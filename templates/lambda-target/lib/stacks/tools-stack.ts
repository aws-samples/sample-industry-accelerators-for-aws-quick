// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { CfnOutput, Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ToolsStackProps extends StackProps {
  readonly projectName: string;
}

/** The Lambda function that implements the example tools. */
export class ToolsStack extends Stack {
  public readonly toolsFunction: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ToolsStackProps) {
    super(scope, id, props);

    const { projectName } = props;
    Tags.of(this).add('Project', projectName);

    // The function's role gets only AWSLambdaBasicExecutionRole (CloudWatch Logs). Grant it exactly the AWS
    // actions your tools call.
    this.toolsFunction = new nodejs.NodejsFunction(this, 'ToolsFunction', {
      functionName: `${projectName}-tools`,
      description: `MCP tools for ${projectName}, invoked by its AgentCore Gateway`,
      entry: path.join(__dirname, '..', '..', 'lambda', 'unit-converter', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling: { minify: true, sourceMap: true },
      environment: { NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'ToolsFunctionLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    NagSuppressions.addResourceSuppressions(
      this.toolsFunction,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS managed policy for writing the function\'s CloudWatch Logs.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Node.js 24 is the latest generally available Lambda runtime; Node.js 26 is in public preview.',
        },
      ],
      true,
    );

    // Read by the integration tests.
    new CfnOutput(this, 'ToolsFunctionName', {
      description: 'Name of the tools Lambda function',
      value: this.toolsFunction.functionName,
    });
  }
}
