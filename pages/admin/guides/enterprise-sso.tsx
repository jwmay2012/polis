import fs from 'fs/promises';
import path from 'path';
import Head from 'next/head';
import Link from 'next/link';
import type { GetStaticPropsContext, InferGetStaticPropsType } from 'next';
import { useTranslation } from 'next-i18next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { MDXRemote } from 'next-mdx-remote';
import { serialize } from 'next-mdx-remote/serialize';
import remarkGfm from 'remark-gfm';
import { GuideFigure } from '@components/guides/GuideFigure';
import styles from '@styles/guides.module.css';

export default function EnterpriseSSOGuide({ source }: InferGetStaticPropsType<typeof getStaticProps>) {
  const { t } = useTranslation('common');
  return (
    <div className='mx-auto max-w-4xl'>
      <Head>
        <title>{t('guide_sso_title')}</title>
      </Head>
      <div className={`${styles.controls} mb-5 flex items-center justify-between gap-4`}>
        <Link href='/admin/guides' className='underline'>
          {t('guides')}
        </Link>
        <button type='button' className='btn btn-sm' onClick={() => window.print()}>
          {t('guide_print')}
        </button>
      </div>
      <article data-sso-guide className={`${styles.guide} prose prose-slate max-w-none`}>
        <MDXRemote {...source} components={{ GuideFigure }} />
      </article>
    </div>
  );
}

export async function getStaticProps({ locale }: GetStaticPropsContext) {
  const text = await fs.readFile(path.join(process.cwd(), 'components/guides/enterprise-sso.mdx'), 'utf8');
  const source = await serialize(text, { mdxOptions: { remarkPlugins: [remarkGfm] } });
  return { props: { source, ...(locale ? await serverSideTranslations(locale, ['common']) : {}) } };
}
