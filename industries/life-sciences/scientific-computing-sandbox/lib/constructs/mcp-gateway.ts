// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig, toCustomJwtAuthorizer } from '../config/jwt-authorizer';
import { CALLER_SUB_HEADER } from '../identity';
import { ToolDefinition, toGatewaySchema } from '../tools';

/** A runtime whose invocation the gateway's targets broker, keyed by sandbox environment ID. */
export interface BrokeredRuntime {
  readonly name: string;
  readonly runtime: agentcore.IBedrockAgentRuntime;
}

/** Runtimes that only one principal may invoke, through one VPC endpoint, and the actions it may use. */
export interface RuntimeAccess {
  readonly runtimes: readonly BrokeredRuntime[];
  readonly principal: iam.IRole;
  readonly actions: readonly string[];
  /** The AgentCore data-plane interface endpoint every call must come through (`aws:SourceVpce`). */
  readonly sourceVpcEndpointId: string;
}

/** A Gateway Lambda target with an inline tool schema. */
export interface McpLambdaTarget {
  /** Gateway target name; tool names are prefixed with it in MCP. */
  readonly name: string;
  readonly function: lambda.IFunction;
  readonly tools: readonly ToolDefinition[];
  /**
   * Forward the interceptor-verified caller `sub` to this target in
   * `CALLER_SUB_HEADER`. Enable only for targets that act per user.
   */
  readonly propagateCallerIdentity: boolean;
}

export interface McpGatewayProps {
  readonly projectName: string;
  readonly gatewayName: string;
  readonly gatewayDescription: string;
  /** Inbound JWT authentication against the customer's identity provider. */
  readonly jwt: JwtAuthorizerConfig;
  /** Lambda targets. Names must be unique. */
  readonly targets: readonly McpLambdaTarget[];
  /** REQUEST interceptor that verifies the caller and sets `CALLER_SUB_HEADER`. */
  readonly requestInterceptor: lambda.IFunction;
  /**
   * Runtimes the targets call, restricted by resource policy to the given
   * principal. A runtime has a single resource policy, owned here. Keep the
   * construct IDs: a new logical ID would make CloudFormation create a second
   * policy for the same runtime and then delete the old one, leaving the
   * runtime without a policy.
   */
  readonly runtimeAccess: RuntimeAccess;
}

/**
 * Amazon Bedrock AgentCore Gateway with the MCP protocol, a CUSTOM_JWT inbound
 * authorizer, Lambda targets, a REQUEST interceptor, the IAM role the Gateway
 * invokes them with, and the resource policies of the runtimes the targets call.
 *
 * Copied from templates/lambda-target and extended for this accelerator. The
 * interceptor runs on every request, receives the request headers, and
 * replaces `CALLER_SUB_HEADER` with the verified `sub`; only targets with
 * `propagateCallerIdentity` allowlist that header.
 */
export class McpGateway extends Construct {
  public readonly gateway: agentcore.CfnGateway;
  public readonly targets: Record<string, agentcore.CfnGatewayTarget> = {};
  public readonly role: iam.Role;
  public readonly runtimePolicies: agentcore.CfnResourcePolicy[] = [];

  constructor(scope: Construct, id: string, props: McpGatewayProps) {
    super(scope, id);

    const { projectName, targets, runtimeAccess } = props;
    const stack = Stack.of(this);
    const { account, partition, region } = stack;
    const names = targets.map((t) => t.name);
    if (new Set(names).size !== names.length) {
      throw new Error(`Gateway target names must be unique, got ${names.join(', ')}`);
    }

    this.role = new iam.Role(this, 'GatewayRole', {
      roleName: `${projectName}-gateway-role`,
      description: 'Execution role for Amazon Bedrock AgentCore Gateway to invoke its interceptor and Lambda targets',
      // Only this gateway may assume the role: its ID is the gateway name plus a generated suffix. Any other gateway
      // in the account could otherwise use the role to invoke the tools Lambda with a caller header of its choosing.
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: {
            'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:gateway/${props.gatewayName}-*`,
          },
        },
      }),
    });
    Tags.of(this.role).add('Component', 'Gateway');
    props.requestInterceptor.grantInvoke(this.role);
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'grantInvoke allows the interceptor and target functions and their versions and aliases ' +
            '(<function ARN>:*), no other functions.',
          // `<Logical.Arn>`, or `<stack>:ExportsOutputFnGetAtt...Arn...` when the ARN is a cross-stack import.
          appliesTo: [{ regex: '/^Resource::(<[^>]+\\.Arn>|[^:]+:ExportsOutputFnGetAtt\\w+Arn\\w*):\\*$/g' }],
        },
      ],
      true,
    );

    this.gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: props.gatewayName,
      description: props.gatewayDescription,
      roleArn: this.role.roleArn,
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: { customJwtAuthorizer: toCustomJwtAuthorizer(props.jwt) },
      protocolConfiguration: { mcp: { searchType: 'SEMANTIC' } },
      interceptorConfigurations: [
        {
          interceptionPoints: ['REQUEST'],
          interceptor: { lambda: { arn: props.requestInterceptor.functionArn } },
          inputConfiguration: { passRequestHeaders: true },
        },
      ],
      tags: { Project: projectName, Component: 'Gateway' },
    });
    // Role policy must exist before the gateway validates the interceptor and targets.
    this.gateway.node.addDependency(this.role);

    // Keep the denies: without the first, any principal in the account with these actions could bypass the
    // Gateway's authorizer or enter another user's sandbox session; the second refuses even the tools Lambda's
    // role (or its leaked credentials) outside the sandbox VPC's AgentCore endpoint.
    for (const { name, runtime } of runtimeAccess.runtimes) {
      const runtimeArn = runtime.agentRuntimeArn;
      const principalArn = runtimeAccess.principal.roleArn;
      this.runtimePolicies.push(
        new agentcore.CfnResourcePolicy(this, `RuntimeResourcePolicy-${name}`, {
          resourceArn: runtimeArn,
          policy: stack.toJsonString({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'AllowSandboxToolsRole',
                Effect: 'Allow',
                Principal: { AWS: principalArn },
                Action: runtimeAccess.actions,
                Resource: runtimeArn,
              },
              {
                Sid: 'DenyAllOtherPrincipals',
                Effect: 'Deny',
                Principal: '*',
                Action: runtimeAccess.actions,
                Resource: runtimeArn,
                Condition: { StringNotEquals: { 'aws:PrincipalArn': principalArn } },
              },
              {
                Sid: 'DenyOutsideSandboxVpcEndpoint',
                Effect: 'Deny',
                Principal: '*',
                Action: runtimeAccess.actions,
                Resource: runtimeArn,
                Condition: { StringNotEquals: { 'aws:SourceVpce': runtimeAccess.sourceVpcEndpointId } },
              },
            ],
          }),
        }),
      );
    }

    const granted = new Set<lambda.IFunction>();
    for (const target of targets) {
      if (!granted.has(target.function)) {
        target.function.grantInvoke(this.role);
        granted.add(target.function);
      }
      const gatewayTarget = new agentcore.CfnGatewayTarget(this, `Target-${target.name}`, {
        name: target.name,
        description: `${target.name} Lambda target for ${projectName}`,
        gatewayIdentifier: this.gateway.attrGatewayIdentifier,
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: target.function.functionArn,
              toolSchema: {
                inlinePayload: target.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: toGatewaySchema(tool.inputSchema),
                })),
              },
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
        metadataConfiguration: target.propagateCallerIdentity
          ? { allowedRequestHeaders: [CALLER_SUB_HEADER] }
          : undefined,
      });
      gatewayTarget.node.addDependency(this.role);
      this.targets[target.name] = gatewayTarget;
    }
  }
}
