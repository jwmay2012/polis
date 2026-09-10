import pino, { type Logger, type LoggerOptions } from 'pino';
import fs from 'fs';
import { loggerOptions } from '@lib/env';
import { serializeError } from '../npm/src/logging/errors';
import { contextFields, secrets, registerSecrets } from '../npm/src/logging/context';
import { redact } from '../npm/src/logging/redact';

const isDevelopment = process.env.NODE_ENV !== 'production';
const g = global as any;

export function initLogger(logFile?: string, logLevel?: string): Logger {
  const options: LoggerOptions = {
    level: logLevel || 'info',
    mixin: contextFields,
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
    hooks: {
      logMethod(args, method, level) {
        try {
          if (args[0] instanceof Error) args[0] = { err: args[0] };
          const fields =
            args[0] && typeof args[0] === 'object' ? (args[0] as Record<string, any>) : undefined;
          const caller: { stack?: string } = {};
          if (!fields?.source) Error.captureStackTrace(caller, options.hooks!.logMethod);
          const source =
            fields?.source ||
            caller.stack
              ?.split('\n')
              .slice(1)
              .find((line) => !/node_modules\/(?:pino|@opentelemetry)\//.test(line))
              ?.trim();
          const extra = {
            source,
            ...(level >= 50 && !fields?.err ? { error_stack: fields?.error_stack || caller.stack } : {}),
          };
          if (fields) args[0] = { ...fields, ...extra };
          else args.unshift(extra);
          return method.apply(this, args);
        } catch {
          // Logging failures must not replace application results.
        }
      },
      // Pino's final-output hook also covers messages, interpolation and child bindings.
      streamWrite: (line) => {
        try {
          return JSON.stringify(redact(JSON.parse(line), secrets())) + '\n';
        } catch {
          return JSON.stringify({ level: 50, msg: 'Unable to serialize log entry' }) + '\n';
        }
      },
    },
  };
  return logFile ? pino(options, fs.createWriteStream(logFile)) : pino(options);
}

function initLoggerFromEnv(): Logger {
  if (!g.loggerInstance) {
    registerSecrets({ api_keys: process.env.API_KEYS?.split(','), db_url: process.env.DB_URL });
    g.loggerInstance = initLogger(loggerOptions.file, loggerOptions.level);
  }
  return g.loggerInstance;
}

export const logger = initLoggerFromEnv();
