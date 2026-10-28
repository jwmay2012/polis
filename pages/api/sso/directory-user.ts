import { createHmac, timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { ApiError } from '@lib/error';

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { POST: readUser });
}

async function readUser(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4096) throw new ApiError('Directory request is too large.', 413);
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError('Invalid directory request.', 400);
  }
  if (
    !body ||
    Object.keys(body).some((key) => !['directory_id', 'user_id'].includes(key)) ||
    ['directory_id', 'user_id'].some(
      (key) => typeof body[key] !== 'string' || !body[key] || body[key].length > 255
    )
  )
    throw new ApiError('Provide a directory ID and user ID.', 400);
  const header = req.headers['ory-polis-signature'];
  const signature = typeof header === 'string' ? /^t=(\d{10,16}),s=([a-f0-9]{64})$/.exec(header) : null;
  if (!signature || Math.abs(Date.now() - Number(signature[1])) > 300000)
    throw new ApiError('Unauthorized', 401);
  const { directorySyncController: sync } = await jackson();
  const { data: directory, error } = await sync.directories.get(body.directory_id);
  if (error && error.code !== 404) throw new ApiError('Directory is unavailable.', 503);
  if (!directory?.webhook.secret) throw new ApiError('Unauthorized', 401);
  const expected = createHmac('sha256', directory.webhook.secret)
    .update(signature[1] + '.')
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature[2], 'hex'))) throw new ApiError('Unauthorized', 401);
  const user = await sync.users
    .setTenantAndProduct(directory.tenant, directory.product)
    .get(body.user_id, directory.id);
  if (user.error && user.error.code !== 404) throw new ApiError('Directory user is unavailable.', 503);
  const current = user.data;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  res.json({
    tenant: directory.tenant,
    product: directory.product,
    user: current
      ? {
          id: current.id,
          email: text(current.email),
          first_name: text(current.first_name),
          last_name: text(current.last_name),
          active: typeof current.active === 'boolean' ? current.active : null,
          raw:
            current.raw && 'emails' in current.raw
              ? {
                  emails: Array.isArray(current.raw.emails)
                    ? current.raw.emails.map((email) =>
                        email && typeof email === 'object'
                          ? {
                              value: text(email.value),
                              type: text(email.type),
                              primary: email.primary === true,
                            }
                          : null
                      )
                    : null,
                }
              : {},
        }
      : null,
  });
}
