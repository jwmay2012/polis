import type { NextApiRequest, NextApiResponse } from 'next';
import { withSsoTelemetry, failure, fingerprint } from '../npm/src/opentelemetry/telemetry';
import { emitSsoEvent } from './logger';

export { failure };

export function instrumentSsoRoute(
  operation: string,
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>
) {
  return (req: NextApiRequest, res: NextApiResponse) => {
    const input = req.method === 'GET' ? req.query : req.body;
    const params = input && typeof input === 'object' ? input : {};
    const email = typeof params.login_hint === 'string' ? params.login_hint : undefined;
    const entryFields =
      operation === 'authorize'
        ? {
            requested_email: email,
            user_email: email,
            downstream_client_id: typeof params.client_id === 'string' ? params.client_id : undefined,
            downstream_state_fp: fingerprint('oauth-state', params.state),
            downstream_nonce_fp: fingerprint('nonce', params.nonce),
          }
        : operation.endsWith('_callback')
          ? {
              upstream_state_fp: fingerprint('oauth-state', params.state ?? params.RelayState),
            }
          : operation === 'token'
            ? {
                authorization_code_fp: fingerprint('oauth-code', params.code),
              }
            : {};
    const header = (name: string) => {
      const value = req.headers?.[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    };
    return withSsoTelemetry(
      operation,
      {
        telemetry: emitSsoEvent,
        fields: {
          ...entryFields,
          http_method: req.method,
          http_route: req.url?.split('?')[0],
          callback_route: operation.endsWith('_callback') ? req.url?.split('?')[0] : undefined,
          request_id: header(process.env.SSO_REQUEST_ID_HEADER || 'x-request-id'),
          client_session_id: header(process.env.SSO_CLIENT_SESSION_ID_HEADER || 'x-session-id'),
        },
        // An uncaught framework error may not have produced its HTTP response
        // yet. Do not report Node's default 200 as an observed response.
        responseStatus: () => (res.headersSent ? res.statusCode : undefined),
      },
      () => handler(req, res)
    );
  };
}
