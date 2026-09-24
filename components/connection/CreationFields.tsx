import { useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'next-i18next';
import { CreateOIDCConnection, CreateSAMLConnection } from '@boxyhq/react-ui/sso';
import { BOXYHQ_UI_CSS } from '@components/styles';
import { errorToast } from '@components/Toaster';
import type { ConnectionCreationOptions, RedirectDefaults } from '@lib/connection-defaults';

const emptyRedirects: RedirectDefaults = { redirectUrl: [''], defaultRedirectUrl: '' };
const concreteUrl = (value: string) => /^https?:\/\/[^\s*]+$/.test(value);

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
  const [edited, setEdited] = useState<RedirectDefaults | null>(null);
  const suggested = options?.redirects?.find((row) => row.product === product && row.protocol === protocol);
  const redirects = edited || suggested?.defaults || emptyRedirects;
  const defaults = { tenant, product, ...redirects };
  const CreateForm = protocol === 'oidc' ? CreateOIDCConnection : CreateSAMLConnection;
  const setAllowed = (redirectUrl: string[]) => {
    const nonempty = redirectUrl.filter(Boolean);
    setEdited({
      redirectUrl,
      defaultRedirectUrl:
        nonempty.length === 1 && concreteUrl(nonempty[0]) ? nonempty[0] : redirects.defaultRedirectUrl,
    });
  };
  const defaultOptions = redirects.redirectUrl.filter(concreteUrl);
  return (
    <div
      onSubmitCapture={(event) => {
        // These locally owned fields sit beside the vendor form, so validate them before its submit handler.
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
            onChange={(e) => setTenant(e.target.value)}
            required
          />
        </label>
        <label className='mb-4 block text-sm'>
          {t('bui-shared-product')}
          <input
            id='product'
            className='input input-bordered mt-1 w-full'
            list='known-connection-products'
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            required
          />
        </label>
        <datalist id='known-connection-products'>
          {options?.products?.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <fieldset className='mb-4'>
          <legend className='text-sm'>{t('connection_allowed_redirects')}</legend>
          {redirects.redirectUrl.map((value, index) => (
            <div key={index} className='mt-2 flex gap-2'>
              <input
                id={`redirectUrl-${index}`}
                aria-label={t('connection_allowed_redirect', { number: index + 1 })}
                className='input input-bordered w-full'
                list='known-connection-redirects'
                required
                value={value}
                onChange={(e) =>
                  setAllowed(redirects.redirectUrl.map((url, i) => (i === index ? e.target.value : url)))
                }
              />
              <button
                type='button'
                className='btn btn-sm'
                disabled={redirects.redirectUrl.length === 1}
                aria-label={t('connection_remove_redirect', { number: index + 1 })}
                onClick={() => setAllowed(redirects.redirectUrl.filter((_, i) => i !== index))}>
                {t('connection_remove')}
              </button>
            </div>
          ))}
          <button
            type='button'
            className='btn btn-sm mt-2'
            onClick={() => setAllowed([...redirects.redirectUrl, ''])}>
            {t('connection_add_redirect')}
          </button>
        </fieldset>
        <datalist id='known-connection-redirects'>
          {suggested?.suggestions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <label className='mb-2 block text-sm'>
          {t('connection_default_redirect')}
          <input
            id='defaultRedirectUrl'
            className='input input-bordered mt-1 w-full'
            list='allowed-default-redirects'
            value={redirects.defaultRedirectUrl}
            onChange={(e) => setEdited({ ...redirects, defaultRedirectUrl: e.target.value })}
            required
          />
        </label>
        <datalist id='allowed-default-redirects'>
          {defaultOptions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <p className='mb-4 text-sm text-gray-500'>{t('connection_redirect_help')}</p>
        {edited && suggested?.defaults && (
          <button type='button' className='btn btn-sm mb-4' onClick={() => setEdited(null)}>
            {t('connection_use_redirect_defaults')}
          </button>
        )}
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
