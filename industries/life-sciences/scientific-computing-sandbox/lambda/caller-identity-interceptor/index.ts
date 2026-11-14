// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AgentCore Gateway REQUEST interceptor that turns the caller's access token
 * into a trusted identity header for the sandbox tools Lambda.
 *
 * The Gateway's CUSTOM_JWT authorizer has already validated the token. This
 * function verifies it again with the same settings (the JWT_* environment
 * variables, set from the Gateway's jwt* context keys): the signature against
 * the identity provider's JWKS, the issuer from its discovery document, expiry,
 * and the allowed clients, audiences and scopes. A misconfigured authorizer
 * therefore cannot leave the target without a verified identity. It then
 * always overwrites CALLER_SUB_HEADER with the token's `sub`, so a
 * client-supplied value for that header never survives.
 *
 * The request body is returned unchanged. Headers, tokens, subjects and the
 * body (which holds tool arguments and code) are never logged.
 */
import { JwtVerifier } from 'aws-jwt-verify';
import {
  JwtExpiredError,
  JwtInvalidAudienceError,
  JwtInvalidIssuerError,
  JwtInvalidSignatureError,
  JwtNotBeforeError,
  JwtParseError,
} from 'aws-jwt-verify/error';
import type { JwtPayload } from 'aws-jwt-verify/jwt-model';
import { CALLER_SUB_HEADER, isValidCallerSub } from '../../lib/identity';

/** How long to wait for the identity provider's discovery document. */
const DISCOVERY_TIMEOUT_MS = 5_000;

interface JwtSettings {
  readonly discoveryUrl: string;
  readonly allowedClients: string[];
  readonly allowedAudiences: string[];
  readonly allowedScopes: string[];
}

/** A configuration or discovery problem: every request is rejected until it is fixed. */
class InterceptorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterceptorConfigError';
  }
}

/** A token that verified but whose claims the settings do not allow. */
class DisallowedClaimError extends Error {
  constructor(readonly reason: 'CLIENT_NOT_ALLOWED' | 'SCOPE_NOT_ALLOWED') {
    super(reason);
  }
}

/** A fixed reason for the log; the bundle is minified, so error class names are not usable. */
function rejectionReason(err: unknown): string {
  if (err instanceof DisallowedClaimError) return err.reason;
  if (err instanceof JwtExpiredError || err instanceof JwtNotBeforeError) return 'EXPIRED_OR_NOT_YET_VALID';
  if (err instanceof JwtInvalidIssuerError) return 'ISSUER_NOT_ALLOWED';
  if (err instanceof JwtInvalidAudienceError) return 'AUDIENCE_NOT_ALLOWED';
  if (err instanceof JwtInvalidSignatureError) return 'INVALID_SIGNATURE';
  if (err instanceof JwtParseError) return 'MALFORMED_TOKEN';
  return 'INVALID_TOKEN';
}

function stringList(name: string): string[] {
  const raw = process.env[name];
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : [];
  } catch {
    throw new InterceptorConfigError(`${name} is not a JSON array`);
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new InterceptorConfigError(`${name} must be a JSON array of strings`);
  }
  return value;
}

function readSettings(): JwtSettings {
  const discoveryUrl = process.env.JWT_DISCOVERY_URL ?? '';
  if (!discoveryUrl.startsWith('https://')) {
    throw new InterceptorConfigError('JWT_DISCOVERY_URL must be an https URL');
  }
  const settings = {
    discoveryUrl,
    allowedClients: stringList('JWT_ALLOWED_CLIENTS'),
    allowedAudiences: stringList('JWT_ALLOWED_AUDIENCES'),
    allowedScopes: stringList('JWT_ALLOWED_SCOPES'),
  };
  // Fail closed: checking only the issuer would accept a token issued to any application of the identity provider.
  if (settings.allowedClients.length === 0 && settings.allowedAudiences.length === 0) {
    throw new InterceptorConfigError('set JWT_ALLOWED_CLIENTS, JWT_ALLOWED_AUDIENCES, or both');
  }
  return settings;
}

/** The token's scopes: a space-separated `scope` claim (RFC 9068, Cognito), or `scp` as an array or string (Okta, Entra ID). */
function tokenScopes(payload: JwtPayload): string[] {
  const scopes: string[] = [];
  for (const claim of [payload.scope, payload.scp]) {
    if (typeof claim === 'string') scopes.push(...claim.split(' '));
    else if (Array.isArray(claim)) scopes.push(...claim.filter((s): s is string => typeof s === 'string'));
  }
  return scopes.filter((s) => s !== '');
}

function checkClaims(payload: JwtPayload, settings: JwtSettings): void {
  if (settings.allowedClients.length > 0 && !settings.allowedClients.includes(payload.client_id as string)) {
    throw new DisallowedClaimError('CLIENT_NOT_ALLOWED');
  }
  if (settings.allowedScopes.length > 0) {
    const scopes = tokenScopes(payload);
    if (!scopes.some((scope) => settings.allowedScopes.includes(scope))) {
      throw new DisallowedClaimError('SCOPE_NOT_ALLOWED');
    }
  }
}

async function createVerifier() {
  const settings = readSettings();
  let document: Record<string, unknown>;
  try {
    const res = await fetch(settings.discoveryUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new InterceptorConfigError('could not fetch the discovery document');
  }
  const { issuer, jwks_uri: jwksUri } = document ?? {};
  if (typeof issuer !== 'string' || issuer === '' || typeof jwksUri !== 'string' || !jwksUri.startsWith('https://')) {
    throw new InterceptorConfigError('the discovery document needs an issuer and an https jwks_uri');
  }
  return JwtVerifier.create({
    issuer,
    jwksUri,
    audience: settings.allowedAudiences.length > 0 ? settings.allowedAudiences : null,
    customJwtCheck: ({ payload }) => checkClaims(payload, settings),
  });
}

// Created on first use and kept for the life of the container, so the discovery document and the JWKS are fetched
// once per cold start. A failed attempt is not cached, so the next request tries again.
let verifierPromise: ReturnType<typeof createVerifier> | undefined;

function verifier(): ReturnType<typeof createVerifier> {
  if (!verifierPromise) {
    verifierPromise = createVerifier().catch((err) => {
      verifierPromise = undefined;
      throw err;
    });
  }
  return verifierPromise;
}

export interface InterceptorEvent {
  mcp?: {
    gatewayRequest?: {
      headers?: Record<string, unknown>;
      body?: { id?: unknown } & Record<string, unknown>;
    };
  };
}

function bearerToken(headers: Record<string, unknown> = {}): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization');
  const value = entry?.[1];
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1];
}

/** Short-circuits the request with a JSON-RPC error; the target is never invoked. */
function reject(body: { id?: unknown } | undefined, message: string) {
  const id = body?.id ?? null;
  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayResponse: {
        statusCode: 200,
        body: { jsonrpc: '2.0', id, error: { code: -32001, message } },
      },
    },
  };
}

export async function handler(event: InterceptorEvent) {
  const request = event?.mcp?.gatewayRequest;
  const body = request?.body;
  const token = bearerToken(request?.headers);
  if (!token) {
    console.log(JSON.stringify({ outcome: 'REJECTED', reason: 'MISSING_TOKEN' }));
    return reject(body, 'Unauthorized: missing bearer token');
  }

  let jwtVerifier: Awaited<ReturnType<typeof createVerifier>>;
  try {
    jwtVerifier = await verifier();
  } catch (err) {
    // Only this function's own messages are logged: they name a setting or the discovery step, never caller input.
    const detail = err instanceof InterceptorConfigError ? err.message : (err as Error)?.name;
    console.log(JSON.stringify({ outcome: 'REJECTED', reason: 'CONFIGURATION', detail }));
    return reject(body, 'Unauthorized: the access token cannot be verified right now');
  }

  let sub: unknown;
  try {
    sub = (await jwtVerifier.verify(token)).sub;
  } catch (err) {
    console.log(JSON.stringify({ outcome: 'REJECTED', reason: rejectionReason(err) }));
    return reject(body, 'Unauthorized: invalid access token');
  }
  if (!isValidCallerSub(sub)) {
    console.log(JSON.stringify({ outcome: 'REJECTED', reason: 'INVALID_SUB' }));
    return reject(body, 'Unauthorized: access token has no usable subject');
  }

  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayRequest: {
        // Interceptor headers take precedence over client-provided ones, so this
        // replaces any value the client sent for the same header.
        headers: { [CALLER_SUB_HEADER]: sub },
        body,
      },
    },
  };
}
