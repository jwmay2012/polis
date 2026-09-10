import pino, { type Logger } from 'pino';
import fs from 'fs';
import { loggerOptions } from '@lib/env';
import { serializeError } from '../npm/src/opentelemetry/errors';
import type { SsoEvent } from '../npm/src/opentelemetry/telemetry';
import { logContextFields } from '../npm/src/opentelemetry/telemetry';

const isDevelopment = process.env.NODE_ENV !== 'production';
const g = global as any;

export function initLogger(logFile?: string, logLevel?: string): Logger {
  if (logFile) {
    return pino(fs.createWriteStream(logFile));
  }

  return pino({
    level: logLevel || 'info',
    mixin: logContextFields,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    transport: isDevelopment
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
    serializers: {
      err: serializeError,
    },
  });
}

function initLoggerFromEnv(): Logger {
  if (!g.loggerInstance) {
    g.loggerInstance = initLogger(loggerOptions.file, loggerOptions.level);
  }
  return g.loggerInstance;
}

export const logger = initLoggerFromEnv();

export const emitSsoEvent = ({ severity, msg, ...fields }: SsoEvent) => {
  logger[severity](fields, msg);
};
