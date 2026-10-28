import path from 'path';
import { Readable } from 'stream';
import { createHmac } from 'crypto';
import tap from 'tap';
import { register } from 'tsconfig-paths';
import jackson from '../../src';
import { jacksonOptions } from '../utils';
import { redact } from '../../src/logging/redact';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });
tap.teardown(() => process.exit(0));

tap.test('directory signatures are omitted from automatic logs', (t) => {
  t.same(redact({ 'Ory-Polis-Signature': 'private-value', 'BoxyHQ-Signature': 'private-value' }), {
    'Ory-Polis-Signature': '[REDACTED]',
    'BoxyHQ-Signature': '[REDACTED]',
  });
  t.end();
});

tap.test(
  'private current-person reads require the directory signature and omit unrelated attributes',
  async (t) => {
    const controllers = await jackson(jacksonOptions);
    const sync = controllers.directorySyncController;
    const directory = (
      await sync.directories.create({
        name: 'A',
        tenant: 'customer',
        product: 'product',
        type: 'okta-scim-v2',
        webhook_url: 'http://localhost/unused',
        webhook_secret: 'fixture-directory-key',
      })
    ).data!;
    const users = sync.users.setTenantAndProduct(directory.tenant, directory.product);
    await users.create({
      id: 'person',
      directoryId: directory.id,
      email: 'person@example.test',
      first_name: 'Person',
      last_name: 'Test',
      active: false,
      raw: {
        privateClaim: 'unselected-value',
        emails: [
          { value: 'person@example.test', type: 'work', primary: true, privateClaim: 'unselected-value' },
        ],
      },
    });
    const handler = t.mockRequire(path.join(root, 'pages/api/sso/directory-user.ts'), {
      [path.join(root, 'lib/jackson.ts')]: async () => controllers,
      [path.join(root, 'lib/api/index.ts')]: {
        defaultHandler: async (req, res, handlers) => handlers[req.method](req, res),
      },
    }).default;
    let response: any;
    const read = async (
      body = { directory_id: directory.id, user_id: 'person' },
      key = 'fixture-directory-key',
      timestamp = Date.now(),
      tamper = false
    ) => {
      const raw = JSON.stringify(body);
      const signature = createHmac('sha256', key)
        .update(timestamp + '.' + raw)
        .digest('hex');
      const req = Object.assign(Readable.from([Buffer.from(raw + (tamper ? ' ' : ''))]), {
        method: 'POST',
        headers: { 'ory-polis-signature': `t=${timestamp},s=${signature}` },
      });
      await handler(req, {
        setHeader() {},
        json(data) {
          response = data;
        },
      });
      return response;
    };
    const body = { directory_id: directory.id, user_id: 'person' };
    t.same(await read(), {
      tenant: 'customer',
      product: 'product',
      user: {
        id: 'person',
        email: 'person@example.test',
        first_name: 'Person',
        last_name: 'Test',
        active: false,
        raw: { emails: [{ value: 'person@example.test', type: 'work', primary: true }] },
      },
    });
    t.notMatch(JSON.stringify(response), /unselected-value/);
    await t.rejects(read(body, 'wrong-key'), { statusCode: 401, message: 'Unauthorized' });
    await t.rejects(read(body, undefined, Date.now() - 301000), { statusCode: 401, message: 'Unauthorized' });
    await t.rejects(read(body, undefined, Date.now(), true), { statusCode: 401, message: 'Unauthorized' });
    await t.rejects(read({ ...body, tenant: 'other' } as any), { statusCode: 400, message: /directory ID/ });
    const other = (
      await sync.directories.create({
        name: 'B',
        tenant: 'customer',
        product: 'product',
        type: 'okta-scim-v2',
        webhook_url: 'http://localhost/unused',
        webhook_secret: 'other-key',
      })
    ).data!;
    await t.rejects(read({ ...body, directory_id: other.id }), { statusCode: 401, message: 'Unauthorized' });
    t.equal(
      (await read({ ...body, directory_id: other.id }, 'other-key')).user,
      null,
      'a foreign directory cannot read this person'
    );
    await users.delete('person');
    t.equal((await read()).user, null, 'absence is explicit only after an authenticated read');
    const original = sync.users.get;
    sync.users.get = async () => ({ data: null, error: { code: 500, message: 'fixture storage failure' } });
    try {
      await t.rejects(read(), { statusCode: 503, message: /unavailable/ });
    } finally {
      sync.users.get = original;
    }
  }
);
