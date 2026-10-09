import { expect, type Page } from '@playwright/test';
import type { DirectorySyncProviders } from '../data/dsync';

export class DSyncPage {
  tenant: string;
  product: string;
  constructor(public readonly page: Page) {
    this.tenant = 'acme.com';
    this.product = 'demo';
  }

  async gotoDSync() {
    await this.page.goto(`/admin/directory-sync`);
  }

  async addDSyncConnection(provider: keyof typeof DirectorySyncProviders, baseURL: string) {
    await this.gotoDSync();
    await this.page.getByRole('link', { name: 'New Directory' }).click();
    await this.page.getByLabel('Directory name').fill('DS-1');
    await this.page.getByLabel('Directory provider').selectOption({ value: provider });
    await this.page.getByLabel('Tenant', { exact: true }).fill(this.tenant);
    await this.page.getByLabel('Product', { exact: true }).fill(this.product);
    await this.page.getByLabel('Webhook URL').fill(`${baseURL}/api/hello`);
    await this.page.getByLabel('Webhook secret').fill('secret');
    await this.page.getByRole('button', { name: 'Create Directory' }).click();
    const scimUrl = await this.page.getByLabel('SCIM Endpoint').inputValue();
    const scimToken = await this.page.getByLabel('SCIM Token').inputValue();
    return { scimUrl, scimToken };
  }

  async deleteConnection() {
    await this.gotoDSync();
    await this.page.getByLabel('Loading').waitFor({ state: 'hidden' });
    const row = this.page.getByRole('row', { name: /DS-1/ }).first();
    await row.getByLabel('Edit').click();
    await this.page.getByRole('button', { name: 'Delete' }).click();
    await this.page.getByRole('button', { name: 'Confirm' }).click();
  }

  async switchToDSyncInfoView() {
    await this.gotoDSync();
    await this.page.getByLabel('Loading').waitFor({ state: 'hidden' });
    const row = this.page.getByRole('row', { name: /DS-1/ }).first();
    await row.getByLabel('View').click();
    await this.page.waitForURL('/admin/directory-sync/**');
  }

  async switchToUsersView({ waitForData }: { waitForData?: boolean } = {}) {
    await this.page.getByRole('listitem').and(this.page.getByText('Users')).click();
    await this.page.waitForURL(/\/admin\/directory-sync\/.*\/users$/);
    if (waitForData) {
      await this.page.getByRole('table').waitFor();
    }
  }
  // group events navigation done after users view, hence we can skip View click
  async switchToGroupsView({ waitForData }: { waitForData?: boolean } = {}) {
    await this.page.getByRole('listitem').and(this.page.getByText('Groups')).click();
    await this.page.waitForURL(/\/admin\/directory-sync\/.*\/groups$/);
    if (waitForData) {
      await this.page.getByRole('table').waitFor();
    }
  }
  async switchToEventsView({ waitForData }: { waitForData?: boolean } = {}) {
    await this.page.getByRole('listitem').and(this.page.getByText('Webhook Events')).click();
    await this.page.waitForURL(/\/admin\/directory-sync\/.*\/events$/);
    if (waitForData) {
      await this.page.getByRole('table').waitFor();
    }
  }
  async inspectEventRow(id: number, webhookEndpoint: string) {
    const webhookRowRegex = new RegExp(`${webhookEndpoint}.*View`);
    await this.page.getByRole('row', { name: webhookRowRegex }).getByRole('button').nth(id).click();
    await this.page.waitForURL(/\/admin\/directory-sync\/.*\/events\/.*/);
    await this.page.locator('pre').waitFor();
  }
  async setWebHookEventsLogging({ enable, directory }: { enable: boolean; directory: any }) {
    await this.gotoDSync();
    const responsePromise = this.page.waitForResponse((response) => {
      const regex = new RegExp(`^\\/api\\/.*\\/directory-sync\\/${directory.id}$`);
      return regex.test(new URL(response.url()).pathname) && response.status() === 200;
    });
    const row = this.page.getByRole('row', { name: /DS-1/ }).first();
    await row.getByLabel('Edit').click();
    // Wait for the directory fetch to finish and then interact with the checkbox
    await responsePromise;
    const checkBox = await this.page.getByLabel('Enable Webhook events logging');
    if (enable) {
      await checkBox.check();
    } else {
      await checkBox.uncheck();
    }
    const save = this.page.getByRole('button', { name: 'Save', exact: true });
    await expect(save).not.toHaveClass(/btn-disabled/);
    const saved = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/directory-sync/${directory.id}`) &&
        response.request().method() === 'PATCH'
    );
    await save.click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().log_webhook_events).toBe(enable);
    await this.page.waitForURL((url) => url.pathname === '/admin/directory-sync');
  }
}
