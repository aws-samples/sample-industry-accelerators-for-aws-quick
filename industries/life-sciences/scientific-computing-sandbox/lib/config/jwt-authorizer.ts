// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Inbound JWT authentication settings shared by every accelerator in this
 * repository. Customers bring their own OIDC identity provider; the Gateway's
 * CUSTOM_JWT authorizer trusts it through these CDK context keys:
 *
 *   jwtDiscoveryUrl      required  OIDC discovery or OAuth metadata URL
 *   jwtAllowedClients    one of    `client_id` claim values (comma-separated)
 *   jwtAllowedAudiences  these    `aud` claim values (comma-separated)
 *   jwtAllowedScopes     optional  scope values; the token needs at least one
 *
 * This file is copied into each accelerator. Keep the copies identical.
 */

import { App } from 'aws-cdk-lib';

export interface JwtAuthorizerConfig {
  /** The identity provider's discovery document URL. */
  readonly discoveryUrl: string;
  /** Allowed `client_id` claim values. */
  readonly allowedClients: string[];
  /** Allowed `aud` claim values. */
  readonly allowedAudiences: string[];
  /** Allowed scopes; empty means scopes are not checked. */
  readonly allowedScopes: string[];
}

/** The URL shape AgentCore accepts for a discovery URL. */
export const DISCOVERY_URL_PATTERN =
  /^https:\/\/[^\s?#]+\/\.well-known\/(openid-configuration|oauth-authorization-server)(\/[^\s?#]+)?$/;

/** Reads a list from context: an array, or a comma-separated string (as `-c key=a,b` passes it). */
export function listContext(app: App, key: string): string[] {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  return values.map((value) => String(value).trim()).filter((value) => value !== '');
}

/**
 * Validates the settings and returns them. Throws when the discovery URL is
 * missing or malformed, or when neither clients nor audiences are allowed: an
 * authorizer that checks only the issuer would accept a token that the
 * identity provider issued to any of its applications.
 */
export function validateJwtAuthorizerConfig(config: JwtAuthorizerConfig): JwtAuthorizerConfig {
  if (!config.discoveryUrl) {
    throw new Error(
      'jwtDiscoveryUrl is required: pass -c jwtDiscoveryUrl=<your identity provider discovery URL>. ' +
        'See docs/authentication.md in the repository root.',
    );
  }
  if (!DISCOVERY_URL_PATTERN.test(config.discoveryUrl)) {
    throw new Error(
      'jwtDiscoveryUrl must be an https URL ending in /.well-known/openid-configuration or ' +
        `/.well-known/oauth-authorization-server, got '${config.discoveryUrl}'`,
    );
  }
  if (config.allowedClients.length === 0 && config.allowedAudiences.length === 0) {
    throw new Error(
      'Set jwtAllowedClients, jwtAllowedAudiences, or both. Without either, the Gateway would accept ' +
        'tokens issued to any application of your identity provider.',
    );
  }
  return config;
}

/** Loads and validates the JWT settings from CDK context. */
export function loadJwtAuthorizerConfig(app: App): JwtAuthorizerConfig {
  const discoveryUrl = app.node.tryGetContext('jwtDiscoveryUrl');
  return validateJwtAuthorizerConfig({
    discoveryUrl: typeof discoveryUrl === 'string' ? discoveryUrl.trim() : '',
    allowedClients: listContext(app, 'jwtAllowedClients'),
    allowedAudiences: listContext(app, 'jwtAllowedAudiences'),
    allowedScopes: listContext(app, 'jwtAllowedScopes'),
  });
}

/** The AgentCore `customJwtAuthorizer` property for these settings. Empty lists are left out. */
export function toCustomJwtAuthorizer(config: JwtAuthorizerConfig) {
  validateJwtAuthorizerConfig(config);
  return {
    discoveryUrl: config.discoveryUrl,
    ...(config.allowedClients.length > 0 ? { allowedClients: config.allowedClients } : {}),
    ...(config.allowedAudiences.length > 0 ? { allowedAudience: config.allowedAudiences } : {}),
    ...(config.allowedScopes.length > 0 ? { allowedScopes: config.allowedScopes } : {}),
  };
}
