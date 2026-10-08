import crypto from 'crypto';
import tap from 'tap';
import DB from '../../src/db/db';
import { RoutingController } from '../../src/controller/routing';
import { OAuthController } from '../../src/controller/oauth';
import { extractOIDCUserProfile, type AuthorizationCodeGrantResult } from '../../src/controller/utils';
import {
  emailVerification,
  publicProfile,
  verifiedEnterpriseEmail,
} from '../../src/controller/email-verification';
import { withContext, contextFields } from '../../src/logging/context';
import { jacksonOptions } from '../utils';
import type { OAuthTokenReq } from '../../src/typings';

const email = 'person@example.test';

tap.test('verification stays paired with its email before raw claims are combined', async (t) => {
  t.same(emailVerification(email, [{ email }]), { email });
  for (const claim of [true, 'true', ['true']])
    t.same(emailVerification(email, [{ email: 'PERSON@EXAMPLE.TEST', email_verified: claim }]), {
      email,
      verified: true,
    });
  for (const claim of [false, 'false', ['false'], 'yes', 1, null, [], ['true', 'false']])
    t.same(emailVerification(email, [{ email, email_verified: claim }]), { email, verified: false });
  for (const sources of [
    [
      { email, email_verified: false },
      { email, email_verified: true },
    ],
    [
      { email, email_verified: true },
      { email, email_verified: false },
    ],
    [{ email }, { email: 'other@example.test', email_verified: true }],
    [{ email, email_verified: true }, { email: 'other@example.test' }],
    [{ email }, { email_verified: true }],
  ])
    t.same(emailVerification(email, sources), { email, verified: false });
  t.equal(emailVerification(undefined, []), null);
  t.equal(emailVerification('', []), null);
});

tap.test('OIDC extraction does not pair one source email with the other source verification', async (t) => {
  const client = await import('openid-client');
  const config = new client.Configuration(
    { issuer: 'https://idp.example.test', userinfo_endpoint: 'https://idp.example.test/userinfo' },
    'fixture'
  );
  for (const [idClaims, userClaims, expected] of [
    [{ email }, { email }, undefined],
    [{ email, email_verified: true }, { email }, true],
    [{ email, email_verified: false }, { email, email_verified: true }, false],
    [{ email, email_verified: true }, { email: 'different@example.test', email_verified: true }, false],
  ] as const) {
    config[client.customFetch] = async () =>
      new Response(JSON.stringify({ sub: 'subject', ...userClaims }), {
        headers: { 'content-type': 'application/json' },
      });
    const profile = await extractOIDCUserProfile(
      {
        access_token: 'fixture',
        token_type: 'bearer',
        expiresIn: () => 60,
        claims: () => ({
          sub: 'subject',
          iss: 'https://idp.example.test',
          aud: 'fixture',
          exp: 1,
          iat: 0,
          ...idClaims,
        }),
      } as unknown as AuthorizationCodeGrantResult,
      config
    );
    t.equal(profile.claims.email, email);
    t.equal(profile.emailVerification?.verified, expected);
  }
});

async function fixture(t) {
  const logger = { info() {}, warn() {}, error() {} };
  const db = await DB.new({ db: { engine: 'mem' }, logger }, true);
  t.teardown(() => db.close());
  const routes = db.store('sso:routing'),
    connections = db.store('saml:config'),
    apps = db.store('samlfed:apps');
  const opts: any = { ...jacksonOptions, logger, db: { engine: 'mem', ttl: 300 } };
  const routing = new RoutingController(routes, connections, apps, opts);
  await apps.put('app', { id: 'app', type: 'oidc', product: 'product', tenants: ['customer'] });
  for (const clientID of ['original', 'replacement'])
    await connections.put(clientID, {
      clientID,
      clientSecret: 'fixture-secret',
      tenant: 'customer',
      product: 'product',
    });
  await routing.setManaged('app', true, null);
  await routing.publish({
    app: 'app',
    match: 'example.test',
    connectionID: 'original',
    expectedRevision: null,
  });
  return { db, opts, routing, connections };
}

tap.test(
  'only the published, active, application-scoped connection can vouch for the returned email',
  async (t) => {
    const { routing, connections } = await fixture(t);
    const evidence = emailVerification(email, [{ email }]);
    t.equal(
      await verifiedEnterpriseEmail(evidence, 'original', 'app', routing),
      true,
      'SAML/Entra may omit the claim'
    );
    t.equal(await verifiedEnterpriseEmail({ email, verified: false }, 'original', 'app', routing), false);
    t.equal(await verifiedEnterpriseEmail({ email, verified: true }, 'replacement', 'app', routing), false);
    t.equal(
      await verifiedEnterpriseEmail(
        { email: 'person@outside.test', verified: true },
        'original',
        'app',
        routing
      ),
      false
    );
    t.equal(
      await verifiedEnterpriseEmail(undefined, 'original', 'app', routing),
      false,
      'legacy records gain no authority'
    );
    t.equal(await verifiedEnterpriseEmail(evidence, 'original', undefined, routing), false);
    await routing.saveDraft('original', ['draft.test']);
    t.equal(await verifiedEnterpriseEmail({ email: 'person@draft.test' }, 'original', 'app', routing), false);
    await withContext({ requested_email: 'typed@example.test', connection_id: 'original' }, {}, async () => {
      await verifiedEnterpriseEmail(evidence, 'original', 'app', routing);
      t.equal(
        contextFields().requested_email,
        'typed@example.test',
        'checking asserted email preserves request context'
      );
    });
    await routing.publish({ app: 'app', match: email, connectionID: 'replacement', expectedRevision: null });
    t.equal(
      await verifiedEnterpriseEmail(evidence, 'original', 'app', routing),
      false,
      'exact-email owner wins'
    );
    t.equal(await verifiedEnterpriseEmail(evidence, 'replacement', 'app', routing), true);
    await connections.put('replacement', {
      clientID: 'replacement',
      tenant: 'customer',
      product: 'product',
      deactivated: true,
    });
    t.equal(await verifiedEnterpriseEmail(evidence, 'replacement', 'app', routing), false);
  }
);

tap.test(
  'raw flattening and legacy profile fields cannot manufacture verification or replace the email',
  async (t) => {
    const claims = {
      id: 'subject',
      email,
      email_verified: true,
      raw: { email: 'forged@outside.test', email_verified: true },
    };
    for (const flatten of [false, true]) {
      t.match(publicProfile(claims, undefined, flatten), { email, email_verified: false });
      t.match(publicProfile(claims, false, flatten), { email, email_verified: false });
      t.match(publicProfile(claims, true, flatten), { email, email_verified: true });
    }
    t.equal(claims.raw.email, 'forged@outside.test', 'input is not mutated');
  }
);

tap.test(
  'confidential and public token exchanges expose identical protected verification in JWT and UserInfo',
  async (t) => {
    const jose = await import('jose');
    const keys = await jose.generateKeyPair('RS256', { extractable: true });
    const jwtSigningKeys = {
      private: Buffer.from(await jose.exportPKCS8(keys.privateKey)).toString('base64'),
      public: Buffer.from(await jose.exportSPKI(keys.publicKey)).toString('base64'),
    };
    const { db, opts, routing } = await fixture(t);
    for (const flatten of [false, true])
      for (const mobile of [false, true])
        for (const verified of [true, false, undefined]) {
          const controller = new OAuthController({
            connectionStore: db.store('saml:config'),
            sessionStore: db.store('sessions'),
            codeStore: db.store('codes'),
            tokenStore: db.store('tokens'),
            ssoTraces: { saveTrace: async () => undefined },
            idFedApp: {},
            routingController: routing,
            opts: { ...opts, flattenRawClaims: flatten, openid: { ...opts.openid, jwtSigningKeys } },
          });
          const redirect = mobile ? 'com.example://callback' : 'https://app.example.test/callback';
          const verifier = crypto.randomBytes(32).toString('base64url');
          const session = {
            requested: {
              oidc: true,
              protocol: 'saml',
              redirect_uri: redirect,
              client_id: 'fed_oidc_app',
              nonce: 'nonce',
            },
            code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 's256',
            oidcFederated: {
              id: 'app',
              clientID: 'fed_oidc_app',
              clientSecret: 'client-secret',
              publicRedirectUrls: ['com.example://callback'],
            },
          };
          const code = await (controller as any)._buildAuthorizationCode(
            { clientID: 'original', clientSecret: 'fixture-secret' },
            {
              claims: { id: 'subject', email, raw: { email: 'forged@outside.test', email_verified: true } },
              emailVerification: { email, verified },
            },
            session,
            false
          );
          const token = await controller.token({
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirect,
            client_id: 'fed_oidc_app',
            code_verifier: verifier,
            ...(mobile ? {} : { client_secret: 'client-secret' }),
          } as unknown as OAuthTokenReq); // Upstream's type predates federation's client_id plus PKCE.
          const { payload } = await jose.jwtVerify(token.id_token!, keys.publicKey, {
            issuer: opts.externalUrl,
            audience: 'fed_oidc_app',
          });
          const userinfo = await controller.userInfo(token.access_token);
          for (const body of [payload, userinfo]) {
            t.equal(body.email, email);
            t.equal(body.email_verified, verified !== false);
            t.notOk('emailVerification' in body, 'internal proof is not a public claim');
          }
        }
  }
);
