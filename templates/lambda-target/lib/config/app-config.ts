// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { JwtAuthorizerConfig, loadJwtAuthorizerConfig } from './jwt-authorizer';

/**
 * Lowercase letters, digits and single hyphens, starting with a letter. AgentCore Gateway names allow no
 * consecutive hyphens, and every resource name starts with the project name.
 */
export const PROJECT_NAME_PATTERN = /^[a-z](?:-?[a-z0-9])*$/;
/** Leaves room for the longest suffix this app adds to resource names (`-gateway-role`) within IAM's 64. */
export const PROJECT_NAME_MAX_LENGTH = 36;

/** Settings read from CDK context (`cdk.json` or `-c key=value`). */
export interface AppConfig {
  /** Prefix for stack IDs and resource names. */
  readonly projectName: string;
  /** Inbound JWT authentication settings (see `jwt-authorizer.ts`). */
  readonly jwt: JwtAuthorizerConfig;
}

export function validateProjectName(projectName: unknown): string {
  // AgentCore cannot rename a deployed Gateway, so a malformed value (for example several -c flags that a shell
  // passed as one argument) must stop synthesis rather than attempt a rename.
  if (
    typeof projectName !== 'string' ||
    projectName.length > PROJECT_NAME_MAX_LENGTH ||
    !PROJECT_NAME_PATTERN.test(projectName)
  ) {
    throw new Error(
      `projectName must be 1-${PROJECT_NAME_MAX_LENGTH} lowercase letters, digits or single hyphens, ` +
        `starting with a letter; got '${projectName}'`,
    );
  }
  return projectName;
}

export function loadConfig(app: App): AppConfig {
  return {
    projectName: validateProjectName(app.node.tryGetContext('projectName')),
    jwt: loadJwtAuthorizerConfig(app),
  };
}
