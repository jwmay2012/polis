import { randomUUID } from 'crypto';
import tap from 'tap';
import DB from '../../src/db/db';
import mem from '../../src/db/mem';
import { RequiredLogger } from '../../src/typings';

const logger: RequiredLogger = { info() {}, warn() {}, error() {} };

for (const encryptionKey of [undefined, '0123456789abcdef0123456789abcdef']) {
  tap.test(`conditional store with ${encryptionKey ? 'encrypted' : 'plain'} records`, async (t) => {
    const driver = await mem.new({ db: { engine: 'mem' } });
    const db = await DB.new({ db: { driver, encryptionKey }, logger }, true);
    t.teardown(() => db.close());
    const store = db.store('routing-test', 60);
    const index = { name: 'connection', value: 'a' };
    const first = { owner: 'a', rev: randomUUID() };
    t.equal(await store.putIfMatch('route', first, null, index), true);
    t.same(index, { name: 'connection', value: 'a' }, 'does not mutate the supplied index');
    t.equal(await store.putIfMatch('route', { owner: 'b' }, null), false, 'does not replace on create');
    const original = (await store.getVersioned('route'))!;
    t.same(original.value, first);
    t.equal(
      Boolean(original.version.iv),
      Boolean(encryptionKey),
      'actually exercises the selected encryption mode'
    );
    const outcomes = await Promise.all(
      ['b', 'c'].map((owner) =>
        store.putIfMatch('route', { owner, rev: randomUUID() }, original.version, {
          name: 'connection',
          value: owner,
        })
      )
    );
    t.same(outcomes.sort(), [false, true], 'only one competing update wins');
    t.equal(
      await store.deleteIfMatch('route', original.version),
      false,
      'stale delete cannot erase the new owner'
    );
    const current = (await store.getVersioned('route'))!;
    const failedOwner = current.value.owner === 'b' ? 'c' : 'b';
    t.same(
      (await store.getByIndex({ name: 'connection', value: failedOwner })).data,
      [],
      'failed update leaves no index'
    );
    const ttlBefore = { ...(driver as any).ttlStore };
    t.equal(await store.putIfMatch('route', { owner: 'bad' }, original.version), false);
    t.same((driver as any).ttlStore, ttlBefore, 'failed update leaves TTL unchanged');
    t.equal(await store.putIfMatch('route', { ...first, rev: randomUUID() }, current.version), true);
    t.equal(
      await store.putIfMatch('route', { owner: 'bad' }, original.version),
      false,
      'returning to the old owner does not revive its revision'
    );
    const latest = (await store.getVersioned('route'))!;
    t.equal(await store.deleteIfMatch('route', latest.version), true);
    t.equal(await store.get('route'), null);
    t.same((await store.getByIndex({ name: 'connection', value: 'a' })).data, [], 'delete removes indexes');
    t.same((driver as any).ttlStore, {}, 'delete removes TTL');
  });
}

tap.test('unsupported custom driver fails rather than downgrading to ordinary writes', async (t) => {
  const driver = await mem.new({ db: { engine: 'mem' } });
  Object.defineProperties(driver, { putIfMatch: { value: undefined }, deleteIfMatch: { value: undefined } });
  const db = await DB.new({ db: { driver }, logger }, true);
  t.teardown(() => db.close());
  const store = db.store('routing-test');
  await t.rejects(store.putIfMatch('route', { owner: 'a' }, null), { message: /./, statusCode: 501 });
  await t.rejects(store.deleteIfMatch('route', { value: '{}' }), { message: /./, statusCode: 501 });
  t.equal(await store.get('route'), null);
});
