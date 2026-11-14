// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Header the Gateway REQUEST interceptor sets to the verified token's `sub`
 * and the sandbox targets allowlist. The interceptor always overwrites it, so
 * a client-supplied value never reaches a target.
 */
export const CALLER_SUB_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Caller-Sub';

/** Printable ASCII without spaces, 1-256 characters. The sub is only ever hashed, never parsed. */
export const CALLER_SUB_PATTERN = /^[\x21-\x7E]{1,256}$/;

export function isValidCallerSub(value: unknown): value is string {
  return typeof value === 'string' && CALLER_SUB_PATTERN.test(value);
}
