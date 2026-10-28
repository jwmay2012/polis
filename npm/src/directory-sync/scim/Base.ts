import type { Storable, DB, Index } from '../../typings';
import { storeNamespacePrefix } from '../../controller/utils';
import { JacksonError } from '../../controller/error';
import { pagination, type ListQuery } from './query';

export class Base {
  protected db: DB;
  protected tenant: null | string = null;
  protected product: null | string = null;
  protected bulkDeleteBatchSize = 500;
  protected cursor: boolean;

  constructor({ db, cursor = false }: { db: DB; cursor?: boolean }) {
    this.db = db;
    this.cursor = cursor;
  }

  // Return the database store
  store(type: 'groups' | 'members' | 'users' | 'logs' | 'events', ttl?: number): Storable {
    if (!this.tenant || !this.product) {
      throw new Error('Set tenant and product before using store.');
    }

    return this.db.store(`${storeNamespacePrefix.dsync[type]}:${this.tenant}:${this.product}`, ttl);
  }

  // Set the tenant and product
  setTenantAndProduct(tenant: string, product: string): this {
    this.tenant = tenant;
    this.product = product;

    // Keep statement-style callers working; chained operations retain their
    // own scope while another request changes the shared controller.
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  }

  protected async *indexRecords(store: Storable, index: Index): AsyncGenerator<any> {
    let offset = 0;
    let token: string | undefined;
    let cursor = this.cursor;
    const seen = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const result = await store.getByIndex({ ...index }, offset, 100, token);
      if (result.pageToken) cursor = true;
      if (cursor) {
        if (result.pageToken && seen.has(result.pageToken)) break;
        if (result.pageToken) seen.add(result.pageToken);
      } else if (result.data.length) {
        const first = String(result.data[0].id);
        if (seen.has(first)) break;
        seen.add(first);
      }
      yield* result.data;
      if (cursor) {
        if (!result.pageToken) return;
        token = result.pageToken;
      } else {
        if (!result.data.length) return;
        offset += result.data.length;
      }
    }
    throw new JacksonError('Could not read the complete directory index.', 503);
  }

  protected async belongsToDirectory(
    type: 'users' | 'groups',
    record: { id: string; directoryId?: string },
    directoryId: string
  ): Promise<boolean> {
    if (record.directoryId) return record.directoryId === directoryId;
    // Older group records and user PUTs omitted directoryId. The original
    // directory index still establishes ownership; the next write retains it.
    for await (const entry of this.indexRecords(this.store(type), {
      name: 'directoryId',
      value: directoryId,
    })) {
      if (entry.id === record.id) return true;
    }
    return false;
  }

  protected async directoryPage<T extends { id: string; directoryId?: string }>(
    type: 'users' | 'groups',
    directoryId: string,
    query: ListQuery,
    matches: (record: T) => boolean = () => true
  ) {
    const { count, startIndex } = pagination(query);
    const data: T[] = [];
    let totalResults = 0;
    const seen = new Set<string>();
    // Read current records from the existing directory index. Attribute indexes
    // are add-only, and older records lack indexes for userName/externalId.
    for await (const record of this.indexRecords(this.store(type), {
      name: 'directoryId',
      value: directoryId,
    })) {
      if ((record.directoryId && record.directoryId !== directoryId) || seen.has(record.id)) continue;
      seen.add(record.id);
      if (!matches(record)) continue;
      totalResults++;
      if (totalResults >= startIndex && data.length < count) data.push(record);
    }
    return { data, totalResults, startIndex };
  }
}
