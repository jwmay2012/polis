import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';
import { connectionCreationOptions } from '../../../lib/connection-defaults';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('creation suggestions are projected from complete inventories and the configured app', async (t) => {
  const original = process.env.SSO_DISCOVERY_APP_ID;
  t.teardown(() => {
    if (original === undefined) delete process.env.SSO_DISCOVERY_APP_ID;
    else process.env.SSO_DISCOVERY_APP_ID = original;
  });
  let reads = 0;
  let fail = false;
  const route = t.mockRequire(path.join(root, 'pages/api/admin/connections/defaults.ts'), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      adminController: {
        getAllConnection: async (offset) => ({
          data: offset
            ? []
            : [
                {
                  clientID: 'stored',
                  tenant: 'customer',
                  product: 'Stored product',
                  redirectUrl: ['https://service.test/callback'],
                  defaultRedirectUrl: 'https://service.test/callback',
                  oidcProvider: { clientSecret: 'private' },
                },
                {
                  clientID: 'system',
                  tenant: 'system',
                  product: 'system',
                  redirectUrl: ['https://private.test'],
                  defaultRedirectUrl: 'https://private.test',
                },
              ],
        }),
      },
      identityFederationController: {
        app: {
          getAll: async ({ pageOffset }) => ({
            data: pageOffset ? [] : [{ id: 'app', product: 'App product', clientSecret: 'private' }],
          }),
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
    [path.join(root, 'lib/env.ts')]: {
      jacksonOptions: { db: { engine: 'mem' } },
      adminPortalSSODefaults: { tenant: 'system', product: 'system' },
    },
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
  t.equal(body.product, undefined, 'multiple products without a configured default remain unselected');
  t.same(body.products, ['App product', 'Stored product']);
  t.equal(body.complete, true);
  t.equal(reads, 0, 'no configured default means no specific app lookup');
  process.env.SSO_DISCOVERY_APP_ID = 'configured-app';
  await read();
  t.equal(body.product, 'Example product');
  t.same(body.products, ['App product', 'Example product', 'Stored product']);
  t.notMatch(
    JSON.stringify(body),
    /private|customer|clientSecret/,
    'no secrets, tenants or portal redirect suggestions'
  );
  fail = true;
  await t.rejects(read(), /App unavailable/, 'failed lookup is not a guessed product');
});

tap.test('product suggestions stay distinct from downstream redirect configuration', (t) => {
  const options = connectionCreationOptions(
    ['Example product', 'Example product', 'Another'],
    ['Only in apps'],
    'Example product',
    true
  );
  t.same(options.products, ['Another', 'Example product', 'Only in apps']);
  t.same(Object.keys(options).sort(), ['complete', 'product', 'products']);
  t.equal(options.product, 'Example product');
  t.equal(connectionCreationOptions([], ['Single'], undefined, true).product, 'Single');
  t.equal(connectionCreationOptions([], ['Single'], undefined, false).product, undefined);
  t.end();
});
