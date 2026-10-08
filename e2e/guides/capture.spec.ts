import path from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';

// POLIS_ADMIN_TEST_PORT=54326 POLIS_GUIDE_CAPTURE=1 npx playwright test --config playwright.guides.config.ts
// Actual UI, local memory database, synthetic customers only. Numbered callouts are DOM overlays.
async function capture(page: Page, name: string, target: Locator, callouts: Locator[]) {
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [index, locator] of callouts.entries()) {
    await locator.evaluate((node, number) => {
      const element = node as HTMLElement;
      element.setAttribute('data-guide-highlight', element.style.outline);
      element.style.outline = '2px solid #2563eb';
      const rect = element.getBoundingClientRect();
      const badge = document.createElement('span');
      badge.dataset.guideCallout = 'true';
      badge.textContent = String(number);
      Object.assign(badge.style, {
        position: 'absolute',
        top: `${rect.top + window.scrollY - 10}px`,
        left: `${rect.right + window.scrollX - 28}px`,
        zIndex: '1000',
        width: '24px',
        height: '24px',
        borderRadius: '50%',
        background: '#2563eb',
        color: 'white',
        display: 'grid',
        placeItems: 'center',
        font: 'bold 14px sans-serif',
        pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }, index + 1);
  }
  await target.screenshot({
    path: path.join(__dirname, '../../public/guides', `${name}.png`),
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.querySelectorAll('[data-guide-callout]').forEach((node) => node.remove());
    document.querySelectorAll<HTMLElement>('[data-guide-highlight]').forEach((node) => {
      node.style.outline = node.dataset.guideHighlight || '';
      node.removeAttribute('data-guide-highlight');
    });
  });
}

test('refresh guide screenshots from synthetic local UI', async ({ page, browser, baseURL }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
  );
  const api = page.request;
  const csrf = await (await api.get('/api/auth/csrf')).json();
  await api.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: csrf.csrfToken,
      email: 'admin@example.test',
      password: 'local-inventory-password',
      callbackUrl: baseURL!,
      json: 'true',
    },
  });
  const makeConnection = async (name: string, client: string) => {
    const response = await api.post('/api/admin/connections', {
      data: {
        name,
        tenant: 'example-customer',
        product: 'Example product',
        redirectUrl: [],
        defaultRedirectUrl: 'http://_boxyhq_redirect_not_in_use',
        oidcClientId: client,
        oidcClientSecret: 'synthetic-fixture',
        oidcDiscoveryUrl: 'https://idp.example.test/.well-known/openid-configuration',
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const previous = await makeConnection('Example Company — existing', 'previous-client');
  const candidate = await makeConnection('Example Company — replacement', 'replacement-client');
  const appResponse = await api.post('/api/admin/identity-federation', {
    data: {
      type: 'oidc',
      name: 'Example application',
      tenant: 'example-app',
      product: 'Example product',
      tenants: ['example-customer'],
      redirectUrl: ['https://app.example.test/callback'],
    },
  });
  expect(appResponse.status()).toBe(201);
  const { data: app } = await appResponse.json();
  const routeURL = (id: string) => `/api/admin/connections/${id}/routing?app=${app.id}`;
  const managed = await api.post(routeURL(previous.clientID), {
    data: { action: 'managed', enabled: true, expectedRevision: null },
  });
  expect(managed.ok()).toBe(true);
  const published = await api.post(routeURL(previous.clientID), {
    data: {
      action: 'publish',
      matches: [{ match: 'example.test', expectedRevision: null }],
    },
  });
  expect(published.ok()).toBe(true);

  await page.goto('/admin/sso-connection/setup-link/new');
  await page.getByLabel('Name (Optional)', { exact: true }).fill('Example Company');
  await page.getByLabel('Description (Optional)', { exact: true }).fill('Enterprise identity provider setup');
  await page.getByLabel('Tenant', { exact: true }).fill('example-customer');
  await expect(page.getByLabel('Product', { exact: true })).toHaveValue('Example product');
  await expect(page.getByRole('button', { name: 'Create Setup Link', exact: true })).toBeEnabled();
  await capture(page, 'setup-link', page.locator('main'), [
    page.getByLabel('Tenant', { exact: true }),
    page.getByLabel('Product', { exact: true }),
    page.getByRole('button', { name: 'Create Setup Link', exact: true }),
  ]);
  const created = page.waitForResponse(
    (response) => response.url().endsWith('/api/admin/setup-links') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create Setup Link', exact: true }).click();
  const { data: link } = await (await created).json();
  const token = new URL(link.url).pathname.split('/').pop();
  const customer = await browser.newContext({ baseURL, viewport: { width: 1280, height: 1500 } });
  try {
    const setup = await customer.newPage();
    await setup.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
    );
    await setup.goto(`/setup/${token}/sso-connection/new?idp=generic-oidc&step=1`);
    const callback = setup.getByLabel('Callback URL', { exact: true });
    await expect(callback).toHaveValue('https://sso.example.test/api/oauth/oidc');
    await capture(setup, 'customer-oidc', setup.locator('.prose'), [callback]);
    await setup.goto(`/setup/${token}/sso-connection/new?idp=generic-saml&step=1`);
    const acs = setup.getByLabel('Reply URL (Assertion Consumer Service URL)', { exact: true });
    const entity = setup.getByLabel('Identifier (Entity ID)', { exact: true });
    await expect(acs).toHaveValue('https://sso.example.test/api/oauth/saml');
    await capture(setup, 'customer-saml', setup.locator('.prose'), [acs, entity]);
  } finally {
    await customer.close();
  }

  await page.goto(`/admin/sso-connection/edit/${candidate.clientID}`);
  const membership = page.getByRole('region', { name: 'Applications', exact: true });
  const routing = page.getByRole('region', { name: 'Login routing', exact: true });
  await routing.getByLabel('Domains or exact email addresses').fill('pilot@example.test');
  await capture(page, 'application-membership', membership, [membership.getByRole('checkbox')]);
  await capture(page, 'pilot-routing', routing, [
    routing.getByLabel('Domains or exact email addresses'),
    routing.getByRole('button', { name: 'Review and publish', exact: true }),
  ]);
  await routing.getByRole('button', { name: 'Review and publish', exact: true }).click();
  await routing.getByRole('button', { name: 'Require SSO for these matches', exact: true }).click();
  await expect(routing.getByRole('status')).toContainText('Published pilot@example.test.');
  await routing.getByLabel('Domains or exact email addresses').fill('example.test');
  await routing.getByRole('button', { name: 'Review and publish', exact: true }).click();
  const confirmation = routing.getByRole('dialog');
  await expect(confirmation).toContainText('Example Company — existing');
  await capture(page, 'move-confirmation', confirmation, [
    confirmation.getByRole('checkbox'),
    confirmation.getByRole('button', { name: 'Require SSO for these matches', exact: true }),
  ]);
});
