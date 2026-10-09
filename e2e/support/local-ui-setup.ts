import { request, type FullConfig } from '@playwright/test';

export default async function setup(config: FullConfig) {
  const { baseURL, storageState } = config.projects[0].use;
  process.env.MOCKSAML_ORIGIN = 'http://localhost:4000';
  process.env.API_KEYS = 'secret';
  const api = await request.newContext({ baseURL });
  try {
    const csrf = await (await api.get('/api/auth/csrf')).json();
    const response = await api.post('/api/auth/callback/credentials', {
      form: {
        csrfToken: csrf.csrfToken,
        email: 'super@boxyhq.com',
        password: '999login',
        callbackUrl: baseURL!,
        json: 'true',
      },
    });
    if (!response.ok() || !(await (await api.get('/api/auth/session')).json()).user)
      throw new Error('Local admin sign-in failed');
    await api.storageState({ path: storageState as string });
    const metadata = await api.get(`${process.env.MOCKSAML_ORIGIN}/api/saml/metadata`);
    if (!metadata.ok()) throw new Error('Start local MockSAML on port 4000 before this suite');
    process.env.MOCKSAML_METADATA = await metadata.text();
  } finally {
    await api.dispose();
  }
}
