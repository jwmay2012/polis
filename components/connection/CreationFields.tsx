import { useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'next-i18next';
import { CreateOIDCConnection, CreateSAMLConnection } from '@boxyhq/react-ui/sso';
import { DirectIntegration, directRedirects, type DirectRedirects } from '@boxyhq/internal-ui';
import { BOXYHQ_UI_CSS } from '@components/styles';
import { errorToast } from '@components/Toaster';
import type { ConnectionCreationOptions } from '@lib/connection-defaults';

export default function CreationFields({
  options,
  successCallback,
}: {
  options?: ConnectionCreationOptions;
  successCallback: ComponentProps<typeof CreateOIDCConnection>['successCallback'];
}) {
  const { t } = useTranslation('common');
  const fields = useRef<HTMLDivElement>(null);
  const [protocol, setProtocol] = useState<'saml' | 'oidc'>('saml');
  const [tenant, setTenant] = useState('');
  const [product, setProduct] = useState(options?.product || '');
  const [direct, setDirect] = useState(false);
  const [redirects, setRedirects] = useState<DirectRedirects>({ redirectUrl: [''], defaultRedirectUrl: '' });
  const defaults = { tenant, product, ...directRedirects(direct, redirects) };
  const CreateForm = protocol === 'oidc' ? CreateOIDCConnection : CreateSAMLConnection;
  return (
    <div
      onSubmitCapture={(event) => {
        // The common controls sit beside the vendor form; validate before its submit handler.
        for (const input of fields.current?.querySelectorAll('input') || []) {
          if (!input.reportValidity()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }}>
      <div ref={fields}>
        <fieldset className='mb-5 flex gap-4'>
          <legend className='mb-2 text-sm'>{t('connection_protocol')}</legend>
          {(['saml', 'oidc'] as const).map((value) => (
            <label key={value} className='flex items-center gap-2'>
              <input
                type='radio'
                name='connection-protocol'
                value={value}
                checked={protocol === value}
                onChange={() => setProtocol(value)}
              />
              {value.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <label className='mb-4 block text-sm'>
          {t('bui-shared-tenant')}
          <input
            id='tenant'
            className='input input-bordered mt-1 w-full'
            value={tenant}
            required
            onChange={(event) => setTenant(event.target.value)}
          />
        </label>
        <label className='mb-4 block text-sm'>
          {t('bui-shared-product')}
          <input
            id='product'
            className='input input-bordered mt-1 w-full'
            list='known-connection-products'
            value={product}
            required
            onChange={(event) => setProduct(event.target.value)}
          />
        </label>
        <datalist id='known-connection-products'>
          {options?.products?.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <p className='text-sm text-gray-500'>{t('direct_federation_default')}</p>
        <DirectIntegration
          enabled={direct}
          onEnabledChange={setDirect}
          values={redirects}
          onChange={setRedirects}
        />
        {options?.complete === false && (
          <p className='mb-4 text-sm text-amber-700'>{t('connection_suggestions_incomplete')}</p>
        )}
      </div>
      <CreateForm
        defaults={defaults}
        displayHeader={false}
        variant='advanced'
        urls={{ post: '/api/admin/connections' }}
        excludeFields={['label', 'tenant', 'product', 'redirectUrl', 'defaultRedirectUrl']}
        successCallback={successCallback}
        errorCallback={errorToast}
        classNames={BOXYHQ_UI_CSS}
      />
    </div>
  );
}
