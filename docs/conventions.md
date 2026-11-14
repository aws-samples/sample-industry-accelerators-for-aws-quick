# Accelerator conventions

Every accelerator follows these conventions, so customers can deploy and test
any of them the same way. The [Lambda target template](../templates/lambda-target/)
already follows them.

## What makes a good accelerator

An accelerator fits this repository when it gives AWS Quick users something
useful in chat, in one of these ways:

- **Conversation.** A user asks a question and gets an answer, a table, a
  chart or a next step.
- **Visual output.** A tool returns an MCP App (a `ui://` resource) that AWS
  Quick displays inline, such as a protein structure or an image viewer.

It should also work for many teams without tailoring to one organization's
data, and show a pattern that customers can reuse for their own tools.

Work that no one sees in AWS Quick belongs elsewhere. Fully automated,
event-driven workflows fit AWS Step Functions and Amazon EventBridge, and
coding agents fit developer tools. Those solutions can still feed data to an
accelerator.

## Location and naming

- Each accelerator lives in `industries/<industry>/<accelerator>/`. Folder names
  are lowercase and hyphenated, for example
  `industries/life-sciences/scientific-computing-sandbox`.
- Add an industry folder (with a `README.md` that lists its accelerators) only
  when its first accelerator is added.
- The default `projectName` in `cdk.json` is unique across the repository and
  starts with a short industry prefix, for example `ls-scientific-computing-sandbox`.
- Stack IDs are `<projectName>-<Component>`, for example
  `ls-scientific-computing-sandbox-Gateway`. Every accelerator has a `<projectName>-Gateway`
  stack with a `GatewayUrl` output.

## Self-contained apps

- An accelerator is a standalone CDK app (TypeScript) with its own
  `package.json`, `package-lock.json`, `cdk.json` and tests. It does not import
  code from outside its folder.
- Shared building blocks, such as the Gateway construct and the JWT
  configuration, are copied into each accelerator from the template. Changes to
  a copy that other accelerators would need belong in the template too.
- Python code (Lambda handlers, MCP servers) is managed with `uv` and has a
  `uv.lock`.

## Required files

| File | Purpose |
| --- | --- |
| `README.md` | Customer documentation, with the sections listed below |
| `AGENTS.md` | Notes for coding agents and contributors about this accelerator's functionality and design. Repository-wide rules live in the root [AGENTS.md](../AGENTS.md) |
| `Makefile` | The targets listed below |
| `cdk.json` | Default `projectName` and other defaults |
| `test/unit/` | Tests that need no AWS account |
| `test/integration/` | Tests against deployed stacks |

## Makefile targets

| Target | What it does | Needs AWS |
| --- | --- | --- |
| `deploy` | `cdk deploy --all` | Yes |
| `destroy` | `cdk destroy --all` | Yes |
| `test` | `test-unit`, then `test-integration` | Yes |
| `test-unit` | Type-check, CDK assertion tests and handler or server unit tests | No |
| `test-integration` | Tests against the deployed stacks | Yes |

- Every target that runs CDK passes `$(CDK_ARGS)` through, for example
  `make deploy CDK_ARGS="--profile dev -c projectName=my-copy"`.
- `test-unit` must pass offline (after dependencies are installed) and without
  AWS credentials or a container engine, because CI runs it.
- Integration tests read stack outputs from CloudFormation using the
  `PROJECT_NAME` environment variable (default: the `cdk.json` value). Tests
  that call the Gateway run only when `ACCESS_TOKEN` holds a valid access
  token from your identity provider, and are skipped otherwise.
- Accelerators can add targets, such as `test-container`, and document them in
  the Makefile header.

## README sections

Use these sections in this order. Leave none out; write "None" where a
section does not apply.

1. **Overview**: what the accelerator adds to AWS Quick, and its tools
2. **Architecture**: a diagram and the stacks it deploys
3. **Prerequisites**: tools, quotas and AWS Regions
4. **Deploy**: the commands, and every context key with its default
5. **Connect to AWS Quick**: connector setup and a few example prompts
6. **Test**: unit and integration test commands
7. **Cost**: the main billable resources and what drives their cost
8. **Security**: what the accelerator can access, what it isolates, and what
   customers must review
9. **Clean up**: `make destroy` and anything it leaves behind

## Security checks (cdk-nag)

Every app applies the [cdk-nag](https://github.com/cdklabs/cdk-nag)
`AwsSolutionsChecks` in `bin/app.ts`, so a finding fails `cdk synth` and
`cdk deploy`. Each app also has a `test/unit/cdk-nag.test.ts` that fails on
any unsuppressed finding.

- Fix a finding when you can. Otherwise, add `NagSuppressions` next to the
  resource with a reason that explains why the permission or setting is
  needed, and limit it with `appliesTo` to the specific finding.
- Use cdk-nag 2. cdk-nag 3 no longer writes the
  `cdk.out/AwsSolutions-*-NagReport.csv` files that security scanners read.
- Before a security scan, run `make synth` from the repository root so every
  app's `cdk.out` holds current reports.

## Authentication

All accelerators use the same CDK context keys for inbound JWT authentication
(`jwtDiscoveryUrl`, `jwtAllowedClients`, `jwtAllowedAudiences`,
`jwtAllowedScopes`). See [authentication.md](authentication.md). Do not add
accelerator-specific identity resources.

## Source files

Start every source file with:

```text
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
```

as a comment in the file's language.
