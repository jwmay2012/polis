import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('app routing inventory includes orphaned bindings without application credentials', async (t) => {
  const calls: string[] = [];
  let unavailable = false;
  const routes = [
    { app: 'app', match: 'example.test', connectionID: 'present', revision: 'one' },
    { app: 'app', match: 'pilot@example.test', connectionID: 'missing', revision: 'two' },
  ];
  const handler = t.mockRequire(path.join(root, 'ee/identity-federation/api/admin/[id]/index.ts'), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      identityFederationController: {
        app: {
          get: async ({ id }) => {
            t.equal(id, 'app');
            calls.push('get');
            if (unavailable) throw new Error('Application unavailable');
            return { id, clientSecret: 'private-fixture-secret' };
          },
          getMetadata: async () => {
            calls.push('metadata');
            return { issuer: 'example' };
          },
        },
      },
      routingController: {
        managed: async (id) => {
          t.equal(id, 'app');
          calls.push('managed');
          return { app: id, revision: 'mode' };
        },
        list: async (filter) => {
          t.same(filter, { app: 'app' });
          calls.push('list');
          return routes;
        },
      },
    }),
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (request, response, handlers) => handlers[request.method](request, response),
    },
  }).default;
  const headers = new Map();
  let body: any;
  const response = { setHeader: (key, value) => headers.set(key, value), json: (value) => (body = value) };
  await handler({ method: 'GET', query: { id: 'app', routing: 'true' } }, response);
  t.same(body, { managed: { app: 'app', revision: 'mode' }, routes });
  t.notMatch(JSON.stringify(body), 'private-fixture');
  t.equal(headers.get('Cache-Control'), 'no-store');
  t.same(calls, ['get', 'managed', 'list']);
  calls.length = 0;
  await handler({ method: 'GET', query: { id: 'app' } }, response);
  t.same(calls, ['get', 'metadata']);
  t.equal(body.data.clientSecret, 'private-fixture-secret', 'ordinary app response is unchanged');
  unavailable = true;
  calls.length = 0;
  await t.rejects(handler({ method: 'GET', query: { id: 'app', routing: 'true' } }, response), {
    message: 'Application unavailable',
  });
  t.same(calls, ['get'], 'app/license checks must succeed before reading any routing data');
});
