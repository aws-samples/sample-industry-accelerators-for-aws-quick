// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig } from '../config/jwt-authorizer';
import { McpGateway, SANDBOX_RUNTIME_ACTIONS, SandboxTools } from '../constructs';
import { gatewayTools, SANDBOX_TARGET_NAME, SERVER_TOOLS } from '../tools';
import { SandboxNetwork } from './network-stack';
import { SandboxRuntime } from './sandbox-runtime-stack';

export interface GatewayStackProps extends StackProps {
  readonly projectName: string;
  /** Inbound JWT authentication against the customer's identity provider; the interceptor checks the same values. */
  readonly jwt: JwtAuthorizerConfig;
  /**
   * Sandbox runtimes, one per environment. A single Gateway target
   * (`SANDBOX_TARGET_NAME`) serves them all: its tools take the environment
   * ID as an argument.
   */
  readonly runtimes: readonly SandboxRuntime[];
  /** The sandbox VPC: the tools Lambda runs in it and reaches the runtimes through an AgentCore endpoint there. */
  readonly network: SandboxNetwork;
  /**
   * Reserved concurrency of the sandbox tools Lambda: the most tool calls that run at once across all users.
   * Undefined reserves none.
   */
  readonly toolsReservedConcurrency?: number;
}

/**
 * The AgentCore Gateway that AWS Quick connects to (its `GatewayUrl` output is the MCP server endpoint), with:
 *
 * - a CUSTOM_JWT authorizer for the customer's identity provider;
 * - a caller-identity REQUEST interceptor that verifies the token again with the same settings and passes the
 *   verified `sub` to the target;
 * - one Lambda target for all sandbox environments: the sandbox tools Lambda, which routes each user to their own
 *   Runtime session in the environment a tool call names;
 * - one runtime resource policy per environment that admits only that Lambda, through the sandbox VPC's AgentCore
 *   endpoint.
 *
 * AWS Quick starts a new MCP session for every tool call, so per-user sandbox persistence comes from the Lambda's
 * `sub`-derived Runtime session IDs, not from Gateway MCP sessions.
 */
export class GatewayStack extends Stack {
  public readonly mcpGateway: McpGateway;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const { projectName, runtimes } = props;
    Tags.of(this).add('Project', projectName);

    const sandboxTools = new SandboxTools(this, 'SandboxTools', {
      projectName,
      runtimes,
      jwt: props.jwt,
      network: {
        vpc: props.network.vpc,
        subnets: props.network.subnets,
        clientSecurityGroup: props.network.agentCoreClientSecurityGroup,
        endpointSecurityGroup: props.network.agentCoreEndpointSecurityGroup,
      },
      reservedConcurrentExecutions: props.toolsReservedConcurrency,
    });
    this.mcpGateway = new McpGateway(this, 'McpGateway', {
      projectName,
      gatewayName: `${projectName}-gateway`,
      gatewayDescription: `Scientific code sandboxes for AWS Quick from ${projectName}`,
      jwt: props.jwt,
      requestInterceptor: sandboxTools.interceptor,
      runtimeAccess: {
        runtimes,
        principal: sandboxTools.toolsFunction.role!,
        actions: SANDBOX_RUNTIME_ACTIONS,
        sourceVpcEndpointId: sandboxTools.runtimeEndpoint.vpcEndpointId,
      },
      targets: [
        {
          name: SANDBOX_TARGET_NAME,
          tools: gatewayTools(SERVER_TOOLS, runtimes.map((r) => r.name)),
          function: sandboxTools.toolsFunction,
          propagateCallerIdentity: true,
        },
      ],
    });

    new CfnOutput(this, 'GatewayUrl', {
      description: 'MCP server endpoint to enter in the AWS Quick connector',
      value: this.mcpGateway.gateway.attrGatewayUrl,
    });
  }
}
