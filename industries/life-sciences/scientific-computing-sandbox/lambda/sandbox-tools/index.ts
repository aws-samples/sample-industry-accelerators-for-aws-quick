// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AgentCore Gateway Lambda target that gives each user one persistent sandbox
 * per environment.
 *
 * Every environment is served by one Gateway target (`sandbox`); the tools
 * take an `environment` argument. AWS Quick starts a new MCP session for
 * every tool call, so Gateway sessions cannot keep a sandbox. Instead this
 * function derives the AgentCore Runtime session ID from the caller's verified
 * `sub` (set by the caller-identity interceptor in CALLER_SUB_HEADER) and the
 * environment, and forwards the call to that environment's Runtime session as
 * an MCP `tools/call`, without the `environment` argument. Every call by the
 * same user in one environment therefore lands in the same microVM until the
 * Runtime stops it (idle timeout or maximum lifetime). `reset_sandbox` stops
 * it on request, and `list_environments` answers from the bundled catalog
 * without starting a sandbox.
 *
 * The `environment` argument only selects which of the caller's own sandboxes
 * to use: it is checked against the deployed environments, and the session ID
 * always comes from the verified caller. Only this function's role can invoke
 * the runtimes (runtime resource policies), so a session ID is not reachable
 * by anyone who can compute it. Logs hold only the environment (once
 * validated), tool name, outcome, and duration: never the caller, arguments,
 * code, paths, or results.
 */
import { createHash } from 'crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { Context } from 'aws-lambda';
import { CALLER_SUB_HEADER, isValidCallerSub } from '../../lib/identity';
import { describeEnvironments } from '../../lib/sandbox/catalog';
import { ENVIRONMENT_ARGUMENT, SANDBOX_TARGET_NAME } from '../../lib/tools/sandbox-tools';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
};

/** Environment ID -> AgentCore Runtime ARN. */
const RUNTIMES: Record<string, string> = JSON.parse(env('RUNTIMES'));
const ENVIRONMENT_IDS = Object.keys(RUNTIMES);
const MCP_PROTOCOL_VERSION = '2025-03-26';
/** Bumping this gives every user a new sandbox. */
const SESSION_NAMESPACE = 'code-sandbox:v1';
const MAX_ATTEMPTS = 5;

// One attempt per SDK call: a transport-level retry could run the caller's code twice. The
// handler retries only the errors AgentCore returns before the request reaches the sandbox.
const client = new BedrockAgentCoreClient({ maxAttempts: 1 });

type Args = Record<string, unknown>;

/** A failure reported to the caller as a structured error. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Runtime session ID for a user's sandbox in one environment (64 hex characters; the API needs 33-256). */
export function runtimeSessionId(sub: string, environment: string): string {
  return createHash('sha256').update(`${SESSION_NAMESPACE}:${environment}:${sub}`).digest('hex');
}

function customContext(context?: Context): Record<string, unknown> {
  const clientContext = context?.clientContext as { custom?: Record<string, unknown>; Custom?: Record<string, unknown> } | undefined;
  return clientContext?.custom ?? clientContext?.Custom ?? {};
}

/** `<target>___<tool>` from the Gateway, split into the target name and the tool name. */
function toolNameFrom(event: Args, context?: Context): { target: string; tool: string } {
  const fullName = customContext(context).bedrockAgentCoreToolName ?? event.tool_name;
  if (typeof fullName !== 'string' || !fullName.includes('___')) return { target: '', tool: '' };
  const at = fullName.indexOf('___');
  return { target: fullName.slice(0, at), tool: fullName.slice(at + 3) };
}

/**
 * The caller identity propagated by Gateway from the request interceptor.
 * Never read from the event: tool arguments are filled in by the model.
 */
function callerFrom(context?: Context): string | undefined {
  let headers = customContext(context).bedrockAgentCorePropagatedHeaders;
  if (typeof headers === 'string') {
    try {
      headers = JSON.parse(headers);
    } catch {
      return undefined;
    }
  }
  if (typeof headers !== 'object' || headers === null) return undefined;
  const wanted = CALLER_SUB_HEADER.toLowerCase();
  const sub = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted)?.[1];
  return isValidCallerSub(sub) ? sub : undefined;
}

/** Parses a JSON-RPC response that may arrive as JSON or as an SSE stream. */
export function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:') && line.length > 5)
    .pop();
  if (!data) throw new ToolError('SANDBOX_UNAVAILABLE', 'The sandbox returned an unreadable response');
  return JSON.parse(data.slice(5));
}

// JSON-RPC errors AgentCore Runtime returns before the request reaches the container: throttling
// (-32003) and "Session operation in progress, please retry" while a session starts or stops (-32005).
const RETRYABLE_RPC_CODES = new Set([-32003, -32005]);
const RETRYABLE_SDK_ERRORS = /Throttling|ServiceQuotaExceeded|RetryableConflict|TooManyRequests/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function invokeRuntime(runtimeArn: string, sessionId: string, tool: string, args: Args): Promise<any> {
  const payload = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  );
  for (let attempt = 1; ; attempt++) {
    const backoff = () => sleep(Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2));
    let message: any;
    try {
      const res = await client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          qualifier: 'DEFAULT',
          // Both IDs route the call to the user's microVM; the MCP one is what the Runtime documents for MCP servers.
          runtimeSessionId: sessionId,
          mcpSessionId: sessionId,
          mcpProtocolVersion: MCP_PROTOCOL_VERSION,
          contentType: 'application/json',
          accept: 'application/json, text/event-stream',
          payload,
        }),
      );
      message = parseRpcBody((await res.response?.transformToString()) ?? '');
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const name = (err as Error)?.name ?? 'Error';
      if (RETRYABLE_SDK_ERRORS.test(name) && attempt < MAX_ATTEMPTS) {
        await backoff();
        continue;
      }
      if (RETRYABLE_SDK_ERRORS.test(name)) {
        throw new ToolError('THROTTLED', 'The sandbox service is busy. Retry shortly.');
      }
      throw new ToolError('SANDBOX_UNAVAILABLE', `The sandbox could not be reached (${name}).`);
    }
    if (message?.error) {
      if (RETRYABLE_RPC_CODES.has(message.error.code) && attempt < MAX_ATTEMPTS) {
        await backoff();
        continue;
      }
      throw new ToolError('SANDBOX_UNAVAILABLE', `The sandbox rejected the request (JSON-RPC ${message.error.code}).`);
    }
    return message?.result;
  }
}

/**
 * Error codes the sandbox server raises (`SandboxError` codes and `INTERNAL_ERROR`). Sandboxed code can replace the
 * server, so any other code is reported as SANDBOX_ERROR rather than logged or returned as given.
 */
export const SANDBOX_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'FILE_NOT_FOUND',
  'NOT_TEXT',
  'PERMISSION_DENIED',
  'JOB_NOT_FOUND',
  'TOO_MANY_JOBS',
  'INTERNAL_ERROR',
]);
const MAX_ERROR_MESSAGE_CHARS = 2000;

/** The sandbox server's tool result: a JSON text payload, or an error whose text starts with a fixed code. */
function unwrap(result: any): unknown {
  const text = result?.content?.find((c: { type?: string }) => c?.type === 'text')?.text;
  if (typeof text !== 'string') throw new ToolError('SANDBOX_UNAVAILABLE', 'The sandbox returned no result');
  if (result.isError) {
    const detail = text.replace(/^Error executing tool \S+: /, '');
    const match = /^([A-Z][A-Z_]+): (.*)$/s.exec(detail);
    if (!match) throw new ToolError('INVALID_INPUT', detail.slice(0, MAX_ERROR_MESSAGE_CHARS));
    const code = SANDBOX_ERROR_CODES.has(match[1]) ? match[1] : 'SANDBOX_ERROR';
    throw new ToolError(code, match[2].slice(0, MAX_ERROR_MESSAGE_CHARS));
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function resetSandbox(runtimeArn: string, sessionId: string) {
  try {
    await client.send(new StopRuntimeSessionCommand({ agentRuntimeArn: runtimeArn, qualifier: 'DEFAULT', runtimeSessionId: sessionId }));
  } catch (err) {
    const name = (err as Error)?.name ?? 'Error';
    if (name !== 'ResourceNotFoundException') {
      throw new ToolError('SANDBOX_UNAVAILABLE', `The sandbox could not be reset (${name}).`);
    }
  }
  return {
    status: 'reset',
    hint: 'The sandbox was stopped and its files and jobs discarded. The next call starts a new, empty sandbox.',
  };
}

const failure = (errorCode: string, message: string) => ({ status: 'error', error_code: errorCode, message });

/** A deployed environment ID, or undefined. The value is caller-supplied, so it is never echoed or logged otherwise. */
function knownEnvironment(value: unknown): string | undefined {
  return typeof value === 'string' && Object.hasOwn(RUNTIMES, value) ? value : undefined;
}

const unknownEnvironment = () =>
  new ToolError(
    'INVALID_INPUT',
    `${ENVIRONMENT_ARGUMENT} must be one of: ${ENVIRONMENT_IDS.join(', ')}. Call list_environments to choose one.`,
  );

function listEnvironments(args: Args) {
  const requested = args[ENVIRONMENT_ARGUMENT];
  if (requested === undefined || requested === null || requested === '') return describeEnvironments(ENVIRONMENT_IDS);
  const environment = knownEnvironment(requested);
  const result = environment && describeEnvironments(ENVIRONMENT_IDS, environment);
  if (!result) throw unknownEnvironment();
  return result;
}

export async function handler(event: unknown, context?: Context) {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return failure('INVALID_INPUT', 'Tool arguments must be a JSON object');
  }
  const args = { ...(event as Args) };
  delete args.tool_name;
  const { target, tool } = toolNameFrom(event as Args, context);
  if (target !== SANDBOX_TARGET_NAME || !tool) {
    return failure('UNKNOWN_TOOL', 'Unknown sandbox tool');
  }

  const started = Date.now();
  let environment: string | undefined;
  const log = (outcome: string) =>
    console.log(JSON.stringify({ environment: environment ?? null, tool, outcome, ms: Date.now() - started }));
  const caller = callerFrom(context);
  if (!caller) {
    log('UNAUTHENTICATED');
    return failure('UNAUTHENTICATED', 'No verified caller identity was provided. Call this tool through the AgentCore Gateway.');
  }

  try {
    let data: unknown;
    if (tool === 'list_environments') {
      data = listEnvironments(args);
    } else {
      environment = knownEnvironment(args[ENVIRONMENT_ARGUMENT]);
      if (!environment) throw unknownEnvironment();
      delete args[ENVIRONMENT_ARGUMENT];
      const runtimeArn = RUNTIMES[environment];
      const sessionId = runtimeSessionId(caller, environment);
      data =
        tool === 'reset_sandbox'
          ? await resetSandbox(runtimeArn, sessionId)
          : unwrap(await invokeRuntime(runtimeArn, sessionId, tool, args));
    }
    log('SUCCESS');
    return data;
  } catch (err) {
    if (err instanceof ToolError) {
      log(err.code);
      return failure(err.code, err.message);
    }
    log(`ERROR:${(err as Error)?.name ?? 'Error'}`);
    return failure('INTERNAL_ERROR', `Unable to complete ${tool}`);
  }
}
