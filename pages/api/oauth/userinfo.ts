import { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { extractAuthToken } from '@lib/auth';
import { instrumentSsoRoute, failure } from '@lib/sso-telemetry';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'GET') {
      throw { message: 'Method not allowed', statusCode: 405 };
    }

    const { oauthController } = await jackson();
    let token: string | null = extractAuthToken(req);

    // check for query param
    if (!token) {
      let arr: string[] = [];
      arr = arr.concat(req.query.access_token || '');
      if (arr[0].length > 0) {
        token = arr[0];
      }
    }

    if (!token) {
      failure(
        { name: 'RequestError', message: 'Userinfo token not found in request', statusCode: 401 },
        'access_token_missing',
        'request'
      );
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const profile = await oauthController.userInfo(token);

    res.json(profile);
  } catch (err: any) {
    failure(err);
    const { message, statusCode = 500 } = err;

    res.status(statusCode).json({ message });
  }
}

export default instrumentSsoRoute('userinfo', handler);
