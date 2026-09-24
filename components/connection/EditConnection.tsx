import { useRouter } from 'next/router';
import { useState } from 'react';
import { errorToast, successToast } from '@components/Toaster';
import { useTranslation } from 'next-i18next';
import { LinkBack } from '@boxyhq/internal-ui';
import type { OIDCSSORecord, SAMLSSORecord } from '@boxyhq/saml-jackson';
import { EditSAMLConnection, EditOIDCConnection } from '@boxyhq/react-ui/sso';
import { BOXYHQ_UI_CSS } from '@components/styles';
import PublicClientSettings from './PublicClientSettings';
import Applications from './Applications';
import LoginRouting from './LoginRouting';
import DirectIntegrationSettings from './DirectIntegrationSettings';

type EditProps = {
  connection: SAMLSSORecord | OIDCSSORecord;
  setupLinkToken?: string;
  isSettingsView?: boolean;
};

const EditConnection = ({ connection, setupLinkToken, isSettingsView = false }: EditProps) => {
  const router = useRouter();
  const { t } = useTranslation('common');
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [directRevision, setDirectRevision] = useState(0);

  const { id: connectionClientId } = router.query;

  const connectionIsSAML = 'idpMetadata' in connection && typeof connection.idpMetadata === 'object';
  const connectionIsOIDC = 'oidcProvider' in connection && typeof connection.oidcProvider === 'object';

  const backUrl = setupLinkToken
    ? `/setup/${setupLinkToken}`
    : isSettingsView
      ? '/admin/settings/sso-connection'
      : '/admin/sso-connection';

  const apiUrl = setupLinkToken ? `/api/setup/${setupLinkToken}/sso-connection` : `/api/admin/connections`;
  const connectionFetchUrl = setupLinkToken
    ? `/api/setup/${setupLinkToken}/sso-connection/${connectionClientId}`
    : `/api/admin/connections/${connectionClientId}?activity=${connection.deactivated ? 'inactive' : 'active'}&direct=${directRevision}`;

  const fieldsToExclude: any = isSettingsView
    ? ['label', 'tenant', 'product']
    : ['label', 'redirectUrl', 'defaultRedirectUrl'];

  return (
    <>
      <LinkBack href={backUrl} />
      <div>
        <div className='flex items-center justify-between'>
          <h2 className='mb-5 mt-5 font-bold text-gray-700 dark:text-white md:text-xl'>
            {t('edit_sso_connection')}
          </h2>
        </div>
        {!setupLinkToken && !isSettingsView && (
          <Applications key={connection.clientID} tenant={connection.tenant} product={connection.product} />
        )}
        {!setupLinkToken && !isSettingsView && (
          <LoginRouting
            key={connection.clientID}
            connectionID={connection.clientID}
            tenant={connection.tenant}
            product={connection.product}
            connectionDirty={connectionDirty}
          />
        )}
        <div
          className='min-w-[28rem] rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'
          onChangeCapture={() => setConnectionDirty(true)}>
          {connectionIsSAML && (
            <EditSAMLConnection
              key={`saml-${directRevision}`}
              displayHeader={false}
              displayIdpMetadata={true}
              displayInfo={!setupLinkToken && isSettingsView}
              excludeFields={
                setupLinkToken
                  ? [
                      'name',
                      'tenant',
                      'description',
                      'defaultRedirectUrl',
                      'redirectUrl',
                      'product',
                      'label',
                      'sortOrder',
                    ]
                  : fieldsToExclude
              }
              classNames={BOXYHQ_UI_CSS}
              variant='advanced'
              urls={{
                delete: apiUrl,
                patch: apiUrl,
                get: connectionFetchUrl,
              }}
              successCallback={({ operation }) => {
                operation === 'UPDATE'
                  ? successToast(t('saved'))
                  : operation === 'DELETE'
                    ? successToast(t('sso_connection_deleted_successfully'))
                    : successToast(t('copied'));
                if (operation !== 'COPY') {
                  router.replace(
                    setupLinkToken
                      ? `/setup/${setupLinkToken}/sso-connection`
                      : isSettingsView
                        ? '/admin/settings/sso-connection'
                        : '/admin/sso-connection'
                  );
                }
              }}
              errorCallback={(errMessage) => errorToast(errMessage)}
            />
          )}
          {connectionIsOIDC && (
            <EditOIDCConnection
              key={`oidc-${directRevision}`}
              displayHeader={false}
              displayInfo={!setupLinkToken && isSettingsView}
              variant='advanced'
              excludeFields={
                setupLinkToken
                  ? [
                      'name',
                      'tenant',
                      'description',
                      'defaultRedirectUrl',
                      'redirectUrl',
                      'product',
                      'oidcClientId',
                      'label',
                      'sortOrder',
                    ]
                  : fieldsToExclude
              }
              classNames={BOXYHQ_UI_CSS}
              urls={{
                delete: apiUrl,
                patch: apiUrl,
                get: connectionFetchUrl,
              }}
              successCallback={({ operation }) => {
                operation === 'UPDATE'
                  ? successToast(t('saved'))
                  : operation === 'DELETE'
                    ? successToast(t('sso_connection_deleted_successfully'))
                    : successToast(t('copied'));
                if (operation !== 'COPY') {
                  router.replace(
                    setupLinkToken
                      ? `/setup/${setupLinkToken}/sso-connection`
                      : isSettingsView
                        ? '/admin/settings/sso-connection'
                        : '/admin/sso-connection'
                  );
                }
              }}
              errorCallback={(errMessage) => errorToast(errMessage)}
            />
          )}
        </div>
        {!setupLinkToken && !isSettingsView && (
          <DirectIntegrationSettings
            connection={connection}
            dirty={connectionDirty}
            onSaved={() => setDirectRevision((revision) => revision + 1)}
          />
        )}
        {/* Public Client Settings for OIDC connections */}
        {connectionIsOIDC && !setupLinkToken && (
          <PublicClientSettings
            connectionClientId={connection.clientID}
            connectionClientSecret={connection.clientSecret}
            apiUrl={apiUrl}
            initialValue={(connection as OIDCSSORecord).oidcProvider?.publicUpstreamRedirectUri || ''}
          />
        )}
      </div>
    </>
  );
};

export default EditConnection;
