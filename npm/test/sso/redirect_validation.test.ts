import fs from 'fs';
import path from 'path';
import tap from 'tap';
import jackson from '../../src';
import { relayStatePrefix } from '../../src/controller/utils';
import { jacksonOptions } from '../utils';

const appReturn = 'https://app.example.test/callback';
const directReturn = 'https://direct.example.test/callback';

tap.test('each OAuth client owns its exact redirect allowlist through both callback protocols', async (t) => {
  const noop = () => undefined;
  const c = await jackson({ ...jacksonOptions, logger: { info: noop, warn: noop, error: noop } });
  const common = {
    product: 'redirect-validation',
    redirectUrl: [directReturn],
    defaultRedirectUrl: directReturn,
  };
  const oidc = await c.connectionAPIController.createOIDCConnection({
    ...common,
    tenant: 'oidc.example.test',
    oidcClientId: 'fixture',
    oidcClientSecret: 'fixture-secret',
    oidcMetadata: {
      issuer: 'https://idp.example.test',
      authorization_endpoint: 'https://idp.example.test/authorize',
      token_endpoint: 'https://idp.example.test/token',
      userinfo_endpoint: 'https://idp.example.test/userinfo',
      jwks_uri: 'https://idp.example.test/jwks',
    },
  });
  const saml = await c.connectionAPIController.createSAMLConnection({
    ...common,
    tenant: 'saml.example.test',
    rawMetadata: fs.readFileSync(path.join(__dirname, 'data/metadata/example.xml'), 'utf8'),
  });
  const app = await c.identityFederationController.app.create({
    type: 'oidc',
    name: 'Redirect fixture',
    tenant: 'owner',
    product: common.product,
    tenants: [oidc.tenant, saml.tenant],
    redirectUrl: [appReturn],
  } as any);
  for (const connection of [oidc, saml]) {
    const request = {
      client_id: app.clientID!,
      redirect_uri: appReturn,
      state: 'fixture-state',
      login_hint: `user@${connection.tenant}`,
      response_type: 'code' as const,
      code_challenge: 'fixture-challenge',
      code_challenge_method: 'S256' as const,
    };
    for (const redirectExactMatch of [false, true]) {
      (c.oauthController as any).opts.openid.redirectExactMatch = redirectExactMatch;
      for (const redirect_uri of [directReturn, `${appReturn}/extra`, `${appReturn}?extra=1`]) {
        await t.rejects(
          c.oauthController.authorize({ ...request, redirect_uri }),
          {
            statusCode: 403,
            message: 'Redirect URL is not allowed.',
          },
          `${connection.tenant}: federation rejects ${redirect_uri} regardless of the retired option`
        );
      }
    }
    const direct = { ...request, client_id: connection.clientID, redirect_uri: directReturn };
    const directResult = await c.oauthController.authorize(direct);
    t.ok(directResult.redirect_url || directResult.authorize_form, 'direct registration still works');
    await t.rejects(c.oauthController.authorize({ ...direct, redirect_uri: `${directReturn}/extra` }), {
      statusCode: 403,
      message: 'Redirect URL is not allowed.',
    });
    await t.rejects(
      c.oauthController.authorize({ ...direct, redirect_uri: appReturn }),
      {
        statusCode: 403,
        message: 'Redirect URL is not allowed.',
      },
      'direct client cannot borrow the federation application registration'
    );

    for (const redirect_uri of [directReturn, `${appReturn}?extra=1`]) {
      const response = await c.oauthController.authorize(request);
      const state = response.redirect_url
        ? new URL(response.redirect_url).searchParams.get(connection === saml ? 'RelayState' : 'state')
        : response.authorize_form?.match(/name="RelayState" value="([^"]*)"/)?.[1];
      t.ok(state, 'valid application redirect starts authorization');
      // Model an in-flight session issued before strict matching, not a caller's writable state.
      const sessionStore = (c.oauthController as any).sessionStore;
      const sessionID = state!.replace(relayStatePrefix, '');
      const session = await sessionStore.get(sessionID);
      session.redirect_uri = redirect_uri;
      await sessionStore.put(sessionID, session);
      const callback =
        connection === saml
          ? c.oauthController.samlResponse({
              RelayState: state!,
              SAMLResponse: Buffer.from(
                `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${saml.idpMetadata.entityID}</saml:Issuer></samlp:Response>`
              ).toString('base64'),
            })
          : c.oauthController.oidcAuthzResponse({ state: state!, error: 'access_denied' });
      await t.rejects(
        callback,
        { statusCode: 403, message: 'Redirect URL is not allowed.' },
        `${connection.tenant}: callback refuses a legacy invalid return before profile validation or error redirect`
      );
    }
  }
});

tap.teardown(() => process.exit(0));
