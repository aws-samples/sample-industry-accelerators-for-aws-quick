// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * One argument of a tool. Gateway inline tool schemas support only `type`, `description`, `properties`,
 * `required` and `items`, so list allowed values in the description instead of an `enum`.
 */
export interface ToolProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description: string;
  readonly items?: { readonly type: string };
}

/** An MCP tool implemented by a Gateway Lambda target. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, ToolProperty>;
  readonly required: readonly string[];
}

/** The tool in the shape of a Gateway inline tool schema entry. */
export function toGatewayToolSchema(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: [...tool.required],
    },
  };
}

/** The name the Gateway exposes a tool under: `<targetName>___<toolName>`. */
export function gatewayToolName(targetName: string, toolName: string): string {
  return `${targetName}___${toolName}`;
}
