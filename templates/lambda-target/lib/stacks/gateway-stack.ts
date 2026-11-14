// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig } from '../config/jwt-authorizer';
import { McpGateway } from '../constructs';
import { TARGET_NAME, TOOLS } from '../tools';

export interface GatewayStackProps extends StackProps {
  readonly projectName: string;
  /** Inbound JWT authentication against the customer's identity provider. */
  readonly jwt: JwtAuthorizerConfig;
  /** The function that implements `TOOLS`. */
  readonly toolsFunction: lambda.IFunction;
}

/** The AgentCore Gateway that AWS Quick connects to. Its `GatewayUrl` output is the MCP server endpoint. */
export class GatewayStack extends Stack {
  public readonly mcpGateway: McpGateway;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const { projectName } = props;
    Tags.of(this).add('Project', projectName);

    this.mcpGateway = new McpGateway(this, 'McpGateway', {
      projectName,
      gatewayName: `${projectName}-gateway`,
      gatewayDescription: `MCP tools for AWS Quick from ${projectName}`,
      jwt: props.jwt,
      targets: [{ name: TARGET_NAME, function: props.toolsFunction, tools: TOOLS }],
    });

    new CfnOutput(this, 'GatewayUrl', {
      description: 'MCP server endpoint to enter in the AWS Quick connector',
      value: this.mcpGateway.gateway.attrGatewayUrl,
    });
  }
}
