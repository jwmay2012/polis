import { createHash, generateKeyPairSync, randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import { SignJWT, exportJWK } from 'jose';
import { test, expect, type APIRequestContext } from '@playwright/test';

const activeSecret = 'synthetic-browser-active';
const replacementSecret = 'synthetic-browser-replacement';
const pilot = 'pilot@example.test';
const servers: Server[] = [];

// A real, loopback-only confidential IdP. UI promotion must earn its proof
// through Polis's token exchange, not by fabricating a status response.
async function fixture(request: APIRequestContext, origin: string) {
  const clientId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture' };
  const grants = new Map<string, { email: string; nonce: string; redirect: string; challenge: string }>();
  const tokens = new Map<string, string>();
  const state = {
    assertedEmail: '',
    acceptedSecrets: new Set([activeSecret, replacementSecret]),
    exchanges: [] as string[],
  };
  let issuer = '';
  const server = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url!, issuer);
      if (url.pathname === '/.well-known/openid-configuration')
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/authorize') {
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('redirect_uri') !== `${origin}/api/oauth/oidc`
        )
          return json({ error: 'invalid_request' }, 400);
        const code = randomUUID();
        grants.set(code, {
          email: state.assertedEmail || url.searchParams.get('login_hint')!,
          nonce: url.searchParams.get('nonce')!,
          redirect: url.searchParams.get('redirect_uri')!,
          challenge: url.searchParams.get('code_challenge')!,
        });
        const target = new URL(`${origin}/api/oauth/oidc`);
        target.searchParams.set('code', code);
        target.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { Location: target.href });
        return res.end();
      }
      if (url.pathname === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        const code = body.get('code')!,
          grant = grants.get(code);
        grants.delete(code);
        if (
          !grant ||
          body.get('client_id') !== clientId ||
          body.get('redirect_uri') !== grant.redirect ||
          createHash('sha256')
            .update(body.get('code_verifier') || '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        const secret = body.get('client_secret') || '';
        state.exchanges.push(secret);
        if (!state.acceptedSecrets.has(secret)) return json({ error: 'invalid_client' }, 401);
        const access = randomUUID();
        tokens.set(access, grant.email);
        const token = await new SignJWT({ email: grant.email, email_verified: true, nonce: grant.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
          .setIssuer(issuer)
          .setSubject(grant.email)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return json({ token_type: 'Bearer', access_token: access, id_token: token, expires_in: 300 });
      }
      if (url.pathname === '/userinfo') {
        const email = tokens.get(req.headers.authorization?.replace(/^Bearer /i, '') || '');
        return email
          ? json({ sub: email, email, email_verified: true })
          : json({ error: 'invalid_token' }, 401);
      }
      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'fixture_failure' }, 500);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://localhost:${(server.address() as { port: number }).port}`;
  const response = await request.post('/api/admin/connections', {
    data: {
      name: 'Rotation fixture',
      tenant: `rotation-${randomUUID()}`,
      product: 'rotation-ui',
      oidcClientId: clientId,
      oidcClientSecret: activeSecret,
      oidcDiscoveryUrl: `${issuer}/.well-known/openid-configuration`,
      redirectUrl: [`${origin}/api/health`],
      defaultRedirectUrl: `${origin}/api/health`,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const connection = (await response.json()).data;
  const endpoint = `/api/admin/connections/${connection.clientID}/secret-rotation`;
  return {
    state,
    connection,
    endpoint,
    status: async () => (await request.get(endpoint)).json(),
    login: async (email: string) => {
      const query = new URLSearchParams({
        client_id: connection.clientID,
        redirect_uri: `${origin}/api/health`,
        response_type: 'code',
        scope: 'openid email',
        state: randomUUID(),
        login_hint: email,
      });
      const response = await request.get(`/api/oauth/authorize?${query}`);
      const target = new URL(response.url());
      expect(target.origin).toBe(origin);
      expect(target.pathname).toBe('/api/health');
      return target.searchParams.has('code') && !target.searchParams.has('error');
    },
  };
}

test.beforeEach(async ({ page, context, baseURL }) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort()
  );
  const csrf = await (await page.request.get('/api/auth/csrf')).json();
  const response = await page.request.post('/api/auth/callback/credentials', {
    form: {
      csrfToken: csrf.csrfToken,
      email: 'admin@example.test',
      password: 'local-inventory-password',
      callbackUrl: baseURL!,
      json: 'true',
    },
  });
  expect(response.ok()).toBe(true);
});

test.afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('a proven secret promotes, refreshes the editor, rolls back and finishes without accepting stale tabs', async ({
  page,
  context,
  baseURL,
}, info) => {
  const f = await fixture(page.request, baseURL!);
  const path = `/admin/sso-connection/edit/${f.connection.clientID}`;
  await page.goto(path);
  await expect(page.locator('#oidcClientSecret')).toHaveValue(activeSecret);
  const stale = await context.newPage();
  await stale.goto(path);
  await expect(stale.locator('#oidcClientSecret')).toHaveValue(activeSecret);
  const link = await page.request.post('/api/admin/setup-links', {
    data: {
      service: 'sso',
      tenant: f.connection.tenant,
      product: f.connection.product,
      defaultRedirectUrl: `${baseURL}/api/health`,
      redirectUrl: [`${baseURL}/api/health`],
    },
  });
  expect(link.status()).toBe(201);
  const setup = await context.newPage();
  await setup.goto(`${(await link.json()).data.url}/sso-connection/edit/${f.connection.clientID}`);
  await expect(setup.locator('#oidcClientSecret')).toHaveValue(activeSecret);
  await expect(setup.getByRole('region', { name: 'Client secret rotation' })).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Client secret rotation' });
  await panel.getByLabel('New client secret').fill(replacementSecret);
  await panel.getByLabel('Test email').fill(pilot);
  await panel.getByRole('button', { name: 'Save pending secret' }).click();
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeDisabled();
  const pending = await f.status();
  expect(JSON.stringify(pending)).not.toContain(replacementSecret);
  expect(await f.login('other@example.test')).toBe(true);
  expect(f.state.exchanges.at(-1)).toBe(activeSecret);
  expect(await f.login(pilot)).toBe(true);
  expect(f.state.exchanges.at(-1)).toBe(replacementSecret);
  await panel.getByRole('button', { name: 'Refresh test result' }).click();
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeEnabled();
  await panel.screenshot({ path: info.outputPath('rotation-tested.png') });
  await panel.getByRole('button', { name: 'Promote pending secret' }).click();
  await panel.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('#oidcClientSecret')).toHaveValue(replacementSecret);
  await expect(panel.getByRole('button', { name: 'Finish rotation' })).toBeVisible();
  await panel.screenshot({ path: info.outputPath('rotation-promoted.png') });
  await panel.getByRole('button', { name: 'Restore previous secret' }).click();
  await panel.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('#oidcClientSecret')).toHaveValue(activeSecret);
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeDisabled();
  expect(await f.login(pilot)).toBe(true);
  await panel.getByRole('button', { name: 'Refresh test result' }).click();
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Promote pending secret' }).click();
  await panel.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('#oidcClientSecret')).toHaveValue(replacementSecret);
  f.state.acceptedSecrets.delete(activeSecret);
  expect(await f.login('other@example.test')).toBe(true);
  expect(f.state.exchanges.at(-1)).toBe(replacementSecret);
  await panel.getByRole('button', { name: 'Finish rotation' }).click();
  await panel.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(panel.getByRole('button', { name: 'Save pending secret' })).toBeVisible();
  for (const oldPage of [stale, setup]) {
    const saved = oldPage.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        (response.url().includes('/sso-connection') || response.url().endsWith('/api/admin/connections'))
    );
    await oldPage
      .locator('form')
      .filter({ has: oldPage.locator('#oidcClientSecret') })
      .getByRole('button', { name: /Save/i })
      .click();
    expect((await saved).status()).toBe(409);
    await expect(
      oldPage.getByText('The client secret changed since this form was loaded. Reload.')
    ).toBeVisible();
  }
  expect((await f.status()).standby).toBeNull();
});

test('bad candidates affect only the pilot, mismatch cannot prove them, and unsaved forms block rotation', async ({
  page,
  baseURL,
}) => {
  const f = await fixture(page.request, baseURL!);
  await page.goto(`/admin/sso-connection/edit/${f.connection.clientID}`);
  const panel = page.getByRole('region', { name: 'Client secret rotation' });
  await panel.getByLabel('New client secret').fill('synthetic-wrong-candidate');
  await panel.getByLabel('Test email').fill(pilot);
  await page.locator('#name').fill('Unsaved edit');
  await expect(panel.getByRole('button', { name: 'Save pending secret' })).toBeDisabled();
  await page.reload();
  await panel.getByLabel('New client secret').fill('synthetic-wrong-candidate');
  await panel.getByLabel('Test email').fill(pilot);
  await panel.getByRole('button', { name: 'Save pending secret' }).click();
  await expect(panel.getByRole('button', { name: 'Discard pending secret' })).toBeVisible();
  expect(await f.login(pilot)).toBe(false);
  expect(await f.login('other@example.test')).toBe(true);
  await panel.getByRole('button', { name: 'Refresh test result' }).click();
  await expect(panel.getByText(/Last test failed/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Discard pending secret' }).click();
  await panel.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(panel.getByRole('button', { name: 'Discard pending secret' })).toHaveCount(0);
  expect(await f.login(pilot)).toBe(true);
  await panel.getByLabel('New client secret').fill(replacementSecret);
  await panel.getByLabel('Test email').fill(pilot);
  await panel.getByRole('button', { name: 'Save pending secret' }).click();
  await expect(panel.getByRole('button', { name: 'Discard pending secret' })).toBeVisible();
  f.state.assertedEmail = 'another@example.test';
  expect(await f.login(pilot)).toBe(true);
  await panel.getByRole('button', { name: 'Refresh test result' }).click();
  await expect(panel.getByText(/The identity provider returned another@example.test/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Promote pending secret' })).toBeDisabled();
});
