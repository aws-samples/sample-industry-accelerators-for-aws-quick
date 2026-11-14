# Agent and contributor guide

This repository holds independent AWS CDK apps ("accelerators") that each
deploy a remote MCP server for AWS Quick. Customers deploy them into their own
AWS accounts. Read this file before changing anything, then read the
accelerator's own `AGENTS.md` for its functionality.

## Layout

```text
industries/<industry>/<accelerator>/   One self-contained CDK app each
templates/lambda-target/               Starter that new accelerators copy
docs/architecture.md                   Shared base architecture
docs/authentication.md                 Bring-your-own JWT identity provider
docs/conventions.md                    Required files, Makefile targets, README sections
```

## Rules

- **Keep accelerators self-contained.** Never import code across accelerator
  folders or from the template. Shared constructs are copied. When you fix a
  bug in a copied construct (`McpGateway`, `lib/config/jwt-authorizer.ts`), fix
  it in the template and in every accelerator that has the same code.
- **Follow [docs/conventions.md](docs/conventions.md)**: Makefile targets,
  README sections, `projectName` and stack naming, license headers.
- **Authentication is bring-your-own JWT.** Gateways use the `CUSTOM_JWT`
  authorizer, configured only from the `jwt*` context keys. Do not create
  Cognito pools, OAuth clients or other identity resources in an accelerator,
  and do not hardcode an issuer, client ID or audience.
- **Fail closed.** Keep the synth-time checks that reject an authorizer with
  neither allowed clients nor allowed audiences.
- **Never commit secrets, account IDs, internal hostnames or personal data.**
  Use `<placeholders>` in documentation. Test fixtures use reserved names
  (`example.com`, `.invalid`) and the account ID `123456789012`.
- **Least privilege.** Scope IAM actions and resources to what the code calls.
  Explain any wildcard in a comment and in its cdk-nag suppression reason
  (see "Security checks" in [docs/conventions.md](docs/conventions.md)).
- **Keep tool schemas and handlers in sync.** For Lambda targets, the CDK tool
  definition and the handler must list the same tools and arguments; a unit
  test should check this.
- **Customers read the READMEs.** Update the README in the same change as the
  behavior it describes. Write for someone who has not seen the code.
- **npm `overrides`.** Each `package.json` overrides `glob` and `minimatch` to
  versions without known CVEs, for copies that jest pulls in. Remove an
  override once jest itself depends on a fixed version. The `minimatch` that
  `aws-cdk-lib` bundles can't be overridden; it changes only when you upgrade
  `aws-cdk-lib`.
- **Container images.** Pin the base image by digest in a single
  `FROM ... AS python-base` stage that the other stages build on, and keep the
  `HEALTHCHECK` for local runs.

## Verifying a change

Run in the accelerator's folder:

```bash
make test-unit
npx cdk synth -c jwtDiscoveryUrl=https://example.com/.well-known/openid-configuration -c jwtAllowedClients=test
```

`make test-unit` needs no AWS credentials. From the repository root,
`make test-unit` runs it for every accelerator. Before a security scan, run
`make synth` from the root so each app's `cdk.out` has current cdk-nag
reports.

Do not run `make deploy`, `make destroy`, `cdk deploy`, `cdk destroy` or
`make test-integration` without explicit approval for the target account and
Region. Those commands change or call real AWS resources.

## Adding an accelerator

1. Copy `templates/lambda-target/` to `industries/<industry>/<accelerator>/`.
2. Set a unique `projectName` in `cdk.json` and the `name` in `package.json`.
3. Replace the example tool, handler and tests with your own.
4. Write the README with the sections in `docs/conventions.md`.
5. Add the accelerator to the table in the root `README.md` and in its
   industry's `README.md`.
