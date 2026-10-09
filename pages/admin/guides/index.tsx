import Link from 'next/link';
import type { GetStaticPropsContext } from 'next';
import { useTranslation } from 'next-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

export default function Guides() {
  const { t } = useTranslation('common');
  return (
    <div className='max-w-4xl space-y-5'>
      <h1 className='text-2xl font-bold'>{t('guides')}</h1>
      <p className='text-gray-600'>{t('guides_description')}</p>
      <Link
        href='/admin/guides/enterprise-sso'
        prefetch={false}
        className='block rounded border border-gray-200 p-5 hover:border-primary'>
        <h2 className='text-lg font-semibold'>{t('guide_sso_title')}</h2>
        <p className='mt-2 text-sm text-gray-600'>{t('guide_sso_description')}</p>
      </Link>
    </div>
  );
}

export async function getStaticProps({ locale }: GetStaticPropsContext) {
  return { props: { ...(locale ? await serverSideTranslations(locale, ['common']) : {}) } };
}
