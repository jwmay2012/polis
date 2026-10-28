import tap from 'tap';
import sinon from 'sinon';
import jackson from '../../src';
import { Users } from '../../src/directory-sync/scim/Users';
import type { DatabaseStore, Directory, DirectorySyncRequest } from '../../src/typings';
import { dsyncOptions } from './test-options';

const person = (email: string) => ({
  userName: email,
  emails: [{ value: email, type: 'work', primary: true }],
  name: { givenName: 'Original', familyName: 'Person' },
  active: true,
});

const request = (
  directory: Directory,
  method: string,
  resourceType: string,
  resourceId?: string,
  body?: any
): DirectorySyncRequest => ({
  method,
  resourceType,
  resourceId,
  directoryId: directory.id,
  apiSecret: directory.scim.secret,
  query: {},
  body,
});

async function fixture(sameTenant = false) {
  const { directorySyncController: sync } = await jackson(dsyncOptions);
  const make = async (name: string, tenant: string) => {
    const result = await sync.directories.create({
      name,
      tenant,
      product: 'isolation',
      type: 'okta-scim-v2',
    });
    if (!result.data) throw Error(result.error?.message || 'Directory creation failed');
    return result.data;
  };
  const a = await make('A', 'customer-a');
  const b = await make('B', sameTenant ? 'customer-a' : 'customer-b');
  return { sync, a, b };
}

tap.teardown(() => process.exit(0));

tap.test('SCIM requests keep their tenant and callback across an awaited lookup', async (t) => {
  const { sync, a, b } = await fixture();
  const alice = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('alice@example.test'))
  );
  const bob = await sync.requests.handle(request(b, 'POST', 'users', undefined, person('bob@example.test')));
  t.equal(alice.status, 201);
  t.equal(bob.status, 201);
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let armed = true;
  const original = Users.prototype.get;
  const delayed = sinon.stub(Users.prototype, 'get').callsFake(async function (
    this: Users,
    id: string,
    directoryId?: string
  ) {
    const result = await original.call(this, id, directoryId);
    if (armed && id === alice.data.id) {
      armed = false;
      paused.resolve();
      await resume.promise;
    }
    return result;
  });
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  try {
    const update = sync.requests.handle(
      request(a, 'PATCH', 'users', alice.data.id, {
        Operations: [{ op: 'replace', path: 'name.givenName', value: 'Updated A' }],
      }),
      async (event) => {
        eventsA.push(event.event);
      }
    );
    await paused.promise;
    await sync.requests.handle(request(b, 'GET', 'users', bob.data.id), async (event) => {
      eventsB.push(event.event);
    });
    resume.resolve();
    t.equal((await update).status, 200);
  } finally {
    resume.resolve();
    delayed.restore();
  }
  const owner = await sync.requests.handle(request(a, 'GET', 'users', alice.data.id));
  t.equal(owner.data.name.givenName, 'Updated A', 'the write stays with the requesting tenant');
  const foreign = await sync.requests.handle(request(b, 'GET', 'users', alice.data.id));
  t.equal(foreign.status, 404, 'no user is written into the other tenant');
  t.same(eventsA, ['user.updated'], 'the first request receives its own event');
  t.same(eventsB, [], 'a later request cannot replace the callback');
});

tap.test('a directory bearer cannot read or modify another directory in the same customer', async (t) => {
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    await t.test(method, async (t) => {
      const { sync, a, b } = await fixture(true);
      const created = await sync.requests.handle(
        request(a, 'POST', 'users', undefined, person('owner@example.test'))
      );
      t.equal(created.status, 201);
      const body =
        method === 'PUT'
          ? person('replacement@example.test')
          : {
              Operations: [{ op: 'replace', path: 'active', value: false }],
            };
      const result = await sync.requests.handle(request(b, method, 'users', created.data.id, body));
      t.equal(result.status, 404);
      const owner = await sync.requests.handle(request(a, 'GET', 'users', created.data.id));
      t.equal(owner.status, 200);
      t.equal(owner.data.userName, 'owner@example.test');
      t.equal(owner.data.active, true);
    });
  }
});

tap.test('a directory cannot read another directory group or add its users', async (t) => {
  const { sync, a, b } = await fixture(true);
  const user = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('owner@example.test'))
  );
  const groupA = await sync.requests.handle(
    request(a, 'POST', 'groups', undefined, { displayName: 'A group' })
  );
  const groupB = await sync.requests.handle(
    request(b, 'POST', 'groups', undefined, { displayName: 'B group' })
  );
  t.equal(user.status, 201);
  t.equal(groupA.status, 201);
  t.equal(groupB.status, 201);
  t.equal((await sync.requests.handle(request(b, 'GET', 'groups', groupA.data.id))).status, 404);
  const membership = await sync.requests.handle(
    request(b, 'PATCH', 'groups', groupB.data.id, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: user.data.id }] }],
    })
  );
  t.equal(membership.status, 404);
  t.equal(
    await sync.groups.setTenantAndProduct(b.tenant, b.product).isUserInGroup(groupB.data.id, user.data.id),
    false
  );
});

tap.test('owner updates retain directory ownership and legacy records remain usable', async (t) => {
  const { sync, a, b } = await fixture(true);
  const created = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('legacy@example.test'))
  );
  const users = sync.users.setTenantAndProduct(a.tenant, a.product);
  const stored = await users.store('users').get(created.data.id);
  delete stored.directoryId;
  await users.store('users').put(created.data.id, stored);
  t.equal((await sync.requests.handle(request(b, 'GET', 'users', created.data.id))).status, 404);
  t.equal((await sync.requests.handle(request(a, 'GET', 'users', created.data.id))).status, 200);
  t.equal(
    (await sync.requests.handle(request(a, 'PUT', 'users', created.data.id, person('renamed@example.test'))))
      .status,
    200
  );
  t.equal((await users.get(created.data.id)).data?.directoryId, a.id);
  t.equal((await sync.requests.handle(request(a, 'GET', 'users', created.data.id))).status, 200);
  const group = await sync.requests.handle(
    request(a, 'POST', 'groups', undefined, { displayName: 'Legacy group' })
  );
  const groups = sync.groups.setTenantAndProduct(a.tenant, a.product);
  const oldGroup = await groups.store('groups').get(group.data.id);
  delete oldGroup.directoryId;
  await groups.store('groups').put(group.data.id, oldGroup);
  t.equal((await sync.requests.handle(request(b, 'GET', 'groups', group.data.id))).status, 404);
  t.equal(
    (await sync.requests.handle(request(a, 'PUT', 'groups', group.data.id, { displayName: 'Renamed group' })))
      .status,
    200
  );
  t.equal((await groups.get(group.data.id)).data?.directoryId, a.id);
  t.equal(
    (
      await sync.requests.handle(
        request(a, 'PATCH', 'groups', group.data.id, {
          Operations: [{ op: 'add', path: 'members', value: [{ value: created.data.id }] }],
        })
      )
    ).status,
    200
  );
  t.equal((await sync.requests.handle(request(a, 'DELETE', 'users', created.data.id))).status, 200);
  t.equal(
    (
      await sync.requests.handle(
        request(a, 'PATCH', 'groups', group.data.id, {
          Operations: [{ op: 'remove', path: 'members', value: [{ value: created.data.id }] }],
        })
      )
    ).status,
    200,
    'a deleted user can still be removed from its old group'
  );
});

tap.test('client-supplied resource ids cannot overwrite another directory', async (t) => {
  const { sync, a, b } = await fixture(true);
  const owner = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('resource-owner@example.test'))
  );
  const impostor = await sync.requests.handle(
    request(b, 'POST', 'users', undefined, {
      ...person('resource-other@example.test'),
      userId: owner.data.id,
    })
  );
  t.equal(impostor.status, 409);
  t.equal(
    (await sync.requests.handle(request(a, 'GET', 'users', owner.data.id))).data.userName,
    'resource-owner@example.test'
  );
  const group = await sync.requests.handle(
    request(a, 'POST', 'groups', undefined, { displayName: 'Owned resource' })
  );
  t.equal(
    (
      await sync.requests.handle(
        request(b, 'POST', 'groups', undefined, {
          displayName: 'Replacement resource',
          groupId: group.data.id,
        })
      )
    ).status,
    409
  );
  t.equal(
    (await sync.requests.handle(request(a, 'GET', 'groups', group.data.id))).data.displayName,
    'Owned resource'
  );
});

tap.test('a mixed member request is refused before its valid members are written', async (t) => {
  const { sync, a, b } = await fixture(true);
  const foreign = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('foreign@example.test'))
  );
  const local = await sync.requests.handle(
    request(b, 'POST', 'users', undefined, person('local@example.test'))
  );
  const group = await sync.requests.handle(
    request(b, 'POST', 'groups', undefined, { displayName: 'Mixed members' })
  );
  const result = await sync.requests.handle(
    request(b, 'PATCH', 'groups', group.data.id, {
      Operations: [
        { op: 'add', path: 'members', value: [{ value: local.data.id }, { value: foreign.data.id }] },
      ],
    })
  );
  t.equal(result.status, 404);
  t.equal(
    await sync.groups.setTenantAndProduct(b.tenant, b.product).isUserInGroup(group.data.id, local.data.id),
    false
  );
});

tap.test('directory deletion retains its scope during another tenant request', async (t) => {
  const { sync, a, b } = await fixture();
  const alice = await sync.requests.handle(
    request(a, 'POST', 'users', undefined, person('delete-a@example.test'))
  );
  const bob = await sync.requests.handle(
    request(b, 'POST', 'users', undefined, person('delete-b@example.test'))
  );
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = Users.prototype.deleteAll;
  const delayed = sinon.stub(Users.prototype, 'deleteAll').callsFake(async function (
    this: Users,
    id: string
  ) {
    if (id === a.id) {
      paused.resolve();
      await resume.promise;
    }
    return original.call(this, id);
  });
  try {
    const deleting = sync.directories.delete(a.id);
    await paused.promise;
    t.equal((await sync.requests.handle(request(b, 'GET', 'users', bob.data.id))).status, 200);
    resume.resolve();
    t.equal((await deleting).error, null);
  } finally {
    resume.resolve();
    delayed.restore();
  }
  t.equal((await sync.users.setTenantAndProduct(a.tenant, a.product).get(alice.data.id)).error?.code, 404);
  t.equal((await sync.requests.handle(request(b, 'GET', 'users', bob.data.id))).status, 200);
});

tap.test('legacy ownership checks follow complete offset and cursor indexes', async (t) => {
  for (const cursor of [false, true]) {
    await t.test(cursor ? 'cursor' : 'offset', async (t) => {
      let calls = 0;
      const db = {
        store: () => ({
          get: async () => ({ id: 'target' }),
          getByIndex: async (index: { value: string }, offset: number, _limit: number, token?: string) => {
            t.equal(index.value, 'directory', 'each request gets a fresh unhashed index');
            index.value = 'mutated-by-store';
            calls++;
            if (calls === 1) return cursor ? { data: [], pageToken: 'next' } : { data: [{ id: 'other' }] };
            t.equal(cursor ? token : offset, cursor ? 'next' : 1);
            return { data: [{ id: 'target' }] };
          },
        }),
      } as unknown as DatabaseStore;
      const users = new Users({ db, cursor }).setTenantAndProduct('customer', 'product');
      const result = await users.get('target', 'directory');
      t.equal(result.error, null);
      t.equal(result.data?.directoryId, 'directory');
      t.equal(calls, 2, 'a short offset page or an empty cursor page is not the end');
    });
  }
  let calls = 0;
  const db = {
    store: () => ({
      get: async () => ({ id: 'target' }),
      getByIndex: async () => {
        calls++;
        return { data: [], pageToken: 'repeated' };
      },
    }),
  } as unknown as DatabaseStore;
  const result = await new Users({ db, cursor: true })
    .setTenantAndProduct('customer', 'product')
    .get('target', 'directory');
  t.equal(result.error?.code, 503, 'an incomplete index cannot establish absence');
  t.equal(calls, 2);
});
