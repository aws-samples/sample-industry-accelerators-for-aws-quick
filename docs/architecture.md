# Architecture

Every accelerator in this repository is an AWS CDK app that deploys a remote
MCP server for AWS Quick. They share the base architecture described here and
differ in their targets.

```text
                    ┌──────────────────────────┐
AWS Quick ─────────▶│ Your identity provider   │  OAuth 2.0 authorization code + PKCE
    │               └──────────────────────────┘
    │ MCP over HTTPS, Authorization: Bearer <JWT access token>
    ▼
┌───────────────────────────────────────────────────────────────┐
│ <projectName>-Gateway stack                                    │
│                                                               │
│  Amazon Bedrock AgentCore Gateway (MCP, CUSTOM_JWT authorizer) │
│     │  optional REQUEST interceptor (Lambda)                   │
│     ├──(Gateway IAM role)──▶ Lambda target ──▶ AWS services    │
│     └──(Gateway IAM role, SigV4)──▶ AgentCore Runtime          │
│                                   (MCP server in a container)  │
└───────────────────────────────────────────────────────────────┘
```

## Components

**AgentCore Gateway.** The Gateway is the MCP endpoint that AWS Quick connects
to. Its URL ends in `/mcp` and is the `GatewayUrl` output of the
`<projectName>-Gateway` stack. The Gateway lists the tools of all its targets
and names each one `<targetName>___<toolName>`.

**Inbound authentication.** The Gateway uses the AgentCore `CUSTOM_JWT`
authorizer. It fetches signing keys from your identity provider's OIDC
discovery document and checks every request's access token (signature,
expiry, and the allowed clients, audiences and scopes you configure). See
[authentication.md](authentication.md).

**Gateway IAM role.** Each Gateway has its own IAM role. The role can invoke
only that accelerator's targets. The trust policy is limited to AgentCore in
the deploying account.

**Targets.** An accelerator uses one or both target types:

| Target type | When to use it | Examples |
| --- | --- | --- |
| Lambda | Short request-response tools. The tool schema is declared in CDK and must match the handler. | Template, Scientific Computing Sandbox |
| MCP server on AgentCore Runtime | An existing MCP server, tools that return MCP Apps (`ui://` resources), or long-lived per-user state | Bio viewers, Scientific Computing Sandbox environments |

A Runtime used as a target uses IAM inbound authentication. Its resource
policy allows only the Gateway role (or the Lambda that brokers calls to it),
so other principals in the account cannot call it around the Gateway.

**REQUEST interceptor (optional).** Lambda targets do not receive the caller's
token claims. When a tool needs to know who the caller is, for example to give
each user their own sandbox, a Gateway REQUEST interceptor verifies the token
again and passes the verified `sub` claim to the target in a header. The Scientific Computing
Sandbox uses this pattern.

## Design rules

- **One Gateway per accelerator.** Each accelerator deploys its own Gateway,
  so customers can connect and share accelerators in AWS Quick separately.
- **Fail closed.** Synthesis fails when the authorizer would accept any token
  from the issuer. Invalid input to a tool returns an error, never a partial
  result.
- **Least privilege.** Grant each role only the actions and resources its code
  calls. Prefer resource policies that admit a single principal.
- **No secrets in code, context or outputs.** The accelerators never create
  or store client secrets. Customers enter OAuth client details directly in
  AWS Quick.
- **Unique names.** Every resource name starts with `projectName`, so several
  accelerators, or several copies of one, can share an account and Region.
- **Small outputs.** The Gateway stack outputs `GatewayUrl`, the value entered
  in AWS Quick. Other stacks output only what integration tests need.

## AWS Quick constraints

These AWS Quick limits shape the tool design. See the
[AWS Quick MCP integration guide](https://docs.aws.amazon.com/quicksuite/latest/userguide/mcp-integration.html).

- MCP operations time out after 5 minutes.
- A connection registers at most 100 tools.
- Tool `inputSchema` must be valid JSON Schema Draft 7 or later.
- Custom HTTP headers are not supported, so per-user context must come from
  the access token.
- Custom connectors do not pick up tool changes automatically. Choose **Sync**
  on the connector after you change tools.
