import { fingerprint } from './fingerprints';

type UpstreamErrorContext = Readonly<{
  upstream_endpoint: string;
  upstream_endpoint_role?: string;
  upstream_http_method?: string;
  upstream_duration_ms: number;
}>;

// An error can cross Next server-bundle boundaries, like the request context.
// Weak keys retain neither completed requests nor their errors indefinitely.
const errorContextKey = Symbol.for('polis.sso.error.context.v1');
const globals = globalThis as any;
const errorContexts: WeakMap<object, UpstreamErrorContext> = (globals[errorContextKey] ??= new WeakMap());

export function attachErrorContext<T>(error: T, fields: UpstreamErrorContext): T {
  try {
    if (error !== null && typeof error === 'object') {
      errorContexts.set(error, Object.freeze({ ...fields }));
    }
  } catch {
    // Diagnostic context must not change the rejected object or auth outcome.
  }
  return error;
}

/** Diagnostic projection only. Never changes an exception or an HTTP response. */
export function serializeError(error: unknown, seen = new Set<unknown>(), depth = 0): Record<string, any> {
  if (error === null || error === undefined) return { type: 'Error', message: String(error) };
  if (typeof error !== 'object') return { type: typeof error, message: String(error) };
  if (seen.has(error) || depth >= 5) return { type: 'Error', message: 'Cause chain truncated' };
  seen.add(error);
  const value = error as Record<string, any>;
  const result: Record<string, any> = {
    type: value.type || value.name || value.constructor?.name || 'Error',
    message: value.message || value.error_description || value.error || 'Unknown error',
  };
  for (const key of [
    'code',
    'statusCode',
    'status',
    'internalError',
    'stack',
    'error',
    'error_description',
  ]) {
    if (['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
  }
  if (value.cause !== undefined) result.cause = serializeError(value.cause, seen, depth + 1);
  // saml20's WrapError uses inner rather than the standard Error.cause.
  if (value.inner !== undefined) result.inner = serializeError(value.inner, seen, depth + 1);
  return result;
}

export type ErrorCategory =
  'request' | 'protocol' | 'routing' | 'configuration' | 'provider' | 'upstream' | 'storage' | 'internal';

export function failureFields(error: unknown, stage: string, code?: string, category?: ErrorCategory) {
  const err = serializeError(error);
  const result: Record<string, any> = {
    error_type: err.type,
    error_message: err.message,
    err,
  };
  if (err.statusCode !== undefined) result.auth_error_status = err.statusCode;
  if (err.code !== undefined) result.error_library_code = err.code;
  if (err.internalError) result.error_detail = err.internalError;

  const seen = new Set<unknown>();
  const descriptions: string[] = [];
  let current: any = error;
  for (let i = 0; current && typeof current === 'object' && i < 5 && !seen.has(current); i++) {
    seen.add(current);
    const attached = errorContexts.get(current);
    if (attached) {
      for (const [key, value] of Object.entries(attached)) result[key] ??= value;
    }
    if (typeof current.error === 'string') result.idp_error ??= current.error;
    if (typeof current.error_description === 'string') {
      result.idp_error_description ??= current.error_description;
      descriptions.push(current.error_description);
    }
    if (typeof current.message === 'string') descriptions.push(current.message);
    if (typeof current.claim === 'string') {
      result.invalid_claim ??= current.claim;
      if (current.claim === 'nonce') {
        result.expected_nonce_fp = fingerprint('nonce', current.expected);
        result.actual_nonce_fp = fingerprint('nonce', current.claims?.nonce);
      }
    }
    if (typeof current.code === 'string' && current.code.startsWith('OAUTH_'))
      result.error_library_code ??= current.code;
    const status = current.status ?? current.response?.status;
    if (typeof status === 'number') result.upstream_http_status ??= status;
    if (Array.isArray(current.error_codes)) {
      result.idp_error_codes ??= current.error_codes.filter(
        (v) => typeof v === 'number' || typeof v === 'string'
      );
    }
    for (const [source, target] of [
      ['trace_id', 'idp_trace_id'],
      ['correlation_id', 'idp_correlation_id'],
      ['timestamp', 'idp_error_timestamp'],
    ]) {
      if (typeof current[source] === 'string') result[target] ??= current[source];
    }
    if (
      typeof current.code === 'string' &&
      /^(ENOTFOUND$|EAI_AGAIN$|EAI_FAIL$|ECONNRESET$|ECONNREFUSED$|ECONNABORTED$|ETIMEDOUT$|EPIPE$|ENETUNREACH$|EHOSTUNREACH$|ESOCKETTIMEDOUT$|ERR_SOCKET_|ERR_TLS_|ERR_STREAM_PREMATURE_CLOSE$|CERT_|DEPTH_ZERO_|UNABLE_TO_)/.test(
        current.code
      )
    ) {
      result.network_error_code ??= current.code;
    }
    current = current.cause ?? current.inner;
  }
  const description = descriptions.join('\n');
  const vendorCodes = [...description.matchAll(/\bAADSTS(\d+)\b/g)].map((m) => m[1]);
  if (vendorCodes.length && !result.idp_error_codes?.length) {
    result.idp_error_codes = [...new Set(vendorCodes)];
    result.idp_error_codes_source = 'description';
  } else if (result.idp_error_codes?.length) result.idp_error_codes_source = 'response';
  for (const [pattern, key] of [
    [/Trace ID:\s*([a-f0-9-]{36})/i, 'idp_trace_id'],
    [/Correlation ID:\s*([a-f0-9-]{36})/i, 'idp_correlation_id'],
  ] as const) {
    if (!result[key]) {
      const match = description.match(pattern);
      if (match) {
        result[key] = match[1];
        result[`${key}_source`] = 'description';
      }
    }
  }

  const samlReasons: Record<string, string> = {
    'Invalid assertion signature.': 'saml_signature_invalid',
    'Assertion is expired.': 'saml_assertion_time_invalid',
    'Invalid audience.': 'saml_audience_mismatch',
    'Invalid InResponseTo.': 'saml_in_response_to_mismatch',
    'Assertion has already been used (replay detected).': 'saml_assertion_replayed',
    'publicKey or thumbprint are options required.': 'saml_certificate_missing',
  };
  const oidcReasons: Record<string, string> = {
    OAUTH_JWT_CLAIM_COMPARISON_FAILED: 'oidc_claim_mismatch',
    OAUTH_JWT_TIMESTAMP_CHECK_FAILED: 'oidc_token_time_invalid',
    OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED: 'oidc_attribute_mismatch',
    OAUTH_KEY_SELECTION_FAILED: 'oidc_signing_key_not_found',
    OAUTH_PARSE_ERROR: 'oidc_response_parse_failed',
    OAUTH_RESPONSE_IS_NOT_JSON: 'oidc_response_not_json',
    OAUTH_RESPONSE_IS_NOT_CONFORM: 'oidc_http_status_unexpected',
    OAUTH_TIMEOUT: 'oidc_request_timeout',
  };
  const samlReason =
    stage === 'saml_validate' ? descriptions.map((message) => samlReasons[message]).find(Boolean) : undefined;
  const oidcReason =
    oidcReasons[result.error_library_code] ||
    (result.error_library_code === 'OAUTH_INVALID_RESPONSE' &&
    descriptions.includes('JWT signature verification failed')
      ? 'oidc_signature_invalid'
      : undefined);
  result.error_code = code || samlReason || oidcReason || `${stage || 'operation'}_failed`;
  if (!code && samlReason) result.error_code_source = 'library_message';
  if (!code && oidcReason) result.error_code_source = 'library_code';
  category ??=
    samlReason === 'saml_certificate_missing' ? 'configuration' : samlReason ? 'protocol' : undefined;
  result.error_category =
    category ||
    (result.idp_error
      ? /^(invalid_client|unauthorized_client|invalid_scope)$/.test(result.idp_error)
        ? 'configuration'
        : 'provider'
      : /^(session_lookup|connection_lookup|federation_app_lookup|code_lookup|token_lookup|session_store|code_store|token_store|code_delete|session_delete)$/.test(
            stage
          ) && !(typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500)
        ? 'storage'
        : result.network_error_code
          ? 'upstream'
          : typeof err.statusCode === 'number' && err.statusCode < 500
            ? 'protocol'
            : 'internal');
  return result;
}

export function failureSeverity(fields: Record<string, any>): 'warn' | 'error' {
  return ['request', 'protocol', 'routing', 'provider'].includes(fields.error_category) ? 'warn' : 'error';
}
