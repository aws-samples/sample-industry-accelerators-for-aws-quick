#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config/app-config';
import { BioViewersRuntimeStack, GatewayStack } from '../lib/stacks';

const app = new App();
// AWS Solutions checks run on every synth and deploy: an unsuppressed finding fails synthesis. The reports
// (cdk.out/AwsSolutions-*-NagReport.csv) are what security scanners read.
Aspects.of(app).add(new AwsSolutionsChecks({ reports: true }));
const { projectName, jwt } = loadConfig(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const runtime = new BioViewersRuntimeStack(app, `${projectName}-Runtime`, {
  env,
  projectName,
  description: `${projectName}: protein structure, sequence alignment and DICOM MCP Apps viewers on AgentCore Runtime`,
});

new GatewayStack(app, `${projectName}-Gateway`, {
  env,
  projectName,
  jwt,
  targetRuntime: runtime.runtime,
  targetEndpoint: runtime.mcpEndpoint,
  description: `${projectName}: AgentCore Gateway that AWS Quick connects to`,
});
