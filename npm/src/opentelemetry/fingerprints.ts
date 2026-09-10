import { createHash } from 'node:crypto';

export type FingerprintKind =
  'oauth-state' | 'polis-session' | 'oauth-code' | 'id-token' | 'access-token' | 'nonce';

/** Hash parsed protocol values, not URL encodings, lookup suffixes or claims. */
export function fingerprint(kind: FingerprintKind, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return createHash('sha256')
      .update(`${process.env.SSO_TELEMETRY_NAMESPACE || 'polis-sso'}/${kind}/v1:${value}`, 'utf8')
      .digest('hex');
  } catch {
    return undefined;
  }
}
