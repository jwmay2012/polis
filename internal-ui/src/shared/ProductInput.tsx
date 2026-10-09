import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import ChevronDownIcon from '@heroicons/react/24/outline/ChevronDownIcon';

// An editable product key, with an explicit menu that also shows the current selection.
export function ProductInput({
  id,
  value,
  onChange,
  products,
  readOnly = false,
}: {
  id: string;
  value: string;
  onChange?: (value: string) => void;
  products?: string[];
  readOnly?: boolean;
}) {
  const { t } = useTranslation('common');
  const listID = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const choices = products || [];
  const suggestions = !readOnly && products !== undefined;
  const options = choices.filter((product) => product.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (open && active >= 0)
      list.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  const choose = (product: string) => {
    onChange?.(product);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };
  return (
    <div
      className='relative mt-1'
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
      <input
        ref={input}
        id={id}
        name='product'
        className={`input input-bordered w-full pr-12 text-sm ${readOnly ? 'bg-gray-100' : ''}`}
        value={value}
        readOnly={readOnly}
        required={!readOnly}
        autoComplete='off'
        role={suggestions ? 'combobox' : undefined}
        aria-autocomplete={suggestions ? 'list' : undefined}
        aria-expanded={suggestions ? open : undefined}
        aria-controls={suggestions ? listID : undefined}
        aria-activedescendant={open && active >= 0 ? `${listID}-${active}` : undefined}
        onChange={(event) => {
          onChange?.(event.target.value);
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!suggestions) return;
          if (event.key === 'Escape' || event.key === 'Tab') setOpen(false);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              setQuery('');
              setOpen(true);
              setActive(choices.length ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : -1);
            } else {
              setActive((index) =>
                !options.length
                  ? -1
                  : index < 0
                    ? event.key === 'ArrowDown'
                      ? 0
                      : options.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
              );
            }
          }
          if (event.key === 'Enter' && open && options[active]) {
            event.preventDefault();
            choose(options[active]);
          }
        }}
      />
      {suggestions && (
        <button
          type='button'
          className='absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r hover:bg-base-200'
          aria-label={t('product_choose_known')}
          aria-expanded={open}
          aria-controls={listID}
          onClick={() => {
            setQuery('');
            setActive(-1);
            setOpen(!open);
            input.current?.focus();
          }}>
          <ChevronDownIcon className='h-4 w-4' aria-hidden='true' />
        </button>
      )}
      {open && suggestions && (
        <ul
          ref={list}
          id={listID}
          role='listbox'
          aria-label={t('product_known')}
          className='absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded border border-base-300 bg-base-100 p-1 shadow-lg'>
          {options.map((product, index) => (
            <li key={product} role='presentation'>
              <button
                id={`${listID}-${index}`}
                type='button'
                role='option'
                aria-selected={product === value}
                tabIndex={-1}
                className={`w-full rounded px-3 py-2 text-left text-sm hover:bg-base-200 ${active === index ? 'bg-base-200' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(product)}>
                {product}
              </button>
            </li>
          ))}
          {!options.length && (
            <li role='presentation' className='px-3 py-2 text-sm text-gray-500'>
              {t('product_enter_custom')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
