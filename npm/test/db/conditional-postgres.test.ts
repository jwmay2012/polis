import { randomUUID } from 'crypto';
import tap from 'tap';
import { Client } from 'pg';
import DB from '../../src/db/db';
import { RoutingController } from '../../src/controller/routing';
import { IndexNames } from '../../src/controller/utils';
import { keyFromParts } from '../../src/db/utils';
import type { JacksonOptionWithRequiredLogger } from '../../src/typings';

const url = process.env.POLIS_ROUTING_TEST_POSTGRES;

tap.test(
  'PostgreSQL routing import, restart, transfer and conditional rollback',
  { skip: !url },
  async (t) => {
    if (new URL(url!).hostname !== '127.0.0.1') throw new Error('Use an isolated loopback fixture');
    const opts = {
      externalUrl: 'https://fixture.test',
      samlPath: '/saml',
      db: { engine: 'sql', type: 'postgres', url, pageLimit: 2 },
      logger: { info() {}, warn() {}, error() {} },
    } as JacksonOptionWithRequiredLogger;
    let db = await DB.new({ db: opts.db, logger: opts.logger }, true);
    const scope = `rehearsal-${randomUUID()}`;
    const stores = () => ({
      routes: db.store(`${scope}:routing`),
      connections: db.store(`${scope}:connections`),
      apps: db.store(`${scope}:apps`),
    });
    let { routes, connections, apps } = stores();
    let router = new RoutingController(routes, connections, apps, opts);
    try {
      await apps.put('app', {
        id: 'app',
        type: 'oidc',
        tenant: 'platform',
        product: 'product',
        tenants: ['old.test', 'replacement'],
      });
      const old = {
        clientID: 'old',
        tenant: 'old.test',
        product: 'product',
        subject: 'unchanged-fixture-subject',
      };
      await connections.put('old', old, {
        name: IndexNames.TenantProduct,
        value: keyFromParts(old.tenant, old.product),
      });
      await connections.put('new', { clientID: 'new', tenant: 'replacement', product: 'product' });
      t.same(await router.lookup('app', 'person@old.test'), { status: 'legacy' });
      const imported = await router.publish({
        app: 'app',
        match: 'old.test',
        connectionID: 'old',
        expectedRevision: null,
        importLegacy: true,
      });
      await db.close();
      db = await DB.new({ db: opts.db, logger: opts.logger }, true);
      ({ routes, connections, apps } = stores());
      router = new RoutingController(routes, connections, apps, opts);
      t.same(
        await router.list({ app: 'app' }),
        JSON.parse(JSON.stringify([imported])),
        'the serialized import journal survives restart'
      );
      await t.rejects(
        router.publish({
          app: 'app',
          match: 'old.test',
          connectionID: 'old',
          expectedRevision: null,
          importLegacy: true,
        }),
        { message: /changed/, statusCode: 409 },
        'retry does not overwrite an existing import'
      );
      const pilot = await router.publish({
        app: 'app',
        match: 'pilot@old.test',
        connectionID: 'old',
        expectedRevision: null,
        importLegacy: true,
      });
      const managed = (await router.setManaged('app', true, null))!;
      t.same(await router.lookup('app', 'person@missing.test'), { status: 'none' });
      const moved = await router.publish({
        app: 'app',
        match: imported.match,
        connectionID: 'new',
        expectedRevision: imported.revision,
      });
      t.match(await router.lookup('app', 'person@old.test'), {
        status: 'route',
        connection: { clientID: 'new' },
      });
      t.match(await router.lookup('app', 'pilot@old.test'), {
        status: 'route',
        connection: { clientID: 'old' },
      });
      await router.setManaged('app', false, managed.revision);
      await router.withdraw('app', pilot.match, pilot.revision);
      await t.rejects(
        router.withdraw('app', imported.match, imported.revision),
        { message: /changed/, statusCode: 409 },
        'old rollback manifest cannot erase a later transfer'
      );
      await router.withdraw('app', moved.match, moved.revision);
      t.same(await router.lookup('app', 'person@old.test'), { status: 'legacy' });
      t.same(await connections.get('old'), old, 'connection identity and subject were never rewritten');
      t.same(await router.list({ app: 'app' }), []);
    } finally {
      await db.close();
    }
  }
);
tap.test('conditional PostgreSQL writes on an isolated loopback fixture', { skip: !url }, async (t) => {
  if (new URL(url!).hostname !== '127.0.0.1')
    throw new Error('This destructive fixture must use loopback PostgreSQL');
  const sql = new Client({ connectionString: url });
  await sql.connect();
  t.teardown(() => sql.end());
  for (const encryptionKey of [undefined, '0123456789abcdef0123456789abcdef']) {
    const db = await DB.new(
      {
        db: { engine: 'sql', type: 'postgres', url, encryptionKey, cleanupLimit: 10 },
        logger: { info() {}, warn() {}, error() {} },
      },
      true
    );
    const store = db.store(`conditional-${randomUUID()}`, 60);
    const schemaBefore = (
      await sql.query(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2"
      )
    ).rows;
    try {
      const created = await Promise.all(
        [1, 2].map(() =>
          store.putIfMatch('route', { owner: 'a', revision: randomUUID() }, null, {
            name: 'owner',
            value: 'a',
          })
        )
      );
      t.same(created.sort(), [false, true], 'concurrent insert has one winner');
      const original = (await store.getVersioned('route'))!;
      t.equal(Boolean(original.version.iv), Boolean(encryptionKey));
      const outcomes = await Promise.all(
        ['b', 'c'].map((owner) =>
          store.putIfMatch('route', { owner, revision: randomUUID() }, original.version, {
            name: 'owner',
            value: owner,
          })
        )
      );
      t.same(outcomes.sort(), [false, true], 'PostgreSQL atomically rejects the stale update');
      const before = (await sql.query('SELECT * FROM jackson_ttl ORDER BY key')).rows;
      const indexes = (await sql.query('SELECT * FROM jackson_index ORDER BY id')).rows;
      t.equal(
        await store.putIfMatch('route', { owner: 'stale' }, original.version, {
          name: 'owner',
          value: 'stale',
        }),
        false
      );
      t.equal(await store.deleteIfMatch('route', original.version), false);
      t.same(
        (await sql.query('SELECT * FROM jackson_ttl ORDER BY key')).rows,
        before,
        'stale writes do not alter TTL'
      );
      t.same(
        (await sql.query('SELECT * FROM jackson_index ORDER BY id')).rows,
        indexes,
        'stale writes do not alter indexes'
      );
      const current = (await store.getVersioned('route'))!;
      t.equal(await store.putIfMatch('route', { owner: 'a', revision: randomUUID() }, current.version), true);
      t.equal(await store.deleteIfMatch('route', original.version), false, 'ABA rejected');
      const latest = (await store.getVersioned('route'))!;
      t.equal(await store.deleteIfMatch('route', latest.version), true);
      t.equal(await store.get('route'), null);
      t.equal((await store.getByIndex({ name: 'owner', value: 'a' })).data.length, 0, 'index rows cascade');
      t.same(
        (
          await sql.query(
            "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2"
          )
        ).rows,
        schemaBefore,
        'routing writes need no schema change'
      );
    } finally {
      await db.close();
    }
  }
});
