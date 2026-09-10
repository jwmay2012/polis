import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context,
  trace,
  SpanStatusCode,
  isSpanContextValid,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import { failureFields, failureSeverity, type ErrorCategory } from './errors';
import { fingerprint } from './fingerprints';
export { fingerprint, type FingerprintKind } from './fingerprints';

export type SsoFields = Record<string, any>;
export type SsoEvent = SsoFields & { sso_event: string; severity: 'info' | 'warn' | 'error'; msg: string };
export type SsoTelemetrySink = (event: SsoEvent) => void | Promise<void>;
type State = {
  fields: SsoFields;
  stage: string;
  span?: Span;
  requestSpan?: Span;
  sink?: SsoTelemetrySink;
  failure?: SsoFields;
  links: Set<string>;
};

// Next can load separate server bundles. Share the context carrier, never a
// mutable current-user object, across those bundles. ALS isolates requests.
const storageKey = Symbol.for('polis.sso.telemetry.context.v1');
const globals = globalThis as any;
const storage: AsyncLocalStorage<State> = (globals[storageKey] ??= new AsyncLocalStorage<State>());
const tracer = trace.getTracer('polis.sso', '1');

const safely = <T>(work: () => T): T | undefined => {
  try {
    return work();
  } catch {
    return undefined;
  }
};
const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);
const traceFields = (span?: Span): SsoFields => {
  const sc = safely(() => span?.spanContext());
  return sc && isSpanContextValid(sc)
    ? { trace_id: sc.traceId, span_id: sc.spanId, trace_flags: sc.traceFlags.toString(16).padStart(2, '0') }
    : {};
};
function attributes(fields: SsoFields) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (['trace_id', 'span_id', 'trace_flags', 'err'].includes(key)) continue;
    if (scalar(value) || (Array.isArray(value) && value.every(scalar))) out[`sso.${key}`] = value;
  }
  return out;
}

export function telemetryActive() {
  return !!storage.getStore()?.sink;
}
export function telemetryFields(): SsoFields {
  return (
    safely(() => ({
      ...storage.getStore()?.fields,
      ...storage.getStore()?.failure,
      stage: storage.getStore()?.failure?.stage || storage.getStore()?.stage,
      ...traceFields(storage.getStore()?.span),
    })) || {}
  );
}
export function logContextFields(): SsoFields {
  return safely(() => ({ ...storage.getStore()?.fields })) || {};
}
export function enrich(fields: SsoFields) {
  safely(() => {
    const state = storage.getStore();
    if (!state) return;
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) state.fields[key] = value;
    const attrs = attributes(fields);
    safely(() => state.span?.setAttributes(attrs));
    safely(() => state.requestSpan?.setAttributes(attrs));
    safely(() => trace.getActiveSpan()?.setAttributes(attrs));
  });
}
export function setStage(stage: string) {
  const state = storage.getStore();
  if (state) state.stage = stage;
}
export function event(
  sso_event: string,
  fields: SsoFields = {},
  msg = sso_event,
  severity: SsoEvent['severity'] = 'info'
) {
  safely(() => {
    const state = storage.getStore();
    if (!state) return;
    const record = {
      ...state.fields,
      stage: state.stage,
      ...fields,
      ...traceFields(trace.getActiveSpan() || state.span),
      sso_event,
      severity,
      msg,
    };
    if (state.sink) {
      safely(() => {
        const pending = state.sink!(record);
        if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
      });
    }
    safely(() =>
      (trace.getActiveSpan() || state.span)?.addEvent(
        sso_event,
        attributes({ ...state.fields, stage: state.stage, ...fields })
      )
    );
  });
}
export function failure(error: unknown, code?: string, category?: ErrorCategory) {
  safely(() => {
    const state = storage.getStore();
    if (!state || state.failure) return;
    state.failure = { ...failureFields(error, state.stage, code, category), stage: state.stage };
    const attrs = attributes({ ...state.failure, outcome: 'failed' });
    attrs['error.type'] = state.failure.error_code;
    for (const span of new Set([state.span, trace.getActiveSpan()])) {
      safely(() => span?.setAttributes(attrs));
      safely(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: state.failure!.error_message }));
    }
    safely(() =>
      (trace.getActiveSpan() || state.span)?.recordException({
        name: state.failure!.error_type,
        message: state.failure!.error_message,
        stack: state.failure!.err?.stack,
      })
    );
  });
}
export function diagnostic<T>(error: T, code: string, category?: ErrorCategory): T {
  failure(error, code, category);
  return error;
}
export function warning(error: unknown, code: string, fields: SsoFields = {}) {
  safely(() => {
    const current = trace.getActiveSpan();
    // Best-effort cleanup failure must not make token issuance a failure.
    if (current && current !== storage.getStore()?.span) {
      current.setStatus({ code: SpanStatusCode.ERROR, message: code });
      current.setAttribute('error.type', code);
    }
  });
  safely(() =>
    event(
      code,
      { ...failureFields(error, storage.getStore()?.stage || 'operation', code, 'storage'), ...fields },
      code,
      'error'
    )
  );
}

async function inSpan<T>(span: Span | undefined, work: () => Promise<T>): Promise<T> {
  const active = safely(() => span && trace.setSpan(context.active(), span));
  if (!active) return work();
  let invoked = false;
  const invoke = () => {
    invoked = true;
    return work();
  };
  let result: Promise<T>;
  try {
    result = context.with(active, invoke);
  } catch (err) {
    if (invoked) throw err;
    return work();
  }
  return result;
}

export async function withSsoTelemetry<T>(
  operation: string,
  options: { telemetry?: SsoTelemetrySink; fields?: SsoFields; responseStatus?: () => number | undefined },
  work: () => Promise<T>
): Promise<T> {
  // The HTTP adapter owns the request when present; direct library consumers
  // get the same scope around the public controller operation.
  if (storage.getStore()) return work();
  const requestSpan = safely(() => trace.getActiveSpan());
  const span = safely(() => tracer.startSpan(`polis.${operation}`));
  const state: State = {
    fields: {
      telemetry_version: 1,
      fingerprint_namespace: process.env.SSO_TELEMETRY_NAMESPACE || 'polis-sso',
      operation,
      ...options.fields,
    },
    stage: 'request_validation',
    span,
    requestSpan,
    sink: options.telemetry,
    links: new Set(),
  };
  const started = performance.now();
  return storage.run(state, () =>
    inSpan(span, async () => {
      enrich(state.fields);
      event('polis_request_started');
      try {
        return await work();
      } catch (err) {
        failure(err);
        throw err;
      } finally {
        const summary = {
          ...(state.failure || {}),
          outcome: state.failure ? 'failed' : 'succeeded',
          duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
          http_response_status: safely(() => options.responseStatus?.()),
        };
        enrich({ outcome: summary.outcome, http_response_status: summary.http_response_status });
        event(
          'polis_request_completed',
          summary,
          `Polis ${operation} ${summary.outcome}`,
          state.failure ? failureSeverity(state.failure) : 'info'
        );
        safely(() => span?.end());
      }
    })
  );
}

export async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const state = storage.getStore();
  if (!state) return work();
  state.stage = name;
  const span = safely(() =>
    tracer.startSpan(`polis.${name}`, { attributes: attributes({ ...state.fields, stage: name }) })
  );
  return inSpan(span, async () => {
    try {
      return await work();
    } catch (err) {
      failure(err);
      throw err;
    } finally {
      safely(() => span?.end());
    }
  });
}

// Only these flow facts may survive a redirect. Never persist current request
// IDs, routes, error state, raw tokens, secrets, or an entire logger/context.
const continuationKeys = [
  'polis_session_fp',
  'downstream_state_fp',
  'downstream_nonce_fp',
  'upstream_state_fp',
  'upstream_nonce_fp',
  'requested_email',
  'requested_domain',
  'connection_id',
  'connection_name',
  'tenant',
  'product',
  'federation_app_id',
  'downstream_client_id',
  'upstream_client_id',
  'provider_name',
  'upstream_protocol',
  'downstream_protocol',
  'login_type',
  'downstream_client_type',
  'upstream_client_auth',
  'downstream_redirect_uri',
  'upstream_redirect_uri',
  'session_created_at',
  'session_ttl_seconds',
  'asserted_email',
  'asserted_email_source',
  'user_email',
  'first_name',
  'last_name',
  'first_name_missing',
  'last_name_missing',
  'first_name_placeholder',
  'last_name_placeholder',
  'upstream_subject',
  'issued_subject',
  'subject_source',
  'profile_validated',
  'id_token_email',
  'id_token_email_verified',
  'id_token_email_verified_present',
  'userinfo_email',
  'userinfo_email_verified',
  'userinfo_email_verified_present',
  'email_verified',
  'email_verified_present',
  'email_verified_source',
  'upstream_issuer',
  'upstream_audience',
  'upstream_token_alg',
  'upstream_token_kid',
  'roles_count',
  'groups_count',
  'claim_keys',
  'authorization_code_fp',
  'id_token_fp',
];
export type SsoContinuation = { version: 1; fields: SsoFields; span?: SpanContext };
export function continuation(): SsoContinuation | undefined {
  return safely(() => {
    const state = storage.getStore();
    if (!state) return undefined;
    const fields = Object.fromEntries(
      continuationKeys.filter((key) => state.fields[key] !== undefined).map((key) => [key, state.fields[key]])
    );
    const sc = state.span?.spanContext();
    return {
      version: 1,
      fields,
      ...(sc && isSpanContextValid(sc)
        ? { span: { traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags } }
        : {}),
    };
  });
}
export function restoreContinuation(value: unknown) {
  safely(() => {
    const state = storage.getStore();
    if (!state) return;
    const saved = value as SsoContinuation | undefined;
    enrich({ continuation_context_found: saved?.version === 1 });
    if (saved?.version !== 1 || !saved.fields || typeof saved.fields !== 'object') return;
    const fields: SsoFields = {};
    for (const key of continuationKeys) {
      const field = saved.fields[key];
      if (scalar(field) || (Array.isArray(field) && field.every(scalar))) fields[key] = field;
    }
    if (state.fields.polis_session_fp && fields.polis_session_fp !== state.fields.polis_session_fp) {
      if (fields.polis_session_fp) enrich({ correlation_mismatch: true });
      delete fields.polis_session_fp;
    }
    enrich(fields);
    const sc = saved.span;
    if (
      sc &&
      /^[a-f0-9]{32}$/i.test(sc.traceId) &&
      /^[a-f0-9]{16}$/i.test(sc.spanId) &&
      isSpanContextValid(sc) &&
      typeof sc.traceFlags === 'number'
    ) {
      const key = `${sc.traceId}/${sc.spanId}`;
      if (!state.links.has(key)) {
        state.links.add(key);
        safely(() => state.span?.addLink({ context: sc, attributes: { 'sso.link.type': 'continuation' } }));
        enrich({ linked_trace_id: sc.traceId, linked_span_id: sc.spanId });
      }
    }
  });
}

export function bindSession(session: any, sessionId?: string) {
  safely(() => {
    const requested = session?.requested || {};
    if (sessionId) enrich({ polis_session_fp: fingerprint('polis-session', sessionId) });
    restoreContinuation(session?.telemetry);
    enrich({
      requested_email: typeof requested.login_hint === 'string' ? requested.login_hint : undefined,
      user_email:
        storage.getStore()?.fields.asserted_email ||
        (typeof requested.login_hint === 'string' ? requested.login_hint : undefined),
      downstream_state_fp: fingerprint('oauth-state', requested.state ?? session?.state),
      downstream_nonce_fp: fingerprint('nonce', requested.nonce),
      upstream_nonce_fp: fingerprint('nonce', session?.oidcNonce),
      downstream_client_id: requested.client_id,
      federation_app_id: session?.oidcFederated?.id,
      downstream_redirect_uri: requested.redirect_uri ?? session?.redirect_uri,
      upstream_redirect_uri: session?.upstreamRedirectUri,
      login_type: requested.login_type,
      provider_name: requested.providerName,
      // Token redemption recovers an embedded session, not the session store.
      session_lookup: sessionId !== undefined ? (session ? 'hit' : 'miss') : undefined,
    });
    const created = storage.getStore()?.fields.session_created_at;
    if (typeof created === 'string' && Number.isFinite(Date.parse(created)))
      enrich({ session_age_ms: Date.now() - Date.parse(created) });
  });
}

export function bindConnection(connection: any) {
  safely(() => {
    if (!connection) return;
    const oidc = connection.oidcProvider;
    enrich({
      connection_id: connection.clientID,
      connection_name: connection.name,
      tenant: connection.tenant,
      product: connection.product,
      upstream_protocol: oidc ? 'oidc' : 'saml',
      upstream_client_id: oidc?.clientId,
      provider_name: oidc?.provider ?? connection.idpMetadata?.provider,
    });
  });
}

export function bindProfile(claims: any) {
  safely(() => {
    if (!claims || typeof claims !== 'object') return;
    const state = storage.getStore();
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const first = typeof claims.firstName === 'string' ? claims.firstName : undefined;
    const last = typeof claims.lastName === 'string' ? claims.lastName : undefined;
    const count = (value: unknown) =>
      Array.isArray(value) ? value.length : typeof value === 'string' ? 1 : undefined;
    enrich({
      asserted_email: email,
      user_email: email || state?.fields.requested_email,
      first_name: first,
      last_name: last,
      first_name_missing: !first?.trim(),
      last_name_missing: !last?.trim(),
      first_name_placeholder: first?.trim().toLowerCase() === 'not_configured',
      last_name_placeholder: last?.trim().toLowerCase() === 'not_configured',
      upstream_subject: claims.id,
      roles_count: count(claims.roles),
      groups_count: count(claims.groups),
      claim_keys:
        claims.raw && typeof claims.raw === 'object' ? Object.keys(claims.raw) : Object.keys(claims),
    });
  });
}

export function bindOidcProfile(idTokenClaims: any, userinfo: any, claims: any, idToken?: string) {
  safely(() => {
    bindProfile(claims);
    const fromToken = typeof idTokenClaims.email === 'string';
    const selected = fromToken ? idTokenClaims : userinfo;
    enrich({
      asserted_email_source: fromToken ? 'id_token' : 'userinfo',
      profile_validated: true,
      subject_source: 'oidc_sub',
      upstream_issuer: idTokenClaims.iss,
      upstream_audience: idTokenClaims.aud,
      id_token_email: idTokenClaims.email,
      userinfo_email: userinfo.email,
      id_token_email_verified_present: Object.hasOwn(idTokenClaims, 'email_verified'),
      userinfo_email_verified_present: Object.hasOwn(userinfo, 'email_verified'),
      id_token_email_verified: scalar(idTokenClaims.email_verified)
        ? idTokenClaims.email_verified
        : undefined,
      userinfo_email_verified: scalar(userinfo.email_verified) ? userinfo.email_verified : undefined,
      email_verified_present: Object.hasOwn(selected, 'email_verified'),
      email_verified: scalar(selected.email_verified) ? selected.email_verified : undefined,
      email_verified_source: fromToken ? 'id_token' : 'userinfo',
      upstream_id_token_fp: fingerprint('id-token', idToken),
    });
    if (idToken) {
      const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8'));
      enrich({ upstream_token_alg: header.alg, upstream_token_kid: header.kid });
    }
  });
}
