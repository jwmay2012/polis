import { randomUUID } from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { getRawMetadata } from '../api/helpers/sso';

const product = () => `admin-test-${randomUUID()}`;

async function createConnection(
  request: APIRequestContext,
  origin: string,
  tenant: string,
  product: string,
  name = tenant
) {
  const response = await request.post('/api/admin/connections', {
    data: {
      tenant,
      product,
      name,
      defaultRedirectUrl: `${origin}/callback`,
      redirectUrl: [origin],
      rawMetadata: getRawMetadata(`${origin}/fixture/${randomUUID()}`)
        .split('https://mocksaml.com/api/saml/sso')
        .join(`${origin}/fixture/sso`),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).data;
}

async function createApp(
  request: APIRequestContext,
  origin: string,
  tenant: string,
  product: string,
  tenants: string[] = [],
  name = 'Example app'
) {
  const response = await request.post('/api/admin/identity-federation', {
    data: { type: 'oidc', name, tenant, product, tenants, redirectUrl: [`${origin}/callback`] },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).data;
}

async function readApp(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/admin/identity-federation/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
  );
  const csrf = await page.request.get('/api/auth/csrf');
  const response = await page.request.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: (await csrf.json()).csrfToken,
      email: 'admin@example.test',
      password: 'local-inventory-password',
      callbackUrl: baseURL!,
      json: 'true',
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const session = await page.request.get('/api/auth/session');
  expect((await session.json()).user.email).toBe('admin@example.test');
});

test('admin inventory requires an admin session, not an API key', async ({ request }) => {
  for (const endpoint of ['connections', 'identity-federation']) {
    const response = await request.get(`/api/admin/${endpoint}?inventory=true&product=example`, {
      headers: { Authorization: 'Api-Key local-inventory-api-key' },
    });
    expect(response.status()).toBe(401);
  }
});

for (const inventory of ['connections', 'identity-federation']) {
  test(`${inventory} inventory does not rescan on window focus`, async ({ page, baseURL }) => {
    const scope = product();
    const connection = await createConnection(page.request, baseURL!, 'customer.example.test', scope);
    const app = await createApp(page.request, baseURL!, 'owner.example.test', scope);
    let scans = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/admin/${inventory}` && url.searchParams.get('inventory') === 'true') scans++;
    });
    await page.clock.install();
    await page.goto(
      inventory === 'connections'
        ? `/admin/identity-federation/${app.id}/edit`
        : `/admin/sso-connection/edit/${connection.clientID}`
    );
    await expect(
      page.getByRole('checkbox', {
        name: inventory === 'connections' ? /customer.example.test/ : /Example app/,
      })
    ).toBeVisible();
    expect(scans).toBe(1);
    await page.clock.runFor(6_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.clock.runFor(1_000);
    expect(scans).toBe(1);
  });
}

test('Edit shows complete tenant inventory, preserves unknown keys and scrolls long selections', async ({
  page,
  baseURL,
}, info) => {
  const scope = product();
  const tenants: string[] = [];
  for (let index = 0; index < 54; index++) {
    const tenant = index < 2 ? 'north.example.test' : `tenant-${index}.example.test`;
    const connection = await createConnection(
      page.request,
      baseURL!,
      tenant,
      scope,
      index < 3 ? 'Shared name' : `Customer connection ${index}`
    );
    if (index === 1 || index === 2) {
      expect(
        (
          await page.request.patch('/api/admin/connections', {
            data: {
              clientID: connection.clientID,
              clientSecret: connection.clientSecret,
              isSAML: true,
              deactivated: true,
            },
          })
        ).ok()
      ).toBe(true);
    }
    tenants.push(tenant);
  }
  const app = await createApp(page.request, baseURL!, 'owner.example.test', scope, [
    ...new Set(tenants),
    'future.example.test',
    'NORTH.EXAMPLE.TEST',
  ]);
  await page.goto(`/admin/identity-federation/${app.id}/edit`);
  const picker = page.locator('.tenant-picker');
  await expect(picker.getByRole('checkbox', { name: /tenant-53\.example\.test/ })).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: /north\.example\.test/ })).toHaveAccessibleName(
    /1 active \/ 2 connections/
  );
  await expect(picker.getByRole('checkbox', { name: /tenant-2\.example\.test/ })).toHaveAccessibleName(
    /0 active \/ 1 connections/
  );
  await expect(picker.getByRole('img', { name: /No connection for this product/ })).toHaveCount(2);
  await expect(picker.getByRole('button', { name: 'Remove tenant owner.example.test' })).toHaveCount(0);
  const tags = picker.locator('.react-tagsinput');
  expect(await tags.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await picker.getByRole('button', { name: 'Remove tenant future.example.test' }).scrollIntoViewIfNeeded();
  await expect(picker.getByRole('button', { name: 'Remove tenant future.example.test' })).toBeVisible();
  await page.locator('input[name="name"]').fill('Renamed app');
  await page
    .locator('form')
    .filter({ has: page.locator('input[name="name"]') })
    .getByRole('button', { name: 'Save Changes' })
    .click();
  await expect.poll(async () => (await readApp(page.request, app.id)).name).toBe('Renamed app');
  const saved = await readApp(page.request, app.id);
  expect(saved.tenants).toContain('future.example.test');
  expect(saved.tenants).toContain('NORTH.EXAMPLE.TEST');
  expect(saved.tenants[0]).toBe('owner.example.test');
  await page.screenshot({ path: info.outputPath('tenant-picker.png'), fullPage: true });
});

test('primary tenant survives Backspace and New derives it without retaining an old primary', async ({
  page,
  baseURL,
}) => {
  const scope = product();
  await createConnection(page.request, baseURL!, 'known.example.test', scope, 'Known customer');
  const app = await createApp(page.request, baseURL!, 'owner.example.test', scope);
  await page.goto(`/admin/identity-federation/${app.id}/edit`);
  let picker = page.locator('.tenant-picker');
  await picker.getByRole('textbox', { name: 'Enter tenant', exact: true }).press('Backspace');
  await expect(picker.locator('.react-tagsinput-tag').filter({ hasText: 'owner.example.test' })).toHaveCount(
    1
  );
  await page.goto('/admin/identity-federation/new');
  await page.getByLabel('OIDC', { exact: true }).check();
  await page.locator('input[name="name"]').fill('New app');
  await page.locator('input[name="tenant"]').fill('old-owner.example.test');
  await page.locator('input[name="product"]').fill(scope);
  await page.locator('input[name="product"]').blur();
  picker = page.locator('.tenant-picker');
  await picker.getByRole('checkbox', { name: /Known customer/ }).check();
  await page.locator('input[name="tenant"]').fill('new-owner.example.test');
  await expect(
    picker.locator('.react-tagsinput-tag').filter({ hasText: 'old-owner.example.test' })
  ).toHaveCount(0);
  await expect(
    picker.locator('.react-tagsinput-tag').filter({ hasText: 'new-owner.example.test' })
  ).toHaveCount(1);
  await page.locator('input[name="item"]').fill(`${baseURL}/callback`);
  await page.getByRole('button', { name: 'Create App', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/identity-federation\/.*\/edit$/);
  const id = new URL(page.url()).pathname.split('/').at(-2)!;
  expect((await readApp(page.request, id)).tenants).toEqual(['new-owner.example.test', 'known.example.test']);
});

test('partial/error inventories withhold missing markers and product changes replace suggestions', async ({
  page,
  baseURL,
}) => {
  const first = product();
  const second = product();
  await createConnection(page.request, baseURL!, 'first.example.test', first, 'First customer');
  await createConnection(page.request, baseURL!, 'second.example.test', second, 'Second customer');
  await page.goto('/admin/identity-federation/new');
  await page.locator('input[name="product"]').fill(first);
  await page.locator('input[name="product"]').blur();
  const picker = page.locator('.tenant-picker');
  await expect(picker.getByRole('checkbox', { name: /First customer/ })).toBeVisible();
  await picker.getByRole('textbox', { name: 'Enter tenant', exact: true }).fill('future.example.test');
  await picker.getByRole('textbox', { name: 'Enter tenant', exact: true }).press('Enter');
  await expect(picker.getByRole('img', { name: /No connection for this product/ })).toHaveCount(1);
  await page.route('**/api/admin/connections?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('inventory') !== 'true') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'jackson-inventory-complete': 'false' },
    });
  });
  await page.locator('input[name="product"]').fill(second);
  await page.locator('input[name="product"]').blur();
  await expect(picker.getByRole('checkbox', { name: /Second customer/ })).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: /First customer/ })).toHaveCount(0);
  await expect(picker.getByRole('img', { name: /No connection for this product/ })).toHaveCount(0);
  await expect(picker.getByText('The full inventory is unavailable.', { exact: false })).toBeVisible();
  await expect(picker.locator('.react-tagsinput-tag').filter({ hasText: 'future.example.test' })).toHaveCount(
    1
  );
  await page.route('**/api/admin/connections?**', (route) =>
    route.fulfill({ status: 503, json: { error: { message: 'fixture unavailable' } } })
  );
  await picker.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(picker.getByRole('img', { name: /No connection for this product/ })).toHaveCount(0);
  await page.route('**/api/admin/connections?**', (route) => route.fulfill({ status: 200, json: [] }));
  await picker.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(picker.getByRole('checkbox')).toHaveCount(0);
  await expect(picker.getByText('The full inventory is unavailable.', { exact: false })).toBeVisible();
  await expect(picker.getByRole('img', { name: /No connection for this product/ })).toHaveCount(0);
});

test('Applications reads latest tenants, preserves other settings and handles failed updates', async ({
  page,
  baseURL,
}, info) => {
  const scope = product();
  const connection = await createConnection(page.request, baseURL!, 'customer.example.test', scope);
  const app = await createApp(page.request, baseURL!, 'app-owner.example.test', scope, [], 'Target app');
  await createApp(page.request, baseURL!, connection.tenant, scope, [], 'Primary app');
  await createApp(page.request, baseURL!, 'other.example.test', product(), [], 'Other product app');
  await page.goto(`/admin/sso-connection/edit/${connection.clientID}`);
  const panel = page.getByRole('region', { name: 'Applications', exact: true });
  const checkbox = panel.getByRole('checkbox', { name: /Target app/ });
  await expect(checkbox).not.toBeChecked();
  await expect(panel.getByRole('checkbox', { name: /Primary app/ })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: /Primary app/ })).toBeDisabled();
  await expect(panel.getByText('Other product app', { exact: false })).toHaveCount(0);
  await page.request.patch(`/api/admin/identity-federation/${app.id}`, {
    data: { id: app.id, tenants: ['intervening.example.test'], name: 'Updated elsewhere' },
  });
  const patch = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith(app.id)
  );
  await checkbox.click();
  expect(Object.keys((await patch).postDataJSON()).sort()).toEqual(['id', 'tenants']);
  const changed = panel.getByRole('checkbox', { name: /Updated elsewhere/ });
  await expect(changed).toBeChecked();
  const updated = await readApp(page.request, app.id);
  expect(updated.tenants).toEqual(['app-owner.example.test', 'intervening.example.test', connection.tenant]);
  expect(updated.redirectUrl).toEqual([`${baseURL}/callback`]);
  await page.route(`**/api/admin/identity-federation/${app.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, json: { error: { message: 'fixture update failure' } } })
      : route.continue()
  );
  await changed.click();
  await expect(panel.getByRole('alert')).toContainText('Unable to update application membership');
  await expect(changed).toBeChecked();
  await expect(changed).toBeEnabled();
  await page.unroute(`**/api/admin/identity-federation/${app.id}`);
  await changed.click();
  await expect(changed).not.toBeChecked();
  expect((await readApp(page.request, app.id)).tenants).toEqual([
    'app-owner.example.test',
    'intervening.example.test',
  ]);
  await panel.screenshot({ path: info.outputPath('applications-panel.png') });
});

test('Applications avoids redundant writes and refreshes a deleted app', async ({ page, baseURL }) => {
  const scope = product();
  const connection = await createConnection(page.request, baseURL!, 'customer.example.test', scope);
  const app = await createApp(page.request, baseURL!, 'owner.example.test', scope, [], 'Changing app');
  await page.goto(`/admin/sso-connection/edit/${connection.clientID}`);
  const panel = page.getByRole('region', { name: 'Applications', exact: true });
  const checkbox = panel.getByRole('checkbox', { name: /Changing app/ });
  await expect(checkbox).not.toBeChecked();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith(app.id)) writes++;
  });
  await page.request.patch(`/api/admin/identity-federation/${app.id}`, {
    data: { id: app.id, tenants: [connection.tenant] },
  });
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  expect(writes).toBe(0);
  expect((await page.request.delete(`/api/admin/identity-federation/${app.id}`)).ok()).toBe(true);
  await checkbox.click();
  await expect(checkbox).toHaveCount(0);
  await expect(panel.getByRole('alert')).toHaveText('That application no longer exists.');
  expect(writes).toBe(0);
  await expect(page.getByLabel('Connection name (Optional)', { exact: true })).toBeEnabled();
});

test('setup-link and portal SSO settings editors never request the Applications inventory', async ({
  page,
  baseURL,
}) => {
  const scope = product();
  const connection = await createConnection(page.request, baseURL!, 'customer.example.test', scope);
  const response = await page.request.post('/api/admin/setup-links', {
    data: {
      service: 'sso',
      tenant: connection.tenant,
      product: scope,
      defaultRedirectUrl: `${baseURL}/callback`,
      redirectUrl: [baseURL],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { data: setupLink } = await response.json();
  const system = await createConnection(page.request, baseURL!, '_jackson_boxyhq', '_jackson_admin_portal');
  let inventoryRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/admin/identity-federation?')) inventoryRequests++;
  });
  for (const path of [
    `${setupLink.url}/sso-connection/edit/${connection.clientID}`,
    `/admin/settings/sso-connection/edit/${system.clientID}`,
  ]) {
    await page.goto(path);
    await expect(page.getByLabel('Raw IdP XML', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Applications', exact: true })).toHaveCount(0);
  }
  expect(inventoryRequests).toBe(0);
});

test('normal admin creation opens the connection editor and its Applications panel', async ({
  page,
  baseURL,
}) => {
  const scope = product();
  await createApp(page.request, baseURL!, 'owner.example.test', scope);
  await page.goto('/admin/sso-connection/new');
  await page.getByLabel('Connection name (Optional)', { exact: true }).fill('New customer connection');
  await page.getByLabel('Tenant', { exact: true }).fill('new-customer.example.test');
  await page.getByLabel('Product', { exact: true }).fill(scope);
  await page
    .getByRole('group')
    .filter({ hasText: 'Allowed redirect URLs' })
    .getByRole('textbox')
    .first()
    .fill(baseURL!);
  await page.getByLabel('Default redirect URL', { exact: true }).fill(`${baseURL}/callback`);
  await page
    .getByLabel('Raw IdP XML', { exact: true })
    .fill(
      getRawMetadata(`${baseURL}/fixture/${randomUUID()}`)
        .split('https://mocksaml.com/api/saml/sso')
        .join(`${baseURL}/fixture/sso`)
    );
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page).toHaveURL(/\/admin\/sso-connection\/edit\//);
  await expect(page.getByRole('region', { name: 'Applications', exact: true })).toBeVisible();
});
