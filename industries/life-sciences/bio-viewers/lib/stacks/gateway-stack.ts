// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig } from '../config/jwt-authorizer';
import { McpGateway } from '../constructs';
import { TARGET_NAME } from '../tools';

export interface GatewayStackProps extends StackProps {
  readonly projectName: string;
  /** Inbound JWT authentication against the customer's identity provider. */
  readonly jwt: JwtAuthorizerConfig;
  /** AgentCore Runtime hosting the bio-viewers MCP server. */
  readonly targetRuntime: agentcore.IBedrockAgentRuntime;
  /** Runtime MCP invocation URL used as the Gateway target endpoint. */
  readonly targetEndpoint: string;
}

/**
 * The AgentCore Gateway that AWS Quick connects to, with the bio-viewers
 * Runtime as its MCP server target. Its `GatewayUrl` output is the MCP server
 * endpoint.
 */
export class GatewayStack extends Stack {
  public readonly mcpGateway: McpGateway;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const { projectName } = props;
    Tags.of(this).add('Project', projectName);

    this.mcpGateway = new McpGateway(this, 'McpGateway', {
      projectName,
      gatewayName: `${projectName}-gateway`,
      gatewayDescription: `Protein structure, sequence alignment and DICOM viewers for AWS Quick from ${projectName}`,
      jwt: props.jwt,
      targetName: TARGET_NAME,
      targetRuntime: props.targetRuntime,
      targetEndpoint: props.targetEndpoint,
    });

    new CfnOutput(this, 'GatewayUrl', {
      description: 'MCP server endpoint to enter in the AWS Quick connector',
      value: this.mcpGateway.gateway.attrGatewayUrl,
    });
  }
}
