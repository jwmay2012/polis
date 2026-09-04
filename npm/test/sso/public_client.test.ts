import crypto from 'crypto';
import tap from 'tap';
import type { Configuration } from 'openid-client';
import * as utils from '../../src/controller/utils';
import { JacksonError } from '../../src/controller/error';
import type {
  IConnectionAPIController,
  IIdentityFederationController,
  IOAuthController,
  IdentityFederationApp,
  OAuthReq,
  OAuthTokenReq,
  Profile,
} from '../../src/typings';
import { jacksonOptions } from '../utils';

// One federation app with a confidential (web) redirect and a public (mobile)
// redirect, fronting an OIDC connection per tenant: one that is also
// registered upstream as a public client, and one that is confidential-only.
//
// Two independent decisions are under test:
//   downstream: a redirect listed in `publicRedirectUrls` redeems with PKCE
//               alone; any other allowed redirect needs the app's client secret;
//   upstream:   the connection's public redirect URI (and a secret-less code
//               exchange) is used only when the downstream client is public AND
//               the connection has `oidcPublicUpstreamRedirectUri`.

const product = 'public-client-test';
const publicTenant = 'public.example';
const confidentialTenant = 'confidential.example';
const webRedirect = 'https://web.example/sso/callback';
const mobileRedirect = 'com.example.app://oidc/';
const publicUpstreamRedirectUri = `${jacksonOptions.externalUrl}${jacksonOptions.oidcPath}/mobile`;
const confidentialUpstreamRedirectUri = `${jacksonOptions.externalUrl}${jacksonOptions.oidcPath}`;

const upstream = (host: string) => ({
  issuer: `https://${host}`,
  authorization_endpoint: `https://${host}/authorize`,
  token_endpoint: `https://${host}/token`,
  userinfo_endpoint: `https://${host}/userinfo`,
  jwks_uri: `https://${host}/jwks`,
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

let oauthController: IOAuthController;
let connectionAPIController: IConnectionAPIController;
let identityFederationController: IIdentityFederationController;
let app: IdentityFederationApp;

// Every upstream code exchange the mocked openid-client performed.
const exchanges: Array<{ clientSecret?: string; redirectUri: string }> = [];

tap.before(async () => {
  const client = await import('openid-client');
  const openIdClientMock = {
    ...client,
    authorizationCodeGrant: async (config: Configuration, currentUrl: URL) => {
      exchanges.push({
        clientSecret: config.clientMetadata().client_secret as string | undefined,
        redirectUri: currentUrl.origin + currentUrl.pathname,
      });
      return {
        access_token: 'ACCESS_TOKEN',
        id_token: 'ID_TOKEN',
        token_type: 'bearer',
        claims: () => ({
          sub: 'USER_IDENTIFIER',
          email: 'user@example.com',
          iss: config.serverMetadata().issuer,
          aud: config.clientMetadata().client_id,
          iat: 1,
          exp: 2,
        }),
      };
    },
  };
  const utilsMock = tap.createMock(utils, {
    ...utils,
    dynamicImport: async (packageName: string) =>
      packageName === 'openid-client' ? openIdClientMock : utils.dynamicImport(packageName),
    extractOIDCUserProfile: async (tokens: utils.AuthorizationCodeGrantResult) => {
      const claims = tokens.claims()!;
      const profile: { claims: Partial<Profile & { raw: Record<string, unknown> }> } = {
        claims: {
          id: claims.sub,
          email: claims.email as string,
          firstName: 'Test',
          lastName: 'User',
          raw: claims,
        },
      };
      return profile;
    },
  });
  const indexModule = tap.mockRequire('../../src/index', {
    '../../src/controller/utils': utilsMock,
  });
  const controller = await indexModule.default(jacksonOptions);

  oauthController = controller.oauthController;
  connectionAPIController = controller.connectionAPIController;
  identityFederationController = controller.identityFederationController;

  // The parameter type lists the SAML fields as required even for an OIDC app.
  app = await identityFederationController.app.create({
    type: 'oidc',
    name: 'Public client test app',
    tenant: publicTenant,
    product,
    tenants: [publicTenant, confidentialTenant],
    redirectUrl: [webRedirect, mobileRedirect],
    publicRedirectUrls: [mobileRedirect],
  } as Parameters<typeof identityFederationController.app.create>[0]);

  await connectionAPIController.createOIDCConnection({
    tenant: publicTenant,
    product,
    name: 'Upstream with a public client registration',
    defaultRedirectUrl: webRedirect,
    redirectUrl: JSON.stringify([webRedirect, mobileRedirect]),
    oidcMetadata: upstream('idp-public.example'),
    oidcClientId: 'upstream-public-client',
    oidcClientSecret: 'upstream-public-secret',
    oidcPublicUpstreamRedirectUri: publicUpstreamRedirectUri,
  });

  await connectionAPIController.createOIDCConnection({
    tenant: confidentialTenant,
    product,
    name: 'Upstream with a confidential registration only',
    defaultRedirectUrl: webRedirect,
    redirectUrl: JSON.stringify([webRedirect, mobileRedirect]),
    oidcMetadata: upstream('idp-confidential.example'),
    oidcClientId: 'upstream-confidential-client',
    oidcClientSecret: 'upstream-confidential-secret',
  });
});

tap.teardown(async () => {
  process.exit(0);
});

const authorize = async (tenant: string, redirectUri: string, codeChallenge?: string) => {
  const state = crypto.randomUUID();
  const { redirect_url } = (await oauthController.authorize(<OAuthReq>{
    client_id: app.clientID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    login_hint: `user@${tenant}`,
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
  })) as { redirect_url: string };
  const url = new URL(redirect_url);
  return { url, relayState: url.searchParams.get('state')!, state };
};

const callback = async (relayState: string) => {
  const { redirect_url } = await oauthController.oidcAuthzResponse({
    code: 'UPSTREAM_CODE',
    state: relayState,
  });
  const url = new URL(redirect_url!);
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state') };
};

const redeem = (body: Record<string, string | undefined>) =>
  oauthController.token(<OAuthTokenReq>{
    grant_type: 'authorization_code',
    client_id: app.clientID,
    ...body,
  });

// The error a call is rejected with, or undefined if it succeeded.
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const { statusCode, message } = err as JacksonError;
    return { statusCode, message };
  }
};

tap.test('Public downstream client, upstream registered as a public client', async (t) => {
  const { verifier, challenge } = pkce();
  const { url, relayState, state } = await authorize(publicTenant, mobileRedirect, challenge);

  t.equal(url.origin + url.pathname, 'https://idp-public.example/authorize', 'routed to the tenant IdP');
  t.equal(
    url.searchParams.get('redirect_uri'),
    publicUpstreamRedirectUri,
    'upstream authorization uses the public upstream redirect URI'
  );

  const { code, state: returnedState } = await callback(relayState);
  t.equal(returnedState, state, 'downstream state is echoed back');
  const exchange = exchanges.at(-1)!;
  t.equal(
    exchange.redirectUri,
    publicUpstreamRedirectUri,
    'upstream code exchange presents the same redirect URI'
  );
  t.equal(exchange.clientSecret, undefined, 'upstream code exchange sends no client secret');

  t.match(
    await rejection(redeem({ code, redirect_uri: mobileRedirect })),
    { statusCode: 401, message: /Invalid code_verifier/ },
    'no code_verifier'
  );
  t.match(
    await rejection(redeem({ code, redirect_uri: mobileRedirect, code_verifier: 'not-the-verifier' })),
    { statusCode: 401, message: /Invalid code_verifier/ },
    'wrong code_verifier'
  );
  t.match(
    await rejection(redeem({ code, redirect_uri: webRedirect, code_verifier: verifier })),
    { statusCode: 400, message: /redirect_uri mismatch/ },
    'redirect_uri must match the authorization request'
  );

  const tokens = await redeem({ code, redirect_uri: mobileRedirect, code_verifier: verifier });
  t.ok(tokens.access_token, 'PKCE alone redeems the code for a public redirect');
  t.match(
    await rejection(redeem({ code, redirect_uri: mobileRedirect, code_verifier: verifier })),
    { statusCode: 403, message: /Invalid code/ },
    'a code redeems once'
  );
});

tap.test('Confidential downstream client on the same app', async (t) => {
  const { verifier, challenge } = pkce();
  const { url, relayState } = await authorize(publicTenant, webRedirect, challenge);

  t.equal(
    url.searchParams.get('redirect_uri'),
    confidentialUpstreamRedirectUri,
    'a confidential downstream client never triggers the public upstream redirect'
  );

  const { code } = await callback(relayState);
  t.equal(
    exchanges.at(-1)!.clientSecret,
    'upstream-public-secret',
    'upstream code exchange keeps its secret'
  );

  t.match(
    await rejection(redeem({ code, redirect_uri: webRedirect, code_verifier: verifier })),
    { statusCode: 401, message: /Confidential clients must provide client_secret/ },
    'no client_secret'
  );
  t.match(
    await rejection(
      redeem({ code, redirect_uri: webRedirect, code_verifier: verifier, client_secret: 'wrong' })
    ),
    { statusCode: 401, message: /Invalid client_secret/ },
    'wrong client_secret'
  );

  const tokens = await redeem({
    code,
    redirect_uri: webRedirect,
    code_verifier: verifier,
    client_secret: app.clientSecret,
  });
  t.ok(tokens.access_token, 'the app client secret redeems the code');
});

tap.test('Public downstream client, upstream registered as confidential only', async (t) => {
  const { verifier, challenge } = pkce();
  const { url, relayState } = await authorize(confidentialTenant, mobileRedirect, challenge);

  t.equal(
    url.origin + url.pathname,
    'https://idp-confidential.example/authorize',
    'routed to the tenant IdP'
  );
  t.equal(
    url.searchParams.get('redirect_uri'),
    confidentialUpstreamRedirectUri,
    'without a public upstream redirect URI the ordinary callback is used'
  );

  const { code } = await callback(relayState);
  t.equal(
    exchanges.at(-1)!.clientSecret,
    'upstream-confidential-secret',
    'upstream code exchange keeps its secret'
  );

  const tokens = await redeem({ code, redirect_uri: mobileRedirect, code_verifier: verifier });
  t.ok(
    tokens.access_token,
    'downstream public-client redemption is independent of the upstream registration'
  );
});

tap.test('Public downstream client without PKCE', async (t) => {
  const { relayState } = await authorize(publicTenant, mobileRedirect);
  const { code } = await callback(relayState);

  t.match(
    await rejection(redeem({ code, redirect_uri: mobileRedirect })),
    { statusCode: 401, message: /Please specify client_secret or code_verifier/ },
    'PKCE is required for a public client'
  );
});

tap.test('Redirect outside the app allow list', async (t) => {
  t.match(
    await rejection(authorize(publicTenant, 'https://evil.example/callback')),
    { statusCode: 403, message: /Redirect URL is not allowed/ },
    'rejected at authorization'
  );
});
