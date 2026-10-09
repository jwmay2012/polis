import { useState } from 'react';
import { useFormik } from 'formik';
import { Button } from 'rsc-daisyui';
import { useTranslation } from 'next-i18next';

import { Card, DirectIntegration, directRedirects, ScopeFields } from '../shared';
import type { SetupLink } from '../types';
import { defaultHeaders } from '../utils';
import { SetupLinkInfo } from './SetupLinkInfo';

interface CreateSetupLinkInput {
  name: string;
  description: string;
  tenant: string;
  product: string;
  expiryDays: number;
  service: 'sso';
  regenerate: boolean;
  redirectUrl: string[];
  defaultRedirectUrl: string;
  directIntegration: boolean;
}

export const SSOForm = ({
  urls,
  expiryDays,
  onCreate,
  onError,
  excludeFields,
  productSuggestions,
}: {
  urls: { createLink: string };
  expiryDays: number;
  onCreate: (data: SetupLink) => void;
  onError: (error: Error) => void;
  excludeFields?: 'product'[];
  productSuggestions?: { product?: string; products?: string[] };
}) => {
  const { t } = useTranslation('common');
  const [setupLink, setSetupLink] = useState<SetupLink | null>(null);
  const [reusedDifferent, setReusedDifferent] = useState(false);

  const formik = useFormik<CreateSetupLinkInput>({
    initialValues: {
      name: '',
      description: '',
      tenant: '',
      product: productSuggestions?.product || '',
      expiryDays,
      service: 'sso',
      regenerate: false,
      redirectUrl: [''],
      defaultRedirectUrl: '',
      directIntegration: false,
    },
    onSubmit: async (values) => {
      if (values.regenerate && !window.confirm(t('setup_replace_confirmation'))) return;
      const { directIntegration, ...fields } = values;
      const redirects = directRedirects(directIntegration, values);

      const rawResponse = await fetch(urls.createLink, {
        method: 'POST',
        body: JSON.stringify({ ...fields, ...redirects, redirectUrl: JSON.stringify(redirects.redirectUrl) }),
        headers: defaultHeaders,
      });

      const response = await rawResponse.json();

      if (rawResponse.ok) {
        const returned = response.data.redirectUrl;
        const returnedUrls =
          typeof returned === 'string'
            ? returned.startsWith('[')
              ? JSON.parse(returned)
              : [returned]
            : returned;
        setSetupLink(response.data);
        const differs =
          JSON.stringify(returnedUrls) !== JSON.stringify(redirects.redirectUrl) ||
          response.data.defaultRedirectUrl !== redirects.defaultRedirectUrl ||
          response.data.name !== values.name ||
          response.data.description !== values.description;
        setReusedDifferent(differs);
        if (differs) return;
        onCreate(response.data);
        formik.resetForm();
      } else {
        onError(response.error);
      }
    },
  });

  return (
    <>
      {setupLink && <SetupLinkInfo setupLink={setupLink} onClose={() => setSetupLink(null)} />}
      {reusedDifferent && (
        <p role='alert' className='my-3 text-sm text-amber-700'>
          {t('setup_reused_different')}
        </p>
      )}
      <form onSubmit={formik.handleSubmit} method='POST'>
        <Card>
          <Card.Body>
            <Card.Description>{t('bui-sl-sso-desc')}</Card.Description>
            <label className='form-control w-full'>
              <div className='label'>
                <span className='label-text'>{t('bui-sl-name')}</span>
              </div>
              <input
                type='text'
                placeholder={t('bui-sl-sso-name-placeholder')!}
                className='input input-bordered w-full text-sm'
                name='name'
                onChange={formik.handleChange}
                value={formik.values.name}
              />
            </label>
            <label className='form-control w-full'>
              <div className='label'>
                <span className='label-text'>{t('bui-sl-sso-description')}</span>
              </div>
              <input
                type='text'
                className='input input-bordered w-full text-sm'
                name='description'
                onChange={formik.handleChange}
                value={formik.values.description}
              />
            </label>
            <ScopeFields
              tenant={formik.values.tenant}
              product={formik.values.product}
              products={productSuggestions?.products}
              hideProduct={excludeFields?.includes('product')}
              onChange={(field, value) => formik.setFieldValue(field, value)}
            />
            <p className='my-3 text-sm text-gray-500'>{t('direct_federation_default')}</p>
            <DirectIntegration
              enabled={formik.values.directIntegration}
              onEnabledChange={(enabled) => formik.setFieldValue('directIntegration', enabled)}
              values={formik.values}
              onChange={(values) => formik.setValues({ ...formik.values, ...values })}
            />
            <label className='form-control w-full'>
              <div className='label'>
                <span className='label-text'>{t('bui-sl-expiry-days')}</span>
              </div>
              <input
                type='number'
                placeholder='7'
                className='input input-bordered w-full text-sm'
                name='expiryDays'
                required
                min={1}
                onChange={formik.handleChange}
                value={formik.values.expiryDays}
              />
            </label>
            <p className='my-3 text-sm text-gray-500'>{t('setup_reuse_help')}</p>
            <label className='my-3 flex items-start gap-2 text-sm'>
              <input
                type='checkbox'
                name='regenerate'
                checked={formik.values.regenerate}
                onChange={formik.handleChange}
              />
              {t('setup_replace')}
            </label>
          </Card.Body>
          <Card.Footer>
            <Button
              type='submit'
              className='btn btn-primary btn-md'
              animation={formik.isSubmitting}
              disabled={!formik.dirty || !formik.isValid}>
              {t('bui-sl-create-link')}
            </Button>
          </Card.Footer>
        </Card>
      </form>
    </>
  );
};
