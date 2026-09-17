import { NextApiRequest, NextApiResponse } from 'next';

import jackson from '@lib/jackson';
import { setErrorCookieAndRedirect } from '@lib/utils';
import { OIDCAuthzResponsePayload } from '@boxyhq/saml-jackson';
import { withRequestLogging } from '@lib/request-logging';
import { logger } from '@lib/logger';

// This endpoint handles OIDC callbacks for public clients (mobile apps, SPAs)
// It's registered in the IdP under "Mobile and desktop applications" platform
// to bypass browser-based Conditional Access restrictions
async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'GET') {
      throw { message: 'Method not allowed', statusCode: 405 };
    }

    const { oauthController } = await jackson();

    const { redirect_url, response_form } = await oauthController.oidcAuthzResponse(
      req.query as OIDCAuthzResponsePayload
    );

    if (redirect_url) {
      res.redirect(302, redirect_url);
    }

    if (response_form) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(response_form);
    }
  } catch (err: any) {
    const { message, statusCode = 500 } = err;
    logger.error({ err }, 'Unable to handle OAuth request');

    setErrorCookieAndRedirect(res, { message, statusCode });
  }
}

export default withRequestLogging(handler);
