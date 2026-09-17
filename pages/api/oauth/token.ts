import { NextApiRequest, NextApiResponse } from 'next';

import jackson from '@lib/jackson';
import { cors } from '@lib/middleware';
import { withRequestLogging } from '@lib/request-logging';
import { logger } from '@lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    await cors(req, res);

    if (req.method !== 'POST') {
      throw { message: 'Method not allowed', statusCode: 405 };
    }

    const { oauthController } = await jackson();
    const authHeader = req.headers['authorization'];
    const result = await oauthController.token(req.body, authHeader);

    res.json(result);
  } catch (err: any) {
    logger.error({ err }, 'Unable to handle OAuth request');
    const { message, statusCode = 500 } = err;

    res.status(statusCode).send(message);
  }
}

export default withRequestLogging(handler);
