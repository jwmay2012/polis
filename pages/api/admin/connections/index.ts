import type { NextApiRequest, NextApiResponse } from 'next';

import jackson from '@lib/jackson';
import { oidcMetadataParse, parsePaginateApiParams, strategyChecker } from '@lib/utils';
import { adminPortalSSODefaults, jacksonOptions } from '@lib/env';
import { defaultHandler } from '@lib/api';
import { ApiError } from '@lib/error';
import { collectInventory } from '@lib/admin-inventory';
import { validateDevelopmentModeLimits } from '@lib/development-mode';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  await defaultHandler(req, res, {
    GET: handleGET,
    POST: handlePOST,
    PATCH: handlePATCH,
    DELETE: handleDELETE,
  });
};

// Get all connections
const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const { adminController, connectionAPIController } = await jackson();

  const { isSystemSSO } = req.query as {
    isSystemSSO?: string; // if present will be '' else undefined
  };

  const { pageOffset, pageLimit, pageToken } = parsePaginateApiParams(req.query);

  const { tenant: adminPortalSSOTenant, product: adminPortalSSOProduct } = adminPortalSSODefaults;

  if (req.query.inventory === 'true' && isSystemSSO === undefined) {
    const { product } = req.query;
    if (typeof product !== 'string' || !product) {
      throw new ApiError('Provide a product for the connection inventory.', 400);
    }
    const db = jacksonOptions.db;
    const inventory = await collectInventory(
      (pagination) => connectionAPIController.getConnectionsByProduct({ product, ...pagination }),
      (connection) => ({
        id: connection.clientID,
        name: connection.name,
        tenant: connection.tenant,
        product: connection.product,
        active: !('deactivated' in connection) || connection.deactivated === false,
        isSystemSSO:
          adminPortalSSOTenant === connection.tenant && adminPortalSSOProduct === connection.product,
      }),
      db && 'engine' in db && db.engine === 'dynamodb'
    );
    res.setHeader('jackson-inventory-complete', String(inventory.complete));
    return res.json(inventory.data);
  }

  const paginatedConnectionList = await adminController.getAllConnection(pageOffset, pageLimit, pageToken);

  const connections =
    isSystemSSO === undefined
      ? // For the Connections list under Enterprise SSO, `isSystemSSO` flag added to show system sso badge
        paginatedConnectionList?.data?.map((conn) => ({
          ...conn,
          isSystemSSO: adminPortalSSOTenant === conn.tenant && adminPortalSSOProduct === conn.product,
        }))
      : // For settings view, pagination not done for now as the system connections are expected to be a few
        await connectionAPIController.getConnections({
          tenant: adminPortalSSOTenant,
          product: adminPortalSSOProduct,
        });

  if (paginatedConnectionList.pageToken) {
    res.setHeader('jackson-pagetoken', paginatedConnectionList.pageToken);
  }

  res.json(connections);
};

// Create a new connection
const handlePOST = async (req: NextApiRequest, res: NextApiResponse) => {
  const { connectionAPIController } = await jackson();

  const { isSAML, isOIDC } = strategyChecker(req);

  await validateDevelopmentModeLimits(req.body.product, 'sso');

  if (!isSAML && !isOIDC) {
    throw new ApiError('Missing SSO connection params', 400);
  }

  // Create SAML connection
  if (isSAML) {
    const connection = await connectionAPIController.createSAMLConnection(req.body);
    res.status(201).json({ data: connection });
  } else {
    // Create OIDC connection
    const connection = await connectionAPIController.createOIDCConnection(oidcMetadataParse(req.body));
    res.status(201).json({ data: connection });
  }
};

// Update a connection
const handlePATCH = async (req: NextApiRequest, res: NextApiResponse) => {
  const { connectionAPIController } = await jackson();

  const { isSAML, isOIDC } = strategyChecker(req);

  if (!isSAML && !isOIDC) {
    throw new ApiError('Missing SSO connection params', 400);
  }

  // Update SAML connection
  if (isSAML) {
    await connectionAPIController.updateSAMLConnection(req.body);
    res.status(204).end();
  } else {
    // Update OIDC connection
    await connectionAPIController.updateOIDCConnection(oidcMetadataParse(req.body));
    res.status(204).end();
  }
};

// Delete a connection
const handleDELETE = async (req: NextApiRequest, res: NextApiResponse) => {
  const { connectionAPIController } = await jackson();

  const { clientID, clientSecret } = req.query as {
    clientID: string;
    clientSecret: string;
  };

  await connectionAPIController.deleteConnections({ clientID, clientSecret });

  res.json({ data: null });
};

export default handler;
