// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_IDLE_TIMEOUT_SECONDS, DEFAULT_MAX_LIFETIME_SECONDS } from '../../lib/config/app-config';
import { JwtAuthorizerConfig } from '../../lib/config/jwt-authorizer';
import { CALLER_SUB_HEADER } from '../../lib/identity';
import { SANDBOX_ENVIRONMENTS, SANDBOX_LAYER_IDS, SandboxEnvironment } from '../../lib/sandbox';
import { GatewayStack, SandboxNetworkStack, SandboxRuntimeStack } from '../../lib/stacks';
import { ALLOWED_DNS_DOMAINS } from '../../lib/constructs';
import { SANDBOX_TARGET_NAME, SERVER_TOOLS, gatewayTools } from '../../lib/tools';

const JWT: JwtAuthorizerConfig = {
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  allowedClients: ['client-a'],
  allowedAudiences: [],
  allowedScopes: ['openid'],
};

interface SynthOptions {
  jwt?: JwtAuthorizerConfig;
  environments?: readonly SandboxEnvironment[];
  projectName?: string;
  availabilityZoneIds?: string[];
  toolsReservedConcurrency?: number;
}

const ENV = { account: '123456789012', region: 'us-west-2' };

function synth(options: SynthOptions = {}) {
  const app = new App();
  const projectName = options.projectName ?? 'test-app';
  const env = ENV;
  const sandboxNetwork = new SandboxNetworkStack(app, `${projectName}-Network`, {
    env,
    projectName,
    availabilityZoneIds: options.availabilityZoneIds,
  });
  const sandboxRuntime = new SandboxRuntimeStack(app, `${projectName}-Runtime`, {
    env,
    projectName,
    network: sandboxNetwork.network,
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    maxLifetimeSeconds: DEFAULT_MAX_LIFETIME_SECONDS,
    environments: options.environments,
  });
  const gateway = new GatewayStack(app, `${projectName}-Gateway`, {
    env,
    projectName,
    jwt: options.jwt ?? JWT,
    runtimes: sandboxRuntime.runtimes,
    network: sandboxNetwork.network,
    toolsReservedConcurrency: options.toolsReservedConcurrency,
  });
  return {
    app,
    sandboxNetwork,
    sandboxRuntime,
    gatewayStack: gateway,
    network: Template.fromStack(sandboxNetwork),
    runtime: Template.fromStack(sandboxRuntime),
    gateway: Template.fromStack(gateway),
  };
}

const CHEM = SANDBOX_ENVIRONMENTS.find((e) => e.id === 'chem')!;
const VCF = SANDBOX_ENVIRONMENTS.find((e) => e.id === 'vcf')!;
const ENVIRONMENT_IDS = SANDBOX_ENVIRONMENTS.map((e) => e.id);
const GATEWAY_TOOLS = gatewayTools(SERVER_TOOLS, ENVIRONMENT_IDS);

type Resource = { Type: string; Properties: Record<string, any> };

/** Logical IDs of the security groups, by construct ID. */
function securityGroupIds(network: Template): Record<string, string> {
  return Object.fromEntries(
    Object.keys(network.findResources('AWS::EC2::SecurityGroup')).map((id) => [id.replace(/^Network|[0-9A-F]{8}$/g, ''), id]),
  );
}

describe('SandboxNetworkStack', () => {
  test('has no route out of the VPC', () => {
    const { network, runtime, gateway } = synth();
    for (const template of [network, runtime, gateway]) {
      for (const type of [
        'AWS::EC2::InternetGateway',
        'AWS::EC2::EgressOnlyInternetGateway',
        'AWS::EC2::NatGateway',
        'AWS::EC2::EIP',
        'AWS::EC2::VPNGateway',
        'AWS::EC2::TransitGatewayAttachment',
        'AWS::EC2::VPCPeeringConnection',
        'AWS::EC2::Route',
        'AWS::NetworkFirewall::Firewall',
      ]) {
        template.resourceCountIs(type, 0);
      }
    }
    network.resourceCountIs('AWS::EC2::VPC', 1);
    network.hasResourceProperties('AWS::EC2::VPC', { EnableDnsSupport: true, EnableDnsHostnames: true });
  });

  test('places two isolated subnets by AgentCore-supported AZ ID', () => {
    const { network } = synth();
    const subnets = Object.values(network.findResources('AWS::EC2::Subnet')) as Resource[];
    expect(subnets.map((s) => s.Properties.AvailabilityZoneId)).toEqual(['usw2-az1', 'usw2-az2']);
    for (const subnet of subnets) {
      expect(subnet.Properties.AvailabilityZone).toBeUndefined();
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
    }
    network.resourceCountIs('AWS::EC2::RouteTable', 2);
  });

  test('accepts supported AZ IDs from context and rejects others', () => {
    const { network } = synth({ availabilityZoneIds: ['usw2-az2', 'usw2-az3'] });
    const subnets = Object.values(network.findResources('AWS::EC2::Subnet')) as Resource[];
    expect(subnets.map((s) => s.Properties.AvailabilityZoneId)).toEqual(['usw2-az2', 'usw2-az3']);
    expect(() => synth({ availabilityZoneIds: ['usw2-az4', 'usw2-az1'] })).toThrow(/does not support VPC subnets in usw2-az4/);
    expect(() => synth({ availabilityZoneIds: ['usw2-az1'] })).toThrow(/must name 2-4 different AZ IDs/);
  });

  test('looks AZ IDs up by Region in the template when the Region is not known at synthesis', () => {
    const app = new App();
    const stack = new SandboxNetworkStack(app, 'N', { projectName: 'test-app' });
    const template = Template.fromStack(stack);
    expect(template.toJSON().Mappings).toBeDefined();
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet')) as Resource[];
    expect(JSON.stringify(subnets.map((s) => s.Properties.AvailabilityZoneId))).toContain('Fn::FindInMap');
    expect(() => new SandboxNetworkStack(new App(), 'N', { env: { region: 'mars-north-1' }, projectName: 'test-app' })).toThrow(
      /No AgentCore-supported AZ IDs are known for mars-north-1/,
    );
  });

  test('opens only the endpoints a container Runtime needs, each limited to this account or to ECR image layers', () => {
    const { network } = synth();
    const endpoints = Object.values(network.findResources('AWS::EC2::VPCEndpoint')) as Resource[];
    const services = endpoints.map((e) => JSON.stringify(e.Properties.ServiceName));
    expect(endpoints).toHaveLength(4);
    for (const service of ['.ecr.api', '.ecr.dkr', '.logs', '.s3']) {
      expect(services.filter((s) => s.includes(`${service}"`) || s.endsWith(`${service}"]]}`))).toHaveLength(1);
    }
    const s3 = endpoints.find((e) => e.Properties.VpcEndpointType === 'Gateway')!.Properties;
    expect(s3.PolicyDocument.Statement).toHaveLength(1);
    expect(s3.PolicyDocument.Statement[0]).toMatchObject({ Effect: 'Allow', Principal: { AWS: '*' }, Action: 's3:GetObject' });
    expect(JSON.stringify(s3.PolicyDocument.Statement[0].Resource)).toContain(':s3:::prod-us-west-2-starport-layer-bucket/*');
    expect(s3.RouteTableIds).toHaveLength(2);
    for (const endpoint of endpoints.filter((e) => e.Properties.VpcEndpointType === 'Interface')) {
      expect(endpoint.Properties.PrivateDnsEnabled).toBe(true);
      for (const statement of endpoint.Properties.PolicyDocument.Statement) {
        expect(statement.Effect).toBe('Allow');
        expect(statement.Condition).toEqual({ StringEquals: { 'aws:PrincipalAccount': '123456789012' } });
        expect(JSON.stringify(statement.Action)).not.toContain('*');
      }
    }
  });

  test('lets the Runtimes connect only to the endpoints, and the tools Lambda only to the AgentCore endpoint', () => {
    const { network } = synth();
    const ids = securityGroupIds(network);
    // Fixed logical IDs and descriptions: replacing a group fails while AgentCore or Lambda interfaces use it.
    expect(Object.keys(ids).sort()).toEqual(
      ['AgentCoreClientSecurityGroup', 'AgentCoreEndpointSecurityGroup', 'RuntimeSecurityGroup', 'ServiceEndpointSecurityGroup'].sort(),
    );
    const groups = network.findResources('AWS::EC2::SecurityGroup') as Record<string, Resource>;
    expect(groups[ids.RuntimeSecurityGroup].Properties.GroupDescription).toBe(
      'Code sandbox AgentCore Runtimes: HTTPS to the VPC endpoints only',
    );
    expect(groups[ids.AgentCoreClientSecurityGroup].Properties.GroupDescription).toBe(
      'Code sandbox tools Lambda: HTTPS to the AgentCore data-plane endpoint only',
    );
    // No group accepts or sends traffic to an address range other than the CDK's match-nothing placeholder.
    const rules = [
      ...Object.values(groups).flatMap((g) => [...(g.Properties.SecurityGroupIngress ?? []), ...(g.Properties.SecurityGroupEgress ?? [])]),
      ...Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties),
      ...Object.values(network.findResources('AWS::EC2::SecurityGroupEgress')).map((r) => r.Properties),
    ];
    for (const rule of rules) {
      if (rule.CidrIp !== undefined) expect(rule.CidrIp).toBe('255.255.255.255/32');
      expect(rule.CidrIpv6).toBeUndefined();
    }
    // A group without an inline egress rule would get EC2's default allow-all egress.
    for (const group of Object.values(groups)) {
      expect(group.Properties.SecurityGroupEgress).toContainEqual(
        expect.objectContaining({ CidrIp: '255.255.255.255/32', IpProtocol: 'icmp', FromPort: 252, ToPort: 86 }),
      );
    }
    const runtimeEgress = [
      ...(groups[ids.RuntimeSecurityGroup].Properties.SecurityGroupEgress ?? []).filter(
        (r: Record<string, unknown>) => r.CidrIp !== '255.255.255.255/32',
      ),
      ...Object.values(network.findResources('AWS::EC2::SecurityGroupEgress'))
        .map((r) => r.Properties)
        .filter((p) => JSON.stringify(p.GroupId).includes(ids.RuntimeSecurityGroup)),
    ];
    expect(runtimeEgress).toHaveLength(2);
    for (const rule of runtimeEgress) expect([rule.IpProtocol, rule.FromPort, rule.ToPort]).toEqual(['tcp', 443, 443]);
    expect(runtimeEgress.some((r) => r.DestinationPrefixListId !== undefined)).toBe(true);
    expect(runtimeEgress.some((r) => JSON.stringify(r.DestinationSecurityGroupId).includes(ids.ServiceEndpointSecurityGroup))).toBe(true);
    expect(groups[ids.RuntimeSecurityGroup].Properties.SecurityGroupIngress).toBeUndefined();
    const ingress = Object.values(network.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
    expect(ingress.map((r) => [JSON.stringify(r.GroupId).includes(ids.AgentCoreEndpointSecurityGroup), JSON.stringify(r.SourceSecurityGroupId).includes(ids.AgentCoreClientSecurityGroup)])).toContainEqual([true, true]);
    expect(ingress.every((r) => r.SourceSecurityGroupId !== undefined && r.FromPort === 443)).toBe(true);
    // The default security group loses its rules.
    network.resourceCountIs('Custom::AWS', 3);
  });

  test('answers only AWS and VPC-internal names in DNS', () => {
    const { network } = synth();
    network.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', { Domains: ALLOWED_DNS_DOMAINS });
    network.hasResourceProperties('AWS::Route53Resolver::FirewallDomainList', { Domains: ['*'] });
    expect(ALLOWED_DNS_DOMAINS.every((d) => /(^|\.)amazonaws\.com$|\.internal$/.test(d))).toBe(true);
    const [group] = Object.values(network.findResources('AWS::Route53Resolver::FirewallRuleGroup')) as Resource[];
    expect(group.Properties.FirewallRules.map((r: Record<string, unknown>) => [r.Priority, r.Action, r.BlockResponse])).toEqual([
      [100, 'ALLOW', undefined],
      [200, 'BLOCK', 'NXDOMAIN'],
    ]);
    network.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroupAssociation', {
      VpcId: { Ref: Match.stringLikeRegexp('NetworkVpc') },
      MutationProtection: 'DISABLED',
    });
  });

  test('logs rejected traffic with a retention period', () => {
    const { network } = synth();
    network.hasResourceProperties('AWS::EC2::FlowLog', { ResourceType: 'VPC', TrafficType: 'REJECT', LogDestinationType: 'cloud-watch-logs' });
    for (const group of Object.values(network.findResources('AWS::Logs::LogGroup'))) {
      expect(group.Properties.RetentionInDays).toBe(30);
    }
  });

  test('has no outputs of its own, only the cross-stack exports the other stacks import', () => {
    const { network } = synth();
    expect(Object.keys(network.toJSON().Outputs ?? {}).every((key) => key.startsWith('ExportsOutput'))).toBe(true);
  });

  test('is a dependency of both other stacks', () => {
    const { sandboxNetwork, sandboxRuntime, gatewayStack } = synth();
    expect(sandboxRuntime.dependencies).toEqual(expect.arrayContaining([sandboxNetwork]));
    expect(gatewayStack.dependencies).toEqual(expect.arrayContaining([sandboxNetwork]));
  });
});

describe('SandboxRuntimeStack', () => {
  test('hosts each environment as an IAM-authorized MCP server with lifecycle limits', () => {
    const { runtime } = synth();
    runtime.resourceCountIs('AWS::BedrockAgentCore::Runtime', SANDBOX_ENVIRONMENTS.length);
    runtime.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'test_app_chem',
      ProtocolConfiguration: 'MCP',
      NetworkConfiguration: {
        NetworkMode: 'VPC',
        NetworkModeConfig: {
          Subnets: [Match.anyValue(), Match.anyValue()],
          SecurityGroups: [{ 'Fn::ImportValue': Match.stringLikeRegexp('RuntimeSecurityGroup') }],
        },
      },
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: Match.anyValue() } },
      LifecycleConfiguration: {
        IdleRuntimeSessionTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
        MaxLifetime: DEFAULT_MAX_LIFETIME_SECONDS,
      },
    });
    // No JWT authorizer: the runtime accepts only SigV4 calls from the gateway role.
    expect(JSON.stringify(runtime.toJSON())).not.toContain('CustomJWTAuthorizer');
    runtime.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('pins every runtime to platform version V1 instead of the changing service default', () => {
    const { runtime } = synth();
    const versions = Object.values(runtime.findResources('AWS::BedrockAgentCore::Runtime')).map(
      (r) => r.Properties.PlatformVersion,
    );
    expect(versions).toEqual(SANDBOX_ENVIRONMENTS.map(() => 'V1'));
  });

  test('outputs only the runtime ARNs the integration tests use', () => {
    const { runtime } = synth();
    // ExportsOutput* are the cross-stack references the Gateway stack imports.
    const outputs = Object.entries(runtime.toJSON().Outputs ?? {}).filter(([key]) => !key.startsWith('ExportsOutput'));
    expect(outputs.map(([key]) => key).sort()).toEqual(
      ENVIRONMENT_IDS.map((id) => `${id.charAt(0).toUpperCase()}${id.slice(1)}RuntimeArn`).sort(),
    );
    for (const [, output] of outputs as [string, { Export?: unknown }][]) expect(output.Export).toBeUndefined();
  });

  test('limits the execution role, whose credentials sandboxed code can read, to image pull and observability', () => {
    const { runtime } = synth();
    const policies = JSON.stringify(runtime.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('ecr:BatchGetImage');
    expect(policies).toContain('logs:PutLogEvents');
    expect(policies).not.toMatch(/"s3:|secretsmanager:|bedrock:|bedrock-agentcore:|kms:|sts:|iam:|"\*:\*"/);
    const actions = Object.values(runtime.findResources('AWS::IAM::Policy')).flatMap((p) =>
      p.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat()),
    );
    expect(actions.every((a: string) => /^(ecr|logs|cloudwatch):/.test(a))).toBe(true);
    runtime.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'Metrics',
            Condition: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
          }),
        ]),
      },
    });
  });

  test('builds each environment image with its ENVIRONMENT build argument and only its own layers', () => {
    const { app, sandboxRuntime } = synth();
    const assembly = app.synth();
    const manifest = assembly.artifacts.find(
      (a) => a.id === `${sandboxRuntime.artifactId}.assets`,
    ) as unknown as { file: string };
    const images = Object.values(JSON.parse(readFileSync(manifest.file, 'utf8')).dockerImages ?? {}) as {
      source: { directory: string; dockerBuildArgs?: Record<string, string>; platform?: string };
    }[];
    expect(images.map((i) => i.source.dockerBuildArgs?.ENVIRONMENT).sort()).toEqual([...ENVIRONMENT_IDS].sort());
    expect(images.every((i) => i.source.platform === 'linux/arm64')).toBe(true);
    expect(sandboxRuntime.runtimes.map((r) => r.name)).toEqual(ENVIRONMENT_IDS);
    // A change to one environment must not change the images that do not contain it.
    for (const image of images) {
      const env = SANDBOX_ENVIRONMENTS.find((e) => e.id === image.source.dockerBuildArgs?.ENVIRONMENT)!;
      const staged = path.join(assembly.directory, image.source.directory);
      for (const layer of SANDBOX_LAYER_IDS) {
        const present = existsSync(path.join(staged, 'environments', layer, 'requirements.txt'));
        expect([env.id, layer, present]).toEqual([env.id, layer, env.lineage.includes(layer)]);
      }
      expect(existsSync(path.join(staged, 'Dockerfile'))).toBe(true);
    }
    // sctraj builds on the shared single-cell layer.
    expect(SANDBOX_ENVIRONMENTS.find((e) => e.id === 'sctraj')!.lineage).toEqual(['general', 'scbase', 'sctraj']);
  });

  test('keeps every runtime name within the 48-character limit for the longest project name', () => {
    const { runtime } = synth({ projectName: 'a'.repeat(36) });
    const names = Object.values(runtime.findResources('AWS::BedrockAgentCore::Runtime')).map(
      (r) => r.Properties.AgentRuntimeName as string,
    );
    expect(names).toHaveLength(SANDBOX_ENVIRONMENTS.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
  });

  test('describes each runtime with its environment', () => {
    const { runtime } = synth();
    runtime.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'test_app_chem',
      Description: Match.stringLikeRegexp('^Cheminformatics code sandbox .*RDKit'),
    });
  });

  test('gateway tools carry honest annotations, and the skill covers every tool and environment', () => {
    const tools = Object.fromEntries(GATEWAY_TOOLS.map((tool) => [tool.name, tool]));
    expect(Object.keys(tools).sort()).toEqual(
      [
        'cancel_job',
        'execute_code',
        'get_job',
        'get_sandbox_info',
        'list_environments',
        'list_files',
        'read_file',
        'reset_sandbox',
        'write_file',
      ].sort(),
    );
    for (const tool of GATEWAY_TOOLS) {
      expect(tool.description).not.toHaveLength(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    for (const name of ['list_environments', 'get_sandbox_info', 'get_job', 'read_file', 'list_files']) {
      expect(tools[name].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of ['execute_code', 'write_file', 'cancel_job', 'reset_sandbox']) {
      expect(tools[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tools.execute_code.annotations).toMatchObject({ openWorldHint: true });
    // The server's descriptions do not depend on the environment; the environment argument names them all.
    expect(tools.execute_code.description).not.toContain('RDKit');
    const environmentArg = (tools.execute_code.inputSchema.properties as Record<string, { description: string }>).environment;
    for (const id of ENVIRONMENT_IDS) expect(environmentArg.description).toContain(`${id} (`);
    expect(environmentArg.description).toContain('rdkit, mmpdb');
    expect(environmentArg.description).not.toContain('scbase');

    // The optional agent skill names the tools as the Gateway exposes them, and every environment.
    const skill = readFileSync(path.join(__dirname, '..', '..', 'skills', 'scientific-computing-sandbox', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: scientific-computing-sandbox\n/);
    for (const name of Object.keys(tools)) expect(skill).toContain(`${SANDBOX_TARGET_NAME}___${name}`);
    for (const id of ENVIRONMENT_IDS) expect(skill).toContain(`\`${id}\``);
  });

  test('creates one runtime and resource policy per environment behind a single target', () => {
    const { runtime, gateway } = synth({ environments: [CHEM, VCF] });
    runtime.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
    gateway.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    gateway.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 2);
    const [target] = Object.values(gateway.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const tools = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload;
    const description = tools.find((t: { Name: string }) => t.Name === 'execute_code').InputSchema.Properties.environment
      .Description;
    expect(description).toContain('chem (');
    expect(description).toContain('vcf (');
    expect(description).not.toContain('sctraj (');
  });
});

describe('GatewayStack', () => {
  test('validates JWTs from the configured identity provider and creates no identity resources', () => {
    const { gateway } = synth();
    gateway.resourceCountIs('AWS::Cognito::UserPool', 0);
    gateway.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
    gateway.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: 'test-app-gateway',
      ProtocolType: 'MCP',
      AuthorizerType: 'CUSTOM_JWT',
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: JWT.discoveryUrl,
          AllowedClients: ['client-a'],
          AllowedScopes: ['openid'],
          AllowedAudience: Match.absent(),
        },
      },
    });
  });

  test('passes allowed audiences to the authorizer', () => {
    const { gateway } = synth({ jwt: { ...JWT, allowedClients: [], allowedAudiences: ['api://sandbox'], allowedScopes: [] } });
    gateway.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: JWT.discoveryUrl,
          AllowedAudience: ['api://sandbox'],
          AllowedClients: Match.absent(),
          AllowedScopes: Match.absent(),
        },
      },
    });
  });

  test('refuses an authorizer with neither clients nor audiences', () => {
    expect(() => synth({ jwt: { ...JWT, allowedClients: [] } })).toThrow(/Set jwtAllowedClients, jwtAllowedAudiences/);
  });

  test('depends on the runtime stack', () => {
    const { sandboxRuntime, gatewayStack } = synth();
    expect(gatewayStack.dependencies).toEqual(expect.arrayContaining([sandboxRuntime]));
  });

  test('verifies callers with a REQUEST interceptor that receives the request headers', () => {
    const { gateway } = synth();
    gateway.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      InterceptorConfigurations: [
        {
          InterceptionPoints: ['REQUEST'],
          Interceptor: { Lambda: { Arn: Match.anyValue() } },
          InputConfiguration: { PassRequestHeaders: true },
        },
      ],
    });
    // Quick re-initializes on every call, so Gateway sessions would not keep a sandbox.
    expect(JSON.stringify(gateway.toJSON())).not.toContain('SessionConfiguration');
  });

  test('gives the interceptor the same JWT settings as the Gateway authorizer', () => {
    const jwt = { ...JWT, allowedAudiences: ['api://sandbox'], allowedScopes: ['openid', 'sandbox/invoke'] };
    const { gateway } = synth({ jwt });
    gateway.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-app-caller-identity-interceptor',
      Environment: {
        Variables: Match.objectLike({
          JWT_DISCOVERY_URL: jwt.discoveryUrl,
          JWT_ALLOWED_CLIENTS: '["client-a"]',
          JWT_ALLOWED_AUDIENCES: '["api://sandbox"]',
          JWT_ALLOWED_SCOPES: '["openid","sandbox/invoke"]',
        }),
      },
    });
  });

  test('targets the sandbox tools Lambda once for every environment with the caller header and an inline schema', () => {
    const { gateway } = synth();
    gateway.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    const [target] = Object.values(gateway.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    expect(target.Properties).toMatchObject({
      Name: SANDBOX_TARGET_NAME,
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      MetadataConfiguration: { AllowedRequestHeaders: [CALLER_SUB_HEADER] },
    });
    const tools = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload;
    expect(tools.map((t: { Name: string }) => t.Name).sort()).toEqual(GATEWAY_TOOLS.map((t) => t.name).sort());
    // Only the schema keywords a Lambda target accepts.
    const keys = new Set<string>();
    const walk = (node: Record<string, unknown>) => {
      Object.keys(node).forEach((k) => keys.add(k));
      Object.values((node.Properties as Record<string, Record<string, unknown>>) ?? {}).forEach(walk);
      if (node.Items) walk(node.Items as Record<string, unknown>);
    };
    tools.forEach((t: { InputSchema: Record<string, unknown> }) => walk(t.InputSchema));
    expect([...keys].every((k) => ['Type', 'Description', 'Properties', 'Required', 'Items'].includes(k))).toBe(true);
    const execute = tools.find((t: { Name: string }) => t.Name === 'execute_code');
    expect(execute.InputSchema.Required).toEqual(['environment', 'code']);
    expect(execute.InputSchema.Properties.cwd.Type).toBe('string');
    expect(execute.InputSchema.Properties.environment.Type).toBe('string');
    for (const tool of tools) {
      expect([tool.Name, tool.InputSchema.Required.includes('environment')]).toEqual([
        tool.Name,
        tool.Name !== 'list_environments',
      ]);
    }
  });

  test('gives the tools Lambda the runtime ARN of every environment', () => {
    const { gateway } = synth();
    const [fn] = Object.values(gateway.findResources('AWS::Lambda::Function')).filter(
      (f) => f.Properties.Environment?.Variables?.RUNTIMES,
    );
    const runtimes = JSON.stringify(fn.Properties.Environment.Variables.RUNTIMES);
    for (const id of ENVIRONMENT_IDS) expect(runtimes).toContain(`\\"${id}\\":`);
  });

  test('lets the gateway role invoke only the interceptor and the tools Lambda', () => {
    const { gateway } = synth();
    const role = Object.entries(gateway.findResources('AWS::IAM::Role')).find(([, r]) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('bedrock-agentcore.amazonaws.com'),
    )!;
    const policies = Object.values(gateway.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(role[0]),
    );
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(statements.flatMap((st: { Action: string | string[] }) => [st.Action].flat()).every((a: string) => a === 'lambda:InvokeFunction')).toBe(true);
    expect(JSON.stringify(statements)).not.toContain('bedrock-agentcore:');
  });

  test('lets only this gateway assume the gateway role', () => {
    const { gateway } = synth();
    const role = Object.values(gateway.findResources('AWS::IAM::Role')).find((r) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('bedrock-agentcore.amazonaws.com'),
    )!;
    const [statement] = role.Properties.AssumeRolePolicyDocument.Statement;
    const sourceArn = JSON.stringify(statement.Condition.ArnLike['aws:SourceArn']);
    expect(sourceArn).toContain(':gateway/test-app-gateway-*');
    expect(statement.Condition.StringEquals['aws:SourceAccount']).toBeDefined();
  });

  test('lets the tools Lambda invoke and stop only the sandbox runtimes', () => {
    const { gateway } = synth();
    const statements = Object.values(gateway.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
    );
    const runtimeStatements = statements.filter((st) => JSON.stringify(st.Action).includes('bedrock-agentcore:'));
    expect(runtimeStatements.length).toBeGreaterThan(0);
    for (const st of runtimeStatements) {
      expect([st.Action].flat().sort()).toEqual(['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession']);
      expect(JSON.stringify(st.Resource)).not.toBe('"*"');
    }
  });

  test('restricts runtime invocation to the tools Lambda role with a resource policy', () => {
    const { gateway } = synth();
    // Stable logical IDs: a new ID for a runtime's single resource policy would create a second policy for the
    // same runtime and then delete the old one, leaving the runtime without a policy.
    const policyIds = Object.keys(gateway.findResources('AWS::BedrockAgentCore::ResourcePolicy'));
    expect(policyIds).toHaveLength(SANDBOX_ENVIRONMENTS.length);
    for (const id of ENVIRONMENT_IDS) {
      expect(policyIds).toContainEqual(expect.stringMatching(new RegExp(`^McpGatewayRuntimeResourcePolicy${id}[0-9A-F]{8}$`)));
    }
    expect(Object.keys(gateway.findResources('AWS::BedrockAgentCore::GatewayTarget'))).toEqual([
      expect.stringMatching(/^McpGatewayTargetsandbox[0-9A-F]{8}$/),
    ]);
    const [policy] = Object.values(gateway.findResources('AWS::BedrockAgentCore::ResourcePolicy'));
    const document = JSON.stringify(policy.Properties.Policy);
    expect(document).toContain('AllowSandboxToolsRole');
    expect(document).toContain('DenyAllOtherPrincipals');
    expect(document).toContain('aws:PrincipalArn');
    expect(document).toContain('StringNotEquals');
    expect(document).toContain('bedrock-agentcore:StopRuntimeSession');
    expect(document).toMatch(/SandboxToolsFunctionServiceRole/);
    // Only through the sandbox VPC's AgentCore endpoint.
    const statements = JSON.parse(JSON.stringify(policy.Properties.Policy['Fn::Join'][1]))
      .map((p: unknown) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join('');
    expect(statements).toContain('"Sid":"DenyOutsideSandboxVpcEndpoint"');
    expect(statements).toMatch(/"StringNotEquals":\{"aws:SourceVpce":"\{"Ref":"SandboxToolsAgentCoreEndpoint[0-9A-F]{8}"\}/);
  });

  test('caps concurrent tool calls with the tools Lambda\'s reserved concurrency when configured', () => {
    const toolsFunction = (gateway: Template) =>
      (Object.values(gateway.findResources('AWS::Lambda::Function')) as Resource[]).find(
        (f) => f.Properties.Environment?.Variables?.RUNTIMES,
      )!;
    expect(toolsFunction(synth({ toolsReservedConcurrency: 50 }).gateway).Properties.ReservedConcurrentExecutions).toBe(50);
    expect(toolsFunction(synth().gateway).Properties).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  test('runs the tools Lambda in the isolated subnets, reaching AgentCore through an endpoint only it may use', () => {
    const { gateway } = synth();
    const functions = Object.values(gateway.findResources('AWS::Lambda::Function')) as Resource[];
    const tools = functions.find((f) => f.Properties.Environment?.Variables?.RUNTIMES)!;
    expect(tools.Properties.VpcConfig).toEqual({
      SubnetIds: [expect.anything(), expect.anything()],
      SecurityGroupIds: [{ 'Fn::ImportValue': expect.stringMatching(/AgentCoreClientSecurityGroup/) }],
    });
    // The interceptor fetches the identity provider's discovery document and signing keys, so it stays outside the VPC.
    const interceptor = functions.find((f) => f.Properties.Environment?.Variables?.JWT_DISCOVERY_URL)!;
    expect(interceptor.Properties.VpcConfig).toBeUndefined();

    const [endpoint] = Object.values(gateway.findResources('AWS::EC2::VPCEndpoint')) as Resource[];
    gateway.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    expect(endpoint.Properties).toMatchObject({
      ServiceName: 'com.amazonaws.us-west-2.bedrock-agentcore',
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
      SecurityGroupIds: [{ 'Fn::ImportValue': expect.stringMatching(/AgentCoreEndpointSecurityGroup/) }],
    });
    const [statement, ...rest] = endpoint.Properties.PolicyDocument.Statement;
    expect(rest).toHaveLength(0);
    expect(statement).toMatchObject({
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/SandboxToolsFunctionServiceRole/), 'Arn'] } },
      Action: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
    });
    expect(JSON.stringify(statement.Resource)).not.toContain('"*"');
  });

  test('outputs only the Gateway URL', () => {
    const { gateway } = synth();
    const outputs = gateway.toJSON().Outputs ?? {};
    expect(Object.keys(outputs)).toEqual(['GatewayUrl']);
    expect(outputs.GatewayUrl.Value).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^McpGateway[0-9A-F]{8}$/), 'GatewayUrl'] });
    expect(outputs.GatewayUrl.Export).toBeUndefined();
    expect(JSON.stringify(gateway.toJSON())).not.toMatch(/client.?secret/i);
  });
});
