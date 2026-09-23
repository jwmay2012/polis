const inventoryPageCap = 100;

type Page<T> = { data: T[]; pageToken?: string };
type Pagination = { pageOffset: number; pageLimit: number; pageToken?: string };

// This is an admin inventory, not a snapshot. Only a finished scan can establish absence.
// Admin routes use the configured engine; custom drivers without one must support offsets.
export async function collectInventory<T, R extends { id: string }>(
  readPage: (pagination: Pagination) => Promise<Page<T>>,
  project: (record: T) => R,
  cursorOnly = false
): Promise<{ data: R[]; complete: boolean }> {
  const rows = new Map<string, R>();
  const tokens = new Set<string>();
  let pageOffset = 0;
  let pageToken: string | undefined;
  let complete = false;

  for (let page = 0; page < inventoryPageCap; page++) {
    const result = await readPage({ pageOffset, pageLimit: 50, pageToken });
    for (const record of result.data) {
      const row = project(record);
      rows.set(row.id, row);
    }

    if (cursorOnly) {
      if (!result.pageToken) {
        complete = true;
        break;
      }
      if (tokens.has(result.pageToken)) break;
      tokens.add(result.pageToken);
      pageToken = result.pageToken;
    } else {
      if (!result.data.length) {
        complete = true;
        break;
      }
      pageOffset += result.data.length;
    }
  }

  return { data: Array.from(rows.values()), complete };
}
