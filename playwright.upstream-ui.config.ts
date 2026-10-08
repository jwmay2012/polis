import { defineConfig } from '@playwright/test';
import admin from './playwright.connection-admin.config';

const server = Array.isArray(admin.webServer) ? admin.webServer[0] : admin.webServer!;
// The upstream OIDC client permits HTTP only for the literal localhost hostname.
const baseURL = admin.use!.baseURL!.replace('127.0.0.1', 'localhost');

// Run the existing upstream UI specifications against the isolated memory-backed app.
// Requires local MockSAML on port 4000; OIDC specifications also use their existing MockLab fixture.
export default defineConfig({
  ...admin,
  globalSetup: require.resolve('./e2e/support/local-ui-setup'),
  testMatch: [
    'Enterprise SSO/*.spec.ts',
    'Identity Federation/*.spec.ts',
    'Directory Sync/*.spec.ts',
    'settings/sso.spec.ts',
  ],
  outputDir: 'test-results/upstream-ui',
  use: {
    ...admin.use,
    baseURL,
    storageState: 'test-results/upstream-ui/auth.json',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    ...server,
    command: server.command.replace('127.0.0.1', 'localhost'),
    url: `${baseURL}/api/health`,
    env: {
      ...server.env,
      HOST_URL: 'localhost',
      EXTERNAL_URL: baseURL,
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_URL_INTERNAL: baseURL,
      ACS_URL: `${baseURL}/api/oauth/saml`,
      ENABLE_DOMAIN_ROUTING: 'false',
      STRICT_DOMAIN_ROUTING: 'false',
      SSO_DISCOVERY_APP_ID: '',
      SAML_AUDIENCE: 'https://saml.boxyhq.com',
      NEXTAUTH_ACL: '*@boxyhq.com',
      NEXTAUTH_ADMIN_CREDENTIALS: 'super@boxyhq.com:999login',
      API_KEYS: 'secret',
      CLIENT_SECRET_VERIFIER: 'local-upstream-ui-verifier',
      SSO_TRACES_DISABLE: 'false',
      IDP_ENABLED: 'true',
      DB_PAGE_LIMIT: '50',
    },
  },
});
