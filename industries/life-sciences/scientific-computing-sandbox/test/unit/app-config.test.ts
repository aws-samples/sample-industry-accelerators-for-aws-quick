// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { DEFAULT_TOOLS_RESERVED_CONCURRENCY, loadConfig } from '../../lib/config/app-config';

const JWT_CONTEXT = {
  jwtDiscoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  jwtAllowedClients: 'client-a',
};

const load = (context: Record<string, unknown>) =>
  loadConfig(new App({ context: { projectName: 'ls-scientific-computing-sandbox', ...JWT_CONTEXT, ...context } }));

describe('loadConfig', () => {
  test('reads the project name and the JWT settings', () => {
    expect(load({}).projectName).toBe('ls-scientific-computing-sandbox');
    expect(load({ projectName: 'my-sandbox' }).projectName).toBe('my-sandbox');
    expect(load({}).jwt).toEqual({
      discoveryUrl: JWT_CONTEXT.jwtDiscoveryUrl,
      allowedClients: ['client-a'],
      allowedAudiences: [],
      allowedScopes: [],
    });
  });

  test('rejects a project name that would rename deployed resources unexpectedly', () => {
    // zsh passes an unquoted "$CTX" holding several -c flags as one argument.
    expect(() => load({ projectName: 'my-sandbox -c jwtAllowedClients=x' })).toThrow(/projectName must be/);
    expect(() => load({ projectName: 'My_Sandbox' })).toThrow(/projectName must be/);
    expect(() => load({ projectName: 'my--sandbox' })).toThrow(/projectName must be/);
    expect(() => load({ projectName: 'a'.repeat(37) })).toThrow(/projectName must be/);
  });

  test('fails closed without allowed clients or audiences', () => {
    expect(() => load({ jwtAllowedClients: '' })).toThrow(/Set jwtAllowedClients, jwtAllowedAudiences, or both/);
  });

  test('accepts the longest project name whose derived resource names fit', () => {
    // `<projectName>-caller-identity-interceptor` must fit Lambda's 64-character function name limit.
    const projectName = 'a'.repeat(36);
    expect(load({ projectName }).projectName).toBe(projectName);
    expect(`${projectName}-caller-identity-interceptor`).toHaveLength(64);
  });

  test('rejects non-integer lifetimes', () => {
    expect(() => load({ idleTimeoutSeconds: '1h' })).toThrow(/idleTimeoutSeconds must be an integer/);
    expect(load({ idleTimeoutSeconds: '600' }).idleTimeoutSeconds).toBe(600);
  });

  test('reads availabilityZoneIds as a comma-separated string or an array', () => {
    expect(load({}).availabilityZoneIds).toBeUndefined();
    expect(load({ availabilityZoneIds: 'use1-az1, use1-az4' }).availabilityZoneIds).toEqual(['use1-az1', 'use1-az4']);
    expect(load({ availabilityZoneIds: ['use1-az2', 'use1-az4'] }).availabilityZoneIds).toEqual(['use1-az2', 'use1-az4']);
    // AZ names map to different AZs in each account, so only IDs are accepted.
    expect(() => load({ availabilityZoneIds: 'us-east-1a,us-east-1b' })).toThrow(/must be AZ IDs/);
  });

  test('reserves concurrency for the tools Lambda by default, unless set to none', () => {
    expect(load({}).toolsReservedConcurrency).toBe(DEFAULT_TOOLS_RESERVED_CONCURRENCY);
    expect(load({ toolsReservedConcurrency: '20' }).toolsReservedConcurrency).toBe(20);
    expect(load({ toolsReservedConcurrency: 'none' }).toolsReservedConcurrency).toBeUndefined();
    for (const value of ['0', '-5', '2.5', 'lots']) {
      expect(() => load({ toolsReservedConcurrency: value })).toThrow(/toolsReservedConcurrency must be a positive integer/);
    }
  });
});
