// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Aws, CfnMapping, Stack, Tags, Token } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * Availability Zone IDs where AgentCore Runtime supports VPC connectivity, by
 * Region. AZ names map to different IDs in each account, so subnets are placed
 * by ID.
 *
 * @see https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html#agentcore-supported-azs
 */
export const AGENTCORE_AVAILABILITY_ZONE_IDS: Readonly<Record<string, readonly string[]>> = {
  'us-east-1': ['use1-az1', 'use1-az2', 'use1-az4'],
  'us-east-2': ['use2-az1', 'use2-az2', 'use2-az3'],
  'us-west-1': ['usw1-az1', 'usw1-az3'],
  'us-west-2': ['usw2-az1', 'usw2-az2', 'usw2-az3'],
  'ap-southeast-5': ['apse5-az1', 'apse5-az2', 'apse5-az3'],
  'ap-south-1': ['aps1-az1', 'aps1-az2', 'aps1-az3'],
  'ap-south-2': ['aps2-az1', 'aps2-az2', 'aps2-az3'],
  'ap-northeast-2': ['apne2-az1', 'apne2-az2', 'apne2-az3'],
  'ap-southeast-1': ['apse1-az1', 'apse1-az2', 'apse1-az3'],
  'ap-southeast-2': ['apse2-az1', 'apse2-az2', 'apse2-az3'],
  'ap-southeast-7': ['apse7-az1', 'apse7-az2', 'apse7-az3'],
  'ap-northeast-1': ['apne1-az1', 'apne1-az2', 'apne1-az4'],
  'ca-central-1': ['cac1-az1', 'cac1-az2', 'cac1-az4'],
  'eu-central-1': ['euc1-az1', 'euc1-az2', 'euc1-az3'],
  'eu-west-1': ['euw1-az1', 'euw1-az2', 'euw1-az3'],
  'eu-west-2': ['euw2-az1', 'euw2-az2', 'euw2-az3'],
  'eu-south-1': ['eus1-az1', 'eus1-az2', 'eus1-az3'],
  'eu-west-3': ['euw3-az1', 'euw3-az2', 'euw3-az3'],
  'eu-south-2': ['eus2-az1', 'eus2-az2', 'eus2-az3'],
  'eu-north-1': ['eun1-az1', 'eun1-az2', 'eun1-az3'],
  'sa-east-1': ['sae1-az1', 'sae1-az2', 'sae1-az3'],
  'us-gov-west-1': ['usgw1-az1', 'usgw1-az2', 'usgw1-az3'],
};

/** Subnets (one per AZ) the network spans by default. AgentCore needs at least two. */
export const DEFAULT_AZ_COUNT = 2;

/**
 * Domains the VPC resolver answers; DNS Firewall answers every other query
 * with NXDOMAIN. Only AWS controls the name servers for these zones, so a
 * lookup cannot carry data to a name server someone else runs.
 */
export const ALLOWED_DNS_DOMAINS = ['amazonaws.com', '*.amazonaws.com', '*.compute.internal', '*.ec2.internal'];

const VPC_CIDR = '10.0.0.0/22';
const SUBNET_CIDRS = ['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24'];
const NO_DEFAULT_EGRESS = 'Matches no traffic; keeps EC2 from adding an allow-all egress rule';

export interface IsolatedNetworkProps {
  readonly projectName: string;
  /**
   * AgentCore-supported AZ IDs for the subnets (2-4). Defaults to the first
   * `DEFAULT_AZ_COUNT` entries of `AGENTCORE_AVAILABILITY_ZONE_IDS` for the
   * stack's Region.
   */
  readonly availabilityZoneIds?: readonly string[];
}

/**
 * A VPC with no route out: no internet gateway, no NAT, and no default route,
 * for AgentCore Runtimes that must have no internet access (pattern 4 of
 * "Network connectivity patterns for agents deployed on Amazon Bedrock
 * AgentCore Runtime"). It has:
 *
 * - isolated subnets placed by AgentCore-supported AZ ID;
 * - the endpoints a container Runtime needs (ECR API and Docker, CloudWatch
 *   Logs, and an S3 gateway endpoint for image layers), each with a policy
 *   that admits only this account's principals or only the ECR layer bucket,
 *   so code holding another account's credentials cannot use them to send
 *   data out;
 * - a Runtime security group that may connect only to those endpoints, and a
 *   pair of security groups for a client of the AgentCore data-plane endpoint
 *   (the tools Lambda) and that endpoint, which the Gateway stack creates;
 * - Route 53 Resolver DNS Firewall, which answers only AWS and VPC-internal
 *   names, so code cannot tunnel data out through DNS lookups; and
 * - VPC Flow Logs of rejected traffic.
 *
 * AgentCore keeps a Runtime's network interfaces for up to 8 hours after the
 * Runtime is deleted, and those interfaces hold the subnets and the Runtime
 * security group. Never replace the security groups (their descriptions and
 * logical IDs are fixed for that reason).
 */
export class IsolatedNetwork extends Construct {
  public readonly vpc: ec2.IVpc;
  /** For the AgentCore Runtime network interfaces. */
  public readonly runtimeSecurityGroup: ec2.SecurityGroup;
  /** For the tools Lambda, which may connect only to the AgentCore data-plane endpoint. */
  public readonly agentCoreClientSecurityGroup: ec2.SecurityGroup;
  /** For the AgentCore data-plane interface endpoint. */
  public readonly agentCoreEndpointSecurityGroup: ec2.SecurityGroup;
  public readonly flowLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: IsolatedNetworkProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const { account, partition, region } = stack;
    const azIds = this.availabilityZoneIds(props.availabilityZoneIds);

    const cfnVpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: VPC_CIDR,
      // Private DNS of the interface endpoints needs both.
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${props.projectName}-sandbox` }],
    });
    // Subnets get a route table with only the local route (and the S3 gateway endpoint's prefix list route).
    const subnets = azIds.map((azId, i) => {
      const subnet = new ec2.Subnet(this, `IsolatedSubnet${i + 1}`, {
        vpcId: cfnVpc.ref,
        availabilityZone: azId,
        cidrBlock: SUBNET_CIDRS[i],
        mapPublicIpOnLaunch: false,
      });
      const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
      cfnSubnet.addPropertyDeletionOverride('AvailabilityZone');
      cfnSubnet.addPropertyOverride('AvailabilityZoneId', azId);
      Tags.of(subnet).add('Name', `${props.projectName}-sandbox-isolated-${i + 1}`);
      return subnet;
    });
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'VpcRef', {
      vpcId: cfnVpc.ref,
      vpcCidrBlock: VPC_CIDR,
      availabilityZones: azIds,
      isolatedSubnetIds: subnets.map((s) => s.subnetId),
      isolatedSubnetRouteTableIds: subnets.map((s) => s.routeTable.routeTableId),
      isolatedSubnetIpv4CidrBlocks: subnets.map((_, i) => SUBNET_CIDRS[i]),
    });
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    // Logs of the custom resource function that looks up the S3 prefix list and empties the default security group.
    const setupLogs = new logs.LogGroup(this, 'SetupFunctionLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.restrictDefaultSecurityGroup(cfnVpc, setupLogs);

    // ------------------------------------------------------------------------------------------------------------
    // Security groups. Never change their descriptions: that replaces the group, which fails while AgentCore or
    // Lambda network interfaces still use it.
    // ------------------------------------------------------------------------------------------------------------
    this.runtimeSecurityGroup = new ec2.SecurityGroup(this, 'RuntimeSecurityGroup', {
      vpc: this.vpc,
      description: 'Code sandbox AgentCore Runtimes: HTTPS to the VPC endpoints only',
      allowAllOutbound: false,
    });
    const serviceEndpointSecurityGroup = new ec2.SecurityGroup(this, 'ServiceEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'ECR and CloudWatch Logs interface endpoints for the code sandbox Runtimes',
      allowAllOutbound: false,
    });
    serviceEndpointSecurityGroup.connections.allowFrom(this.runtimeSecurityGroup, ec2.Port.tcp(443), 'HTTPS from the sandbox Runtimes');
    this.agentCoreClientSecurityGroup = new ec2.SecurityGroup(this, 'AgentCoreClientSecurityGroup', {
      vpc: this.vpc,
      description: 'Code sandbox tools Lambda: HTTPS to the AgentCore data-plane endpoint only',
      allowAllOutbound: false,
    });
    this.agentCoreEndpointSecurityGroup = new ec2.SecurityGroup(this, 'AgentCoreEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'AgentCore data-plane interface endpoint for the code sandbox tools Lambda',
      allowAllOutbound: false,
    });
    this.agentCoreEndpointSecurityGroup.connections.allowFrom(
      this.agentCoreClientSecurityGroup,
      ec2.Port.tcp(443),
      'HTTPS from the sandbox tools Lambda',
    );

    // ------------------------------------------------------------------------------------------------------------
    // Endpoints the Runtimes need: image pull (ECR API, ECR Docker, S3 layers) and logs.
    // ------------------------------------------------------------------------------------------------------------
    const thisAccount = { StringEquals: { 'aws:PrincipalAccount': account } };
    const s3 = new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [isolated],
    });
    // ECR keeps image layers in this AWS-owned bucket; nothing else in S3 is reachable through the endpoint.
    s3.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrImageLayers',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [`arn:${partition}:s3:::prod-${region}-starport-layer-bucket/*`],
      }),
    );
    const s3PrefixList = new cr.AwsCustomResource(this, 'S3PrefixList', {
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: { Filters: [{ Name: 'prefix-list-name', Values: [`com.amazonaws.${region}.s3`] }] },
        physicalResourceId: cr.PhysicalResourceId.of(`com.amazonaws.${region}.s3`),
        outputPaths: ['PrefixLists.0.PrefixListId'],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      installLatestAwsSdk: false,
      logGroup: setupLogs,
    });
    NagSuppressions.addResourceSuppressions(
      s3PrefixList,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ec2:DescribeManagedPrefixLists supports only Resource "*"; the call is read-only.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );
    // The Lambda function that runs every AwsCustomResource in this stack, created by CDK with the managed policy.
    NagSuppressions.addResourceSuppressionsByPath(
      Stack.of(this),
      `${Stack.of(this).node.path}/AWS${cr.AwsCustomResource.PROVIDER_FUNCTION_UUID.replace(/-/g, '')}/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'CDK creates the AwsCustomResource provider function with AWSLambdaBasicExecutionRole, the AWS managed ' +
            'policy for writing its CloudWatch Logs.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ],
    );
    this.runtimeSecurityGroup.addEgressRule(
      ec2.Peer.prefixList(s3PrefixList.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(443),
      'HTTPS to the S3 gateway endpoint (ECR image layers)',
    );

    const interfaceEndpoint = (endpointId: string, service: ec2.InterfaceVpcEndpointAwsService, statements: iam.PolicyStatement[]) => {
      const endpoint = new ec2.InterfaceVpcEndpoint(this, endpointId, {
        vpc: this.vpc,
        service,
        subnets: isolated,
        securityGroups: [serviceEndpointSecurityGroup],
        // Otherwise CDK admits the whole VPC CIDR.
        open: false,
        privateDnsEnabled: true,
      });
      statements.forEach((statement) => endpoint.addToPolicy(statement));
      return endpoint;
    };
    const ecrStatements = () => [
      new iam.PolicyStatement({
        sid: 'EcrAuthorizationToken',
        principals: [new iam.AnyPrincipal()],
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
        conditions: thisAccount,
      }),
      new iam.PolicyStatement({
        sid: 'EcrPullThisAccount',
        principals: [new iam.AnyPrincipal()],
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [`arn:${partition}:ecr:${region}:${account}:repository/*`],
        conditions: thisAccount,
      }),
    ];
    interfaceEndpoint('EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR, ecrStatements());
    interfaceEndpoint('EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER, ecrStatements());
    interfaceEndpoint('LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS, [
      new iam.PolicyStatement({
        sid: 'RuntimeLogsThisAccount',
        principals: [new iam.AnyPrincipal()],
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
        resources: [`arn:${partition}:logs:${region}:${account}:log-group:*`],
        conditions: thisAccount,
      }),
    ]);

    // ------------------------------------------------------------------------------------------------------------
    // DNS Firewall: the VPC resolver is not subject to security groups, and would otherwise resolve any public name.
    // ------------------------------------------------------------------------------------------------------------
    const allowedDomains = new route53resolver.CfnFirewallDomainList(this, 'AllowedDomains', {
      name: `${props.projectName}-sandbox-allowed`,
      domains: ALLOWED_DNS_DOMAINS,
    });
    const allDomains = new route53resolver.CfnFirewallDomainList(this, 'AllDomains', {
      name: `${props.projectName}-sandbox-all`,
      domains: ['*'],
    });
    const ruleGroup = new route53resolver.CfnFirewallRuleGroup(this, 'DnsFirewallRules', {
      name: `${props.projectName}-sandbox-dns`,
      firewallRules: [
        { firewallDomainListId: allowedDomains.attrId, priority: 100, action: 'ALLOW' },
        { firewallDomainListId: allDomains.attrId, priority: 200, action: 'BLOCK', blockResponse: 'NXDOMAIN' },
      ],
    });
    new route53resolver.CfnFirewallRuleGroupAssociation(this, 'DnsFirewallAssociation', {
      name: `${props.projectName}-sandbox-dns`,
      firewallRuleGroupId: ruleGroup.attrId,
      vpcId: cfnVpc.ref,
      priority: 101,
      mutationProtection: 'DISABLED',
    });

    // ------------------------------------------------------------------------------------------------------------
    // Flow logs of rejected traffic: connection attempts the security groups refused.
    // ------------------------------------------------------------------------------------------------------------
    this.flowLogGroup = new logs.LogGroup(this, 'RejectedFlowLogs', { retention: logs.RetentionDays.ONE_MONTH });
    new ec2.FlowLog(this, 'RejectedFlows', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      trafficType: ec2.FlowLogTrafficType.REJECT,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(this.flowLogGroup),
    });

    Tags.of(this).add('Component', 'Network');

    // Rules to other groups and to the prefix list are separate resources, and CDK then drops its inline
    // match-nothing rule. A group with no inline egress rule gets EC2's default allow-all egress, so keep one.
    for (const group of [this.runtimeSecurityGroup, this.agentCoreClientSecurityGroup]) {
      group.addEgressRule(ec2.Peer.ipv4('255.255.255.255/32'), ec2.Port.icmpTypeAndCode(252, 86), NO_DEFAULT_EGRESS);
    }
  }

  /** The configured AZ IDs, or the Region's AgentCore-supported ones (from a template mapping when the Region is a token). */
  private availabilityZoneIds(configured?: readonly string[]): string[] {
    const region = Stack.of(this).region;
    if (configured !== undefined) {
      if (configured.length < 2 || configured.length > SUBNET_CIDRS.length || new Set(configured).size !== configured.length) {
        throw new Error(`availabilityZoneIds must name 2-${SUBNET_CIDRS.length} different AZ IDs, got ${configured.join(', ')}`);
      }
      const supported = Token.isUnresolved(region) ? undefined : AGENTCORE_AVAILABILITY_ZONE_IDS[region];
      const unsupported = supported ? configured.filter((id) => !supported.includes(id)) : [];
      if (unsupported.length > 0) {
        throw new Error(`AgentCore Runtime does not support VPC subnets in ${unsupported.join(', ')} (${region})`);
      }
      return [...configured];
    }
    if (!Token.isUnresolved(region)) {
      const supported = AGENTCORE_AVAILABILITY_ZONE_IDS[region];
      if (!supported) {
        throw new Error(`No AgentCore-supported AZ IDs are known for ${region}; set the availabilityZoneIds context key`);
      }
      return supported.slice(0, DEFAULT_AZ_COUNT);
    }
    const mapping = new CfnMapping(this, 'AgentCoreAzIds', {
      mapping: Object.fromEntries(
        Object.entries(AGENTCORE_AVAILABILITY_ZONE_IDS).map(([r, ids]) => [
          r,
          Object.fromEntries(ids.slice(0, DEFAULT_AZ_COUNT).map((azId, i) => [`az${i + 1}`, azId])),
        ]),
      ),
    });
    return Array.from({ length: DEFAULT_AZ_COUNT }, (_, i) => mapping.findInMap(Aws.REGION, `az${i + 1}`));
  }

  /** Removes the default security group's rules, so nothing attached to it can reach anything. */
  private restrictDefaultSecurityGroup(cfnVpc: ec2.CfnVPC, logGroup: logs.ILogGroup): void {
    const { account, partition, region } = Stack.of(this);
    const groupId = cfnVpc.attrDefaultSecurityGroup;
    const groupArn = `arn:${partition}:ec2:${region}:${account}:security-group/${groupId}`;
    const revoke = (resourceId: string, action: string, ipPermissions: unknown[]) =>
      new cr.AwsCustomResource(this, resourceId, {
        onCreate: {
          service: 'EC2',
          action,
          parameters: { GroupId: groupId, IpPermissions: ipPermissions },
          physicalResourceId: cr.PhysicalResourceId.of(`${groupId}-${action}`),
          ignoreErrorCodesMatching: 'InvalidPermission.NotFound',
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [groupArn] }),
        installLatestAwsSdk: false,
        logGroup,
      });
    revoke('RestrictDefaultSgIngress', 'revokeSecurityGroupIngress', [
      { IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: groupId }] },
    ]);
    revoke('RestrictDefaultSgEgress', 'revokeSecurityGroupEgress', [
      { IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ]);
  }
}
