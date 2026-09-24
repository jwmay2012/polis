import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { collectInventory } from '@lib/admin-inventory';
import { connectionCreationOptions } from '@lib/connection-defaults';
import { adminPortalSSODefaults, jacksonOptions } from '@lib/env';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { GET: read });
}

async function read(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const id = process.env.SSO_DISCOVERY_APP_ID;
  const { identityFederationController, adminController } = await jackson();
  const db = jacksonOptions.db;
  const cursorOnly = db && 'engine' in db && db.engine === 'dynamodb';
  const [connections, apps] = await Promise.all([
    collectInventory(
      ({ pageOffset, pageLimit, pageToken }) =>
        adminController.getAllConnection(pageOffset, pageLimit, pageToken),
      (row) => ({
        id: row.clientID,
        tenant: row.tenant,
        product: row.product,
        protocol: 'oidcProvider' in row ? ('oidc' as const) : ('saml' as const),
        redirectUrl: Array.isArray(row.redirectUrl) ? row.redirectUrl : [row.redirectUrl],
        defaultRedirectUrl: row.defaultRedirectUrl,
      }),
      cursorOnly
    ),
    collectInventory(
      (pagination) => identityFederationController.app.getAll(pagination),
      (row) => ({ id: row.id, product: row.product }),
      cursorOnly
    ),
  ]);
  const configured = id ? await identityFederationController.app.get({ id }) : undefined;
  res.json(
    connectionCreationOptions(
      connections.data.filter(
        (row) =>
          row.tenant !== adminPortalSSODefaults.tenant || row.product !== adminPortalSSODefaults.product
      ),
      apps.data.filter((row) => row.product !== adminPortalSSODefaults.product).map((row) => row.product),
      configured?.product,
      connections.complete && apps.complete
    )
  );
}
