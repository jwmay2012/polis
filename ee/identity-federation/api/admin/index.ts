import type { NextApiRequest, NextApiResponse } from 'next';

import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { parsePaginateApiParams } from '@lib/utils';
import { validateDevelopmentModeLimits } from '@lib/development-mode';
import { collectInventory } from '@lib/admin-inventory';
import { jacksonOptions } from '@lib/env';
import { ApiError } from '@lib/error';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  await defaultHandler(req, res, {
    GET: handleGET,
    POST: handlePOST,
  });
};

// Create new Identity Federation app
const handlePOST = async (req: NextApiRequest, res: NextApiResponse) => {
  const { identityFederationController } = await jackson();

  await validateDevelopmentModeLimits(
    req.body.product,
    'identityFederation',
    'Maximum number of federation apps reached'
  );

  const app = await identityFederationController.app.create(req.body);

  res.status(201).json({ data: app });
};

// Get Identity Federation apps
const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const { identityFederationController } = await jackson();

  if (req.query.inventory === 'true') {
    const { product } = req.query;
    if (typeof product !== 'string' || !product) {
      throw new ApiError('Provide a product for the application inventory.', 400);
    }
    const db = jacksonOptions.db;
    const inventory = await collectInventory(
      (pagination) => identityFederationController.app.getByProduct({ product, ...pagination }),
      (app) => ({
        id: app.id,
        name: app.name,
        type: app.type,
        tenant: app.tenant,
        product: app.product,
        tenants: app.tenants,
      }),
      db && 'engine' in db && db.engine === 'dynamodb'
    );
    res.setHeader('jackson-inventory-complete', String(inventory.complete));
    return res.json({ data: inventory.data });
  }

  const { pageOffset, pageLimit, pageToken } = parsePaginateApiParams(req.query);

  const apps = await identityFederationController.app.getAll({
    pageOffset,
    pageLimit,
    pageToken,
  });

  if (apps.pageToken) {
    res.setHeader('jackson-pagetoken', apps.pageToken);
  }

  res.json({ data: apps.data });
};

export default handler;
