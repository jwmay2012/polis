import tap from 'tap';
import sinon from 'sinon';
import DB from '../../src/db/db';
import { RoutingController, normalizeLoginMatch } from '../../src/controller/routing';
import { ConnectionAPIController } from '../../src/controller/api';
import { App } from '../../src/ee/identity-federation/app';
import { IndexNames } from '../../src/controller/utils';
import { keyFromParts } from '../../src/db/utils';
import type { JacksonOptionWithRequiredLogger } from '../../src/typings';

const opts = {
  externalUrl: 'https://example.test',
  samlPath: '/saml',
  db: { engine: 'mem', pageLimit: 2 },
  logger: { info() {}, warn() {}, error() {} },
} as JacksonOptionWithRequiredLogger;

async function fixture(t) {
  const db = await DB.new({ db: opts.db, logger: opts.logger }, true);
  t.teardown(() => db.close());
  const store = db.store('sso:routing');
  const connections = db.store('saml:config');
  const apps = db.store('samlfed:apps');
  const router = new RoutingController(store, connections, apps, opts);
  await apps.put('app', {
    id: 'app',
    type: 'oidc',
    tenant: 'platform',
    product: 'product',
    tenants: ['example.test', 'replacement'],
  });
  for (const [clientID, tenant] of [
    ['old', 'example.test'],
    ['new', 'replacement'],
    ['outside', 'not-in-app'],
  ]) {
    await connections.put(
      clientID,
      { clientID, tenant, product: 'product', name: clientID },
      { name: IndexNames.TenantProduct, value: keyFromParts(tenant, 'product') }
    );
  }
  return { router, store, connections, apps };
}

tap.test('deleting an application clears its routing mode only after the deletion succeeds', async (t) => {
  const { router, apps } = await fixture(t);
  const controller = new App({
    store: apps,
    opts: { ...opts, polisLicenseKey: 'dummy-license' },
    routingController: router,
  });
  const params = {
    type: 'oidc',
    name: 'Recreated application',
    tenant: 'recreated',
    product: 'product',
    redirectUrl: ['https://example.test/callback'],
  } as Parameters<App['create']>[0];
  for (const byId of [true, false]) {
    const app = await controller.create(params);
    const mode = await router.setManaged(app.id, true, null);
    const target = byId ? { id: app.id } : { tenant: app.tenant, product: app.product, type: app.type };
    const failure = sinon.stub(apps, 'delete').rejects(new Error('fixture deletion failed'));
    await t.rejects(controller.delete(target), { message: 'fixture deletion failed' });
    t.same(await router.managed(app.id), mode, 'failed deletion preserves the routing mode');
    failure.restore();
    await controller.delete(target);
    t.equal(await router.managed(app.id), null, 'successful deletion removes the routing mode');
    const recreated = await controller.create(params);
    t.equal(recreated.id, app.id, 'recreation reuses the application ID');
    t.same(await router.lookup(recreated.id, 'person@example.test'), { status: 'legacy' });
    await controller.delete({ id: recreated.id });
  }
});

tap.test('legacy primary-tenant scope and known policy survive secondary lookup failure', async (t) => {
  const { router, apps, connections } = await fixture(t);
  await apps.put('app', { id: 'app', type: 'oidc', product: 'product', tenant: 'example.test' });
  await router.publish({
    app: 'app',
    match: 'example.test',
    connectionID: 'old',
    expectedRevision: null,
    importLegacy: true,
  });
  t.match(await router.lookup('app', 'person@example.test'), {
    status: 'route',
    connection: { clientID: 'old' },
  });
  const stub = sinon.stub(connections, 'get').rejects(new Error('fixture database unavailable'));
  t.teardown(() => stub.restore());
  t.match(
    await router.lookup('app', 'person@example.test'),
    { status: 'unavailable', reason: 'unavailable' },
    'a known SSO requirement is not lost when its target read fails'
  );
});

tap.test('tenant deletion checks later pages before deleting any connections', async (t) => {
  const { router, connections, apps } = await fixture(t);
  const tenant = 'many.example.test';
  await apps.put('app', { ...(await apps.get('app')), tenants: [tenant] });
  for (let index = 0; index < 5; index++)
    await connections.put(
      `bulk-${index}`,
      { clientID: `bulk-${index}`, tenant, product: 'product' },
      { name: IndexNames.TenantProduct, value: keyFromParts(tenant, 'product') }
    );
  await router.setManaged('app', true, null);
  await router.publish({ app: 'app', match: tenant, connectionID: 'bulk-0', expectedRevision: null });
  const api = new ConnectionAPIController({
    connectionStore: connections,
    opts,
    eventController: { notify: async () => {} },
    routingController: router,
  });
  await t.rejects(api.deleteConnections({ tenant, product: 'product' }), {
    message: /published SSO routes/,
    statusCode: 409,
  });
  for (let index = 0; index < 5; index++) t.ok(await connections.get(`bulk-${index}`), 'no partial deletion');
});

tap.test(
  'normalization accepts literal email/domain matches, not patterns or malformed domains',
  async (t) => {
    t.equal(normalizeLoginMatch(' Pilot@Example.TEST '), 'pilot@example.test');
    t.equal(normalizeLoginMatch(' Example.TEST '), 'example.test');
    for (const invalid of [
      '@example.test',
      '*.example.test',
      'a@b@example.test',
      'example. test',
      '-example.test',
      'example-.test',
      'example.test/path',
      'example.test:443',
      '',
      'localhost',
      'a'.repeat(255),
    ])
      t.throws(() => normalizeLoginMatch(invalid), { message: /./, statusCode: 400 });
  }
);

tap.test('drafts and imports do not activate policy implicitly', async (t) => {
  const { router, connections, store } = await fixture(t);
  t.same(await router.lookup('app', 'person@example.test'), { status: 'legacy' });
  await router.saveDraft('new', [' PILOT@example.test ', 'pilot@example.test']);
  t.same(await router.draft('new'), { matches: ['pilot@example.test'] });
  await connections.put('new', { clientID: 'new', tenant: 'replacement', product: 'product' });
  t.same(
    await router.draft('new'),
    { matches: ['pilot@example.test'] },
    'same-ID recreation cannot erase the draft'
  );
  t.same(await router.lookup('app', 'person@example.test'), { status: 'legacy' });
  await t.rejects(
    router.publish({ app: 'app', match: 'example.test', connectionID: 'new', expectedRevision: null }),
    { message: /./, statusCode: 409 }
  );
  await t.rejects(
    router.publish({
      app: 'app',
      match: 'example.test',
      connectionID: 'new',
      expectedRevision: null,
      importLegacy: true,
    }),
    { message: /./, statusCode: 409 }
  );
  const imported = await router.publish({
    app: 'app',
    match: 'example.test',
    connectionID: 'old',
    expectedRevision: null,
    importLegacy: true,
  });
  t.match(await router.lookup('app', 'person@example.test'), {
    status: 'route',
    connection: { clientID: 'old' },
  });
  await t.rejects(
    router.publish({
      app: 'app',
      match: 'example.test',
      connectionID: 'old',
      expectedRevision: null,
      importLegacy: true,
    }),
    { message: /./, statusCode: 409 },
    'resume must reconcile an existing import, not overwrite it'
  );
  const managed = (await router.setManaged('app', true, null))!;
  t.same(await router.lookup('app', 'person@unknown.test'), { status: 'none' });
  await t.rejects(router.setManaged('app', false, 'stale'), { message: /./, statusCode: 409 });
  await router.setManaged('app', false, managed.revision);
  await router.withdraw('app', imported.match, imported.revision);
  t.same(
    await router.lookup('app', 'person@example.test'),
    { status: 'legacy' },
    'ordered rollback restores the original path'
  );
  t.equal(await store.get('route:app:example.test'), null);
});

tap.test(
  'email pilots win, transfers have one owner, and stale indexes/confirmations cannot revive it',
  async (t) => {
    const { router } = await fixture(t);
    await router.setManaged('app', true, null);
    const domain = await router.publish({
      app: 'app',
      match: 'example.test',
      connectionID: 'old',
      expectedRevision: null,
    });
    const pilot = await router.publish({
      app: 'app',
      match: 'pilot@example.test',
      connectionID: 'new',
      expectedRevision: null,
    });
    t.match(await router.lookup('app', 'PILOT@example.test'), {
      status: 'route',
      connection: { clientID: 'new' },
    });
    t.match(await router.lookup('app', 'other@example.test'), {
      status: 'route',
      connection: { clientID: 'old' },
    });
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] });
    t.teardown(() => clock.restore());
    const moved = await router.publish({
      app: 'app',
      match: domain.match,
      connectionID: 'new',
      expectedRevision: domain.revision,
    });
    const back = await router.publish({
      app: 'app',
      match: domain.match,
      connectionID: 'old',
      expectedRevision: moved.revision,
    });
    t.equal(moved.publishedAt, back.publishedAt, 'same-clock updates');
    t.not(moved.revision, back.revision);
    await t.rejects(
      router.withdraw('app', domain.match, domain.revision),
      { message: /./, statusCode: 409 },
      'ABA does not authorize an old withdrawal'
    );
    const results = await Promise.allSettled(
      ['new', 'old'].map((connectionID) =>
        router.publish({ app: 'app', match: domain.match, connectionID, expectedRevision: back.revision })
      )
    );
    t.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('No publication succeeded');
    t.same(
      (await router.list({ connectionID: 'old' })).map((route) => route.match),
      winner.value.connectionID === 'old' ? [domain.match] : [],
      'filters previous owner indexes'
    );
    await router.withdraw('app', pilot.match, pilot.revision);
    t.match(
      await router.lookup('app', 'pilot@example.test'),
      { status: 'route', connection: { clientID: winner.value.connectionID } },
      'withdrawn pilot reveals the domain rule'
    );
  }
);

tap.test('known requirements stay required when their targets are unavailable', async (t) => {
  const { router, connections, apps } = await fixture(t);
  await router.setManaged('app', true, null);
  await router.publish({ app: 'app', match: 'example.test', connectionID: 'old', expectedRevision: null });
  await router.publish({
    app: 'app',
    match: 'pilot@example.test',
    connectionID: 'new',
    expectedRevision: null,
  });
  await connections.put('new', {
    clientID: 'new',
    tenant: 'replacement',
    product: 'product',
    deactivated: true,
  });
  t.match(
    await router.lookup('app', 'pilot@example.test'),
    { status: 'unavailable', reason: 'deactivated' },
    'does not fall back to the active domain owner'
  );
  await connections.delete('new');
  t.match(await router.lookup('app', 'pilot@example.test'), { status: 'unavailable', reason: 'missing' });
  await apps.put('app', { type: 'oidc', product: 'product', tenants: [] });
  t.match(await router.lookup('app', 'other@example.test'), {
    status: 'unavailable',
    reason: 'out_of_scope',
  });
  await apps.delete('app');
  t.match(await router.lookup('app', 'other@example.test'), { status: 'unavailable', reason: 'app_missing' });
});

tap.test(
  'inventory passes the configured page cap and delete guards never trust partial scans',
  async (t) => {
    const { router, store } = await fixture(t);
    await router.setManaged('app', true, null);
    for (let index = 0; index < 7; index++)
      await router.publish({
        app: 'app',
        match: `domain-${index}.test`,
        connectionID: 'old',
        expectedRevision: null,
      });
    t.equal((await router.list({ connectionID: 'old' })).length, 7, 'paginates a configured two-row limit');
    await t.rejects(router.assertUnused({ connectionID: 'old' }), { message: /./, statusCode: 409 });
    await t.rejects(router.assertUnused({ app: 'app' }), { message: /./, statusCode: 409 });
    t.same(await router.list({ connectionID: 'new' }), []);
    const stub = sinon
      .stub(store, 'getByIndex')
      .resolves({ data: [{ app: 'other', match: 'stale.test', connectionID: 'other' }] });
    t.teardown(() => stub.restore());
    await t.rejects(
      router.assertUnused({ connectionID: 'new' }),
      { message: /./, statusCode: 503 },
      'incomplete stale-only scan is not an empty inventory'
    );
  }
);
