// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { readFileSync } from 'fs';
import * as path from 'path';
import { ToolDefinition } from './types';

/** Gateway target name; the Gateway exposes each tool as `bio-viewers___<tool>`. */
export const TARGET_NAME = 'bio-viewers';

/**
 * Snapshot of the bio-viewers server's `tools/list` catalog, written by `npm run tools:snapshot` (see
 * `containers/bio-viewers/scripts/`). The Gateway discovers tools from the running server; this copy feeds the
 * tests. A Python test fails when it drifts from the server, so regenerate it whenever a tool's name, schema or
 * annotations change.
 */
export const BIO_VIEWERS_TOOLS: ToolDefinition[] = JSON.parse(
  readFileSync(path.join(__dirname, 'bio-viewers-tools.json'), 'utf8'),
);
