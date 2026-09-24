export type ConnectionCreationOptions = { product?: string; products: string[]; complete: boolean };

export function connectionCreationOptions(
  connectionProducts: string[],
  appProducts: string[],
  preferredProduct: string | undefined,
  complete: boolean
): ConnectionCreationOptions {
  const products = [...new Set([...connectionProducts, ...appProducts, preferredProduct])]
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    product: preferredProduct || (complete && products.length === 1 ? products[0] : undefined),
    products,
    complete,
  };
}
