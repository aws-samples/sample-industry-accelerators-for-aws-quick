// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { loadConfig } from '../../lib/config/app-config';
import { loadJwtAuthorizerConfig, toCustomJwtAuthorizer } from '../../lib/config/jwt-authorizer';

const DISCOVERY = 'https://idp.example.com/.well-known/openid-configuration';

const load = (context: Record<string, unknown>) => loadJwtAuthorizerConfig(new App({ context }));

describe('JWT authorizer configuration', () => {
  test('reads comma-separated lists and trims them', () => {
    expect(
      load({
        jwtDiscoveryUrl: DISCOVERY,
        jwtAllowedClients: 'client-a, client-b',
        jwtAllowedScopes: 'openid',
      }),
    ).toEqual({
      discoveryUrl: DISCOVERY,
      allowedClients: ['client-a', 'client-b'],
      allowedAudiences: [],
      allowedScopes: ['openid'],
    });
  });

  test('accepts lists from cdk.json as arrays', () => {
    expect(load({ jwtDiscoveryUrl: DISCOVERY, jwtAllowedAudiences: ['api://quick'] }).allowedAudiences).toEqual([
      'api://quick',
    ]);
  });

  test('requires a discovery URL', () => {
    expect(() => load({ jwtAllowedClients: 'client-a' })).toThrow(/jwtDiscoveryUrl is required/);
  });

  test.each([
    'http://idp.example.com/.well-known/openid-configuration',
    'https://idp.example.com/oauth2/certs',
    'https://idp.example.com/.well-known/openid-configuration?x=1',
  ])('rejects the malformed discovery URL %s', (url) => {
    expect(() => load({ jwtDiscoveryUrl: url, jwtAllowedClients: 'client-a' })).toThrow(/must be an https URL/);
  });

  test('accepts OAuth authorization server metadata URLs', () => {
    const url = 'https://idp.example.com/.well-known/oauth-authorization-server/tenant';
    expect(load({ jwtDiscoveryUrl: url, jwtAllowedClients: 'client-a' }).discoveryUrl).toBe(url);
  });

  test('fails closed when neither clients nor audiences are allowed', () => {
    expect(() => load({ jwtDiscoveryUrl: DISCOVERY, jwtAllowedScopes: 'openid' })).toThrow(
      /Set jwtAllowedClients, jwtAllowedAudiences, or both/,
    );
  });

  test('leaves empty lists out of the authorizer property', () => {
    expect(toCustomJwtAuthorizer(load({ jwtDiscoveryUrl: DISCOVERY, jwtAllowedClients: 'client-a' }))).toEqual({
      discoveryUrl: DISCOVERY,
      allowedClients: ['client-a'],
    });
  });
});

describe('projectName', () => {
  const jwt = { jwtDiscoveryUrl: DISCOVERY, jwtAllowedClients: 'client-a' };

  test.each(['my-app', 'a', 'a1-b2'])('accepts %s', (projectName) => {
    expect(loadConfig(new App({ context: { ...jwt, projectName } })).projectName).toBe(projectName);
  });

  test.each(['My-App', '1app', 'my--app', 'my-app-', '-c x=1 -c y=2', 'a'.repeat(37)])('rejects %s', (projectName) => {
    expect(() => loadConfig(new App({ context: { ...jwt, projectName } }))).toThrow(/projectName must be/);
  });
});
