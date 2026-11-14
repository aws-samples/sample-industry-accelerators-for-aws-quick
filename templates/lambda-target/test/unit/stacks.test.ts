// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JwtAuthorizerConfig } from '../../lib/config/jwt-authorizer';
import { GatewayStack, ToolsStack } from '../../lib/stacks';
import { TARGET_NAME, TOOLS } from '../../lib/tools';

const env = { account: '123456789012', region: 'us-east-1' };
const JWT: JwtAuthorizerConfig = {
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  allowedClients: ['client-a'],
  allowedAudiences: [],
  allowedScopes: ['openid'],
};

function synth(jwt: JwtAuthorizerConfig = JWT) {
  const app = new App();
  const tools = new ToolsStack(app, 'test-app-Tools', { env, projectName: 'test-app' });
  const gateway = new GatewayStack(app, 'test-app-Gateway', {
    env,
    projectName: 'test-app',
    jwt,
    toolsFunction: tools.toolsFunction,
  });
  return { tools: Template.fromStack(tools), gateway: Template.fromStack(gateway) };
}

describe('GatewayStack', () => {
  const { gateway } = synth();

  test('validates JWTs from the configured identity provider', () => {
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

  test('refuses an authorizer with neither clients nor audiences', () => {
    expect(() => synth({ ...JWT, allowedClients: [] })).toThrow(/Set jwtAllowedClients, jwtAllowedAudiences/);
  });

  test('declares every tool on one Lambda target', () => {
    gateway.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: TARGET_NAME,
      TargetConfiguration: {
        Mcp: {
          Lambda: {
            ToolSchema: {
              InlinePayload: TOOLS.map((tool) =>
                Match.objectLike({ Name: tool.name, InputSchema: Match.objectLike({ Type: 'object' }) }),
              ),
            },
          },
        },
      },
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
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

  test('outputs only the Gateway URL', () => {
    expect(Object.keys(gateway.toJSON().Outputs)).toEqual(['GatewayUrl']);
  });
});

describe('ToolsStack', () => {
  const { tools } = synth();

  test('creates the tools function with a log group', () => {
    tools.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-app-tools',
      Architectures: ['arm64'],
    });
    tools.resourceCountIs('AWS::Logs::LogGroup', 1);
  });
});
