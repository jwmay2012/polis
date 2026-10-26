import type { OIDCSSORecord, SAMLSSORecord } from '@boxyhq/saml-jackson';
import { ApiError } from './error';

// Response projection only. Internal readers and writers need the complete record.
export function connectionResponse(connection: OIDCSSORecord | SAMLSSORecord) {
  if (!('oidcProvider' in connection) || !connection.oidcProvider.standby) return connection;
  const { role, revision, email, savedAt } = connection.oidcProvider.standby;
  return {
    ...connection,
    oidcProvider: { ...connection.oidcProvider, standby: { role, revision, email, savedAt } },
  };
}

// react-ui echoes the provider object from the GET that populated its form.
// An old form without a revision is distinct from a non-form API update.
export function snapshotSecretRevision(body: Record<string, any>): string | null | undefined {
  if (!Object.hasOwn(body, 'oidcProvider')) return undefined;
  const provider = body.oidcProvider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider))
    throw new ApiError('Invalid OIDC provider snapshot.', 400);
  const revision = provider.secretRevision;
  if (revision !== undefined && revision !== null && typeof revision !== 'string')
    throw new ApiError('Invalid client secret revision.', 400);
  return revision ?? null;
}
