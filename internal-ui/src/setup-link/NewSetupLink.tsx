import { useTranslation } from 'next-i18next';

import { SSOForm } from './SSOForm';
import { PageHeader } from '../shared';
import { DSyncForm } from './DSyncForm';
import type { SetupLinkService, SetupLink } from '../types';

export const NewSetupLink = ({
  urls,
  service,
  expiryDays,
  onCreate,
  onError,
  excludeFields,
  productSuggestions,
}: {
  urls: { createLink: string };
  service: SetupLinkService;
  expiryDays: number;
  onCreate: (data: SetupLink) => void;
  onError: (error: Error) => void;
  excludeFields?: 'product'[];
  productSuggestions?: { product?: string; products?: string[] };
}) => {
  const { t } = useTranslation('common');

  return (
    <>
      {service === 'sso' ? (
        <>
          <PageHeader title={t('bui-sl-create-link')} />
          <SSOForm
            urls={urls}
            expiryDays={expiryDays}
            onCreate={onCreate}
            onError={onError}
            excludeFields={excludeFields}
            productSuggestions={productSuggestions}
          />
        </>
      ) : (
        <>
          <PageHeader title={t('bui-sl-create-link')} />
          <DSyncForm
            urls={urls}
            expiryDays={expiryDays}
            onCreate={onCreate}
            onError={onError}
            excludeFields={excludeFields}
          />
        </>
      )}
    </>
  );
};
