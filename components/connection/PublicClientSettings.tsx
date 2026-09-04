import { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { errorToast, successToast } from '@components/Toaster';

type PublicClientSettingsProps = {
  connectionClientId: string;
  connectionClientSecret: string;
  apiUrl: string;
  initialValue?: string;
};

const PublicClientSettings = ({
  connectionClientId,
  connectionClientSecret,
  apiUrl,
  initialValue = '',
}: PublicClientSettingsProps) => {
  const { t } = useTranslation('common');
  const [publicUpstreamRedirectUri, setPublicUpstreamRedirectUri] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed the field when the connection loads a different stored value;
  // adjusting state during render avoids a setState-in-effect round trip.
  const [seededFrom, setSeededFrom] = useState(initialValue);
  if (initialValue !== seededFrom) {
    setSeededFrom(initialValue);
    setPublicUpstreamRedirectUri(initialValue);
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(apiUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientID: connectionClientId,
          clientSecret: connectionClientSecret,
          oidcPublicUpstreamRedirectUri: publicUpstreamRedirectUri || null,
          isOIDC: true, // Required for API to recognize this as an OIDC update
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to save');
      }

      successToast(t('saved'));
    } catch (error: any) {
      errorToast(error.message || t('error_saving_public_client_settings'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className='mt-6 rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'>
      <h3 className='mb-4 font-semibold text-gray-700 dark:text-white'>
        {t('public_client_settings_title')}
      </h3>
      <p className='mb-4 text-sm text-gray-500 dark:text-gray-400'>
        {t('public_client_settings_description')}
      </p>
      <div className='mb-4'>
        <label
          htmlFor='publicUpstreamRedirectUri'
          className='mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300'>
          {t('public_upstream_redirect_uri')}
        </label>
        <input
          type='text'
          id='publicUpstreamRedirectUri'
          value={publicUpstreamRedirectUri}
          onChange={(e) => setPublicUpstreamRedirectUri(e.target.value)}
          placeholder='https://sso.example.com/api/oauth/oidc?client=mobile'
          className='w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white'
        />
        <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
          {t('public_upstream_redirect_uri_hint')}
        </p>
      </div>
      <button
        type='button'
        onClick={handleSave}
        disabled={isSaving}
        className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50'>
        {isSaving ? t('saving') : t('save_public_client_settings')}
      </button>
    </div>
  );
};

export default PublicClientSettings;
