import fs from 'fs';
import path from 'path';
import { once } from 'events';
import tap from 'tap';
import { register } from 'tsconfig-paths';
import { withContext, secrets } from '../../src/logging/context';
import { redact } from '../../src/logging/redact';

const root = path.resolve(__dirname, '../../..');
register({ baseUrl: root, paths: { '@lib/*': ['lib/*'] } });

tap.test('file logging retains request mixin, error causes and configured level as JSON', async (t) => {
  const directory = t.testdir();
  const globalLogger = (globalThis as any).loggerInstance;
  const env: Record<string, string | undefined> = process.env;
  const nodeEnv = env.NODE_ENV;
  const streams = new Map<string, fs.WriteStream>();
  delete (globalThis as any).loggerInstance;
  env.NODE_ENV = 'development';
  const loggingModule = t.mockRequire<typeof import('../../../lib/logger')>('../../../lib/logger.ts', {
    [path.join(root, 'lib/env.ts')]: { loggerOptions: { file: path.join(directory, 'default.jsonl') } },
    fs: {
      ...fs,
      createWriteStream: (filename: string) => {
        const destination = fs.createWriteStream(filename);
        streams.set(filename, destination);
        return destination;
      },
    },
  });
  const filename = path.join(directory, 'requests.jsonl');
  const logger = loggingModule.initLogger(filename, 'warn');
  const close = async (destination: fs.WriteStream) => {
    if (destination.writableFinished || destination.destroyed) return;
    const done = once(destination, 'finish');
    if (!destination.writableEnded) destination.end();
    await done;
  };
  try {
    await withContext({ requested_email: 'fixture@example.com', request_id: 'request-1' }, {}, async () => {
      logger.info('below the configured level');
      logger.warn(
        { err: new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) }) },
        'file failure'
      );
    });
    logger.warn('outside request');
    await close(streams.get(filename)!);
    const rows = fs
      .readFileSync(filename, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    t.equal(rows.length, 2);
    t.match(rows[0], {
      level: 40,
      requested_email: 'fixture@example.com',
      request_id: 'request-1',
      err: { message: 'outer', cause: { message: 'inner', code: 'ECONNRESET' } },
    });
    t.ok(rows[0].err.stack);
    t.equal(rows[1].requested_email, undefined);
    t.equal(rows[1].request_id, undefined);

    const detailsFile = path.join(directory, 'details.jsonl');
    const detailed = loggingModule.initLogger(detailsFile, 'info');
    const apiKey = 'test-api-secret-1234';
    const password = 'test-password-never-log';
    await withContext({ http_method: 'POST', http_route: '/api/connections' }, {}, async () => {
      redact({ api_key: apiKey, password }, secrets());
      detailed
        .child({ api_key: apiKey })
        .info(
          { requested_email: 'requested@example.com' },
          'Creating connection with %s and %s',
          apiKey,
          password
        );
      detailed.error(
        {
          err: new Error(`Unable to connect using ${password}`, {
            cause: Object.assign(new Error('network failed'), { code: 'ECONNRESET' }),
          }),
        },
        'Unable to create connection'
      );
      detailed.error('An unexpected condition occurred');
      detailed.info({ api_key: 'abcdef' }, 'Short key');
      detailed.info({ api_key: 'abc' }, 'Very short key');
    });
    await close(streams.get(detailsFile)!);
    const output = fs.readFileSync(detailsFile, 'utf8');
    const detailRows = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    t.equal(detailRows.length, 5);
    t.notMatch(output, apiKey);
    t.notMatch(output, password);
    t.match(detailRows[0], {
      api_key: '1234',
      msg: 'Creating connection with 1234 and [REDACTED]',
      http_method: 'POST',
      http_route: '/api/connections',
    });
    t.match(detailRows[0].source, /file_logger.test.ts/);
    t.equal(detailRows[1].err.cause.code, 'ECONNRESET');
    t.ok(detailRows[1].err.stack);
    t.ok(detailRows[2].error_stack);
    t.equal(detailRows[3].api_key, 'cdef');
    t.equal(detailRows[4].api_key, 'abc', 'last four, without a short-key exception');
  } finally {
    await Promise.all([...streams.values()].map(close));
    (globalThis as any).loggerInstance = globalLogger;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
  }
});
