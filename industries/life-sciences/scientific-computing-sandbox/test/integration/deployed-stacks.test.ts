// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/*
 * Integration tests against the deployed <projectName>-Runtime and <projectName>-Gateway stacks.
 *
 * Needs AWS credentials for the account and Region of the deployment, with permission to invoke the sandbox tools
 * Lambda. Set PROJECT_NAME if you deployed with a projectName other than the cdk.json default. The tools Lambda tests
 * call the Lambda directly with test identities in its client context (as the Gateway does after the interceptor),
 * which checks per-user sandbox persistence without an access token. They use throwaway `integration-test-*`
 * subjects, start one sandbox per deployed environment for one of them, and reset their sandboxes afterwards.
 *
 * The Gateway (MCP) tests also need ACCESS_TOKEN: an unexpired access token from your identity provider for a client
 * the Gateway allows. They are skipped without it. Each Gateway call starts a new MCP session, as AWS Quick does.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CALLER_SUB_HEADER } from '../../lib/identity';
import { CATALOG, SANDBOX_ENVIRONMENTS } from '../../lib/sandbox';
import { gatewayTools, SANDBOX_TARGET_NAME, SERVER_TOOLS } from '../../lib/tools';

const PROJECT_NAME =
  process.env.PROJECT_NAME ??
  JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8')).context.projectName;
const RUNTIME_STACK = `${PROJECT_NAME}-Runtime`;
const GATEWAY_STACK = `${PROJECT_NAME}-Gateway`;
const TOOLS_FUNCTION = process.env.TOOLS_FUNCTION_NAME ?? `${PROJECT_NAME}-sandbox-tools`;
const ENVIRONMENT = process.env.SANDBOX_ENVIRONMENT ?? 'chem';
const ENVIRONMENT_IDS = SANDBOX_ENVIRONMENTS.map((e) => e.id);
// The protocol version AWS Quick negotiates with the gateway.
const MCP_PROTOCOL_VERSION = '2025-03-26';
// Cold starts of a new sandbox microVM can take tens of seconds.
const SLOW = 240_000;

async function stackOutputs(stackName: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({});
  let res;
  try {
    res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (err) {
    throw new Error(`Could not read stack ${stackName}. Check AWS credentials, Region and PROJECT_NAME. (${(err as Error).message})`);
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

describe('Code sandbox AgentCore Runtimes', () => {
  test('deny direct invocation by principals other than the sandbox tools Lambda', async () => {
    const outputs = await stackOutputs(RUNTIME_STACK);
    const client = new BedrockAgentCoreClient({});
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    for (const env of SANDBOX_ENVIRONMENTS) {
      const key = env.id.charAt(0).toUpperCase() + env.id.slice(1);
      await expect(
        client.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: outputs[`${key}RuntimeArn`],
            qualifier: 'DEFAULT',
            runtimeSessionId: 'integration-test-direct-invoke-000000000000',
            contentType: 'application/json',
            accept: 'application/json, text/event-stream',
            payload: Buffer.from(JSON.stringify(body)),
          }),
        ),
      ).rejects.toMatchObject({ name: 'AccessDeniedException' });
    }
  }, 60_000);
});

describe('Sandbox tools Lambda (as the Gateway calls it after the interceptor)', () => {
  const lambda = new LambdaClient({});
  const run = `${Date.now()}`;
  const userA = `integration-test-a-${run}`;
  const userB = `integration-test-b-${run}`;

  async function callTool(
    sub: string | undefined,
    tool: string,
    args: Record<string, unknown> = {},
    // null sends no environment argument (passing undefined would select the default).
    environment: string | null = ENVIRONMENT,
  ) {
    const custom: Record<string, unknown> = { bedrockAgentCoreToolName: `${SANDBOX_TARGET_NAME}___${tool}` };
    if (sub) custom.bedrockAgentCorePropagatedHeaders = { [CALLER_SUB_HEADER]: sub };
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: TOOLS_FUNCTION,
        Payload: Buffer.from(JSON.stringify(environment ? { environment, ...args } : args)),
        ClientContext: Buffer.from(JSON.stringify({ custom })).toString('base64'),
      }),
    );
    expect(res.FunctionError).toBeUndefined();
    return JSON.parse(Buffer.from(res.Payload!).toString());
  }

  afterAll(async () => {
    await Promise.all([
      ...ENVIRONMENT_IDS.map((env) => callTool(userA, 'reset_sandbox', {}, env)),
      callTool(userB, 'reset_sandbox'),
    ]);
  }, SLOW);

  test('lists every deployed environment without starting a sandbox', async () => {
    const out = await callTool(userA, 'list_environments', {}, null);
    expect(out.environments.map((e: { id: string }) => e.id)).toEqual(ENVIRONMENT_IDS);
    const detail = await callTool(userA, 'list_environments', {}, 'chem');
    expect(detail.environment.installed.rdkit).toEqual(expect.any(String));
    expect(await callTool(userA, 'execute_code', { code: 'print(1)' }, 'nope')).toMatchObject({ error_code: 'INVALID_INPUT' });
  }, 60_000);

  test('fails closed without a caller identity', async () => {
    expect(await callTool(undefined, 'get_sandbox_info')).toMatchObject({ status: 'error', error_code: 'UNAUTHENTICATED' });
  }, 60_000);

  test('keeps one sandbox per user across calls, and separate sandboxes for different users', async () => {
    const marker = `marker-${run}`;
    const written = await callTool(userA, 'execute_code', { code: `open('marker.txt', 'w').write('${marker}')` });
    expect(written).toMatchObject({ status: 'succeeded', exit_code: 0 });
    const infoA = await callTool(userA, 'get_sandbox_info');
    expect(infoA.environment).toBe(ENVIRONMENT);
    expect(await callTool(userA, 'read_file', { path: 'marker.txt' })).toMatchObject({ content: marker });
    expect((await callTool(userA, 'get_sandbox_info')).sandbox_instance).toBe(infoA.sandbox_instance);

    const infoB = await callTool(userB, 'get_sandbox_info');
    expect(infoB.sandbox_instance).not.toBe(infoA.sandbox_instance);
    expect(await callTool(userB, 'read_file', { path: 'marker.txt' })).toMatchObject({ error_code: 'FILE_NOT_FOUND' });
  }, SLOW);

  test('has no internet access: public names do not resolve and public addresses are unreachable', async () => {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const code = [
      'import json, socket',
      'out = {}',
      "for key, host in [('public_dns', 'example.com'), ('aws_dns', 'logs.%s.amazonaws.com')]:",
      '    try:',
      '        out[key] = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)[0][4][0]',
      '    except socket.gaierror:',
      '        out[key] = None',
      "for key, address in [('tcp_1_1_1_1', '1.1.1.1'), ('tcp_8_8_8_8', '8.8.8.8')]:",
      '    try:',
      '        socket.create_connection((address, 443), timeout=5).close()',
      "        out[key] = 'connected'",
      '    except OSError:',
      "        out[key] = 'failed'",
      'print(json.dumps(out))',
    ]
      .join('\n')
      .replace('%s', region);
    const out = await callTool(userB, 'execute_code', { code, timeout_seconds: 60 });
    expect(out).toMatchObject({ status: 'succeeded' });
    const result = JSON.parse(out.stdout);
    // DNS Firewall answers NXDOMAIN for public names; the VPC resolver gives the Logs endpoint's private address.
    expect(result).toEqual({
      public_dns: null,
      aws_dns: expect.stringMatching(/^10\.0\./),
      tcp_1_1_1_1: 'failed',
      tcp_8_8_8_8: 'failed',
    });
  }, SLOW);

  test('runs RDKit in chem', async () => {
    const out = await callTool(
      userA,
      'execute_code',
      { code: "from rdkit import Chem\nfrom rdkit.Chem import Descriptors\nprint(round(Descriptors.MolWt(Chem.MolFromSmiles('CCO')), 2))" },
      'chem',
    );
    expect(out).toMatchObject({ status: 'succeeded', stdout: '46.07\n' });
  }, SLOW);

  test('reset_sandbox gives the user a new, empty sandbox', async () => {
    const before = await callTool(userA, 'get_sandbox_info');
    expect(await callTool(userA, 'reset_sandbox')).toMatchObject({ status: 'reset' });
    const after = await callTool(userA, 'get_sandbox_info');
    expect(after.sandbox_instance).not.toBe(before.sandbox_instance);
    expect(await callTool(userA, 'read_file', { path: 'marker.txt' })).toMatchObject({ error_code: 'FILE_NOT_FOUND' });
  }, SLOW);

  test('keeps each environment a separate sandbox', async () => {
    const other = ENVIRONMENT_IDS.find((id) => id !== ENVIRONMENT)!;
    await callTool(userB, 'write_file', { path: 'only-here.txt', content: 'x' });
    expect(await callTool(userB, 'read_file', { path: 'only-here.txt' }, other)).toMatchObject({ error_code: 'FILE_NOT_FOUND' });
    expect((await callTool(userB, 'get_sandbox_info', {}, other)).environment).toBe(other);
    await callTool(userB, 'reset_sandbox', {}, other);
  }, SLOW);

  test.each(ENVIRONMENT_IDS)('%s imports every catalog package at its catalog version', async (id) => {
    const env = CATALOG.environments.find((e) => e.id === id)!;
    const packages = env.packages.map((p) => [p.name, p.version, p.import ?? '']);
    const code = [
      'import importlib, importlib.metadata as md',
      `for name, version, module in ${JSON.stringify(packages)}:`,
      '    assert md.version(name) == version, (name, md.version(name), version)',
      '    if module: importlib.import_module(module)',
      "print('ok')",
    ].join('\n');
    const out = await callTool(userA, 'execute_code', { code, timeout_seconds: 300 }, id);
    expect(out).toMatchObject({ status: 'succeeded', stdout: 'ok\n' });
  }, SLOW);
});

describe('AgentCore Gateway inbound authentication', () => {
  test('rejects a request without an access token', async () => {
    const { GatewayUrl: gatewayUrl } = await stackOutputs(GATEWAY_STACK);
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
    gatewayUrl = (await stackOutputs(GATEWAY_STACK)).GatewayUrl;
  });

  async function rpc(method: string, params?: unknown, extraHeaders: Record<string, string> = {}) {
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    const message = parseRpcBody(text, res.headers.get('content-type') ?? undefined);
    expect(message.error).toBeUndefined();
    return message.result;
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
    const result = await rpc(
      'tools/call',
      {
        name: `${SANDBOX_TARGET_NAME}___${name}`,
        arguments: name === 'list_environments' ? args : { environment: ENVIRONMENT, ...args },
      },
      extraHeaders,
    );
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  }

  test('tools/list exposes list_environments, the sandbox tools and reset_sandbox', async () => {
    const { tools } = await rpc('tools/list');
    for (const expected of gatewayTools(SERVER_TOOLS, ENVIRONMENT_IDS)) {
      expect(tools.find((t: { name: string }) => t.name === `${SANDBOX_TARGET_NAME}___${expected.name}`)).toBeDefined();
    }
    expect((await callTool('list_environments')).environments.length).toBe(ENVIRONMENT_IDS.length);
  });

  test('keeps the caller\'s sandbox across calls with no MCP session', async () => {
    const marker = `marker-${Date.now()}`;
    await callTool('execute_code', { code: `open('gateway-marker.txt', 'w').write('${marker}')` });
    const first = await callTool('get_sandbox_info');
    expect(await callTool('read_file', { path: 'gateway-marker.txt' })).toMatchObject({ content: marker });
    expect((await callTool('get_sandbox_info')).sandbox_instance).toBe(first.sandbox_instance);
  }, SLOW);

  test('ignores a caller header the client sends and uses the token\'s own sub', async () => {
    // get_sandbox_info reports sha256(Runtime session ID)[:12]; the session ID is the tools Lambda's
    // runtimeSessionId(sub, environment), which the Lambda module computes but cannot be imported without its env.
    const digest = (sub: string) => {
      const sessionId = createHash('sha256').update(`code-sandbox:v1:${ENVIRONMENT}:${sub}`).digest('hex');
      return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
    };
    const tokenSub = JSON.parse(Buffer.from(ACCESS_TOKEN!.split('.')[1], 'base64url').toString()).sub;
    const spoofed = `integration-test-spoofed-${Date.now()}`;
    const info = await callTool('get_sandbox_info', {}, { [CALLER_SUB_HEADER]: spoofed });
    expect(info.runtime_session).toBe(digest(tokenSub));
    expect(info.runtime_session).not.toBe(digest(spoofed));
  }, SLOW);
});
