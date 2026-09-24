import { defineConfig } from '@playwright/test';
import { createHash, generateKeyPairSync } from 'crypto';

const port = process.env.POLIS_ADMIN_TEST_PORT || '54325';
const baseURL = `http://127.0.0.1:${port}`;
const signingKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// No shared database, saved browser session, external IdP, or production credentials.
export default defineConfig({
  testDir: './e2e/ui',
  testMatch: ['connection-admin.spec.ts', 'routing-admin.spec.ts'],
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: 'list',
  outputDir: process.env.POLIS_ADMIN_TEST_OUTPUT || 'test-results/connection-admin',
  use: { baseURL, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    stdout: 'pipe',
    command: `node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'development',
      NODE_OPTIONS: '',
      DB_ENGINE: 'mem',
      DB_TYPE: '',
      DB_URL: '',
      DATABASE_URL: '',
      DB_PAGE_LIMIT: '7',
      DB_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
      HOST_URL: '127.0.0.1',
      PORT: port,
      EXTERNAL_URL: baseURL,
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_URL_INTERNAL: baseURL,
      NEXTAUTH_SECRET: 'local-admin-inventory-session-secret',
      NEXTAUTH_ADMIN_CREDENTIALS: 'admin@example.test:local-inventory-password',
      ADMIN_PORTAL_SSO_TENANT: '_jackson_boxyhq',
      ADMIN_PORTAL_SSO_PRODUCT: '_jackson_admin_portal',
      API_KEYS: 'local-inventory-api-key',
      POLIS_LICENSE_KEY: 'dummy-license',
      BOXYHQ_LICENSE_KEY: 'dummy-license',
      POLIS_NO_ANALYTICS: '1',
      OTEL_SDK_DISABLED: 'true',
      POLIS_HOSTED: '0',
      BOXYHQ_HOSTED: '0',
      PRE_LOADED_CONNECTION: '',
      PRE_LOADED_CONFIG: '',
      PUBLIC_KEY: '',
      PRIVATE_KEY: '',
      OPENID_RSA_PRIVATE_KEY: signingKeys.privateKey,
      OPENID_RSA_PUBLIC_KEY: signingKeys.publicKey,
      WEBHOOK_URL: '',
      WEBHOOK_SECRET: '',
      SSO_TRACES_DISABLE: 'true',
      SSO_DISCOVERY_APP_ID: `oidc_${createHash('ripemd160').update('routing-browser:routing-browser').digest('hex')}`,
      ENABLE_DOMAIN_ROUTING: 'true',
      STRICT_DOMAIN_ROUTING: 'true',
    },
  },
});
