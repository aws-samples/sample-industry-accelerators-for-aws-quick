# Lambda target template

A minimal accelerator to copy when you build a new one: an AgentCore Gateway
that AWS Quick connects to, with one AWS Lambda target. The example tools
convert units. Replace them with your own.

## Overview

The example target, `unit-converter`, has two tools:

| Tool in AWS Quick | What it does |
| --- | --- |
| `unit-converter___list_units` | Lists the supported length, mass and temperature units |
| `unit-converter___convert_units` | Converts a value between two units of the same quantity |

### Start a new accelerator from this template

1. Copy this folder to `industries/<industry>/<accelerator>/` (without
   `node_modules` and `cdk.out`).
2. Set a unique `projectName` in `cdk.json` (for example `ls-my-tool`) and the
   `name` in `package.json`.
3. Replace `lambda/unit-converter/`, `lib/tools/unit-converter-tools.ts` and
   their tests with your tools. Grant the function's role the AWS actions your
   tools call, in `lib/stacks/tools-stack.ts`.
4. Rewrite this README, keeping the section headings, and update `AGENTS.md`.
5. Add the accelerator to the root `README.md` and its industry's `README.md`.

See [docs/conventions.md](../../docs/conventions.md).

## Architecture

```text
AWS Quick ──(JWT from your identity provider)──▶ AgentCore Gateway ──(IAM)──▶ tools Lambda
```

| Stack | Resources |
| --- | --- |
| `<projectName>-Tools` | The tools Lambda function and its log group (30-day retention) |
| `<projectName>-Gateway` | The AgentCore Gateway (MCP, `CUSTOM_JWT` authorizer), its Lambda target and the IAM role it invokes the function with |

Source layout:

```text
bin/app.ts                         Reads context and creates the stacks
lib/config/app-config.ts           projectName validation
lib/config/jwt-authorizer.ts       jwt* context keys (identical in every accelerator)
lib/constructs/mcp-gateway.ts      Gateway, Lambda targets and Gateway role
lib/stacks/                        ToolsStack and GatewayStack
lib/tools/                         Tool schemas the Gateway publishes
lambda/unit-converter/index.ts     The tools' handler
test/unit/                         Offline tests
test/integration/                  Tests against the deployed stacks
```

## Prerequisites

- Node.js 22 or later, npm and GNU Make
- AWS credentials for the target account, bootstrapped for CDK
  (`npx cdk bootstrap`)
- A Region where Amazon Bedrock AgentCore Gateway is available
- An identity provider for AWS Quick sign-in; see
  [docs/authentication.md](../../docs/authentication.md)

## Deploy

```bash
make deploy CDK_ARGS="-c jwtDiscoveryUrl=<discovery-url> -c jwtAllowedClients=<client-id>"
```

| Context key | Default | Description |
| --- | --- | --- |
| `projectName` | `template-lambda-target` | Prefix for stack IDs and resource names. 1-36 lowercase letters, digits or single hyphens |
| `jwtDiscoveryUrl` | None (required) | Your identity provider's discovery URL |
| `jwtAllowedClients` | None | Allowed `client_id` claim values (comma-separated) |
| `jwtAllowedAudiences` | None | Allowed `aud` claim values (comma-separated) |
| `jwtAllowedScopes` | None | Scopes; the token must carry at least one |

Set `jwtAllowedClients`, `jwtAllowedAudiences`, or both. The
`<projectName>-Gateway` stack outputs `GatewayUrl`.

## Connect to AWS Quick

Create an MCP connector in AWS Quick with the `GatewayUrl` output as the MCP
server endpoint and your identity provider's OAuth settings. The
[Cognito example](../../docs/authentication.md#worked-example-amazon-cognito)
lists every field.

Example prompts:

- "How many kilometres is a half marathon of 13.1 miles?"
- "Convert 98.6 F to Celsius."

## Test

```bash
make test-unit          # type-check, CDK assertions and handler tests; no AWS needed
make test-integration   # invoke the deployed Lambda; set PROJECT_NAME if you changed it
```

To also test the Gateway, set `ACCESS_TOKEN` to an access token that your
identity provider issued to the allowed client, then run
`make test-integration`.

## Cost

- AgentCore Gateway: charged per tool call and per search request.
- Lambda: charged per request and duration (256 MB, arm64).
- CloudWatch Logs: ingestion and storage for the function's log group.

With no traffic, the deployment costs close to nothing.

## Security

- `cdk synth` and `cdk deploy` run the cdk-nag AWS Solutions
  checks and fail on any finding without a documented suppression. Each
  suppression, next to its resource in `lib/`, gives the reason. Synthesis
  writes the results to `cdk.out/AwsSolutions-*-NagReport.csv`.
- The Gateway accepts only JWTs that your identity provider signed and that
  carry an allowed client ID or audience. Synthesis fails if neither is set.
- The Gateway role can invoke only the tools function, and only this Gateway
  can assume it (`aws:SourceArn` names the Gateway).
- The tools function's role has only CloudWatch Logs permissions.
- Every user who can sign in through your identity provider and use the AWS
  Quick connector can call every tool. Restrict who can use the connector in
  your identity provider and in AWS Quick.
- The function logs the tool name and outcome of each call, not its arguments
  or results.

## Clean up

```bash
make destroy CDK_ARGS="<the same CDK_ARGS you deployed with>"
```

This removes both stacks. Delete the AWS Quick connector and any OAuth client
you created for it separately.
