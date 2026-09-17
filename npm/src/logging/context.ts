import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  isSpanContextValid,
  type Attributes,
  type Span,
  type SpanContext,
} from '@opentelemetry/api';
import type { RequiredLogger } from '../typings';
import { serializeError } from './errors';
import { redact, type Secrets } from './redact';

export type LogFields = Record<string, any>;
type RequestContext = {
  fields: LogFields;
  secrets: Secrets;
  logger: RequiredLogger;
  span?: Span;
  links: Set<string>;
  loggedErrors: WeakSet<object>;
};

// Next loads separate server bundles. Share the carrier, never a global current user.
const key = Symbol.for('polis.logging.context.v1');
const globals = globalThis as any;
const storage: AsyncLocalStorage<RequestContext> = (globals[key] ??= new AsyncLocalStorage<RequestContext>());
const tracer = trace.getTracer('polis.logging', '1');
const defaults: RequiredLogger = { info: console.info, warn: console.warn, error: console.error };
const configuredSecrets: Secrets = (globals[Symbol.for('polis.logging.secrets.v1')] ??= new Map());
const contextual = Symbol.for('polis.logging.logger.v1');
const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);

export function currentContext() {
  return storage.getStore();
}

export function secrets(): Secrets {
  return storage.getStore()?.secrets || new Map(configuredSecrets);
}

export function registerSecrets(values: LogFields) {
  redact(values, configuredSecrets);
}

export function contextFields(): LogFields {
  const state = storage.getStore();
  const fields = { ...state?.fields };
  try {
    const sc = (trace.getActiveSpan() || state?.span)?.spanContext();
    if (sc && isSpanContextValid(sc)) {
      Object.assign(fields, { trace_id: sc.traceId, span_id: sc.spanId });
      if (state && !state.fields.trace_id)
        Object.assign(state.fields, { trace_id: sc.traceId, span_id: sc.spanId });
    }
  } catch {
    // Logging must also work without a functioning tracing SDK.
  }
  return fields;
}

export function bindContext(fields: LogFields) {
  const state = storage.getStore();
  if (!state) return;
  const values = redact(fields, state.secrets);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) state.fields[key] = value;
  try {
    const attributes = Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => scalar(value))
        .map(([key, value]) => [`sso.${key}`, value])
    ) as Attributes;
    state.span?.setAttributes(attributes);
    trace.getActiveSpan()?.setAttributes(attributes);
  } catch {
    // Context enrichment cannot change application behavior.
  }
}

/** Preserve the library's existing message-first logger contract. */
export function contextualLogger(sink: Partial<RequiredLogger> = {}): RequiredLogger {
  if ((sink as any)[contextual]) return sink as RequiredLogger;
  const destination = { ...defaults, ...sink };
  const write = (level: keyof RequiredLogger, message: string, data?: any) => {
    try {
      const caller: { stack?: string } = {};
      Error.captureStackTrace(caller, logger[level]);
      const fields =
        data instanceof Error
          ? { err: data }
          : data && typeof data === 'object'
            ? data
            : data === undefined
              ? {}
              : { detail: data };
      if (level === 'error' && fields.err && typeof fields.err === 'object')
        storage.getStore()?.loggedErrors.add(fields.err);
      const row = redact(
        {
          ...contextFields(),
          ...fields,
          source: caller.stack?.split('\n')[1]?.trim(),
          msg: message,
          ...(level === 'error' && !fields.err ? { error_stack: caller.stack } : {}),
        },
        secrets()
      );
      const { msg, ...extra } = row;
      if (level === 'error')
        markOperationFailed(extra.err || { name: 'Error', message: msg, stack: extra.error_stack });
      const pending = destination[level](msg, extra) as unknown as Promise<unknown> | undefined;
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    } catch {
      // A failed logging destination must not fail or repeat the caller's operation.
    }
  };
  const logger = {
    [contextual]: true,
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  } as RequiredLogger;
  return logger;
}

export function currentLogger(): RequiredLogger {
  return storage.getStore()?.logger || contextualLogger();
}

export function withContext<T>(fields: LogFields, logger: Partial<RequiredLogger>, work: () => T): T {
  if (storage.getStore()) {
    bindContext(fields);
    return work();
  }
  const state: RequestContext = {
    fields: {
      fingerprint_namespace: process.env.SSO_TELEMETRY_NAMESPACE || 'polis-sso',
      telemetry_version: 1,
    },
    secrets: new Map(configuredSecrets),
    logger: contextualLogger(logger),
    links: new Set(),
    loggedErrors: new WeakSet(),
  };
  return storage.run(state, () => {
    bindContext(fields);
    return work();
  });
}

export function detachedFromRequest<T>(work: () => T): T {
  return storage.exit(() => context.with(ROOT_CONTEXT, work));
}

export function markOperationFailed(error: unknown) {
  const span = storage.getStore()?.span;
  const detail = redact(serializeError(error), secrets());
  try {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: detail.message });
    span?.recordException({ name: detail.type, message: detail.message, stack: detail.stack });
  } catch {
    // Tracing never changes the error propagated to the caller.
  }
}

/** One scope around a public controller operation, not a span around every check. */
export function logOperation(_target: unknown, name: string, descriptor: PropertyDescriptor) {
  const original = descriptor.value;
  descriptor.value = function (this: { opts?: { logger?: Partial<RequiredLogger> } }, ...args: any[]) {
    return withContext({ operation: name }, this.opts?.logger || {}, async () => {
      const state = storage.getStore()!;
      redact(args, state.secrets);
      const previous = state.span;
      let span: Span | undefined;
      try {
        span = tracer.startSpan(`polis.${name}`);
      } catch {
        // The operation still runs exactly once if tracing is unavailable.
      }
      state.span = span;
      const work = async () => {
        try {
          return await original.apply(this, args);
        } catch (err) {
          if (!err || typeof err !== 'object' || !state.loggedErrors.has(err))
            currentLogger().error(`Unable to complete ${name}`, { err });
          throw err;
        } finally {
          state.span = previous;
          try {
            span?.end();
          } catch {
            /* Do not replace an application result. */
          }
        }
      };
      if (!span) return work();
      let invoked = false;
      try {
        return context.with(trace.setSpan(context.active(), span), () => {
          invoked = true;
          return work();
        });
      } catch (err) {
        if (invoked) throw err;
        return work();
      }
    });
  };
}

export function continuationSpan(): SpanContext | undefined {
  try {
    const sc = (storage.getStore()?.span || trace.getActiveSpan())?.spanContext();
    return sc && isSpanContextValid(sc)
      ? { traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags }
      : undefined;
  } catch {
    return undefined;
  }
}

export function linkContext(sc: SpanContext) {
  const state = storage.getStore();
  if (!state || !isSpanContextValid(sc)) return;
  const key = `${sc.traceId}/${sc.spanId}`;
  if (state.links.has(key)) return;
  state.links.add(key);
  try {
    state.span?.addLink({ context: sc, attributes: { 'sso.link.type': 'continuation' } });
    bindContext({ linked_trace_id: sc.traceId, linked_span_id: sc.spanId });
  } catch {
    // A saved link is diagnostic, never a new parent or an auth requirement.
  }
}
