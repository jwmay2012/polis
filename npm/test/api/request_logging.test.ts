import tap from 'tap';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { register } from 'tsconfig-paths';
import { bindContext, contextFields, type LogFields } from '../../src/logging/context';
import { redact } from '../../src/logging/redact';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('redaction preserves useful facts and native errors without changing input', (t) => {
  const password = 'fixture-password';
  const code = 'fixture-authorization-code';
  const input = {
    headers: {
      authorization: `Basic ${Buffer.from(`client:${password}`).toString('base64')}`,
      cookie: 'session=fixture-cookie',
      'x-api-key': 'abc123',
    },
    response: {
      headers: {
        'set-cookie': ['session=fixture-new-cookie; HttpOnly'],
        location: `https://app.example/callback?code=${code}&state=fixture-state`,
      },
    },
    body: {
      client_secret: password,
      requested_email: 'user@example.com',
      nested: { access_token: 'fixture-token' },
    },
    err: new Error(`Exchange failed with ${password} and ${code}`, {
      cause: Object.assign(new Error('socket failed'), { code: 'ECONNRESET' }),
    }),
    msg: `cookie fixture-cookie and fixture-new-cookie, key abc123, code ${code}`,
  };
  const before = JSON.stringify(input);
  const output = redact(input);
  t.equal(JSON.stringify(input), before);
  t.match(output, {
    headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-api-key': 'c123' },
    response: { headers: { 'set-cookie': ['[REDACTED]'], location: 'https://app.example/callback' } },
    body: {
      client_secret: '[REDACTED]',
      requested_email: 'user@example.com',
      nested: { access_token: '[REDACTED]' },
    },
    err: { cause: { code: 'ECONNRESET' } },
  });
  for (const credential of [
    password,
    code,
    'fixture-cookie',
    'fixture-new-cookie',
    'fixture-token',
    'fixture-state',
    'abc123',
  ])
    t.notMatch(JSON.stringify(output), credential);
  t.match(output.msg, 'key c123');
  t.equal(redact({ code: '123456' }).code, '[REDACTED]', 'OAuth codes remain credentials');
  for (const uri of ['example-app://oauthredirect', 'example-app://auth/callback', 'example-app:/callback']) {
    t.equal(
      redact({ redirect_uri: `${uri}?state=native-state` }).redirect_uri,
      uri,
      'native callback schemes stay meaningful'
    );
  }
  const redirects = [
    'https://app.example/callback?state=private-state',
    'example-app://callback?code=private-code',
  ];
  const safeRedirects = ['https://app.example/callback', 'example-app://callback'];
  t.same(redact({ redirectUrl: redirects }).redirectUrl, safeRedirects);
  t.equal(redact({ redirectUrl: JSON.stringify(redirects) }).redirectUrl, JSON.stringify(safeRedirects));
  t.same(
    redact({
      webhook_secret: 'webhook',
      oidcClientSecret: 'client',
      google_access_token: 'google',
      sdkToken: 'sdk',
    }),
    {
      webhook_secret: '[REDACTED]',
      oidcClientSecret: '[REDACTED]',
      google_access_token: '[REDACTED]',
      sdkToken: '[REDACTED]',
    }
  );
  t.same(
    redact({ url: 'https://polis.example/setup/fixture-setup-token', msg: 'Created fixture-setup-token' }),
    { url: 'https://polis.example/setup/[REDACTED]', msg: 'Created [REDACTED]' }
  );
  t.equal(
    redact({
      err: new AggregateError([Object.assign(new Error('socket'), { code: 'ECONNRESET' })], 'All failed'),
    }).err.errors[0].code,
    'ECONNRESET'
  );
  t.equal(
    redact({
      redirect_uri: 'https://name:fixture-uri-password@app.example/cb?nonce=fixture-nonce',
      msg: 'fixture-uri-password fixture-nonce',
    }).msg,
    '[REDACTED] [REDACTED]'
  );
  const cyclic: any = { name: 'fixture' };
  cyclic.self = cyclic;
  t.equal(redact(cyclic).self, '[Truncated]');
  const broken = Object.defineProperty({}, 'field', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  t.equal(redact(broken), '[Unable to serialize log data]');
  t.end();
});

tap.test(
  'the HTTP boundary observes real finish, rejection and disconnect without changing bytes',
  async (t) => {
    const logs: LogFields[] = [];
    const logger = Object.fromEntries(
      ['info', 'warn', 'error'].map((level) => [
        level,
        (fields: any, msg: string) => logs.push({ ...fields, msg, level }),
      ])
    );
    const { withRequestLogging } = t.mockRequire<typeof import('../../../lib/request-logging')>(
      '../../../lib/request-logging.ts',
      { [path.join(root, 'lib/logger.ts')]: { logger } }
    );
    const bodies = new Map<string, any>();
    const responses = new Map<string, http.ServerResponse>();
    const originalWrites = new Map<string, http.ServerResponse['write']>();
    const original = new Error('fixture handler failure');
    const handler = withRequestLogging(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      bodies.set(url.pathname, req.body);
      responses.set(url.pathname, res);
      if (url.pathname === '/throw') throw original;
      if (url.pathname === '/disconnect') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        return;
      }
      if (url.pathname === '/large') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: 'x'.repeat(70000) }));
        return;
      }
      if (url.pathname === '/redirect') {
        res.writeHead(302, {
          location: 'https://app.example/callback?code=fixture-wire-code&state=fixture-state',
        });
        res.end();
        return;
      }
      bindContext({
        user_email: `${url.pathname.slice(1)}@example.com`,
        connection_id: url.pathname.slice(1),
      });
      await new Promise((resolve) => setTimeout(resolve, url.pathname === '/alice' ? 15 : 2));
      res.writeHead(201, {
        'content-type': 'application/json',
        'set-cookie': 'session=fixture-response-cookie; HttpOnly',
      });
      res.write('{"access_token":"fixture-wire-token",');
      res.end('"message":"created"}');
    });
    const rejected: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      originalWrites.set(new URL(req.url!, 'http://localhost').pathname, res.write);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      Object.assign(req, {
        query: Object.fromEntries(new URL(req.url!, 'http://localhost').searchParams),
        body: body ? JSON.parse(body) : undefined,
      });
      await handler(req as any, res as any).catch((err) => {
        rejected.push(err);
        res.writeHead(500);
        res.end('framework error');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const request = (route: string, body?: any) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: route,
            method: 'POST',
            headers: {
              'x-request-id': route,
              'x-session-id': 'device-1',
              cookie: 'session=fixture-request-cookie',
              'x-api-key': 'fixture-key-1234',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            );
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    try {
      const payload = { client_secret: 'fixture-client-secret', requested_email: 'user@example.com' };
      const replies = await Promise.all(['/alice', '/bob'].map((route) => request(route, payload)));
      for (const reply of replies) {
        t.equal(reply.status, 201);
        t.equal(reply.body, '{"access_token":"fixture-wire-token","message":"created"}');
        t.same(reply.headers['set-cookie'], ['session=fixture-response-cookie; HttpOnly']);
      }
      t.same(bodies.get('/alice'), payload, 'request body is never mutated');
      const completed = () => logs.filter((row) => row.msg === 'HTTP request completed');
      t.equal(completed().length, 2, 'exactly one completion per response');
      for (const row of completed()) {
        t.equal(row.user_email, `${row.http_route.slice(1)}@example.com`);
        t.equal(row.connection_id, row.http_route.slice(1));
        t.equal(row.http_response_status, 201);
        t.ok(row.duration_ms >= 1);
        t.equal(row.response_bytes, Buffer.byteLength(replies[0].body));
        t.match(row, {
          request: {
            headers: { cookie: '[REDACTED]', 'x-api-key': '1234' },
            body: { client_secret: '[REDACTED]' },
          },
          response: { body: { access_token: '[REDACTED]', message: 'created' } },
        });
        t.equal(
          responses.get(row.http_route)!.write,
          originalWrites.get(row.http_route),
          'response methods are restored'
        );
      }
      const redirect = await request('/redirect');
      t.equal(redirect.status, 302);
      t.equal(
        redirect.headers.location,
        'https://app.example/callback?code=fixture-wire-code&state=fixture-state'
      );
      t.equal(
        completed().find((row) => row.http_route === '/redirect')!.response.headers.location,
        'https://app.example/callback'
      );
      t.equal((await request('/throw')).body, 'framework error');
      t.equal(rejected[0], original, 'the exact thrown error reaches the framework');
      t.equal(completed().find((row) => row.http_route === '/throw')!.http_response_status, 500);
      t.equal(logs.find((row) => row.msg === 'HTTP request handler failed')!.err.message, original.message);
      t.ok((await request('/large')).body.length > 65536);
      t.equal(
        completed().find((row) => row.http_route === '/large')!.response.body_omitted,
        'Body exceeds capture limit'
      );
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/disconnect' }, (res) => {
          res.once('data', () => {
            const response = responses.get('/disconnect')!;
            once(response, 'close').then(() => resolve(), reject);
            res.destroy();
          });
        });
        req.on('error', reject);
        req.end();
      });
      const aborted = logs.filter((row) => row.msg === 'HTTP request closed before completion');
      t.equal(aborted.length, 1);
      t.equal(
        aborted[0].http_response_status,
        200,
        'retain the status actually sent, not an invented timeout code'
      );
      t.equal(aborted[0].response.body_omitted, 'Response did not finish');
      t.type(aborted[0].duration_ms, 'number');
      t.same(contextFields(), {}, 'no request context remains in the caller');
      for (const credential of [
        'fixture-client-secret',
        'fixture-wire-token',
        'fixture-wire-code',
        'fixture-request-cookie',
        'fixture-response-cookie',
        'fixture-key-1234',
      ])
        t.notMatch(JSON.stringify(logs), credential);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
