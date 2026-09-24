import { useRouter } from 'next/router';
import useSWR from 'swr';
import { notFound } from 'next/navigation';
import { useTranslation } from 'next-i18next';
import type { SetupLinkService } from '@boxyhq/saml-jackson';
import { LinkBack, NewSetupLink, Loading } from '@boxyhq/internal-ui';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import type { GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';

import { setupLinkExpiryDays } from '@lib/env';
import { errorToast, successToast } from '@components/Toaster';
import { fetcher } from '@lib/ui/utils';
import type { ConnectionCreationOptions } from '@lib/connection-defaults';

const serviceMap = {
  sso: 'sso-connection',
  dsync: 'directory-sync',
} as const;

const SetupLinkCreatePage = ({ expiryDays }: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const router = useRouter();
  const { t } = useTranslation('common');

  let service: SetupLinkService | null = null;

  if (router.asPath.includes('sso-connection')) {
    service = 'sso';
  } else if (router.asPath.includes('directory-sync')) {
    service = 'dsync';
  }

  const { data, error, isLoading } = useSWR<ConnectionCreationOptions>(
    service === 'sso' ? '/api/admin/connections/defaults' : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  if (!service) {
    return notFound();
  }
  if (isLoading) return <Loading />;

  return (
    <div className='space-y-4'>
      <LinkBack href={`/admin/${serviceMap[service]}/setup-link`} />
      {error && <p className='text-sm text-amber-700'>{t('connection_default_unavailable')}</p>}
      <NewSetupLink
        urls={{ createLink: '/api/admin/setup-links' }}
        service={service}
        expiryDays={expiryDays}
        productSuggestions={data}
        onCreate={() => {
          successToast(t('setup-link-created'));
        }}
        onError={(error) => errorToast(error.message)}
      />
    </div>
  );
};

export async function getServerSideProps({ locale }: GetServerSidePropsContext) {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
      expiryDays: setupLinkExpiryDays,
    },
  };
}

export default SetupLinkCreatePage;
