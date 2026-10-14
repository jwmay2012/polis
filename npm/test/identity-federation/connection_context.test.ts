import tap from 'tap';
import { jacksonOptions } from '../utils';

tap.test('connection context is a strict, default-off OIDC application option', async (t) => {
  const jackson = await (await import('../../src')).default(jacksonOptions);
  const apps = jackson.identityFederationController.app;
  const base = {
    type: 'oidc',
    name: 'Example app',
    tenant: 'app-key',
    product: 'example-product',
    acsUrl: '',
    entityId: '',
    redirectUrl: ['https://app.example.test/callback'],
  };
  const app = await apps.create(base);
  t.notOk(app.includeConnectionContext);
  t.equal((await apps.update({ id: app.id, includeConnectionContext: true })).includeConnectionContext, true);
  t.equal((await apps.update({ id: app.id, name: 'Renamed app' })).includeConnectionContext, true);
  t.equal(
    (await apps.update({ id: app.id, includeConnectionContext: false })).includeConnectionContext,
    false
  );
  for (const value of [null, 'true', 'false', 1, {}, []]) {
    await t.rejects(apps.update({ id: app.id, includeConnectionContext: value } as any), {
      message: /must be a boolean on an OIDC app/,
      statusCode: 400,
    });
    await t.rejects(apps.create({ ...base, tenant: 'another-key', includeConnectionContext: value } as any), {
      message: /must be a boolean on an OIDC app/,
      statusCode: 400,
    });
  }
  const saml = await apps.create({
    ...base,
    type: 'saml',
    tenant: 'saml-key',
    entityId: 'https://sp.example.test/entity',
    acsUrl: 'https://sp.example.test/acs',
  });
  for (const value of [true, false]) {
    await t.rejects(apps.update({ id: saml.id, includeConnectionContext: value }), {
      message: /must be a boolean on an OIDC app/,
      statusCode: 400,
    });
    await t.rejects(
      apps.create({ ...base, type: 'saml', tenant: 'another-saml', includeConnectionContext: value }),
      { message: /must be a boolean on an OIDC app/, statusCode: 400 }
    );
  }
  const enabled = await apps.create({ ...base, tenant: 'enabled-key', includeConnectionContext: true });
  t.equal(enabled.includeConnectionContext, true);
});

tap.teardown(() => process.exit(0));
