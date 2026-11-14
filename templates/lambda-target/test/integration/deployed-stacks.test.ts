// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Integration tests against the deployed stacks.
 *
 * Needs AWS credentials for the account and Region of the deployment. Set PROJECT_NAME if you deployed with a
 * projectName other than the cdk.json default. The Gateway tests also need ACCESS_TOKEN: an unexpired access token
 * from your identity provider for the client the Gateway allows. They are skipped without it.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { gatewayToolName, TARGET_NAME, TOOLS } from '../../lib/tools';

const PROJECT_NAME =
  process.env.PROJECT_NAME ??
  JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8')).context.projectName;

async function stackOutputs(stackName: string): Promise<Record<string, string>> {
  let res;
  try {
    res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (err) {
    throw new Error(`Could not read stack ${stackName}. Check AWS credentials, Region and PROJECT_NAME. (${err})`);
  }
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey!, o.OutputValue!]));
}

describe('tools Lambda', () => {
  const lambda = new LambdaClient({});
  let functionName: string;

  beforeAll(async () => {
    functionName = (await stackOutputs(`${PROJECT_NAME}-Tools`)).ToolsFunctionName;
  });

  async function invoke(event: Record<string, unknown>) {
    const res = await lambda.send(
      new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(event)) }),
    );
    expect(res.FunctionError).toBeUndefined();
    return JSON.parse(Buffer.from(res.Payload!).toString());
  }

  test('convert_units converts miles to kilometres', async () => {
    const result = await invoke({ tool_name: 'convert_units', value: 5, from_unit: 'mi', to_unit: 'km' });
    expect(result).toMatchObject({ success: true, data: { result: 8.04672 } });
  });

  test('rejects unknown tools', async () => {
    expect(await invoke({ tool_name: 'nope' })).toMatchObject({ success: false, error_code: 'UNKNOWN_TOOL' });
  });
});

const { ACCESS_TOKEN } = process.env;
const describeGateway = ACCESS_TOKEN ? describe : describe.skip;

describeGateway('AgentCore Gateway (MCP, as AWS Quick calls it)', () => {
  let gatewayUrl: string;
  let rpcId = 0;

  beforeAll(async () => {
    gatewayUrl = (await stackOutputs(`${PROJECT_NAME}-Gateway`)).GatewayUrl;
  });

  async function rpc(method: string, params?: unknown, token = ACCESS_TOKEN) {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const text = await res.text();
    // Streamable HTTP may answer with an SSE stream; the last data line holds the response.
    const json = res.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter((line) => line.startsWith('data:')).pop()!.slice(5)
      : text;
    return { status: res.status, message: res.ok ? JSON.parse(json) : undefined };
  }

  test('tools/list lists every tool', async () => {
    const { status, message } = await rpc('tools/list');
    expect(status).toBe(200);
    const names = message.result.tools.map((tool: { name: string }) => tool.name);
    for (const tool of TOOLS) {
      expect(names).toContain(gatewayToolName(TARGET_NAME, tool.name));
    }
  });

  test('tools/call reaches the Lambda target', async () => {
    const { message } = await rpc('tools/call', {
      name: gatewayToolName(TARGET_NAME, 'convert_units'),
      arguments: { value: 100, from_unit: 'C', to_unit: 'F' },
    });
    expect(message.result.isError).toBeFalsy();
    expect(JSON.stringify(message.result.content)).toContain('212');
  });

  test('rejects a request with an invalid token', async () => {
    const { status } = await rpc('tools/list', undefined, 'not-a-token');
    expect(status).toBe(401);
  });
});
