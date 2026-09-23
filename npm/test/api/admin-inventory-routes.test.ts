import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

function fixture(t, kind: 'connections' | 'applications', engine = 'mem') {
  const records = Array.from({ length: 53 }, (_, index) => ({
    id: `app-${index}`,
    clientID: `connection-${index}`,
    clientSecret: 'private-fixture-secret',
    name: `Example ${index}`,
    tenant: `tenant-${index}.example.test`,
    product: 'example-product',
    type: 'oidc',
    tenants: [`tenant-${index}.example.test`],
    deactivated: index === 1,
    oidcProvider: { clientSecret: 'private-upstream-secret' },
  }));
  const calls: any[] = [];
  let defaultCalls = 0;
  let settingsCalls = 0;
  const getByProduct = async (params) => {
    calls.push(params);
    if (params.product !== 'example-product') return { data: [] };
    if (engine === 'dynamodb') {
      return params.pageToken
        ? { data: records.slice(3) }
        : { data: records.slice(0, 3), pageToken: 'next-page' };
    }
    return { data: records.slice(params.pageOffset, params.pageOffset + 7) };
  };
  const getAll = async (...params) => {
    defaultCalls++;
    calls.push(params);
    return { data: records.slice(0, 1), pageToken: 'ordinary-page' };
  };

  const filename =
    kind === 'connections'
      ? 'pages/api/admin/connections/index.ts'
      : 'ee/identity-federation/api/admin/index.ts';
  const route = t.mockRequire(path.join(root, filename), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      adminController: { getAllConnection: getAll },
      connectionAPIController: {
        getConnectionsByProduct: getByProduct,
        getConnections: async (params) => {
          settingsCalls++;
          t.same(params, { tenant: 'portal-tenant', product: 'portal-product' });
          return [{ clientID: 'system-connection', product: 'portal-product' }];
        },
      },
      identityFederationController: { app: { getByProduct, getAll } },
    }),
    [path.join(root, 'lib/env.ts')]: {
      jacksonOptions: { db: { engine } },
      adminPortalSSODefaults: { tenant: 'portal-tenant', product: 'portal-product' },
    },
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (request, response, handlers) => handlers[request.method](request, response),
    },
    [path.join(root, 'lib/utils.ts')]: {
      parsePaginateApiParams: () => ({ pageOffset: 4, pageLimit: 2, pageToken: 'request-page' }),
    },
    [path.join(root, 'lib/development-mode.ts')]: { validateDevelopmentModeLimits: () => undefined },
  });

  const headers = new Map<string, string>();
  let body: any;
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    json: (value) => {
      body = value;
    },
  };
  return {
    request: (query) => route.default({ method: 'GET', query }, response),
    headers,
    calls,
    get body() {
      return body;
    },
    get defaultCalls() {
      return defaultCalls;
    },
    get settingsCalls() {
      return settingsCalls;
    },
  };
}

for (const kind of ['connections', 'applications'] as const) {
  for (const engine of ['mem', 'dynamodb']) {
    tap.test(`${kind} inventory uses ${engine} pagination and excludes credentials`, async (t) => {
      const api = fixture(t, kind, engine);
      await api.request({ inventory: 'true', product: 'example-product' });
      const rows = kind === 'connections' ? api.body : api.body.data;
      t.equal(rows.length, 53);
      t.equal(api.headers.get('jackson-inventory-complete'), 'true');
      t.notOk(api.headers.has('jackson-pagetoken'), 'inventory is not a paginated response');
      t.notMatch(JSON.stringify(rows), 'private-');
      t.equal(api.defaultCalls, 0);
      t.equal(api.settingsCalls, 0);
      t.ok(api.calls.every((params) => params.product === 'example-product'));
      if (kind === 'connections') {
        t.same(Object.keys(rows[0]).sort(), ['active', 'id', 'isSystemSSO', 'name', 'product', 'tenant']);
        t.equal(rows[0].active, true);
        t.equal(rows[1].active, false);
      } else {
        t.same(Object.keys(rows[0]).sort(), ['id', 'name', 'product', 'tenant', 'tenants', 'type']);
      }
      if (engine === 'dynamodb')
        t.same(
          api.calls.map((params) => params.pageToken),
          [undefined, 'next-page']
        );
      else
        t.same(
          api.calls.map((params) => params.pageOffset),
          [0, 7, 14, 21, 28, 35, 42, 49, 53]
        );
    });
  }

  tap.test(`${kind} inventory validates its product without changing ordinary GETs`, async (t) => {
    const api = fixture(t, kind);
    for (const product of [undefined, '', ['one', 'two']]) {
      await t.rejects(api.request({ inventory: 'true', product }), {
        message: /Provide a product/,
        statusCode: 400,
      });
    }
    await api.request({ inventory: 'true', product: 'not-configured' });
    t.same(kind === 'connections' ? api.body : api.body.data, []);
    t.equal(api.headers.get('jackson-inventory-complete'), 'true');
    await api.request({});
    t.equal(api.defaultCalls, 1);
    t.equal(api.headers.get('jackson-pagetoken'), 'ordinary-page');
    t.match(JSON.stringify(api.body), 'private-fixture-secret', 'ordinary payload is unchanged');
  });
}

tap.test('system SSO queries retain their existing scope and payload', async (t) => {
  const api = fixture(t, 'connections');
  await api.request({ isSystemSSO: '', product: 'example-product', inventory: 'true' });
  t.equal(api.settingsCalls, 1);
  t.same(api.body, [{ clientID: 'system-connection', product: 'portal-product' }]);
  t.notOk(api.headers.has('jackson-inventory-complete'));
});
