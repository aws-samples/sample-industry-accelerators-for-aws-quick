// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ToolDefinition } from './types';

/** Gateway target name; MCP tool names are prefixed with it (`unit-converter___convert_units`). */
export const TARGET_NAME = 'unit-converter';

// The tools that lambda/unit-converter/index.ts implements. test/unit/handler.test.ts checks that the two match.
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'list_units',
    description: 'List the units that convert_units supports, grouped by quantity (length, mass, temperature).',
    properties: {},
    required: [],
  },
  {
    name: 'convert_units',
    description:
      'Convert a value from one unit to another unit of the same quantity, for example 5 mi to km or 37 C to F. ' +
      'Call list_units for the supported unit symbols.',
    properties: {
      value: { type: 'number', description: 'The value to convert.' },
      from_unit: { type: 'string', description: 'Symbol of the unit to convert from, for example mi.' },
      to_unit: { type: 'string', description: 'Symbol of the unit to convert to, for example km.' },
    },
    required: ['value', 'from_unit', 'to_unit'],
  },
];
