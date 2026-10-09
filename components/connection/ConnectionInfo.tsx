import { InputWithCopyButton } from '@boxyhq/internal-ui';
import type { OIDCSSORecord, SAMLSSORecord } from '@boxyhq/saml-jackson';
import { useTranslation } from 'next-i18next';

export default function ConnectionInfo({ connection }: { connection: OIDCSSORecord | SAMLSSORecord }) {
  const { t } = useTranslation('common');
  return (
    <section
      className='mb-6 space-y-3 rounded border border-gray-200 p-4'
      aria-label={t('connection_details')}>
      <InputWithCopyButton label={t('connection_id')} text={connection.clientID} />
      {'idpMetadata' in connection && (
        <>
          <p className='text-sm'>
            <span className='font-medium'>{t('connection_certificate_validity')}: </span>
            {connection.idpMetadata.validTo || t('connection_certificate_unknown')}
          </p>
          <details>
            <summary className='cursor-pointer text-sm font-medium'>{t('connection_idp_metadata')}</summary>
            <pre className='mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs'>
              {JSON.stringify(connection.idpMetadata, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
