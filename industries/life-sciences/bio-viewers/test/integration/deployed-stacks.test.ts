// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Integration tests against the deployed stacks.
 *
 * Needs AWS credentials for the account and Region of the deployment. Set PROJECT_NAME if you deployed with a
 * projectName other than the cdk.json default. The Runtime's resource policy admits only the Gateway role, so the
 * Runtime test checks that your (non-Gateway) credentials are denied. The Gateway MCP tests also need ACCESS_TOKEN:
 * an unexpired access token from your identity provider for a client or audience the Gateway allows. They are
 * skipped without it.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { BIO_VIEWERS_TOOLS, gatewayToolName, TARGET_NAME } from '../../lib/tools';

const PROJECT_NAME =
  process.env.PROJECT_NAME ??
  JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8')).context.projectName;
// The protocol version AWS Quick negotiates with the Gateway.
const MCP_PROTOCOL_VERSION = '2025-03-26';
const WIDGET_URIS: Record<string, string> = {
  show_structure: 'ui://bio-viewers/structure.html',
  show_alignment: 'ui://bio-viewers/alignment.html',
  show_dicom: 'ui://bio-viewers/dicom.html',
};

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

/** Parses a JSON-RPC response that may arrive as JSON or as an SSE stream. */
function parseRpcBody(text: string, contentType?: string) {
  const json = contentType?.includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:') && line.length > 6).pop()!.slice(5)
    : text;
  return JSON.parse(json);
}

describe('bio-viewers AgentCore Runtime', () => {
  test('denies direct invocation by principals other than the Gateway role', async () => {
    const { RuntimeArn: runtimeArn } = await stackOutputs(`${PROJECT_NAME}-Runtime`);
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0.0' },
      },
    };
    await expect(
      new BedrockAgentCoreClient({}).send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          qualifier: 'DEFAULT',
          contentType: 'application/json',
          accept: 'application/json, text/event-stream',
          payload: Buffer.from(JSON.stringify(body)),
        }),
      ),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });
});

describe('AgentCore Gateway inbound authentication', () => {
  test('rejects a request without a token', async () => {
    const { GatewayUrl: gatewayUrl } = await stackOutputs(`${PROJECT_NAME}-Gateway`);
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
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

  async function rpc(method: string, params?: unknown) {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    const message = parseRpcBody(text, res.headers.get('content-type') ?? undefined);
    expect(message.error).toBeUndefined();
    return message.result;
  }

  const toolName = (name: string) => gatewayToolName(TARGET_NAME, name);

  test('tools/list exposes every tool with its MCP Apps widget', async () => {
    const { tools } = await rpc('tools/list');
    for (const expected of BIO_VIEWERS_TOOLS) {
      const tool = tools.find((t: { name: string }) => t.name === toolName(expected.name));
      expect(tool).toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      // MCP Apps hosts open the widget from this metadata.
      expect(tool._meta?.ui?.resourceUri).toBe(WIDGET_URIS[expected.name]);
    }
  });

  test.each(Object.values(WIDGET_URIS))('resources/read serves the %s widget', async (uri) => {
    const { contents } = await rpc('resources/read', { uri });
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0].text).toContain('<html');
  });

  test('show_structure returns a PDB entry for the widget', async () => {
    const result = await rpc('tools/call', { name: toolName('show_structure'), arguments: { structure: '1CRN' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('CRAMBIN');
    expect(result.structuredContent).toMatchObject({ kind: 'pdb', id: '1CRN' });
  });

  test('show_alignment summarizes FASTA text for the widget', async () => {
    const result = await rpc('tools/call', {
      name: toolName('show_alignment'),
      arguments: { alignment: '>a\nMKV-LA\n>b\nMKVQLA\n' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ aligned: true, ids: ['a', 'b'] });
  });

  test('show_dicom returns the bundled CT sample for the widget', async () => {
    const result = await rpc('tools/call', { name: toolName('show_dicom'), arguments: { sample: 'ct' } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('Modality: CT');
    expect(result.structuredContent.files).toHaveLength(1);
  });
});
