import { logger } from '@lib/logger';
import { ApiError } from '../error';
import type { NextApiRequest, NextApiResponse } from 'next';
import { failureFields, failureSeverity } from '../../npm/src/opentelemetry/errors';

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type Handlers = {
  [method in HTTPMethod]?: (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
};

export const defaultHandler = async (req: NextApiRequest, res: NextApiResponse, handlers: Handlers) => {
  try {
    // Get the handler for the request
    const handler = handlers[req.method as HTTPMethod];
    const allowedMethods = Object.keys(handlers).join(', ');

    if (!handler) {
      res.setHeader('Allow', allowedMethods);
      throw new ApiError(`Method ${req.method} not allowed.`, 405);
    }

    // Call the handler
    await handler(req, res);
    return;
  } catch (err: any) {
    const message = err.message || 'Internal Server Error';
    const status = err.statusCode || 500;

    const diagnostic = failureFields(
      err,
      'management_api',
      status < 500 ? 'management_request_rejected' : 'management_operation_failed'
    );
    logger[failureSeverity(diagnostic)](
      {
        ...diagnostic,
        http_method: req.method,
        http_route: req.url?.split('?')[0],
        http_response_status: status,
      },
      `${req.method} ${req.url?.split('?')[0]} - ${status} - ${message}`
    );

    res.status(status).json({ error: { message } });
  }
};
