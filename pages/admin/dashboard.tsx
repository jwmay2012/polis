import { WellKnownURLs } from '@boxyhq/internal-ui';
import type { GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { adminPortal } from '@lib/env';
import Link from 'next/link';
import { useTranslation } from 'next-i18next';

const Dashboard: NextPage<InferGetServerSidePropsType<typeof getStaticProps>> = ({
  hideIdentityFederation,
}) => {
  const { t } = useTranslation('common');
  return (
    <div className='space-y-6'>
      <section className='rounded border border-gray-200 p-5'>
        <h1 className='text-lg font-semibold'>{t('guide_sso_title')}</h1>
        <p className='my-3 text-sm text-gray-600'>{t('guide_sso_description')}</p>
        <Link href='/admin/guides/enterprise-sso' prefetch={false} className='btn btn-primary btn-sm'>
          {t('guide_get_started')}
        </Link>
      </section>
      <WellKnownURLs hideIdentityFederation={hideIdentityFederation} />
    </div>
  );
};

export async function getStaticProps({ locale }: GetServerSidePropsContext) {
  return {
    props: {
      hideIdentityFederation: adminPortal.hideIdentityFederation,
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
}

export default Dashboard;
