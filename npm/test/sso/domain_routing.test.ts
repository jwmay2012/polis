import crypto from 'crypto';
import tap from 'tap';
import { JacksonError } from '../../src/controller/error';
import type {
  IConnectionAPIController,
  IIdentityFederationController,
  IOAuthController,
  IdentityFederationApp,
  OAuthReq,
  OIDCSSORecord,
} from '../../src/typings';
import { jacksonOptions } from '../utils';

// Strict domain routing: absent an explicit IdP selection, an authorization
// request must carry an email login_hint, and its domain must select exactly
// one active connection. An idp_hint represents an explicit choice made on
// Polis's connection-selection page and therefore retains priority.

process.env.ENABLE_DOMAIN_ROUTING = 'true';
process.env.STRICT_DOMAIN_ROUTING = 'true';

const product = 'domain-routing-test';
const tenantA = 'a.example';
const tenantB = 'b.example';
const tenantC = 'c.example';
const singleTenant = 'single.example';
const singleProduct = 'single-domain-routing-test';
const webRedirect = 'https://web.example/sso/callback';

const upstream = (host: string) => ({
  issuer: `https://${host}`,
  authorization_endpoint: `https://${host}/authorize`,
  token_endpoint: `https://${host}/token`,
  userinfo_endpoint: `https://${host}/userinfo`,
  jwks_uri: `https://${host}/jwks`,
});

let oauthController: IOAuthController;
let connectionAPIController: IConnectionAPIController;
let identityFederationController: IIdentityFederationController;
let app: IdentityFederationApp;
let singleApp: IdentityFederationApp;
let connectionA: OIDCSSORecord;
let connectionB: OIDCSSORecord;
let inactive: OIDCSSORecord;

const createConnection = (tenant: string, host: string, connectionProduct = product) =>
  connectionAPIController.createOIDCConnection({
    tenant,
    product: connectionProduct,
    name: host,
    defaultRedirectUrl: webRedirect,
    redirectUrl: JSON.stringify([webRedirect]),
    oidcMetadata: upstream(host),
    oidcClientId: `${host}-client`,
    oidcClientSecret: `${host}-secret`,
  });

tap.before(async () => {
  const jackson = await (await import('../../src/index')).default(jacksonOptions);

  oauthController = jackson.oauthController;
  connectionAPIController = jackson.connectionAPIController;
  identityFederationController = jackson.identityFederationController;

  // The parameter type lists the SAML fields as required even for an OIDC app.
  app = await identityFederationController.app.create({
    type: 'oidc',
    name: 'Domain routing test app',
    tenant: tenantA,
    product,
    tenants: [tenantA, tenantB, tenantC],
    redirectUrl: [webRedirect],
  } as Parameters<typeof identityFederationController.app.create>[0]);

  connectionA = await createConnection(tenantA, 'idp-a.example');
  connectionB = await createConnection(tenantB, 'idp-b.example');
  inactive = await createConnection(tenantC, 'idp-c.example');
  await connectionAPIController.updateOIDCConnection({
    clientID: inactive.clientID,
    clientSecret: inactive.clientSecret,
    tenant: tenantC,
    product,
    deactivated: true,
  });

  singleApp = await identityFederationController.app.create({
    type: 'oidc',
    name: 'Single connection domain routing test app',
    tenant: singleTenant,
    product: singleProduct,
    tenants: [singleTenant],
    redirectUrl: [webRedirect],
  } as Parameters<typeof identityFederationController.app.create>[0]);
  await createConnection(singleTenant, 'idp-single.example', singleProduct);
});

tap.teardown(async () => {
  process.exit(0);
});

const authorizeRequest = ({
  selectedApp = app,
  loginHint,
  idpHint,
}: {
  selectedApp?: IdentityFederationApp;
  loginHint?: string;
  idpHint?: string;
} = {}) =>
  oauthController.authorize(<OAuthReq>{
    client_id: selectedApp.clientID,
    redirect_uri: webRedirect,
    response_type: 'code',
    state: crypto.randomUUID(),
    ...(loginHint === undefined ? {} : { login_hint: loginHint }),
    ...(idpHint === undefined ? {} : { idp_hint: idpHint }),
  }) as Promise<{ redirect_url: string }>;

const authorize = (loginHint?: string) => authorizeRequest({ loginHint });

// The IdP origin an authorization request is routed to.
const routedTo = async (loginHint: string) => new URL((await authorize(loginHint)).redirect_url).origin;

// The error an authorization request is rejected with, or undefined if it succeeded.
const rejection = async (loginHint?: string) => {
  try {
    await authorize(loginHint);
    return undefined;
  } catch (err) {
    const { statusCode, message } = err as JacksonError;
    return { statusCode, message };
  }
};

tap.test('Strict domain routing', async (t) => {
  t.test('routes by the login_hint domain', async (t) => {
    t.equal(await routedTo(`alice@${tenantA}`), 'https://idp-a.example');
    t.equal(await routedTo(`bob@${tenantB}`), 'https://idp-b.example');
    t.equal(
      await routedTo(`Carol@${tenantA.toUpperCase()}`),
      'https://idp-a.example',
      'domain match is case-insensitive'
    );
  });

  t.test('rejects a request without a login_hint', async (t) => {
    t.match(await rejection(undefined), {
      statusCode: 400,
      message: /Authentication requires email address/,
    });
  });

  t.test('still requires login_hint when the app has only one connection', async (t) => {
    try {
      await authorizeRequest({ selectedApp: singleApp });
      t.fail('authorization without login_hint unexpectedly succeeded');
    } catch (err) {
      const { statusCode, message } = err as JacksonError;
      t.equal(statusCode, 400);
      t.match(message, /Authentication requires email address/);
    }
  });

  t.test('preserves an explicit idp_hint over login_hint domain inference', async (t) => {
    const withConflictingLoginHint = await authorizeRequest({
      loginHint: `alice@${tenantA}`,
      idpHint: connectionB.clientID,
    });
    t.equal(
      new URL(withConflictingLoginHint.redirect_url).origin,
      'https://idp-b.example',
      'the explicitly selected connection wins'
    );

    const withoutLoginHint = await authorizeRequest({ idpHint: connectionA.clientID });
    t.equal(
      new URL(withoutLoginHint.redirect_url).origin,
      'https://idp-a.example',
      'an explicit connection selection does not require login_hint'
    );
  });

  t.test('rejects a login_hint that is not an email address', async (t) => {
    t.match(await rejection('not-an-address'), { statusCode: 400, message: /Invalid email format/ });
  });

  t.test('rejects a domain with no connection', async (t) => {
    t.match(await rejection('dave@nowhere.example'), {
      statusCode: 404,
      message: /No SSO configuration found/,
    });
  });

  t.test('ignores a deactivated connection', async (t) => {
    t.match(await rejection(`erin@${tenantC}`), { statusCode: 404, message: /No SSO configuration found/ });
  });

  t.test('rejects a domain with more than one active connection', async (t) => {
    await createConnection(tenantB, 'idp-b-second.example');
    t.match(await rejection(`frank@${tenantB}`), {
      statusCode: 400,
      message: /Multiple SSO configurations found/,
    });
  });
});
