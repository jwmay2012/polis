import tap from 'tap';
import { randomUUID } from 'crypto';
import DB from '../../src/db/db';
import mem from '../../src/db/mem';
import oidc from '../../src/controller/connection/oidc';
import { OIDCSecretRotationController, selectOIDCSecret } from '../../src/controller/oidc-secret-rotation';
import { redact } from '../../src/logging/redact';
import type { OIDCSSORecord, OIDCSecretRotationAction, RequiredLogger } from '../../src';

const activeSecret = 'synthetic-active-credential';
const pendingSecret = 'synthetic-replacement-credential';
const pilot = 'pilot@example.test';
const conflict = { message: /./, statusCode: 409 };
const postgres = process.env.POLIS_ROUTING_TEST_POSTGRES;
if (postgres && new URL(postgres).hostname !== '127.0.0.1')
  throw new Error('Use an isolated loopback PostgreSQL fixture.');
const definition = {
  tenant: 'customer',
  product: 'product',
  name: 'OIDC fixture',
  oidcClientId: 'fixture-client',
  oidcClientSecret: activeSecret,
  oidcDiscoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
  redirectUrl: ['https://app.example.test/callback'],
  defaultRedirectUrl: 'https://app.example.test/callback',
};

async function fixture(t, supported = true) {
  const events: any[] = [];
  const logger: RequiredLogger = {
    info: (message, fields) => events.push({ message, ...fields }),
    warn: (message, fields) => events.push({ message, ...fields }),
    error() {},
  };
  const driver = await mem.new({ db: { engine: 'mem' } });
  if (!supported) Object.defineProperty(driver, 'putIfMatch', { value: undefined });
  const db = await DB.new(
    { db: supported && postgres ? { engine: 'sql', type: 'postgres', url: postgres } : { driver }, logger },
    true
  );
  t.teardown(() => db.close());
  const scope = `secret-rotation-${randomUUID()}`;
  const store = db.store(`${scope}:connections`);
  const results = db.store(`${scope}:results`, 60);
  const original = await oidc.create(definition, store);
  const rotation = new OIDCSecretRotationController(store, results, logger);
  const get = async () => (await store.get(original.clientID)) as OIDCSSORecord;
  const status = () => rotation.status(original.clientID);
  const change = async (action: OIDCSecretRotationAction['action'], fields = {}) =>
    rotation.change(
      original.clientID,
      {
        action,
        expectedRevision: (await status()).revision,
        ...fields,
      },
      { id: 'admin-fixture', email: 'admin@example.test' }
    );
  return {
    store,
    results,
    original,
    rotation,
    get,
    status,
    change,
    events,
    stage: () => change('stage', { clientSecret: pendingSecret, email: ' Pilot@Example.Test ' }),
    validate: async () => rotation.record(selectOIDCSecret(await get(), pilot, false), { email: pilot }),
    update: (body: Record<string, unknown>) =>
      oidc.update(
        {
          clientID: original.clientID,
          clientSecret: original.clientSecret,
          tenant: original.tenant,
          product: original.product,
          ...body,
        },
        store,
        async () => [await get()]
      ),
  };
}

tap.test(
  'trial selection and proof distinguish confidential credentials from public and wrong accounts',
  async (t) => {
    const f = await fixture(t);
    await f.stage();
    const connection = await f.get();
    const selected = selectOIDCSecret(connection, pilot, false);
    t.equal(selected.clientSecret, pendingSecret);
    t.equal(selectOIDCSecret(connection, 'other@example.test', false).clientSecret, activeSecret);
    t.equal(selectOIDCSecret(connection, undefined, false).clientSecret, activeSecret);
    t.equal(selectOIDCSecret(connection, [pilot], false).clientSecret, activeSecret);
    t.equal(selectOIDCSecret(connection, pilot, true).clientSecret, undefined);
    await t.rejects(f.change('promote'), conflict);
    await f.rotation.record(selectOIDCSecret(connection, pilot, true), { email: pilot });
    t.equal((await f.status()).last?.outcome, 'not_exercised');
    t.notOk((await f.status()).validated);
    await f.rotation.record(selectOIDCSecret(connection, pilot, true), { error: { error: 'invalid_grant' } });
    t.match((await f.status()).last, { outcome: 'not_exercised', mode: 'public', error: 'invalid_grant' });
    t.notOk((await f.status()).validated, 'failed public sign-ins never test a secret');
    await f.rotation.record(selected, { email: 'another@example.test' });
    t.equal((await f.status()).last?.outcome, 'different_account');
    await t.rejects(f.change('promote'), conflict);
    await f.rotation.record(selected, {
      error: { error: 'invalid_client', error_description: pendingSecret },
    });
    t.equal((await f.status()).last?.error, 'invalid_client');
    t.notMatch(JSON.stringify(await f.status()), pendingSecret);
    await f.rotation.record(selected, { error: { error: pendingSecret } });
    t.equal((await f.status()).last?.error, 'upstream_validation_failed');
    await f.validate();
    await f.rotation.record(selected, { error: { error: 'invalid_client' } });
    t.equal((await f.status()).validated?.email, pilot, 'a diagnostic failure does not erase separate proof');
    t.same(await f.get(), connection, 'test recording never writes the connection');
  }
);

tap.test(
  'promotion, rollback, re-test and finish preserve the connection and its active-secret contract',
  async (t) => {
    const f = await fixture(t);
    const originalRevision = (await f.status()).revision;
    await f.stage();
    await f.validate();
    const before = await f.status();
    t.notMatch(JSON.stringify(before), pendingSecret);
    await f.change('promote');
    let current = await f.get();
    t.equal(current.oidcProvider.clientSecret, pendingSecret);
    t.equal(current.oidcProvider.standby?.clientSecret, activeSecret);
    t.equal(current.oidcProvider.standby?.role, 'previous');
    for (const key of ['clientID', 'clientSecret', 'tenant', 'product', 'name'])
      t.equal(current[key], f.original[key], `preserves ${key}`);
    t.equal(current.oidcProvider.clientId, f.original.oidcProvider.clientId);
    await t.rejects(f.stage(), conflict);
    await f.change('rollback');
    current = await f.get();
    t.equal(current.oidcProvider.clientSecret, activeSecret);
    t.equal(current.oidcProvider.standby?.clientSecret, pendingSecret);
    t.not((await f.status()).revision, before.revision, 'returning to A does not revive an old revision');
    await t.rejects(f.change('promote'), conflict, 'rollback requires a fresh test');
    await f.validate();
    await f.change('promote');
    await f.change('finish');
    current = await f.get();
    t.equal(
      current.oidcProvider.clientSecret,
      pendingSecret,
      'old images still read the promoted active field'
    );
    t.notOk(current.oidcProvider.standby);
    await t.rejects(
      f.update({
        name: 'Old form',
        oidcClientSecret: activeSecret,
        expectedSecretRevision: originalRevision,
      }),
      conflict
    );
    await f.update({
      name: 'Fresh form',
      oidcClientSecret: pendingSecret,
      expectedSecretRevision: current.oidcProvider.secretRevision,
    });
    t.equal((await f.get()).name, 'Fresh form');
    const recreated = await oidc.create({ ...definition, oidcClientSecret: pendingSecret }, f.store);
    t.not(
      recreated.oidcProvider.secretRevision,
      current.oidcProvider.secretRevision,
      'same-ID replacement retains a fresh revision'
    );
    t.equal(recreated.clientID, f.original.clientID);
    t.ok(f.events.filter((event) => event.action).every((event) => event.admin_id === 'admin-fixture'));
    t.same(
      f.events.filter((event) => event.action).map((event) => event.action),
      ['stage', 'promote', 'rollback', 'promote', 'finish'],
      'one audit event per successful state change'
    );
    t.notMatch(JSON.stringify(f.events), pendingSecret);
  }
);

tap.test('discard and candidate replacement make late or older proof inert', async (t) => {
  const f = await fixture(t);
  await f.stage();
  const oldSelection = selectOIDCSecret(await f.get(), pilot, false);
  const oldRevision = (await f.status()).revision;
  await f.change('discard');
  t.equal(selectOIDCSecret(await f.get(), pilot, false).clientSecret, activeSecret);
  await f.stage();
  await f.rotation.record(oldSelection, { email: pilot });
  t.notOk((await f.status()).validated);
  await t.rejects(f.change('promote'), conflict);
  await t.rejects(
    f.rotation.change(f.original.clientID, { action: 'discard', expectedRevision: oldRevision }, {}),
    conflict
  );
  await f.validate();
  await f.stage();
  t.notOk((await f.status()).validated, 'saving a candidate requires a new test');
});

tap.test('rotation preserves normal name edits but prevents credential/provider replacement', async (t) => {
  const f = await fixture(t);
  await f.stage();
  await f.update({
    name: 'Renamed',
    oidcClientSecret: activeSecret,
    oidcDiscoveryUrl: definition.oidcDiscoveryUrl,
    oidcMetadata: {
      issuer: '',
      authorization_endpoint: '',
      token_endpoint: '',
      jwks_uri: '',
      userinfo_endpoint: '',
    },
  });
  t.equal((await f.get()).name, 'Renamed', 'normal discovery-form echoes are harmless');
  await t.rejects(f.update({ oidcDiscoveryUrl: 'https://other.example.test/discovery' }), conflict);
  await t.rejects(f.update({ oidcClientSecret: 'synthetic-third-credential' }), conflict);
  await t.rejects(oidc.create(definition, f.store), conflict);
  await f.update({ oidcPublicUpstreamRedirectUri: 'https://polis.example.test/api/oauth/oidc/mobile' });
  t.ok((await f.get()).oidcProvider.standby);
});

tap.test('metadata forms can echo absent optional endpoints while a rotation is pending', async (t) => {
  const f = await fixture(t);
  const metadata = {
    issuer: 'https://idp.example.test',
    authorization_endpoint: 'https://idp.example.test/authorize',
    token_endpoint: 'https://idp.example.test/token',
    userinfo_endpoint: 'https://idp.example.test/userinfo',
  };
  // Creation requires every endpoint; the existing PATCH path permits this partial metadata.
  await f.update({ oidcMetadata: metadata });
  await f.stage();
  await f.update({
    name: 'Metadata form edit',
    oidcDiscoveryUrl: '',
    oidcMetadata: { ...metadata, jwks_uri: '' },
  });
  t.equal((await f.get()).name, 'Metadata form edit');
  t.equal((await f.get()).oidcProvider.standby?.clientSecret, pendingSecret);
  await t.rejects(
    f.update({ oidcMetadata: { token_endpoint: 'https://other.example.test/token' } }),
    conflict
  );
  await t.rejects(
    f.update({ oidcMetadata: { userinfo_endpoint: '' } }),
    conflict,
    'clearing an existing endpoint remains a material change'
  );
  await t.rejects(
    f.update({ oidcMetadata: { token_endpoint_auth_methods_supported: '' } }),
    conflict,
    'only the known form endpoint defaults can be ignored'
  );
});

tap.test('ordinary edits rebase on a concurrent rotation rather than erasing it', async (t) => {
  for (const action of ['stage', 'promote'] as const) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      if (action === 'promote') {
        await f.stage();
        await f.validate();
      }
      const read = f.store.getVersioned.bind(f.store);
      let interleaved = false;
      f.store.getVersioned = async (key) => {
        const snapshot = await read(key);
        if (!interleaved) {
          interleaved = true;
          if (action === 'stage') await f.stage();
          else await f.change('promote');
        }
        return snapshot;
      };
      await f.update({ name: 'Concurrent name edit' });
      t.ok(interleaved);
      const current = await f.get();
      t.equal(current.name, 'Concurrent name edit');
      t.equal(current.oidcProvider.standby?.role, action === 'stage' ? 'pending' : 'previous');
      t.equal(current.oidcProvider.clientSecret, action === 'stage' ? activeSecret : pendingSecret);
      t.equal(
        f.events.filter((event) => event.action === action).length,
        1,
        'retries do not duplicate action auditing'
      );
    });
  }
});

tap.test('same-ID creation cannot race a saved candidate', async (t) => {
  const f = await fixture(t);
  const read = f.store.getVersioned.bind(f.store);
  let interleaved = false;
  f.store.getVersioned = async (key) => {
    const snapshot = await read(key);
    if (!interleaved) {
      interleaved = true;
      await f.stage();
    }
    return snapshot;
  };
  await t.rejects(oidc.create(definition, f.store), conflict);
  t.ok(interleaved);
  t.equal((await f.get()).oidcProvider.standby?.clientSecret, pendingSecret);
});

tap.test('one competing confirmation wins; unsupported storage keeps ordinary CRUD', async (t) => {
  const f = await fixture(t);
  const expectedRevision = (await f.status()).revision;
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      f.rotation.change(
        f.original.clientID,
        {
          action: 'stage',
          expectedRevision,
          clientSecret: pendingSecret,
          email: pilot,
        },
        {}
      )
    )
  );
  t.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  t.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const old = await fixture(t, false);
  t.equal((await old.status()).supported, false);
  await old.update({ name: 'Supported ordinary edit', oidcClientSecret: pendingSecret });
  t.equal((await old.get()).oidcProvider.clientSecret, pendingSecret);
  await t.rejects(old.change('stage', { clientSecret: activeSecret, email: pilot }), {
    message: /conditional/,
    statusCode: 501,
  });
});

tap.test('evidence failures are best effort and log fields do not disclose credentials', async (t) => {
  const f = await fixture(t);
  await f.stage();
  f.results.put = async () => {
    throw new Error('Synthetic evidence failure');
  };
  await t.resolves(f.validate());
  t.notOk((await f.status()).validated);
  t.match(f.events.at(-1)?.message, /Unable to record/);
  const safe = JSON.stringify(redact({ connection: await f.get(), upstream_credential_source: 'pending' }));
  t.notMatch(safe, activeSecret);
  t.notMatch(safe, pendingSecret);
  t.match(safe, '"upstream_credential_source":"pending"');
});

tap.test('expired proof cannot promote even before the store cleans up its TTL rows', async (t) => {
  const f = await fixture(t);
  await f.stage();
  await f.validate();
  const status = await f.status();
  await f.results.put(`${f.original.clientID}:${status.standby!.revision}:validated`, {
    ...status.validated,
    at: '2000-01-01T00:00:00Z',
  });
  t.notOk((await f.status()).validated);
  await t.rejects(f.change('promote'), conflict);
});

tap.test(
  'tenant/product addressing stays pinned through a retry and legacy form snapshots become stale',
  async (t) => {
    const f = await fixture(t);
    const legacy = await f.get();
    delete legacy.oidcProvider.secretRevision;
    await f.store.put(legacy.clientID, legacy);
    let lookups = 0;
    const read = f.store.getVersioned.bind(f.store);
    let interleaved = false;
    f.store.getVersioned = async (key) => {
      const snapshot = await read(key);
      if (!interleaved) {
        interleaved = true;
        await f.stage();
      }
      return snapshot;
    };
    await oidc.update(
      {
        tenant: legacy.tenant,
        product: legacy.product,
        clientSecret: legacy.clientSecret,
        name: 'By tenant',
      } as any, // The HTTP API supports tenant/product despite the upstream type requiring clientID.
      f.store,
      async (query) => {
        lookups++;
        t.notOk('clientID' in query);
        return [legacy];
      }
    );
    t.equal(lookups, 1);
    t.equal((await f.get()).name, 'By tenant');
    t.ok((await f.get()).oidcProvider.standby);
    await f.change('discard');
    await t.rejects(f.update({ expectedSecretRevision: null, oidcClientSecret: activeSecret }), conflict);
  }
);
