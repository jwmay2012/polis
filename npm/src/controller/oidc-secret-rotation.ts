import { randomUUID } from 'crypto';
import type { OIDCSSORecord, RequiredLogger, Storable } from '../typings';
import { extractDomainFromLoginHint } from './domain-utils';
import { JacksonError } from './error';
import { writeOIDCRecord } from './connection/oidc-write';

type Standby = NonNullable<OIDCSSORecord['oidcProvider']['standby']>;
export const oidcSecretTestTTL = 30 * 24 * 60 * 60;
type Result = {
  outcome: 'validated' | 'different_account' | 'failed' | 'not_exercised';
  at: string;
  mode: 'confidential' | 'public';
  email?: string;
  error?: string;
};
export type OIDCSecretRotationStatus = {
  supported: boolean;
  active: boolean;
  revision: string | null;
  standby: Omit<Standby, 'clientSecret'> | null;
  validated: Result | null;
  last: Result | null;
};
export type OIDCSecretRotationAction = {
  action: 'stage' | 'promote' | 'rollback' | 'discard' | 'finish';
  expectedRevision: string | null;
  clientSecret?: string;
  email?: string;
};
type Selection = {
  clientSecret?: string;
  source: 'active' | 'pending' | 'public';
  revision?: string;
  trial?: { clientID: string; revision: string; email: string };
};

const freshProof = (result: Result | null): result is Result =>
  result?.outcome === 'validated' && Date.parse(result.at) >= Date.now() - oidcSecretTestTTL * 1000;

const emailAddress = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 254 && extractDomainFromLoginHint(value)
    ? value.trim().toLowerCase()
    : undefined;

export function selectOIDCSecret(connection: OIDCSSORecord, hint: unknown, publicClient: boolean): Selection {
  const provider = connection.oidcProvider;
  const pending = provider.standby?.role === 'pending' ? provider.standby : undefined;
  const trial =
    pending && emailAddress(hint) === pending.email
      ? { clientID: connection.clientID, revision: pending.revision, email: pending.email }
      : undefined;
  return {
    clientSecret: publicClient ? undefined : trial ? pending!.clientSecret : provider.clientSecret,
    source: publicClient ? 'public' : trial ? 'pending' : 'active',
    revision: trial?.revision ?? provider.secretRevision,
    trial,
  };
}

export class OIDCSecretRotationController {
  constructor(
    private connections: Storable,
    private results: Storable,
    private logger: RequiredLogger
  ) {}

  async status(clientID: string): Promise<OIDCSecretRotationStatus> {
    const connection = (await this.connections.get(clientID)) as OIDCSSORecord | null;
    if (!connection?.oidcProvider) throw new JacksonError('OIDC connection not found.', 404);
    const { standby, secretRevision } = connection.oidcProvider;
    const [validated, last] = standby
      ? await Promise.all([
          this.results.get(`${clientID}:${standby.revision}:validated`),
          this.results.get(`${clientID}:${standby.revision}:last`),
        ])
      : [null, null];
    return {
      supported: this.connections.conditional === true,
      active: !connection.deactivated,
      revision: secretRevision ?? null,
      standby: standby
        ? { revision: standby.revision, role: standby.role, email: standby.email, savedAt: standby.savedAt }
        : null,
      validated: freshProof(validated) ? validated : null,
      last,
    };
  }

  async change(clientID: string, input: OIDCSecretRotationAction, actor: { id?: string; email?: string }) {
    if (!this.connections.conditional)
      throw new JacksonError('Secret rotation requires a database with conditional writes.', 501);
    if (!(input.expectedRevision === null || typeof input.expectedRevision === 'string'))
      throw new JacksonError('Provide the secret revision shown in the editor.', 400);
    const connection = await writeOIDCRecord(this.connections, clientID, async (current) => {
      if (!current?.oidcProvider) throw new JacksonError('OIDC connection not found.', 404);
      const provider = { ...current.oidcProvider };
      if (input.expectedRevision !== (provider.secretRevision ?? null))
        throw new JacksonError('The client secret changed. Reload before confirming.', 409);
      const standby = provider.standby;
      const revision = randomUUID();
      if (input.action === 'stage') {
        if (standby?.role === 'previous')
          throw new JacksonError('Finish the current rotation before saving another secret.', 409);
        if (
          typeof input.clientSecret !== 'string' ||
          !input.clientSecret ||
          input.clientSecret === provider.clientSecret
        )
          throw new JacksonError('Enter a new client secret different from the active secret.', 400);
        const email = emailAddress(input.email);
        if (!email) throw new JacksonError('Enter the full email address of the test user.', 400);
        provider.standby = {
          clientSecret: input.clientSecret,
          revision,
          role: 'pending',
          email,
          savedAt: new Date().toISOString(),
        };
      } else if (input.action === 'promote' || input.action === 'rollback') {
        const requiredRole = input.action === 'promote' ? 'pending' : 'previous';
        if (!standby || standby.role !== requiredRole)
          throw new JacksonError(`There is no ${requiredRole} secret. Reload.`, 409);
        if (input.action === 'promote') {
          const proof = (await this.results.get(
            `${clientID}:${standby.revision}:validated`
          )) as Result | null;
          if (!freshProof(proof) || proof.mode !== 'confidential' || proof.email !== standby.email)
            throw new JacksonError(
              'Complete a confidential login with the pending secret and test email first.',
              409
            );
        }
        provider.standby = {
          ...standby,
          clientSecret: provider.clientSecret,
          revision,
          role: input.action === 'promote' ? 'previous' : 'pending',
          savedAt: new Date().toISOString(),
        };
        provider.clientSecret = standby.clientSecret;
      } else if (input.action === 'discard' || input.action === 'finish') {
        const requiredRole = input.action === 'discard' ? 'pending' : 'previous';
        if (!standby || standby.role !== requiredRole)
          throw new JacksonError(`There is no ${requiredRole} secret. Reload.`, 409);
        delete provider.standby;
      } else throw new JacksonError('Unknown secret rotation action.', 400);
      provider.secretRevision = revision;
      return { ...current, oidcProvider: provider };
    });
    this.logger.info('OIDC client secret rotation updated', {
      action: input.action,
      connection_id: clientID,
      admin_id: actor.id,
      admin_email: actor.email,
      previous_secret_revision: input.expectedRevision,
      oidc_secret_revision: connection.oidcProvider.secretRevision,
    });
    return this.status(clientID);
  }

  async record(selection: Selection, outcome: { email: unknown } | { error: unknown }) {
    const trial = selection.trial;
    if (!trial) return;
    const result: Result = {
      at: new Date().toISOString(),
      mode: selection.source === 'public' ? 'public' : 'confidential',
      outcome: 'not_exercised',
    };
    if ('error' in outcome) {
      result.outcome = 'failed';
      const error = outcome.error as any;
      const code = error?.cause?.error ?? error?.error;
      result.error = [
        'invalid_client',
        'invalid_grant',
        'invalid_request',
        'unauthorized_client',
        'access_denied',
        'server_error',
        'temporarily_unavailable',
      ].includes(code)
        ? code
        : 'upstream_validation_failed';
    } else {
      result.email = emailAddress(outcome.email);
      if (selection.source === 'pending')
        result.outcome = result.email === trial.email ? 'validated' : 'different_account';
    }
    try {
      if (result.outcome === 'validated')
        await this.results.put(`${trial.clientID}:${trial.revision}:validated`, result);
      await this.results.put(`${trial.clientID}:${trial.revision}:last`, result);
    } catch (error) {
      this.logger.warn('Unable to record OIDC secret test result', {
        connection_id: trial.clientID,
        oidc_secret_revision: trial.revision,
        error,
      });
    }
  }
}
