import tap from 'tap';
import sinon from 'sinon';
import * as axiosModule from '../../src/event/axios';
import { handleEventCallback } from '../../src/directory-sync/utils';

tap.test('exhausted webhook delivery is logged even when payload retention is disabled', async (t) => {
  const error = sinon.spy();
  const retain = sinon.spy();
  const post = sinon.stub().rejects({
    response: { status: 503, data: { secret: 'private-response' } },
    config: { __retryCount: 3, headers: { Authorization: 'private-token' } },
  });
  const stub = sinon.stub(axiosModule, 'createAxiosInstance').returns({ post } as any);
  t.teardown(() => stub.restore());
  const callback = await handleEventCallback({
    opts: { logger: { error, info() {}, warn() {}, debug() {} } },
    directories: {
      get: async () => ({
        data: {
          webhook: { endpoint: 'http://localhost/webhook', secret: 'private-signature-key' },
          log_webhook_events: false,
        },
        error: null,
      }),
    },
    webhookLogs: { setTenantAndProduct: () => ({ log: retain }) },
  } as any);
  await callback({
    directory_id: 'directory-one',
    tenant: 'customer',
    product: 'product',
    event: 'user.updated',
    data: { id: 'person-one', raw: { privateClaim: 'private-payload' } },
  } as any);
  t.equal(error.callCount, 1, 'final failure is visible without storing payloads');
  t.match(error.firstCall?.args, [
    'Directory sync webhook delivery failed.',
    {
      directory_id: 'directory-one',
      tenant: 'customer',
      product: 'product',
      event: 'user.updated',
      resource_id: 'person-one',
      status_code: 503,
      attempts: 4,
    },
  ]);
  t.notMatch(
    JSON.stringify(error.args),
    /private-/,
    'no payload, response body, signature or headers are logged'
  );
  t.equal(retain.callCount, 0, 'payload retention remains disabled');
});
