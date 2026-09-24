import { randomUUID } from 'crypto';
import type {
  ConditionalStore,
  IdentityFederationApp,
  Index,
  JacksonOptionWithRequiredLogger,
  OIDCSSORecord,
  SAMLSSORecord,
  Storable,
} from '../typings';
import { JacksonError } from './error';
import { IndexNames, isConnectionActive } from './utils';
import { keyFromParts } from '../db/utils';
import { extractDomainFromLoginHint } from './domain-utils';
import { bindContext } from './log-context';

type Connection = OIDCSSORecord | SAMLSSORecord;
export type PublishedRoute = {
  app: string;
  match: string;
  connectionID: string;
  revision: string;
  publishedAt: string;
  previousConnectionID?: string;
};
export type RouteLookup =
  | { status: 'route'; connection: Connection; route: PublishedRoute }
  | {
      status: 'unavailable';
      reason: 'missing' | 'deactivated' | 'app_missing' | 'out_of_scope' | 'unavailable';
      route: PublishedRoute;
    }
  | { status: 'none' | 'legacy' };

const inApplication = (connection: Connection, app: IdentityFederationApp) =>
  connection.product === app.product &&
  (app.tenants?.length ? app.tenants.includes(connection.tenant) : app.tenant === connection.tenant);

export function normalizeLoginMatch(input: string): string {
  if (typeof input !== 'string' || input.length > 254)
    throw new JacksonError('Enter a full email address or domain.', 400);
  const match = input.trim().toLowerCase();
  const domain = match.includes('@') ? extractDomainFromLoginHint(match) : match;
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) ||
    /[\s<>"\\:/?#]/.test(match)
  )
    throw new JacksonError('Enter a full email address or domain.', 400);
  return match;
}

export class RoutingController {
  constructor(
    private store: ConditionalStore,
    private connections: Storable,
    private apps: Storable,
    private opts: JacksonOptionWithRequiredLogger
  ) {}

  // Indexes retain former owners. Filter current records only after paging the complete index.
  private async collect<T>(store: Storable, index: Index): Promise<T[]> {
    const rows: T[] = [];
    const tokens = new Set<string>();
    let pageOffset = 0;
    let pageToken: string | undefined;
    const cursor = 'engine' in this.opts.db && this.opts.db.engine === 'dynamodb';
    for (let page = 0; page < 100; page++) {
      const result = await store.getByIndex({ ...index }, pageOffset, 50, pageToken);
      rows.push(...result.data);
      if (cursor) {
        if (!result.pageToken) return rows;
        if (tokens.has(result.pageToken)) break;
        tokens.add(result.pageToken);
        pageToken = result.pageToken;
      } else {
        if (!result.data.length) return rows;
        pageOffset += result.data.length;
      }
    }
    throw new JacksonError('Could not verify all published routes; try again.', 503);
  }

  async list(scope: { app: string } | { connectionID: string }): Promise<PublishedRoute[]> {
    const [field, value] =
      'app' in scope ? (['app', scope.app] as const) : (['connectionID', scope.connectionID] as const);
    const rows = await this.collect<PublishedRoute>(this.store, { name: field, value });
    return rows.filter((route) => route[field] === value);
  }

  async connectionsForTenant(tenant: string, product: string): Promise<Connection[]> {
    return this.collect<Connection>(this.connections, {
      name: IndexNames.TenantProduct,
      value: keyFromParts(tenant, product),
    });
  }

  async managed(app: string): Promise<{ app: string; revision: string } | null> {
    return this.store.get(`managed:${app}`);
  }

  async setManaged(app: string, enabled: boolean, expectedRevision: string | null) {
    await this.requireApp(app);
    const key = `managed:${app}`;
    const current = await this.store.getVersioned(key);
    if ((current?.value.revision ?? null) !== expectedRevision)
      throw new JacksonError('Routing mode changed; reload before confirming.', 409);
    if (!enabled && !current) return null;
    const next = { app, revision: randomUUID() };
    const changed = enabled
      ? await this.store.putIfMatch(key, next, current?.version ?? null)
      : await this.store.deleteIfMatch(key, current!.version);
    if (!changed) throw new JacksonError('Routing mode changed; reload before confirming.', 409);
    this.opts.logger.info(enabled ? 'Enabled explicit SSO routing' : 'Restored legacy tenant routing', {
      federation_app_id: app,
    });
    return enabled ? next : null;
  }

  async draft(connectionID: string): Promise<{ matches: string[] }> {
    return (await this.store.get(`draft:${connectionID}`)) || { matches: [] };
  }

  async saveDraft(connectionID: string, matches: string[]) {
    if (!(await this.connections.get(connectionID))) throw new JacksonError('Connection not found.', 404);
    if (!Array.isArray(matches) || matches.length > 100)
      throw new JacksonError('Provide at most 100 email addresses or domains.', 400);
    const draft = { matches: [...new Set(matches.map(normalizeLoginMatch))] };
    await this.store.put(`draft:${connectionID}`, draft);
    return draft;
  }

  async preview(app: string, matches: string[]) {
    await this.requireApp(app);
    if (!Array.isArray(matches) || matches.length > 100)
      throw new JacksonError('Provide at most 100 email addresses or domains.', 400);
    return Promise.all(
      [...new Set(matches.map(normalizeLoginMatch))].map(async (match) => {
        const route: PublishedRoute | null = await this.store.get(`route:${app}:${match}`);
        const connection: Connection | null = route ? await this.connections.get(route.connectionID) : null;
        return {
          match,
          route,
          owner: connection
            ? {
                id: connection.clientID,
                name: connection.name,
                tenant: connection.tenant,
                active: isConnectionActive(connection),
              }
            : null,
        };
      })
    );
  }

  async lookup(app: string, email: string): Promise<RouteLookup> {
    const match = normalizeLoginMatch(email);
    if (!match.includes('@')) throw new JacksonError('Enter a full email address.', 400);
    const domain = match.slice(match.lastIndexOf('@') + 1);
    const route: PublishedRoute | null =
      (await this.store.get(`route:${app}:${match}`)) || (await this.store.get(`route:${app}:${domain}`));
    if (!route) return { status: (await this.managed(app)) ? 'none' : 'legacy' };
    bindContext({
      requested_email: match,
      requested_domain: domain,
      federation_app_id: app,
      routing_source: 'published_match',
      connection_id: route.connectionID,
    });
    try {
      const connection: Connection | null = await this.connections.get(route.connectionID);
      if (!connection) return { status: 'unavailable', reason: 'missing', route };
      if (!isConnectionActive(connection)) return { status: 'unavailable', reason: 'deactivated', route };
      const application: IdentityFederationApp | null = await this.apps.get(app);
      if (!application) return { status: 'unavailable', reason: 'app_missing', route };
      if (!inApplication(connection, application))
        return { status: 'unavailable', reason: 'out_of_scope', route };
      return { status: 'route', connection, route };
    } catch (err) {
      this.opts.logger.error('SSO is required but its configuration could not be loaded', {
        err,
        federation_app_id: app,
        match,
        connection_id: route.connectionID,
      });
      return { status: 'unavailable', reason: 'unavailable', route };
    }
  }

  async publish({
    app,
    match: input,
    connectionID,
    expectedRevision,
    importLegacy = false,
  }: {
    app: string;
    match: string;
    connectionID: string;
    expectedRevision: string | null;
    importLegacy?: boolean;
  }) {
    const match = normalizeLoginMatch(input);
    const application = await this.requireApp(app);
    const connection: Connection | null = await this.connections.get(connectionID);
    if (!connection || !inApplication(connection, application))
      throw new JacksonError('Connection must belong to this application before publishing.', 400);
    if (!(await this.managed(app))) {
      if (!importLegacy || expectedRevision !== null)
        throw new JacksonError('Import and activate explicit routing before publishing new matches.', 409);
      const domain = match.includes('@') ? match.split('@')[1] : match;
      const candidates: Connection[] = [];
      for (const tenant of application.tenants?.length ? application.tenants : [application.tenant]) {
        if (tenant.toLowerCase() === domain)
          candidates.push(...(await this.connectionsForTenant(tenant, application.product)));
      }
      const active = candidates.filter(isConnectionActive);
      const owners = active.length ? active : candidates;
      if (owners.length !== 1 || owners[0].clientID !== connectionID)
        throw new JacksonError(
          'Import must preserve one verified legacy owner; resolve the missing or ambiguous connection first.',
          409
        );
    }
    const key = `route:${app}:${match}`;
    const current = await this.store.getVersioned<PublishedRoute>(key);
    if ((current?.value.revision ?? null) !== expectedRevision)
      throw new JacksonError(`${match} changed; reload before confirming.`, 409);
    const route: PublishedRoute = {
      app,
      match,
      connectionID,
      revision: randomUUID(),
      publishedAt: new Date().toISOString(),
      previousConnectionID: current?.value.connectionID,
    };
    const changed = await this.store.putIfMatch(
      key,
      route,
      current?.version ?? null,
      { name: 'app', value: app },
      { name: 'connectionID', value: connectionID }
    );
    if (!changed) throw new JacksonError(`${match} changed; reload before confirming.`, 409);
    this.opts.logger.info('Published SSO route', {
      federation_app_id: app,
      match,
      connection_id: connectionID,
      previous_connection_id: current?.value.connectionID,
    });
    return route;
  }

  async withdraw(app: string, input: string, expectedRevision: string) {
    const match = normalizeLoginMatch(input);
    const key = `route:${app}:${match}`;
    const current = await this.store.getVersioned<PublishedRoute>(key);
    if (
      !current ||
      current.value.revision !== expectedRevision ||
      !(await this.store.deleteIfMatch(key, current.version))
    )
      throw new JacksonError(`${match} changed; reload before confirming withdrawal.`, 409);
    this.opts.logger.info('Withdrew SSO requirement', {
      federation_app_id: app,
      match,
      connection_id: current.value.connectionID,
    });
  }

  async assertUnused(scope: { app: string } | { connectionID: string }) {
    const routes = await this.list(scope);
    if (routes.length)
      throw new JacksonError(
        `Move or explicitly withdraw published SSO routes first: ${routes.map((route) => route.match).join(', ')}.`,
        409
      );
  }

  async removeDraft(connectionID: string) {
    await this.store.delete(`draft:${connectionID}`);
  }

  async removeManaged(app: string) {
    await this.store.delete(`managed:${app}`);
  }

  private async requireApp(id: string): Promise<IdentityFederationApp> {
    const app: IdentityFederationApp | null = await this.apps.get(id);
    if (!app) throw new JacksonError('Application not found.', 404);
    if (app.type !== 'oidc')
      throw new JacksonError('Email routing requires an OIDC federation application.', 400);
    return app;
  }
}
