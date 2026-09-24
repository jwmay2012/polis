# Explicit login routing

An OIDC federation application can route literal domains and exact email addresses
to existing connections. Exact email wins over domain. Tenant/product membership
remains the eligibility boundary. This does not rename tenants, change subjects,
merge identities, or revoke sessions.

The connection editor saves a draft separately from live policy. **Review and
publish** shows the exact matches being moved. Move one, several, or all listed
matches now and the rest later. Omitted matches are not withdrawn; withdrawal
requires a separate confirmation. A published match requires SSO even when its
connection is disabled, missing, or outside the application's current scope.
An unavailable exact-email rule never falls through to the domain rule.

The optional retirement step disables former connections after their last published
match moves. Global deactivation also stops direct links and legacy-app logins;
the published-route list cannot enumerate every caller. Transfer and deactivation
are separate writes. The UI reports partial publications and failed deactivation.
Reload and reconfirm rather than blindly retrying an old retirement request.

## Storage and compatibility

The database schema is unchanged. The `sso:routing` namespace holds drafts, one
published record per `(application, match)`, and an application activation marker.
Ordinary connection/app updates cannot overwrite those records. Every live write
gets a fresh revision; conditional create/update/delete rejects stale confirmations.
Only PostgreSQL and memory currently support these conditional operations. Other
drivers explicitly refuse them; their ordinary storage operations stay unchanged.
Stored bytes and encryption fields used for comparison never leave the server.

App/connection deletion refuses known references. Index scans stop after 100 pages,
follow the configured engine's pagination, and filter stale owner entries. An
incomplete scan cannot prove absence. These guards are not cross-record
transactions: orphaned bindings still resolve as required-but-unavailable.

Unmanaged applications retain legacy tenant routing. Creating a second active
same-tenant connection can still disrupt them. Do not start the new pilot workflow
until that application is migrated. Direct `idp_hint` selection keeps its existing
scope/activity checks; it selects a connection, not an identity or access grant.

## Discovery

`POST /api/sso/resolve` accepts only `{"email":"person@example.com"}`. The server
selects the application with `SSO_DISCOVERY_APP_ID` (the app ID, not its `fed_`
prefixed OAuth client ID). No caller-selected app or connection catalog is exposed.

```json
{"required":true,"idp_hint":"connection-id"}
{"required":true,"idp_hint":null,"reason":"deactivated"}
{"required":false}
```

An unconfigured application or initial storage failure returns 503, not no-match.
Before activation, imported bindings already return required/available or
required/unavailable for verification; an email with no binding returns 503.
Only an activated application can return `required:false` for an unbound email.
This endpoint has no API-key requirement. Deploy it only through private/in-cluster
ingress; explicitly verify that public ingress excludes it before enabling consumers.
It is not a management API. Whether failed discovery permits ordinary login is the
consumer's deliberate availability policy, not backend password enforcement.

Preserve `login_hint` for email routing and upstream account selection. Do not assume
an intervening identity server forwards `idp_hint`.

## Import and rollout

The image alone does not activate explicit routing. Prepare a reviewed manifest of
effective requirements from every existing consumer, including exact-email pilots,
Mobile enable/whitelist settings, and direct-provider exceptions. Connection tenants
alone are not publication authority. Resolve contradictory/missing owners explicitly.
Enrollment configuration remains the consuming application's responsibility.

The session-protected admin endpoint is
`/api/admin/connections/{connectionID}/routing?app={appID}`. `GET` returns the draft,
published matches, eligibility and activation revision. Sign in through the private
admin UI to use its session; a management API key does not authorize this endpoint.
For credential-based automation, keep one cookie jar: `GET /api/auth/csrf`, then
form-POST `/api/auth/callback/credentials` with that `csrfToken`, `email`, `password`,
`callbackUrl` (the private origin), and `json=true`. Verify `/api/auth/session`
identifies the intended administrator before making writes. Keep the password and
session cookies out of command arguments, logs and the import manifest. The isolated
recipe in `e2e/ui/routing-admin.spec.ts` uses only disposable fixture credentials.

`POST` actions are:

- `draft`: `matches` is a list of strings; this never changes live policy.
- `preview`: read current owners and revisions for those matches.
- `import`: `matches` contains `{match, expectedRevision:null}` entries. Before
  activation, the target must be the unique active legacy owner, or the unique
  inactive owner when none is active. Non-equivalent pre-cutover changes refuse.
- `managed`: `{enabled:true, expectedRevision:null}` activates after operator-verified
  coverage. Disabling requires the current activation revision.
- `publish`: entry shape as above, using each owner's reviewed current revision
  (null only for a new binding). Results report each independently saved match.
- `withdraw`: provide `match` and its `expectedRevision`.
- `retire`: provide `previousConnectionID` and the resulting `moves` revisions.
  Remaining references keep the former connection active.

Record revisions as imports are acknowledged. A repeated import refuses an existing
binding: that protects against conflicts but is not automatic resume. Reconcile a
lost/uncertain response before adopting its row into a rollback list. Never overwrite
another operator's decision merely because its owner matches an old manifest.

Order: additive image, reviewed import, private discovery verification, application
activation, consumer delegation, then new pilots/aliases/transfers. Keep installed-client
compatibility mappings until the release floor permits their retirement. Do not
enable consumer delegation with an incomplete manifest.

Rollback: disable consumer delegation first, restore legacy mode, then withdraw only
unchanged imported revisions. New aliases/transfers/deactivations may not be representable
by the old image: reconcile them explicitly rather than promise image-only rollback.
Before any policy activation/import, additive image rollback needs no schema restoration.

## Verification

Run the fork gates in `PATCHES.md`. The isolated Playwright suite covers drafts, pilots,
retained hints, partial moves, stale confirmations, withdrawal and retirement. It
generates fixture signing keys and uses no personal browser, real account or external IdP.

For the PostgreSQL fixture test, run in `npm/` against a disposable loopback database:

```sh
POLIS_ROUTING_TEST_POSTGRES=postgresql://fixture:fixture@127.0.0.1:55467/fixture npx tap --disable-coverage test/db/conditional-postgres.test.ts
```

It checks competing writes, stale deletion, ABA, plaintext/encryption, TTL/index effects
and unchanged schema. Never point it at shared application data.
