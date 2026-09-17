# Correlated application logging

Use the existing logger. Explain what happened in English, attach useful data,
and preserve the real error. Request/trace context and credential redaction are
handled centrally; routes do not need event names or an error classification.

```ts
// Application: ordinary Pino, including child loggers.
logger.info({ connection_id: connection.clientID }, 'SSO connection selected');
logger.error({ err }, 'Unable to handle OAuth request');

// Library: its existing message-first logger interface.
this.opts.logger.info('SSO connection selected');
this.opts.logger.error('Unable to process the OIDC response', err);
```

## Shared machinery

`lib/logger.ts` extends Pino with request/trace context, source location and
non-mutating error serialization. Errors retain their type, message, native
code/status, stack, cause and the older SAML `inner` cause. Provider diagnostics
remain inside `err`; a provider's trace ID never becomes the OTel trace ID.
An error call without an exception receives its call-site stack. File logging
uses the same behavior and stays JSON even in development.

`npm/src/logging/context.ts` adapts the library's existing `logger` option. There
is no second event sink. Existing library/database log calls inherit the current
context, and a rejected or throwing logger cannot fail or retry authentication.
Logs outside requests still work; trace/span IDs appear only when available.

`lib/request-logging.ts` wraps the shared API `defaultHandler` and the six public
OAuth/SAML handlers. Routes using those boundaries receive one HTTP completion
record with method, path, status actually sent, elapsed time, response byte count,
and bounded, redacted request/response details. Other bespoke API routes do not
automatically acquire this HTTP record; their Pino logs still benefit from the
logger. New handlers should use the existing shared boundary.

The boundary observes existing body parsing and response writes. It does not
read a request stream ahead of the application or change response bytes. Parsed
JSON/form request objects and JSON responses are capped at 64 KiB for capture;
unparsed, non-JSON, oversized and incomplete bodies are marked omitted. A closed
response records elapsed time and the status already sent, if any. An unhandled
handler exception is logged and rethrown unchanged. A process kill or a request
that never finishes/closes cannot produce a completion record. There is no
second routine request-start record.

Small common facts repeat where useful: request/trace IDs, method/path, selected
connection, provider/client modes and resolved identity. HTTP payloads appear
only on the HTTP record. Add newly resolved facts with `bindContext` at their
point of discovery, or put local details on an ordinary logger call.

Every HTTP request receives a fresh local `request_id`, including redirects with
no caller ID. The application separately reads `client_request_id` through
`SSO_REQUEST_ID_HEADER` (default `x-request-id`) and `client_session_id` through
`SSO_CLIENT_SESSION_ID_HEADER` (default `x-session-id`). These caller values are
correlation hints, never identity or authorization inputs. No new frontend header
is required, and a repeated caller ID does not reuse a local request ID.

## SSO evidence

The SSO-specific additions are factual context, a few ordinary messages at
meaningful boundaries, and cross-request continuity. Examples include connection
selection, IdP redirect, validated identity, code issuance, token redemption and
userinfo. These say what Polis did, not that the downstream application finished
login. Original authentication decisions, exception messages and public response
formats remain unchanged.

Each public OAuth controller method gets one semantic span through a decorator.
There are no per-check/stage spans. An error marks this operation span, not its
HTTP parent: a failed login can still have a correctly delivered HTTP 302. The
externally configured SDK owns all providers and exporters. Factual attributes
retain the `sso.*` names used by the existing deployment.

Outbound IdP calls log their own endpoint, method, duration, status and provider
request IDs. Those facts are not carried forward as mutable request attributes:
a later socket failure cannot inherit a discovery response's HTTP 200. A
recoverable call failure is a warning; the actual operation's error determines
whether authentication failed. Best-effort code-cleanup and error-report storage
failures also warn without undoing a successfully issued token.

Requested and asserted identity stay separate. `requested_email` is caller
input; `user_email`/`asserted_email` come from the resolved provider profile.
ID-token and UserInfo emails and verification values retain their provenance;
missing verification is not false and is not borrowed from another address.
`profile_validated` means the existing profile checks finished, not a new
assurance level or permission to merge accounts. Kratos owns its own identities
and sessions downstream.

Automatic SDK HTTP spans are outside this logger. Configure the collector to
remove raw URL queries and tokenized setup paths before export; log redaction
alone does not sanitize those SDK attributes.

## Credential handling

The logger redacts credentials in structured fields, error text, interpolated
messages and Pino child bindings. Known secret values are tracked within the
request so later errors cannot repeat them. Passwords, cookies, authorization
headers, client secrets, tokens, codes, state/nonces, SAML assertions and private
keys are masked. API keys retain the last four characters, including keys shorter
than four. URLs retain origin/path, not query strings, fragments or userinfo.
Configured API keys and database URL credentials are also registered centrally.
Redaction works on copies, never on request/response/error objects.

This is not arbitrary-secret detection: callers must not disguise credentials in
unknown fields or manually dump whole external objects. Ordinary logs can contain
emails, names, claim names and identifiers; scalar bound facts also appear as span
attributes. Both logs and traces require restricted access. These values are not
high-cardinality stream labels. Existing encrypted admin error reports retain
their existing `SSO_TRACES_REDACT_KEYS` behavior; that setting is not a general
scrubber. A saved report's mnemonic `polis_error_report_id` links its log to the
original request. Only request/trace/span IDs, operation and the session fingerprint
are added to existing report context. Caller-provided report tenant/product retain
indexing precedence.

## Fingerprints and continuation, version 1

```text
lowercase_hex(sha256(UTF8(namespace + "/" + kind + "/v1:" + exact_value)))
```

`namespace` is `SSO_TELEMETRY_NAMESPACE`, default `polis-sso`. Joining services
must use the same namespace and exact bytes. Logs carry `fingerprint_namespace`
and `telemetry_version=1`; fixtures pin the byte contract in
`npm/test/sso/data/telemetry-fingerprints.json`.

Kinds are `oauth-state`, `polis-session`, `oauth-code`, `id-token`, `access-token`
and `nonce`. Upstream and downstream state/nonce are separate. `polis_session_fp`
covers the internal session key without the RelayState prefix; code/access-token
fingerprints cover the full wire value (`encryption-key.store-key`). JWT
fingerprints cover the exact compact token, not reserialized claims. Missing or
non-string values have no fingerprint. HTTP decoding happens once; the hash does
not trim, lowercase or URL-decode again. A fingerprint is correlation evidence,
not proof of validation.

A narrow optional `telemetry` object in the existing encrypted session/code/token
records stores whitelisted flow facts and a SpanContext. Profile-derived email,
names, subject, counts and claim names are rebound from the already-loaded profile,
not duplicated in the continuation. Routing facts and original ID-token/UserInfo
verification provenance remain because the token record does not retain the session.
Restoring it adds a real
Span Link; it never changes the new request's parent or restores old request IDs,
paths or errors. It is absent from public responses and JWT claims. Legacy records
and malformed optional metadata still authenticate normally. Lookup miss logs do
not pretend to know whether a credential expired, was replayed or never existed.

AsyncLocalStorage carries request context across awaits and Next bundles without
globally rebinding a logger to a user. Lazy Jackson initialization detaches both
logging and OTel context so process-lifetime timers cannot inherit the first
request. Ordinary request work and the caller awaiting initialization retain
their own context.
