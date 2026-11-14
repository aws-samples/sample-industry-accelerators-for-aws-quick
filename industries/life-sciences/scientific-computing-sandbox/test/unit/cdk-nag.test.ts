// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DEFAULT_IDLE_TIMEOUT_SECONDS, DEFAULT_MAX_LIFETIME_SECONDS } from '../../lib/config/app-config';
import { GatewayStack, SandboxNetworkStack, SandboxRuntimeStack } from '../../lib/stacks';

// bin/app.ts applies the same checks, so any finding here would also fail `cdk synth` and `cdk deploy`.
describe('AWS Solutions checks (cdk-nag)', () => {
  const env = { account: '123456789012', region: 'us-west-2' };
  const projectName = 'test-app';
  const app = new App();
  Aspects.of(app).add(new AwsSolutionsChecks());
  const network = new SandboxNetworkStack(app, `${projectName}-Network`, { env, projectName });
  const runtime = new SandboxRuntimeStack(app, `${projectName}-Runtime`, {
    env,
    projectName,
    network: network.network,
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    maxLifetimeSeconds: DEFAULT_MAX_LIFETIME_SECONDS,
  });
  const gateway = new GatewayStack(app, `${projectName}-Gateway`, {
    env,
    projectName,
    jwt: {
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      allowedClients: ['client-a'],
      allowedAudiences: [],
      allowedScopes: [],
    },
    runtimes: runtime.runtimes,
    network: network.network,
  });

  test.each<[string, Stack]>([
    ['Network', network],
    ['Runtime', runtime],
    ['Gateway', gateway],
  ])('the %s stack has no unsuppressed findings', (_, stack) => {
    const findings = Match.stringLikeRegexp('AwsSolutions-.*');
    expect(Annotations.fromStack(stack).findError('*', findings)).toEqual([]);
    expect(Annotations.fromStack(stack).findWarning('*', findings)).toEqual([]);
  });
});
