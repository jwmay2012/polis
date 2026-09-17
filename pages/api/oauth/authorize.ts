import { NextApiRequest, NextApiResponse } from 'next';

import jackson from '@lib/jackson';
import { OAuthReq } from '@boxyhq/saml-jackson';
import { setErrorCookieAndRedirect } from '@lib/utils';
import { withRequestLogging } from '@lib/request-logging';
import { logger } from '@lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      throw { message: 'Method not allowed', statusCode: 405 };
    }

    const { oauthController } = await jackson();
    const requestParams = req.method === 'GET' ? req.query : req.body;
    const { redirect_url, authorize_form } = await oauthController.authorize(
      requestParams as unknown as OAuthReq
    );
    if (redirect_url) {
      res.redirect(302, redirect_url);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(authorize_form);
    }
  } catch (err: any) {
    logger.error({ err }, 'Unable to handle OAuth request');
    const { message, statusCode = 500 } = err;

    setErrorCookieAndRedirect(res, { message, statusCode });
  }
}

export default withRequestLogging(handler);
