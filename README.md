# Sample Industry Accelerators for AWS Quick

Sample AWS CDK applications that add industry-specific tools to
[AWS Quick](https://aws.amazon.com/quick/). Each accelerator deploys a remote
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) server into
your own AWS account. You then connect it to AWS Quick as an MCP connector, so
Quick's AI assistant can call the accelerator's tools in a conversation.

Every accelerator is an independent CDK app. Deploy only the ones you need.

## Why use these accelerators

Research and business teams often ask IT for tools that off-the-shelf software
doesn't provide, such as scientific computing environments, prediction models,
or knowledge graphs built on the company's own data. You can build these on
AWS, but each tool then needs its own interface, sign-in and AI agent
integration. AWS Quick gives you one chat interface, one sign-in and one set
of access controls that you can reuse for all of them. Each accelerator is a
working example of that pattern that you can deploy as-is or adapt.

You deploy every accelerator into your own AWS account, so you control its
resources, permissions, network access and logs. Some accelerators call
public services or load code from public sites; each accelerator's Security
section lists what it reaches outside your account.

Accelerators work alongside the other connectors in AWS Quick, including
partner connectors. An AWS Quick agent can use both in the same conversation.

## Accelerators

| Industry | Accelerator | What it adds to AWS Quick |
| --- | --- | --- |
| Life sciences | [Scientific Computing Sandbox](industries/life-sciences/scientific-computing-sandbox/) | Per-user, network-isolated Python sandboxes with scientific environments for cheminformatics, imaging, genomics, transcriptomics and single-cell analysis |
| Life sciences | [Bio viewers](industries/life-sciences/bio-viewers/) | Interactive protein structure, sequence alignment and DICOM image viewers (MCP Apps) |

Interested in more accelerators? Reach out to your AWS account team for information about additional solutions available for deployment as part of engineering engagements.

To build a new accelerator, start from the
[Lambda target template](templates/lambda-target/).

## How the accelerators work

All accelerators share one base architecture:

```text
AWS Quick ──(OAuth sign-in)──▶ your identity provider
    │
    └──(JWT access token)──▶ Amazon Bedrock AgentCore Gateway (MCP)
                                 ├──▶ AWS Lambda target(s)
                                 └──(IAM)──▶ MCP server on AgentCore Runtime
```

- An [Amazon Bedrock AgentCore Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html)
  is the MCP endpoint that AWS Quick connects to.
- The Gateway validates a JWT access token from **your own identity
  provider** (Amazon Cognito, Okta, Microsoft Entra ID or any OIDC provider).
  The accelerators create no identity resources.
- The Gateway's targets do the work: Lambda functions, or MCP servers hosted on
  AgentCore Runtime that only the Gateway can invoke.

See [docs/architecture.md](docs/architecture.md) for details and
[docs/authentication.md](docs/authentication.md) to set up sign-in.

## Prerequisites

- An AWS account and credentials for it, in a Region where Amazon Bedrock
  AgentCore is available
- An AWS Quick Enterprise subscription
- An OIDC identity provider that can issue JWT access tokens for AWS Quick (see
  [docs/authentication.md](docs/authentication.md))
- Node.js 22 or later and npm
- GNU Make
- Some accelerators also need [uv](https://docs.astral.sh/uv/) and a container
  engine (Docker or Finch); see their READMEs

## Quick start

```bash
cd industries/<industry>/<accelerator>
npx cdk bootstrap                     # once per account and Region
make deploy CDK_ARGS="-c jwtDiscoveryUrl=<url> -c jwtAllowedClients=<client-id>"
```

Then follow the accelerator's README to connect it to AWS Quick.

## Repository layout

```text
industries/<industry>/<accelerator>/  One self-contained CDK app per accelerator
templates/lambda-target/            Starter for a new accelerator
docs/                               Shared architecture, authentication and conventions
Makefile                            Runs a target across every accelerator
```

Each accelerator has a `README.md` and a `Makefile` with the same targets:
`deploy`, `destroy`, `test`, `test-unit` and `test-integration`. From the
repository root, `make test-unit` runs every accelerator's unit tests.

## Costs

Deployed accelerators create billable AWS resources in your account. These
charges are in addition to your AWS Quick subscription. Each accelerator's
README has a cost section. Run `make destroy` in an accelerator's folder to
remove it.

## Support

The accelerators are sample code, not a supported AWS service. Report bugs and
request features in [GitHub issues](../../issues).

For help deploying, tailoring or extending an accelerator, or for
capabilities that work with data that can't leave your account, contact your
AWS account team.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more
information.

These samples are a starting point. Review them against your organization's
security, compliance and data-handling requirements before you use them with
real data.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE)
file.
