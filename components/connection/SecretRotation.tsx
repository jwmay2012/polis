import { useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'next-i18next';
import type { OIDCSecretRotationAction, OIDCSecretRotationStatus } from '@boxyhq/saml-jackson';

type Props = { connectionID: string; dirty: boolean; onSaved: () => void };
type Confirmation = { action: Exclude<OIDCSecretRotationAction['action'], 'stage'>; revision: string | null };

async function readStatus(url: string): Promise<OIDCSecretRotationStatus> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Unable to read secret rotation.');
  return body;
}

export default function SecretRotation({ connectionID, dirty, onSaved }: Props) {
  const { t } = useTranslation('common');
  const url = `/api/admin/connections/${encodeURIComponent(connectionID)}/secret-rotation`;
  const { data, error, mutate } = useSWR(url, readStatus, { revalidateOnFocus: false });
  const [clientSecret, setClientSecret] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [seed, setSeed] = useState<string | null | undefined>(undefined);
  if (data && data.revision !== seed) {
    setSeed(data.revision);
    setClientSecret('');
    setEmail(data.standby?.email || '');
  }

  const confirmations = {
    promote: { title: t('secret_rotation_promote'), text: t('secret_rotation_promote_confirm') },
    rollback: { title: t('secret_rotation_rollback'), text: t('secret_rotation_rollback_confirm') },
    discard: { title: t('secret_rotation_discard'), text: t('secret_rotation_discard_confirm') },
    finish: { title: t('secret_rotation_finish'), text: t('secret_rotation_finish_confirm') },
  };
  const disabled = pending || dirty || !!error;

  async function write(input: OIDCSecretRotationAction) {
    setPending(true);
    setFailure('');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || t('secret_rotation_save_error'));
      await mutate(body, { revalidate: false });
      setConfirmation(null);
      setClientSecret('');
      onSaved();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('secret_rotation_save_error'));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label={t('secret_rotation_title')}
      className='mt-6 rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'>
      <div className='mb-3 flex items-center justify-between gap-3'>
        <h3 className='font-semibold'>{t('secret_rotation_title')}</h3>
        <button type='button' className='btn btn-ghost btn-sm' disabled={pending} onClick={() => mutate()}>
          {t('secret_rotation_refresh')}
        </button>
      </div>
      <p className='mb-4 text-sm text-gray-500'>{t('secret_rotation_help')}</p>
      {error && <p role='alert'>{t('secret_rotation_read_error')}</p>}
      {failure && (
        <p role='alert' className='mb-3 text-error'>
          {failure}
        </p>
      )}
      {dirty && <p className='mb-3 text-sm text-warning'>{t('secret_rotation_dirty')}</p>}
      {data && !data.supported && <p>{t('secret_rotation_unsupported')}</p>}
      {data?.supported && (
        <>
          {!data.active && <p className='mb-3 text-sm text-warning'>{t('secret_rotation_inactive')}</p>}
          {data.standby?.role === 'pending' && (
            <div className='mb-4 space-y-2 text-sm'>
              <p>{t('secret_rotation_pilot', { email: data.standby.email })}</p>
              {data.validated ? (
                <p className='text-green-700 dark:text-green-400'>
                  {t('secret_rotation_validated', { email: data.validated.email, time: data.validated.at })}
                </p>
              ) : (
                <p>{t('secret_rotation_unproven')}</p>
              )}
              {data.last?.outcome === 'failed' && (
                <p className='text-error'>
                  {t('secret_rotation_failed', { error: data.last.error, time: data.last.at })}
                </p>
              )}
              {data.last?.outcome === 'different_account' && (
                <p className='text-warning'>
                  {t('secret_rotation_different', { email: data.last.email || '—' })}
                </p>
              )}
              {data.last?.mode === 'public' && <p>{t('secret_rotation_public')}</p>}
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  className='btn btn-primary btn-sm'
                  disabled={disabled || !data.validated}
                  onClick={() => setConfirmation({ action: 'promote', revision: data.revision })}>
                  {t('secret_rotation_promote')}
                </button>
                <button
                  type='button'
                  className='btn btn-outline btn-sm'
                  disabled={disabled}
                  onClick={() => setConfirmation({ action: 'discard', revision: data.revision })}>
                  {t('secret_rotation_discard')}
                </button>
              </div>
            </div>
          )}
          {data.standby?.role === 'previous' ? (
            <div className='space-y-3'>
              <p className='text-sm'>{t('secret_rotation_previous')}</p>
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  className='btn btn-outline btn-sm'
                  disabled={disabled}
                  onClick={() => setConfirmation({ action: 'rollback', revision: data.revision })}>
                  {t('secret_rotation_rollback')}
                </button>
                <button
                  type='button'
                  className='btn btn-primary btn-sm'
                  disabled={disabled}
                  onClick={() => setConfirmation({ action: 'finish', revision: data.revision })}>
                  {t('secret_rotation_finish')}
                </button>
              </div>
            </div>
          ) : (
            <form
              className='space-y-3'
              onSubmit={(event) => {
                event.preventDefault();
                void write({ action: 'stage', expectedRevision: data.revision, clientSecret, email });
              }}>
              <label className='form-control'>
                <span className='label-text mb-1'>{t('secret_rotation_new_secret')}</span>
                <input
                  className='input input-bordered w-full'
                  type='password'
                  autoComplete='new-password'
                  required
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </label>
              <label className='form-control'>
                <span className='label-text mb-1'>{t('secret_rotation_test_email')}</span>
                <input
                  className='input input-bordered w-full'
                  type='email'
                  autoComplete='off'
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button
                type='submit'
                className='btn btn-primary btn-sm'
                disabled={disabled || !clientSecret || !email}>
                {pending ? t('saving') : t('secret_rotation_stage')}
              </button>
            </form>
          )}
          {confirmation && (
            <div
              role='alertdialog'
              aria-label={confirmations[confirmation.action].title}
              className='mt-4 space-y-3 rounded border border-warning p-4'>
              <p>{confirmations[confirmation.action].text}</p>
              <div className='flex gap-2'>
                <button
                  type='button'
                  className='btn btn-primary btn-sm'
                  disabled={disabled}
                  onClick={() =>
                    write({ action: confirmation.action, expectedRevision: confirmation.revision })
                  }>
                  {t('secret_rotation_confirm')}
                </button>
                <button
                  type='button'
                  className='btn btn-ghost btn-sm'
                  disabled={pending}
                  onClick={() => setConfirmation(null)}>
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
