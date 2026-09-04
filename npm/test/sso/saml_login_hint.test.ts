import crypto from 'crypto';
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

tap.before(async () => {
  const jackson = await (await import('../../src/index')).default(jacksonOptions);

  oauthController = jackson.oauthController;
  connectionAPIController = jackson.connectionAPIController;
  await addSSOConnections(metadataPath, connectionAPIController);
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
