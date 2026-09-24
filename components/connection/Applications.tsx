import { useState } from 'react';
import useSWR from 'swr';
import { useTranslation } from 'next-i18next';
import { fetchInventory, type Inventory } from '@boxyhq/internal-ui';
import type { IdentityFederationApp } from '@boxyhq/saml-jackson';
import { successToast } from '@components/Toaster';

type Application = Pick<IdentityFederationApp, 'id' | 'name' | 'type' | 'tenant' | 'product' | 'tenants'>;

const Applications = ({ tenant, product }: { tenant: string; product: string }) => {
  const { t } = useTranslation('common');
  const url = `/api/admin/identity-federation?${new URLSearchParams({ inventory: 'true', product })}`;
  const { data, error, isLoading, mutate } = useSWR<Inventory<Application>>(url, fetchInventory, {
    revalidateOnFocus: false,
  });
  const [pending, setPending] = useState<string[]>([]);
  const [updateError, setUpdateError] = useState('');

  const changeMembership = async (app: Application, checked: boolean) => {
    setPending((ids) => [...ids, app.id]);
    setUpdateError('');
    try {
      const appUrl = `/api/admin/identity-federation/${encodeURIComponent(app.id)}`;
      const currentResponse = await fetch(appUrl);
      if (currentResponse.status === 404) {
        await mutate();
        setUpdateError(t('bui-fs-app-membership-deleted'));
        return;
      }
      if (!currentResponse.ok) {
        throw new Error(t('bui-fs-app-membership-error'));
      }
      const { data: current } = (await currentResponse.json()) as { data: Application };
      if (current.product !== product) {
        await mutate();
        throw new Error(t('bui-fs-app-membership-error'));
      }

      let updated = current;
      if (current.tenant !== tenant && (current.tenants || []).includes(tenant) !== checked) {
        const tenants = checked
          ? [...(current.tenants || []), tenant]
          : (current.tenants || []).filter((value) => value !== tenant);
        const response = await fetch(appUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: current.id, tenants }),
        });
        if (!response.ok) throw new Error(t('bui-fs-app-membership-error'));
        updated = (await response.json()).data;
      }

      await mutate(
        (inventory) =>
          inventory && {
            ...inventory,
            rows: inventory.rows.map((row) => (row.id === app.id ? updated : row)),
          },
        { revalidate: false }
      );
      successToast(t('saved'));
    } catch {
      setUpdateError(t('bui-fs-app-membership-error'));
    } finally {
      setPending((ids) => ids.filter((id) => id !== app.id));
    }
  };

  const apps = (data?.rows || []).filter((app) => app.product === product);

  return (
    <section
      className='mb-6 rounded border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800'
      aria-label={t('bui-fs-connection-applications')}>
      <h3 className='mb-3 font-semibold'>{t('bui-fs-connection-applications')}</h3>
      <p className='mb-3 text-sm text-gray-500'>{t('bui-fs-tenant-app-membership', { tenant, product })}</p>
      {isLoading && <p role='status'>{t('bui-fs-loading-applications')}</p>}
      {(error || (data && !data.complete)) && (
        <p role='status' className='mb-2 text-sm text-amber-700'>
          {t('bui-fs-app-inventory-unavailable')}{' '}
          <button type='button' className='underline' onClick={() => mutate()}>
            {t('bui-fs-retry-inventory')}
          </button>
        </p>
      )}
      {updateError && (
        <p role='alert' className='mb-2 text-sm text-red-600'>
          {updateError}
        </p>
      )}
      {!error && data?.complete && !apps.length && (
        <p className='text-sm'>{t('bui-fs-no-product-applications')}</p>
      )}
      <div className='max-h-64 overflow-y-auto'>
        {apps.map((app) => (
          <label
            key={app.id}
            className='flex cursor-pointer items-center gap-3 py-2'
            aria-busy={pending.includes(app.id)}>
            <input
              type='checkbox'
              className='checkbox checkbox-sm'
              checked={app.tenant === tenant || (app.tenants || []).includes(tenant)}
              disabled={pending.includes(app.id) || app.tenant === tenant}
              onChange={(event) => changeMembership(app, event.target.checked)}
            />
            <span>
              {app.name} <span className='text-xs text-gray-500'>({(app.type || 'saml').toUpperCase()})</span>
            </span>
            {app.tenant === tenant && (
              <span className='text-xs text-gray-500'>{t('bui-fs-app-primary-membership')}</span>
            )}
            {pending.includes(app.id) && (
              <span className='loading loading-spinner loading-xs' aria-hidden='true' />
            )}
          </label>
        ))}
      </div>
    </section>
  );
};

export default Applications;
