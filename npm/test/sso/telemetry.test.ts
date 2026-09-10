import tap from 'tap';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';
import saml from '@boxyhq/saml20';
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';
import * as telemetry from '../../src/opentelemetry/telemetry';
import { attachErrorContext, failureFields, serializeError } from '../../src/opentelemetry/errors';
import { OAuthController } from '../../src/controller/oauth';
import { oidcClientConfig } from '../../src/controller/oauth/oidc-client';
import { JacksonError } from '../../src/controller/error';
import { extractSAMLResponseAttributes } from '../../src/saml/lib';
import * as encrypter from '../../src/db/encrypter';
import { jacksonOptions } from '../utils';
import fingerprintFixtures from './data/telemetry-fingerprints.json';
import SSOTraces from '../../src/sso-traces';

// Exercise the real global API/context contract without adding an SDK/provider
// to the application. Compiled-image acceptance also uses the real injected SDK.
const active = new AsyncLocalStorage<Context>();
let sequence = 0;
const spans: TestSpan[] = [];
class TestSpan {
  attributes: Record<string, any> = {};
  links: any[] = [];
  events: any[] = [];
  status: any = { code: SpanStatusCode.UNSET };
  ended = false;
  sc: SpanContext;
  constructor(public name: string) {
    const parent = trace.getActiveSpan()?.spanContext();
    const id = (++sequence).toString(16);
    this.sc = {
      traceId: parent?.traceId || id.padStart(32, '0'),
      spanId: id.padStart(16, '0'),
      traceFlags: 1,
    };
    spans.push(this);
  }
  spanContext() {
    return this.sc;
  }
  setAttribute(key: string, value: any) {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(fields: any) {
    Object.assign(this.attributes, fields);
    return this;
  }
  setStatus(value: any) {
    this.status = value;
    return this;
  }
  addEvent(name: string, attributes: any) {
    this.events.push({ name, attributes });
    return this;
  }
  addLink(value: any) {
    this.links.push(value);
    return this;
  }
  addLinks(values: any[]) {
    this.links.push(...values);
    return this;
  }
  recordException(value: any) {
    this.events.push({ exception: value });
  }
  updateName(name: string) {
    this.name = name;
    return this;
  }
  isRecording() {
    return !this.ended;
  }
  end() {
    this.ended = true;
  }
}
tap.before(() => {
  context.setGlobalContextManager({
    active: () => active.getStore() || ROOT_CONTEXT,
    with: (ctx: Context, fn: (...args: any[]) => any, self: any, ...args: any[]) =>
      active.run(ctx, () => fn.apply(self, args)),
    bind: (_ctx: Context, target: any) => target,
    enable() {
      return this;
    },
    disable() {
      active.disable();
      return this;
    },
  });
  trace.setGlobalTracerProvider({
    getTracer: () => ({ startSpan: (name: string) => new TestSpan(name) }),
  } as any);
});
tap.teardown(() => {
  trace.disable();
  context.disable();
});

const makeStore = () => {
  const rows = new Map<string, any>();
  return {
    rows,
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: any) => {
      rows.set(key, value);
    },
    delete: async (key: string) => {
      rows.delete(key);
    },
    getByIndex: async () => ({ data: [] }),
  };
};
function fixture() {
  const events: telemetry.SsoEvent[] = [];
  const stores = {
    connectionStore: makeStore(),
    sessionStore: makeStore(),
    codeStore: makeStore(),
    tokenStore: makeStore(),
  };
  const opts = {
    ...jacksonOptions,
    db: { ...jacksonOptions.db, ttl: 300 },
    telemetry: (row: telemetry.SsoEvent) => {
      events.push(row);
    },
  };
  const controller = new OAuthController({
    ...stores,
    opts,
    ssoTraces: { saveTrace: async () => undefined },
    idFedApp: {},
  });
  return { controller, events, stores, opts };
}
const finished = (events: telemetry.SsoEvent[]) =>
  events.filter((row) => row.sso_event === 'polis_request_completed');

tap.test('process initialization detaches both contexts without changing the caller', async (t) => {
  const pending: Promise<void>[] = [];
  let inherited: { fields: telemetry.SsoFields; span: unknown } | undefined;
  let detached: { fields: telemetry.SsoFields; span: unknown } | undefined;
  await telemetry.withSsoTelemetry(
    'authorize',
    { fields: { requested_email: 'caller@example.com' } },
    async () => {
      const caller = trace.getActiveSpan();
      pending.push(
        new Promise((resolve) =>
          setTimeout(() => {
            inherited = { fields: telemetry.logContextFields(), span: trace.getActiveSpan() };
            resolve();
          }, 5)
        )
      );
      pending.push(
        telemetry.detachedFromRequest(
          () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                detached = { fields: telemetry.logContextFields(), span: trace.getActiveSpan() };
                resolve();
              }, 5)
            )
        )
      );
      await telemetry.detachedFromRequest(async () => {
        await Promise.resolve();
        t.same(telemetry.logContextFields(), {});
        t.equal(trace.getActiveSpan(), undefined);
      });
      t.equal(trace.getActiveSpan(), caller, 'awaiting init retains the request span');
      t.equal(telemetry.logContextFields().requested_email, 'caller@example.com');
    }
  );
  await Promise.all(pending);
  t.equal(
    inherited?.fields.requested_email,
    'caller@example.com',
    'ordinary request async work still inherits context'
  );
  t.ok(inherited?.span);
  t.same(detached?.fields, {}, 'background callback has no customer context');
  t.equal(detached?.span, undefined, 'background callback has no first-request trace');
});

tap.test('upstream response facts belong to their call, not a later socket failure', async (t) => {
  const events: telemetry.SsoEvent[] = [];
  const firstSpan = spans.length;
  const server = http.createServer((req, res) => {
    if (req.url === '/first') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'first-id',
        'x-correlation-id': 'first-correlation',
      });
      res.end('{}');
    } else req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = await import('openid-client');
    const origin = `http://localhost:${(server.address() as { port: number }).port}`;
    const config = await oidcClientConfig({
      metadata: { issuer: origin },
      clientId: 'fixture',
      ssoTraces: {
        instance: { saveTrace: async () => undefined } as any,
        context: { tenant: 'fixture', product: 'fixture', clientID: 'fixture' },
      },
    });
    const fetch = config[client.customFetch]!;
    await t.rejects(
      telemetry.withSsoTelemetry(
        'oidc_callback',
        {
          telemetry: (row) => {
            events.push(row);
          },
        },
        async () => {
          await telemetry.stage('upstream_discovery', () =>
            fetch(`${origin}/first`, { body: undefined, headers: {}, method: 'GET', redirect: 'manual' })
          );
          await telemetry.stage('upstream_token_exchange', () =>
            fetch(`${origin}/second`, { body: undefined, headers: {}, method: 'POST', redirect: 'manual' })
          );
        }
      ),
      { code: 'ECONNRESET' }
    );
    const success = events.find((row) => row.sso_event === 'polis_upstream_response')!;
    t.match(success, {
      upstream_endpoint: `${origin}/first`,
      upstream_http_status: 200,
      idp_request_id: 'first-id',
      idp_correlation_id: 'first-correlation',
    });
    const callFailure = events.find((row) => row.sso_event === 'polis_upstream_request_failed')!;
    t.match(callFailure, { upstream_endpoint: `${origin}/second`, network_error_code: 'ECONNRESET' });
    const failure = finished(events)[0];
    t.match(failure, {
      stage: 'upstream_token_exchange',
      outcome: 'failed',
      upstream_endpoint: `${origin}/second`,
      network_error_code: 'ECONNRESET',
    });
    for (const row of [callFailure, failure]) {
      t.equal(row.upstream_http_status, undefined);
      t.equal(row.idp_request_id, undefined);
      t.equal(row.idp_correlation_id, undefined);
    }
    t.type(failure.upstream_duration_ms, 'number');
    t.ok(
      spans.slice(firstSpan).every((span) => span.attributes['sso.upstream_http_status'] === undefined),
      'no ancestor/stage attribute inherits a previous HTTP status'
    );
    t.ok(
      spans
        .slice(firstSpan)
        .some((span) =>
          span.events.some(
            (event) =>
              event.name === 'polis_upstream_response' && event.attributes['sso.upstream_http_status'] === 200
          )
        ),
      'the response remains available as a span event'
    );
    t.equal(finished(events).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

tap.test(
  'attached error facts survive wrapping without mutating errors or leaking to unrelated failures',
  (t) => {
    const raw = Object.freeze(Object.assign(new Error('socket failure'), { code: 'ECONNRESET' }));
    const before = serializeError(raw);
    const fields = {
      upstream_endpoint: 'https://idp.example/token',
      upstream_endpoint_role: 'upstream_token_exchange',
      upstream_http_method: 'POST',
      upstream_duration_ms: 12,
    };
    t.equal(attachErrorContext(raw, fields), raw, 'reject the identical error object');
    t.same(serializeError(raw), before, 'no new error properties or changed message');
    const wrapped = new Error('library wrapper', { cause: raw });
    t.match(failureFields(wrapped, 'upstream_token_exchange'), {
      ...fields,
      error_message: 'library wrapper',
      network_error_code: 'ECONNRESET',
    });
    t.equal(failureFields(new Error('later unrelated failure'), 'profile_map').upstream_endpoint, undefined);
    t.equal(attachErrorContext('primitive rejection', fields), 'primitive rejection');
    t.end();
  }
);

tap.test('federation lookup distinguishes missing app, license and storage failures', async (t) => {
  for (const [error, expected] of [
    [
      new JacksonError('Identity Federation app not found', 404),
      { error_code: 'federation_app_not_found', error_category: 'routing', severity: 'warn' },
    ],
    [
      new JacksonError('Enterprise License not found', 403),
      { error_code: 'federation_app_license_invalid', error_category: 'configuration', severity: 'error' },
    ],
    [
      new Error('database unavailable'),
      { error_code: 'federation_app_lookup_failed', error_category: 'storage', severity: 'error' },
    ],
    [
      new JacksonError('database unavailable', 503),
      { error_code: 'federation_app_lookup_failed', error_category: 'storage', severity: 'error' },
    ],
  ] as const) {
    const f = fixture();
    (f.controller as any).idFedApp = {
      get: async () => {
        throw error;
      },
    };
    await f.controller
      .authorize({
        client_id: 'fed_oidc_missing',
        redirect_uri: 'https://app.example/callback',
        state: 'fixture-state',
        response_type: 'code',
      } as any)
      .catch(() => undefined);
    t.equal(finished(f.events).length, 1);
    t.match(finished(f.events)[0], {
      ...expected,
      outcome: 'failed',
      stage: 'federation_app_lookup',
      error_message: error.message,
    });
  }
  t.equal(failureFields(new JacksonError('missing', 404), 'connection_lookup').error_category, 'protocol');
  t.equal(failureFields(new JacksonError('unavailable', 503), 'connection_lookup').error_category, 'storage');
});

tap.test('a SAML profile is validated only after a usable subject is established', async (t) => {
  const validate = saml.validate;
  try {
    for (const claims of [{ firstName: 'Partial' }, { email: 'fallback@example.com' }]) {
      saml.validate = (async () => ({
        claims: { ...claims },
        audience: 'fixture',
        issuer: 'fixture',
        sessionIndex: '',
      })) as typeof saml.validate;
      const f = fixture();
      let profile: Awaited<ReturnType<typeof extractSAMLResponseAttributes>> | undefined;
      await telemetry
        .withSsoTelemetry('saml_callback', { telemetry: f.opts.telemetry }, async () => {
          profile = await telemetry.stage('saml_validate', () =>
            extractSAMLResponseAttributes('fixture', {} as any)
          );
        })
        .catch(() => undefined);
      const row = finished(f.events)[0];
      if ('email' in claims) {
        t.match(row, {
          outcome: 'succeeded',
          profile_validated: true,
          subject_source: 'email_sha256',
          asserted_email: claims.email,
        });
        t.equal(row.upstream_subject, profile!.claims.id);
        t.ok(profile!.claims.idHash);
      } else {
        t.match(row, { outcome: 'failed', error_code: 'saml_subject_missing', first_name: 'Partial' });
        t.equal(row.profile_validated, undefined);
        t.equal(row.subject_source, undefined);
      }
    }
  } finally {
    saml.validate = validate;
  }
});

tap.test('fingerprint byte contract and absent values', (t) => {
  const prior = process.env.SSO_TELEMETRY_NAMESPACE;
  process.env.SSO_TELEMETRY_NAMESPACE = 'polis-sso';
  try {
    for (const item of fingerprintFixtures)
      t.equal(
        telemetry.fingerprint(item.kind as telemetry.FingerprintKind, item.value),
        item.expected,
        item.kind
      );
    for (const invalid of [undefined, null, '', {}, []])
      t.equal(telemetry.fingerprint('oauth-state', invalid), undefined);
    t.not(telemetry.fingerprint('oauth-code', 'key.id'), telemetry.fingerprint('oauth-code', 'id'));
    t.not(telemetry.fingerprint('nonce', 'Abc'), telemetry.fingerprint('nonce', 'abc'));
  } finally {
    if (prior === undefined) delete process.env.SSO_TELEMETRY_NAMESPACE;
    else process.env.SSO_TELEMETRY_NAMESPACE = prior;
  }
  t.end();
});

tap.test('request-local context survives awaits but never crosses concurrent requests', async (t) => {
  const events: telemetry.SsoEvent[] = [];
  await Promise.all(
    ['a', 'b'].map(async (name) =>
      telemetry.withSsoTelemetry(
        'authorize',
        {
          telemetry: (row) => {
            events.push(row);
          },
          fields: { request_id: name },
        },
        async () => {
          telemetry.enrich({ requested_email: `${name}@example.com`, connection_id: name });
          await new Promise((resolve) => setTimeout(resolve, name === 'a' ? 10 : 1));
          telemetry.event('fixture');
        }
      )
    )
  );
  for (const row of events.filter((row) => row.sso_event !== 'polis_request_started')) {
    t.equal(row.requested_email, `${row.request_id}@example.com`);
    t.equal(row.connection_id, row.request_id);
    t.match(row.trace_id, /^[a-f0-9]{32}$/);
    t.match(row.span_id, /^[a-f0-9]{16}$/);
  }
  t.equal(new Set(finished(events).map((row) => row.trace_id)).size, 2);
  t.same(telemetry.logContextFields(), {}, 'nothing remains outside the request');
});

tap.test('a 302 error redirect has one failure record and an error-marked semantic span', async (t) => {
  const f = fixture();
  f.stores.connectionStore.getByIndex = async () => ({
    data: [{ clientID: 'c', tenant: 'example.com', product: 'test' }] as any,
  });
  const response = Buffer.from(
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.example</saml:Issuer></samlp:Response>'
  ).toString('base64');
  await telemetry.withSsoTelemetry(
    'saml_callback',
    { telemetry: f.opts.telemetry, responseStatus: () => 302 },
    async () => {
      await t.rejects(
        f.controller.samlResponse({ SAMLResponse: response, RelayState: 'boxyhq_jackson_missing' }),
        { message: 'Unable to validate state from the origin request.', statusCode: 403 }
      );
    }
  );
  const rows = finished(f.events);
  t.equal(rows.length, 1);
  t.match(rows[0], {
    outcome: 'failed',
    stage: 'session_lookup',
    error_code: 'sso_session_not_found',
    auth_error_status: 403,
    http_response_status: 302,
    session_lookup: 'miss',
    severity: 'warn',
  });
  t.equal(rows[0].polis_session_fp, telemetry.fingerprint('polis-session', 'missing'));
  t.equal(rows[0].requested_email, undefined, 'missing session does not invent an email');
  t.equal(spans.find((s) => s.sc.spanId === rows[0].span_id)?.status.code, SpanStatusCode.ERROR);
});

tap.test('full wire values and narrow internal records connect code, token, and userinfo', async (t) => {
  const f = fixture();
  const requested = {
    client_id: 'connection',
    state: 'downstream-state',
    nonce: 'downstream-nonce',
    redirect_uri: 'https://app.example/callback',
    login_hint: 'requested@example.com',
    tenant: 'example.com',
    product: 'test',
    protocol: 'saml',
  };
  const session = {
    requested,
    state: requested.state,
    redirect_uri: requested.redirect_uri,
    // The existing session field is OIDC-specific, even on SAML sessions.
    upstreamRedirectUri: 'https://polis.example/api/oauth/oidc',
    telemetry: undefined as telemetry.SsoContinuation | undefined,
  };
  await telemetry.withSsoTelemetry(
    'authorize',
    { telemetry: f.opts.telemetry, fields: { request_id: 'first-request' } },
    async () => {
      telemetry.enrich({
        polis_session_fp: telemetry.fingerprint('polis-session', 'session-key'),
        requested_email: requested.login_hint,
        downstream_state_fp: telemetry.fingerprint('oauth-state', requested.state),
        session_created_at: new Date().toISOString(),
        upstream_protocol: 'saml',
        upstream_redirect_uri: 'https://polis.example/api/oauth/saml',
      });
      session.telemetry = telemetry.continuation();
    }
  );
  const code = await telemetry.withSsoTelemetry(
    'saml_callback',
    { telemetry: f.opts.telemetry },
    async () => {
      telemetry.bindSession(session, 'session-key');
      const profile = {
        claims: { id: 'subject', email: 'asserted@example.com', firstName: 'Test', lastName: 'User' },
      };
      telemetry.bindProfile(profile.claims);
      return (f.controller as any)._buildAuthorizationCode(
        { clientID: 'connection', clientSecret: 'fixture-secret' },
        profile,
        session,
        false
      );
    }
  );
  const token = await f.controller.token({
    code,
    grant_type: 'authorization_code',
    redirect_uri: requested.redirect_uri,
    client_id: 'connection',
    client_secret: 'fixture-secret',
  });
  const profile = await f.controller.userInfo(token.access_token);
  t.same(Object.keys(token).sort(), ['access_token', 'expires_in', 'token_type']);
  t.same(Object.keys(profile).sort(), ['email', 'firstName', 'id', 'lastName', 'requested']);
  const rows = ['polis_code_issued', 'polis_token_redeemed', 'polis_userinfo_served'].map((name) =>
    f.events.find((row) => row.sso_event === name)!
  );
  t.ok(rows.every(Boolean));
  for (const row of rows) {
    t.equal(row.polis_session_fp, telemetry.fingerprint('polis-session', 'session-key'));
    t.equal(row.requested_email, requested.login_hint);
    t.equal(row.asserted_email, 'asserted@example.com');
    t.equal(row.request_id, undefined, 'the prior request ID is not propagated');
    t.equal(
      row.upstream_redirect_uri,
      'https://polis.example/api/oauth/saml',
      'the actual SAML ACS survives restoration'
    );
  }
  t.equal(rows[0].authorization_code_fp, telemetry.fingerprint('oauth-code', code));
  t.equal(rows[1].authorization_code_fp, rows[0].authorization_code_fp);
  t.equal(rows[1].session_lookup, undefined, 'embedded code context is not a live session-store hit');
  t.equal(rows[1].access_token_fp, telemetry.fingerprint('access-token', token.access_token));
  t.equal(rows[2].access_token_fp, rows[1].access_token_fp);
  t.equal(f.stores.codeStore.rows.size, 0);
  const [key, storeId] = token.access_token.split('.');
  const stored = f.stores.tokenStore.rows.get(storeId);
  const decoded = JSON.parse(encrypter.decrypt(stored.value, stored.iv, stored.tag, Buffer.from(key, 'hex')));
  t.equal(decoded.telemetry.fields.polis_session_fp, rows[0].polis_session_fp);
  t.equal(decoded.telemetry.fields.request_id, undefined);
  t.equal(decoded.session, undefined, 'the full session/client secret is not copied to the token');
  const completed = finished(f.events);
  for (let i = 1; i < completed.length; i++) {
    const span = spans.find((s) => s.sc.spanId === completed[i].span_id)!;
    t.ok(
      span.links.some((link) => link.context.traceId === completed[i - 1].trace_id),
      'each independent request links to its predecessor'
    );
  }
});

tap.test('legacy session callback metadata distinguishes SAML from OIDC', async (t) => {
  for (const oidc of [false, true]) {
    await telemetry.withSsoTelemetry('fixture', {}, async () => {
      telemetry.bindSession({
        upstreamRedirectUri: 'https://polis.example/api/oauth/oidc',
        ...(oidc ? { oidcNonce: 'upstream-nonce' } : {}),
      });
      t.equal(
        telemetry.telemetryFields().upstream_redirect_uri,
        oidc ? 'https://polis.example/api/oauth/oidc' : undefined,
        'only an OIDC session uses the legacy upstreamRedirectUri field'
      );
    });
  }
});

tap.test('code cleanup and telemetry sink failures do not change successful auth', async (t) => {
  const f = fixture();
  const code = await (f.controller as any)._buildAuthorizationCode(
    { clientID: 'c', clientSecret: 's' },
    { claims: { id: 'id', email: 'e@example.com' } },
    { requested: { client_id: 'c', protocol: 'saml' } },
    false
  );
  f.stores.codeStore.delete = async () => {
    throw new Error('fixture cleanup failure');
  };
  const response = await f.controller.token({
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'https://app.example/callback',
    client_id: 'c',
    client_secret: 's',
  });
  t.ok(response.access_token);
  t.match(
    f.events.find((row) => row.sso_event === 'authorization_code_cleanup_failed'),
    { severity: 'error', token_issued: true }
  );
  t.equal(finished(f.events)[0].outcome, 'succeeded');
  t.equal(spans.findLast((s) => s.name === 'polis.code_cleanup')?.status.code, SpanStatusCode.ERROR);
  for (const sink of [
    () => {
      throw new Error('sink failed');
    },
    () => Promise.reject(new Error('sink rejected')),
  ]) {
    let calls = 0;
    const result = await telemetry.withSsoTelemetry('fixture', { telemetry: sink }, async () => {
      calls++;
      telemetry.event('fixture');
      return 42;
    });
    t.equal(result, 42);
    t.equal(calls, 1, 'a failing sink never reruns the operation');
  }
});

tap.test('legacy records and malformed continuation metadata do not alter auth', async (t) => {
  const f = fixture();
  const code = await (f.controller as any)._buildAuthorizationCode(
    { clientID: 'c', clientSecret: 's' },
    { claims: { id: 'id', email: 'e@example.com' } },
    { requested: { client_id: 'c', protocol: 'saml' } },
    false
  );
  const token = await f.controller.token({
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'https://app.example/callback',
    client_id: 'c',
    client_secret: 's',
  });
  t.equal((await f.controller.userInfo(token.access_token)).email, 'e@example.com');
  await telemetry.withSsoTelemetry(
    'fixture',
    { telemetry: f.opts.telemetry, fields: { request_id: 'current' } },
    async () => {
      telemetry.restoreContinuation({
        version: 1,
        fields: { request_id: 'old', raw_token: 'not-allowed', requested_email: 'known@example.com' },
        span: { traceId: 'bad', spanId: 'bad' },
      });
      t.equal(telemetry.telemetryFields().request_id, 'current');
      t.equal(telemetry.telemetryFields().raw_token, undefined);
      telemetry.restoreContinuation({ version: 99, fields: { requested_email: 'wrong@example.com' } });
      t.equal(telemetry.telemetryFields().requested_email, 'known@example.com');
    }
  );
});

tap.test(
  'failure distinctions cover missing/malformed code, lookup failures, and early userinfo',
  async (t) => {
    const f = fixture();
    await t.rejects(f.controller.token({ code: 'malformed' } as any), {
      message: 'Invalid code',
      statusCode: 403,
    });
    await t.rejects(f.controller.token({ code: 'key.absent' } as any), {
      message: 'Invalid code',
      statusCode: 403,
    });
    f.stores.codeStore.get = async () => {
      throw new Error('database unavailable');
    };
    await t.rejects(f.controller.token({ code: 'key.store-id' } as any), { message: 'database unavailable' });
    await t.rejects(f.controller.userInfo('malformed'), { message: 'Invalid token', statusCode: 403 });
    await t.rejects(f.controller.userInfo('key.absent'), { message: 'Invalid token', statusCode: 403 });
    t.same(
      finished(f.events).map((row) => row.error_code),
      [
        'authorization_code_malformed',
        'authorization_code_not_found',
        'code_lookup_failed',
        'access_token_malformed',
        'access_token_not_found',
      ]
    );
    t.equal(finished(f.events)[2].error_category, 'storage');
  }
);

tap.test('OIDC profile provenance does not borrow verification from a different email', async (t) => {
  const f = fixture();
  await telemetry.withSsoTelemetry('fixture', { telemetry: f.opts.telemetry }, async () => {
    telemetry.bindOidcProfile(
      { sub: 'id', email: 'token@example.com' },
      { email: 'userinfo@example.com', email_verified: true },
      { id: 'id', email: 'token@example.com', firstName: 'not_configured' }
    );
    const row = telemetry.telemetryFields();
    t.match(row, {
      asserted_email: 'token@example.com',
      asserted_email_source: 'id_token',
      email_verified_present: false,
      userinfo_email_verified: true,
      first_name_placeholder: true,
      last_name_missing: true,
    });
    t.equal(row.email_verified, undefined);
  });
});

tap.test('error normalization preserves causes and distinguishes provider IDs from OTel IDs', (t) => {
  const cause = Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
  const outer = new Error('something went wrong', { cause });
  const fields = failureFields(outer, 'upstream_token_exchange');
  t.equal(fields.err.cause.code, 'ECONNRESET');
  t.ok(fields.err.stack);
  t.equal(fields.network_error_code, 'ECONNRESET');
  t.equal(
    failureFields(
      Object.assign(new Error('bad key'), { code: 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE' }),
      'token_issue'
    ).network_error_code,
    undefined,
    'local crypto errors are not misclassified as network failures'
  );
  const response = failureFields(
    {
      name: 'ResponseBodyError',
      code: 'OAUTH_RESPONSE_BODY_ERROR',
      status: 400,
      error: 'access_denied',
      error_description: 'provider denied',
      cause: { error_codes: [53003], trace_id: 'provider-trace', correlation_id: 'provider-correlation' },
    },
    'upstream_token_exchange'
  );
  t.match(response, {
    idp_error: 'access_denied',
    idp_error_codes: [53003],
    idp_trace_id: 'provider-trace',
    idp_correlation_id: 'provider-correlation',
    upstream_http_status: 400,
    error_category: 'provider',
  });
  t.equal(response.trace_id, undefined);
  t.equal(
    failureFields(new Error('Invalid audience.'), 'saml_validate').error_code,
    'saml_audience_mismatch'
  );
  const nonce = failureFields(
    {
      code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
      cause: { claim: 'nonce', expected: 'expected', claims: { nonce: 'actual' } },
    },
    'upstream_token_exchange'
  );
  t.match(nonce, {
    error_code: 'oidc_claim_mismatch',
    invalid_claim: 'nonce',
    expected_nonce_fp: telemetry.fingerprint('nonce', 'expected'),
    actual_nonce_fp: telemetry.fingerprint('nonce', 'actual'),
  });
  t.notMatch(JSON.stringify(nonce), '"nonce":"actual"', 'raw nonce claims are not copied into error logs');
  const cyclic: any = new Error('cycle');
  cyclic.cause = cyclic;
  t.equal(serializeError(cyclic).cause.message, 'Cause chain truncated');
  t.equal(
    serializeError(serializeError(outer)).type,
    'Error',
    'Pino can serialize an already-normalized error'
  );
  t.end();
});

tap.test('routing rejection still has a reserved correlation key but no persisted session', async (t) => {
  const f = fixture();
  await t.rejects(f.controller.authorize({ login_hint: 'person@example.com' } as any), {
    message: 'Please specify a redirect URL.',
    statusCode: 400,
  });
  t.match(finished(f.events)[0], {
    error_code: 'redirect_uri_missing',
    requested_email: 'person@example.com',
    session_stored: false,
  });
  t.match(finished(f.events)[0].polis_session_fp, /^[a-f0-9]{64}$/);
  t.equal(f.stores.sessionStore.rows.size, 0);
});

tap.test('provider denial remains an early error redirect with native diagnostics', async (t) => {
  const f = fixture();
  const redirect = 'https://app.example/callback';
  f.stores.connectionStore.rows.set('connection', {
    clientID: 'connection',
    tenant: 'example.com',
    product: 'test',
    redirectUrl: [redirect],
    oidcProvider: { provider: 'fixture' },
  });
  f.stores.sessionStore.rows.set('session', {
    id: 'connection',
    state: 'client-state',
    redirect_uri: redirect,
    requested: { oidc: true, client_id: 'connection', login_hint: 'person@example.com' },
  });
  const result = await f.controller.oidcAuthzResponse({
    state: 'boxyhq_jackson_session',
    error: 'access_denied',
    error_description: 'AADSTS53003: fixture policy denial',
  } as any);
  const url = new URL(result.redirect_url!);
  t.equal(url.searchParams.get('error'), 'access_denied');
  t.equal(url.searchParams.get('state'), 'client-state');
  t.equal(url.searchParams.get('error_description'), 'AADSTS53003: fixture policy denial');
  t.match(finished(f.events)[0], {
    stage: 'idp_authorization',
    outcome: 'failed',
    error_code: 'idp_authorization_rejected',
    requested_email: 'person@example.com',
    idp_error_codes: ['53003'],
    idp_error_codes_source: 'description',
  });
  t.notOk(
    f.events.some((row) => row.stage === 'upstream_discovery'),
    'missing discovery configuration was never used'
  );
});

tap.test('error reports link to the original trace and preserve report indexing', async (t) => {
  const f = fixture();
  const store = makeStore();
  const reporter = { opts: f.opts, tracesStore: store } as any;
  await telemetry.withSsoTelemetry('fixture', { telemetry: f.opts.telemetry }, async () => {
    telemetry.enrich({ tenant: 'selected-tenant', connection_id: 'connection' });
    telemetry.failure(new Error('original failure'), 'original_failure');
    const id = await SSOTraces.prototype.saveTrace.call(reporter, {
      error: 'original failure',
      context: { tenant: 'original-index-tenant', product: 'test', clientID: 'connection' },
    });
    const saved = store.rows.get(id!);
    t.match(saved.context, {
      tenant: 'original-index-tenant',
      error_code: 'original_failure',
      trace_id: telemetry.telemetryFields().trace_id,
    });
    t.equal(f.events.find((row) => row.sso_event === 'polis_error_report_saved')?.polis_error_report_id, id);
    store.put = async () => {
      throw new Error('report store down');
    };
    t.equal(
      await SSOTraces.prototype.saveTrace.call(reporter, {
        error: 'original failure',
        context: { tenant: 't', product: 'p', clientID: 'c' },
      }),
      undefined
    );
    t.equal(
      telemetry.telemetryFields().error_code,
      'original_failure',
      'secondary reporting failure cannot replace the original'
    );
  });
  t.equal(finished(f.events).length, 1);
  t.ok(f.events.some((row) => row.sso_event === 'polis_error_report_failed'));
});
