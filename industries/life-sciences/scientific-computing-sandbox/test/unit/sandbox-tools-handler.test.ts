// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { Context } from 'aws-lambda';
import { CALLER_SUB_HEADER } from '../../lib/identity';

const send = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send })),
  InvokeAgentRuntimeCommand: jest.fn((input) => ({ kind: 'invoke', input })),
  StopRuntimeSessionCommand: jest.fn((input) => ({ kind: 'stop', input })),
}));

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test_chem-abc';
const VCF_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test_vcf-abc';
process.env.RUNTIMES = JSON.stringify({ chem: RUNTIME_ARN, vcf: VCF_ARN });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tools = require('../../lambda/sandbox-tools/index') as typeof import('../../lambda/sandbox-tools/index');

function context(tool: string, sub?: string): Context {
  const custom: Record<string, unknown> = { bedrockAgentCoreToolName: tool };
  if (sub !== undefined) custom.bedrockAgentCorePropagatedHeaders = { [CALLER_SUB_HEADER.toLowerCase()]: sub };
  return { clientContext: { custom } } as unknown as Context;
}

function rpcResponse(result: unknown, error?: unknown) {
  const body = JSON.stringify(error ? { jsonrpc: '2.0', id: 1, error } : { jsonrpc: '2.0', id: 1, result });
  return { response: { transformToString: async () => body } };
}

const textResult = (payload: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  isError,
});

beforeEach(() => {
  send.mockReset();
  jest.restoreAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('sandbox tools Lambda', () => {
  test('forwards a tool call to the caller\'s own Runtime session in the chosen environment', async () => {
    send.mockResolvedValue(rpcResponse(textResult({ status: 'succeeded', stdout: '42\n' })));
    const out = await tools.handler({ environment: 'chem', code: 'print(42)' }, context('sandbox___execute_code', 'user-a'));
    expect(out).toEqual({ status: 'succeeded', stdout: '42\n' });

    const { input } = send.mock.calls[0][0];
    expect(input.agentRuntimeArn).toBe(RUNTIME_ARN);
    expect(input.runtimeSessionId).toBe(tools.runtimeSessionId('user-a', 'chem'));
    expect(input.mcpSessionId).toBe(input.runtimeSessionId);
    expect(input.runtimeSessionId).toMatch(/^[0-9a-f]{64}$/);
    const rpc = JSON.parse(Buffer.from(input.payload).toString());
    // The environment argument selects the runtime and is not forwarded to the sandbox server.
    expect(rpc).toMatchObject({ method: 'tools/call', params: { name: 'execute_code' } });
    expect(rpc.params.arguments).toEqual({ code: 'print(42)' });
  });

  test('routes each environment to its own runtime and session', async () => {
    send.mockResolvedValue(rpcResponse(textResult({ entries: [] })));
    await tools.handler({ environment: 'vcf' }, context('sandbox___list_files', 'user-a'));
    const { input } = send.mock.calls[0][0];
    expect(input.agentRuntimeArn).toBe(VCF_ARN);
    expect(input.runtimeSessionId).toBe(tools.runtimeSessionId('user-a', 'vcf'));
  });

  test('rejects a missing or unknown environment without echoing it or calling a runtime', async () => {
    for (const environment of [undefined, 'secret-env', 'toString', '__proto__', 42]) {
      const out = await tools.handler({ environment, code: 'x' }, context('sandbox___execute_code', 'user-a'));
      expect(out).toMatchObject({ status: 'error', error_code: 'INVALID_INPUT' });
      expect((out as { message: string }).message).toContain('chem, vcf');
      expect((out as { message: string }).message).not.toContain('secret-env');
    }
    expect(send).not.toHaveBeenCalled();
    const logged = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(logged).not.toContain('secret-env');
    expect(JSON.parse((console.log as jest.Mock).mock.calls.at(-1)[0])).toMatchObject({ environment: null, outcome: 'INVALID_INPUT' });
  });

  test('list_environments describes the deployed environments without starting a sandbox', async () => {
    const all = (await tools.handler({}, context('sandbox___list_environments', 'user-a'))) as {
      environments: { id: string; packages: { name: string; version: string; import?: string }[] }[];
      usage: string;
    };
    expect(all.environments.map((e) => e.id)).toEqual(['chem', 'vcf']);
    const chem = all.environments[0];
    expect(chem.packages.map((p) => p.name)).toEqual(expect.arrayContaining(['numpy', 'pandas', 'scipy', 'rdkit', 'mmpdb']));
    expect(chem.packages.find((p) => p.name === 'mmpdb')).toMatchObject({ import: 'mmpdblib', version: expect.any(String) });
    expect(all.usage).toContain('environment');
    expect(chem).not.toHaveProperty('installed');

    const detail = (await tools.handler({ environment: 'vcf' }, context('sandbox___list_environments', 'user-a'))) as {
      environment: { id: string; installed: Record<string, string> };
    };
    expect(detail.environment.id).toBe('vcf');
    expect(detail.environment.installed.pysam).toEqual(expect.any(String));

    // Not deployed here (sctraj) or not an environment at all (the shared scbase layer).
    for (const environment of ['sctraj', 'scbase', 'nope']) {
      expect(await tools.handler({ environment }, context('sandbox___list_environments', 'user-a'))).toMatchObject({
        error_code: 'INVALID_INPUT',
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  test('gives each user and environment a stable, distinct session', () => {
    expect(tools.runtimeSessionId('user-a', 'chem')).toBe(tools.runtimeSessionId('user-a', 'chem'));
    expect(tools.runtimeSessionId('user-a', 'chem')).not.toBe(tools.runtimeSessionId('user-b', 'chem'));
    expect(tools.runtimeSessionId('user-a', 'chem')).not.toBe(tools.runtimeSessionId('user-a', 'vcf'));
    // The derivation is unchanged from the per-environment targets, so existing chem sandboxes keep their session.
    expect(tools.runtimeSessionId('user-a', 'chem')).toBe(
      createHash('sha256').update('code-sandbox:v1:chem:user-a').digest('hex'),
    );
  });

  test('fails closed without a verified caller and never reads identity from arguments', async () => {
    const out = await tools.handler({ environment: 'chem', code: 'x', sub: 'user-a' }, context('sandbox___execute_code'));
    expect(out).toMatchObject({ status: 'error', error_code: 'UNAUTHENTICATED' });
    expect(await tools.handler({}, context('sandbox___list_environments'))).toMatchObject({ error_code: 'UNAUTHENTICATED' });
    expect(send).not.toHaveBeenCalled();
  });

  test('rejects unknown targets and tool names', async () => {
    expect(await tools.handler({ environment: 'chem' }, context('chem___execute_code', 'user-a'))).toMatchObject({
      error_code: 'UNKNOWN_TOOL',
    });
    expect(await tools.handler({}, context('execute_code', 'user-a'))).toMatchObject({ error_code: 'UNKNOWN_TOOL' });
    expect(await tools.handler([] as unknown, context('sandbox___execute_code', 'user-a'))).toMatchObject({
      error_code: 'INVALID_INPUT',
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('passes the sandbox server\'s fixed error codes through', async () => {
    send.mockResolvedValue(
      rpcResponse(textResult('Error executing tool read_file: FILE_NOT_FOUND: No regular file exists at that path', true)),
    );
    const out = await tools.handler({ environment: 'chem', path: 'x' }, context('sandbox___read_file', 'user-a'));
    expect(out).toEqual({ status: 'error', error_code: 'FILE_NOT_FOUND', message: 'No regular file exists at that path' });
  });

  test('neither logs nor returns error codes the sandbox server does not define', async () => {
    // Sandboxed code can replace the server, so an error code from the sandbox is untrusted.
    const forged = `LEAKED_${'A'.repeat(5000)}`;
    send.mockResolvedValue(rpcResponse(textResult(`Error executing tool read_file: ${forged}: ${'x'.repeat(5000)}`, true)));
    const out = (await tools.handler({ environment: 'chem', path: 'x' }, context('sandbox___read_file', 'user-a'))) as {
      error_code: string;
      message: string;
    };
    expect(out).toMatchObject({ status: 'error', error_code: 'SANDBOX_ERROR' });
    expect(out.message).toHaveLength(2000);
    const logged = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(logged).not.toContain('LEAKED');
    expect(JSON.parse((console.log as jest.Mock).mock.calls.at(-1)[0])).toMatchObject({ outcome: 'SANDBOX_ERROR' });
  });

  test('knows every error code the sandbox server raises', () => {
    const source = ['sandbox.py', 'server.py']
      .map((file) => readFileSync(path.join(__dirname, '..', '..', 'containers', 'sandbox', 'src', 'code_sandbox_mcp', file), 'utf8'))
      .join('\n');
    const raised = new Set([
      ...[...source.matchAll(/SandboxError\(\s*"([A-Z_]+)"/g)].map((m) => m[1]),
      ...[...source.matchAll(/ToolError\("([A-Z_]+):/g)].map((m) => m[1]),
    ]);
    expect([...raised].sort()).toEqual([...tools.SANDBOX_ERROR_CODES].sort());
  });

  test('retries session-conflict and throttling errors that occur before the sandbox runs anything', async () => {
    send
      .mockResolvedValueOnce(rpcResponse(undefined, { code: -32005, message: 'Session operation in progress, please retry' }))
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }))
      .mockResolvedValueOnce(rpcResponse(textResult({ status: 'succeeded' })));
    const out = await tools.handler({ environment: 'chem', code: 'x' }, context('sandbox___execute_code', 'user-a'));
    expect(out).toEqual({ status: 'succeeded' });
    expect(send).toHaveBeenCalledTimes(3);
  }, 20_000);

  test('does not retry other failures, which could run code twice', async () => {
    send.mockRejectedValue(Object.assign(new Error('boom'), { name: 'InternalServerException' }));
    const out = await tools.handler({ environment: 'chem', code: 'x' }, context('sandbox___execute_code', 'user-a'));
    expect(out).toMatchObject({ status: 'error', error_code: 'SANDBOX_UNAVAILABLE' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('reset_sandbox stops the caller\'s Runtime session in one environment, and succeeds when none is running', async () => {
    send.mockResolvedValueOnce({});
    const reset = context('sandbox___reset_sandbox', 'user-a');
    expect(await tools.handler({ environment: 'chem' }, reset)).toMatchObject({ status: 'reset' });
    expect(send.mock.calls[0][0]).toMatchObject({
      kind: 'stop',
      input: { agentRuntimeArn: RUNTIME_ARN, runtimeSessionId: tools.runtimeSessionId('user-a', 'chem') },
    });
    send.mockRejectedValueOnce(Object.assign(new Error('none'), { name: 'ResourceNotFoundException' }));
    expect(await tools.handler({ environment: 'chem' }, reset)).toMatchObject({ status: 'reset' });
    expect(await tools.handler({}, reset)).toMatchObject({ error_code: 'INVALID_INPUT' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('parses SSE-framed responses', () => {
    expect(tools.parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  test('logs only the environment, tool, outcome, and duration', async () => {
    send.mockResolvedValue(rpcResponse(textResult({ stdout: 'secret-output' })));
    await tools.handler({ environment: 'chem', code: 'secret-code' }, context('sandbox___execute_code', 'secret-user'));
    const logged = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(logged).not.toMatch(/secret-/);
    expect(JSON.parse((console.log as jest.Mock).mock.calls[0][0])).toEqual({
      environment: 'chem',
      tool: 'execute_code',
      outcome: 'SUCCESS',
      ms: expect.any(Number),
    });
  });
});
