import type { ConditionalStore, OIDCSSORecord, Storable } from '../../typings';
import { keyFromParts } from '../../db/utils';
import { JacksonError } from '../error';
import { IndexNames } from '../utils';

// All OIDC writers cooperate so an ordinary form save cannot undo a rotation.
// The builder may be retried: keep external side effects outside it.
export async function writeOIDCRecord(
  store: Storable,
  id: string,
  build: (current: OIDCSSORecord | null) => OIDCSSORecord | Promise<OIDCSSORecord>
): Promise<OIDCSSORecord> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const versioned = store.conditional
      ? await (store as ConditionalStore).getVersioned<OIDCSSORecord>(id)
      : null;
    const current = store.conditional ? (versioned?.value ?? null) : await store.get(id);
    const next = await build(current);
    const indexes = [
      { name: IndexNames.TenantProduct, value: keyFromParts(next.tenant, next.product) },
      { name: IndexNames.Product, value: next.product },
    ];
    if (!store.conditional) {
      await store.put(id, next, ...indexes);
      return next;
    }
    if (await (store as ConditionalStore).putIfMatch(id, next, versioned?.version ?? null, ...indexes))
      return next;
  }
  throw new JacksonError('The connection changed while saving. Reload and try again.', 409);
}
