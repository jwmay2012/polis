import path from 'path';
import tap from 'tap';
import { register } from 'tsconfig-paths';

const root = path.resolve(__dirname, '../../..');

register({
  baseUrl: root,
  paths: { '@lib/*': ['lib/*'] },
});

const jacksonModule = path.join(root, 'lib/jackson.ts');
const loggerModule = path.join(root, 'lib/logger.ts');
const utilsModule = path.join(root, 'lib/utils.ts');

tap.test('Mobile OIDC callback route', async (t) => {
  const query = { code: 'upstream-code', state: 'upstream-state' };
  const calls: {
    callbackPayload?: Record<string, string>;
    redirect?: { statusCode: number; url: string };
    error?: { message?: string; statusCode?: number };
  } = {};

  const route = t.mockRequire<typeof import('../../../pages/api/oauth/oidc/mobile')>(
    '../../../pages/api/oauth/oidc/mobile.ts',
    {
      [jacksonModule]: async () => ({
        oauthController: {
          oidcAuthzResponse: async (payload: Record<string, string>) => {
            calls.callbackPayload = payload;
            return { redirect_url: 'com.example.app://oidc/?code=downstream-code' };
          },
        },
      }),
      [loggerModule]: { logger: { error: () => undefined } },
      [utilsModule]: {
        setErrorCookieAndRedirect: (_response: unknown, error: { message?: string; statusCode?: number }) => {
          calls.error = error;
        },
      },
    }
  );

  const response = {
    redirect: (statusCode: number, url: string) => {
      calls.redirect = { statusCode, url };
    },
    send: () => undefined,
    setHeader: () => undefined,
  };

  await route.default({ method: 'GET', query } as never, response as never);

  t.same(calls.callbackPayload, query, 'the route passes the upstream callback parameters through');
  t.same(
    calls.redirect,
    { statusCode: 302, url: 'com.example.app://oidc/?code=downstream-code' },
    'the route redirects to the downstream native application URI'
  );
  t.notOk(calls.error, 'the successful callback does not use the error redirect');
});

tap.test('Mobile OIDC callback route rejects non-GET requests', async (t) => {
  let callbackCalled = false;
  let routedError: { message?: string; statusCode?: number } | undefined;

  const route = t.mockRequire<typeof import('../../../pages/api/oauth/oidc/mobile')>(
    '../../../pages/api/oauth/oidc/mobile.ts',
    {
      [jacksonModule]: async () => ({
        oauthController: {
          oidcAuthzResponse: async () => {
            callbackCalled = true;
            return {};
          },
        },
      }),
      [loggerModule]: { logger: { error: () => undefined } },
      [utilsModule]: {
        setErrorCookieAndRedirect: (_response: unknown, error: { message?: string; statusCode?: number }) => {
          routedError = error;
        },
      },
    }
  );

  await route.default({ method: 'POST', query: {} } as never, {} as never);

  t.notOk(callbackCalled, 'the controller is not called');
  t.same(routedError, { message: 'Method not allowed', statusCode: 405 });
});
