import crypto from 'crypto';
import { isDeepStrictEqual } from 'util';
import {
  IConnectionAPIController,
  OIDCSSOConnectionWithDiscoveryUrl,
  OIDCSSOConnectionWithMetadata,
  OIDCSSORecord,
  Storable,
  UpdateOIDCConnectionParams,
} from '../../typings';
import * as dbutils from '../../db/utils';
import {
  extractHostName,
  extractRedirectUrls,
  validateSSOConnection,
  validateRedirectUrl,
  validateTenantAndProduct,
  validateSortOrder,
} from '../utils';
import { JacksonError } from '../error';
import { writeOIDCRecord } from './oidc-write';

const oidc = {
  create: async (
    body: OIDCSSOConnectionWithDiscoveryUrl | OIDCSSOConnectionWithMetadata,
    connectionStore: Storable
  ) => {
    validateSSOConnection(body, 'oidc');

    const {
      defaultRedirectUrl,
      redirectUrl,
      tenant,
      product,
      name,
      label,
      description,
      oidcDiscoveryUrl = '',
      oidcMetadata = { issuer: '' },
      oidcClientId = '',
      oidcClientSecret = '',
      oidcPublicUpstreamRedirectUri,
    } = body;

    const redirectUrlList = extractRedirectUrls(redirectUrl);

    validateRedirectUrl({ defaultRedirectUrl, redirectUrlList });

    validateTenantAndProduct(tenant, product);

    if ('sortOrder' in body) {
      validateSortOrder(body.sortOrder);
    }

    const record: Partial<OIDCSSORecord> = {
      defaultRedirectUrl,
      redirectUrl: redirectUrlList,
      tenant,
      product,
      name,
      label,
      description,
      clientID: '',
      clientSecret: '',
      sortOrder: parseInt(body.sortOrder as any),
    };

    //  from OpenID Provider
    record.oidcProvider = {
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
    } as OIDCSSORecord['oidcProvider'];

    if (oidcDiscoveryUrl) {
      record.oidcProvider.discoveryUrl = oidcDiscoveryUrl;
    } else if (oidcMetadata.issuer) {
      record.oidcProvider.metadata = oidcMetadata;
    }

    // Public upstream redirect URI for mobile/SPA clients
    if (oidcPublicUpstreamRedirectUri) {
      record.oidcProvider.publicUpstreamRedirectUri = oidcPublicUpstreamRedirectUri;
    }

    // extract provider
    const providerName = extractHostName(oidcDiscoveryUrl || oidcMetadata.issuer);
    record.oidcProvider.provider = providerName ? providerName : 'Unknown';

    // Use the clientId from the OpenID Provider to generate the clientID hash for the connection
    record.clientID = dbutils.keyDigest(dbutils.keyFromParts(tenant, product, oidcClientId));

    return writeOIDCRecord(connectionStore, record.clientID, (exists) => {
      if (exists?.oidcProvider?.standby)
        throw new JacksonError(
          'Discard or finish the secret rotation before replacing this connection.',
          409
        );
      return {
        ...record,
        clientSecret: exists?.clientSecret ?? crypto.randomBytes(24).toString('hex'),
        oidcProvider: { ...record.oidcProvider, secretRevision: crypto.randomUUID() },
      } as OIDCSSORecord;
    });
  },

  update: async (
    body: UpdateOIDCConnectionParams,
    connectionStore: Storable,
    connectionsGetter: IConnectionAPIController['getConnections']
  ) => {
    const {
      defaultRedirectUrl,
      redirectUrl,
      name,
      label,
      description,
      oidcDiscoveryUrl,
      oidcMetadata,
      oidcClientId,
      oidcClientSecret,
      oidcPublicUpstreamRedirectUri,
      expectedSecretRevision,
      ...clientInfo
    } = body;

    if (
      !(clientInfo?.clientID && clientInfo?.clientSecret) &&
      !(clientInfo?.tenant && clientInfo?.product && clientInfo?.clientSecret)
    ) {
      throw new JacksonError('Please provide clientID/clientSecret or tenant/product/clientSecret', 400);
    }

    if (description && description.length > 100) {
      throw new JacksonError('Description should not exceed 100 characters', 400);
    }

    if ('sortOrder' in body) {
      validateSortOrder(body.sortOrder);
    }

    const redirectUrlList = redirectUrl ? extractRedirectUrls(redirectUrl) : null;
    validateRedirectUrl({ defaultRedirectUrl, redirectUrlList });

    // Preserve the existing tenant/product selection, then retry only this ID.
    const selected = (await connectionsGetter(clientInfo))[0] as OIDCSSORecord;
    if (!selected) throw new JacksonError('OIDC connection not found.', 404);

    return writeOIDCRecord(connectionStore, selected.clientID, (_savedConnection) => {
      if (!_savedConnection?.oidcProvider) throw new JacksonError('OIDC connection not found.', 404);

      if (_savedConnection.clientSecret !== clientInfo?.clientSecret) {
        throw new JacksonError('clientSecret mismatch', 400);
      }
      if (
        expectedSecretRevision !== undefined &&
        expectedSecretRevision !== (_savedConnection.oidcProvider.secretRevision ?? null)
      )
        throw new JacksonError('The client secret changed since this form was loaded. Reload.', 409);

      let oidcProvider;
      if (_savedConnection && typeof _savedConnection.oidcProvider === 'object') {
        oidcProvider = { ..._savedConnection.oidcProvider };

        if (oidcClientId && typeof oidcClientId === 'string') {
          const clientID = dbutils.keyDigest(
            dbutils.keyFromParts(clientInfo.tenant, clientInfo.product, oidcClientId)
          );
          if (clientID !== clientInfo?.clientID) {
            throw new JacksonError('Tenant/Product config mismatch with OIDC Provider metadata', 400);
          }
        }

        if (oidcClientSecret && typeof oidcClientSecret === 'string') {
          if (oidcProvider.standby && oidcClientSecret !== oidcProvider.clientSecret)
            throw new JacksonError(
              'Discard or finish the secret rotation before replacing the active secret.',
              409
            );
          if (oidcClientSecret !== oidcProvider.clientSecret)
            oidcProvider.secretRevision = crypto.randomUUID();
          oidcProvider.clientSecret = oidcClientSecret;
        }

        if (oidcDiscoveryUrl && typeof oidcDiscoveryUrl === 'string') {
          oidcProvider.discoveryUrl = oidcDiscoveryUrl;
          const providerName = extractHostName(oidcDiscoveryUrl);
          oidcProvider.provider = providerName ? providerName : 'Unknown';
          // Remove previous metadata if any
          delete oidcProvider.metadata;
        } else if (oidcMetadata && typeof oidcMetadata === 'object') {
          // Perform a merge of new metadata with existing one
          oidcProvider.metadata = { ...oidcProvider.metadata, ...oidcMetadata };
          const providerName = extractHostName(oidcMetadata.issuer);
          oidcProvider.provider = providerName ? providerName : 'Unknown';
          // Remove previous discoveryUrl if any
          delete oidcProvider.discoveryUrl;
        }

        // Update public upstream redirect URI for mobile/SPA clients
        if (oidcPublicUpstreamRedirectUri !== undefined) {
          if (oidcPublicUpstreamRedirectUri === '' || oidcPublicUpstreamRedirectUri === null) {
            // Allow clearing the value
            delete oidcProvider.publicUpstreamRedirectUri;
          } else {
            oidcProvider.publicUpstreamRedirectUri = oidcPublicUpstreamRedirectUri;
          }
        }
        if (oidcProvider.standby) {
          const savedMetadata = _savedConnection.oidcProvider.metadata;
          const materialMetadata = oidcProvider.metadata ? { ...oidcProvider.metadata } : undefined;
          if (materialMetadata && savedMetadata) {
            // The form echoes absent endpoint fields as empty strings. Ignore
            // only those additions for this guard; preserve normal update semantics.
            for (const key of [
              'issuer',
              'authorization_endpoint',
              'token_endpoint',
              'userinfo_endpoint',
              'jwks_uri',
            ]) {
              if (materialMetadata[key] === '' && !Object.prototype.hasOwnProperty.call(savedMetadata, key))
                delete materialMetadata[key];
            }
          }
          if (
            oidcProvider.discoveryUrl !== _savedConnection.oidcProvider.discoveryUrl ||
            !isDeepStrictEqual(materialMetadata, savedMetadata)
          )
            throw new JacksonError(
              'Discard or finish the secret rotation before changing the OIDC provider.',
              409
            );
        }
      }

      const record: OIDCSSORecord = {
        ..._savedConnection,
        name: name || name === '' ? name : _savedConnection.name,
        label: label || label === '' ? label : _savedConnection.label,
        description: description || description === '' ? description : _savedConnection.description,
        defaultRedirectUrl: defaultRedirectUrl ? defaultRedirectUrl : _savedConnection.defaultRedirectUrl,
        redirectUrl: redirectUrlList ? redirectUrlList : _savedConnection.redirectUrl,
        oidcProvider: oidcProvider ? oidcProvider : _savedConnection.oidcProvider,
      };

      if ('sortOrder' in body) {
        record.sortOrder = parseInt(body.sortOrder as any);
      }

      if ('deactivated' in body) {
        record['deactivated'] = body.deactivated;
      }

      return record;
    });
  },
};

export default oidc;
