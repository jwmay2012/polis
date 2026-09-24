export type RedirectDefaults = { redirectUrl: string[]; defaultRedirectUrl: string };
export type ConnectionCreationOptions = {
  product?: string;
  products: string[];
  complete: boolean;
  redirects: Array<{
    product: string;
    protocol: 'saml' | 'oidc';
    suggestions: string[];
    defaults?: RedirectDefaults;
  }>;
};

export function connectionCreationOptions(
  connections: Array<RedirectDefaults & { product: string; protocol: 'saml' | 'oidc' }>,
  appProducts: string[],
  preferredProduct: string | undefined,
  complete: boolean
): ConnectionCreationOptions {
  const products = [...new Set([...connections.map((row) => row.product), ...appProducts, preferredProduct])]
    .filter((value): value is string => Boolean(value))
    .sort();
  const redirects: ConnectionCreationOptions['redirects'] = [];
  for (const product of products) {
    for (const protocol of ['saml', 'oidc'] as const) {
      const rows = connections.filter((row) => row.product === product && row.protocol === protocol);
      if (!rows.length) continue;
      const configurations = new Map(
        rows.map((row) => {
          const redirectUrl = [...new Set(row.redirectUrl)].sort();
          const value = { redirectUrl, defaultRedirectUrl: row.defaultRedirectUrl };
          return [JSON.stringify(value), value];
        })
      );
      redirects.push({
        product,
        protocol,
        suggestions: [...new Set(rows.flatMap((row) => row.redirectUrl))].sort(),
        ...(complete && configurations.size === 1 ? { defaults: [...configurations.values()][0] } : {}),
      });
    }
  }
  return {
    product: preferredProduct || (complete && products.length === 1 ? products[0] : undefined),
    products,
    redirects,
    complete,
  };
}
