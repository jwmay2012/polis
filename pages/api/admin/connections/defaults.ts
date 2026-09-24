import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { GET: read });
}

async function read(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const id = process.env.SSO_DISCOVERY_APP_ID;
  if (!id) return res.json({});
  const { identityFederationController } = await jackson();
  const app = await identityFederationController.app.get({ id });
  res.json({ product: app.product });
}
