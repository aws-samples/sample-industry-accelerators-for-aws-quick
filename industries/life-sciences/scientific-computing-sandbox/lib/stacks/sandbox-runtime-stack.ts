// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnOutput, Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { SANDBOX_BUILD_CONTEXT, SANDBOX_ENVIRONMENTS, SANDBOX_LAYER_IDS, SandboxEnvironment } from '../sandbox';
import { SandboxNetwork } from './network-stack';

/**
 * Platform version of every sandbox runtime. Set explicitly because AgentCore
 * is changing the create-time default from V1 to V2: without it, runtimes
 * created after that change (a new environment, a new account or Region)
 * would get V2 while existing ones stay on V1. V2 loads image files lazily,
 * which made new sessions and first imports much slower for these images.
 * `scripts/image_report.py` reads this line to apply the matching image size
 * limit.
 */
export const RUNTIME_PLATFORM_VERSION = agentcore.PlatformVersion.V1;

/** One sandbox environment's Runtime, as the Gateway stack consumes it. */
export interface SandboxRuntime {
  /** The environment ID (the `environment` tool argument). */
  readonly name: string;
  readonly runtime: agentcore.IBedrockAgentRuntime;
}

export interface SandboxRuntimeStackProps extends StackProps {
  readonly projectName: string;
  /** The isolated VPC (no internet route) whose subnets and Runtime security group the runtimes use. */
  readonly network: SandboxNetwork;
  /** Seconds a session may stay idle before the Runtime stops its microVM (60-28800). */
  readonly idleTimeoutSeconds: number;
  /** Maximum lifetime of a session's microVM in seconds (60-28800). */
  readonly maxLifetimeSeconds: number;
  /** Defaults to every entry of `SANDBOX_ENVIRONMENTS`. */
  readonly environments?: readonly SandboxEnvironment[];
}

/**
 * One Amazon Bedrock AgentCore Runtime per sandbox environment, each running
 * `containers/sandbox` built for that environment. Every Runtime session gets
 * its own microVM, which is the sandbox: the Gateway stack's tools Lambda maps
 * each user to one Runtime session per environment.
 *
 * Each image's build context leaves out the environment layers it does not
 * build on, so changing one environment changes only the images (and
 * runtimes) that contain it.
 *
 * The runtimes keep IAM (SigV4) inbound authorization; the Gateway stack
 * attaches resource policies so only the tools Lambda, calling through the
 * VPC's AgentCore endpoint, can invoke them. Code in the sandbox can read the
 * execution role's credentials from the microVM's metadata endpoint, so the
 * role is created here with only what the platform needs to run and observe
 * the container: logs and metrics in the `bedrock-agentcore` namespace, plus
 * pulling its image. It has no workload-identity, S3, Secrets Manager,
 * model, or other data-plane permissions.
 *
 * The runtimes run in VPC mode in the isolated subnets of `SandboxNetworkStack`,
 * which have no route to the internet: sandboxed code reaches only the
 * endpoints the platform needs (ECR, S3 image layers, CloudWatch Logs), and
 * DNS Firewall answers only AWS and VPC-internal names.
 */
export class SandboxRuntimeStack extends Stack {
  public readonly runtimes: SandboxRuntime[] = [];

  constructor(scope: Construct, id: string, props: SandboxRuntimeStackProps) {
    super(scope, id, props);

    const { projectName, idleTimeoutSeconds, maxLifetimeSeconds } = props;
    const environments = props.environments ?? SANDBOX_ENVIRONMENTS;
    if (environments.length === 0) {
      throw new Error('SandboxRuntimeStack needs at least one sandbox environment');
    }
    Tags.of(this).add('Project', projectName);

    for (const env of environments) {
      // Runtime names allow only letters, digits, and underscores.
      const runtimeName = `${projectName.replace(/[^A-Za-z0-9]/g, '_')}_${env.id}`;
      const image = new DockerImageAsset(this, `Image-${env.id}`, {
        directory: SANDBOX_BUILD_CONTEXT,
        platform: Platform.LINUX_ARM64,
        buildArgs: { ENVIRONMENT: env.id },
        exclude: SANDBOX_LAYER_IDS.filter((layer) => !env.lineage.includes(layer)).map((layer) => `environments/${layer}`),
      });
      const role = this.executionRole(env.id, runtimeName);
      image.repository.grantPull(role);
      const runtime = new agentcore.Runtime(this, `Runtime-${env.id}`, {
        runtimeName,
        description: `${env.title} code sandbox for AWS Quick: ${env.description}`.slice(0, 1200),
        // The Runtime construct adds its default statements (including
        // workload-identity token actions) to any role it can modify, so it
        // gets a view of the role that ignores policy changes.
        executionRole: role.withoutPolicyUpdates(),
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag),
        protocolConfiguration: agentcore.ProtocolType.MCP,
        platformVersion: RUNTIME_PLATFORM_VERSION,
        networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
          vpc: props.network.vpc,
          vpcSubnets: props.network.subnets,
          securityGroups: [props.network.runtimeSecurityGroup],
        }),
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: Duration.seconds(idleTimeoutSeconds),
          maxLifetime: Duration.seconds(maxLifetimeSeconds),
        },
      });
      // The image pull permission must exist before the runtime is created.
      runtime.node.addDependency(role);
      Tags.of(runtime).add('Component', 'Runtime');
      Tags.of(runtime).add('SandboxEnvironment', env.id);

      this.runtimes.push({ name: env.id, runtime });

      // The integration tests read these outputs to check that the runtimes refuse other callers.
      const key = env.id.charAt(0).toUpperCase() + env.id.slice(1);
      new CfnOutput(this, `${key}RuntimeArn`, {
        description: `ARN of the ${env.id} sandbox AgentCore Runtime`,
        value: runtime.agentRuntimeArn,
      });
    }
  }

  /** Execution role limited to running and observing the container; assume sandboxed code can read its credentials. */
  private executionRole(envId: string, runtimeName: string): iam.Role {
    const { account, partition, region } = Stack.of(this);
    const logGroups = `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`;
    const role = new iam.Role(this, `ExecutionRole-${envId}`, {
      description: `Execution role for the ${envId} code sandbox runtime (logs and metrics only)`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:bedrock-agentcore:${region}:${account}:runtime/${runtimeName}-*` },
        },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuntimeLogs',
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroups, `${logGroups}:log-stream:*`],
      }),
    );
    // No X-Ray statement: the server has no tracing SDK or exporter, and X-Ray
    // actions accept only Resource "*", which sandboxed code could use to
    // write traces anywhere in the account. PutMetricData has no resource-level
    // permissions, so Resource is "*" and the namespace condition limits it.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
      }),
    );
    Tags.of(role).add('Component', 'Runtime');
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken (from grantPull) and cloudwatch:PutMetricData support only Resource "*"; ' +
            'PutMetricData is limited to the bedrock-agentcore namespace.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'AgentCore Runtime creates its log group as /aws/bedrock-agentcore/runtimes/<runtime name>-<generated suffix>, ' +
            'so the policy names this Runtime and wildcards only the suffix and its log streams.',
          appliesTo: [{ regex: '/^Resource::arn:<AWS::Partition>:logs:.+:log-group:\\/aws\\/bedrock-agentcore\\/runtimes\\/\\w+-\\*(:log-stream:\\*)?$/g' }],
        },
      ],
      true,
    );
    return role;
  }
}
