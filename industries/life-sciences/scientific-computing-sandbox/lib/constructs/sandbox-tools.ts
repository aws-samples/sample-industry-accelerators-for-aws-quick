// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { Duration, Stack, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { JwtAuthorizerConfig, validateJwtAuthorizerConfig } from '../config/jwt-authorizer';

const LAMBDA_DIR = path.join(__dirname, '..', '..', 'lambda');

/** Runtime actions the tools Lambda uses. The runtime resource policies (see `McpGateway`) admit only it for them. */
export const SANDBOX_RUNTIME_ACTIONS = ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'];

/** A sandbox environment's runtime, keyed by its environment ID. */
export interface SandboxRuntimeRef {
  readonly name: string;
  readonly runtime: agentcore.IBedrockAgentRuntime;
}

/** Where the tools Lambda runs: the sandbox VPC, which reaches AgentCore only through an interface endpoint. */
export interface SandboxToolsNetwork {
  readonly vpc: ec2.IVpc;
  readonly subnets: ec2.SubnetSelection;
  /** The Lambda's security group; it may connect only to the endpoint's. */
  readonly clientSecurityGroup: ec2.ISecurityGroup;
  readonly endpointSecurityGroup: ec2.ISecurityGroup;
}

export interface SandboxToolsProps {
  readonly projectName: string;
  readonly runtimes: readonly SandboxRuntimeRef[];
  readonly network: SandboxToolsNetwork;
  /** The Gateway's JWT settings; the interceptor verifies every token against the same values. */
  readonly jwt: JwtAuthorizerConfig;
  /** Reserved concurrency of the tools Lambda (caps concurrent tool calls); undefined reserves none. */
  readonly reservedConcurrentExecutions?: number;
}

/**
 * The Lambda functions between the Gateway and the sandbox runtimes:
 *
 * - `interceptor`: the Gateway REQUEST interceptor. It verifies the caller's
 *   access token again, with the Gateway's JWT settings, and sets the verified
 *   `sub` in `CALLER_SUB_HEADER`, overwriting any client-supplied value.
 * - `toolsFunction`: the Gateway target for every environment. It maps each
 *   verified `sub` to one Runtime session per environment, forwards tool calls
 *   into the environment a call names, and answers `list_environments`. It
 *   runs in the sandbox VPC and reaches the runtimes only through
 *   `runtimeEndpoint`, the AgentCore data-plane interface endpoint, whose
 *   policy admits only this function's role and actions on these runtimes.
 *
 * `McpGateway` attaches the runtime resource policies that admit only the
 * tools function's role, and only through `runtimeEndpoint`. The interceptor
 * stays outside the VPC: it fetches the identity provider's discovery
 * document and signing keys over the internet.
 */
export class SandboxTools extends Construct {
  public readonly toolsFunction: nodejs.NodejsFunction;
  public readonly interceptor: nodejs.NodejsFunction;
  public readonly runtimeEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: SandboxToolsProps) {
    super(scope, id);

    const { projectName, runtimes } = props;
    const jwt = validateJwtAuthorizerConfig(props.jwt);
    const stack = Stack.of(this);
    const bundling: nodejs.BundlingOptions = {
      // Bundle the AWS SDK: the managed runtime's SDK may predate the AgentCore data-plane client.
      externalModules: [],
      minify: true,
      sourceMap: true,
    };

    this.interceptor = new nodejs.NodejsFunction(this, 'CallerIdentityInterceptor', {
      functionName: `${projectName}-caller-identity-interceptor`,
      description: 'AgentCore Gateway REQUEST interceptor that verifies the access token and passes on its sub',
      entry: path.join(LAMBDA_DIR, 'caller-identity-interceptor', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling,
      environment: {
        JWT_DISCOVERY_URL: jwt.discoveryUrl,
        JWT_ALLOWED_CLIENTS: JSON.stringify(jwt.allowedClients),
        JWT_ALLOWED_AUDIENCES: JSON.stringify(jwt.allowedAudiences),
        JWT_ALLOWED_SCOPES: JSON.stringify(jwt.allowedScopes),
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'CallerIdentityInterceptorLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    Tags.of(this.interceptor).add('Component', 'Gateway');

    this.toolsFunction = new nodejs.NodejsFunction(this, 'SandboxToolsFunction', {
      functionName: `${projectName}-sandbox-tools`,
      description: 'Routes each user to their own code sandbox Runtime session and forwards tool calls into it',
      entry: path.join(LAMBDA_DIR, 'sandbox-tools', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Synchronous sandbox calls run up to 600 s, plus a cold start of the user's microVM.
      timeout: Duration.minutes(15),
      // Each call can hold a slot for minutes; the cap keeps them from using up the account's Lambda concurrency.
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      bundling,
      environment: {
        RUNTIMES: stack.toJsonString(Object.fromEntries(runtimes.map((r) => [r.name, r.runtime.agentRuntimeArn]))),
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'SandboxToolsLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      vpc: props.network.vpc,
      vpcSubnets: props.network.subnets,
      securityGroups: [props.network.clientSecurityGroup],
    });
    Tags.of(this.toolsFunction).add('Component', 'SandboxTools');
    NagSuppressions.addResourceSuppressions(
      this.interceptor,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS managed policy for writing the function\'s CloudWatch Logs.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
      true,
    );
    const runtimeResources = runtimes.flatMap(({ runtime }) => [runtime.agentRuntimeArn, `${runtime.agentRuntimeArn}/*`]);
    for (const { runtime } of runtimes) {
      // Invocation is authorized on the runtime and on its endpoints.
      this.toolsFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: SANDBOX_RUNTIME_ACTIONS,
          resources: [runtime.agentRuntimeArn, `${runtime.agentRuntimeArn}/*`],
        }),
      );
    }
    // After the grants above: suppressions apply to the role's policy only once it exists.
    NagSuppressions.addResourceSuppressions(
      this.toolsFunction,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole are the AWS managed policies for writing ' +
            'the function\'s CloudWatch Logs and attaching it to the sandbox VPC.',
          appliesTo: [
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
            'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Invocation is authorized on each sandbox Runtime and on its endpoints (<runtime ARN>/*), no other Runtimes.',
          // `<Logical.AgentRuntimeArn>`, or `<stack>:ExportsOutputFnGetAtt...` when the ARN is a cross-stack import.
          appliesTo: [{ regex: '/^Resource::(<[^>]+\\.AgentRuntimeArn>|[^:]+:ExportsOutputFnGetAtt\\w+AgentRuntimeArn\\w*)\\/\\*$/g' }],
        },
      ],
      true,
    );

    // Private DNS sends the SDK's bedrock-agentcore requests from the VPC to this endpoint.
    this.runtimeEndpoint = new ec2.InterfaceVpcEndpoint(this, 'AgentCoreEndpoint', {
      vpc: props.network.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENTCORE,
      subnets: props.network.subnets,
      securityGroups: [props.network.endpointSecurityGroup],
      open: false,
      privateDnsEnabled: true,
    });
    this.runtimeEndpoint.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SandboxToolsRuntimeAccess',
        principals: [new iam.ArnPrincipal(this.toolsFunction.role!.roleArn)],
        actions: SANDBOX_RUNTIME_ACTIONS,
        resources: runtimeResources,
      }),
    );
    Tags.of(this.runtimeEndpoint).add('Component', 'SandboxTools');
    // On the function resource only: its role (a child construct) is in the endpoint policy.
    (this.toolsFunction.node.defaultChild as lambda.CfnFunction).node.addDependency(this.runtimeEndpoint);
  }
}
