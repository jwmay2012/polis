import { isSpanContextValid, type SpanContext } from '@opentelemetry/api';
import {
  bindContext,
  currentContext,
  continuationSpan,
  linkContext,
  type LogFields,
} from '../logging/context';
import { fingerprint as hash, type FingerprintKind } from '../opentelemetry/fingerprints';
import { secrets } from '../logging/context';
import { redact } from '../logging/redact';
export {
  bindContext,
  contextFields,
  currentLogger,
  logOperation,
  markOperationFailed,
} from '../logging/context';
export function fingerprint(kind: FingerprintKind, value: unknown) {
  // Once a credential/state value is known, keep it out of later error text too.
  if (typeof value === 'string') redact({ token: value }, secrets());
  return hash(kind, value);
}

const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);
const safely = <T>(work: () => T): T | undefined => {
  try {
    return work();
  } catch {
    return undefined;
  }
};

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
export type LogContinuation = { version: 1; fields: LogFields; span?: SpanContext };
export function continuation(): LogContinuation | undefined {
  return safely(() => {
    const state = currentContext();
    if (!state) return undefined;
    const fields = Object.fromEntries(
      continuationKeys.filter((key) => state.fields[key] !== undefined).map((key) => [key, state.fields[key]])
    );
    const sc = continuationSpan();
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
    const state = currentContext();
    if (!state) return;
    const saved = value as LogContinuation | undefined;
    bindContext({ continuation_context_found: saved?.version === 1 });
    if (saved?.version !== 1 || !saved.fields || typeof saved.fields !== 'object') return;
    const fields: LogFields = {};
    for (const key of continuationKeys) {
      const field = saved.fields[key];
      if (scalar(field) || (Array.isArray(field) && field.every(scalar))) fields[key] = field;
    }
    if (state.fields.polis_session_fp && fields.polis_session_fp !== state.fields.polis_session_fp) {
      if (fields.polis_session_fp) bindContext({ correlation_mismatch: true });
      delete fields.polis_session_fp;
    }
    bindContext(fields);
    const sc = saved.span;
    if (
      sc &&
      /^[a-f0-9]{32}$/i.test(sc.traceId) &&
      /^[a-f0-9]{16}$/i.test(sc.spanId) &&
      isSpanContextValid(sc) &&
      typeof sc.traceFlags === 'number'
    ) {
      linkContext(sc);
    }
  });
}

export function bindSession(session: any, sessionId?: string) {
  safely(() => {
    const requested = session?.requested || {};
    if (sessionId) bindContext({ polis_session_fp: fingerprint('polis-session', sessionId) });
    restoreContinuation(session?.telemetry);
    bindContext({
      requested_email: typeof requested.login_hint === 'string' ? requested.login_hint : undefined,
      user_email: currentContext()?.fields.asserted_email,
      downstream_state_fp: fingerprint('oauth-state', requested.state ?? session?.state),
      downstream_nonce_fp: fingerprint('nonce', requested.nonce),
      upstream_nonce_fp: fingerprint('nonce', session?.oidcNonce),
      downstream_client_id: requested.client_id,
      federation_app_id: session?.oidcFederated?.id,
      downstream_redirect_uri: requested.redirect_uri ?? session?.redirect_uri,
      // The legacy session field also holds an unused OIDC URL for SAML.
      // Keep the actual handoff URI captured by authorize; only OIDC sessions
      // can recover a meaningful value from the legacy field.
      upstream_redirect_uri:
        currentContext()?.fields.upstream_redirect_uri ??
        (typeof session?.oidcNonce === 'string' ? session?.upstreamRedirectUri : undefined),
      login_type: requested.login_type,
      provider_name: requested.providerName,
      // Token redemption recovers an embedded session, not the session store.
      session_lookup: sessionId !== undefined ? (session ? 'hit' : 'miss') : undefined,
    });
    const created = currentContext()?.fields.session_created_at;
    if (typeof created === 'string' && Number.isFinite(Date.parse(created)))
      bindContext({ session_age_ms: Date.now() - Date.parse(created) });
  });
}

export function bindConnection(connection: any) {
  safely(() => {
    if (!connection) return;
    const oidc = connection.oidcProvider;
    bindContext({
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
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const first = typeof claims.firstName === 'string' ? claims.firstName : undefined;
    const last = typeof claims.lastName === 'string' ? claims.lastName : undefined;
    const count = (value: unknown) =>
      Array.isArray(value) ? value.length : typeof value === 'string' ? 1 : undefined;
    bindContext({
      asserted_email: email,
      user_email: email,
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
    bindContext({
      asserted_email_source: fromToken ? 'id_token' : 'userinfo',
      profile_validated: true,
      subject_source: 'oidc_sub',
      upstream_issuer: idTokenClaims.iss,
      upstream_audience: idTokenClaims.aud,
      id_token_email: idTokenClaims.email,
      userinfo_email: userinfo.email,
      id_token_email_verified_present: Object.prototype.hasOwnProperty.call(idTokenClaims, 'email_verified'),
      userinfo_email_verified_present: Object.prototype.hasOwnProperty.call(userinfo, 'email_verified'),
      id_token_email_verified: scalar(idTokenClaims.email_verified)
        ? idTokenClaims.email_verified
        : undefined,
      userinfo_email_verified: scalar(userinfo.email_verified) ? userinfo.email_verified : undefined,
      email_verified_present: Object.prototype.hasOwnProperty.call(selected, 'email_verified'),
      email_verified: scalar(selected.email_verified) ? selected.email_verified : undefined,
      email_verified_source: fromToken ? 'id_token' : 'userinfo',
      upstream_id_token_fp: fingerprint('id-token', idToken),
    });
    if (idToken) {
      const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8'));
      bindContext({ upstream_token_alg: header.alg, upstream_token_kid: header.kid });
    }
  });
}
