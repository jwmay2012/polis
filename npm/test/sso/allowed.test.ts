import * as allowed from '../../src/controller/oauth/allowed';
import tap from 'tap';

const matches = allowed.redirect;
const callback = 'https://auth.example/self-service/methods/oidc/callback/polis';

tap.test('redirects match the entire registered URI without normalization', async (t) => {
  t.ok(matches(callback, [callback]));
  for (const uri of [
    'https://auth.example/',
    'https://auth.example/other',
    `${callback}/extra`,
    `${callback}EXTRA`,
    `${callback}/`,
    callback.replace('/self-service/', '//self-service/'),
    `${callback}?next=other`,
    `${callback}#fragment`,
    callback.replace('https://', 'https://user@'),
    callback.replace('auth.example/', 'auth.example:443/'),
    callback.replace('https:', 'HTTPS:'),
    callback.replace('auth.example', 'AUTH.EXAMPLE'),
    callback.replace('/polis', '/%70olis'),
    callback.replace('/polis', '/unused/../polis'),
    callback.replace('/polis', '/%2e/polis'),
    callback.replace('https:', 'http:'),
    callback.replace('auth.example', 'other.example'),
  ]) {
    t.notOk(matches(uri, [callback]), uri);
  }
  const query = `${callback}?a=1&b=2`;
  t.ok(matches(query, [query]), 'registered query is allowed exactly');
  t.notOk(matches(`${callback}?a=2&b=2`, [query]), 'changed query');
  t.notOk(matches(`${callback}?b=2&a=1`, [query]), 'reordered query');
  t.ok(matches(callback, ['https://other.example/callback', callback]), 'checks every entry');
});

tap.test('native and loopback callbacks retain exact matching', async (t) => {
  const native = 'com.example.app://oidc/';
  t.ok(matches(native, [native]));
  t.ok(matches('com.example.app:/callback', ['com.example.app:/callback']));
  for (const uri of ['com.example.app://oidc', `${native}extra`, `${native}?extra=1`]) {
    t.notOk(matches(uri, [native]), uri);
  }
  t.ok(matches('http://127.0.0.1:3000/cb', ['http://127.0.0.1:3000/cb']));
  t.notOk(matches('http://127.0.0.1:3001/cb', ['http://127.0.0.1:3000/cb']), 'no new port exception');
});

tap.test('supported list forms cannot grant a substring match', async (t) => {
  for (const registered of [[callback], JSON.stringify([callback]), callback]) {
    t.ok(matches(callback, registered));
    t.notOk(matches('https://auth.example', registered));
  }
  for (const registered of [undefined, null, {}, 1, [callback, 1], '[invalid', '[]']) {
    t.notOk(matches(callback, registered), JSON.stringify(registered));
  }
  t.notOk(matches(callback, []));
  t.notOk(matches(callback, ['https://*.example/self-service/methods/oidc/callback/polis']));
});

tap.test('invalid request URIs are refused even if registered literally', async (t) => {
  for (const uri of [
    'http://_boxyhq_redirect_not_in_use',
    '/relative',
    'not a URL',
    `${callback}#`,
    `${callback}#fragment`,
    callback.replace('https://', 'https://user:password@'),
    callback.replace('https://', 'https://@'),
    'https:////user@auth.example/callback',
    'https://*.example/callback',
    'https://%2a.example/callback',
    ` ${callback}`,
    `${callback} `,
    `${callback}\u0000`,
    `${callback}\u001f`,
    `${callback}\u007f`,
    callback.replace('auth', 'au\tth'),
    callback.replace('auth', 'au\nth'),
    callback.replace('/self-service', '\\self-service'),
  ]) {
    t.notOk(matches(uri, [uri]), JSON.stringify(uri));
  }
});

tap.teardown(() => process.exit(0));
