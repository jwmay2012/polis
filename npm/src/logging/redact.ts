import { serializeError } from './errors';

export type Secrets = Map<string, string>;
const secretFields = new Set(
  'authorization proxyauthorization cookie setcookie password passwd secret clientsecret clientassertion assertion token accesstoken refreshtoken idtoken code codeverifier codechallenge state relaystate nonce samlrequest samlresponse private privatekey signingkey encryptionkey dburl dsn'.split(
    ' '
  )
);
const urlFields = /(?:url|uri|location|referer|referrer)$/i;

export function redactText(text: string, secrets: Secrets): string {
  if (text === '[REDACTED]') return text;
  for (const [secret, replacement] of [...secrets].sort(([a], [b]) => b.length - a.length)) {
    if (secret.length < 8) {
      const literal = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(?<!\\w)${literal}(?!\\w)`, 'g'), () => replacement);
    } else text = text.split(secret).join(replacement);
  }
  return text;
}

/** Redact a copy, never request objects, response values, or the thrown error. */
export function redact(value: unknown, secrets: Secrets = new Map()): any {
  const seen = new Set<object>();
  const remember = (value: string, replacement: string) => {
    if (!value || value === '[REDACTED]') return;
    for (const variant of [value, encodeURIComponent(value)]) {
      if (replacement === '[REDACTED]' || !secrets.has(variant)) secrets.set(variant, replacement);
    }
  };
  const clean = (value: any, depth = 0, error = false): any => {
    if (value instanceof Error) {
      value = serializeError(value);
      error = true;
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return typeof value === 'bigint' ? String(value) : typeof value === 'function' ? '[Function]' : value;
    }
    if (depth >= 8 || seen.has(value)) return '[Truncated]';
    seen.add(value);
    if (value instanceof Uint8Array) return `[Binary data: ${value.byteLength} bytes]`;
    if (value instanceof Date || value instanceof URL) return String(value);
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, error));
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      const name = key.toLowerCase().replace(/[-_]/g, '');
      const apiKey = name.endsWith('apikey') || name === 'apikeys';
      const credential =
        apiKey ||
        secretFields.has(name) ||
        /(?:password|secret|token|privatekey|signingkey|encryptionkey)(?:verifier)?$/.test(name);
      if (credential && !(error && name === 'code') && item !== null && item !== undefined) {
        const values = Array.isArray(item) ? item : [item];
        const hints = values.map((secret) => {
          const hint = apiKey && typeof secret === 'string' ? secret.slice(-4) : '[REDACTED]';
          if (typeof secret === 'string') {
            remember(secret, hint);
            if (name === 'authorization' || name === 'proxyauthorization') {
              const [scheme, credential] = secret.split(/\s+/, 2);
              if (credential) {
                remember(credential, '[REDACTED]');
                if (scheme.toLowerCase() === 'basic') {
                  const decoded = Buffer.from(credential, 'base64').toString('utf8');
                  remember(decoded.slice(decoded.indexOf(':') + 1), '[REDACTED]');
                }
              }
            } else if (name === 'cookie' || name === 'setcookie') {
              for (const pair of name === 'cookie' ? secret.split(';') : secret.split(';', 1)) {
                const separator = pair.indexOf('=');
                if (separator >= 0) remember(pair.slice(separator + 1).trim(), '[REDACTED]');
              }
            } else if (name === 'dburl' || name === 'dsn') {
              try {
                remember(decodeURIComponent(new URL(secret).password), '[REDACTED]');
              } catch {
                /* Not every DSN is a URL. */
              }
            }
          }
          return hint;
        });
        result[key] = Array.isArray(item) ? hints : hints[0];
      } else if (urlFields.test(name) && Array.isArray(item)) {
        result[key] = item.map((url) => clean({ url }, depth + 1).url);
      } else if (urlFields.test(name) && typeof item === 'string') {
        try {
          // Connection APIs also accept a JSON-encoded redirect URL list.
          if (item.trim().startsWith('[')) {
            const urls = JSON.parse(item);
            if (Array.isArray(urls)) {
              result[key] = JSON.stringify(clean({ [key]: urls }, depth + 1)[key]);
              continue;
            }
          }
          const absolute = /^[a-z][a-z0-9+.-]*:/i.test(item);
          const url = new URL(item, 'http://localhost');
          if (url.password) remember(decodeURIComponent(url.password), '[REDACTED]');
          const setupToken = /^(?:\/api)?\/setup\/([^/]+)/.exec(url.pathname)?.[1];
          if (setupToken) remember(decodeURIComponent(setupToken), '[REDACTED]');
          url.searchParams.forEach((value, key) => clean({ [key]: value }, depth + 1));
          url.username = url.password = url.search = url.hash = '';
          result[key] = absolute ? url.toString() : url.pathname;
        } catch {
          result[key] = '[Invalid URL]';
        }
      } else
        result[key] = clean(
          item,
          depth + 1,
          name === 'err' || (error && ['cause', 'inner', 'errors'].includes(name))
        );
    }
    return result;
  };
  const scrub = (value: any): any => {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  };
  try {
    return scrub(clean(value));
  } catch {
    return '[Unable to serialize log data]';
  }
}
