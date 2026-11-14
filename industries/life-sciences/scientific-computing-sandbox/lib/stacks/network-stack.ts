// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { IsolatedNetwork } from '../constructs';

/** The network the sandbox Runtimes and the tools Lambda use, as the other stacks consume it. */
export interface SandboxNetwork {
  readonly vpc: ec2.IVpc;
  /** Isolated subnets: no internet gateway, NAT, or default route. */
  readonly subnets: ec2.SubnetSelection;
  readonly runtimeSecurityGroup: ec2.ISecurityGroup;
  readonly agentCoreClientSecurityGroup: ec2.ISecurityGroup;
  readonly agentCoreEndpointSecurityGroup: ec2.ISecurityGroup;
}

export interface SandboxNetworkStackProps extends StackProps {
  readonly projectName: string;
  /** AgentCore-supported AZ IDs for the subnets; defaults to two for the Region. */
  readonly availabilityZoneIds?: readonly string[];
}

/**
 * The isolated VPC for the sandbox Runtimes (see `IsolatedNetwork`). It is a
 * stack of its own because AgentCore keeps a deleted Runtime's network
 * interfaces for up to 8 hours: deleting the Runtime stack does not wait for
 * them, and deleting this stack may need a retry once they are gone.
 */
export class SandboxNetworkStack extends Stack {
  public readonly network: SandboxNetwork;

  constructor(scope: Construct, id: string, props: SandboxNetworkStackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', props.projectName);

    const isolated = new IsolatedNetwork(this, 'Network', {
      projectName: props.projectName,
      availabilityZoneIds: props.availabilityZoneIds,
    });
    this.network = {
      vpc: isolated.vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      runtimeSecurityGroup: isolated.runtimeSecurityGroup,
      agentCoreClientSecurityGroup: isolated.agentCoreClientSecurityGroup,
      agentCoreEndpointSecurityGroup: isolated.agentCoreEndpointSecurityGroup,
    };
  }
}
