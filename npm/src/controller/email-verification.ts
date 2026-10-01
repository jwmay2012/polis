import type { RoutingController } from './routing';

export type EmailVerification = { email: string; verified?: boolean };

// Keep verification paired with the selected email before ID-token/UserInfo maps are merged.
export function emailVerification(
  email: unknown,
  sources: Record<string, unknown>[]
): EmailVerification | null {
  if (typeof email !== 'string' || !email.trim()) return null;
  const key = email.trim().toLowerCase();
  let verified: boolean | undefined;
  for (const source of sources) {
    if (typeof source.email === 'string' && source.email.trim().toLowerCase() !== key)
      return { email, verified: false };
    if (!Object.prototype.hasOwnProperty.call(source, 'email_verified')) continue;
    const claim =
      Array.isArray(source.email_verified) && source.email_verified.length === 1
        ? source.email_verified[0]
        : source.email_verified;
    if ((claim !== true && claim !== 'true') || typeof source.email !== 'string')
      return { email, verified: false };
    verified = true;
  }
  return { email, ...(verified === undefined ? {} : { verified }) };
}

export async function verifiedEnterpriseEmail(
  evidence: EmailVerification | null | undefined,
  connectionID: string,
  appID: string | undefined,
  routing: RoutingController | undefined
): Promise<boolean> {
  // Missing evidence means an old code/profile, not a provider with an absent claim.
  if (!evidence || evidence.verified === false || !appID || !routing) return false;
  const route = await routing.lookup(appID, evidence.email, false);
  return route.status === 'route' && route.connection.clientID === connectionID;
}

export function publicProfile(claims: Record<string, any>, verified: unknown, flatten: boolean) {
  // Raw attributes are untrusted even after protocol validation. They cannot replace broker-owned facts.
  const profile = flatten ? { ...claims, ...claims.raw } : { ...claims };
  if (flatten) delete profile.raw;
  profile.email = claims.email;
  profile.email_verified = verified === true;
  return profile;
}
