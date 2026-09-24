import type { NextApiRequest, NextApiResponse } from 'next';
import jackson from '@lib/jackson';
import { defaultHandler } from '@lib/api';
import { ApiError } from '@lib/error';
import { logger } from '@lib/logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await defaultHandler(req, res, { GET: read, POST: write });
}

async function context(req: NextApiRequest) {
  const { clientId, app } = req.query;
  if (typeof clientId !== 'string' || typeof app !== 'string' || !app)
    throw new ApiError('Provide a connection and application.', 400);
  const controllers = await jackson();
  const application = await controllers.identityFederationController.app.get({ id: app });
  const [connection] = await controllers.connectionAPIController.getConnections({ clientID: clientId });
  if (!connection) throw new ApiError('Connection not found.', 404);
  if (connection.product !== application.product)
    throw new ApiError('Application and connection products must match.', 400);
  return { ...controllers, clientId, app, application, connection };
}

async function read(req: NextApiRequest, res: NextApiResponse) {
  const { routingController: routing, clientId, app, application, connection } = await context(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    draft: await routing.draft(clientId),
    managed: await routing.managed(app),
    routes: (await routing.list({ app })).filter((route) => route.connectionID === clientId),
    eligible: application.tenants?.length
      ? application.tenants.includes(connection.tenant)
      : application.tenant === connection.tenant,
    active: !connection.deactivated,
    target: { name: connection.name, tenant: connection.tenant },
  });
}

async function write(req: NextApiRequest, res: NextApiResponse) {
  const { routingController: routing, connectionAPIController, clientId, app } = await context(req);
  const body = req.body || {};
  if (body.action === 'draft') res.json(await routing.saveDraft(clientId, body.matches));
  else if (body.action === 'preview') res.json(await routing.preview(app, body.matches));
  else if (body.action === 'managed') {
    if (
      typeof body.enabled !== 'boolean' ||
      !(body.expectedRevision === null || typeof body.expectedRevision === 'string')
    )
      throw new ApiError('Provide routing mode and its expected revision.', 400);
    res.json(await routing.setManaged(app, body.enabled, body.expectedRevision));
  } else if (body.action === 'withdraw') {
    if (typeof body.match !== 'string' || typeof body.expectedRevision !== 'string')
      throw new ApiError('Provide a match and its expected revision.', 400);
    const [current] = await routing.preview(app, [body.match]);
    if (current.route?.connectionID !== clientId)
      throw new ApiError('This connection no longer owns that match.', 409);
    await routing.withdraw(app, body.match, body.expectedRevision);
    res.json({ withdrawn: body.match });
  } else if (body.action === 'publish' || body.action === 'import') {
    if (
      !Array.isArray(body.matches) ||
      !body.matches.length ||
      body.matches.length > 100 ||
      body.matches.some(
        (item) =>
          !item ||
          typeof item.match !== 'string' ||
          !(item.expectedRevision === null || typeof item.expectedRevision === 'string')
      )
    )
      throw new ApiError('Provide matches with the revisions shown in the confirmation.', 400);
    const results: Array<{ match: string; route?: unknown; error?: string }> = [];
    let stopped = false;
    for (const item of body.matches) {
      if (stopped) {
        results.push({
          match: item.match,
          error: 'Not attempted after an earlier publication failed. Reload before retrying.',
        });
        continue;
      }
      try {
        const route = await routing.publish({
          app,
          match: item.match,
          connectionID: clientId,
          expectedRevision: item.expectedRevision,
          importLegacy: body.action === 'import',
        });
        results.push({ match: item.match, route });
      } catch (err) {
        logger.warn({ err, match: item.match, federation_app_id: app }, 'Unable to publish SSO route');
        const conflict = err instanceof Error && 'statusCode' in err && err.statusCode === 409;
        results.push({
          match: item.match,
          error: conflict
            ? err.message
            : 'Publication failed. Reload to verify the saved state before retrying.',
        });
        stopped = !conflict;
      }
    }
    res.json({ results });
  } else if (body.action === 'retire') {
    if (
      typeof body.previousConnectionID !== 'string' ||
      body.previousConnectionID === clientId ||
      !Array.isArray(body.moves) ||
      !body.moves.length ||
      body.moves.length > 100
    )
      throw new ApiError('Provide the former connection and the confirmed moves.', 400);
    for (const move of body.moves) {
      if (!move || typeof move.match !== 'string' || typeof move.revision !== 'string')
        throw new ApiError('Provide the confirmed route revisions.', 400);
      const [current] = await routing.preview(app, [move.match]);
      if (
        current.route?.connectionID !== clientId ||
        current.route.revision !== move.revision ||
        current.route.previousConnectionID !== body.previousConnectionID
      )
        throw new ApiError(
          'Routing changed after the move. Reload before disabling the former connection.',
          409
        );
    }
    const remaining = await routing.list({ connectionID: body.previousConnectionID });
    if (remaining.length) {
      res.json({ disabled: false, remaining });
      return;
    }
    const [previous] = await connectionAPIController.getConnections({ clientID: body.previousConnectionID });
    if (!previous) throw new ApiError('The former connection no longer exists.', 404);
    const update = {
      clientID: previous.clientID,
      clientSecret: previous.clientSecret,
      tenant: previous.tenant,
      product: previous.product,
      deactivated: true,
    };
    if ('oidcProvider' in previous) await connectionAPIController.updateOIDCConnection(update);
    else await connectionAPIController.updateSAMLConnection(update);
    res.json({ disabled: true });
  } else throw new ApiError('Unknown routing action.', 400);
}
