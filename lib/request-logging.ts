import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { logger } from './logger';
import { bindContext, contextFields, currentLogger, secrets, withContext } from '../npm/src/logging/context';
import { redact } from '../npm/src/logging/redact';

const BODY_LIMIT = 64 * 1024;
const destination = {
  info: (message: string, fields?: any) => logger.info(fields, message),
  warn: (message: string, fields?: any) => logger.warn(fields, message),
  error: (message: string, fields?: any) => logger.error(fields, message),
};

function requestBody(body: unknown) {
  if (body === undefined) return {};
  try {
    if (typeof body !== 'object' || body === null || Buffer.isBuffer(body))
      return { body_omitted: 'Non-JSON or unparsed body' };
    const safe = redact(body, secrets());
    return Buffer.byteLength(JSON.stringify(safe)) <= BODY_LIMIT
      ? { body: safe }
      : { body_omitted: 'Body exceeds capture limit' };
  } catch {
    return { body_omitted: 'Unable to serialize body' };
  }
}

/** Shared API boundary. It observes existing body handling and preserves response bytes. */
export function withRequestLogging<
  T extends (req: NextApiRequest, res: NextApiResponse, ...args: any[]) => any,
>(handler: T): T {
  return ((req: NextApiRequest, res: NextApiResponse, ...args: any[]) =>
    withContext({}, destination, async () => {
      // Register credentials before binding paths (setup tokens can also occur in URLs).
      const request = redact({ headers: req.headers, query: req.query, ...requestBody(req.body) }, secrets());
      const header = (name: string) =>
        typeof req.headers?.[name.toLowerCase()] === 'string' ? req.headers[name.toLowerCase()] : undefined;
      bindContext({
        http_method: req.method,
        http_route: req.url?.split('?')[0],
        request_id: randomUUID(),
        client_request_id: header(process.env.SSO_REQUEST_ID_HEADER || 'x-request-id'),
        client_session_id: header(process.env.SSO_CLIENT_SESSION_ID_HEADER || 'x-session-id'),
      });
      const started = performance.now();
      let finished = false;
      let responseBytes = 0;
      const chunks: Buffer[] = [];
      const write = res.write;
      const end = res.end;
      const writeHead = res.writeHead;
      const sentHeaders: Record<string, any> = {};
      res.writeHead = function (this: NextApiResponse, ...args: any[]) {
        try {
          const headers = typeof args[1] === 'string' ? args[2] : args[1];
          if (Array.isArray(headers)) {
            for (let i = 0; i < headers.length; i += 2)
              sentHeaders[String(headers[i]).toLowerCase()] = headers[i + 1];
          } else if (headers) {
            for (const [key, value] of Object.entries(headers)) sentHeaders[key.toLowerCase()] = value;
          }
        } catch {
          /* Header capture cannot change the response. */
        }
        return writeHead.apply(this, args as any);
      } as typeof res.writeHead;
      const capture = (value: unknown, encoding?: unknown) => {
        if (typeof value !== 'string' && !(value instanceof Uint8Array)) return;
        const chunk =
          typeof value === 'string'
            ? Buffer.from(value, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
            : Buffer.from(value);
        const available = Math.max(0, BODY_LIMIT - responseBytes);
        responseBytes += chunk.length;
        if (available) chunks.push(chunk.subarray(0, available));
      };
      res.write = function (this: NextApiResponse, ...args: any[]) {
        try {
          capture(args[0], args[1]);
        } catch {
          /* Observe, never replace write behavior. */
        }
        return write.apply(this, args as any);
      } as typeof res.write;
      res.end = function (this: NextApiResponse, ...args: any[]) {
        try {
          capture(args[0], args[1]);
        } catch {
          /* Observe, never replace end behavior. */
        }
        return end.apply(this, args as any);
      } as typeof res.end;
      const complete = AsyncResource.bind(() => {
        if (finished) return;
        finished = true;
        res.write = write;
        res.end = end;
        res.writeHead = writeHead;
        res.removeListener?.('finish', complete);
        res.removeListener?.('close', complete);
        const response: Record<string, any> = { headers: { ...res.getHeaders?.(), ...sentHeaders } };
        const completeBody = res.writableFinished;
        if (responseBytes) {
          const contentType = String(response.headers['content-type'] || '').split(';')[0];
          if (!completeBody) response.body_omitted = 'Response did not finish';
          else if (responseBytes > BODY_LIMIT) response.body_omitted = 'Body exceeds capture limit';
          else if (contentType !== 'application/json' && !contentType.endsWith('+json'))
            response.body_omitted = 'Non-JSON body';
          else {
            try {
              response.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              response.body_omitted = 'Invalid JSON body';
            }
          }
        }
        chunks.length = 0;
        const fields = {
          ...contextFields(),
          http_response_status: res.headersSent ? res.statusCode : undefined,
          duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
          response_bytes: responseBytes,
          request,
          response,
        };
        currentLogger().info(
          completeBody ? 'HTTP request completed' : 'HTTP request closed before completion',
          fields
        );
      });
      res.once?.('finish', complete);
      res.once?.('close', complete);
      try {
        return await handler(req, res, ...args);
      } catch (err) {
        currentLogger().error('HTTP request handler failed', { err });
        throw err;
      } finally {
        // Real responses finish asynchronously; lightweight library route fixtures may have no event emitter.
        if (!res.once) complete();
      }
    })) as T;
}
