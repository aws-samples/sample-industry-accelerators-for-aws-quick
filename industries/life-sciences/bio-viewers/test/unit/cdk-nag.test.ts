// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BioViewersRuntimeStack, GatewayStack } from '../../lib/stacks';

// bin/app.ts applies the same checks, so any finding here would also fail `cdk synth` and `cdk deploy`.
describe('AWS Solutions checks (cdk-nag)', () => {
  const env = { account: '123456789012', region: 'us-west-2' };
  const app = new App();
  Aspects.of(app).add(new AwsSolutionsChecks());
  const runtime = new BioViewersRuntimeStack(app, 'test-app-Runtime', { env, projectName: 'test-app' });
  const gateway = new GatewayStack(app, 'test-app-Gateway', {
    env,
    projectName: 'test-app',
    jwt: {
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      allowedClients: ['client-a'],
      allowedAudiences: [],
      allowedScopes: [],
    },
    targetRuntime: runtime.runtime,
    targetEndpoint: runtime.mcpEndpoint,
  });

  test.each<[string, Stack]>([
    ['Runtime', runtime],
    ['Gateway', gateway],
  ])('the %s stack has no unsuppressed findings', (_, stack) => {
    const findings = Match.stringLikeRegexp('AwsSolutions-.*');
    expect(Annotations.fromStack(stack).findError('*', findings)).toEqual([]);
    expect(Annotations.fromStack(stack).findWarning('*', findings)).toEqual([]);
  });
});
