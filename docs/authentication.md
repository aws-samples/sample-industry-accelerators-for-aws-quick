# Authentication: bring your own identity provider

The accelerators don't create users or OAuth clients. Each Gateway trusts JWT
access tokens from an identity provider (IdP) that you already run, or that
you create for this purpose. AWS Quick signs each user in to that IdP, gets an
access token, and sends it to the Gateway with every MCP request.

This page covers:

1. [What the identity provider must support](#identity-provider-requirements)
2. [The CDK context keys every accelerator accepts](#configure-the-gateway)
3. [A worked example with Amazon Cognito](#worked-example-amazon-cognito)
4. [Notes for other identity providers](#other-identity-providers)

## Identity provider requirements

The IdP must:

- Publish an OIDC discovery document (`.../.well-known/openid-configuration`)
  or OAuth authorization server metadata
  (`.../.well-known/oauth-authorization-server`) over the public internet.
- Support the OAuth 2.0 authorization code flow with PKCE (S256). AWS Quick can
  act as a public client (no secret) or a confidential client.
- Allow AWS Quick's redirect URL,
  `https://<quick-region>.quicksight.aws.amazon.com/sn/oauthcallback`.
- Accept the `resource` parameter (RFC 8707) that AWS Quick sends. Its value is
  the Gateway URL.
- Issue access tokens as signed JWTs (not opaque tokens) with a `sub` claim,
  plus a `client_id` claim, an `aud` claim, or both, that the Gateway can check.

## Configure the Gateway

Every accelerator reads these CDK context keys. Pass them with
`make deploy CDK_ARGS="-c key=value ..."` or add them to the `context` block of
the accelerator's `cdk.json`.

| Context key | Required | Value |
| --- | --- | --- |
| `jwtDiscoveryUrl` | Yes | The IdP's discovery URL, ending in `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server` |
| `jwtAllowedClients` | One of these two | Comma-separated OAuth client IDs, checked against the token's `client_id` claim |
| `jwtAllowedAudiences` | One of these two | Comma-separated audiences, checked against the token's `aud` claim |
| `jwtAllowedScopes` | No | Comma-separated scopes; the token must carry at least one |

The Gateway checks every value you set. Synthesis fails if `jwtDiscoveryUrl` is
missing or if neither `jwtAllowedClients` nor `jwtAllowedAudiences` is set,
because a Gateway that checks only the issuer would accept a token issued to
any application of that IdP.

Pass the same keys to `make destroy` and `cdk diff`, or keep them in
`cdk.json`.

## Worked example: Amazon Cognito

This example creates a Cognito user pool for AWS Quick, deploys an accelerator
that trusts it, and connects the accelerator to AWS Quick. One user pool and
app client can serve every accelerator you deploy.

Set these shell variables first. Use the Region where you deploy the
accelerators, and the Region of your AWS Quick account.

```bash
REGION=us-east-1
QUICK_REGION=us-east-1
DOMAIN_PREFIX=quick-accelerators-<unique-suffix>
```

### 1. Create the user pool and domain

Create a pool where only administrators can create users:

```bash
POOL_ID=$(aws cognito-idp create-user-pool \
  --region "$REGION" \
  --pool-name quick-accelerators \
  --username-attributes email \
  --auto-verified-attributes email \
  --admin-create-user-config AllowAdminCreateUserOnly=true \
  --query UserPool.Id --output text)
```

Add a domain for the sign-in pages:

```bash
aws cognito-idp create-user-pool-domain \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --domain "$DOMAIN_PREFIX"
```

### 2. Create the app client for AWS Quick

Create a public client (no secret) that uses the authorization code flow and
redirects to AWS Quick:

```bash
CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --client-name aws-quick \
  --no-generate-secret \
  --allowed-o-auth-flows-user-pool-client \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid \
  --supported-identity-providers COGNITO \
  --callback-urls "https://${QUICK_REGION}.quicksight.aws.amazon.com/sn/oauthcallback" \
  --query UserPoolClient.ClientId --output text)
```

### 3. Deploy the accelerator

Cognito access tokens carry the app client ID in `client_id` and have no `aud`
claim, so allow the client and the `openid` scope:

```bash
DISCOVERY="https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}/.well-known/openid-configuration"
```

```bash
make deploy CDK_ARGS="-c jwtDiscoveryUrl=${DISCOVERY} -c jwtAllowedClients=${CLIENT_ID} -c jwtAllowedScopes=openid"
```

Read the Gateway URL from the stack output. Replace `<projectName>` with the
accelerator's project name (its `cdk.json` default, or the value you passed):

```bash
GATEWAY_URL=$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name <projectName>-Gateway \
  --query "Stacks[0].Outputs[?OutputKey=='GatewayUrl'].OutputValue" \
  --output text)
```

### 4. Register the Gateway as a resource server

AWS Quick sends the Gateway URL as the OAuth `resource` parameter. Cognito
rejects the token request unless a resource server with that exact identifier
exists. Create one per Gateway:

```bash
aws cognito-idp create-resource-server \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --identifier "$GATEWAY_URL" \
  --name <projectName>-gateway \
  --scopes ScopeName=invoke,ScopeDescription="Invoke the Gateway"
```

### 5. Create a user

Cognito emails the user a temporary password, which they change at first
sign-in:

```bash
aws cognito-idp admin-create-user \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

### 6. Create the AWS Quick connector

In AWS Quick, choose **Connectors**, then **Create for your team**, then
**Model Context Protocol (MCP)**. Enter:

| AWS Quick field | Value |
| --- | --- |
| MCP server endpoint | `$GATEWAY_URL` |
| Authentication method | User authentication (OAuth) |
| Public OAuth client | Selected |
| Client ID | `$CLIENT_ID` |
| Client secret | Leave empty |
| Authorization URL | `https://<DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/authorize` |
| Token URL | `https://<DOMAIN_PREFIX>.auth.<REGION>.amazoncognito.com/oauth2/token` |
| Redirect URL | `https://<QUICK_REGION>.quicksight.aws.amazon.com/sn/oauthcallback` |
| OAuth resource (if shown) | `$GATEWAY_URL` |

Sign in as the user you created, review the discovered actions, and share the
connector with its users.

### Remove the example

Delete the accelerator first (`make destroy` with the same `CDK_ARGS`), then
the resource server and, when no accelerator uses it, the user pool:

```bash
aws cognito-idp delete-resource-server --region "$REGION" --user-pool-id "$POOL_ID" --identifier "$GATEWAY_URL"
```

```bash
aws cognito-idp delete-user-pool-domain --region "$REGION" --user-pool-id "$POOL_ID" --domain "$DOMAIN_PREFIX"
```

```bash
aws cognito-idp delete-user-pool --region "$REGION" --user-pool-id "$POOL_ID"
```

## Other identity providers

Work out which claims your IdP puts in its access tokens, then set the context
keys to match. Decode a test token (for example with `jwt.io` or a local
script) and check `iss`, `aud`, `client_id` and `scp` or `scope`.

- **Okta.** Use a custom authorization server. Its discovery URL is
  `https://<org>.okta.com/oauth2/<server-id>/.well-known/openid-configuration`.
  Access tokens carry `aud` (the authorization server's audience) and `cid`
  (not `client_id`), so set `jwtAllowedAudiences`.
- **Microsoft Entra ID.** Create separate app registrations for the AWS Quick
  client and for the Gateway resource, and set `accessTokenAcceptedVersion` to
  `2`. See the Entra ID notes in the
  [AWS Quick MCP integration guide](https://docs.aws.amazon.com/quicksuite/latest/userguide/mcp-integration.html#mcp-integration-troubleshooting-entra).
  Access tokens carry `aud` (the resource app's client ID) and `azp`, so set
  `jwtAllowedAudiences`.

The Gateway reads `client_id` only for `jwtAllowedClients`. If your IdP puts
the client ID in another claim, use `jwtAllowedAudiences` instead.

## What the Gateway checks

The AgentCore `CUSTOM_JWT` authorizer validates the token signature against
the IdP's published keys, the issuer and expiry, and every allowed-value list
you configured. See
[Configure inbound JWT authorizer](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html).

Accelerators with per-user state, such as the Scientific Computing Sandbox, verify the token a
second time in a Gateway REQUEST interceptor with the same settings. They use
the verified `sub` claim as the user's identity.
