export type Inventory<T> = { rows: T[]; complete: boolean };

export async function fetchInventory<T>(url: string): Promise<Inventory<T>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load inventory (${response.status}).`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(rows)) throw new Error('Invalid inventory response.');
  return { rows, complete: response.headers.get('jackson-inventory-complete') === 'true' };
}
