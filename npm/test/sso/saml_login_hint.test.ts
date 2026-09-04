import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import tap from 'tap';
import type { IConnectionAPIController, IOAuthController, OAuthReq } from '../../src/typings';
import { addSSOConnections, jacksonOptions } from '../utils';
import { authz_request_normal } from './fixture';

// A login_hint on a SAML authorization request is forwarded to the IdP as a
// query parameter of the HTTP-Redirect URL without touching the signed part of
// the query (SAMLRequest, RelayState, SigAlg).

let oauthController: IOAuthController;
let connectionAPIController: IConnectionAPIController;

const metadataPath = path.join(__dirname, '/data/metadata');
const loginHint = 'jackson@example.com';
const postTenant = 'post-only.example';
const postLoginHint = `jackson@${postTenant}`;

tap.before(async () => {
  const jackson = await (await import('../../src/index')).default(jacksonOptions);

  oauthController = jackson.oauthController;
  connectionAPIController = jackson.connectionAPIController;
  await addSSOConnections(metadataPath, connectionAPIController);

  const redirectBinding =
    '    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://accounts.google.com/o/saml2"/>\n';
  const postOnlyMetadata = (await fs.readFile(path.join(metadataPath, 'boxyhq.xml'), 'utf8'))
    .replace('entityID="https://accounts.google.com/o/saml2"', 'entityID="https://post-only.example/saml"')
    .replace(redirectBinding, '');
  await connectionAPIController.createSAMLConnection({
    tenant: postTenant,
    product: 'crm',
    name: 'HTTP-POST login_hint test',
    defaultRedirectUrl: 'http://localhost:3366/sso/oauth/completed',
    redirectUrl: '["http://localhost:3366"]',
    rawMetadata: postOnlyMetadata,
  });
});

tap.teardown(async () => {
  process.exit(0);
});

const authorize = async (loginHint?: string) => {
  const { redirect_url } = (await oauthController.authorize(<OAuthReq>{
    ...authz_request_normal,
    ...(loginHint ? { login_hint: loginHint } : {}),
  })) as { redirect_url: string };
  return new URL(redirect_url).searchParams;
};

tap.test('SAML HTTP-Redirect with a login_hint', async (t) => {
  const params = await authorize(loginHint);

  t.equal(params.get('login_hint'), loginHint, 'login_hint is forwarded');
  for (const name of ['SAMLRequest', 'RelayState', 'SigAlg', 'Signature']) {
    t.ok(params.has(name), `${name} present`);
  }

  const queryToVerify = `SAMLRequest=${encodeURIComponent(params.get('SAMLRequest')!)}&RelayState=${encodeURIComponent(
    params.get('RelayState')!
  )}&SigAlg=${encodeURIComponent(params.get('SigAlg')!)}`;
  const { getDefaultCertificate } = await import('../../src/saml/x509');
  const { publicKey } = await getDefaultCertificate();
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(queryToVerify);
  t.ok(
    verifier.verify(publicKey, params.get('Signature')!, 'base64'),
    'the signature still verifies over SAMLRequest, RelayState, and SigAlg alone'
  );
});

tap.test('SAML HTTP-Redirect without a login_hint', async (t) => {
  const params = await authorize();

  t.notOk(params.has('login_hint'), 'no login_hint parameter is added');
  t.ok(params.has('Signature'), 'Signature present');
});

tap.test('SAML HTTP-POST with a login_hint', async (t) => {
  const { authorize_form } = await oauthController.authorize(<OAuthReq>{
    ...authz_request_normal,
    client_id: `tenant=${postTenant}&product=crm`,
    login_hint: postLoginHint,
  });

  t.type(authorize_form, 'string', 'an HTTP-POST form is returned');
  const action = authorize_form?.match(/<form[^>]+action="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  t.type(action, 'string', 'the form has an action URL');
  t.equal(new URL(action!).searchParams.get('login_hint'), postLoginHint, 'login_hint is forwarded');
  t.match(authorize_form, /name="SAMLRequest"/, 'the signed SAML request is posted in the form');
  t.match(authorize_form, /name="RelayState"/, 'RelayState is posted in the form');
});
