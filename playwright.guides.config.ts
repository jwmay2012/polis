import { createHash } from 'crypto';
import { defineConfig } from '@playwright/test';
import admin from './playwright.connection-admin.config';

const server = Array.isArray(admin.webServer) ? admin.webServer[0] : admin.webServer!;

// Reuse the isolated admin harness. Capture is explicit; normal tests never rewrite guide assets.
export default defineConfig({
  ...admin,
  testDir: './e2e/guides',
  testMatch: process.env.POLIS_GUIDE_CAPTURE === '1' ? 'capture.spec.ts' : 'guide.spec.ts',
  outputDir: 'test-results/guides',
  use: { ...admin.use, viewport: { width: 1280, height: 1500 }, actionTimeout: 20_000 },
  webServer: {
    ...server,
    env: {
      ...server.env,
      EXTERNAL_URL: 'https://sso.example.test',
      ACS_URL: 'https://sso.example.test/api/oauth/saml',
      SAML_AUDIENCE: 'https://sso.example.test',
      SSO_DISCOVERY_APP_ID: `oidc_${createHash('ripemd160').update('example-app:Example product').digest('hex')}`,
    },
  },
});
