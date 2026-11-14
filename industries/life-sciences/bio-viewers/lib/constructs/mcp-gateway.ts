// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig, toCustomJwtAuthorizer } from '../config/jwt-authorizer';

export interface McpGatewayProps {
  readonly projectName: string;
  readonly gatewayName: string;
  readonly gatewayDescription: string;
  /** Inbound JWT authentication against the customer's identity provider. */
  readonly jwt: JwtAuthorizerConfig;
  /** Target name; the Gateway prefixes tool names with it (`<targetName>___<tool>`). */
  readonly targetName: string;
  /** AgentCore Runtime hosting the MCP server the Gateway proxies. */
  readonly targetRuntime: agentcore.IBedrockAgentRuntime;
  /** Runtime MCP invocation URL (URL-encoded runtime ARN, DEFAULT qualifier). */
  readonly targetEndpoint: string;
}

/**
 * Amazon Bedrock AgentCore Gateway with the MCP protocol, a CUSTOM_JWT inbound
 * authorizer, one MCP server target hosted on AgentCore Runtime, and the IAM
 * role the Gateway SigV4-signs its calls to the Runtime with. The Gateway
 * discovers the target's tools and `ui://` resources from the server itself.
 *
 * A resource policy on the Runtime denies `InvokeAgentRuntime` to every
 * principal except the Gateway role, so other IAM principals in the account
 * cannot reach the server around the Gateway's authorizer.
 *
 * Adapted from templates/lambda-target, which supports Lambda targets only.
 */
export class McpGateway extends Construct {
  public readonly gateway: agentcore.CfnGateway;
  public readonly target: agentcore.CfnGatewayTarget;
  public readonly role: iam.Role;
  public readonly runtimePolicy: agentcore.CfnResourcePolicy;

  constructor(scope: Construct, id: string, props: McpGatewayProps) {
    super(scope, id);

    const { projectName, targetName, targetRuntime, targetEndpoint } = props;
    const stack = Stack.of(this);
    const { account, partition, region } = stack;

    this.role = new iam.Role(this, 'GatewayRole', {
      roleName: `${projectName}-gateway-role`,
      description: `Role the ${props.gatewayName} AgentCore Gateway uses to invoke its Runtime target`,
      // Only this gateway may assume the role: its ID is the gateway name plus a generated suffix. Another gateway in
      // the account (one without an inbound authorizer, say) could otherwise use the role, which the Runtime resource
      // policy admits, and reach the server around this Gateway's authorizer.
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
    targetRuntime.grantInvokeRuntime(this.role);
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'grantInvokeRuntime allows the target Runtime and its endpoints (<runtime ARN>/*), no other Runtimes.',
          // `<Logical.AgentRuntimeArn>`, or `<stack>:ExportsOutputFnGetAtt...` when the ARN is a cross-stack import.
          appliesTo: [{ regex: '/^Resource::(<[^>]+\\.AgentRuntimeArn>|[^:]+:ExportsOutputFnGetAtt\\w+AgentRuntimeArn\\w*)\\/\\*$/g' }],
        },
      ],
      true,
    );

    // A Runtime has a single resource policy; this construct owns it because it
    // knows the Gateway role. Keep the deny: without it any principal in the
    // account with InvokeAgentRuntime could bypass the Gateway's authorizer.
    const runtimeArn = targetRuntime.agentRuntimeArn;
    this.runtimePolicy = new agentcore.CfnResourcePolicy(this, 'RuntimeResourcePolicy', {
      resourceArn: runtimeArn,
      policy: stack.toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowGatewayRole',
            Effect: 'Allow',
            Principal: { AWS: this.role.roleArn },
            Action: 'bedrock-agentcore:InvokeAgentRuntime',
            Resource: runtimeArn,
          },
          {
            Sid: 'DenyAllOtherPrincipals',
            Effect: 'Deny',
            Principal: '*',
            Action: 'bedrock-agentcore:InvokeAgentRuntime',
            Resource: runtimeArn,
            Condition: { StringNotEquals: { 'aws:PrincipalArn': this.role.roleArn } },
          },
        ],
      }),
    });

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
    // The Gateway checks that it can invoke the target when the target is created.
    this.gateway.node.addDependency(this.role);

    // MCP server targets (not Lambda targets) pass through the tools' `_meta`
    // and the `ui://` resources that MCP Apps need.
    this.target = new agentcore.CfnGatewayTarget(this, 'Target', {
      name: targetName,
      description: `AgentCore Runtime MCP server target for ${projectName}`,
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      targetConfiguration: { mcp: { mcpServer: { endpoint: targetEndpoint } } },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'GATEWAY_IAM_ROLE',
          credentialProvider: { iamCredentialProvider: { service: 'bedrock-agentcore', region } },
        },
      ],
    });
    // The Gateway lists the server's tools and resources when the target is
    // created, so the invoke permission (identity and resource policy) must be
    // in place first.
    this.target.node.addDependency(this.role);
    this.target.node.addDependency(this.runtimePolicy);
  }
}
