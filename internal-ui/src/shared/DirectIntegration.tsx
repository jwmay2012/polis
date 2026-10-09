import type { ReactNode } from 'react';
import { useTranslation } from 'next-i18next';

export type DirectRedirects = { redirectUrl: string[]; defaultRedirectUrl: string };
// Existing Jackson marker, never an address to display as an IdP callback.
export const unusedRedirectUrl = 'http://_boxyhq_redirect_not_in_use';
export const directRedirects = (enabled: boolean, values: DirectRedirects): DirectRedirects =>
  enabled
    ? {
        redirectUrl: values.redirectUrl.map((url) => url.trim()).filter(Boolean),
        defaultRedirectUrl: values.defaultRedirectUrl,
      }
    : { redirectUrl: [], defaultRedirectUrl: unusedRedirectUrl };

export function DirectIntegration({
  enabled,
  onEnabledChange,
  values,
  onChange,
  disabled = false,
  children,
  actions,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  values: DirectRedirects;
  onChange: (values: DirectRedirects) => void;
  disabled?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation('common');
  const concrete = (value: string) => /^https?:\/\/[^\s*]+$/.test(value);
  const urls = values.redirectUrl.length ? values.redirectUrl : [''];
  const setUrls = (redirectUrl: string[]) => {
    const filled = redirectUrl.filter(Boolean);
    onChange({
      redirectUrl,
      defaultRedirectUrl: filled.length === 1 && concrete(filled[0]) ? filled[0] : values.defaultRedirectUrl,
    });
  };
  return (
    <details className='my-4 rounded border border-gray-200 p-4'>
      <summary className='cursor-pointer text-sm font-semibold'>{t('direct_advanced')}</summary>
      <p className='my-3 text-sm text-gray-500'>{t('direct_explanation')}</p>
      <label className='mb-3 flex items-center gap-2 text-sm'>
        <input
          type='checkbox'
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        {t('direct_enable')}
      </label>
      {!enabled && <p className='text-sm text-gray-500'>{t('direct_disabled')}</p>}
      {enabled && (
        <fieldset disabled={disabled} className='space-y-3'>
          <legend className='text-sm'>{t('connection_allowed_redirects')}</legend>
          {urls.map((url, index) => (
            <div className='flex gap-2' key={index}>
              <input
                aria-label={t('connection_allowed_redirect', { number: index + 1 })}
                className='input input-bordered w-full'
                value={url}
                required
                onChange={(event) =>
                  setUrls(urls.map((value, i) => (i === index ? event.target.value : value)))
                }
              />
              <button
                type='button'
                className='btn btn-sm'
                disabled={urls.length === 1}
                aria-label={t('connection_remove_redirect', { number: index + 1 })}
                onClick={() => setUrls(urls.filter((_, i) => i !== index))}>
                {t('connection_remove')}
              </button>
            </div>
          ))}
          <button type='button' className='btn btn-sm' onClick={() => setUrls([...urls, ''])}>
            {t('connection_add_redirect')}
          </button>
          <label className='block text-sm'>
            {t('connection_default_redirect')}
            <input
              className='input input-bordered mt-1 w-full'
              value={values.defaultRedirectUrl}
              required
              type='url'
              onChange={(event) => onChange({ ...values, defaultRedirectUrl: event.target.value })}
            />
          </label>
          <p className='text-sm text-gray-500'>{t('direct_default_help')}</p>
          {children}
        </fieldset>
      )}
      {actions}
    </details>
  );
}
