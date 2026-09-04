/**
 * Domain-based routing utilities for automatic IDP selection
 */

/**
 * Extract domain from login_hint (email address)
 * Handles edge cases like subdomains, invalid emails, etc.
 * @param login_hint - Email address or other login hint
 * @returns Domain part of email (lowercase) or null if invalid
 */
export function extractDomainFromLoginHint(login_hint?: string): string | null {
  if (!login_hint || typeof login_hint !== 'string') {
    return null;
  }

  // Trim whitespace
  const trimmed = login_hint.trim();

  // Basic email validation - must have @ and domain part
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    return null;
  }

  // Extract domain (everything after @)
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return null;
  }

  // Return lowercase domain for case-insensitive comparison
  return parts[1].toLowerCase();
}

/**
 * Filter connections by domain using tenant field
 * @param connections - Array of SSO connections
 * @param domain - Domain to filter by
 * @returns Filtered connections where tenant matches domain
 */
export function filterConnectionsByDomain<T extends { tenant?: string }>(
  connections: T[],
  domain: string | null
): T[] {
  if (!domain || !connections || connections.length === 0) {
    return connections;
  }

  const domainLower = domain.toLowerCase();

  return connections.filter((connection) => {
    // Check if tenant matches domain (case-insensitive)
    return connection.tenant && connection.tenant.toLowerCase() === domainLower;
  });
}
