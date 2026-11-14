// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Example AgentCore Gateway Lambda target with two tools: list_units and convert_units.
 *
 * The Gateway invokes the function with the tool arguments as the event, and the tool name
 * (`<targetName>___<toolName>`) in the client context. Whatever the handler returns becomes the tool result.
 *
 * Replace this handler with your own tools, and keep lib/tools/ in sync with it.
 */

import type { Context } from 'aws-lambda';

interface Unit {
  readonly quantity: 'length' | 'mass' | 'temperature';
  readonly name: string;
  /** Converts a value in this unit to the quantity's base unit (metre, kilogram, kelvin). */
  readonly toBase: (value: number) => number;
  /** Converts a value in the base unit to this unit. */
  readonly fromBase: (value: number) => number;
}

const scale = (quantity: Unit['quantity'], name: string, factor: number): Unit => ({
  quantity,
  name,
  toBase: (v) => v * factor,
  fromBase: (v) => v / factor,
});

export const UNITS: Readonly<Record<string, Unit>> = {
  m: scale('length', 'metre', 1),
  km: scale('length', 'kilometre', 1000),
  cm: scale('length', 'centimetre', 0.01),
  mm: scale('length', 'millimetre', 0.001),
  mi: scale('length', 'mile', 1609.344),
  ft: scale('length', 'foot', 0.3048),
  in: scale('length', 'inch', 0.0254),
  kg: scale('mass', 'kilogram', 1),
  g: scale('mass', 'gram', 0.001),
  lb: scale('mass', 'pound', 0.45359237),
  oz: scale('mass', 'ounce', 0.028349523125),
  K: { quantity: 'temperature', name: 'kelvin', toBase: (v) => v, fromBase: (v) => v },
  C: { quantity: 'temperature', name: 'degree Celsius', toBase: (v) => v + 273.15, fromBase: (v) => v - 273.15 },
  F: {
    quantity: 'temperature',
    name: 'degree Fahrenheit',
    toBase: (v) => ((v - 32) * 5) / 9 + 273.15,
    fromBase: (v) => ((v - 273.15) * 9) / 5 + 32,
  },
};

export type ToolResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error_code: string; readonly message: string };

const failure = (error_code: string, message: string): ToolResult => ({ success: false, error_code, message });

function listUnits(): ToolResult {
  const quantities: Record<string, { symbol: string; name: string }[]> = {};
  for (const [symbol, unit] of Object.entries(UNITS)) {
    (quantities[unit.quantity] ??= []).push({ symbol, name: unit.name });
  }
  return { success: true, data: { quantities } };
}

function convertUnits(args: Record<string, unknown>): ToolResult {
  const { value, from_unit: fromSymbol, to_unit: toSymbol } = args;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return failure('INVALID_INPUT', 'value must be a finite number');
  }
  if (typeof fromSymbol !== 'string' || typeof toSymbol !== 'string') {
    return failure('INVALID_INPUT', 'from_unit and to_unit must be unit symbols such as km or F');
  }
  const from = Object.hasOwn(UNITS, fromSymbol) ? UNITS[fromSymbol] : undefined;
  const to = Object.hasOwn(UNITS, toSymbol) ? UNITS[toSymbol] : undefined;
  if (!from || !to) {
    const unknown = [fromSymbol, toSymbol].filter((s) => !Object.hasOwn(UNITS, s)).join(', ');
    return failure('UNKNOWN_UNIT', `Unknown unit: ${unknown}. Call list_units for the supported units.`);
  }
  if (from.quantity !== to.quantity) {
    return failure('INCOMPATIBLE_UNITS', `Cannot convert ${from.quantity} (${fromSymbol}) to ${to.quantity} (${toSymbol})`);
  }
  const result = to.fromBase(from.toBase(value));
  return { success: true, data: { value, from_unit: fromSymbol, to_unit: toSymbol, result: Number(result.toPrecision(12)) } };
}

export const HANDLERS: Readonly<Record<string, (args: Record<string, unknown>) => ToolResult>> = {
  list_units: listUnits,
  convert_units: convertUnits,
};

/** The tool name the Gateway sent, without the `<targetName>___` prefix. */
export function toolName(event: Record<string, unknown>, context?: Context): string | undefined {
  const clientContext = context?.clientContext as
    | { custom?: Record<string, unknown>; Custom?: Record<string, unknown> }
    | undefined;
  // `tool_name` in the event lets integration tests invoke the function directly.
  const fullName = (clientContext?.custom ?? clientContext?.Custom)?.bedrockAgentCoreToolName ?? event.tool_name;
  if (typeof fullName !== 'string') return undefined;
  const separator = fullName.indexOf('___');
  return separator >= 0 ? fullName.slice(separator + 3) : fullName;
}

export async function handler(event: unknown, context?: Context): Promise<ToolResult> {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return failure('INVALID_INPUT', 'Tool arguments must be a JSON object');
  }
  const args = event as Record<string, unknown>;
  const name = toolName(args, context);
  const run = name !== undefined && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!run) {
    return failure('UNKNOWN_TOOL', `Unknown tool: ${name}. Supported tools: ${Object.keys(HANDLERS).join(', ')}`);
  }
  const result = run(args);
  // One line per call for operations; arguments and results are not logged.
  console.log(JSON.stringify({ tool: name, outcome: result.success ? 'OK' : result.error_code }));
  return result;
}
