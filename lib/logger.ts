import pino, { type Logger, type LoggerOptions } from 'pino';
import fs from 'fs';
import { loggerOptions } from '@lib/env';
import { serializeError } from '../npm/src/opentelemetry/errors';
import type { SsoEvent } from '../npm/src/opentelemetry/telemetry';
import { logContextFields } from '../npm/src/opentelemetry/telemetry';

const isDevelopment = process.env.NODE_ENV !== 'production';
const g = global as any;

export function initLogger(logFile?: string, logLevel?: string): Logger {
  const options: LoggerOptions = {
    level: logLevel || 'info',
    mixin: logContextFields,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    transport:
      isDevelopment && !logFile
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
  };
  return logFile ? pino(options, fs.createWriteStream(logFile)) : pino(options);
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
