import crypto from 'crypto';
import saml from '@boxyhq/saml20';
import * as dbutils from '../db/utils';
import claims from '../saml/claims';
import * as telemetry from '../opentelemetry/telemetry';

// Validate the SAMLResponse and extract the user profile
export const extractSAMLResponseAttributes = async (
  decodedResponse: string,
  validateOpts: ValidateOption
) => {
  const attributes = await saml.validate(decodedResponse, validateOpts);
  let subjectSource: string | undefined;

  if (attributes && attributes.claims) {
    // We map claims to our attributes id, email, firstName, lastName where possible. We also map original claims to raw
    attributes.claims = claims.map(attributes.claims);
    const subjectProvided = !!attributes.claims.id;
    telemetry.bindProfile(attributes.claims);
    telemetry.enrich({ asserted_email_source: 'saml_mapped_claim' });
    subjectSource = subjectProvided
      ? 'saml_nameidentifier'
      : attributes.claims.email
        ? 'email_sha256'
        : undefined;

    // Some providers don't return the id in the assertion, we set it to a sha256 hash of the email
    if (!attributes.claims.id && attributes.claims.email) {
      attributes.claims.id = crypto.createHash('sha256').update(attributes.claims.email).digest('hex');
    }

    if (!attributes.claims.id) {
      telemetry.setStage('profile_map');
      throw telemetry.diagnostic(
        new Error(
          'SAML assertion is missing both id (NameID) and email. Ensure the IdP is configured to send at least one of these attributes.'
        ),
        'saml_subject_missing',
        'protocol'
      );
    }
  }

  // we'll send a ripemd160 hash of the id, this can be used in the case of email missing it can be used as the local part
  attributes.claims.idHash = dbutils.keyDigest(attributes.claims.id);
  telemetry.enrich({
    upstream_subject: attributes.claims.id,
    subject_source: subjectSource,
    profile_validated: true,
  });

  return attributes;
};

export type ValidateOption = {
  thumbprint?: string;
  publicKey?: string;
  audience: string;
  privateKey: string;
  inResponseTo?: string;
};
