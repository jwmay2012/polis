import tap from 'tap';

tap.test('portal defaults register the exact NextAuth callback', async (t) => {
  process.env.EXTERNAL_URL = 'https://polis.example.test';
  for (const nextAuthUrl of ['', 'https://portal.example.test/', 'https://portal.example.test/api/auth/']) {
    if (nextAuthUrl) process.env.NEXTAUTH_URL = nextAuthUrl;
    else delete process.env.NEXTAUTH_URL;
    const { adminPortalSSODefaults } = t.mockRequire('../../../lib/env');
    const origin = nextAuthUrl ? 'https://portal.example.test' : process.env.EXTERNAL_URL;
    t.ok(adminPortalSSODefaults.redirectUrl.includes(`${origin}/api/auth/callback/boxyhq-saml`));
    t.equal(adminPortalSSODefaults.defaultRedirectUrl, 'https://polis.example.test/admin/auth/idp-login');
  }
});
