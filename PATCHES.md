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
(2026-07-27), on branch `release/2026.09.04`.

## The series

Each patch is one commit. They apply in this order.

1. **Route SSO connections by the login_hint email domain, with a strict mode.**
   When `login_hint` is an email address, `resolveConnection` keeps only the
   active connections whose `tenant` equals that address's domain. With
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
   redirect must still present the app's `client_secret`. Files:
   `npm/src/ee/identity-federation/{app,types}.ts`,
   `npm/src/controller/oauth.ts`, `internal-ui/src/identity-federation/`.
3. **Support a per-connection public upstream redirect URI and a
   public-client OIDC callback for mobile.** An OIDC connection gains
   `oidcPublicUpstreamRedirectUri`. When the downstream client is public
   (patch 2) and the selected connection has that URI, the upstream
   authorization uses it as `redirect_uri` and the upstream code exchange
   uses PKCE without the connection's client secret, so an IdP can register
   Polis as a mobile/public application. `pages/api/oauth/oidc/mobile.ts`
   serves that callback; it is the same handler as `/api/oauth/oidc`. Files:
   `npm/src/controller/connection/oidc.ts`, `npm/src/controller/oauth.ts`,
   `components/connection/PublicClientSettings.tsx`.
4. **Forward login_hint to the IdP on SAML SSO redirects.** The hint is added
   to the HTTP-Redirect URL and to the HTTP-POST form action. It is not part
   of the signed query (`SAMLRequest`, `RelayState`, `SigAlg`). File:
   `npm/src/controller/oauth.ts`.

Invariants the series must keep, and the tests that hold them:

- A public downstream client must use PKCE, and only a redirect listed in
  `publicRedirectUrls` is public. Confidential redirects still require the
  client secret. `npm/test/sso/public_client.test.ts`
- A public upstream redirect is used only when both the downstream client is
  public and the connection has `oidcPublicUpstreamRedirectUri`.
  `npm/test/sso/public_client.test.ts`
- Strict routing needs exactly one active connection for the hinted domain.
  `npm/test/sso/domain_routing.test.ts`, `npm/test/controller/domain-utils.test.ts`
- `login_hint` on a SAML redirect leaves the signed query intact.
  `npm/test/sso/saml_login_hint.test.ts`
- The upstream `idp_hint` scope check and the provider-error early return in
  the OIDC callback are upstream behavior and must survive every rebase.

Upstream status: none of the patches is upstream. Patches 1 and 4 are generic
enough to propose.

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
npm ci && npm run check-types && npm run check-lint && npm test
```

Review the semantic seams every time, not only the textual conflicts:
`resolveConnection` in `sso-handler.ts`, the `allowed.redirect` calls and the
public-client branches in `oauth.ts` (`authorize`, `oidcAuthzResponse`,
`token`), the federation app model, and the SAML redirect block.

Update the base commit above, tag the build (`git tag -a vYYYY.MM.DD`), and
push the branch and the tag.

## Building

The image is upstream's `Dockerfile`, unmodified. Build hosts may append
stages to run the checks above inside the build; the fork itself carries no
build-host specifics.
