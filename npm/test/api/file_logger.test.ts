import fs from 'fs';
import path from 'path';
import { once } from 'events';
import tap from 'tap';
import { register } from 'tsconfig-paths';
import * as telemetry from '../../src/opentelemetry/telemetry';

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
    await telemetry.withSsoTelemetry(
      'fixture',
      { fields: { requested_email: 'fixture@example.com', request_id: 'request-1' } },
      async () => {
        logger.info('below the configured level');
        logger.warn(
          { err: new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) }) },
          'file failure'
        );
      }
    );
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
  } finally {
    await Promise.all([...streams.values()].map(close));
    (globalThis as any).loggerInstance = globalLogger;
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
  }
});
