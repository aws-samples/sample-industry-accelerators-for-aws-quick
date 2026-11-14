#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config/app-config';
import { GatewayStack, SandboxNetworkStack, SandboxRuntimeStack } from '../lib/stacks';

const app = new App();
// AWS Solutions checks run on every synth and deploy: an unsuppressed finding fails synthesis. The reports
// (cdk.out/AwsSolutions-*-NagReport.csv) are what security scanners read.
Aspects.of(app).add(new AwsSolutionsChecks({ reports: true }));
const config = loadConfig(app);
const { projectName, jwt } = config;

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// An isolated VPC: the sandboxes have no internet route, and reach only the AWS endpoints the platform needs.
const sandboxNetwork = new SandboxNetworkStack(app, `${projectName}-Network`, {
  env,
  projectName,
  availabilityZoneIds: config.availabilityZoneIds,
  description: `${projectName}: isolated VPC with VPC endpoints and DNS Firewall for the sandbox runtimes`,
});

const sandboxRuntime = new SandboxRuntimeStack(app, `${projectName}-Runtime`, {
  env,
  projectName,
  network: sandboxNetwork.network,
  idleTimeoutSeconds: config.idleTimeoutSeconds,
  maxLifetimeSeconds: config.maxLifetimeSeconds,
  description: `${projectName}: one Amazon Bedrock AgentCore Runtime per Scientific Computing Sandbox environment`,
});

new GatewayStack(app, `${projectName}-Gateway`, {
  env,
  projectName,
  jwt,
  runtimes: sandboxRuntime.runtimes,
  network: sandboxNetwork.network,
  toolsReservedConcurrency: config.toolsReservedConcurrency,
  description: `${projectName}: AgentCore Gateway that AWS Quick connects to, with the sandbox tools and interceptor Lambdas`,
});
