import tap from 'tap';
import jackson from '../../src';
import type { Directory, DirectorySyncRequest } from '../../src/typings';
import { dsyncOptions } from './test-options';

const request = (
  directory: Directory,
  method: string,
  body?: any,
  resourceId?: string,
  query = {}
): DirectorySyncRequest => ({
  method,
  body,
  resourceId,
  query,
  resourceType: 'users',
  directoryId: directory.id,
  apiSecret: directory.scim.secret,
});
const user = (name: string) => ({
  userName: `${name}.login`,
  externalId: `external-${name}`,
  active: true,
  emails: [{ value: `${name}@example.test`, primary: true, type: 'work' }],
});

async function fixture() {
  const { directorySyncController: sync } = await jackson({
    ...dsyncOptions,
    db: { ...dsyncOptions.db, pageLimit: 2 },
  });
  const result = await sync.directories.create({
    name: 'Queries',
    tenant: 'customer',
    product: 'queries',
    type: 'okta-scim-v2',
  });
  if (!result.data) throw Error('Directory creation failed');
  return { sync, directory: result.data };
}

tap.teardown(() => process.exit(0));

tap.test('SCIM equality filters distinguish userName, externalId and email', async (t) => {
  const { sync, directory } = await fixture();
  const created = await sync.requests.handle(request(directory, 'POST', user('alice')));
  t.equal(created.status, 201);
  for (const filter of [
    'userName eq "alice.login"',
    'externalId eq "external-alice"',
    'emails.value eq "alice@example.test"',
  ]) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, { filter }));
    t.equal(result.status, 200, filter);
    t.same(
      result.data.Resources.map((entry: any) => entry.id),
      [created.data.id],
      filter
    );
  }
  const wrong = await sync.requests.handle(
    request(directory, 'GET', undefined, undefined, { filter: 'externalId eq "alice@example.test"' })
  );
  t.equal(wrong.data.totalResults, 0, 'an externalId filter must not silently search email');
});

tap.test('SCIM rename updates matching and rejects stale index results', async (t) => {
  const { sync, directory } = await fixture();
  const created = await sync.requests.handle(request(directory, 'POST', user('alice')));
  const renamed = await sync.requests.handle(request(directory, 'PUT', user('renamed'), created.data.id));
  t.equal(renamed.status, 200);
  for (const [filter, expected] of [
    ['emails.value eq "alice@example.test"', 0],
    ['emails.value eq "renamed@example.test"', 1],
    ['userName eq "renamed.login"', 1],
    ['externalId eq "external-renamed"', 1],
  ] as const) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, { filter }));
    t.equal(result.data.totalResults, expected, filter);
  }
});

tap.test('SCIM totalResults includes users beyond the database page limit', async (t) => {
  const { sync, directory } = await fixture();
  for (let i = 0; i < 5; i++)
    t.equal((await sync.requests.handle(request(directory, 'POST', user(`person${i}`)))).status, 201);
  const first = await sync.requests.handle(
    request(directory, 'GET', undefined, undefined, { count: 2, startIndex: 1 })
  );
  const last = await sync.requests.handle(
    request(directory, 'GET', undefined, undefined, { count: 2, startIndex: 5 })
  );
  t.equal(first.data.totalResults, 5);
  t.equal(first.data.Resources.length, 2);
  t.equal(last.data.totalResults, 5);
  t.equal(last.data.Resources.length, 1);
});

tap.test('SCIM filters validate attributes, quoting, conjunctions and case rules', async (t) => {
  const { sync, directory } = await fixture();
  const created = await sync.requests.handle(request(directory, 'POST', user('alice')));
  for (const [filter, count] of [
    ['USERNAME EQ "ALICE.LOGIN"', 1],
    ['externalId eq "EXTERNAL-ALICE"', 0],
    ['userName eq "alice.login" and externalId eq "external-alice"', 1],
    ['userName eq "alice.login" and externalId eq "other"', 0],
    ['emails[type eq "work"].value eq "ALICE@EXAMPLE.TEST"', 1],
  ] as const) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, { filter }));
    t.equal(result.status, 200, filter);
    t.equal(result.data.totalResults, count, filter);
  }
  for (const filter of [
    'name eq "Alice"',
    'userName co "alice"',
    'userName eq',
    'userName eq "unterminated',
    '',
  ]) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, { filter }));
    t.equal(result.status, 400, filter);
    t.equal(result.data.scimType, 'invalidFilter');
  }
  const patched = await sync.requests.handle(
    request(
      directory,
      'PATCH',
      {
        Operations: [
          { op: 'replace', path: 'userName', value: 'new.login' },
          { op: 'replace', path: 'emails[type eq "work"].value', value: 'new@example.test' },
        ],
      },
      created.data.id
    )
  );
  t.equal(patched.status, 200);
  for (const [filter, count] of [
    ['userName eq "alice.login"', 0],
    ['userName eq "new.login"', 1],
    ['emails.value eq "alice@example.test"', 0],
    ['emails.value eq "new@example.test"', 1],
  ] as const) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, { filter }));
    t.equal(result.data.totalResults, count, filter);
  }
});

tap.test('SCIM renamed addresses can be reused but current userNames remain unique', async (t) => {
  const { sync, directory } = await fixture();
  const created = await sync.requests.handle(request(directory, 'POST', user('alice')));
  const collision = await sync.requests.handle(
    request(directory, 'POST', { ...user('bob'), userName: 'ALICE.LOGIN' })
  );
  t.equal(collision.status, 409, 'same userName with another email is a conflict');
  const bob = await sync.requests.handle(request(directory, 'POST', user('bob')));
  const renameCollision = await sync.requests.handle(request(directory, 'PUT', user('alice'), bob.data.id));
  t.equal(renameCollision.status, 409, 'renaming onto a current user is refused');
  t.equal(
    (await sync.requests.handle(request(directory, 'GET', undefined, bob.data.id))).data.userName,
    'bob.login'
  );
  t.equal(
    (await sync.requests.handle(request(directory, 'PUT', user('renamed'), created.data.id))).status,
    200
  );
  t.equal(
    (await sync.requests.handle(request(directory, 'POST', user('alice')))).status,
    201,
    'old index entry does not reserve the old email'
  );
});

tap.test('SCIM pagination handles count zero, defaults and invalid parameters', async (t) => {
  const { sync, directory } = await fixture();
  for (let i = 0; i < 5; i++) await sync.requests.handle(request(directory, 'POST', user(`page${i}`)));
  for (const query of [{ count: 0 }, { count: 2, startIndex: 99 }]) {
    const result = await sync.requests.handle(request(directory, 'GET', undefined, undefined, query));
    t.equal(result.status, 200);
    t.equal(result.data.totalResults, 5);
    t.equal(result.data.Resources.length, 0);
  }
  const all = await sync.requests.handle(request(directory, 'GET'));
  t.equal(all.data.Resources.length, 5, 'unspecified count is not the database page cap');
  for (const query of [{ count: 'NaN' }, { startIndex: 1.5 }, { count: [] }]) {
    t.equal((await sync.requests.handle(request(directory, 'GET', undefined, undefined, query))).status, 400);
  }
});

tap.test('SCIM group lookup, rename and totals use the complete directory', async (t) => {
  const { sync, directory } = await fixture();
  const groupRequest = (method: string, body?: any, id?: string, query = {}) =>
    sync.requests.handle({ ...request(directory, method, body, id, query), resourceType: 'groups' });
  const groups: string[] = [];
  for (let i = 0; i < 5; i++) {
    const result = await groupRequest('POST', { displayName: `Team ${i}`, externalId: `team-${i}` });
    t.equal(result.status, 201);
    groups.push(result.data.id);
  }
  const page = await groupRequest('GET', undefined, undefined, { count: 2, startIndex: 5 });
  t.equal(page.data.totalResults, 5);
  t.equal(page.data.Resources.length, 1);
  t.equal(page.data.startIndex, 5);
  t.equal(
    (
      await groupRequest(
        'PATCH',
        { Operations: [{ op: 'replace', path: 'displayName', value: 'Renamed' }] },
        groups[0]
      )
    ).status,
    200
  );
  for (const [filter, count] of [
    ['displayName eq "Team 0"', 0],
    ['displayName eq "RENAMED"', 1],
    ['externalId eq "team-0"', 1],
  ] as const) {
    const result = await groupRequest('GET', undefined, undefined, { filter });
    t.equal(result.data.totalResults, count, filter);
  }
  t.equal((await groupRequest('POST', { displayName: 'Team 0' })).status, 201);
  const invalid = await groupRequest('GET', undefined, undefined, { filter: 'name co "Team"' });
  t.equal(invalid.status, 400);
  t.equal(invalid.data.scimType, 'invalidFilter');
});
