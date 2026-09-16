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
import * as logging from '../../src/logging/context';
import * as flow from '../../src/controller/log-context';
import { serializeError } from '../../src/logging/errors';
import { redact } from '../../src/logging/redact';
import { fingerprint, type FingerprintKind } from '../../src/opentelemetry/fingerprints';
import { OAuthController } from '../../src/controller/oauth';
import { oidcClientConfig } from '../../src/controller/oauth/oidc-client';
import { JacksonError } from '../../src/controller/error';
import { extractSAMLResponseAttributes } from '../../src/saml/lib';
import * as encrypter from '../../src/db/encrypter';
import { jacksonOptions } from '../utils';
import fingerprintFixtures from './data/telemetry-fingerprints.json';
import SSOTraces from '../../src/sso-traces';

// The compiled-image probe also checks these links with the actual injected SDK.
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
  setAttributes(fields: any) {
    Object.assign(this.attributes, fields);
    return this;
  }
  setStatus(value: any) {
    this.status = value;
    return this;
  }
  addLink(value: any) {
    this.links.push(value);
    return this;
  }
  recordException(value: any) {
    this.events.push({ exception: value });
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
  const logs: logging.LogFields[] = [];
  const sink = Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [
      level,
      (msg: string, fields: any) => logs.push({ ...fields, msg, level }),
    ])
  );
  const stores = {
    connectionStore: makeStore(),
    sessionStore: makeStore(),
    codeStore: makeStore(),
    tokenStore: makeStore(),
  };
  const opts = {
    ...jacksonOptions,
    db: { ...jacksonOptions.db, ttl: 300 },
    logger: logging.contextualLogger(sink),
  };
  const controller = new OAuthController({
    ...stores,
    opts,
    ssoTraces: { saveTrace: async () => undefined },
    idFedApp: {},
  });
  return { controller, logs, stores, opts, sink };
}
class Operation {
  constructor(public opts = { logger: logging.contextualLogger() }) {}
  @logging.logOperation
  async run<T>(work: () => T) {
    return work();
  }
}
const scoped = <T>(f: ReturnType<typeof fixture>, fields: logging.LogFields, work: () => T) =>
  logging.withContext(fields, f.sink, () => new Operation(f.opts).run(work));
const errors = (f: ReturnType<typeof fixture>) => f.logs.filter((row) => row.level === 'error');

tap.test(
  'initialization detaches both contexts, but the caller and ordinary async work retain them',
  async (t) => {
    const f = fixture();
    const pending: Promise<void>[] = [];
    let inherited: any;
    let detached: any;
    await scoped(f, { requested_email: 'caller@example.com' }, async () => {
      const caller = trace.getActiveSpan();
      pending.push(
        new Promise((resolve) =>
          setTimeout(() => {
            inherited = { fields: logging.contextFields(), span: trace.getActiveSpan() };
            resolve();
          }, 5)
        )
      );
      pending.push(
        logging.detachedFromRequest(
          () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                detached = { fields: logging.contextFields(), span: trace.getActiveSpan() };
                resolve();
              }, 5)
            )
        )
      );
      await logging.detachedFromRequest(async () => {
        await Promise.resolve();
        t.same(logging.contextFields(), {});
        t.equal(trace.getActiveSpan(), undefined);
      });
      t.equal(trace.getActiveSpan(), caller);
      t.equal(logging.contextFields().requested_email, 'caller@example.com');
    });
    await Promise.all(pending);
    t.equal(inherited.fields.requested_email, 'caller@example.com');
    t.ok(inherited.span);
    t.same(detached.fields, {});
    t.equal(detached.span, undefined);
  }
);

tap.test('upstream responses and network failures carry only their own call facts', async (t) => {
  const f = fixture();
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
      scoped(f, {}, async () => {
        await fetch(`${origin}/first`, { body: undefined, headers: {}, method: 'GET', redirect: 'manual' });
        await fetch(`${origin}/second`, { body: undefined, headers: {}, method: 'POST', redirect: 'manual' });
      }),
      { code: 'ECONNRESET' }
    );
    t.match(
      f.logs.find((row) => row.msg === 'Received response from upstream IdP'),
      {
        upstream_endpoint: `${origin}/first`,
        upstream_http_status: 200,
        idp_request_id: 'first-id',
        idp_correlation_id: 'first-correlation',
      }
    );
    const failedCall = f.logs.find((row) => row.msg === 'Unable to reach upstream IdP')!;
    t.match(failedCall, { upstream_endpoint: `${origin}/second`, err: { code: 'ECONNRESET' } });
    for (const row of [failedCall, ...errors(f)]) {
      t.equal(row.upstream_http_status, undefined);
      t.equal(row.idp_request_id, undefined);
      t.equal(row.idp_correlation_id, undefined);
      t.equal(row.trace_id, failedCall.trace_id);
    }
    t.type(failedCall.upstream_duration_ms, 'number');
    t.ok(spans.slice(firstSpan).every((span) => span.attributes['sso.upstream_http_status'] === undefined));
    t.equal(errors(f).length, 1, 'one human error at the operation boundary');
    const recoveryStart = spans.length;
    await scoped(f, {}, async () => {
      await fetch(`${origin}/second`, {
        body: undefined,
        headers: {},
        method: 'GET',
        redirect: 'manual',
      }).catch(() => undefined);
      await fetch(`${origin}/first`, { body: undefined, headers: {}, method: 'GET', redirect: 'manual' });
    });
    t.equal(
      spans[recoveryStart].status.code,
      SpanStatusCode.UNSET,
      'a recovered fetch does not mark successful auth as failed'
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

tap.test('lookup errors keep their actual message and status without a second classification', async (t) => {
  for (const error of [
    new JacksonError('Identity Federation app not found', 404),
    new JacksonError('Enterprise License not found', 403),
    new Error('database unavailable'),
    new JacksonError('database unavailable', 503),
  ]) {
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
    const row = errors(f).find((row) => row.err?.message === error.message)!;
    t.ok(row, error.message);
    t.equal(row.err.statusCode, (error as any).statusCode);
    for (const key of ['sso_event', 'outcome', 'error_code', 'error_category', 'stage'])
      t.equal(row[key], undefined);
  }
});

tap.test('SAML profile validity is not asserted before the subject check', async (t) => {
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
      let facts: logging.LogFields = {};
      let profile: any;
      await scoped(f, {}, async () => {
        try {
          profile = await extractSAMLResponseAttributes('fixture', {} as any);
        } finally {
          facts = logging.contextFields();
        }
      }).catch(() => undefined);
      if ('email' in claims) {
        t.match(facts, {
          profile_validated: true,
          subject_source: 'email_sha256',
          asserted_email: claims.email,
        });
        t.equal(facts.upstream_subject, profile.claims.id);
        t.ok(profile.claims.idHash);
      } else {
        t.equal(facts.first_name, 'Partial');
        t.equal(facts.profile_validated, undefined);
        t.equal(facts.subject_source, undefined);
        t.match(errors(f)[0].err.message, /missing both id \(NameID\) and email/);
      }
    }
  } finally {
    saml.validate = validate;
  }
});

tap.test('fingerprint bytes remain stable', (t) => {
  const prior = process.env.SSO_TELEMETRY_NAMESPACE;
  process.env.SSO_TELEMETRY_NAMESPACE = 'polis-sso';
  try {
    for (const item of fingerprintFixtures)
      t.equal(fingerprint(item.kind as FingerprintKind, item.value), item.expected, item.kind);
    for (const invalid of [undefined, null, '', {}, []])
      t.equal(fingerprint('oauth-state', invalid), undefined);
    t.not(fingerprint('oauth-code', 'key.id'), fingerprint('oauth-code', 'id'));
    t.not(fingerprint('nonce', 'Abc'), fingerprint('nonce', 'abc'));
  } finally {
    if (prior === undefined) delete process.env.SSO_TELEMETRY_NAMESPACE;
    else process.env.SSO_TELEMETRY_NAMESPACE = prior;
  }
  t.end();
});

tap.test('ordinary logger calls inherit request context without crossing concurrent requests', async (t) => {
  const f = fixture();
  await Promise.all(
    ['a', 'b'].map((name) =>
      scoped(f, { request_id: name }, async () => {
        logging.bindContext({ requested_email: `${name}@example.com`, connection_id: name });
        await new Promise((resolve) => setTimeout(resolve, name === 'a' ? 10 : 1));
        f.opts.logger.info('Selected a connection', { database: 'fixture' });
      })
    )
  );
  for (const row of f.logs) {
    t.equal(row.requested_email, `${row.request_id}@example.com`);
    t.equal(row.connection_id, row.request_id);
    t.equal(row.database, 'fixture');
    t.match(row.source, /logging.test.ts/);
    t.match(row.trace_id, /^[a-f0-9]{32}$/);
    t.match(row.span_id, /^[a-f0-9]{16}$/);
  }
  t.equal(new Set(f.logs.map((row) => row.trace_id)).size, 2);
  t.same(logging.contextFields(), {});
  t.equal(logging.contextualLogger(f.opts.logger), f.opts.logger, 'the adapter never double-wraps');
});

tap.test('a failed callback marks the auth operation, not its successful HTTP redirect parent', async (t) => {
  const f = fixture();
  f.stores.connectionStore.getByIndex = async () => ({
    data: [{ clientID: 'c', tenant: 'example.com', product: 'test' }] as any,
  });
  const response = Buffer.from(
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.example</saml:Issuer></samlp:Response>'
  ).toString('base64');
  const parent = new TestSpan('HTTP POST /api/oauth/saml');
  await context.with(trace.setSpan(context.active(), parent as any), () =>
    f.controller
      .samlResponse({ SAMLResponse: response, RelayState: 'boxyhq_jackson_missing' })
      .catch((err) => {
        t.match(err, { message: 'Unable to validate state from the origin request.', statusCode: 403 });
      })
  );
  const row = errors(f)[0];
  t.equal(errors(f).length, 1);
  t.match(row, { err: { statusCode: 403 }, session_lookup: 'miss' });
  t.equal(row.polis_session_fp, fingerprint('polis-session', 'missing'));
  t.equal(row.requested_email, undefined);
  t.equal(row.user_email, undefined);
  t.equal(spans.find((s) => s.sc.spanId === row.span_id)?.status.code, SpanStatusCode.ERROR);
  t.equal(parent.status.code, SpanStatusCode.UNSET);
});

tap.test(
  'narrow encrypted continuation records connect code, token and userinfo without changing responses',
  async (t) => {
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
      upstreamRedirectUri: 'https://polis.example/api/oauth/oidc',
      telemetry: undefined as flow.LogContinuation | undefined,
    };
    let initialTrace: string;
    await scoped(f, { request_id: 'first-request' }, async () => {
      logging.bindContext({
        polis_session_fp: fingerprint('polis-session', 'session-key'),
        requested_email: requested.login_hint,
        downstream_state_fp: fingerprint('oauth-state', requested.state),
        session_created_at: new Date().toISOString(),
        upstream_protocol: 'saml',
        upstream_redirect_uri: 'https://polis.example/api/oauth/saml',
      });
      session.telemetry = flow.continuation();
      initialTrace = logging.contextFields().trace_id;
    });
    const code = await scoped(f, {}, async () => {
      flow.bindSession(session, 'session-key');
      const profile = {
        claims: { id: 'subject', email: 'asserted@example.com', firstName: 'Test', lastName: 'User' },
      };
      flow.bindProfile(profile.claims);
      return (f.controller as any)._buildAuthorizationCode(
        { clientID: 'connection', clientSecret: 'fixture-secret' },
        profile,
        session,
        false
      );
    });
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
    const rows = [
      'Polis authorization code issued',
      'Polis token redemption succeeded',
      'Polis userinfo served',
    ].map((msg) => f.logs.find((row) => row.msg === msg)!);
    t.ok(rows.every(Boolean));
    let previous = initialTrace!;
    for (const row of rows) {
      t.equal(row.polis_session_fp, fingerprint('polis-session', 'session-key'));
      t.equal(row.requested_email, requested.login_hint);
      t.equal(row.asserted_email, 'asserted@example.com');
      t.equal(row.user_email, 'asserted@example.com');
      t.equal(row.request_id, undefined);
      t.equal(row.upstream_redirect_uri, 'https://polis.example/api/oauth/saml');
      const span = spans.find((s) => s.sc.spanId === row.span_id)!;
      t.ok(
        span.links.some((link) => link.context.traceId === previous),
        'each request links to its predecessor'
      );
      previous = row.trace_id;
    }
    t.equal(rows[0].authorization_code_fp, fingerprint('oauth-code', code));
    t.equal(rows[1].authorization_code_fp, rows[0].authorization_code_fp);
    t.equal(rows[1].session_lookup, undefined);
    t.equal(rows[1].access_token_fp, fingerprint('access-token', token.access_token));
    t.equal(rows[2].access_token_fp, rows[1].access_token_fp);
    t.equal(f.stores.codeStore.rows.size, 0);
    const [key, storeId] = token.access_token.split('.');
    const stored = f.stores.tokenStore.rows.get(storeId);
    const decoded = JSON.parse(
      encrypter.decrypt(stored.value, stored.iv, stored.tag, Buffer.from(key, 'hex'))
    );
    t.equal(decoded.telemetry.fields.polis_session_fp, rows[0].polis_session_fp);
    t.equal(decoded.telemetry.fields.request_id, undefined);
    t.equal(decoded.session, undefined);
    t.notMatch(JSON.stringify(f.logs), code, 'raw wire credentials never land in logs');
    t.notMatch(JSON.stringify(f.logs), token.access_token);
  }
);

tap.test('legacy callback metadata and malformed continuations remain optional', async (t) => {
  const f = fixture();
  for (const oidc of [false, true])
    await scoped(f, {}, () => {
      flow.bindSession({
        upstreamRedirectUri: 'https://polis.example/api/oauth/oidc',
        ...(oidc ? { oidcNonce: 'upstream-nonce' } : {}),
      });
      t.equal(
        logging.contextFields().upstream_redirect_uri,
        oidc ? 'https://polis.example/api/oauth/oidc' : undefined
      );
    });
  await scoped(f, { request_id: 'current', polis_session_fp: 'current-session' }, () => {
    flow.restoreContinuation({
      version: 1,
      fields: {
        request_id: 'old',
        raw_token: 'not-allowed',
        requested_email: 'known@example.com',
        polis_session_fp: 'other-session',
      },
      span: { traceId: 'bad', spanId: 'bad' },
    });
    t.equal(logging.contextFields().request_id, 'current');
    t.equal(logging.contextFields().raw_token, undefined);
    t.equal(logging.contextFields().polis_session_fp, 'current-session');
    t.equal(logging.contextFields().correlation_mismatch, true);
    flow.restoreContinuation({ version: 99, fields: { requested_email: 'wrong@example.com' } });
    t.equal(logging.contextFields().requested_email, 'known@example.com');
  });
});

tap.test('cleanup and logging failures neither undo issued tokens nor rerun auth', async (t) => {
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
  const token = await f.controller.token({
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'https://app.example/callback',
    client_id: 'c',
    client_secret: 's',
  });
  t.ok(token.access_token);
  const warning = f.logs.find((row) => row.msg === 'Token issued, but authorization code cleanup failed')!;
  t.match(warning, { level: 'warn', token_issued: true, err: { message: 'fixture cleanup failure' } });
  t.equal(spans.find((s) => s.sc.spanId === warning.span_id)?.status.code, SpanStatusCode.UNSET);
  t.equal(
    (await f.controller.userInfo(token.access_token)).email,
    'e@example.com',
    'legacy session also redeems'
  );
  for (const sink of [
    () => {
      throw new Error('sink failed');
    },
    () => Promise.reject(new Error('sink rejected')),
  ]) {
    let calls = 0;
    const op = new Operation({ logger: logging.contextualLogger({ info: sink, warn: sink, error: sink }) });
    t.equal(
      await op.run(() => {
        calls++;
        logging.currentLogger().info('Interesting work happened');
        return 42;
      }),
      42
    );
    t.equal(calls, 1);
    const original = new Error('original error');
    try {
      await op.run(() => {
        throw original;
      });
    } catch (err) {
      t.equal(err, original);
    }
  }
});

tap.test('malformed credentials, absent records and storage errors retain real evidence', async (t) => {
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
    errors(f).map((row) => row.err.message),
    ['Invalid code', 'Invalid code', 'database unavailable', 'Invalid token', 'Invalid token']
  );
  t.equal(errors(f)[1].code_lookup, 'miss');
  t.equal(errors(f)[2].err.statusCode, undefined, 'a store exception is not given a made-up HTTP status');
});

tap.test('identity facts distinguish requested and asserted email and verification sources', async (t) => {
  const f = fixture();
  for (const asserted_email of [undefined, 'verified@example.com'])
    await scoped(f, {}, () => {
      flow.bindSession({
        requested: { login_hint: 'requested@example.com' },
        telemetry: {
          version: 1,
          fields: {
            requested_email: 'requested@example.com',
            user_email: asserted_email || 'requested@example.com',
            asserted_email,
          },
        },
      });
      t.equal(
        logging.contextFields().user_email,
        asserted_email,
        'legacy login_hint aliases are not treated as an authenticated user'
      );
    });
  await scoped(f, {}, () => {
    flow.bindSession({ requested: { login_hint: 'requested@example.com' } });
    t.equal(logging.contextFields().user_email, undefined);
    flow.bindOidcProfile(
      { sub: 'id', email: 'token@example.com' },
      { email: 'userinfo@example.com', email_verified: true },
      { id: 'id', email: 'token@example.com', firstName: 'not_configured' }
    );
    t.match(logging.contextFields(), {
      asserted_email: 'token@example.com',
      user_email: 'token@example.com',
      asserted_email_source: 'id_token',
      email_verified_present: false,
      userinfo_email_verified: true,
      first_name_placeholder: true,
      last_name_missing: true,
    });
    t.equal(logging.contextFields().email_verified, undefined);
  });
});

tap.test('native error causes, provider diagnostics and stacks survive without mutating exceptions', (t) => {
  const cause = Object.freeze(Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }));
  const outer = Object.freeze(new Error('Unable to exchange code', { cause }));
  const fields = redact({ err: outer });
  t.equal(fields.err.cause.code, 'ECONNRESET');
  t.ok(fields.err.stack);
  t.same(Object.keys(cause), ['code']);
  const provider = {
    name: 'ResponseBodyError',
    code: 'OAUTH_RESPONSE_BODY_ERROR',
    status: 400,
    error: 'access_denied',
    error_description: 'provider denied',
    cause: { error_codes: [53003], trace_id: 'provider-trace', correlation_id: 'provider-correlation' },
  };
  const serialized = redact({ trace_id: 'otel-trace', err: serializeError(provider) });
  t.match(serialized.err, {
    code: 'OAUTH_RESPONSE_BODY_ERROR',
    status: 400,
    error: 'access_denied',
    cause: { error_codes: [53003], trace_id: 'provider-trace' },
  });
  t.equal(serialized.trace_id, 'otel-trace');
  t.equal(serializeError({ inner: new Error('Invalid audience.') }).inner.message, 'Invalid audience.');
  const nonce = serializeError({
    code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
    cause: { claim: 'nonce', expected: 'expected-secret', claims: { nonce: 'actual-secret' } },
  });
  t.equal(nonce.cause.claim, 'nonce');
  t.notMatch(JSON.stringify(nonce), 'expected-secret');
  t.notMatch(JSON.stringify(nonce), 'actual-secret');
  const cyclic: any = new Error('cycle');
  cyclic.cause = cyclic;
  t.equal(serializeError(cyclic).cause.message, 'Cause chain truncated');
  t.equal(serializeError(serializeError(outer)).type, 'Error');
  t.end();
});

tap.test(
  'an early routing rejection has useful context without inventing a user or stored session',
  async (t) => {
    const f = fixture();
    await t.rejects(f.controller.authorize({ login_hint: 'person@example.com' } as any), {
      message: 'Please specify a redirect URL.',
      statusCode: 400,
    });
    t.match(errors(f)[0], {
      requested_email: 'person@example.com',
      err: { message: 'Please specify a redirect URL.' },
    });
    t.equal(errors(f)[0].user_email, undefined);
    t.equal(
      errors(f)[0].polis_session_fp,
      undefined,
      'an invalid request does not reserve a session just for logging'
    );
    t.equal(f.stores.sessionStore.rows.size, 0);
  }
);

tap.test('provider denial is still an early redirect with its original native explanation', async (t) => {
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
  t.match(errors(f)[0], {
    msg: 'OIDC provider rejected authorization: AADSTS53003: fixture policy denial',
    requested_email: 'person@example.com',
    oauth_error: 'access_denied',
  });
  t.equal(spans.find((s) => s.sc.spanId === errors(f)[0].span_id)?.status.code, SpanStatusCode.ERROR);
  t.notOk(
    f.logs.some((row) => row.upstream_endpoint),
    'no discovery or exchange attempted'
  );
});

tap.test('stored error reports correlate to the original request and retain report indexes', async (t) => {
  const f = fixture();
  const store = makeStore();
  const reporter = { opts: f.opts, tracesStore: store } as any;
  await scoped(f, {}, async () => {
    logging.bindContext({ tenant: 'selected-tenant', connection_id: 'connection' });
    f.opts.logger.error('Unable to validate identity', new Error('original failure'));
    const id = await SSOTraces.prototype.saveTrace.call(reporter, {
      error: 'original failure',
      context: { tenant: 'original-index-tenant', product: 'test', clientID: 'connection' },
    });
    t.match(store.rows.get(id!).context, {
      tenant: 'original-index-tenant',
      trace_id: logging.contextFields().trace_id,
    });
    t.equal(f.logs.find((row) => row.msg === 'Saved SSO error report')?.polis_error_report_id, id);
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
  });
  t.equal(errors(f).length, 1);
  t.ok(f.logs.some((row) => row.msg === 'Unable to save SSO error report' && row.level === 'warn'));
});
