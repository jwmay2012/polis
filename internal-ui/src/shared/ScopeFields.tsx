import { useId } from 'react';
import { ScopeLabel } from './ScopeLabel';
import { ProductInput } from './ProductInput';

export function ScopeFields({
  tenant,
  product,
  onChange,
  products,
  hideProduct = false,
  directory = false,
}: {
  tenant: string;
  product: string;
  onChange?: (field: 'tenant' | 'product', value: string) => void;
  products?: string[];
  hideProduct?: boolean;
  directory?: boolean;
}) {
  const id = useId();
  const context = directory ? 'directory' : 'connection';
  return (
    <div className='mb-4 space-y-4'>
      <div>
        <ScopeLabel field='tenant' context={context} htmlFor={`${id}-tenant`} />
        <input
          id={`${id}-tenant`}
          name='tenant'
          className={`input input-bordered mt-1 w-full text-sm ${onChange ? '' : 'bg-gray-100'}`}
          value={tenant}
          readOnly={!onChange}
          required={!!onChange}
          onChange={(event) => onChange?.('tenant', event.target.value)}
        />
      </div>
      {!hideProduct && (
        <div>
          <ScopeLabel field='product' context={context} htmlFor={`${id}-product`} />
          <ProductInput
            id={`${id}-product`}
            value={product}
            readOnly={!onChange}
            products={products}
            onChange={(value) => onChange?.('product', value)}
          />
        </div>
      )}
    </div>
  );
}
