import { useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'next-i18next';
import { fetchInventory, type Inventory } from '@boxyhq/internal-ui';
import type { IdentityFederationApp, PublishedRoute } from '@boxyhq/saml-jackson';

type Application = Pick<IdentityFederationApp, 'id' | 'name' | 'type' | 'tenant' | 'tenants'>;
type RoutingData = {
  draft: { matches: string[] };
  managed: { revision: string } | null;
  routes: PublishedRoute[];
  eligible: boolean;
  active: boolean;
  target: { name?: string; tenant: string };
};
type Preview = {
  match: string;
  route: PublishedRoute | null;
  owner: { id: string; name?: string; tenant: string } | null;
};

async function request<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    url,
    body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || response.statusText);
  return result;
}

function RoutingEditor({
  connectionID,
  tenant,
  app,
}: {
  connectionID: string;
  tenant: string;
  app: Application;
}) {
  const { t } = useTranslation('common');
  const url = `/api/admin/connections/${encodeURIComponent(connectionID)}/routing?${new URLSearchParams({ app: app.id })}`;
  const { data, error, mutate } = useSWR<RoutingData>(url, (url: string) => request<RoutingData>(url), {
    revalidateOnFocus: false,
  });
  const eligible = app.tenants?.length ? app.tenants.includes(tenant) : app.tenant === tenant;
  const [edited, setInput] = useState<string | null>(null);
  const input = edited ?? data?.draft.matches.join('\n') ?? '';
  const [review, setReview] = useState<Preview[] | null>(null);
  const [retire, setRetire] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('routing_error'));
    } finally {
      await mutate();
      setBusy(false);
    }
  };

  const save = async () => {
    await request(url, {
      action: 'draft',
      matches: input
        .split(/[\n,]+/)
        .map((match) => match.trim())
        .filter(Boolean),
    });
  };

  const publish = async () => {
    if (!review) return;
    const { results } = await request<{
      results: Array<{ match: string; route?: PublishedRoute; error?: string }>;
    }>(url, {
      action: 'publish',
      matches: review.map((item) => ({ match: item.match, expectedRevision: item.route?.revision ?? null })),
    });
    const messages = results.map((result) =>
      result.error
        ? `${result.match}: ${result.error}`
        : t('routing_published_match', { match: result.match })
    );
    if (retire) {
      const former = [
        ...new Set(
          review
            .map((item) => item.route?.connectionID)
            .filter((id): id is string => Boolean(id) && id !== connectionID)
        ),
      ];
      for (const previousConnectionID of former) {
        const moves = results.flatMap((result) =>
          result.route?.previousConnectionID === previousConnectionID ? [result.route] : []
        );
        if (!moves.length) continue;
        try {
          const result = await request<{ disabled: boolean; remaining?: PublishedRoute[] }>(url, {
            action: 'retire',
            previousConnectionID,
            moves,
          });
          const owner = review.find((item) => item.route?.connectionID === previousConnectionID)?.owner;
          const name = owner?.name || owner?.tenant || previousConnectionID;
          messages.push(
            result.disabled
              ? t('routing_disabled_old', { name })
              : t('routing_kept_old', {
                  name,
                  matches: result.remaining?.map((route) => route.match).join(', '),
                })
          );
        } catch (err) {
          messages.push(
            t('routing_disable_failed', { message: err instanceof Error ? err.message : t('routing_error') })
          );
        }
      }
    }
    setReview(null);
    setMessage(messages.join('\n'));
  };

  if (error)
    return (
      <p role='alert'>
        {t('routing_error')}{' '}
        <button type='button' className='underline' onClick={() => mutate()}>
          {t('bui-fs-retry-inventory')}
        </button>
      </p>
    );
  if (!data) return <p role='status'>{t('routing_loading')}</p>;
  return (
    <div>
      {!data.managed && <p className='mb-3 text-sm text-amber-700'>{t('routing_legacy')}</p>}
      {!eligible && <p className='mb-3 text-sm text-amber-700'>{t('routing_not_eligible')}</p>}
      {!data.active && <p className='mb-3 text-sm text-amber-700'>{t('routing_inactive')}</p>}
      <label className='block text-sm' htmlFor='login-matches'>
        {t('routing_matches')}
      </label>
      <textarea
        id='login-matches'
        className='textarea textarea-bordered my-2 w-full font-mono'
        rows={4}
        value={input}
        disabled={busy}
        onChange={(event) => {
          setInput(event.target.value);
          setReview(null);
        }}
      />
      <p className='mb-3 text-sm text-gray-500'>{t('routing_draft_help')}</p>
      <div className='flex gap-3'>
        <button
          type='button'
          className='btn btn-sm'
          disabled={busy}
          onClick={() =>
            run(async () => {
              await save();
              setReview(null);
              setMessage(t('saved'));
            })
          }>
          {t('routing_save_draft')}
        </button>
        <button
          type='button'
          className='btn btn-primary btn-sm'
          disabled={busy || !data.managed || !eligible || !input.trim()}
          onClick={() =>
            run(async () => {
              await save();
              setReview(
                await request<Preview[]>(url, {
                  action: 'preview',
                  matches: input
                    .split(/[\n,]+/)
                    .map((match) => match.trim())
                    .filter(Boolean),
                })
              );
            })
          }>
          {t('routing_review')}
        </button>
      </div>
      {review && (
        <div
          role='dialog'
          aria-label={t('routing_confirmation')}
          className='my-4 rounded border border-amber-300 p-4'>
          <p className='mb-2 font-semibold'>{t('routing_confirmation')}</p>
          <p className='mb-2 text-sm'>{t('routing_confirm_help')}</p>
          <p className='mb-2 text-sm'>
            {t('routing_destination')} <code>{data.target.tenant}</code>
            {data.target.name && <span className='text-gray-500'> — {data.target.name}</span>}
          </p>
          <ul className='mb-3 max-h-48 overflow-y-auto text-sm'>
            {review.map((item) => (
              <li key={item.match}>
                <code>{item.match}</code>
                {item.route && item.route.connectionID !== connectionID && (
                  <span>
                    {' '}
                    —{' '}
                    {t('routing_moves_from', {
                      name: item.owner?.name || item.route.connectionID,
                      tenant: item.owner?.tenant || '?',
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {review.some((item) => item.owner && item.owner.tenant !== tenant) && (
            <p className='mb-2 text-sm text-amber-700'>{t('routing_cross_tenant')}</p>
          )}
          {review.some((item) => item.route && item.route.connectionID !== connectionID) && (
            <label className='mb-3 flex items-start gap-2 text-sm'>
              <input
                type='checkbox'
                checked={retire}
                disabled={busy}
                onChange={(event) => setRetire(event.target.checked)}
              />
              {t('routing_retire')}
            </label>
          )}
          <div className='flex gap-3'>
            <button
              type='button'
              className='btn btn-primary btn-sm'
              disabled={busy || !eligible}
              onClick={() => run(publish)}>
              {t('routing_publish')}
            </button>
            <button type='button' className='btn btn-sm' disabled={busy} onClick={() => setReview(null)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
      {message && (
        <p role='status' className='my-3 whitespace-pre-line text-sm'>
          {message}
        </p>
      )}
      <h4 className='mb-2 mt-5 text-sm font-semibold'>{t('routing_live')}</h4>
      {!data.routes.length && <p className='text-sm text-gray-500'>{t('routing_no_routes')}</p>}
      <ul className='max-h-64 overflow-y-auto'>
        {data.routes.map((route) => (
          <li key={route.match} className='flex items-center justify-between gap-4 py-1 text-sm'>
            <code>{route.match}</code>
            <button
              type='button'
              className='underline'
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('routing_withdraw_confirmation', { match: route.match })))
                  run(async () => {
                    await request(url, {
                      action: 'withdraw',
                      match: route.match,
                      expectedRevision: route.revision,
                    });
                    setMessage(t('routing_withdrawn', { match: route.match }));
                  });
              }}>
              {t('routing_withdraw')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LoginRouting({
  connectionID,
  tenant,
  product,
}: {
  connectionID: string;
  tenant: string;
  product: string;
}) {
  const { t } = useTranslation('common');
  const [selected, setSelected] = useState('');
  const { data, error } = useSWR<Inventory<Application>>(
    `/api/admin/identity-federation?${new URLSearchParams({ inventory: 'true', product })}`,
    fetchInventory,
    { revalidateOnFocus: false }
  );
  const apps = data?.rows.filter((app) => app.type === 'oidc') || [];
  const app = apps.find((app) => app.id === selected) || apps[0];
  return (
    <section
      aria-label={t('routing_title')}
      className='mb-6 rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'>
      <h3 className='mb-3 font-semibold'>{t('routing_title')}</h3>
      {error || (data && !data.complete) ? (
        <p role='status'>{t('routing_error')}</p>
      ) : !app ? (
        <p className='text-sm text-gray-500'>{t('routing_no_apps')}</p>
      ) : (
        <>
          <label className='mb-3 block text-sm'>
            {t('routing_app')}
            <select
              className='select select-bordered ml-3'
              value={app.id}
              onChange={(event) => setSelected(event.target.value)}>
              {apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
          <RoutingEditor
            key={`${connectionID}:${app.id}`}
            connectionID={connectionID}
            tenant={tenant}
            app={app}
          />
        </>
      )}
    </section>
  );
}
