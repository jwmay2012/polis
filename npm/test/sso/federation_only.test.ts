import tap from 'tap';
import fs from 'fs';
import path from 'path';
import jackson from '../../src';
import { jacksonOptions } from '../utils';

const unused = 'http://_boxyhq_redirect_not_in_use';
const callbacks = ['https://application.example.test/callback', 'com.example.app://oidc/'];

tap.test(
  'federation-only SAML/OIDC keep app returns while refusing direct and unsolicited logins',
  async (t) => {
    const noop = () => undefined;
    const c = await jackson({
      ...jacksonOptions,
      idpEnabled: true,
      logger: { info: noop, warn: noop, error: noop },
      acsUrl: 'https://polis.example.test/api/oauth/saml',
      oidcPath: '/api/oauth/oidc',
    });
    const oidc = await c.connectionAPIController.createOIDCConnection({
      tenant: 'oidc.example.test',
      product: 'federation-only',
      redirectUrl: [],
      defaultRedirectUrl: unused,
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
      tenant: 'saml.example.test',
      product: 'federation-only',
      redirectUrl: [],
      defaultRedirectUrl: unused,
      rawMetadata: fs.readFileSync(path.join(__dirname, 'data/metadata/example.xml'), 'utf8'),
    });
    const app = await c.identityFederationController.app.create({
      type: 'oidc',
      name: 'Fixture app',
      tenant: 'owner',
      product: 'federation-only',
      tenants: [oidc.tenant, saml.tenant],
      redirectUrl: callbacks,
      publicRedirectUrls: [callbacks[1]],
    } as any);
    for (const connection of [oidc, saml]) {
      const request = {
        client_id: app.clientID!,
        scope: 'openid',
        response_type: 'code' as const,
        code_challenge: 'fixture-challenge',
        code_challenge_method: 'S256' as const,
        state: 'fixture',
        login_hint: `user@${connection.tenant}`,
      };
      for (const redirect_uri of callbacks) {
        const result = await c.oauthController.authorize({ ...request, redirect_uri });
        t.ok(
          result.redirect_url || result.authorize_form,
          `${connection.tenant}: federation callback allowed`
        );
        await t.rejects(
          c.oauthController.authorize({ ...request, client_id: connection.clientID, redirect_uri }),
          /Redirect URL is not allowed/
        );
      }
      await t.rejects(
        c.oauthController.authorize({ ...request, redirect_uri: 'https://attacker.example.test' }),
        /Redirect URL is not allowed/
      );
      await t.rejects(
        c.oauthController.authorize({
          ...request,
          client_id: connection.clientID,
          redirect_uri: unused + '/other',
        }),
        /Redirect URL is not allowed/
      );
    }
    const link = await c.setupLinkController.create({
      service: 'sso',
      tenant: 'setup-customer',
      product: 'federation-only',
      redirectUrl: '[]',
      defaultRedirectUrl: unused,
    });
    t.equal(link.redirectUrl, '[]');
    t.equal(link.defaultRedirectUrl, unused);
    await t.rejects(
      c.oauthController.samlResponse({
        SAMLResponse: Buffer.from(
          `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${saml.idpMetadata.entityID}</saml:Issuer></samlp:Response>`
        ).toString('base64'),
        RelayState: '',
      }),
      /Direct application integration is disabled/,
      'empty direct allowlist also refuses IdP-initiated flow if the global flag is later enabled'
    );
    await c.connectionAPIController.updateOIDCConnection({
      clientID: oidc.clientID,
      clientSecret: oidc.clientSecret,
      tenant: oidc.tenant,
      product: oidc.product,
      redirectUrl: [callbacks[0]],
      defaultRedirectUrl: callbacks[0],
    });
    t.ok(
      (
        await c.oauthController.authorize({
          client_id: oidc.clientID,
          redirect_uri: callbacks[0],
          response_type: 'code',
          scope: 'openid',
          state: 'fixture',
          code_challenge: 'fixture-challenge',
          code_challenge_method: 'S256',
        })
      ).redirect_url,
      'explicit direct opt-in still works'
    );
    const [updated] = await c.connectionAPIController.getConnections({ clientID: oidc.clientID });
    t.equal(updated.clientSecret, oidc.clientSecret, 'mode changes do not rotate credentials');
  }
);
tap.teardown(() => process.exit(0));
