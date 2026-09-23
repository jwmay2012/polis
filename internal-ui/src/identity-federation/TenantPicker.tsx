import { useId, useState } from 'react';
import useSWR from 'swr';
import TagsInput from 'react-tagsinput';
import { useTranslation } from 'next-i18next';
import XMarkIcon from '@heroicons/react/24/outline/XMarkIcon';
import LockClosedIcon from '@heroicons/react/24/outline/LockClosedIcon';
import ExclamationTriangleIcon from '@heroicons/react/24/outline/ExclamationTriangleIcon';
import { addQueryParamsToPath } from '../utils';
import { fetchInventory, type Inventory } from './inventory';

type Connection = { id: string; name?: string; tenant: string; product: string; active: boolean };

export const TenantPicker = ({
  value,
  onChange,
  primaryTenant,
  product,
  connectionsUrl,
}: {
  value: string[];
  onChange: (tenants: string[]) => void;
  primaryTenant: string;
  product: string;
  connectionsUrl?: string;
}) => {
  const { t } = useTranslation('common');
  const id = useId();
  const [search, setSearch] = useState('');
  const url =
    connectionsUrl && product ? addQueryParamsToPath(connectionsUrl, { inventory: 'true', product }) : null;
  const { data, error, isLoading, mutate } = useSWR<Inventory<Connection>>(url, fetchInventory, {
    revalidateOnFocus: false,
  });
  const complete = !!url && !!data?.complete && !error;
  const selected = [...new Set([...(primaryTenant ? [primaryTenant] : []), ...value])];
  const change = (tenants: string[]) => onChange(tenants.filter((tenant) => tenant !== primaryTenant));
  const tenants = new Map<string, { names: Set<string>; active: number; total: number }>();

  if (url && data) {
    for (const connection of data.rows) {
      if (connection.product !== product) continue;
      const tenant = tenants.get(connection.tenant) || { names: new Set<string>(), active: 0, total: 0 };
      if (connection.name) tenant.names.add(connection.name);
      tenant.total++;
      if (connection.active) tenant.active++;
      tenants.set(connection.tenant, tenant);
    }
  }

  const label = (tenant: string) => {
    const names = Array.from(tenants.get(tenant)?.names || [])
      .sort()
      .join(', ');
    return names ? `${names} (${tenant})` : tenant;
  };
  const query = search.trim().toLowerCase();
  const choices = Array.from(tenants.keys())
    .sort()
    .filter((tenant) => label(tenant).toLowerCase().includes(query));

  return (
    <fieldset className='form-control w-full tenant-picker'>
      <legend className='label'>{t('bui-fs-tenants')}</legend>
      <TagsInput
        value={selected}
        onChange={change}
        onlyUnique={true}
        addOnBlur={true}
        focusedClassName='input-focused'
        inputProps={{
          id: `${id}-add`,
          placeholder: t('bui-fs-enter-tenant'),
          'aria-label': t('bui-fs-enter-tenant'),
          autoComplete: 'off',
        }}
        renderTag={({ tag, key, className, onRemove }) => {
          const primary = tag === primaryTenant;
          const known = tenants.get(tag);
          return (
            <span key={key} className={className}>
              <span>{label(tag)}</span>
              {complete && known && (
                <span className='ml-1 text-xs'>{t('bui-fs-connection-count', known)}</span>
              )}
              {primary ? (
                <span
                  className='ml-1 inline-flex'
                  role='img'
                  aria-label={t('bui-fs-primary-tenant')}
                  title={t('bui-fs-primary-tenant')}>
                  <LockClosedIcon className='h-3 w-3' />
                </span>
              ) : (
                <>
                  {complete && !known && (
                    <span
                      className='ml-1 inline-flex text-amber-600'
                      role='img'
                      aria-label={t('bui-fs-unmatched-tenant')}
                      title={t('bui-fs-unmatched-tenant')}>
                      <ExclamationTriangleIcon className='h-3 w-3' />
                    </span>
                  )}
                  <button
                    type='button'
                    className='ml-1 inline-flex'
                    aria-label={t('bui-fs-remove-tenant', { tenant: tag })}
                    onClick={() => onRemove(key)}>
                    <XMarkIcon className='h-3 w-3' />
                  </button>
                </>
              )}
            </span>
          );
        }}
      />
      <p className='mt-1 text-xs text-gray-500'>{t('bui-fs-tenants-mapping-desc')}</p>
      {connectionsUrl && !product && <p className='mt-2 text-sm'>{t('bui-fs-product-for-tenants')}</p>}
      {url && (
        <div className='mt-3'>
          <label htmlFor={`${id}-search`} className='label'>
            {t('bui-fs-search-tenants')}
          </label>
          <input
            id={`${id}-search`}
            type='search'
            className='input input-bordered input-sm w-full'
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {isLoading && (
            <p role='status' className='mt-2 text-sm'>
              {t('bui-fs-loading-inventory')}
            </p>
          )}
          {(error || (data && !data.complete)) && (
            <p role='status' className='mt-2 text-sm text-amber-700'>
              {t('bui-fs-inventory-unavailable')}{' '}
              <button type='button' className='underline' onClick={() => mutate()}>
                {t('bui-fs-retry-inventory')}
              </button>
            </p>
          )}
          <div className='mt-2 max-h-48 overflow-y-auto' role='group' aria-label={t('bui-fs-known-tenants')}>
            {choices.map((tenant) => (
              <label key={tenant} className='flex cursor-pointer items-center gap-2 py-1 text-sm'>
                <input
                  type='checkbox'
                  className='checkbox checkbox-sm'
                  checked={selected.includes(tenant)}
                  disabled={tenant === primaryTenant}
                  onChange={(event) =>
                    change(
                      event.target.checked
                        ? [...selected, tenant]
                        : selected.filter((item) => item !== tenant)
                    )
                  }
                />
                <span className='break-all'>{label(tenant)}</span>
                {complete && (
                  <span className='text-xs text-gray-500'>
                    {t('bui-fs-connection-count', tenants.get(tenant)!)}
                  </span>
                )}
              </label>
            ))}
            {complete && !choices.length && (
              <p className='py-1 text-sm text-gray-500'>{t('bui-fs-no-matching-tenants')}</p>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
};
