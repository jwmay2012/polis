import InformationCircleIcon from '@heroicons/react/24/outline/InformationCircleIcon';
import { useTranslation } from 'next-i18next';

export function ScopeLabel({
  field,
  context = 'connection',
  htmlFor,
}: {
  field: 'tenant' | 'product' | 'tenants';
  context?: 'connection' | 'application' | 'directory';
  htmlFor?: string;
}) {
  const { t } = useTranslation('common');
  const label =
    field === 'product'
      ? t('bui-shared-product')
      : field === 'tenant'
        ? t('bui-shared-tenant')
        : t('bui-fs-tenants');
  const help =
    field === 'tenants'
      ? t('scope_help_tenants')
      : field === 'product'
        ? context === 'directory'
          ? t('scope_help_directory_product')
          : t('scope_help_product')
        : context === 'application'
          ? t('scope_help_app_tenant')
          : context === 'directory'
            ? t('scope_help_directory_tenant')
            : t('scope_help_tenant');
  return (
    <span className='inline-flex items-center gap-1.5 text-sm'>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <span className='tooltip tooltip-bottom before:w-80 before:whitespace-normal' data-tip={help}>
        <button
          type='button'
          aria-label={`${t('scope_help_about', { field: label })}: ${help}`}
          className='inline-flex rounded text-gray-500 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary'>
          <InformationCircleIcon className='h-4 w-4' aria-hidden='true' />
        </button>
      </span>
    </span>
  );
}
