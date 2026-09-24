import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('connection product default comes only from the configured app', async (t) => {
  const original = process.env.SSO_DISCOVERY_APP_ID;
  t.teardown(() => {
    if (original === undefined) delete process.env.SSO_DISCOVERY_APP_ID;
    else process.env.SSO_DISCOVERY_APP_ID = original;
  });
  let reads = 0;
  let fail = false;
  const route = t.mockRequire(path.join(root, 'pages/api/admin/connections/defaults.ts'), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      identityFederationController: {
        app: {
          get: async ({ id }) => {
            reads++;
            t.equal(id, 'configured-app', 'caller cannot choose the source app');
            if (fail) throw new Error('App unavailable');
            return {
              product: 'Example product',
              clientSecret: 'private-fixture',
              tenants: ['private-tenant'],
            };
          },
        },
      },
    }),
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
    },
  });
  let body;
  const response = {
    setHeader: (key, value) => t.same([key, value], ['Cache-Control', 'no-store']),
    json: (value) => {
      body = value;
    },
  };
  const read = () => route.default({ method: 'GET', query: { app: 'caller-app' } }, response);
  delete process.env.SSO_DISCOVERY_APP_ID;
  await read();
  t.same(body, {});
  t.equal(reads, 0, 'no configured default means no app lookup');
  process.env.SSO_DISCOVERY_APP_ID = 'configured-app';
  await read();
  t.same(body, { product: 'Example product' }, 'no credentials, catalog or membership returned');
  fail = true;
  await t.rejects(read(), /App unavailable/, 'failed lookup is not a guessed product');
});
