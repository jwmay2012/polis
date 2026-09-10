import crypto from 'crypto';
import { promisify } from 'util';
import { deflateRaw } from 'zlib';
import saml from '@boxyhq/saml20';
import { validateSSOURL, sigAlg, signQueryString } from './utils';
import { SAMLProfile } from '@boxyhq/saml20/dist/typings';
import type {
  IOAuthController,
  OAuthReq,
  OAuthTokenReq,
  OAuthTokenRes,
  Profile,
  SAMLResponsePayload,
  Storable,
  SAMLSSORecord,
  OIDCSSORecord,
  SSOTrace,
  SSOTracesInstance as ssoTraces,
  OAuthErrorHandlerParams,
  OIDCAuthzResponsePayload,
  IdentityFederationApp,
  JacksonOptionWithRequiredLogger,
} from '../typings';
import {
  AuthorizationCodeGrantResult,
  clientIDFederatedPrefix,
  clientIDOIDCPrefix,
  relayStatePrefix,
  IndexNames,
  OAuthErrorResponse,
  getErrorMessage,
  loadJWSPrivateKey,
  computeKid,
  isJWSKeyPairLoaded,
  extractOIDCUserProfile,
  getScopeValues,
  getEncodedTenantProduct,
  isConnectionActive,
  dynamicImport,
  GENERIC_ERR_STRING,
} from './utils';

import * as metrics from '../opentelemetry/metrics';
import { JacksonError } from './error';
import * as allowed from './oauth/allowed';
import * as codeVerifier from './oauth/code-verifier';
import * as redirect from './oauth/redirect';
import { getDefaultCertificate } from '../saml/x509';
import { SSOHandler } from './sso-handler';
import { ValidateOption, extractSAMLResponseAttributes } from '../saml/lib';
import { oidcClientConfig } from './oauth/oidc-client';
import { App } from '../ee/identity-federation/app';
import * as encrypter from '../db/encrypter';
import { Encrypted } from '../typings';
import * as telemetry from '../opentelemetry/telemetry';
import { extractDomainFromLoginHint } from './domain-utils';

const deflateRawAsync = promisify(deflateRaw);

const escapeHTMLAttribute = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

function encrypt(val: any) {
  const genKey = crypto.randomBytes(32);
  const hexKey = genKey.toString('hex');
  const encVal = encrypter.encrypt(JSON.stringify(val), genKey);
  return { hexKey, encVal };
}

function decrypt(res: Encrypted, encryptionKey: string) {
  const encKey = Buffer.from(encryptionKey, 'hex');
  if (res.iv && res.tag) {
    return JSON.parse(encrypter.decrypt(res.value, res.iv, res.tag, encKey));
  }

  return JSON.parse(res.value);
}

export class OAuthController implements IOAuthController {
  private connectionStore: Storable;
  private sessionStore: Storable;
  private codeStore: Storable;
  private tokenStore: Storable;
  private ssoTraces: ssoTraces;
  private opts: JacksonOptionWithRequiredLogger;
  private ssoHandler: SSOHandler;
  private idFedApp: App;

  constructor({ connectionStore, sessionStore, codeStore, tokenStore, ssoTraces, opts, idFedApp }) {
    this.connectionStore = connectionStore;
    this.sessionStore = sessionStore;
    this.codeStore = codeStore;
    this.tokenStore = tokenStore;
    this.ssoTraces = ssoTraces;
    this.opts = opts;
    this.idFedApp = idFedApp;

    this.ssoHandler = new SSOHandler({ connection: connectionStore, session: sessionStore, opts });
  }

  public async authorize(
    body: OAuthReq
  ): Promise<{ redirect_url?: string; authorize_form?: string; error?: string }> {
    return telemetry.withSsoTelemetry('authorize', this.opts, () => this.authorizeWithTelemetry(body));
  }

  private async authorizeWithTelemetry(
    body: OAuthReq
  ): Promise<{ redirect_url?: string; authorize_form?: string; error?: string }> {
    const sessionId = crypto.randomBytes(16).toString('hex');
    telemetry.enrich({
      polis_session_fp: telemetry.fingerprint('polis-session', sessionId),
      session_stored: false,
    });
    const {
      tenant,
      product,
      access_type,
      resource,
      response_type = 'code',
      client_id,
      redirect_uri,
      state,
      scope,
      nonce,
      code_challenge,
      code_challenge_method = '',
      idp_hint,
      forceAuthn = 'false',
      login_hint,
      ...oidcParams // Rest of the params will be assumed as OIDC params and will be forwarded to the IdP
    } = body;

    telemetry.enrich({
      requested_email: typeof login_hint === 'string' ? login_hint : undefined,
      user_email: typeof login_hint === 'string' ? login_hint : undefined,
      requested_domain: extractDomainFromLoginHint(login_hint) || undefined,
      downstream_client_id: client_id,
      requested_tenant: tenant,
      requested_product: product,
      downstream_redirect_uri: redirect_uri,
      downstream_state_fp: telemetry.fingerprint('oauth-state', state),
      downstream_nonce_fp: telemetry.fingerprint('nonce', nonce),
      requested_scope: scope,
      downstream_pkce_present: !!code_challenge,
      downstream_pkce_method: code_challenge_method,
      force_authn: forceAuthn,
      prompt: oidcParams.prompt,
      session_ttl_seconds: this.opts.db.ttl,
      login_type: 'sp-initiated',
    });
    telemetry.event('polis_authorize_started', {}, 'Polis authorization started');

    let requestedTenant;
    let requestedProduct;
    let requestedScopes: string[] | undefined;
    let requestedOIDCFlow: boolean | undefined;
    let isOIDCFederated: boolean | undefined;
    let connection: SAMLSSORecord | OIDCSSORecord | undefined;
    let fedApp: IdentityFederationApp | undefined;
    let connectionIsSAML;
    let connectionIsOIDC;
    let protocol;
    let isPublicClient = false; // True if client redirect_uri is in publicRedirectUrls (mobile/SPA)
    let upstreamRedirectUri: string; // Redirect URI to use when calling upstream IdP
    const login_type = 'sp-initiated';

    try {
      requestedTenant = tenant;
      requestedProduct = product;

      metrics.increment('oauthAuthorize');

      if (!redirect_uri) {
        throw telemetry.diagnostic(
          new JacksonError('Please specify a redirect URL.', 400),
          'redirect_uri_missing',
          'request'
        );
      }

      requestedScopes = getScopeValues(scope);
      requestedOIDCFlow = requestedScopes.includes('openid');
      telemetry.enrich({ downstream_protocol: requestedOIDCFlow ? 'oidc' : 'oauth' });

      if (tenant && product) {
        const response = await this.ssoHandler.resolveConnection({
          tenant,
          product,
          idp_hint,
          login_hint, // Pass login_hint for domain-based routing
          authFlow: 'oauth',
          originalParams: { ...body },
        });

        if ('redirectUrl' in response) {
          return { redirect_url: response.redirectUrl };
        }

        if ('connection' in response) {
          connection = response.connection;
        }
      } else if (client_id && client_id !== '' && client_id !== 'undefined' && client_id !== 'null') {
        // if tenant and product are encoded in the client_id then we parse it and check for the relevant connection(s)
        let sp = getEncodedTenantProduct(client_id);

        if (!sp && access_type) {
          sp = getEncodedTenantProduct(access_type);
        }
        if (!sp && resource) {
          sp = getEncodedTenantProduct(resource);
          if (sp === null) {
            oidcParams.resource = resource;
          }
        }
        if (!sp && requestedScopes) {
          const encodedParams = requestedScopes.find((scope) => scope.includes('=') && scope.includes('&')); // for now assume only one encoded param i.e. for tenant/product
          if (encodedParams) {
            sp = getEncodedTenantProduct(encodedParams);
          }
        }
        if (sp && sp.tenant && sp.product) {
          const { tenant, product } = sp;

          requestedTenant = tenant;
          requestedProduct = product;

          const response = await this.ssoHandler.resolveConnection({
            tenant,
            product,
            idp_hint,
            login_hint, // Pass login_hint for domain-based routing
            authFlow: 'oauth',
            originalParams: { ...body },
          });

          if ('redirectUrl' in response) {
            return { redirect_url: response.redirectUrl };
          }

          if ('connection' in response) {
            connection = response.connection;
          }
        } else {
          // client_id is not encoded, so we look for the connection using the client_id
          // First we check if it's a federated connection
          if (client_id.startsWith(`${clientIDFederatedPrefix}${clientIDOIDCPrefix}`)) {
            isOIDCFederated = true;
            protocol = 'oidc-federation';
            metrics.increment('idfedAuthorize', { protocol, login_type });
            fedApp = await telemetry.stage('federation_app_lookup', async () => {
              try {
                return await this.idFedApp.get({ id: client_id.replace(clientIDFederatedPrefix, '') });
              } catch (err) {
                const status = (err as { statusCode?: number } | null)?.statusCode;
                if (status === 404) {
                  throw telemetry.diagnostic(err, 'federation_app_not_found', 'routing');
                }
                if (status === 403) {
                  throw telemetry.diagnostic(err, 'federation_app_license_invalid', 'configuration');
                }
                throw err;
              }
            });
            telemetry.enrich({ federation_app_id: fedApp.id });

            const response = await this.ssoHandler.resolveConnection({
              tenant: fedApp.tenant,
              product: fedApp.product,
              idp_hint,
              login_hint, // Pass login_hint for domain-based routing
              authFlow: 'oauth',
              originalParams: { ...body },
              tenants: fedApp.tenants,
              idFedAppId: fedApp.id,
              fedType: fedApp.type,
            });

            if ('redirectUrl' in response) {
              return { redirect_url: response.redirectUrl };
            }

            if ('connection' in response) {
              connection = response.connection;
              requestedTenant = fedApp.tenant;
              requestedProduct = fedApp.product;
            }
          } else {
            // If it's not a federated connection, we look for the connection using the client_id
            telemetry.enrich({ routing_source: 'direct_client_id' });
            connection = await telemetry.stage('connection_lookup', () =>
              this.connectionStore.get(client_id)
            );
            if (connection) {
              requestedTenant = connection.tenant;
              requestedProduct = connection.product;
              telemetry.bindConnection(connection);
              telemetry.event('polis_connection_selected', {}, 'Polis connection selected');
            }
          }
        }
      } else {
        throw telemetry.diagnostic(
          new JacksonError('You need to specify client_id or tenant & product', 403),
          'client_selection_missing',
          'request'
        );
      }

      if (!connection) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'IdP connection not found.'),
          'connection_not_found',
          'routing'
        );
      }

      connectionIsSAML = 'idpMetadata' in connection && connection.idpMetadata !== undefined;
      connectionIsOIDC = 'oidcProvider' in connection && connection.oidcProvider !== undefined;
      protocol = isOIDCFederated ? 'oidc-federation' : connectionIsSAML ? 'saml' : 'oidc';
      telemetry.bindConnection(connection);
      telemetry.setStage('redirect_validation');

      if (
        !allowed.redirect(
          redirect_uri,
          connection.redirectUrl as string[],
          this.opts.openid?.redirectExactMatch
        )
      ) {
        if (fedApp) {
          if (
            !allowed.redirect(
              redirect_uri,
              fedApp.redirectUrl as string[],
              this.opts.openid?.redirectExactMatch
            )
          ) {
            throw telemetry.diagnostic(
              new JacksonError('Redirect URL is not allowed.', 403),
              'redirect_uri_not_allowed',
              'protocol'
            );
          }
        } else {
          throw telemetry.diagnostic(
            new JacksonError('Redirect URL is not allowed.', 403),
            'redirect_uri_not_allowed',
            'protocol'
          );
        }
      }

      // Determine if public client flow should be used
      // Requires BOTH: client redirect_uri is in publicRedirectUrls AND connection has publicUpstreamRedirectUri configured
      const clientIsPublic = fedApp?.publicRedirectUrls?.includes(redirect_uri) || false;
      const publicUpstreamRedirectUri = connectionIsOIDC
        ? (connection as OIDCSSORecord).oidcProvider?.publicUpstreamRedirectUri
        : undefined;

      // Only use public client flow if both conditions are met
      isPublicClient = clientIsPublic && !!publicUpstreamRedirectUri;

      upstreamRedirectUri = isPublicClient
        ? publicUpstreamRedirectUri!
        : this.opts.externalUrl + this.opts.oidcPath;

      telemetry.enrich({
        downstream_client_type: fedApp ? (clientIsPublic ? 'public' : 'confidential') : 'connection',
        upstream_client_auth: connectionIsOIDC
          ? isPublicClient
            ? 'pkce'
            : 'client_secret_and_pkce'
          : undefined,
        upstream_redirect_uri: connectionIsOIDC ? upstreamRedirectUri : undefined,
        redirect_allowed: true,
      });

      if (!isConnectionActive(connection)) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'SSO connection is deactivated.'),
          'connection_inactive',
          'configuration'
        );
      }
    } catch (err: unknown) {
      telemetry.failure(err);
      const error_description = getErrorMessage(err);
      metrics.increment(isOIDCFederated ? 'idfedAuthorizeError' : 'oauthAuthorizeError', {
        protocol,
        login_type,
      });
      // Save the error trace
      await this.ssoTraces.saveTrace({
        error: error_description,
        context: {
          tenant: requestedTenant || '',
          product: requestedProduct || '',
          clientID: connection?.clientID || '',
          requestedOIDCFlow,
          isOIDCFederated,
          redirectUri: redirect_uri,
        },
      });
      throw err;
    }

    const isMissingJWTKeysForOIDCFlow =
      requestedOIDCFlow &&
      (!this.opts.openid?.jwtSigningKeys || !isJWSKeyPairLoaded(this.opts.openid.jwtSigningKeys));

    const oAuthClientReqError = !state || response_type !== 'code';
    telemetry.setStage('request_validation');

    if (isMissingJWTKeysForOIDCFlow || oAuthClientReqError || (!connectionIsSAML && !connectionIsOIDC)) {
      let error, error_description, internalError;
      if (isMissingJWTKeysForOIDCFlow) {
        error = 'server_error';
        internalError =
          'Authorize error: OAuth server not configured correctly for openid flow, check if JWT signing keys are loaded';
        error_description = GENERIC_ERR_STRING;
        if (!telemetry.telemetryActive()) this.opts.logger.error(internalError);
      }

      if (!state) {
        error = 'invalid_request';
        error_description = 'Please specify a state to safeguard against XSRF attacks';
      }

      if (response_type !== 'code') {
        error = 'unsupported_response_type';
        error_description = 'Only Authorization Code grant is supported';
      }

      if (!connectionIsSAML && !connectionIsOIDC) {
        error = 'server_error';
        internalError = 'Authorize error: Connection appears to be misconfigured';
        error_description = GENERIC_ERR_STRING;
        if (!telemetry.telemetryActive()) this.opts.logger.error(internalError);
      }

      telemetry.failure(
        {
          name: 'JacksonError',
          message: error_description,
          internalError,
          statusCode: error === 'server_error' ? 500 : 400,
        },
        !state
          ? 'downstream_state_missing'
          : response_type !== 'code'
            ? 'response_type_unsupported'
            : isMissingJWTKeysForOIDCFlow
              ? 'signing_keys_missing'
              : 'connection_protocol_invalid',
        error === 'server_error' ? 'configuration' : 'request'
      );
      metrics.increment('oauthAuthorizeError', { protocol, login_type });

      // Save the error trace
      const traceId = await this.ssoTraces.saveTrace({
        error: internalError ?? error_description,
        context: {
          tenant: requestedTenant,
          product: requestedProduct,
          clientID: connection.clientID,
          requestedOIDCFlow,
          isOIDCFederated,
          redirectUri: redirect_uri,
        },
      });
      return {
        redirect_url: OAuthErrorResponse({
          error,
          error_description: traceId ? `${traceId}: ${error_description}` : error_description,
          redirect_uri,
          state,
        }),
        error: `${error} - ${error_description}`,
      };
    }

    // Connection retrieved: Handover to IdP starts here
    let ssoUrl;
    let post = false;
    let providerName;

    // Init sessionId
    const relayState = relayStatePrefix + sessionId;
    telemetry.enrich({ upstream_state_fp: telemetry.fingerprint('oauth-state', relayState) });
    // SAML connection: SAML request will be constructed here
    let samlReq, samlReqSigningKey: string | undefined, internalError;
    if (connectionIsSAML) {
      try {
        telemetry.setStage('saml_request_creation');
        const { sso, provider } = (connection as SAMLSSORecord).idpMetadata;
        providerName = provider;

        if ('redirectUrl' in sso) {
          // HTTP Redirect binding
          ssoUrl = sso.redirectUrl;
        } else if ('postUrl' in sso) {
          // HTTP-POST binding
          ssoUrl = sso.postUrl;
          post = true;
        } else {
          // This code here is kept for backward compatibility. We now have validation while adding the SSO connection to ensure binding is present.
          internalError = 'Authorize error: SAML binding could not be retrieved';
          const error_description = GENERIC_ERR_STRING;
          telemetry.failure(
            { name: 'JacksonError', message: internalError, statusCode: 500 },
            'saml_binding_missing',
            'configuration'
          );
          if (!telemetry.telemetryActive()) this.opts.logger.error(internalError);

          metrics.increment('oauthAuthorizeError', { protocol, login_type });
          // Save the error trace
          const traceId = await this.ssoTraces.saveTrace({
            error: internalError ?? error_description,
            context: {
              tenant: requestedTenant as string,
              product: requestedProduct as string,
              clientID: connection.clientID,
              requestedOIDCFlow,
              isOIDCFederated,
              redirectUri: redirect_uri,
              providerName: provider,
            },
          });
          return {
            redirect_url: OAuthErrorResponse({
              error: 'invalid_request',
              error_description: traceId ? `${traceId}: ${error_description}` : error_description,
              redirect_uri,
              state,
            }),
          };
        }

        validateSSOURL(ssoUrl);

        const cert = await getDefaultCertificate();

        const samlRequestOpts = {
          ssoUrl,
          entityID: connection.samlAudienceOverride
            ? connection.samlAudienceOverride
            : this.opts.samlAudience!,
          callbackUrl: connection.acsUrlOverride ? connection.acsUrlOverride : (this.opts.acsUrl as string),
          forceAuthn: forceAuthn === 'true' ? true : !!(connection as SAMLSSORecord).forceAuthn,
          identifierFormat: (connection as SAMLSSORecord).identifierFormat
            ? (connection as SAMLSSORecord).identifierFormat
            : 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        };

        // For HTTP-POST, embed signature in the XML body
        // For HTTP-Redirect, leave XML unsigned (query string is signed instead)
        samlReq = post
          ? saml.request({ ...samlRequestOpts, signingKey: cert.privateKey, publicKey: cert.publicKey })
          : saml.request({ ...samlRequestOpts, signingKey: '', publicKey: '' });
        samlReqSigningKey = cert.privateKey;
        telemetry.enrich({
          saml_request_id: samlReq.id,
          saml_binding: post ? 'HTTP-POST' : 'HTTP-Redirect',
          saml_signing_algorithm: sigAlg,
          upstream_redirect_uri: samlRequestOpts.callbackUrl,
          upstream_issuer: (connection as SAMLSSORecord).idpMetadata.entityID,
        });
      } catch (err: unknown) {
        telemetry.failure(err);
        const error_description = getErrorMessage(err);
        if (!telemetry.telemetryActive()) this.opts.logger.error(`Authorize error: ${error_description} `);
        metrics.increment('oauthAuthorizeError', { protocol, login_type });
        // Save the error trace
        const traceId = await this.ssoTraces.saveTrace({
          error: error_description,
          context: {
            tenant: requestedTenant,
            product: requestedProduct,
            clientID: connection.clientID,
            requestedOIDCFlow,
            isOIDCFederated,
            redirectUri: redirect_uri,
          },
        });

        return {
          redirect_url: OAuthErrorResponse({
            error: 'server_error',
            error_description: traceId ? `${traceId}: ${error_description}` : error_description,
            redirect_uri,
            state,
          }),
        };
      }
    }

    // OIDC Connection: Issuer discovery, openid-client init and extraction of authorization endpoint happens here
    let oidcCodeVerifier: string | undefined;
    let oidcNonce: string | undefined;
    if (connectionIsOIDC) {
      const { discoveryUrl, metadata, clientId, clientSecret, provider } = (connection as OIDCSSORecord)
        .oidcProvider;
      providerName = provider;
      const { ssoTraces } = this;
      try {
        if (!this.opts.oidcPath) {
          throw telemetry.diagnostic(
            new JacksonError(GENERIC_ERR_STRING, 500, 'OpenID response handler path (oidcPath) is not set'),
            'oidc_callback_path_missing',
            'configuration'
          );
        }
        const client = (await dynamicImport('openid-client')) as typeof import('openid-client');
        telemetry.setStage('upstream_discovery');
        const oidcConfig = await telemetry.stage('upstream_discovery', () =>
          oidcClientConfig({
            discoveryUrl,
            metadata,
            clientId,
            clientSecret,
            ssoTraces: {
              instance: ssoTraces,
              context: {
                tenant: requestedTenant as string,
                product: requestedProduct as string,
                clientID: connection.clientID,
                requestedOIDCFlow,
                isOIDCFederated,
                redirectUri: redirect_uri,
                providerName: provider,
              },
            },
          })
        );
        oidcCodeVerifier = client.randomPKCECodeVerifier();
        const code_challenge = await client.calculatePKCECodeChallenge(oidcCodeVerifier);
        oidcNonce = client.randomNonce();
        telemetry.enrich({
          upstream_nonce_fp: telemetry.fingerprint('nonce', oidcNonce),
          upstream_pkce_method: 'S256',
        });
        const standardScopes = this.opts.openid?.requestProfileScope
          ? ['openid', 'email', 'profile']
          : ['openid', 'email'];
        const paramsToForward = this.opts.openid?.forwardOIDCParams ? oidcParams : {};
        if (login_hint) {
          paramsToForward.login_hint = login_hint;
        }
        ssoUrl = client.buildAuthorizationUrl(oidcConfig, {
          scope: [...requestedScopes, ...standardScopes]
            .filter((value, index, self) => self.indexOf(value) === index) // filter out duplicates
            .join(' '),
          code_challenge,
          code_challenge_method: 'S256',
          state: relayState,
          nonce: oidcNonce,
          redirect_uri: upstreamRedirectUri,
          ...paramsToForward,
        }).href;
      } catch (err: unknown) {
        telemetry.failure(err);
        const error_description = getErrorMessage(err);
        if (!telemetry.telemetryActive()) this.opts.logger.error(`Authorize error: ${error_description}`);
        metrics.increment('oauthAuthorizeError', { protocol, login_type });
        // Save the error trace
        const traceId = await this.ssoTraces.saveTrace({
          error: error_description,
          context: {
            tenant: requestedTenant as string,
            product: requestedProduct as string,
            clientID: connection.clientID,
            requestedOIDCFlow,
            isOIDCFederated,
            redirectUri: redirect_uri,
            providerName,
          },
        });

        if (err) {
          return {
            redirect_url: OAuthErrorResponse({
              error: 'server_error',
              error_description: traceId ? `${traceId}: ${error_description}` : error_description,
              redirect_uri,
              state,
            }),
          };
        }
      }
    }
    // Session persistence happens here
    try {
      telemetry.enrich({ session_created_at: new Date().toISOString() });
      const requested = {
        client_id,
        state,
        redirect_uri,
        protocol,
        login_type,
        providerName,
        login_hint,
      } as Record<string, string | boolean | string[]>;
      if (requestedTenant) {
        requested.tenant = requestedTenant;
      }
      if (requestedProduct) {
        requested.product = requestedProduct;
      }
      // Persist the federation app's tenant allow-list so the upstream-response
      // callback can re-assert connection scope, including multi-tenant apps.
      if (fedApp?.tenants?.length) {
        requested.tenants = fedApp.tenants;
      }
      if (idp_hint) {
        requested.idp_hint = idp_hint;
      } else {
        if (fedApp) {
          requested.idp_hint = connection.clientID;
        }
      }
      if (requestedOIDCFlow) {
        requested.oidc = true;
        if (nonce) {
          requested.nonce = nonce;
        }
      }
      if (requestedScopes) {
        requested.scope = requestedScopes;
      }

      const sessionObj = {
        redirect_uri,
        response_type,
        state,
        code_challenge,
        code_challenge_method,
        requested,
        isPublicClient, // True if client redirect_uri is a public client (mobile/SPA)
        upstreamRedirectUri, // The redirect_uri used when calling upstream IdP
        telemetry: telemetry.continuation(),
        oidcFederated: fedApp
          ? {
              redirectUrl: fedApp.redirectUrl,
              publicRedirectUrls: fedApp.publicRedirectUrls || [], // List of public client redirect URIs
              id: fedApp.id,
              clientID: fedApp.clientID,
              clientSecret: fedApp.clientSecret,
              ttlInMinutes: fedApp.ttlInMinutes,
            }
          : undefined,
      };
      await telemetry.stage('session_store', () =>
        this.sessionStore.put(
          sessionId,
          connectionIsSAML
            ? { ...sessionObj, id: samlReq?.id }
            : { ...sessionObj, id: connection.clientID, oidcCodeVerifier, oidcNonce }
        )
      );
      telemetry.enrich({ session_stored: true });
      telemetry.setStage('idp_redirect');
      // Redirect to IdP
      if (connectionIsSAML) {
        let redirectUrl;
        let authorizeForm;

        if (!post) {
          // HTTP-Redirect: sign the query string, not the XML body
          const encodedRequest = Buffer.from(await deflateRawAsync(samlReq.request)).toString('base64');
          const queryToSign = `SAMLRequest=${encodeURIComponent(encodedRequest)}&RelayState=${encodeURIComponent(relayState)}&SigAlg=${encodeURIComponent(sigAlg)}`;
          const signature = signQueryString(queryToSign, samlReqSigningKey!);

          redirectUrl = redirect.success(ssoUrl, {
            SAMLRequest: encodedRequest,
            RelayState: relayState,
            SigAlg: sigAlg,
            Signature: signature,
            // Not part of the signed query (SAMLRequest, RelayState, SigAlg);
            // IdPs read it as a hint only.
            login_hint: login_hint || undefined,
          });
        } else {
          // HTTP-POST: signature is already embedded in the XML
          const postUrl = login_hint ? redirect.success(ssoUrl, { login_hint }) : ssoUrl;
          authorizeForm = saml.createPostForm(ssoUrl, [
            { name: 'RelayState', value: relayState },
            { name: 'SAMLRequest', value: Buffer.from(samlReq.request).toString('base64') },
          ]);
          if (postUrl !== ssoUrl) {
            // saml20's form helper calls encodeURI on its action. Passing the
            // URLSearchParams-encoded postUrl to it would encode `%40` again
            // as `%2540`, so replace the base action with the already encoded,
            // HTML-escaped URL after the form is created.
            authorizeForm = authorizeForm.replace(
              `action="${encodeURI(ssoUrl)}"`,
              `action="${escapeHTMLAttribute(postUrl)}"`
            );
          }
        }
        telemetry.enrich({ saml_request_signed: true });
        telemetry.event('polis_idp_redirect_issued', {}, 'Polis SAML redirect issued');
        return { redirect_url: redirectUrl, authorize_form: authorizeForm };
      }
      if (connectionIsOIDC) {
        telemetry.event('polis_idp_redirect_issued', {}, 'Polis OIDC redirect issued');
        return { redirect_url: ssoUrl };
      }
      throw 'Connection appears to be misconfigured';
    } catch (err: unknown) {
      telemetry.failure(err);
      const error_description = getErrorMessage(err);
      metrics.increment('oauthAuthorizeError', { protocol, login_type });
      // Save the error trace
      const traceId = await this.ssoTraces.saveTrace({
        error: error_description,
        context: {
          tenant: requestedTenant as string,
          product: requestedProduct as string,
          clientID: connection.clientID,
          requestedOIDCFlow,
          isOIDCFederated,
          redirectUri: redirect_uri,
          samlRequest: samlReq?.request || '',
          providerName,
        },
      });
      return {
        redirect_url: OAuthErrorResponse({
          error: 'server_error',
          error_description: traceId ? `${traceId}: ${error_description}` : error_description,
          redirect_uri,
          state,
        }),
      };
    }
  }

  public async samlResponse(
    body: SAMLResponsePayload
  ): Promise<{ redirect_url?: string; app_select_form?: string; response_form?: string; error?: string }> {
    return telemetry.withSsoTelemetry('saml_callback', this.opts, () => this.samlResponseWithTelemetry(body));
  }

  private async samlResponseWithTelemetry(
    body: SAMLResponsePayload
  ): Promise<{ redirect_url?: string; app_select_form?: string; response_form?: string; error?: string }> {
    let connection: SAMLSSORecord | undefined;
    let rawResponse: string | undefined;
    let sessionId: string | undefined;
    let session: any;
    let issuer: string | undefined;
    let isIdPFlow: boolean | undefined;
    let isSAMLFederated: boolean | undefined;
    let isOIDCFederated: boolean | undefined;
    let validateOpts: ValidateOption;
    let redirect_uri: string | undefined;
    const { SAMLResponse, idp_hint, RelayState = '' } = body;
    let protocol, login_type;

    telemetry.enrich({
      upstream_protocol: 'saml',
      upstream_state_fp: telemetry.fingerprint('oauth-state', RelayState),
      state_present: !!RelayState,
      callback_route: telemetry.telemetryFields().callback_route || '/api/oauth/saml',
    });
    telemetry.event('polis_idp_callback_received', {}, 'Polis SAML callback received');

    try {
      isIdPFlow = !RelayState.startsWith(relayStatePrefix);
      login_type = isIdPFlow ? 'idp-initiated' : 'sp-initiated';
      telemetry.enrich({ login_type, idp_initiated_enabled: this.opts.idpEnabled });
      telemetry.setStage('saml_issuer_parse');
      metrics.increment('oauthResponse', { protocol: 'saml', login_type });
      rawResponse = Buffer.from(SAMLResponse, 'base64').toString();
      issuer = saml.parseIssuer(rawResponse);
      telemetry.setStage('flow_validation');

      if (!this.opts.idpEnabled && isIdPFlow) {
        // IdP login is disabled so block the request
        throw telemetry.diagnostic(
          new JacksonError(
            GENERIC_ERR_STRING,
            403,
            'IdP (Identity Provider) flow has been disabled. Please head to your Service Provider to login.'
          ),
          'idp_initiated_disabled',
          'protocol'
        );
      }

      if (isIdPFlow) {
        protocol = 'saml';
      }
      sessionId = RelayState.replace(relayStatePrefix, '');
      telemetry.enrich({
        polis_session_fp: !isIdPFlow ? telemetry.fingerprint('polis-session', sessionId) : undefined,
        presented_issuer: issuer,
      });

      if (!issuer) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'Issuer not found.'),
          'saml_issuer_missing',
          'protocol'
        );
      }

      const connections: SAMLSSORecord[] = (
        await telemetry.stage('connection_lookup', () =>
          this.connectionStore.getByIndex({ name: IndexNames.EntityID, value: issuer! })
        )
      ).data;

      if (!connections || connections.length === 0) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'SAML connection not found.'),
          'saml_issuer_connection_not_found',
          'routing'
        );
      }

      session = sessionId
        ? await telemetry.stage('session_lookup', () => this.sessionStore.get(sessionId!))
        : null;
      telemetry.enrich({ session_lookup: session ? 'hit' : 'miss' });
      if (session) telemetry.bindSession(session, sessionId);

      if (!isIdPFlow && !session) {
        throw telemetry.diagnostic(
          new JacksonError('Unable to validate state from the origin request.', 403),
          'sso_session_not_found',
          'protocol'
        );
      }

      isSAMLFederated = session && 'samlFederated' in session;
      isOIDCFederated = session && 'oidcFederated' in session;
      const isSPFlow = !isIdPFlow && !isSAMLFederated;
      telemetry.enrich({
        downstream_protocol: isSAMLFederated ? 'saml' : session?.requested?.oidc ? 'oidc' : 'oauth',
      });
      telemetry.setStage('callback_connection_validation');
      protocol = isOIDCFederated ? 'oidc-federation' : isSAMLFederated ? 'saml-federation' : 'saml';
      if (protocol !== 'saml') {
        metrics.increment('idfedResponse', { protocol, login_type });
      }
      // IdP initiated SSO flow
      if (isIdPFlow) {
        const response = await this.ssoHandler.resolveConnection({
          idp_hint,
          login_hint: session?.requested?.login_hint, // Get login_hint from session if available
          authFlow: 'idp-initiated',
          entityId: issuer,
          originalParams: { SAMLResponse },
        });

        // Redirect to the product selection page
        if ('postForm' in response) {
          return { app_select_form: response.postForm };
        }

        // Found a connection
        if ('connection' in response) {
          connection = response.connection as SAMLSSORecord;
          if (!isConnectionActive(connection)) {
            throw new JacksonError(
              GENERIC_ERR_STRING,
              403,
              'SSO connection is deactivated. Please contact your administrator.'
            );
          }
        }
      }

      // SP initiated SSO flow
      // Resolve if there are multiple matches for SP login
      if (isSPFlow || isSAMLFederated || isOIDCFederated) {
        connection = connections.filter((c) => {
          return (
            c.clientID === session.requested.client_id ||
            c.clientID === session.requested.idp_hint ||
            (c.tenant === session.requested.tenant && c.product === session.requested.product)
          );
        })[0];

        // Defense in depth: re-assert that the selected connection belongs to
        // the tenant/product scope the session was created under. The scoping
        // in resolveConnection already prevents an out-of-scope connection from
        // being bound to a session, but selecting by clientID/idp_hint here is
        // not tenant-bound on its own, so we verify the result against the
        // session's allow-list (CWE-639). Multi-tenant federation apps persist
        // their tenant list; everything else is scoped to a single tenant.
        //
        // This fails closed: if the session does not carry a verifiable scope
        // (tenant/tenants and product), we deny rather than fall back to the
        // permissive filter above. Every SP-initiated and federated SAML
        // session created by authorize() and createSAMLRequest() sets both, so
        // a missing scope means a malformed or legacy session and must not pass.
        let allowedTenants: string[] = [];
        if (Array.isArray(session.requested.tenants)) {
          // Multi-tenant federation app: any of the app's tenants is in scope.
          allowedTenants = session.requested.tenants;
        } else if (session.requested.tenant) {
          // Everything else is scoped to the session's single tenant.
          allowedTenants = [session.requested.tenant];
        }

        const tenantsKnown = allowedTenants.length > 0;
        const productKnown = !!session.requested.product;

        if (
          connection &&
          (!tenantsKnown ||
            !productKnown ||
            !allowedTenants.includes(connection.tenant) ||
            connection.product !== session.requested.product)
        ) {
          throw telemetry.diagnostic(
            new JacksonError(GENERIC_ERR_STRING, 403, 'SAML connection not found.'),
            'connection_scope_mismatch',
            'protocol'
          );
        }
      }

      if (!connection) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'SAML connection not found.'),
          'callback_connection_not_found',
          'routing'
        );
      }
      telemetry.bindConnection(connection);
      telemetry.setStage('redirect_validation');

      if (
        session &&
        session.redirect_uri &&
        !allowed.redirect(
          session.redirect_uri,
          connection.redirectUrl as string[],
          this.opts.openid?.redirectExactMatch
        )
      ) {
        if (isOIDCFederated) {
          if (
            !allowed.redirect(
              session.redirect_uri,
              session.oidcFederated?.redirectUrl as string[],
              this.opts.openid?.redirectExactMatch
            )
          ) {
            throw telemetry.diagnostic(
              new JacksonError('Redirect URL is not allowed.', 403),
              'redirect_uri_not_allowed',
              'protocol'
            );
          }
        } else {
          throw telemetry.diagnostic(
            new JacksonError('Redirect URL is not allowed.', 403),
            'redirect_uri_not_allowed',
            'protocol'
          );
        }
      }

      const { privateKey } = await getDefaultCertificate();

      validateOpts = {
        audience: connection.samlAudienceOverride ? connection.samlAudienceOverride : this.opts.samlAudience!,
        privateKey,
      };

      if (connection.idpMetadata.publicKey) {
        validateOpts.publicKey = connection.idpMetadata.publicKey;
      } else if (connection.idpMetadata.thumbprint) {
        validateOpts.thumbprint = connection.idpMetadata.thumbprint;
      }

      if (session && session.id) {
        validateOpts['inResponseTo'] = session.id;
      }
      telemetry.enrich({
        saml_request_id: session?.id,
        expected_audience: validateOpts.audience,
        redirect_allowed: true,
        certificate_source: validateOpts.publicKey
          ? 'public_key'
          : validateOpts.thumbprint
            ? 'thumbprint'
            : 'none',
      });

      redirect_uri = ((session && session.redirect_uri) as string) || connection.defaultRedirectUrl;
    } catch (err: unknown) {
      telemetry.failure(err);
      metrics.increment(isOIDCFederated || isSAMLFederated ? 'idfedResponseError' : 'oauthResponseError', {
        protocol,
        login_type,
      });
      // Save the error trace
      await this.ssoTraces.saveTrace({
        error: getErrorMessage(err),
        context: {
          samlResponse: rawResponse,
          tenant: session?.requested?.tenant || connection?.tenant,
          product: session?.requested?.product || connection?.product,
          clientID: session?.requested?.client_id || connection?.clientID,
          providerName: connection?.idpMetadata?.provider,
          redirectUri: isIdPFlow ? connection?.defaultRedirectUrl : session?.redirect_uri,
          issuer,
          isSAMLFederated,
          isOIDCFederated,
          isIdPFlow,
          requestedOIDCFlow: !!session?.requested?.oidc,
          acsUrl: session?.requested?.acsUrl,
          entityId: session?.requested?.entityId,
          relayState: RelayState,
        },
      });
      throw err; // Rethrow the error
    }
    let profile: SAMLProfile | undefined;

    try {
      profile = await telemetry.stage('saml_validate', () =>
        extractSAMLResponseAttributes(rawResponse!, validateOpts)
      );
      telemetry.enrich({
        saml_assertion_id: profile.assertionId,
        saml_session_index: profile.sessionIndex,
        assertion_expires_at: profile.notOnOrAfter,
        upstream_issuer: profile.issuer,
        upstream_audience: profile.audience,
      });
      telemetry.event('polis_identity_validated', {}, 'Polis SAML identity validated');

      // This is a federated SAML flow, let's create a new SAMLResponse and POST it to the SP
      if (isSAMLFederated) {
        const { responseForm } = await this.ssoHandler.createSAMLResponse({ profile, session });

        await telemetry.stage('session_delete', () => this.sessionStore.delete(sessionId!));
        telemetry.event('polis_session_consumed', {}, 'Polis authorization session consumed');

        return { response_form: responseForm };
      }

      const code = await this._buildAuthorizationCode(connection, profile, session, isIdPFlow);

      const params = { code };

      if (session && session.state) {
        params['state'] = session.state;
      }

      await telemetry.stage('session_delete', () => this.sessionStore.delete(sessionId!));
      telemetry.event('polis_session_consumed', {}, 'Polis authorization session consumed');

      return { redirect_url: redirect.success(redirect_uri, params) };
    } catch (err: unknown) {
      telemetry.failure(err);
      metrics.increment(isOIDCFederated || isSAMLFederated ? 'idfedResponseError' : 'oauthResponseError', {
        protocol,
        login_type,
      });
      const error_description = getErrorMessage(err);
      if (!telemetry.telemetryActive()) this.opts.logger.error(`SAMLResponse error: ${error_description}`);
      // Trace the error
      const traceId = await this.ssoTraces.saveTrace({
        error: error_description,
        context: {
          samlResponse: rawResponse,
          tenant: connection.tenant,
          product: connection.product,
          clientID: connection.clientID,
          providerName: connection?.idpMetadata?.provider,
          redirectUri: isIdPFlow ? connection?.defaultRedirectUrl : session?.redirect_uri,
          isSAMLFederated,
          isOIDCFederated,
          isIdPFlow,
          acsUrl: session?.requested?.acsUrl,
          entityId: session?.requested?.entityId,
          requestedOIDCFlow: !!session?.requested?.oidc,
          relayState: RelayState,
          issuer,
          profile,
        },
      });

      if (isSAMLFederated) {
        throw err;
      }

      return {
        redirect_url: OAuthErrorResponse({
          error: 'access_denied',
          error_description: traceId ? `${traceId}: ${error_description}` : error_description,
          redirect_uri,
          state: session?.requested?.state,
        }),
        error: `access_denied - ${error_description}`,
      };
    }
  }

  public async oidcAuthzResponse(
    body: OIDCAuthzResponsePayload
  ): Promise<{ redirect_url?: string; response_form?: string; error?: string }> {
    return telemetry.withSsoTelemetry('oidc_callback', this.opts, () => this.oidcResponseWithTelemetry(body));
  }

  private async oidcResponseWithTelemetry(
    body: OIDCAuthzResponsePayload
  ): Promise<{ redirect_url?: string; response_form?: string; error?: string }> {
    let oidcConnection: OIDCSSORecord | undefined;
    let session: any;
    let isSAMLFederated: boolean | undefined;
    let isOIDCFederated: boolean | undefined;
    let redirect_uri: string | undefined;
    let profile;
    let protocol;
    const login_type = 'sp-initiated';

    const callbackParams = body;

    let RelayState = callbackParams.state || '';
    telemetry.enrich({
      upstream_protocol: 'oidc',
      upstream_state_fp: telemetry.fingerprint('oauth-state', RelayState),
      state_present: !!RelayState,
      upstream_code_fp: telemetry.fingerprint('oauth-code', callbackParams.code),
      idp_error_present: !!callbackParams.error,
      callback_route: telemetry.telemetryFields().callback_route || '/api/oauth/oidc',
    });
    telemetry.event('polis_idp_callback_received', {}, 'Polis OIDC callback received');
    try {
      metrics.increment('oauthResponse', { protocol: 'oidc', login_type });
      if (!RelayState) {
        throw telemetry.diagnostic(
          new JacksonError('State from original request is missing.', 403),
          'upstream_state_missing',
          'protocol'
        );
      }

      RelayState = RelayState.replace(relayStatePrefix, '');
      telemetry.enrich({ polis_session_fp: telemetry.fingerprint('polis-session', RelayState) });
      session = await telemetry.stage('session_lookup', () => this.sessionStore.get(RelayState));
      telemetry.enrich({ session_lookup: session ? 'hit' : 'miss' });
      if (!session) {
        throw telemetry.diagnostic(
          new JacksonError('Unable to validate state from the original request.', 403),
          'sso_session_not_found',
          'protocol'
        );
      }
      telemetry.bindSession(session, RelayState);

      isSAMLFederated = session && 'samlFederated' in session;
      isOIDCFederated = session && 'oidcFederated' in session;

      protocol = isOIDCFederated ? 'oidc-federation' : isSAMLFederated ? 'saml-federation' : 'oidc';
      if (protocol !== 'oidc') {
        metrics.increment('idfedResponse', { protocol, login_type });
      }
      telemetry.enrich({
        downstream_protocol: isSAMLFederated ? 'saml' : session.requested?.oidc ? 'oidc' : 'oauth',
      });
      oidcConnection = await telemetry.stage('connection_lookup', () => this.connectionStore.get(session.id));

      if (!oidcConnection) {
        throw telemetry.diagnostic(
          new JacksonError(GENERIC_ERR_STRING, 403, 'OIDC connection not found.'),
          'callback_connection_not_found',
          'routing'
        );
      }
      telemetry.bindConnection(oidcConnection);
      telemetry.setStage('redirect_validation');

      if (!isSAMLFederated) {
        redirect_uri = session && session.redirect_uri;
        if (!redirect_uri) {
          throw telemetry.diagnostic(
            new JacksonError('Redirect URL from the authorization request could not be retrieved', 403),
            'stored_redirect_uri_missing',
            'protocol'
          );
        }

        if (
          redirect_uri &&
          !allowed.redirect(
            redirect_uri,
            oidcConnection.redirectUrl as string[],
            this.opts.openid?.redirectExactMatch
          )
        ) {
          if (isOIDCFederated) {
            if (
              !allowed.redirect(
                redirect_uri,
                session.oidcFederated?.redirectUrl as string[],
                this.opts.openid?.redirectExactMatch
              )
            ) {
              throw telemetry.diagnostic(
                new JacksonError('Redirect URL is not allowed.', 403),
                'redirect_uri_not_allowed',
                'protocol'
              );
            }
          } else {
            throw telemetry.diagnostic(
              new JacksonError('Redirect URL is not allowed.', 403),
              'redirect_uri_not_allowed',
              'protocol'
            );
          }
        }
      }
    } catch (err) {
      telemetry.failure(err);
      metrics.increment(protocol === 'oidc' ? 'oauthResponseError' : 'idfedResponseError', {
        protocol,
        login_type,
      });
      await this.ssoTraces.saveTrace({
        error: getErrorMessage(err),
        context: {
          tenant: session?.requested?.tenant || oidcConnection?.tenant,
          product: session?.requested?.product || oidcConnection?.product,
          clientID: session?.requested?.client_id || oidcConnection?.clientID,
          providerName: oidcConnection?.oidcProvider?.provider,
          acsUrl: session?.requested?.acsUrl,
          entityId: session?.requested?.entityId,
          redirectUri: redirect_uri,
          relayState: RelayState,
          isSAMLFederated,
          isOIDCFederated,
          requestedOIDCFlow: !!session?.requested?.oidc,
          oidcIdPRequest: session?.requested?.oidcIdPRequest,
        },
      });
      // Rethrow err and redirect to Jackson error page
      throw err;
    }

    // If the OIDC provider returned an error, forward it to the redirect_uri
    // without attempting discovery or token exchange
    if (callbackParams.error) {
      const { error, error_description } = callbackParams;
      const error_message = error_description || 'Authorization failed at the OIDC provider';
      telemetry.setStage('idp_authorization');
      telemetry.failure(
        { name: 'OAuthProviderError', message: error_message, error, error_description },
        'idp_authorization_rejected'
      );
      if (!telemetry.telemetryActive())
        this.opts.logger.error(`OIDCResponse error from provider: ${error_message}`);
      metrics.increment(protocol === 'oidc' ? 'oauthResponseError' : 'idfedResponseError', {
        protocol,
        login_type,
      });
      const traceId = await this.ssoTraces.saveTrace({
        error: error_message,
        context: {
          tenant: oidcConnection!.tenant,
          product: oidcConnection!.product,
          clientID: oidcConnection!.clientID,
          providerName: oidcConnection!.oidcProvider?.provider,
          redirectUri: redirect_uri,
          relayState: RelayState,
          isSAMLFederated,
          isOIDCFederated,
          acsUrl: session.requested.acsUrl,
          entityId: session.requested.entityId,
          requestedOIDCFlow: !!session.requested.oidc,
          oidcIdPRequest: session?.requested?.oidcIdPRequest,
          error,
          error_description,
        },
      });

      if (isSAMLFederated) {
        throw new JacksonError(error_message, 403);
      }

      return {
        redirect_url: OAuthErrorResponse({
          error: (error as OAuthErrorHandlerParams['error']) || 'server_error',
          error_description: traceId ? `${traceId}: ${error_message}` : error_message,
          redirect_uri: redirect_uri!,
          state: session.state,
        }),
        error: `${error} - ${error_message}`,
      };
    }

    // Reconstruct the oidcClient, code exchange for token and user profile happens here
    const { discoveryUrl, metadata, clientId, clientSecret } = oidcConnection.oidcProvider;
    const { ssoTraces } = this;
    let tokens: AuthorizationCodeGrantResult | undefined = undefined;

    // Get public client info from session (set during authorize)
    const sessionIsPublicClient = session.isPublicClient || false;
    const sessionUpstreamRedirectUri =
      session.upstreamRedirectUri || this.opts.externalUrl + this.opts.oidcPath;

    try {
      const client = (await dynamicImport('openid-client')) as typeof import('openid-client');
      telemetry.enrich({
        upstream_redirect_uri: sessionUpstreamRedirectUri,
        upstream_client_auth: sessionIsPublicClient ? 'pkce' : 'client_secret_and_pkce',
        redirect_allowed: true,
      });
      const oidcConfig = await telemetry.stage('upstream_discovery', () =>
        oidcClientConfig({
          discoveryUrl,
          metadata,
          clientId,
          // For public clients (mobile/SPA), don't send client_secret - rely on PKCE
          clientSecret: sessionIsPublicClient ? undefined : clientSecret,
          ssoTraces: {
            instance: ssoTraces,
            context: {
              tenant: oidcConnection.tenant,
              product: oidcConnection.product,
              clientID: oidcConnection.clientID,
              providerName: oidcConnection.oidcProvider.provider,
              redirectUri: redirect_uri,
              relayState: RelayState,
              isSAMLFederated,
              isOIDCFederated,
              acsUrl: session.requested.acsUrl,
              entityId: session.requested.entityId,
              requestedOIDCFlow: !!session.requested.oidc,
              oidcIdPRequest: session?.requested?.oidcIdPRequest,
            },
          },
        })
      );
      // Use the upstream redirect_uri that was used during authorize (must match for token exchange)
      const currentUrl = new URL(sessionUpstreamRedirectUri + '?' + new URLSearchParams(callbackParams));
      tokens = await telemetry.stage('upstream_token_exchange', () =>
        client.authorizationCodeGrant(oidcConfig, currentUrl, {
          pkceCodeVerifier: session.oidcCodeVerifier,
          expectedNonce: session.oidcNonce,
          expectedState: callbackParams.state,
          idTokenExpected: true,
        })
      );
      profile = await telemetry.stage('profile_map', () =>
        extractOIDCUserProfile(tokens!, oidcConfig, session.includeOidcTokensInAssertion)
      );
      telemetry.bindProfile(profile.claims);
      telemetry.event('polis_identity_validated', {}, 'Polis OIDC identity validated');

      if (isSAMLFederated) {
        const { responseForm } = await this.ssoHandler.createSAMLResponse({ profile, session });

        await telemetry.stage('session_delete', () => this.sessionStore.delete(RelayState));
        telemetry.event('polis_session_consumed', {}, 'Polis authorization session consumed');

        return { response_form: responseForm };
      }

      const code = await this._buildAuthorizationCode(oidcConnection, profile, session, false);

      const params = { code };

      if (session && session.state) {
        params['state'] = session.state;
      }

      await telemetry.stage('session_delete', () => this.sessionStore.delete(RelayState));
      telemetry.event('polis_session_consumed', {}, 'Polis authorization session consumed');

      return { redirect_url: redirect.success(redirect_uri!, params) };
    } catch (err: any) {
      telemetry.failure(err);
      metrics.increment(protocol === 'oidc' ? 'oauthResponseError' : 'idfedResponseError', {
        protocol,
        login_type,
      });
      const { error, error_description, error_uri, session_state, scope, stack } = err;
      const error_message = error_description || getErrorMessage(err);
      if (!telemetry.telemetryActive()) this.opts.logger.error(`OIDCResponse error: ${error_message}`);
      const traceId = await this.ssoTraces.saveTrace({
        error: error_message,
        context: {
          tenant: oidcConnection.tenant,
          product: oidcConnection.product,
          clientID: oidcConnection.clientID,
          providerName: oidcConnection.oidcProvider.provider,
          redirectUri: redirect_uri,
          relayState: RelayState,
          isSAMLFederated,
          isOIDCFederated,
          acsUrl: session.requested.acsUrl,
          entityId: session.requested.entityId,
          requestedOIDCFlow: !!session.requested.oidc,
          oidcIdPRequest: session?.requested?.oidcIdPRequest,
          profile,
          error,
          error_description,
          error_uri,
          session_state_from_op_error: session_state,
          scope_from_op_error: scope,
          stack,
          oidcTokenSet: { id_token: tokens?.id_token, access_token: tokens?.access_token },
        },
      });
      if (isSAMLFederated) {
        throw err;
      }
      return {
        redirect_url: OAuthErrorResponse({
          error: (error as OAuthErrorHandlerParams['error']) || 'server_error',
          error_description: traceId ? `${traceId}: ${error_message}` : error_message,
          redirect_uri: redirect_uri!,
          state: session.state,
        }),
        error: `${error} - ${error_message}`,
      };
    }
  }

  // Build the authorization code for the session
  private async _buildAuthorizationCode(
    connection: SAMLSSORecord | OIDCSSORecord,
    profile: any,
    session: any,
    isIdPFlow: boolean
  ) {
    telemetry.setStage('code_issue');
    // Store details against a code
    const code = crypto.randomBytes(20).toString('hex');

    const requested = isIdPFlow
      ? {
          isIdPFlow: true,
          tenant: connection.tenant,
          product: connection.product,
          providerName: (connection as SAMLSSORecord).idpMetadata.provider,
        }
      : session
        ? session.requested
        : null;

    const codeVal = {
      profile,
      clientID: connection.clientID,
      clientSecret: connection.clientSecret,
      requested,
      isIdPFlow,
      telemetry: telemetry.continuation(),
    };

    if (session) {
      codeVal['session'] = session;
    }

    const { hexKey, encVal } = encrypt(codeVal);

    await telemetry.stage('code_store', () => this.codeStore.put(code, encVal));
    const wireCode = hexKey + '.' + code;
    telemetry.enrich({
      authorization_code_fp: telemetry.fingerprint('oauth-code', wireCode),
      code_ttl_seconds: this.opts.db.ttl,
    });
    telemetry.event('polis_code_issued', {}, 'Polis authorization code issued');
    return wireCode;
  }

  /**
   * @openapi
   *
   * /oauth/token:
   *   post:
   *     tags:
   *       - OAuth
   *     summary: Code exchange
   *     operationId: oauth-code-exchange
   *     requestBody:
   *       content:
   *         application/x-www-form-urlencoded:
   *           schema:
   *             required:
   *               - client_id
   *               - client_secret
   *               - code
   *               - grant_type
   *               - redirect_uri
   *             type: object
   *             properties:
   *               grant_type:
   *                 type: string
   *                 description: Grant type should be 'authorization_code'
   *                 default: authorization_code
   *               client_id:
   *                 type: string
   *                 description: Use the client_id returned by the SAML connection API
   *               client_secret:
   *                 type: string
   *                 description: Use the client_secret returned by the SAML connection API
   *               code_verifier:
   *                 type: string
   *                 description: code_verifier against the code_challenge in the authz request (relevant to PKCE flow)
   *               redirect_uri:
   *                 type: string
   *                 description: Redirect URI
   *               code:
   *                 type: string
   *                 description: Code
   *       required: true
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 access_token:
   *                   type: string
   *                 token_type:
   *                   type: string
   *                 expires_in:
   *                   type: string
   *               example:
   *                 access_token: 8958e13053832b5af58fdf2ee83f35f5d013dc74
   *                 token_type: bearer
   *                 expires_in: "300"
   *     x-ory-ratelimit-bucket: polis-public-medium
   */
  public async token(body: OAuthTokenReq, authHeader?: string | null): Promise<OAuthTokenRes> {
    return telemetry.withSsoTelemetry('token', this.opts, () => this.tokenWithTelemetry(body, authHeader));
  }

  private async tokenWithTelemetry(body: OAuthTokenReq, authHeader?: string | null): Promise<OAuthTokenRes> {
    let basic_client_id: string | undefined;
    let basic_client_secret: string | undefined;
    let protocol, login_type;
    const jose = (await dynamicImport('jose')) as typeof import('jose');
    try {
      if (authHeader) {
        // Authorization: Basic {Base64(<client_id>:<client_secret>)}
        const base64Credentials = authHeader.split(' ')[1];
        const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
        [basic_client_id, basic_client_secret] = credentials.split(':');
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (err) {
      // no-op
      telemetry.enrich({ client_auth_header_parse_failed: true });
    }

    const { code, grant_type = 'authorization_code', redirect_uri } = body;
    const client_id = 'client_id' in body ? body.client_id : basic_client_id;
    const client_secret = 'client_secret' in body ? body.client_secret : basic_client_secret;
    const code_verifier = 'code_verifier' in body ? body.code_verifier : undefined;

    telemetry.enrich({
      authorization_code_fp: telemetry.fingerprint('oauth-code', code),
      presented_client_id: client_id,
      presented_redirect_uri: redirect_uri,
      downstream_client_id: client_id,
      client_auth_source:
        'client_secret' in body || 'client_id' in body ? 'body' : authHeader ? 'basic' : 'none',
      client_secret_present: !!client_secret,
      code_verifier_present: !!code_verifier,
      grant_type,
    });

    metrics.increment('oauthToken');
    let traceContext = {} as SSOTrace['context'];
    try {
      if (grant_type !== 'authorization_code') {
        throw telemetry.diagnostic(
          new JacksonError('Unsupported grant_type', 400),
          'grant_type_unsupported',
          'request'
        );
      }

      if (!code) {
        throw telemetry.diagnostic(
          new JacksonError('Please specify code', 400),
          'authorization_code_missing',
          'request'
        );
      }

      const codes = code.split('.');
      if (codes.length !== 2) {
        throw telemetry.diagnostic(
          new JacksonError('Invalid code', 403),
          'authorization_code_malformed',
          'protocol'
        );
      }

      const encCodeVal = await telemetry.stage('code_lookup', () => this.codeStore.get(codes[1]));
      telemetry.enrich({ code_lookup: encCodeVal ? 'hit' : 'miss' });
      if (!encCodeVal) {
        throw telemetry.diagnostic(
          new JacksonError('Invalid code', 403),
          'authorization_code_not_found',
          'protocol'
        );
      }

      const codeVal = await telemetry.stage('code_decrypt', async () => {
        try {
          return decrypt(encCodeVal, codes[0]);
        } catch (err) {
          throw telemetry.diagnostic(err, 'authorization_code_decryption_failed', 'protocol');
        }
      });

      if (!codeVal || !codeVal.profile) {
        throw telemetry.diagnostic(
          new JacksonError('Invalid code', 403),
          'authorization_code_profile_missing',
          'protocol'
        );
      }

      if (codeVal.session) telemetry.bindSession(codeVal.session);
      telemetry.restoreContinuation(codeVal.telemetry);
      telemetry.bindProfile(codeVal.profile.claims);
      telemetry.enrich({
        connection_id: codeVal.clientID,
        requested_email: codeVal.requested?.login_hint,
        user_email: codeVal.profile.claims?.email || codeVal.requested?.login_hint,
        downstream_state_fp: telemetry.fingerprint('oauth-state', codeVal.requested?.state),
        downstream_nonce_fp: telemetry.fingerprint('nonce', codeVal.requested?.nonce),
        session_present: !!codeVal.session,
      });
      telemetry.setStage('token_request_validation');

      const requestedOIDCFlow = !!codeVal.requested?.oidc;
      const isOIDCFederated = !!(codeVal.session && 'oidcFederated' in codeVal.session);
      traceContext = {
        tenant: codeVal.requested?.tenant,
        product: codeVal.requested?.product,
        clientID: client_id || '',
        redirectUri: redirect_uri,
        requestedOIDCFlow,
        isOIDCFederated,
        isIdPFlow: codeVal.requested?.isIdPFlow,
        providerName: codeVal.requested?.providerName,
        acsUrl: codeVal.requested?.acsUrl,
        entityId: codeVal.requested?.entityId,
        oAuthStage: 'token_fetch',
      };
      protocol = codeVal.requested.protocol || 'saml';
      login_type = codeVal.isIdPFlow ? 'idp-initiated' : 'sp-initiated';
      telemetry.enrich({ login_type, downstream_protocol: requestedOIDCFlow ? 'oidc' : 'oauth' });

      if (codeVal.requested?.redirect_uri) {
        if (redirect_uri !== codeVal.requested.redirect_uri) {
          telemetry.enrich({ redirect_matches: false });
          throw telemetry.diagnostic(
            new JacksonError(
              `Invalid request: ${!redirect_uri ? 'redirect_uri missing' : 'redirect_uri mismatch'}`,
              400
            ),
            !redirect_uri ? 'redirect_uri_missing' : 'redirect_uri_mismatch',
            'protocol'
          );
        }
        telemetry.enrich({ redirect_matches: true });
      }

      // A sessionless code comes from an IdP-initiated flow. It cannot be a
      // configured public client because no authorization session exists to
      // bind PKCE or an allowlisted public redirect URI. Require confidential
      // client authentication before considering any token exchange branch.
      if (!codeVal.session && (!client_id || !client_secret)) {
        throw telemetry.diagnostic(
          new JacksonError('Please specify client_id and client_secret', 401),
          'sessionless_client_credentials_missing',
          'protocol'
        );
      }

      if (codeVal.session?.code_challenge) {
        telemetry.setStage('pkce_validation');
        telemetry.enrich({
          client_auth_branch: 'pkce',
          downstream_pkce_method: codeVal.session.code_challenge_method,
        });
        // PKCE flow
        let cv = code_verifier;
        if (!code_verifier) {
          throw telemetry.diagnostic(
            new JacksonError('Invalid code_verifier', 401),
            'code_verifier_missing',
            'protocol'
          );
        }

        if (codeVal.session.code_challenge_method?.toLowerCase() === 's256') {
          cv = codeVerifier.encode(code_verifier);
        }

        if (codeVal.session.code_challenge !== cv) {
          telemetry.enrich({ pkce_validated: false });
          throw telemetry.diagnostic(
            new JacksonError('Invalid code_verifier', 401),
            'code_verifier_mismatch',
            'protocol'
          );
        }
        telemetry.enrich({ pkce_validated: true });
        telemetry.setStage('client_authentication');

        // For Federation flow, verify client credentials
        // Public clients (mobile/SPA) are explicitly configured via publicRedirectUrls
        // Confidential clients (web backends) require client_secret
        // The issued session owns the client mode; callers cannot opt out by
        // omitting or changing the client ID. Retain the old prefix check for
        // non-federated records so their existing rejection is unchanged.
        if (
          codeVal.session?.oidcFederated ||
          client_id?.startsWith(`${clientIDFederatedPrefix}${clientIDOIDCPrefix}`)
        ) {
          // Always validate client_id
          if (client_id !== codeVal.session?.oidcFederated?.clientID) {
            throw telemetry.diagnostic(
              new JacksonError('Invalid client_id', 401),
              'client_id_mismatch',
              'protocol'
            );
          }

          // Check if this redirect URI is explicitly marked as public client
          const redirectUri = codeVal.requested?.redirect_uri || redirect_uri;
          const publicRedirectUrls = codeVal.session?.oidcFederated?.publicRedirectUrls || [];
          const isPublicClient = publicRedirectUrls.includes(redirectUri);
          telemetry.enrich({
            downstream_client_type: isPublicClient ? 'public' : 'confidential',
            client_auth_branch: isPublicClient ? 'federation_public_pkce' : 'federation_confidential_pkce',
          });

          if (isPublicClient) {
            // Public client (mobile app, SPA): Must use PKCE, no client_secret required
            if (!codeVal.session?.code_challenge) {
              throw telemetry.diagnostic(
                new JacksonError('Public clients must use PKCE', 401),
                'public_client_pkce_required',
                'protocol'
              );
            }
            // PKCE already validated above at lines 1235-1248
          } else {
            // Confidential client (web backend): Must provide client_secret
            if (!client_secret) {
              throw telemetry.diagnostic(
                new JacksonError('Confidential clients must provide client_secret', 401),
                'client_secret_missing',
                'protocol'
              );
            }
            if (client_secret !== codeVal.session?.oidcFederated?.clientSecret) {
              throw telemetry.diagnostic(
                new JacksonError('Invalid client_secret', 401),
                'client_secret_mismatch',
                'protocol'
              );
            }
            // PKCE is optional but recommended for confidential clients
          }
        }
      } else if (client_id && client_secret) {
        telemetry.setStage('client_authentication');
        telemetry.enrich({ client_auth_branch: 'client_secret', downstream_client_type: 'confidential' });
        // check if we have an encoded client_id
        if (client_id !== 'dummy') {
          const sp = getEncodedTenantProduct(client_id);
          if (!sp) {
            // OAuth flow
            if (client_id !== codeVal.clientID || client_secret !== codeVal.clientSecret) {
              throw telemetry.diagnostic(
                new JacksonError('Invalid client_id or client_secret', 401),
                'client_credentials_mismatch',
                'protocol'
              );
            }
          } else {
            if (
              !codeVal.isIdPFlow &&
              (sp.tenant !== codeVal.requested?.tenant || sp.product !== codeVal.requested?.product)
            ) {
              throw telemetry.diagnostic(
                new JacksonError('Invalid tenant or product', 401),
                'client_scope_mismatch',
                'protocol'
              );
            }
            // encoded client_id, verify client_secret
            if (client_secret !== this.opts.clientSecretVerifier) {
              throw telemetry.diagnostic(
                new JacksonError('Invalid client_secret', 401),
                'client_secret_mismatch',
                'protocol'
              );
            }
          }
        } else {
          if (client_secret !== this.opts.clientSecretVerifier && client_secret !== codeVal.clientSecret) {
            throw telemetry.diagnostic(
              new JacksonError('Invalid client_secret', 401),
              'client_secret_mismatch',
              'protocol'
            );
          }
        }
      } else if (codeVal && codeVal.session) {
        throw telemetry.diagnostic(
          new JacksonError('Please specify client_secret or code_verifier', 401),
          'client_authentication_missing',
          'protocol'
        );
      }

      telemetry.enrich({ client_auth_validated: true });
      telemetry.setStage('token_issue');

      // store details against a token
      const token = crypto.randomBytes(20).toString('hex');

      if (this.opts.flattenRawClaims) {
        codeVal.profile.claims = { ...codeVal.profile.claims, ...codeVal.profile.claims.raw };
        delete codeVal.profile.claims.raw;
      }

      const tokenVal = {
        ...codeVal.profile,
        requested: codeVal.requested,
        clientID: codeVal.clientID,
        login_type,
        protocol,
        telemetry: telemetry.continuation(),
      };

      let subject = codeVal.profile.claims.id;
      if (this.opts.openid?.subjectPrefix) {
        subject =
          codeVal.requested?.tenant + ':' + codeVal.requested?.product + ':' + codeVal.profile.claims.id;
        if (subject.length > 255) {
          subject = crypto.createHash('sha512').update(subject).digest('hex');
        }
      }

      const requestHasNonce = !!codeVal.requested?.nonce;
      telemetry.enrich({ issued_subject: subject });
      if (requestedOIDCFlow) {
        const { jwtSigningKeys, jwsAlg } = this.opts.openid ?? {};
        if (!jwtSigningKeys || !isJWSKeyPairLoaded(jwtSigningKeys)) {
          throw telemetry.diagnostic(
            new JacksonError(GENERIC_ERR_STRING, 500, 'JWT signing keys are not loaded'),
            'signing_keys_missing',
            'configuration'
          );
        }

        let claims: Record<string, string> = requestHasNonce ? { nonce: codeVal.requested.nonce } : {};
        claims = {
          ...claims,
          requested: codeVal.profile.requested,
          ...codeVal.profile.claims,
          id: subject,
        };
        const signingKey = await loadJWSPrivateKey(jwtSigningKeys.private, jwsAlg!);
        const kid = await computeKid(jwtSigningKeys.public, jwsAlg!);
        const id_token = await new jose.SignJWT(claims)
          .setProtectedHeader({ alg: jwsAlg!, kid })
          .setIssuedAt()
          .setIssuer(this.opts.externalUrl)
          .setSubject(subject)
          .setAudience(tokenVal.requested.client_id)
          .setExpirationTime(`${this.opts.db.ttl}s`) //  identity token only really needs to be valid long enough for it to be verified by the client application.
          .sign(signingKey);
        tokenVal.id_token = id_token;
        tokenVal.claims.sub = subject;
        telemetry.enrich({
          id_token_fp: telemetry.fingerprint('id-token', id_token),
          issued_token_alg: jwsAlg,
          issued_token_kid: kid,
          issued_token_issuer: this.opts.externalUrl,
          issued_token_audience: tokenVal.requested.client_id,
          issued_nonce_fp: telemetry.fingerprint('nonce', claims.nonce),
        });
      }

      tokenVal.telemetry = telemetry.continuation();

      const { hexKey, encVal } = encrypt(tokenVal);

      await telemetry.stage('token_store', () => this.tokenStore.put(token, encVal));
      const wireToken = hexKey + '.' + token;
      telemetry.enrich({
        access_token_fp: telemetry.fingerprint('access-token', wireToken),
        token_ttl_seconds: this.opts.db.ttl,
      });

      // delete the code
      await telemetry.stage('code_cleanup', async () => {
        try {
          await this.codeStore.delete(codes[1]);
          telemetry.event('polis_code_consumed', {}, 'Polis authorization code consumed');
        } catch (err) {
          telemetry.warning(err, 'authorization_code_cleanup_failed', { token_issued: true });
        }
      });

      const tokenResponse: OAuthTokenRes = {
        access_token: wireToken,
        token_type: 'bearer',
        expires_in: this.opts.db.ttl!,
      };

      if (requestedOIDCFlow) {
        tokenResponse.id_token = tokenVal.id_token;
      }

      telemetry.setStage('token_response');
      telemetry.event('polis_token_redeemed', {}, 'Polis token redemption succeeded');
      return tokenResponse;
    } catch (err: any) {
      telemetry.failure(err);
      metrics.increment('oauthTokenError', { protocol, login_type });
      this.ssoTraces.saveTrace({ error: err.message, context: traceContext });
      throw err;
    }
  }

  /**
   * @openapi
   *
   * /oauth/userinfo:
   *   get:
   *     tags:
   *       - OAuth
   *     summary: Get profile
   *     operationId: oauth-get-profile
   *     responses:
   *       200:
   *         description: Success
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id:
   *                   type: string
   *                 email:
   *                   type: string
   *                 firstName:
   *                   type: string
   *                 lastName:
   *                   type: string
   *                 roles:
   *                   type: array
   *                   items:
   *                     type: string
   *                 groups:
   *                   type: array
   *                   items:
   *                     type: string
   *                 raw:
   *                   type: object
   *                   properties: {}
   *                 requested:
   *                   type: object
   *                   properties: {}
   *               example:
   *                 id: 32b5af58fdf
   *                 email: jackson@coolstartup.com
   *                 firstName: SAML
   *                 lastName: Jackson
   *                 raw: {}
   *                 requested: {}
   *     x-ory-ratelimit-bucket: polis-public-high
   */
  public async userInfo(token: string): Promise<Profile> {
    return telemetry.withSsoTelemetry('userinfo', this.opts, () => this.userInfoWithTelemetry(token));
  }

  private async userInfoWithTelemetry(token: string): Promise<Profile> {
    telemetry.enrich({ access_token_fp: telemetry.fingerprint('access-token', token) });
    const tokens = token.split('.');
    if (tokens.length !== 2) {
      throw telemetry.diagnostic(
        new JacksonError('Invalid token', 403),
        'access_token_malformed',
        'protocol'
      );
    }

    const encRsp = await telemetry.stage('token_lookup', () => this.tokenStore.get(tokens[1]));
    telemetry.enrich({ token_lookup: encRsp ? 'hit' : 'miss' });
    if (!encRsp) {
      throw telemetry.diagnostic(
        new JacksonError('Invalid token', 403),
        'access_token_not_found',
        'protocol'
      );
    }

    const rsp = await telemetry.stage('token_decrypt', async () => {
      try {
        return decrypt(encRsp, tokens[0]);
      } catch (err) {
        throw telemetry.diagnostic(err, 'access_token_decryption_failed', 'protocol');
      }
    });
    telemetry.restoreContinuation(rsp?.telemetry);
    telemetry.bindProfile(rsp?.claims);
    telemetry.enrich({
      connection_id: rsp?.clientID,
      requested_email: rsp?.requested?.login_hint,
      returned_profile_id: rsp?.claims?.id,
      returned_subject: rsp?.claims?.sub,
    });
    telemetry.setStage('userinfo_profile');

    const traceContext: SSOTrace['context'] = {
      tenant: rsp.requested?.tenant,
      product: rsp.requested?.product,
      clientID: rsp.clientID,
      isIdPFlow: rsp.requested?.isIdPFlow,
      providerName: rsp.requested?.providerName,
      acsUrl: rsp.requested?.acsUrl,
      entityId: rsp.requested?.entityId,
      oAuthStage: 'userinfo_fetch',
    };

    metrics.increment('oauthUserInfo');

    if (!rsp || !rsp.claims) {
      metrics.increment('oauthUserInfoError', { protocol: rsp.protocol, login_type: rsp.login_type });
      this.ssoTraces.saveTrace({ error: 'Invalid token', context: traceContext });
      throw telemetry.diagnostic(
        new JacksonError('Invalid token', 403),
        'access_token_profile_missing',
        'protocol'
      );
    }

    telemetry.event('polis_userinfo_served', {}, 'Polis userinfo served');
    return { ...rsp.claims, requested: rsp.requested };
  }
}
