import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

function fixture(t, saml = false) {
  const connection = {
    clientID: 'target',
    clientSecret: 'private',
    tenant: 'customer',
    product: 'product',
    deactivated: true,
    ...(saml ? { idpMetadata: {} } : { oidcProvider: {} }),
  };
  const application = { product: 'product', tenants: ['customer'] };
  const calls: string[] = [];
  const state = { managed: true, revision: null as string | null, failEnable: false, failPublish: false };
  let response;
  const update = async (input) => {
    t.same(input, {
      clientID: 'target',
      clientSecret: 'private',
      tenant: 'customer',
      product: 'product',
      deactivated: false,
    });
    calls.push('enable');
    if (state.failEnable) throw new Error('Enable failed');
    connection.deactivated = false;
  };
  const route = t.mockRequire(path.join(root, 'pages/api/admin/connections/[clientId]/routing.ts'), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      identityFederationController: { app: { get: async () => application } },
      connectionAPIController: {
        getConnections: async () => [connection],
        updateOIDCConnection: saml ? async () => t.fail('wrong protocol') : update,
        updateSAMLConnection: saml ? update : async () => t.fail('wrong protocol'),
      },
      routingController: {
        managed: async () => state.managed,
        preview: async (_app, matches) => {
          if (matches.some((match) => match === 'invalid')) throw new Error('Invalid match');
          return [{ route: state.revision ? { revision: state.revision } : null }];
        },
        publish: async ({ match }) => {
          calls.push('publish');
          if (state.failPublish) throw new Error('Storage failed');
          return { match, connectionID: 'target' };
        },
      },
    }),
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
    },
    [path.join(root, 'lib/logger.ts')]: { logger: { warn: () => undefined } },
  });
  return {
    state,
    connection,
    application,
    calls,
    get response() {
      return response;
    },
    write: (body = {}) =>
      route.default(
        {
          method: 'POST',
          query: { clientId: 'target', app: 'app' },
          body: { action: 'publish', matches: [{ match: 'example.test', expectedRevision: null }], ...body },
        },
        {
          json: (value) => {
            response = value;
          },
        }
      ),
  };
}

for (const saml of [false, true]) {
  tap.test(`confirmed ${saml ? 'SAML' : 'OIDC'} reactivation happens before publication`, async (t) => {
    const api = fixture(t, saml);
    await t.rejects(api.write(), { statusCode: 409, message: /confirm enabling/ });
    t.same(api.calls, [], 'old clients cannot silently publish into a disabled target');
    await api.write({ enable: true });
    t.same(api.calls, ['enable', 'publish']);
    t.equal(api.response.enabled, true);
    t.equal(api.connection.deactivated, false);
  });
}

tap.test('invalid or stale confirmations do not reactivate; enable failures do not publish', async (t) => {
  const api = fixture(t);
  api.application.tenants = [];
  await t.rejects(api.write({ enable: true }), /belong to this application/);
  api.application.tenants = ['customer'];
  api.state.managed = false;
  await t.rejects(api.write({ enable: true }), /activate explicit routing/);
  api.state.managed = true;
  api.state.revision = 'newer';
  await t.rejects(api.write({ enable: true }), /reload before confirming/);
  api.state.revision = null;
  await t.rejects(
    api.write({ enable: true, matches: [{ match: 'invalid', expectedRevision: null }] }),
    /Invalid match/
  );
  t.same(api.calls, []);
  api.state.failEnable = true;
  await t.rejects(api.write({ enable: true }), /Enable failed/);
  t.same(api.calls, ['enable']);
});

tap.test('publication failure reports successful activation without pretending an atomic move', async (t) => {
  const api = fixture(t);
  api.state.failPublish = true;
  await api.write({ enable: true });
  t.equal(api.response.enabled, true);
  t.match(api.response.results[0].error, /Publication failed/);
  t.equal(api.connection.deactivated, false);
});

tap.test('legacy imports preserve paused targets', async (t) => {
  const api = fixture(t);
  await api.write({ action: 'import' });
  t.same(api.calls, ['publish']);
  t.equal(api.response.enabled, false);
  t.equal(api.connection.deactivated, true);
});
