// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * MCP tool as advertised in a server's `tools/list` response. Gateway MCP server targets discover tools from the
 * server itself; these definitions describe the tool surface for tests.
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

/** Name the Gateway exposes a tool under: `<targetName>___<toolName>`. */
export function gatewayToolName(targetName: string, toolName: string): string {
  return `${targetName}___${toolName}`;
}
