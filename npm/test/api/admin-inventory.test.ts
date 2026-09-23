import tap from 'tap';
import { collectInventory } from '../../../lib/admin-inventory';

tap.test('offset inventory follows the actual page cap and projects metadata', async (t) => {
  const records = Array.from({ length: 53 }, (_, index) => ({
    id: String(index),
    secret: 'not-in-inventory',
  }));
  const offsets: number[] = [];
  const result = await collectInventory(
    async ({ pageOffset, pageLimit }) => {
      offsets.push(pageOffset);
      t.equal(pageLimit, 50, 'requests the usual page size');
      return { data: records.slice(pageOffset, pageOffset + 7) };
    },
    (record) => ({ id: record.id })
  );

  t.same(offsets, [0, 7, 14, 21, 28, 35, 42, 49, 53]);
  t.equal(result.data.length, 53);
  t.ok(result.complete);
  t.notMatch(JSON.stringify(result), 'not-in-inventory');
});

tap.test('cursor inventory follows empty pages and ends on a full terminal page', async (t) => {
  const tokens: Array<string | undefined> = [];
  const result = await collectInventory(
    async ({ pageToken }) => {
      tokens.push(pageToken);
      return pageToken
        ? { data: Array.from({ length: 50 }, (_, index) => ({ id: String(index) })) }
        : { data: [], pageToken: 'next' };
    },
    (record) => record,
    true
  );

  t.same(tokens, [undefined, 'next']);
  t.equal(result.data.length, 50);
  t.ok(result.complete);
});

tap.test('a full first cursor page without a token is terminal', async (t) => {
  let calls = 0;
  const result = await collectInventory(
    async () => {
      calls++;
      return { data: Array.from({ length: 50 }, (_, index) => ({ id: String(index) })) };
    },
    (record) => record,
    true
  );
  t.equal(calls, 1);
  t.ok(result.complete);
});

tap.test('a repeated cursor stops without claiming completeness or duplicating rows', async (t) => {
  let calls = 0;
  const result = await collectInventory(
    async () => {
      calls++;
      return { data: [{ id: 'same-record' }], pageToken: 'same-token' };
    },
    (record) => record,
    true
  );
  t.equal(calls, 2);
  t.same(result, { data: [{ id: 'same-record' }], complete: false });
});

tap.test('the page budget bounds the inventory and reports it as incomplete', async (t) => {
  let calls = 0;
  const result = await collectInventory(
    async () => ({ data: [{ id: String(calls++) }] }),
    (record) => record
  );
  t.equal(calls, 100);
  t.equal(result.data.length, 100);
  t.notOk(result.complete);
});

tap.test('store failures are not reported as empty inventories', async (t) => {
  const failure = new Error('inventory unavailable');
  await t.rejects(
    collectInventory(
      async () => Promise.reject(failure),
      (record: { id: string }) => record
    ),
    failure
  );
});
