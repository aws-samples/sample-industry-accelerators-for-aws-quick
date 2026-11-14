// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { Context } from 'aws-lambda';
import { handler, HANDLERS } from '../../lambda/unit-converter';
import { TARGET_NAME, TOOLS } from '../../lib/tools';

/** A Lambda context like the one the Gateway sends: the prefixed tool name in the client context. */
const gatewayContext = (tool: string) =>
  ({ clientContext: { custom: { bedrockAgentCoreToolName: `${TARGET_NAME}___${tool}` } } }) as unknown as Context;

const call = (tool: string, args: Record<string, unknown> = {}) => handler(args, gatewayContext(tool));

describe('unit-converter handler', () => {
  test('implements exactly the tools declared in lib/tools', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  test('list_units groups units by quantity', async () => {
    const result = await call('list_units');
    expect(result.success).toBe(true);
    expect(result).toMatchObject({ data: { quantities: { length: expect.arrayContaining([{ symbol: 'km', name: 'kilometre' }]) } } });
  });

  test.each([
    [5, 'mi', 'km', 8.04672],
    [100, 'C', 'F', 212],
    [32, 'F', 'K', 273.15],
    [1, 'lb', 'g', 453.59237],
  ])('converts %d %s to %s', async (value, from_unit, to_unit, expected) => {
    const result = await call('convert_units', { value, from_unit, to_unit });
    expect(result).toEqual({ success: true, data: { value, from_unit, to_unit, result: expected } });
  });

  test.each([
    [{ value: '5', from_unit: 'mi', to_unit: 'km' }, 'INVALID_INPUT'],
    [{ value: 5, from_unit: 'mi', to_unit: 'parsec' }, 'UNKNOWN_UNIT'],
    [{ value: 5, from_unit: 'toString', to_unit: 'km' }, 'UNKNOWN_UNIT'],
    [{ value: 5, from_unit: 'kg', to_unit: 'km' }, 'INCOMPATIBLE_UNITS'],
  ])('rejects %j with %s', async (args, code) => {
    expect(await call('convert_units', args)).toMatchObject({ success: false, error_code: code });
  });

  test('rejects unknown tools', async () => {
    expect(await call('constructor')).toMatchObject({ success: false, error_code: 'UNKNOWN_TOOL' });
  });

  test('accepts tool_name in the event for direct invocation', async () => {
    expect(await handler({ tool_name: 'list_units' })).toMatchObject({ success: true });
  });

  test('rejects a non-object event', async () => {
    expect(await handler([1, 2])).toMatchObject({ success: false, error_code: 'INVALID_INPUT' });
  });
});
