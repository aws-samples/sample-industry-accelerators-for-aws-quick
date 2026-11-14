// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig, toCustomJwtAuthorizer } from '../config/jwt-authorizer';
import { ToolDefinition, toGatewayToolSchema } from '../tools';

/** A Gateway Lambda target with an inline tool schema. */
export interface McpLambdaTarget {
  /** Target name; the Gateway prefixes tool names with it (`<name>___<tool>`). */
  readonly name: string;
  readonly function: lambda.IFunction;
  /** The tools the function implements. */
  readonly tools: readonly ToolDefinition[];
}

export interface McpGatewayProps {
  readonly projectName: string;
  readonly gatewayName: string;
  readonly gatewayDescription: string;
  /** Inbound JWT authentication against the customer's identity provider. */
  readonly jwt: JwtAuthorizerConfig;
  /** Lambda targets. Names must be unique. */
  readonly targets: readonly McpLambdaTarget[];
}

/**
 * Amazon Bedrock AgentCore Gateway with the MCP protocol, a CUSTOM_JWT inbound
 * authorizer, Lambda targets, and the IAM role the Gateway invokes them with.
 *
 * Copied into each accelerator from templates/lambda-target. Accelerators
 * extend it with other target types (for example MCP servers on AgentCore
 * Runtime) or a REQUEST interceptor.
 */
export class McpGateway extends Construct {
  public readonly gateway: agentcore.CfnGateway;
  public readonly role: iam.Role;
  public readonly targets: Record<string, agentcore.CfnGatewayTarget> = {};

  constructor(scope: Construct, id: string, props: McpGatewayProps) {
    super(scope, id);

    const { projectName } = props;
    const { account, partition, region } = Stack.of(this);
    const names = props.targets.map((t) => t.name);
    if (new Set(names).size !== names.length) {
      throw new Error(`Gateway target names must be unique, got ${names.join(', ')}`);
    }

    this.role = new iam.Role(this, 'GatewayRole', {
      roleName: `${projectName}-gateway-role`,
      description: `Role the ${props.gatewayName} AgentCore Gateway uses to invoke its targets`,
      // Only this gateway may assume the role: its ID is the gateway name plus a generated suffix. Any other gateway
      // in the account could otherwise use the role to invoke the target functions.
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
    for (const target of props.targets) {
      target.function.grantInvoke(this.role);
    }
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'grantInvoke allows the target functions and their versions and aliases (<function ARN>:*), no other functions.',
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
      tags: { Project: projectName, Component: 'Gateway' },
    });
    // The Gateway checks that it can invoke each target when the target is created.
    this.gateway.node.addDependency(this.role);

    for (const target of props.targets) {
      this.targets[target.name] = new agentcore.CfnGatewayTarget(this, `Target-${target.name}`, {
        name: target.name,
        description: `Lambda target ${target.name} for ${projectName}`,
        gatewayIdentifier: this.gateway.attrGatewayIdentifier,
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: target.function.functionArn,
              toolSchema: { inlinePayload: target.tools.map(toGatewayToolSchema) },
            },
          },
        },
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      });
    }
  }
}
