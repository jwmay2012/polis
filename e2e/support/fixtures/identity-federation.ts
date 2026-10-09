import { Locator, expect, type Page } from '@playwright/test';

export class IdentityFederationPage {
  public readonly TENANT = 'acme.com';
  public readonly PRODUCT = '_jackson_admin_portal';
  private readonly editButton: Locator;
  private readonly acsUrlInput: Locator;
  readonly ENTITY_ID = 'https://saml.boxyhq.com';
  constructor(public readonly page: Page) {
    this.editButton = this.page.getByRole('cell', { name: 'Edit' }).getByRole('button');
    this.acsUrlInput = this.page.getByLabel('ACS URL', { exact: true });
  }

  async goto() {
    await this.page.getByRole('link', { name: 'Apps' }).click();
    // Wait for the new page before a generic Edit locator can match the previous page's table.
    await this.page.waitForURL((url) => url.pathname === '/admin/identity-federation');
  }

  async createApp({
    type = 'saml',
    baseURL,
    params: { name, acsUrl, entityID, redirectUrl } = { name: '' },
  }: {
    type?: 'oidc' | 'saml';
    baseURL: string;
    params: { name: string; acsUrl?: string; entityID?: string; redirectUrl?: string };
  }): Promise<any | { oidcClientId: string; oidcClientSecret: string }> {
    await this.goto();
    await this.page.waitForURL(/.*admin\/identity-federation$/);
    await this.page.getByRole('button', { name: 'New App' }).click();
    await this.page.waitForURL(/.*admin\/identity-federation\/new$/);
    if (type === 'oidc') {
      // Toggle connection type to OIDC
      await this.page.getByLabel('OIDC').check();
    }
    // Common config
    await this.page.getByPlaceholder('Your app').and(this.page.getByLabel('Name')).fill(name);
    await this.page.getByLabel('Tenant', { exact: true }).fill(this.TENANT);
    await this.page.getByLabel('Product', { exact: true }).fill(this.PRODUCT);

    if (type === 'saml') {
      await this.acsUrlInput.fill(acsUrl ?? `${baseURL}/api/oauth/saml`);
      await this.page
        .getByLabel('Entity ID / Audience URI / Audience Restriction')
        .fill(entityID ?? this.ENTITY_ID);
    } else {
      await this.page.locator('input[name="item"]').fill(redirectUrl ?? baseURL);
    }

    await this.page.getByRole('button', { name: 'Create App' }).click();
    await this.page.waitForURL(/.*admin\/identity-federation\/.*\/edit$/);

    let oidcClientId, oidcClientSecret;
    if (type === 'oidc') {
      oidcClientId = await this.page
        .locator('label')
        .filter({ hasText: 'Client ID' })
        .getByRole('textbox')
        .inputValue();
      oidcClientSecret = await this.page
        .locator('label')
        .filter({ hasText: 'Client Secret' })
        .locator('input')
        .inputValue();
    }

    await this.page.getByRole('link', { name: 'Back' }).click();
    await this.page.waitForURL(/.*admin\/identity-federation$/);
    await expect(this.page.getByRole('cell', { name })).toBeVisible();

    if (type === 'oidc') {
      return { oidcClientId, oidcClientSecret };
    }
  }

  async updateApp({ acsUrl }: { acsUrl?: string }) {
    await this.goto();
    await this.editButton.click();
    if (acsUrl && (await this.acsUrlInput.inputValue()) !== acsUrl) {
      await this.acsUrlInput.fill(acsUrl);
      await expect(this.acsUrlInput).toHaveValue(acsUrl);
      const save = this.page
        .locator('form')
        .filter({ has: this.acsUrlInput })
        .getByRole('button', { name: /^Save Changes/ });
      await expect(save).not.toHaveClass(/btn-disabled/);
      await save.click();
    }
  }

  async deleteApp() {
    await this.goto();
    await this.page.waitForURL(/.*admin\/identity-federation$/);
    await this.editButton.click();
    await this.page.locator('.card').getByRole('button', { name: 'Delete' }).click();
    const deleted = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.startsWith('/api/admin/identity-federation/') &&
        response.request().method() === 'DELETE'
    );
    await this.page.getByTestId('confirm-delete').click();
    expect((await deleted).ok()).toBe(true);
    await this.page.waitForURL((url) => url.pathname === '/admin/identity-federation');
  }
}
