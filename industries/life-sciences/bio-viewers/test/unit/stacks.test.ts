// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JwtAuthorizerConfig } from '../../lib/config/jwt-authorizer';
import { BioViewersRuntimeStack, GatewayStack } from '../../lib/stacks';
import { BIO_VIEWERS_TOOLS, TARGET_NAME } from '../../lib/tools';

const env = { account: '123456789012', region: 'us-west-2' };
const JWT: JwtAuthorizerConfig = {
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  allowedClients: ['client-a'],
  allowedAudiences: ['api://bio-viewers'],
  allowedScopes: ['openid'],
};

function synth(jwt: JwtAuthorizerConfig = JWT) {
  const app = new App();
  const runtimeStack = new BioViewersRuntimeStack(app, 'test-app-Runtime', { env, projectName: 'test-app' });
  const gatewayStack = new GatewayStack(app, 'test-app-Gateway', {
    env,
    projectName: 'test-app',
    jwt,
    targetRuntime: runtimeStack.runtime,
    targetEndpoint: runtimeStack.mcpEndpoint,
  });
  return {
    runtimeStack,
    gatewayStack,
    runtime: Template.fromStack(runtimeStack),
    gateway: Template.fromStack(gatewayStack),
  };
}

describe('BioViewersRuntimeStack', () => {
  const { runtime } = synth();

  test('hosts the viewers as an IAM-authorized MCP server on AgentCore Runtime', () => {
    runtime.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'test_app_bio_viewers',
      ProtocolConfiguration: 'MCP',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: Match.anyValue() } },
    });
    // No JWT authorizer on the Runtime: it accepts only SigV4 calls from the Gateway role.
    expect(JSON.stringify(runtime.toJSON())).not.toContain('CustomJWTAuthorizer');
  });

  test('outputs only the Runtime ARN, besides the exports the Gateway stack imports', () => {
    const outputs = Object.keys(runtime.toJSON().Outputs).filter((key) => !key.startsWith('ExportsOutput'));
    expect(outputs).toEqual(['RuntimeArn']);
  });

  test('gives the Runtime an execution role limited to image pull, logs and metrics', () => {
    const actions = Object.values(runtime.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((s: { Action: string | string[] }) => [s.Action].flat()),
    );
    expect(new Set(actions.map((a: string) => a.split(':')[0]))).toEqual(new Set(['ecr', 'logs', 'cloudwatch']));
    runtime.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Condition: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
          }),
        ]),
      },
    });
  });
});

describe('tool snapshot', () => {
  test('lists the three viewers as read-only tools', () => {
    expect(BIO_VIEWERS_TOOLS.map((tool) => tool.name)).toEqual(['show_structure', 'show_alignment', 'show_dicom']);
    for (const tool of BIO_VIEWERS_TOOLS) {
      expect(tool.description).not.toHaveLength(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      // AWS Quick classifies tools as read-only from these hints.
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});

describe('GatewayStack', () => {
  const { gateway, gatewayStack, runtimeStack } = synth();

  test('validates JWTs from the configured identity provider', () => {
    gateway.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      Name: 'test-app-gateway',
      ProtocolType: 'MCP',
      AuthorizerType: 'CUSTOM_JWT',
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: JWT.discoveryUrl,
          AllowedClients: ['client-a'],
          AllowedAudience: ['api://bio-viewers'],
          AllowedScopes: ['openid'],
        },
      },
    });
  });

  test('leaves unset allow-lists out of the authorizer', () => {
    const { gateway: clientsOnly } = synth({ ...JWT, allowedAudiences: [], allowedScopes: [] });
    clientsOnly.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: JWT.discoveryUrl,
          AllowedClients: ['client-a'],
          AllowedAudience: Match.absent(),
          AllowedScopes: Match.absent(),
        },
      },
    });
  });

  test('refuses an authorizer with neither clients nor audiences', () => {
    expect(() => synth({ ...JWT, allowedClients: [], allowedAudiences: [] })).toThrow(
      /Set jwtAllowedClients, jwtAllowedAudiences/,
    );
  });

  test('creates no identity resources', () => {
    gateway.resourceCountIs('AWS::Cognito::UserPool', 0);
    gateway.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });

  test('depends on the Runtime stack', () => {
    expect(gatewayStack.dependencies).toEqual(expect.arrayContaining([runtimeStack]));
  });

  test('targets the Runtime as an MCP server with SigV4 Gateway credentials', () => {
    gateway.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: TARGET_NAME,
      TargetConfiguration: { Mcp: { McpServer: { Endpoint: Match.anyValue() } } },
      CredentialProviderConfigurations: [
        {
          CredentialProviderType: 'GATEWAY_IAM_ROLE',
          CredentialProvider: { IamCredentialProvider: { Service: 'bedrock-agentcore', Region: 'us-west-2' } },
        },
      ],
    });
  });

  test('builds the target endpoint from the URL-encoded Runtime ARN', () => {
    const [target] = Object.values(gateway.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const endpoint = JSON.stringify(target.Properties.TargetConfiguration.Mcp.McpServer.Endpoint);
    expect(endpoint).toContain('https://bedrock-agentcore.us-west-2.');
    expect(endpoint).toContain('/runtimes/arn%3A');
    expect(endpoint).toContain('%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2F');
    expect(endpoint).toContain('/invocations?qualifier=DEFAULT');
  });

  test('lets only this Gateway assume the Gateway role', () => {
    gateway.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'test-app-gateway-role',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': env.account },
              ArnLike: {
                'aws:SourceArn': {
                  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:bedrock-agentcore:${env.region}:${env.account}:gateway/test-app-gateway-*`]],
                },
              },
            },
          }),
        ],
      },
    });
  });

  test('grants the Gateway role invoke on its Runtime only', () => {
    const policies = JSON.stringify(gateway.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('bedrock-agentcore:InvokeAgentRuntime');
    expect(policies).not.toMatch(/"Resource":"\*"/);
  });

  test('restricts Runtime invocation to the Gateway role with a resource policy', () => {
    gateway.resourceCountIs('AWS::BedrockAgentCore::ResourcePolicy', 1);
    const [policy] = Object.values(gateway.findResources('AWS::BedrockAgentCore::ResourcePolicy'));
    const document = JSON.stringify(policy.Properties.Policy);
    expect(document).toContain('AllowGatewayRole');
    expect(document).toContain('DenyAllOtherPrincipals');
    expect(document).toContain('aws:PrincipalArn');
    expect(document).toContain('StringNotEquals');
    // The Gateway lists the server's tools only after the policy admits it.
    const [target] = Object.values(gateway.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    expect(target.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/RuntimeResourcePolicy/)]));
  });

  test('outputs only the Gateway URL', () => {
    expect(Object.keys(gateway.toJSON().Outputs)).toEqual(['GatewayUrl']);
  });
});
