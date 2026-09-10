# SSO telemetry

The application emits structured Pino records at INFO for meaningful SSO
milestones and request completion, WARN for normal request/protocol/routing
rejections and provider denials, and ERROR for configuration, dependency,
storage, and unexpected failures. No second SDK is initialized: manual spans
use the externally configured OpenTelemetry API provider.

The public OAuth/SAML handlers and direct OAuth-controller calls share a
request-local context. The library's optional `JacksonOption.telemetry`
callback receives a typed event; the application supplies the Pino adapter.
Library consumers without an event sink retain their existing logger behavior.
Sink exceptions/rejections cannot rerun or change the authentication operation.

## Events

`polis_request_started` and `polis_request_completed` surround authorize,
SAML/OIDC callback, token, and userinfo requests. Completion includes
`operation`, `stage`, `outcome`, `duration_ms`, and HTTP status when called
through the application. A failed auth operation returning an HTTP 302 error
redirect records `outcome=failed` and marks its **semantic** span as failed;
the transport status remains 302.

Milestones are `polis_authorize_started`, `polis_connection_selected`,
`polis_connection_selection_required`, `polis_idp_redirect_issued`,
`polis_idp_callback_received`, `polis_identity_validated`, `polis_code_issued`,
`polis_session_consumed`, `polis_token_redeemed`, `polis_code_consumed`, and
`polis_userinfo_served`. A milestone is not proof that a downstream app finished
login. Successful persistence events follow successful writes.

`stage` is the last operation entered, not a restored call-stack scope. The
milestone event name describes what completed; for example, code issuance may
be emitted after the `code_store` stage.

`polis_upstream_response` and `polis_upstream_request_failed` record facts about
one outbound HTTP call. Status, duration and provider response IDs belong to
that event and its span event, not mutable request-wide response attributes.
Request context retains the most recent endpoint/role/method. A non-mutating
error-context side channel preserves the actual failed-call facts through an
error's cause chain. A recovered call failure is not an authentication terminal;
only request completion is the canonical SSO operation outcome.

One request completion is the canonical failure record. Original errors keep
type/code/message/stack/cause, and receive a stable `error_code` plus
`error_category`. `auth_error_status`, `upstream_http_status`, and
`http_response_status` are deliberately different fields. Provider diagnostics
use `idp_error`, `idp_error_codes`, `idp_trace_id`, `idp_correlation_id`, and
related fields; provider IDs must not overwrite the OTel IDs. Description-
parsed provider fields have a source marker.

`polis_error_report_saved` links a mnemonic `polis_error_report_id` to the
request's OTel IDs. This is the existing DB error-report ID, not another trace
ID. Report persistence failures and authorization-code cleanup failures are
separate operational records; best-effort cleanup does not falsely mark a
successfully issued token as failed. The underlying auth behavior is unchanged.

Stored reports include the available semantic fields, including identity
details and error causes/stacks. Explicit caller context retains its existing
indexing precedence; telemetry does not reassign report tenancy. The existing
report-redaction option removes `profile`, `oidcTokenSet`, and `samlResponse`;
it is not a general scrubber of every semantic field or free-text error.

## Context

Fields appear as known: `connection_id`, `connection_name`, `tenant`,
`product`, `federation_app_id`, `routing_source`, candidate counts,
`downstream_client_id`, `upstream_client_id`, and separate upstream/downstream
protocol and client-auth modes. Public client does not imply mobile. Explicit
`idp_hint` retains priority and scope checks; different login-hint domains are
not a new rejection condition.

Identity records contain `requested_email`, `asserted_email`, `user_email`,
first/last names and missing/placeholder flags, upstream/issued subject,
claim-name lists, and group/role counts. OIDC ID-token and UserInfo email and
verification values retain their provenance; absent verification is not false.
`profile_validated` describes completion of the existing provider-profile
validation, not a new assurance level or permission to merge identities.
Kratos identity/session ownership remains downstream.

The application can bind already-existing caller headers using
`SSO_REQUEST_ID_HEADER` (default `x-request-id`) and
`SSO_CLIENT_SESSION_ID_HEADER` (default `x-session-id`). It does not require a
new frontend header. Those values are supporting telemetry, not auth authority.

## Fingerprint contract, version 1

```text
lowercase_hex(sha256(UTF8(namespace + "/" + kind + "/v1:" + exact_value)))
```

`namespace` is `SSO_TELEMETRY_NAMESPACE`, default `polis-sso`. Configure the
same namespace and byte contract in every joining service. Each request logs
`fingerprint_namespace` and `telemetry_version=1`. The kinds are `oauth-state`,
`polis-session`, `oauth-code`, `id-token`, `access-token`, and `nonce`.
Canonical test vectors are in `npm/test/sso/data/telemetry-fingerprints.json`.

`downstream_state_fp` covers the client's parsed OAuth state;
`upstream_state_fp` covers the full state/RelayState sent to the IdP;
`polis_session_fp` covers the exact internal session key without the RelayState
prefix. `downstream_nonce_fp` and `upstream_nonce_fp` are different values.
`authorization_code_fp` and `access_token_fp` cover their **whole wire values**
(`encryption-key.store-key`), not just the store suffix. `id_token_fp` covers
the exact issued compact JWT, not reserialized claims; `upstream_id_token_fp`
is separately named when present. `issued_nonce_fp` describes the actual
issued claim. Missing/non-string values have no fingerprint.

Query/form decoding happens once in the HTTP layer. Fingerprinting does not
URL-decode again, trim, lowercase, or stringify objects. These fields are
correlation evidence, not proof that received protocol data passed validation.

## Continuity and Span Links

The existing session ID is allocated at authorize entry, including routing
failures, but an authorization session is still persisted only after validation.
A narrow optional `telemetry` object in encrypted session/code/token records
contains whitelisted flow facts and the originating semantic SpanContext.
Restoring it adds a Span Link; it never changes the current request's parent
trace. Current request IDs, routes, and error state are not restored. Telemetry
is not included in public token responses, JWT claims, or userinfo.

Legacy records without this object still authenticate normally. A lookup miss
means `sso_session_not_found`/`authorization_code_not_found`/`access_token_not_found`,
not an unsupported assertion that the value expired or was replayed. Earlier
issuance/consumption records provide evidence for a later resolver.

Request-local context is shared safely across Next server bundles through an
AsyncLocalStorage carrier; no global logger is rebound to the current user.
Lazy process initialization detaches both the SSO and OpenTelemetry contexts,
so process-lifetime timers cannot inherit the first request. Ordinary request
work and the caller awaiting initialization retain their request context.
File logging uses the same context mixin and error serializer as stdout while
remaining JSON even in development mode.
Logs outside active traces may lack OTel IDs. Events still emit when tracing
is unsampled or unconfigured. Full credentials/tokens/assertions are not copied
into routine semantic events; the existing detailed error-report mechanism and
its existing settings are unchanged.
