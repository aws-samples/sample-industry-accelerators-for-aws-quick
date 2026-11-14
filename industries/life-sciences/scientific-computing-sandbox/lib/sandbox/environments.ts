// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { CATALOG, CatalogEnvironment } from './catalog';

/**
 * A deployable sandbox environment: one container image
 * (`containers/sandbox/Dockerfile` built with `ENVIRONMENT=<id>`) and one
 * AgentCore Runtime. All environments share one Gateway target; the tools
 * take the environment ID as an argument, and the tools Lambda gives each
 * user one Runtime session (microVM) per environment, started only when they
 * first use it.
 */
export interface SandboxEnvironment {
  /** 1-11 lowercase letters and digits; part of the Runtime name and the `environment` tool argument. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Layer IDs whose `environments/<id>/` directories the image build needs, root first. */
  readonly lineage: readonly string[];
}

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'containers', 'sandbox');

/** Directory holding the image build context shared by every environment. */
export const SANDBOX_BUILD_CONTEXT = SANDBOX_DIR;

/** Every layer under `containers/sandbox/environments/`, including shared layers that are not deployed. */
export const SANDBOX_LAYER_IDS: readonly string[] = CATALOG.environments.map((env) => env.id);

/**
 * Runtime names are `<projectName>_<id>`, at most 48 characters, and
 * projectName is at most 36, so an ID has at most 11 characters.
 */
export const ENVIRONMENT_ID_PATTERN = /^[a-z][a-z0-9]{0,10}$/;

function toEnvironment(env: CatalogEnvironment): SandboxEnvironment {
  return { id: env.id, title: env.title, description: env.description, lineage: env.lineage };
}

/**
 * The deployed environments, from the generated catalog. To add one, follow
 * "Adding an environment" in the README.
 */
export const SANDBOX_ENVIRONMENTS: readonly SandboxEnvironment[] = CATALOG.environments
  .filter((env) => env.deploy)
  .map(toEnvironment);

for (const env of CATALOG.environments) {
  if (!ENVIRONMENT_ID_PATTERN.test(env.id)) {
    throw new Error(`Sandbox environment id '${env.id}' must be 1-11 lowercase letters and digits, starting with a letter`);
  }
}
