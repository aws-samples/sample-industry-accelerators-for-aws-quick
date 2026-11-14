// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CATALOG } from '../sandbox/catalog';
import serverToolsJson = require('./server-tools.json');
import { ToolDefinition } from './types';

/**
 * Name of the single Gateway target that serves every environment; it
 * prefixes the tool names (`sandbox___execute_code`). Renaming it replaces
 * the target and changes every tool name.
 */
export const SANDBOX_TARGET_NAME = 'sandbox';

/** Tool argument that selects the environment. The tools Lambda removes it before forwarding a call. */
export const ENVIRONMENT_ARGUMENT = 'environment';

/**
 * The sandbox server's tools, from `lib/tools/server-tools.json` (written by
 * `npm run tools:snapshot`). They are the same in every environment.
 */
export const SERVER_TOOLS: readonly ToolDefinition[] = serverToolsJson as ToolDefinition[];

/**
 * Handled by the tools Lambda from the bundled catalog, without starting a
 * sandbox.
 */
export const LIST_ENVIRONMENTS_TOOL: ToolDefinition = {
  name: 'list_environments',
  title: 'List sandbox environments',
  description:
    'List the code sandbox environments and the scientific packages installed in each (name, version, import ' +
    'name and purpose), the command-line programs, what each environment is for, and its limitations. Call it ' +
    'first to choose the environment for a task, then pass that environment\'s id to the other sandbox tools. With ' +
    'environment set, it returns that environment with every installed package and version. It starts no sandbox.',
  inputSchema: {
    type: 'object',
    properties: {
      [ENVIRONMENT_ARGUMENT]: {
        type: 'string',
        description: 'Optional environment id; omit it to list all environments.',
      },
    },
    required: [],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/**
 * Handled by the tools Lambda itself (`lambda/sandbox-tools`), not the
 * sandbox server: stops the caller's Runtime session for one environment.
 */
export const RESET_SANDBOX_TOOL: ToolDefinition = {
  name: 'reset_sandbox',
  title: 'Reset sandbox',
  description:
    'Stop the current user\'s sandbox for one environment, discarding all files under its /workspace and any ' +
    'running jobs. The next tool call in that environment starts a new, empty sandbox; other environments are not ' +
    'affected. Use it only when the user asks for a clean sandbox or the sandbox is unusable (for example, the disk ' +
    'is full).',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

/** Description of the `environment` argument: every deployed environment with its own key packages. */
export function environmentArgumentDescription(environmentIds: readonly string[]): string {
  const envs = CATALOG.environments.filter((env) => env.deploy && environmentIds.includes(env.id));
  const root = CATALOG.environments.find((env) => env.parent === null)!;
  const lines = envs.map((env) => {
    const own = env.packages.filter((p) => p.layer !== root.id || env.id === root.id).map((p) => p.name);
    return `${env.id} (${env.title}: ${own.join(', ')})`;
  });
  const rootPackages = root.packages.map((p) => p.name).join(', ');
  return (
    `Sandbox environment to use (required). One of: ${lines.join('; ')}. Every environment also has ` +
    `${rootPackages}. Each environment is a separate sandbox with its own files. Call list_environments for ` +
    'exact versions and the other installed libraries.'
  );
}

/** Adds the required `environment` argument to a tool's input schema. */
function withEnvironment(tool: ToolDefinition, description: string): ToolDefinition {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  if (schema.properties && ENVIRONMENT_ARGUMENT in schema.properties) {
    throw new Error(`Sandbox tool ${tool.name} must not define its own '${ENVIRONMENT_ARGUMENT}' argument`);
  }
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { [ENVIRONMENT_ARGUMENT]: { type: 'string', description }, ...(schema.properties ?? {}) },
      required: [ENVIRONMENT_ARGUMENT, ...(schema.required ?? [])],
    },
  };
}

/**
 * Tools the sandbox Gateway target exposes: `list_environments`, the
 * server's tools, and `reset_sandbox`, each of the last two with a required
 * `environment` argument naming one of `environmentIds`.
 */
export function gatewayTools(serverTools: readonly ToolDefinition[], environmentIds: readonly string[]): ToolDefinition[] {
  const description = environmentArgumentDescription(environmentIds);
  return [
    LIST_ENVIRONMENTS_TOOL,
    ...[...serverTools, RESET_SANDBOX_TOOL].map((tool) => withEnvironment(tool, description)),
  ];
}

/** JSON Schema subset accepted by an AgentCore Gateway Lambda target's inline tool schema. */
export interface GatewaySchema {
  type: string;
  description?: string;
  properties?: Record<string, GatewaySchema>;
  required?: string[];
  items?: GatewaySchema;
}

/**
 * Converts a server tool's JSON Schema (as pydantic emits it) to the subset a
 * Lambda target accepts: `type`, `description`, `properties`, `required`, and
 * `items`. Optional values (`anyOf` with `null`) become their non-null type.
 * Bounds, enums, and defaults cannot be expressed, so the descriptions state
 * them and the sandbox server enforces them.
 */
export function toGatewaySchema(schema: Record<string, unknown>): GatewaySchema {
  let node: Record<string, unknown> = schema;
  if (Array.isArray(node.anyOf)) {
    const nonNull = (node.anyOf as Record<string, unknown>[]).filter((s) => s.type !== 'null');
    if (nonNull.length !== 1) {
      throw new Error(`Cannot express anyOf with ${nonNull.length} non-null alternatives in a Gateway tool schema`);
    }
    node = { ...nonNull[0], description: node.description ?? nonNull[0].description };
  }
  if (typeof node.type !== 'string') {
    throw new Error(`Gateway tool schemas need a single string type, got ${JSON.stringify(node.type)}`);
  }
  const out: GatewaySchema = { type: node.type };
  if (typeof node.description === 'string') out.description = node.description;
  if (node.properties && typeof node.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, toGatewaySchema(v)]),
    );
    out.required = Array.isArray(node.required) ? (node.required as string[]) : [];
  }
  if (node.items && typeof node.items === 'object') out.items = toGatewaySchema(node.items as Record<string, unknown>);
  return out;
}
