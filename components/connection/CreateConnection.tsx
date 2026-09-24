import { useRouter } from 'next/router';
import type { ComponentProps } from 'react';
import useSWR from 'swr';
import { errorToast } from '@components/Toaster';
import { useTranslation } from 'next-i18next';
import { LinkBack, Loading } from '@boxyhq/internal-ui';
import { CreateSSOConnection } from '@boxyhq/react-ui/sso';
import { BOXYHQ_UI_CSS } from '@components/styles';
import { AdminPortalSSODefaults } from '@lib/utils';
import { fetcher } from '@lib/ui/utils';
import type { ConnectionCreationOptions } from '@lib/connection-defaults';
import CreationFields from './CreationFields';

const CreateConnection = ({
  isSettingsView = false,
  adminPortalSSODefaults,
}: {
  idpEntityID?: string;
  isSettingsView?: boolean;
  adminPortalSSODefaults?: AdminPortalSSODefaults;
}) => {
  const { t } = useTranslation('common');
  const router = useRouter();
  const {
    data: defaults,
    error,
    isLoading,
  } = useSWR<ConnectionCreationOptions>(isSettingsView ? null : '/api/admin/connections/defaults', fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const redirectUrl = isSettingsView ? '/admin/settings/sso-connection' : '/admin/sso-connection';

  const backUrl = redirectUrl;

  const fieldsToExclude: any = isSettingsView ? ['label', 'tenant', 'product'] : ['label'];

  if (isLoading) return <Loading />;

  const successCallback: ComponentProps<typeof CreateSSOConnection>['successCallback'] = ({ connection }) => {
    // The vendor callback passes the API's data envelope, despite its unwrapped record type.
    const clientID = (connection as { data?: { clientID?: string } })?.data?.clientID || connection?.clientID;
    router.replace(
      !isSettingsView && clientID ? `/admin/sso-connection/edit/${encodeURIComponent(clientID)}` : redirectUrl
    );
  };

  return (
    <>
      {backUrl && <LinkBack href={backUrl} />}
      <h2 className='mb-8 mt-5 font-bold text-gray-700 dark:text-white md:text-xl'>
        {t('create_sso_connection')}
      </h2>
      <div className='min-w-[28rem] rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'>
        {error && <p className='mb-3 text-sm text-amber-700'>{t('connection_default_unavailable')}</p>}
        {!isSettingsView ? (
          <CreationFields options={defaults} successCallback={successCallback} />
        ) : (
          <CreateSSOConnection
            defaults={adminPortalSSODefaults}
            variant={{ saml: 'advanced', oidc: 'advanced' }}
            urls={{
              post: '/api/admin/connections',
            }}
            excludeFields={{
              saml: fieldsToExclude,
              oidc: fieldsToExclude,
            }}
            successCallback={successCallback}
            errorCallback={(errMessage) => errorToast(errMessage)}
            classNames={BOXYHQ_UI_CSS}
          />
        )}
      </div>
    </>
  );
};

export default CreateConnection;
