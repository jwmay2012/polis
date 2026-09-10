# Fork patches

This fork carries a short patch series on top of upstream
[ory/polis](https://github.com/ory/polis). Upstream is followed at pinned
commits of `main`, not at release tags: Ory publishes Polis releases from an
internal tree and the open-source repository has not been tagged since
`v26.2.0`, while security fixes keep landing on `main`.

## Layout

| Ref                  | Meaning                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `main`               | Mirror of upstream `main`, fast-forwarded only. Never carries patches.                                                             |
| `release/YYYY.MM.DD` | The patch series rebased onto upstream `main` as of that day. One branch per rebase; older branches are kept as history.           |
| `vYYYY.MM.DD`        | A build of a release branch, tagged on the day it was built. A second build the same day is `vYYYY.MM.DD.1`. Tags are never moved. |

Upstream itself uses `vYY.Q.N` (year, quarter, release number), so the
four-digit year keeps this fork's tags visibly distinct from upstream's.

Current base: upstream `main` at `e13ed6541ec026dc37243f975b6d88be9488b687`
(2026-07-27), on branch `release/2026.09.11`.

## The series

Each patch is one commit. They apply in this order.

1. **Route SSO connections by the login_hint email domain, with a strict mode.**
   Absent an explicit `idp_hint`, when `login_hint` is an email address,
   `resolveConnection` keeps only the active connections whose `tenant` equals
   that address's domain. An `idp_hint` is the exact connection selected by
   Polis's connection picker and deliberately retains priority. With
   `STRICT_DOMAIN_ROUTING=true`, a missing hint, an invalid address, an
   unknown domain, or more than one matching connection is an error
   (`missing_login_hint`, `invalid_login_hint`, `domain_not_configured`,
   `ambiguous_domain`) instead of a connection picker. `ENABLE_DOMAIN_ROUTING`
   defaults on; `false` disables the filter. Deactivated connections never
   match. Files: `npm/src/controller/domain-utils.ts`,
   `npm/src/controller/sso-handler.ts`, `.env.example`.
2. **Support public clients (mobile/SPA) on identity federation apps with
   public redirect URLs and PKCE.** A federation app gains
   `publicRedirectUrls`. A downstream client whose `redirect_uri` is in that
   list redeems its code with PKCE alone; a client using any other allowed
   redirect must still present the app's `client_secret`. Sessionless codes
   from IdP-initiated flows always require a client ID and secret; they cannot
   use the public-client exception because no authorization session exists to
   bind PKCE or a public redirect. Files:
   `npm/src/ee/identity-federation/{app,types}.ts`,
   `npm/src/controller/oauth.ts`, `internal-ui/src/identity-federation/`.
3. **Support a per-connection public upstream redirect URI and a
   public-client OIDC callback for mobile.** An OIDC connection gains
   `oidcPublicUpstreamRedirectUri`. When the downstream client is public
   (patch 2) and the selected connection has that URI, the upstream
   authorization uses it as `redirect_uri` and the upstream code exchange
   uses PKCE without the connection's client secret, so an IdP can register
   Polis as a mobile/public application. `pages/api/oauth/oidc/mobile.ts`
   serves that callback through the same controller as `/api/oauth/oidc`.
   Files:
   `npm/src/controller/connection/oidc.ts`, `npm/src/controller/oauth.ts`,
   `components/connection/PublicClientSettings.tsx`.
4. **Forward login_hint to the IdP on SAML SSO redirects.** The hint is added
   to the HTTP-Redirect URL and to the HTTP-POST form action. It is not part
   of the signed query (`SAMLRequest`, `RelayState`, `SigAlg`). File:
   `npm/src/controller/oauth.ts`.
5. **Await Directory Sync webhook batch processing.** `process()` retains its
   in-process and distributed locks until `_process()` finishes, catches its
   asynchronous failures, and does not report completion while webhook
   delivery is still running. Files:
   `npm/src/directory-sync/batch-events/queue.ts`,
   `npm/test/dsync/batch/webhooks.test.ts`.
6. **Align setup-link tests with current validation.** The upstream test
   fixtures supply the webhook fields now required for Directory Sync links
   and verify the serialized SSO redirect list in its stored representation.
   File: `npm/test/setup-link.test.ts`.
7. **Use the externally configured OpenTelemetry SDK for Jackson metrics.**
   Remove the application-owned metrics bootstrap. Jackson's existing
   instruments use the global API provider supplied by a preloaded SDK,
   preserving its resource attributes and avoiding a second exporter/provider.
   Deployments must preload a Node SDK and enable its metrics exporter;
   without one, instruments are no-ops. Files: `lib/jackson.ts`, `.env.example`,
   `npm/test/api/metrics_sdk.test.ts`.
8. **Record structured SSO lifecycle, identity, errors, and continuity.**
   Request-local telemetry emits stage/completion events and semantic spans,
   preserves error causes, and connects authorize/callback/code/token/userinfo
   with native-value fingerprints and server-owned Span Links. Optional
   telemetry context stays inside encrypted records, not token claims or
   public responses. Existing auth decisions, routing priority, and response
   formats are unchanged. The npm library accepts a typed event sink; the
   application binds it to Pino. See `TELEMETRY.md` for the field and byte
   contract. Files: `npm/src/opentelemetry/{telemetry,errors}.ts`, OAuth/profile
   handlers, `lib/sso-telemetry.ts`, and `npm/test/sso/telemetry.test.ts`.

Invariants the series must keep, and the tests that hold them:

- A public downstream client must use PKCE, and only a redirect listed in
  `publicRedirectUrls` is public. Confidential redirects still require the
  client secret. The stored federation session determines that requirement;
  omitting or changing the presented client ID cannot bypass it.
  `npm/test/sso/federation_client_auth.test.ts`, `npm/test/sso/public_client.test.ts`
- A sessionless code cannot be redeemed without confidential client
  authentication, including when a caller supplies a `code_verifier`.
  `npm/test/sso/saml_idp_oauth.test.ts`
- A public upstream redirect is used only when both the downstream client is
  public and the connection has `oidcPublicUpstreamRedirectUri`.
  `npm/test/sso/public_client.test.ts`
- Strict routing needs exactly one active connection for the hinted domain,
  even when only one connection exists in total. An explicit in-scope
  `idp_hint` remains authoritative with a conflicting or absent `login_hint`.
  `npm/test/sso/domain_routing.test.ts`, `npm/test/controller/domain-utils.test.ts`
- The public Mobile callback accepts only GET, delegates the callback payload,
  and returns the native-app redirect. `npm/test/api/mobile_oidc_callback.test.ts`
- `login_hint` works for both SAML HTTP-Redirect and HTTP-POST; the Redirect
  binding's signed query remains intact, and the POST form action does not
  double-encode the address.
  `npm/test/sso/saml_login_hint.test.ts`
- Directory Sync batch processing is complete before `process()` returns, so
  its worker guard and distributed lock cover the actual deliveries.
  `npm/test/dsync/batch/webhooks.test.ts`
- Current setup-link validation and stored redirect semantics remain covered.
  `npm/test/setup-link.test.ts`
- Initializing Jackson must not register another metrics provider. Its real
  counters export through the existing SDK with that SDK's service and
  Kubernetes resource identity intact. `npm/test/api/metrics_sdk.test.ts`
- The upstream `idp_hint` scope check and the provider-error early return in
  the OIDC callback are upstream behavior and must survive every rebase.
- Telemetry is isolated per request, retains legacy-record compatibility,
  never copies request IDs across redirects, and never changes authentication
  results when an event sink fails. Native fingerprints cover full wire codes
  and tokens. A failed SSO callback can have an error-marked semantic span
  while its unchanged HTTP response is 302. `npm/test/sso/telemetry.test.ts`
- Per-call HTTP facts do not leak into later failures; process-lifetime
  initialization detaches both contexts; mapped profiles are marked validated
  only after their checks complete. Federation and SAML fixture flows verify
  the real controller's metadata continuity. File logging retains the same
  context and error behavior. `npm/test/sso/telemetry.test.ts`,
  `npm/test/sso/public_client.test.ts`, `npm/test/sso/saml_idp_oauth.test.ts`,
  `npm/test/api/file_logger.test.ts`

Upstream status: none of the patches is upstream. Patches 1, 4, 5, and 6 are
generic enough to propose after this release is accepted.

## Rebasing onto a newer upstream

```sh
git fetch upstream --tags
git push origin upstream/main:main                 # refresh the mirror
git checkout -b release/$(date -u +%Y.%m.%d) <previous release branch>
git rebase --onto upstream/main <previous base commit>
```

Resolve conflicts patch by patch, keeping each commit self-contained. Then
prove the series survived:

```sh
git range-diff <old base>..<old release branch> upstream/main..HEAD
npm run check-types
npx tsc -p npm/tsconfig.build.json --noEmit
npm run check-lint
npm run check-format
npm run check-locale
(
  cd npm
  test_files=$(find test -type f -name '*.test.ts' ! -path 'test/db/*' | sort)
  npx cross-env POLIS_NO_ANALYTICS=1 tap --timeout=1800 \
    --allow-incomplete-coverage --allow-empty-coverage --bail $test_files
)
```

The omitted `test/db/db.test.ts` exercises external database engines and
requires upstream's Postgres, Redis, MongoDB, CockroachDB, and other service
matrix. A bare `npm test` enters that file and stalls without those services.
The recursive `find` intentionally includes every other test, including nested
Directory Sync tests and `test/setup-link.test.ts`.

Check the library's own TypeScript configuration as well as the application's.
The root Next.js configuration accepts newer builtins than the standalone
library configuration; passing the application build alone does not prove the
library still compiles.

Review the semantic seams every time, not only the textual conflicts:
`resolveConnection` in `sso-handler.ts`, the `allowed.redirect` calls and the
public-client branches in `oauth.ts` (`authorize`, `oidcAuthzResponse`,
`token`), the federation app model, and the SAML redirect block.
Also review the Directory Sync batch worker's lock lifetime and the setup-link
validation contract.

Update the base commit above, tag the build (`git tag -s vYYYY.MM.DD`), and
push the branch and the tag.

## Upstream changelog gaps

Ory's hosted-product [v26.3.7 changelog](https://changelog.ory.com/announcements/ory-network-ory-hydra-ory-kratos-ory-keto-ory-polis-ory-elements-v26-3-7-released)
describes fixes that had not reached the pinned public source at the time of
this rebase:

- sessionless authorization-code client authentication is backported in patch
  2 and covered by the regression above;
- the SCIM empty-secret authentication correction must be reviewed and
  backported before exposing or enabling SCIM;
- IdP-initiated SAML replay protection is not backported; deployments must keep
  IdP-initiated login disabled until that gap is closed;
- later public-source synchronizations and Ory changelog entries must be
  reviewed on every rebase for additional disclosed or undisclosed gaps.

## Building

The image is upstream's `Dockerfile`, unmodified. Build hosts may append
stages to run the checks above inside the build; the fork itself carries no
build-host specifics.
