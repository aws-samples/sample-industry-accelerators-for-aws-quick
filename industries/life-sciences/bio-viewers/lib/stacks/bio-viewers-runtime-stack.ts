// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface BioViewersRuntimeStackProps extends StackProps {
  readonly projectName: string;
}

/**
 * The bio-viewers MCP server (`containers/bio-viewers`) on Amazon Bedrock
 * AgentCore Runtime: MCP Apps viewers for protein 3D structures (Mol*),
 * sequence alignments and DICOM images. The Runtime keeps the default IAM
 * (SigV4) inbound authorization, and the Gateway stack attaches a resource
 * policy so only the Gateway role can invoke it. The server calls the public
 * RCSB PDB API, so the Runtime uses public network mode.
 */
export class BioViewersRuntimeStack extends Stack {
  public readonly runtime: agentcore.Runtime;
  /** Runtime invocation URL used as the Gateway MCP server target endpoint. */
  public readonly mcpEndpoint: string;

  constructor(scope: Construct, id: string, props: BioViewersRuntimeStackProps) {
    super(scope, id, props);

    const { projectName } = props;
    const { account, partition, region, urlSuffix } = Stack.of(this);
    Tags.of(this).add('Project', projectName);

    // Runtime names allow only letters, digits and underscores.
    const runtimeName = `${projectName.replace(/[^A-Za-z0-9]/g, '_')}_bio_viewers`;
    const image = new DockerImageAsset(this, 'Image', {
      directory: path.join(__dirname, '..', '..', 'containers', 'bio-viewers'),
      platform: Platform.LINUX_ARM64,
    });
    const role = this.executionRole(runtimeName);
    image.repository.grantPull(role);
    this.runtime = new agentcore.Runtime(this, 'BioViewersRuntime', {
      runtimeName,
      description: 'Protein structure, sequence alignment and DICOM MCP Apps viewers behind an AgentCore Gateway',
      // The Runtime construct adds its default statements (X-Ray and workload-identity token actions, which this
      // server doesn't use) to any role it can modify, so it gets a view of the role that ignores policy changes.
      executionRole: role.withoutPolicyUpdates(),
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(image.repository, image.imageTag),
      protocolConfiguration: agentcore.ProtocolType.MCP,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
    });
    // The image pull permission must exist before the runtime is created.
    this.runtime.node.addDependency(role);
    Tags.of(this.runtime).add('Component', 'Runtime');

    // The Gateway calls the Runtime's DEFAULT endpoint with the Runtime ARN
    // URL-encoded into the path. The ARN parts are known here, so the encoded
    // form is assembled directly instead of encoding a deploy-time token.
    const encodedArn = `arn%3A${partition}%3Abedrock-agentcore%3A${region}%3A${account}%3Aruntime%2F${this.runtime.agentRuntimeId}`;
    this.mcpEndpoint = `https://bedrock-agentcore.${region}.${urlSuffix}/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;

    // Read by the integration tests.
    new CfnOutput(this, 'RuntimeArn', {
      description: 'ARN of the bio-viewers AgentCore Runtime',
      value: this.runtime.agentRuntimeArn,
    });
  }

  /** Execution role limited to pulling the image and writing the Runtime's logs and metrics. */
  private executionRole(runtimeName: string): iam.Role {
    const { account, partition, region } = Stack.of(this);
    const logGroups = `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`;
    const role = new iam.Role(this, 'ExecutionRole', {
      description: 'Execution role for the bio-viewers runtime (image pull, logs and metrics only)',
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
    // PutMetricData has no resource-level permissions, so Resource is "*" and the namespace condition limits it.
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
