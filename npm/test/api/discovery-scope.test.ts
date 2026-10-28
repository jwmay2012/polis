import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('private discovery includes only the selected connection scope', async (t) => {
  const previous = process.env.SSO_DISCOVERY_APP_ID;
  process.env.SSO_DISCOVERY_APP_ID = 'configured-app';
  t.teardown(() => {
    if (previous === undefined) delete process.env.SSO_DISCOVERY_APP_ID;
    else process.env.SSO_DISCOVERY_APP_ID = previous;
  });
  let outcome: any = {
    status: 'route',
    connection: {
      clientID: 'chosen',
      tenant: 'customer',
      product: 'product',
      clientSecret: 'private-credential',
      redirectUrl: ['private-url'],
    },
  };
  const handler = t.mockRequire(path.join(root, 'pages/api/sso/resolve.ts'), {
    [path.join(root, 'lib/jackson.ts')]: async () => ({
      routingController: {
        lookup: async (app, email) => {
          t.equal(app, 'configured-app');
          t.equal(email, 'person@example.test');
          return outcome;
        },
      },
    }),
    [path.join(root, 'lib/api/index.ts')]: {
      defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
    },
    [path.join(root, 'lib/logger.ts')]: { logger: { warn() {} } },
  }).default;
  let response: any;
  let status = 200;
  const res = {
    setHeader() {},
    json: (data) => {
      response = data;
    },
    status: (code) => {
      status = code;
      return res;
    },
  };
  const read = (body = { email: 'person@example.test' }) => handler({ method: 'POST', body }, res);
  await read();
  t.same(response, { required: true, idp_hint: 'chosen', tenant: 'customer', product: 'product' });
  t.notMatch(JSON.stringify(response), /private-/);
  outcome = { status: 'unavailable', reason: 'deactivated' };
  await read();
  t.same(response, { required: true, idp_hint: null, reason: 'deactivated' });
  outcome = { status: 'none' };
  await read();
  t.same(response, { required: false });
  await read({ email: 'person@example.test', app: 'untrusted-app' } as any);
  t.equal(status, 400);
});
