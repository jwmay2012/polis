import tap from 'tap';
import { extractDomainFromLoginHint, filterConnectionsByDomain } from '../../src/controller/domain-utils';

tap.test('Domain Utils', async () => {
  tap.test('extractDomainFromLoginHint', async () => {
    tap.test('should extract domain from valid email', async (t) => {
      t.equal(extractDomainFromLoginHint('user@example.com'), 'example.com', 'extracts simple domain');
      t.equal(
        extractDomainFromLoginHint('test.user@subdomain.example.com'),
        'subdomain.example.com',
        'extracts subdomain'
      );
      t.equal(extractDomainFromLoginHint('admin@acres.com'), 'acres.com', 'extracts acres.com');
    });

    tap.test('should handle edge cases', async (t) => {
      t.equal(extractDomainFromLoginHint(null as any), null, 'handles null');
      t.equal(extractDomainFromLoginHint(undefined), null, 'handles undefined');
      t.equal(extractDomainFromLoginHint(''), null, 'handles empty string');
      t.equal(extractDomainFromLoginHint('  '), null, 'handles whitespace only');
      t.equal(extractDomainFromLoginHint('notanemail'), null, 'handles invalid email');
      t.equal(extractDomainFromLoginHint('user@'), null, 'handles missing domain');
      t.equal(extractDomainFromLoginHint('@example.com'), null, 'handles missing user');
      t.equal(extractDomainFromLoginHint('user@@example.com'), null, 'handles double @');
      t.equal(extractDomainFromLoginHint('user@domain'), null, 'handles missing TLD');
    });

    tap.test('should normalize to lowercase', async (t) => {
      t.equal(extractDomainFromLoginHint('User@EXAMPLE.COM'), 'example.com', 'converts to lowercase');
      t.equal(extractDomainFromLoginHint('test@AcRes.COM'), 'acres.com', 'converts mixed case');
    });

    tap.test('should trim whitespace', async (t) => {
      t.equal(extractDomainFromLoginHint('  user@example.com  '), 'example.com', 'trims spaces');
      t.equal(extractDomainFromLoginHint('\tuser@example.com\n'), 'example.com', 'trims tabs and newlines');
    });
  });

  tap.test('filterConnectionsByDomain', async () => {
    const mockConnections = [
      { tenant: 'example.com', clientID: '1', name: 'Example SSO' },
      { tenant: 'acres.com', clientID: '2', name: 'Acres SSO' },
      { tenant: 'century.com', clientID: '3', name: 'Century SSO' },
      { tenant: 'UPPERCASE.COM', clientID: '4', name: 'Uppercase SSO' },
    ];

    tap.test('should filter by exact tenant match', async (t) => {
      const result = filterConnectionsByDomain(mockConnections, 'acres.com');
      t.equal(result.length, 1, 'returns one connection');
      t.equal(result[0].clientID, '2', 'returns correct connection');
      t.equal(result[0].name, 'Acres SSO', 'returns correct name');
    });

    tap.test('should be case insensitive', async (t) => {
      const result = filterConnectionsByDomain(mockConnections, 'uppercase.com');
      t.equal(result.length, 1, 'finds uppercase connection');
      t.equal(result[0].clientID, '4', 'returns correct connection');
    });

    tap.test('should return empty array when no matches', async (t) => {
      const result = filterConnectionsByDomain(mockConnections, 'notfound.com');
      t.equal(result.length, 0, 'returns empty array');
    });

    tap.test('should return all connections when domain is null', async (t) => {
      const result = filterConnectionsByDomain(mockConnections, null);
      t.equal(result.length, 4, 'returns all connections for null');
    });

    tap.test('should return all connections when domain is empty', async (t) => {
      const result = filterConnectionsByDomain(mockConnections, '');
      t.equal(result.length, 4, 'returns all connections for empty string');
    });

    tap.test('should handle empty connections array', async (t) => {
      const result = filterConnectionsByDomain([], 'example.com');
      t.equal(result.length, 0, 'returns empty for empty input');
    });

    tap.test('should handle connections without tenant field', async (t) => {
      const connectionsWithMissingTenant = [
        { clientID: '1', name: 'No Tenant' },
        { tenant: 'example.com', clientID: '2', name: 'With Tenant' },
      ];
      const result = filterConnectionsByDomain(connectionsWithMissingTenant, 'example.com');
      t.equal(result.length, 1, 'filters out connections without tenant');
      t.equal(result[0].clientID, '2', 'returns connection with matching tenant');
    });
  });
});
