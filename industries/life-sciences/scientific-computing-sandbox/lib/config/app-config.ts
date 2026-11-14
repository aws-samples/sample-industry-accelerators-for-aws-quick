// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { JwtAuthorizerConfig, listContext, loadJwtAuthorizerConfig } from './jwt-authorizer';

/** Default Runtime idle timeout before a sandbox microVM is stopped: 1 hour. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 3_600;
/** Default maximum lifetime of a sandbox microVM: 8 hours, the maximum. */
export const DEFAULT_MAX_LIFETIME_SECONDS = 28_800;
/**
 * Default reserved concurrency of the sandbox tools Lambda: at most this many tool calls run at once, so long
 * sandbox calls cannot use up the account's Lambda concurrency.
 */
export const DEFAULT_TOOLS_RESERVED_CONCURRENCY = 50;

/**
 * Lowercase letters, digits and single hyphens, starting with a letter. AgentCore Gateway names allow no
 * consecutive hyphens, and every resource name starts with the project name.
 */
export const PROJECT_NAME_PATTERN = /^[a-z](?:-?[a-z0-9])*$/;
/**
 * The longest derived name is the `<projectName>-caller-identity-interceptor` Lambda function, which must fit
 * Lambda's 64 characters. Runtime names (`<projectName>_<environment>`, at most 48) rely on this cap too: it leaves
 * 11 characters for environment IDs.
 */
export const PROJECT_NAME_MAX_LENGTH = 36;

/** Settings read from CDK context (`cdk.json` or `-c key=value`). */
export interface AppConfig {
  /** Prefix for stack IDs and resource names. */
  readonly projectName: string;
  /** Inbound JWT authentication settings (see `jwt-authorizer.ts`), used by the Gateway and the interceptor. */
  readonly jwt: JwtAuthorizerConfig;
  /** Runtime idle timeout in seconds (60-28800, at most `maxLifetimeSeconds`). */
  readonly idleTimeoutSeconds: number;
  /** Runtime microVM maximum lifetime in seconds (60-28800). */
  readonly maxLifetimeSeconds: number;
  /**
   * AgentCore-supported Availability Zone IDs for the sandbox VPC's subnets
   * (2-4, for example `use1-az1,use1-az2`). Defaults to two supported AZs of
   * the Region.
   */
  readonly availabilityZoneIds?: string[];
  /**
   * Reserved concurrency of the sandbox tools Lambda, which caps concurrent tool calls across all users. Undefined
   * (context value `none`) reserves nothing, for accounts whose Lambda concurrency quota cannot spare it.
   */
  readonly toolsReservedConcurrency?: number;
}

const AZ_ID_PATTERN = /^[a-z]+[0-9]+-az[0-9]+$/;

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

function intContext(app: App, key: string, fallback: number): number {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Context key ${key} must be an integer number of seconds, got '${raw}'`);
  }
  return value;
}

function concurrencyContext(app: App, key: string, fallback: number): number | undefined {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  if (raw === 'none') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Context key ${key} must be a positive integer or 'none', got '${raw}'`);
  }
  return value;
}

export function loadConfig(app: App): AppConfig {
  const projectName = validateProjectName(app.node.tryGetContext('projectName'));
  const availabilityZoneIds = listContext(app, 'availabilityZoneIds');
  const malformed = availabilityZoneIds.filter((id) => !AZ_ID_PATTERN.test(id));
  if (malformed.length > 0) {
    throw new Error(`availabilityZoneIds must be AZ IDs such as use1-az1, got '${malformed.join(', ')}'`);
  }
  return {
    projectName,
    jwt: loadJwtAuthorizerConfig(app),
    idleTimeoutSeconds: intContext(app, 'idleTimeoutSeconds', DEFAULT_IDLE_TIMEOUT_SECONDS),
    maxLifetimeSeconds: intContext(app, 'maxLifetimeSeconds', DEFAULT_MAX_LIFETIME_SECONDS),
    availabilityZoneIds: availabilityZoneIds.length > 0 ? availabilityZoneIds : undefined,
    toolsReservedConcurrency: concurrencyContext(app, 'toolsReservedConcurrency', DEFAULT_TOOLS_RESERVED_CONCURRENCY),
  };
}
