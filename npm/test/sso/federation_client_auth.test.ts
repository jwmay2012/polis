import crypto from 'crypto';
import tap from 'tap';
import { OAuthController } from '../../src/controller/oauth';
import { jacksonOptions } from '../utils';

// Deliberately independent of the later public-upstream-callback patch.
// Real code encryption/redemption, but no external IdP, DB, or signing keys.
const makeStore = () => {
  const rows = new Map<string, any>();
  return {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: any) => rows.set(key, value),
    delete: async (key: string) => rows.delete(key),
  };
};
const clientID = 'fed_oidc_fixture';
const clientSecret = 'fixture-client-secret';
const webRedirect = 'https://app.example/callback';
const publicRedirect = 'com.example.app://callback/';

async function redeemFixture(
  redirect: string,
  credentials: Record<string, string | undefined>,
  federated = true
) {
  const controller = new OAuthController({
    opts: {
      ...jacksonOptions,
      db: { engine: 'mem', ttl: 300 },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    connectionStore: makeStore(),
    sessionStore: makeStore(),
    codeStore: makeStore(),
    tokenStore: makeStore(),
    ssoTraces: { saveTrace: async () => undefined },
    idFedApp: {},
  });
  const verifier = 'fixture-verifier';
  const code = await (controller as any)._buildAuthorizationCode(
    { clientID: 'connection', clientSecret: 'fixture-connection-secret' },
    { claims: { id: 'fixture-subject', email: 'fixture@example.com' } },
    {
      requested: { client_id: federated ? clientID : 'connection', redirect_uri: redirect, protocol: 'saml' },
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(federated
        ? { oidcFederated: { clientID, clientSecret, publicRedirectUrls: [publicRedirect] } }
        : {}),
    },
    false
  );
  try {
    const result = await controller.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      ...credentials,
    } as any);
    return { issued: !!result.access_token };
  } catch (err) {
    const error = err as { statusCode: number; message: string };
    return { issued: false, statusCode: error.statusCode, message: error.message };
  }
}

tap.test('stored federation identity cannot be bypassed by the presented client ID', async (t) => {
  for (const redirect of [webRedirect, publicRedirect]) {
    for (const credentials of [{}, { client_id: 'non-federation-id' }, { client_id: 'fed_oidc_other' }]) {
      t.match(
        await redeemFixture(redirect, credentials),
        {
          issued: false,
          statusCode: 401,
          message: 'Invalid client_id',
        },
        `${redirect}: reject ${credentials.client_id || 'missing client ID'} despite valid PKCE`
      );
    }
  }
});

tap.test('confidential and public federation requirements remain distinct', async (t) => {
  t.match(await redeemFixture(webRedirect, { client_id: clientID }), {
    issued: false,
    statusCode: 401,
    message: 'Confidential clients must provide client_secret',
  });
  t.match(await redeemFixture(webRedirect, { client_id: clientID, client_secret: 'wrong' }), {
    issued: false,
    statusCode: 401,
    message: 'Invalid client_secret',
  });
  t.same(await redeemFixture(webRedirect, { client_id: clientID, client_secret: clientSecret }), {
    issued: true,
  });
  t.same(await redeemFixture(publicRedirect, { client_id: clientID }), { issued: true });
});

tap.test('the existing generic PKCE path and fed-looking rejection stay intact', async (t) => {
  t.same(await redeemFixture(webRedirect, { client_id: 'connection' }, false), { issued: true });
  t.match(await redeemFixture(webRedirect, { client_id: 'fed_oidc_other' }, false), {
    issued: false,
    statusCode: 401,
    message: 'Invalid client_id',
  });
});
