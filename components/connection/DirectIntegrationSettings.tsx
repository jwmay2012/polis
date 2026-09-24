import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslation } from 'next-i18next';
import {
  DirectIntegration,
  directRedirects,
  unusedRedirectUrl,
  InputWithCopyButton,
  CopyToClipboardButton,
} from '@boxyhq/internal-ui';
import type { SAMLSSORecord, OIDCSSORecord } from '@boxyhq/saml-jackson';
import { errorToast, successToast } from '@components/Toaster';

export default function DirectIntegrationSettings({
  connection,
  dirty,
  onSaved,
}: {
  connection: SAMLSSORecord | OIDCSSORecord;
  dirty: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation('common');
  const { mutate } = useSWRConfig();
  const initial = Array.isArray(connection.redirectUrl)
    ? connection.redirectUrl
    : connection.redirectUrl.startsWith('[')
      ? (JSON.parse(connection.redirectUrl) as string[])
      : [connection.redirectUrl];
  const [enabled, setEnabled] = useState(initial.length > 0);
  const [values, setValues] = useState({
    redirectUrl: initial.length ? initial : [''],
    defaultRedirectUrl:
      connection.defaultRedirectUrl === unusedRedirectUrl ? '' : connection.defaultRedirectUrl,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState({
    redirectUrl: initial,
    defaultRedirectUrl: connection.defaultRedirectUrl,
  });
  const next = directRedirects(enabled, values);
  const changed = JSON.stringify(next) !== JSON.stringify(saved);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (dirty || busy || !changed) return;
        if (!enabled && saved.redirectUrl.length && !window.confirm(t('direct_disable_confirmation'))) return;
        setBusy(true);
        try {
          const response = await fetch('/api/admin/connections', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clientID: connection.clientID,
              clientSecret: connection.clientSecret,
              ...('oidcProvider' in connection ? { isOIDC: true } : { isSAML: true }),
              ...next,
            }),
          });
          if (!response.ok)
            throw new Error((await response.json()).error?.message || t('direct_save_failed'));
          setSaved(next);
          await mutate(
            `/api/admin/connections/${connection.clientID}`,
            (rows) => rows?.map((row) => ({ ...row, ...next })),
            { revalidate: false }
          );
          onSaved();
          successToast(t('saved'));
        } catch (error) {
          errorToast(error instanceof Error ? error.message : t('direct_save_failed'));
        } finally {
          setBusy(false);
        }
      }}>
      <DirectIntegration
        enabled={enabled}
        onEnabledChange={setEnabled}
        values={values}
        onChange={setValues}
        disabled={busy || dirty}
        actions={
          <>
            {dirty && <p className='my-3 text-sm text-amber-700'>{t('direct_save_connection_first')}</p>}
            <button
              type='submit'
              className='btn btn-primary btn-sm mt-3'
              disabled={busy || dirty || !changed}>
              {t('direct_save')}
            </button>
          </>
        }>
        <InputWithCopyButton label={t('direct_client_id')} text={connection.clientID} />
        <label className='block text-sm'>
          {t('direct_client_secret')}
          <span className='mt-1 flex gap-2'>
            <input
              className='input input-bordered w-full'
              type='password'
              readOnly
              value={connection.clientSecret}
            />
            <CopyToClipboardButton text={connection.clientSecret} />
          </span>
        </label>
      </DirectIntegration>
    </form>
  );
}
