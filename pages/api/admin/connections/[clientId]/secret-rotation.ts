import type { NextApiRequest, NextApiResponse } from 'next';
import { getToken } from 'next-auth/jwt';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { ApiError } from '@lib/error';
import { sessionName } from '@lib/constants';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { GET: read, POST: write });
}

async function context(req: NextApiRequest) {
  const token = await getToken({ req, cookieName: sessionName });
  if (!token) throw new ApiError('Unauthorized', 401);
  const { clientId } = req.query;
  if (typeof clientId !== 'string' || !clientId) throw new ApiError('Provide a connection.', 400);
  const { oidcSecretRotationController } = await jackson();
  return {
    clientId,
    rotation: oidcSecretRotationController,
    actor: {
      id: token.sub,
      email: typeof token.email === 'string' ? token.email : undefined,
    },
  };
}

async function read(req: NextApiRequest, res: NextApiResponse) {
  const { clientId, rotation } = await context(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await rotation.status(clientId));
}

async function write(req: NextApiRequest, res: NextApiResponse) {
  const { clientId, rotation, actor } = await context(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await rotation.change(clientId, req.body || {}, actor));
}
