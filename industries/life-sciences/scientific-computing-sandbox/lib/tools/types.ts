// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * MCP tool as advertised in a server's `tools/list` response. The sandbox
 * target's inline Gateway tool schema and the tests are built from these.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments object. */
  readonly inputSchema: Record<string, unknown>;
  /** MCP behavioral hints (`readOnlyHint`, `destructiveHint`, ...). */
  readonly annotations?: Record<string, unknown>;
}

/** Name the gateway exposes a tool under: `<targetName>___<toolName>`. */
export function toGatewayToolName(targetName: string, tool: ToolDefinition): string {
  return `${targetName}___${tool.name}`;
}
