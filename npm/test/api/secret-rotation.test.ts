import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });
const source = {
  clientID: 'fixture-connection',
  clientSecret: 'synthetic-downstream-credential',
  tenant: 'customer',
  product: 'product',
  oidcProvider: {
    clientId: 'upstream-client',
    clientSecret: 'synthetic-active-credential',
    secretRevision: 'current-revision',
    standby: {
      role: 'pending',
      clientSecret: 'synthetic-hidden-candidate',
      email: 'pilot@example.test',
      revision: 'candidate-revision',
      savedAt: '2026-10-26T00:00:00Z',
    },
  },
};

function routeFixture(t, file: string, token: any = { sub: 'admin-id', email: 'admin@example.test' }) {
  const connection = structuredClone(source);
  let update: any;
  let action: any[] | undefined;
  const controllers = {
    connectionAPIController: {
      getConnections: async () => [connection],
      getConnectionsByProduct: async () => ({ data: [connection] }),
      updateOIDCConnection: async (body) => {
        update = body;
        return connection;
      },
    },
    adminController: { getAllConnection: async () => ({ data: [connection] }) },
    setupLinkController: { getByToken: async () => ({ tenant: 'customer', product: 'product' }) },
    oidcSecretRotationController: {
      status: async () => ({
        supported: true,
        revision: 'current-revision',
        standby: connection.oidcProvider.standby,
      }),
      change: async (...args) => {
        action = args;
        return { supported: true, revision: 'new-revision' };
      },
    },
  };
  const loaded = t.mockRequire(path.join(root, file), {
    [path.join(root, 'lib/jackson.ts')]: async () => controllers,
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
    },
    [path.join(root, 'lib/env.ts')]: {
      adminPortalSSODefaults: { tenant: 'system', product: 'system' },
      jacksonOptions: { db: { engine: 'mem' } },
    },
    [path.join(root, 'lib/development-mode.ts')]: { validateDevelopmentModeLimits: async () => undefined },
    'next-auth/jwt': { getToken: async () => token },
  });
  return {
    connection,
    get update() {
      return update;
    },
    get action() {
      return action;
    },
    async call(method = 'GET', body = {}, query = {}) {
      let response;
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (key, value) => {
          headers[key] = value;
        },
        status: () => res,
        end: () => undefined,
        json: (value) => {
          response = value;
          return res;
        },
      };
      await loaded.default(
        {
          method,
          query: { clientId: source.clientID, id: source.clientID, token: 'fixture-token', ...query },
          headers: { 'x-polis-return-connection': 'true' },
          body,
        },
        res
      );
      return { body: response, headers };
    },
  };
}

for (const file of [
  'pages/api/admin/connections/[clientId].ts',
  'pages/api/admin/connections/index.ts',
  'pages/api/setup/[token]/sso-connection/[id].ts',
  'pages/api/v1/sso/index.ts',
  'pages/api/v1/sso/product.ts',
]) {
  tap.test(`${file} never returns the standby secret or strips the stored record`, async (t) => {
    const api = routeFixture(t, file);
    const response = await api.call();
    t.notMatch(JSON.stringify(response.body), source.oidcProvider.standby.clientSecret);
    t.match(JSON.stringify(response.body), 'candidate-revision');
    t.match(JSON.stringify(response.body), 'current-revision', 'the form retains its snapshot revision');
    t.equal(api.connection.oidcProvider.standby.clientSecret, source.oidcProvider.standby.clientSecret);
    if (file === 'pages/api/admin/connections/index.ts') {
      const system = await api.call('GET', {}, { isSystemSSO: '' });
      t.notMatch(JSON.stringify(system.body), source.oidcProvider.standby.clientSecret);
    }
  });
}

tap.test('v1 opt-in PATCH response also omits the standby secret', async (t) => {
  const api = routeFixture(t, 'pages/api/v1/sso/index.ts');
  const response = await api.call('PATCH', { isOIDC: true, clientID: source.clientID });
  t.notMatch(JSON.stringify(response.body), source.oidcProvider.standby.clientSecret);
  t.match(response.body, { oidcProvider: { secretRevision: 'current-revision' } });
  t.equal(api.connection.oidcProvider.standby.clientSecret, source.oidcProvider.standby.clientSecret);
});

tap.test('admin form forwards old, current and absent revision snapshots distinctly', async (t) => {
  const api = routeFixture(t, 'pages/api/admin/connections/index.ts');
  await api.call('PATCH', { isOIDC: true, oidcProvider: { secretRevision: 'old-revision' } });
  t.equal(api.update.expectedSecretRevision, 'old-revision');
  await api.call('PATCH', { isOIDC: true, oidcProvider: {} });
  t.equal(api.update.expectedSecretRevision, null);
  await api.call('PATCH', { isOIDC: true, deactivated: false });
  t.equal(
    api.update.expectedSecretRevision,
    undefined,
    'active toggle and sibling panels have no form snapshot'
  );
  await t.rejects(api.call('PATCH', { isOIDC: true, oidcProvider: [] }), {
    message: /snapshot/,
    statusCode: 400,
  });
});

tap.test('rotation actions require an admin session and attribute the actor from the token', async (t) => {
  const api = routeFixture(t, 'pages/api/admin/connections/[clientId]/secret-rotation.ts');
  const read = await api.call();
  t.equal(read.body.standby.clientSecret, source.oidcProvider.standby.clientSecret);
  t.equal(read.headers['Cache-Control'], 'no-store');
  const body = { action: 'discard', expectedRevision: 'current-revision', actor: { id: 'forged' } };
  const response = await api.call('POST', body);
  t.same(api.action, [source.clientID, body, { id: 'admin-id', email: 'admin@example.test' }]);
  t.equal(response.headers['Cache-Control'], 'no-store');
  const anonymous = routeFixture(t, 'pages/api/admin/connections/[clientId]/secret-rotation.ts', null);
  await t.rejects(anonymous.call('GET'), { message: /Unauthorized/, statusCode: 401 });
  await t.rejects(anonymous.call('POST', body), { message: /Unauthorized/, statusCode: 401 });
  t.notOk(anonymous.action);
});
