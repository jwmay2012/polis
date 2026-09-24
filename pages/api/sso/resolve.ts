import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { logger } from '@lib/logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { POST: resolve });
}

async function resolve(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (
    !req.body ||
    typeof req.body.email !== 'string' ||
    Object.keys(req.body).some((key) => key !== 'email')
  ) {
    res.status(400).json({ error: 'Provide only a full email address.' });
    return;
  }
  const app = process.env.SSO_DISCOVERY_APP_ID;
  if (!app) {
    logger.warn('SSO discovery application is not configured');
    res.status(503).json({ error: 'SSO discovery is unavailable.' });
    return;
  }
  try {
    const { routingController } = await jackson();
    const result = await routingController.lookup(app, req.body.email);
    if (result.status === 'route') res.json({ required: true, idp_hint: result.connection.clientID });
    else if (result.status === 'unavailable')
      res.json({ required: true, idp_hint: null, reason: result.reason });
    else if (result.status === 'none') res.json({ required: false });
    else {
      logger.warn(
        { federation_app_id: app },
        'SSO discovery is not enabled until the application routing import is complete'
      );
      res.status(503).json({ error: 'SSO discovery is unavailable.' });
    }
  } catch (err) {
    logger.warn({ err }, 'Unable to resolve SSO connection');
    const invalid = err instanceof Error && 'statusCode' in err && err.statusCode === 400;
    res
      .status(invalid ? 400 : 503)
      .json({ error: invalid ? 'Enter a valid email address.' : 'SSO discovery is unavailable.' });
  }
}
