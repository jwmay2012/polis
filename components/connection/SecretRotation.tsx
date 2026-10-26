import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';
import { useTranslation } from 'next-i18next';
import type { OIDCSecretRotationAction, OIDCSecretRotationStatus } from '@boxyhq/saml-jackson';
import { ClipboardButton } from '@boxyhq/react-ui/shared';
import EyeIcon from '@heroicons/react/24/outline/EyeIcon';
import EyeSlashIcon from '@heroicons/react/24/outline/EyeSlashIcon';
import { successToast } from '@components/Toaster';

type Props = {
  connectionID: string;
  container: RefObject<HTMLDivElement | null>;
  dirty: boolean;
  onSaved: () => void;
};
type Confirmation = { action: Exclude<OIDCSecretRotationAction['action'], 'stage'>; revision: string | null };

async function readStatus(url: string): Promise<OIDCSecretRotationStatus> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Unable to read secret rotation.');
  return body;
}

export default function SecretRotation({ connectionID, container, dirty, onSaved }: Props) {
  const { t } = useTranslation('common');
  const url = `/api/admin/connections/${encodeURIComponent(connectionID)}/secret-rotation`;
  const { data, error, mutate } = useSWR(url, readStatus, { revalidateOnFocus: false });
  const [clientSecret, setClientSecret] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [seed, setSeed] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const formID = `secret-rotation-${connectionID}`;

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const target = document.createElement('div');
    // react-ui has no field slot. Use its stable input ID, including after its
    // async load/remount. Our form stays outside the vendor form's DOM.
    const attach = () => {
      const field = root.querySelector('#oidcClientSecret')?.parentElement;
      if (!field || target.previousElementSibling === field) return;
      field.after(target);
      setSlot(target);
    };
    const observer = new MutationObserver(attach);
    observer.observe(root, { childList: true, subtree: true });
    attach();
    return () => {
      observer.disconnect();
      target.remove();
    };
  }, [container]);

  if (data && data.revision !== seed) {
    if (data.standby || seed !== undefined) setExpanded(!!data.standby);
    setSeed(data.revision);
    setClientSecret(data.standby?.clientSecret || '');
    setShowSecret(false);
    setEmail(data.standby?.email || '');
  }

  const confirmations = {
    promote: { title: t('secret_rotation_promote'), text: t('secret_rotation_promote_confirm') },
    rollback: { title: t('secret_rotation_rollback'), text: t('secret_rotation_rollback_confirm') },
    discard: { title: t('secret_rotation_discard'), text: t('secret_rotation_discard_confirm') },
    finish: { title: t('secret_rotation_finish'), text: t('secret_rotation_finish_confirm') },
  };
  const disabled = pending || dirty || !!error;
  const previous = data?.standby?.role === 'previous';
  const unchanged =
    data?.standby?.role === 'pending' &&
    clientSecret === data.standby.clientSecret &&
    email.trim().toLowerCase() === data.standby.email;

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
      onSaved();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('secret_rotation_save_error'));
    } finally {
      setPending(false);
    }
  }

  const panel = (
    <section
      aria-label={t('secret_rotation_title')}
      className='mt-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900'>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className='cursor-pointer text-sm font-medium'>
          {t('secret_rotation_title')}
          {data?.standby && (
            <span className='ml-2 text-xs font-normal text-gray-500'>
              {previous ? t('secret_rotation_retained') : t('secret_rotation_trial')}
            </span>
          )}
        </summary>
        <div className='mt-3 flex justify-end'>
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
            <div className='my-3'>
              <div className='mb-1 flex items-center justify-between gap-2'>
                <label htmlFor={`${formID}-secret`} className='label-text'>
                  {previous ? t('secret_rotation_previous_secret') : t('secret_rotation_new_secret')}
                </label>
                <div className='flex items-center gap-2'>
                  <button
                    type='button'
                    title={showSecret ? t('secret_rotation_hide') : t('secret_rotation_show')}
                    aria-label={showSecret ? t('secret_rotation_hide') : t('secret_rotation_show')}
                    onClick={() => setShowSecret((shown) => !shown)}>
                    {showSecret ? <EyeSlashIcon className='h-5 w-5' /> : <EyeIcon className='h-5 w-5' />}
                  </button>
                  <ClipboardButton text={clientSecret} successCallback={() => successToast(t('copied'))} />
                </div>
              </div>
              <input
                id={`${formID}-secret`}
                form={formID}
                className='input input-bordered w-full'
                type={showSecret ? 'text' : 'password'}
                autoComplete='new-password'
                required={!previous}
                readOnly={previous}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </div>
            {previous ? (
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
              <div className='space-y-3'>
                <label className='form-control'>
                  <span className='label-text mb-1'>{t('secret_rotation_test_email')}</span>
                  <input
                    form={formID}
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
                  form={formID}
                  className='btn btn-primary btn-sm'
                  disabled={disabled || unchanged || !clientSecret || !email}>
                  {pending ? t('saving') : t('secret_rotation_stage')}
                </button>
              </div>
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
      </details>
    </section>
  );
  return (
    <form
      id={formID}
      onSubmit={(event) => {
        event.preventDefault();
        if (data && !disabled && !previous && !unchanged)
          void write({ action: 'stage', expectedRevision: data.revision, clientSecret, email });
      }}>
      {slot ? createPortal(panel, slot) : panel}
    </form>
  );
}
