import crypto from 'crypto';
import tap from 'tap';
import { OAuthController } from '../../src/controller/oauth';
import { encrypt } from '../../src/db/encrypter';
import { jacksonOptions } from '../utils';

const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const redirect = 'https://app.example.test/callback';
const clientID = 'fed_oidc_fixture';
const clientSecret = 'local-app-fixture';
const verifier = 'local-pkce-fixture';
const hostile = { id: 'other-connection', tenant: 'other-tenant', product: 'other-product' };
const makeStore = () => {
  const rows = new Map<string, any>();
  return {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: any) => rows.set(key, value),
    delete: async (key: string) => rows.delete(key),
  };
};

function fixture(flattenRawClaims = false) {
  const tokenStore = makeStore();
  const controller = new OAuthController({
    opts: {
      ...jacksonOptions,
      db: { engine: 'mem', ttl: 300 },
      flattenRawClaims,
      openid: {
        jwsAlg: 'RS256',
        jwtSigningKeys: {
          private: Buffer.from(keys.privateKey).toString('base64'),
          public: Buffer.from(keys.publicKey).toString('base64'),
        },
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    connectionStore: makeStore(),
    sessionStore: makeStore(),
    codeStore: makeStore(),
    tokenStore,
    ssoTraces: { saveTrace: async () => undefined },
    idFedApp: {},
  });
  return { controller, tokenStore };
}

for (const flatten of [false, true]) {
  for (const protocol of ['oidc', 'saml'] as const) {
    for (const enabled of [undefined, false, true]) {
      tap.test(`${protocol}: connection context ${enabled} with flatten=${flatten}`, async (t) => {
        const { controller } = fixture(flatten);
        const connection = {
          clientID: 'selected-connection',
          clientSecret: 'local-upstream-fixture',
          tenant: 'customer-key',
          product: 'example-product',
          ...(protocol === 'saml' ? { idpMetadata: {} } : { oidcProvider: {} }),
        };
        const code = await (controller as any)._buildAuthorizationCode(
          connection,
          {
            claims: {
              id: 'subject',
              email: 'person@example.test',
              connection: hostile,
              raw: { connection: hostile, division: 'north' },
            },
          },
          {
            requested: {
              client_id: clientID,
              redirect_uri: redirect,
              protocol: 'oidc-federation',
              oidc: true,
            },
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            oidcFederated: { clientID, clientSecret, includeConnectionContext: enabled },
          },
          false
        );
        const token = await controller.token({
          code,
          client_id: clientID,
          client_secret: clientSecret,
          redirect_uri: redirect,
          code_verifier: verifier,
        } as any);
        const jose = await import('jose');
        const verified = await jose.jwtVerify(
          token.id_token!,
          await jose.importSPKI(keys.publicKey, 'RS256'),
          {
            issuer: jacksonOptions.externalUrl,
            audience: clientID,
          }
        );
        const userInfo = await controller.userInfo(token.access_token);
        if (enabled) {
          const expected = {
            id: connection.clientID,
            tenant: connection.tenant,
            product: connection.product,
            protocol,
          };
          t.same(verified.payload.connection, expected);
          t.same(
            userInfo.connection,
            expected,
            'stored federation marker reserves UserInfo consistently with token issuance'
          );
        } else {
          t.notOk(
            'connection' in verified.payload,
            'off and pre-upgrade codes cannot promote upstream context'
          );
          t.notOk('connection' in userInfo);
        }
        if (!flatten) {
          t.same(
            (verified.payload.raw as any).connection,
            hostile,
            'nested upstream attributes remain unchanged'
          );
          t.same(userInfo.raw.connection, hostile);
        }
        t.equal(userInfo.requested.client_id, clientID);
        t.equal(verified.payload.sub, 'subject', 'identity subject stays unchanged');
      });
    }
  }
}

tap.test('pre-upgrade UserInfo records reserve only the federation namespace', async (t) => {
  const { controller, tokenStore } = fixture();
  for (const protocol of ['oidc-federation', 'saml', 'oidc']) {
    const key = crypto.randomBytes(32);
    const id = crypto.randomBytes(20).toString('hex');
    const record = {
      claims: { id: 'subject', connection: hostile, raw: { connection: hostile } },
      requested: {},
      protocol,
    };
    await tokenStore.put(id, encrypt(JSON.stringify(record), key));
    const result = await controller.userInfo(`${key.toString('hex')}.${id}`);
    if (protocol === 'oidc-federation') t.notOk('connection' in result);
    else t.same(result.connection, hostile, 'direct integrations retain their existing attributes');
    t.same(result.raw.connection, hostile);
  }
});

tap.test('direct token claims do not acquire the federation reservation', async (t) => {
  const { controller } = fixture(true);
  const code = await (controller as any)._buildAuthorizationCode(
    { clientID: 'direct-client', clientSecret },
    { claims: { id: 'subject', email: 'person@example.test', raw: { connection: hostile } } },
    { requested: { client_id: 'direct-client', redirect_uri: redirect, protocol: 'oidc', oidc: true } },
    false
  );
  const token = await controller.token({
    grant_type: 'authorization_code',
    code,
    client_id: 'direct-client',
    client_secret: clientSecret,
    redirect_uri: redirect,
  });
  const jose = await import('jose');
  t.same(jose.decodeJwt(token.id_token!).connection, hostile);
  t.same((await controller.userInfo(token.access_token)).connection, hostile);
});
