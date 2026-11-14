// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The sandbox environment catalog, generated from
 * `containers/sandbox/environments/<id>/pyproject.toml` and the layers' locks
 * by `npm run environments:catalog` (a pytest fails when it is stale).
 *
 * This module has no Node.js or CDK dependencies: the sandbox tools Lambda
 * bundles it to answer `list_environments` without starting a sandbox.
 */
import catalogJson = require('./catalog.json');

export interface CatalogPackage {
  /** Normalized distribution name. */
  readonly name: string;
  readonly version: string;
  /** Import name; absent for packages used only as a command. */
  readonly import?: string;
  readonly summary: string;
  /** The layer that installs it. */
  readonly layer: string;
}

export interface CatalogProgram {
  readonly name: string;
  readonly summary: string;
  /** Command the container smoke test runs to check the program. */
  readonly check: readonly string[];
  readonly layer: string;
}

/** One layer: a deployable environment, or a shared build layer (`deploy: false`). */
export interface CatalogEnvironment {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly parent: string | null;
  readonly deploy: boolean;
  /** Ancestor layers and the layer itself, root first. */
  readonly lineage: readonly string[];
  readonly use_for: readonly string[];
  readonly notes: readonly string[];
  /** Direct packages of the layer and its ancestors. */
  readonly packages: readonly CatalogPackage[];
  readonly programs: readonly CatalogProgram[];
  /** Notable libraries installed as dependencies of the packages above. */
  readonly also_installed: readonly { name: string; version: string; import: string }[];
  /** Every installed distribution and its version. */
  readonly installed: Readonly<Record<string, string>>;
}

export interface Catalog {
  readonly python_version: string;
  readonly platform: string;
  readonly environments: readonly CatalogEnvironment[];
}

// The generated JSON is checked by the Python tests; its inferred type is too detailed to compare structurally.
export const CATALOG: Catalog = catalogJson as unknown as Catalog;

/** How the model should use the environments, returned with every `list_environments` result. */
export const ENVIRONMENT_USAGE =
  'Pass an environment id as the `environment` argument of the other sandbox tools. Choose the environment whose ' +
  'packages the task needs. Each environment is a separate sandbox with its own /workspace: files written in one ' +
  'environment are not visible in another, so move data between them with read_file and write_file. Packages ' +
  'cannot be installed. Call list_environments with an environment id to see every installed package and version.';

/**
 * The `list_environments` result: the environments with the given IDs (in
 * catalog order), or one environment in detail, including every installed
 * distribution. Returns undefined for an ID that is not among `ids`.
 */
export function describeEnvironments(ids: readonly string[], detail?: string): Record<string, unknown> | undefined {
  const available = CATALOG.environments.filter((env) => env.deploy && ids.includes(env.id));
  const summary = (env: CatalogEnvironment) => ({
    id: env.id,
    title: env.title,
    description: env.description,
    use_for: env.use_for,
    packages: env.packages.map(({ name, version, import: importName, summary: text }) => ({
      name,
      version,
      ...(importName ? { import: importName } : {}),
      summary: text,
    })),
    ...(env.programs.length ? { programs: env.programs.map(({ name, summary: text }) => ({ name, summary: text })) } : {}),
    also_installed: env.also_installed,
    ...(env.notes.length ? { notes: env.notes } : {}),
    installed_package_count: Object.keys(env.installed).length,
  });
  const common = { python_version: CATALOG.python_version, platform: CATALOG.platform, usage: ENVIRONMENT_USAGE };
  if (detail === undefined) {
    return { environments: available.map(summary), ...common };
  }
  const env = available.find((e) => e.id === detail);
  if (!env) return undefined;
  return { environment: { ...summary(env), installed: env.installed }, ...common };
}
