import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';
import jackson from '../../src';
import { jacksonOptions } from '../utils';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });
tap.teardown(() => process.exit(0));

tap.test('admin directory detail routes do not display another directory resource', async (t) => {
  const controllers = await jackson(jacksonOptions);
  const sync = controllers.directorySyncController;
  const a = (
    await sync.directories.create({ name: 'A', tenant: 'shared', product: 'admin', type: 'okta-scim-v2' })
  ).data!;
  const b = (
    await sync.directories.create({ name: 'B', tenant: 'shared', product: 'admin', type: 'okta-scim-v2' })
  ).data!;
  for (const type of ['users', 'groups'] as const) {
    const created = await sync.requests.handle({
      method: 'POST',
      directoryId: a.id,
      apiSecret: a.scim.secret,
      resourceType: type,
      resourceId: undefined,
      query: {},
      body: type === 'users' ? { userName: 'person@example.test' } : { displayName: 'Team' },
    });
    const idKey = type === 'users' ? 'userId' : 'groupId';
    const handler = t.mockRequire(
      path.join(root, `pages/api/admin/directory-sync/[directoryId]/${type}/[${idKey}].ts`),
      {
        [path.join(root, 'lib/jackson.ts')]: async () => controllers,
        [path.join(root, 'lib/api/index.ts')]: {
          defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
        },
      }
    ).default;
    let response: any;
    const read = (directoryId: string) =>
      handler(
        { method: 'GET', query: { directoryId, [idKey]: created.data.id } },
        {
          json: (data) => {
            response = data;
          },
        }
      );
    await read(a.id);
    t.equal(response.data.id, created.data.id);
    await t.rejects(read(b.id), { statusCode: 404, message: /not found/i });
  }
});
