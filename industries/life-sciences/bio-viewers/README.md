# Bio viewers

Interactive viewers for protein structures, sequence alignments and DICOM
medical images in AWS Quick. The accelerator hosts an MCP server on Amazon
Bedrock AgentCore Runtime and exposes it to AWS Quick through an AgentCore
Gateway. Its tools return [MCP Apps](https://apps.extensions.modelcontextprotocol.io/)
widgets, which AWS Quick renders in the conversation.

## Overview

| Tool in AWS Quick | What it shows | Arguments |
| --- | --- | --- |
| `bio-viewers___show_structure` | A protein 3D structure in a [Mol*](https://molstar.org/) viewer | `structure`: a PDB ID (for example `1CRN`), downloaded from RCSB, or mmCIF or PDB text |
| `bio-viewers___show_alignment` | Sequences or a multiple sequence alignment in a viewer based on [CDCgov AlignmentViewer](https://github.com/CDCgov/AlignmentViewer), with consensus and conservation tracks | `alignment`: FASTA (aligned or not, A2M), A3M, Clustal or Stockholm text, or one bare sequence. Optional `title`, and `format` (`fasta`, `a3m`, `clustal`, `stockholm`; set `a3m` for A3M) |
| `bio-viewers___show_dicom` | A medical image in a DICOM viewer: window and level with CT presets, zoom, pan, pixel values, and frame and slice scrolling | Optional `dicom`: a base64 DICOM file (a `data:` URL prefix is accepted). Optional `sample`: `ct` or `mr`, anonymized test images from pydicom. Optional `title` |

Called with neither `dicom` nor `sample`, `show_dicom` opens an empty viewer.
The user then opens DICOM files (one image, a multi-frame file or a series)
from their computer. The browser decodes those files; they are never sent to
the server or the model.

Each tool returns a text summary to the model and the full data to the
widget:

- `show_structure`: title, method, resolution, chains, residues and ligands.
- `show_alignment`: sequence count, length, gaps, conserved columns, identity
  to the consensus.
- `show_dicom`: the technical header only (modality, size, frames, pixel
  encoding, spacing, window). Patient, study, institution, physician, date and
  UID attributes are never included.

All tools are read-only (`readOnlyHint: true`, `destructiveHint: false`).
`show_structure` declares `openWorldHint: true` because it calls RCSB.

Limits and behavior:

- Structure and alignment text, and decoded DICOM files, are limited to 5 MB
  per call. The container reads the limits from `STRUCTURE_MAX_MB`,
  `ALIGNMENT_MAX_MB` and `DICOM_MAX_MB`. Prefer PDB IDs for deposited
  structures, and let users open DICOM files in the viewer instead of passing
  them through the model.
- The DICOM viewer decodes uncompressed (implicit or explicit VR little
  endian, explicit VR big endian), RLE Lossless and 8-bit JPEG Baseline or
  Extended images in MONOCHROME1, MONOCHROME2, RGB or YBR_FULL. It does not
  decode JPEG Lossless, JPEG-LS, JPEG 2000, HTJ2K, deflated files or palette
  color; the viewer shows an error and the summary tells the model. It is a
  review aid, not a diagnostic viewer.
- The server never reads files. Tools take content, not paths, and reject
  path-like input with an error that asks for the content.

[`skills/bio-viewers/SKILL.md`](skills/bio-viewers/SKILL.md) is optional
guidance on using the tools, in the Agent Skills format. Nothing in the
deployment reads it; give it to an agent that you want to use the tools well.

## Architecture

```text
AWS Quick ──(JWT from your identity provider)──▶ AgentCore Gateway ──(SigV4, Gateway role)──▶ AgentCore Runtime
                                                  CUSTOM_JWT authorizer                         bio-viewers container
                                                                                                   │ :8000/mcp, stateless HTTP
                                                                                                   └──▶ data.rcsb.org

Widget in the AWS Quick conversation ──▶ cdn.jsdelivr.net (viewer code), models.rcsb.org and files.rcsb.org (PDB entries)
```

| Stack | Resources |
| --- | --- |
| `<projectName>-Runtime` | The AgentCore Runtime (MCP protocol, IAM inbound authorization, public network mode) running the bio-viewers container image, and its execution role |
| `<projectName>-Gateway` | The AgentCore Gateway (MCP, `CUSTOM_JWT` authorizer), its MCP server target on the Runtime, the Gateway IAM role (allowed to invoke only this Runtime), and the Runtime resource policy that admits only the Gateway role |

The Gateway discovers the tools and `ui://` widget resources from the server.
The server is a Python 3.13 package on the MCP Python SDK with its MCP Apps
extension. In the container it serves stateless Streamable HTTP with JSON
responses at `0.0.0.0:8000/mcp`, the AgentCore Runtime MCP contract.

Source layout:

```text
bin/app.ts                           Reads context and creates the stacks
lib/config/                          projectName validation and the jwt* context keys
lib/constructs/mcp-gateway.ts        Gateway, Runtime target, Gateway role and Runtime resource policy
lib/stacks/                          Runtime and Gateway stacks
lib/tools/bio-viewers-tools.json     Snapshot of the server's tools/list, used by the tests
containers/bio-viewers/              The MCP server: Dockerfile, uv project, widgets and tests
skills/bio-viewers/SKILL.md          Optional agent guidance for the tools
test/unit/                           Offline CDK tests
test/integration/                    Tests against the deployed stacks
```

## Prerequisites

- Node.js 22 or later, npm and GNU Make
- [uv](https://docs.astral.sh/uv/), for the server tests
- A running container engine: Docker, or Finch with `CDK_DOCKER=finch`. The
  deploy builds a `linux/arm64` image; on an x86 machine the engine needs
  arm64 emulation.
- AWS credentials for the target account, bootstrapped for CDK
  (`npx cdk bootstrap`)
- A Region where Amazon Bedrock AgentCore Runtime and Gateway are available
- An identity provider for AWS Quick sign-in; see
  [docs/authentication.md](../../../docs/authentication.md)

## Deploy

```bash
make deploy CDK_ARGS="-c jwtDiscoveryUrl=<discovery-url> -c jwtAllowedClients=<client-id>"
```

| Context key | Default | Description |
| --- | --- | --- |
| `projectName` | `ls-bio-viewers` | Prefix for stack IDs and resource names. 1-36 lowercase letters, digits or single hyphens, starting with a letter |
| `jwtDiscoveryUrl` | None (required) | Your identity provider's discovery URL |
| `jwtAllowedClients` | None | Allowed `client_id` claim values (comma-separated) |
| `jwtAllowedAudiences` | None | Allowed `aud` claim values (comma-separated) |
| `jwtAllowedScopes` | None | Scopes; the token must carry at least one |

Set `jwtAllowedClients`, `jwtAllowedAudiences`, or both; synthesis fails
otherwise. The `<projectName>-Gateway` stack outputs `GatewayUrl`, the MCP
server endpoint for AWS Quick.

## Connect to AWS Quick

Create an MCP connector in AWS Quick with the `GatewayUrl` output as the MCP
server endpoint and your identity provider's OAuth settings. The
[Cognito example](../../../docs/authentication.md#worked-example-amazon-cognito)
lists every field.

AWS Quick discovers `bio-viewers___show_structure`,
`bio-viewers___show_alignment` and `bio-viewers___show_dicom`, all classified
as read tools. The tools return MCP Apps (`ui://`) widgets that AWS Quick
renders in the conversation.

Example prompts:

- "Show me the structure of hemoglobin, PDB 4HHB."
- "Show 1CRN and tell me how many chains and ligands it has."
- "Show this alignment and tell me which columns are conserved: `<pasted FASTA>`"
- "Show me a sample CT image."
- "Open a DICOM viewer so I can look at my scans."

After you change a tool or widget and redeploy, synchronize the Gateway target
(`aws bedrock-agentcore-control synchronize-gateway-targets`), because the
Gateway caches the server's listings, then choose **Sync** on the connector.

## Test

```bash
make test-unit          # type-check, CDK assertions and server tests; no AWS or container engine needed
make test-integration   # tests against the deployed stacks; set PROJECT_NAME if you changed it
```

Without `ACCESS_TOKEN`, the integration tests check that the Runtime denies
your own (non-Gateway) credentials and that the Gateway rejects a request
without a token. To also call the tools through the Gateway, set
`ACCESS_TOKEN` to an access token that your identity provider issued for an
allowed client or audience:

```bash
read -s ACCESS_TOKEN
export ACCESS_TOKEN
make test-integration
unset ACCESS_TOKEN
```

### Try the server locally

The container also runs as a local stdio MCP server, with no AWS deployment.
Build the image for your machine, then point a local MCP client that renders
MCP Apps at it:

```bash
docker build -t bio-viewers-mcp containers/bio-viewers
```

```json
{
  "mcpServers": {
    "bio-viewers": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "MCP_TRANSPORT=stdio", "bio-viewers-mcp"]
    }
  }
}
```

- `-e MCP_TRANSPORT=stdio` is required: the image defaults to Streamable HTTP
  for AgentCore Runtime.
- `-i` is required because stdin carries the MCP messages. Don't add `-t` or
  publish a port (`-p`); in stdio mode the server does not listen on the
  network.
- With Finch, use `finch build` and set `command` to `finch`. Desktop apps on
  macOS don't inherit your shell's `PATH`, so you may need the absolute path
  from `which docker` or `which finch`.
- Locally, tool names have no `bio-viewers___` prefix (for example,
  `show_dicom`).

## Cost

- AgentCore Runtime: charged for the vCPU and memory that active sessions
  use.
- AgentCore Gateway: charged per tool call and per search request.
- Amazon ECR: storage of the container image in the CDK bootstrap repository.
- CloudWatch Logs: ingestion and storage of the Runtime's logs.

With no traffic, the deployment costs little beyond image storage.

## Security

- **cdk-nag.** `cdk synth` and `cdk deploy` run the cdk-nag AWS Solutions
  checks and fail on any finding without a documented suppression. Each
  suppression, next to its resource in `lib/`, gives the reason. Synthesis
  writes the results to `cdk.out/AwsSolutions-*-NagReport.csv`.
- **Authentication.** The Gateway accepts only JWTs that your identity
  provider signed and that carry an allowed client ID or audience. Synthesis
  fails if neither is set.
- **No path around the Gateway.** The Runtime keeps IAM inbound authorization.
  Its resource policy denies `InvokeAgentRuntime` to every principal except
  the Gateway role, and the Gateway role can invoke only this Runtime. Only
  this Gateway can assume the Gateway role (`aws:SourceArn` names the
  Gateway), so another Gateway in the account can't use it to reach the
  Runtime. The server itself has no authentication.
- **Runtime permissions.** The Runtime's execution role can only pull its
  image from the CDK bootstrap ECR repository, write the Runtime's CloudWatch
  logs, and put metrics in the `bedrock-agentcore` namespace. It has no X-Ray
  or workload identity permissions. The server calls no AWS APIs.
- **Who can use it.** Every user who can sign in through your identity
  provider and use the AWS Quick connector can call every tool. Restrict the
  connector in your identity provider and in AWS Quick.
- **No file access.** The server never reads file paths from tool arguments.
  Tools take content, and reject path-like input. `show_dicom`'s `sample`
  selects one of two bundled test images by a fixed name.
- **Container.** The image runs as a non-root user (uid 10001), starts from a
  base image pinned by digest, and installs dependencies from a hashed
  `requirements.txt` with `pip --require-hashes`.
- **Host header checks.** DNS rebinding protection stays on when the server
  binds to a loopback address. It is off only for the container's
  `0.0.0.0` bind, which the Runtime reaches only through SigV4-signed
  `InvokeAgentRuntime` calls; the port is never published.
- **DICOM and patient data.** The `show_dicom` summary, the widget's
  annotations and the context it sends back to the model carry technical
  attributes only, never patient, study, institution, physician, date or UID
  attributes. pydicom error text, which can quote header values, is not
  returned or logged. A base64 DICOM file passed to the tool does travel
  through AWS Quick, the Gateway and the Runtime; files the user opens in the
  viewer stay in the browser. Only use protected health information in an
  account and with services that your compliance requirements allow.
- **Logging.** The server does not log tool arguments, results, or exception
  text derived from them. An unexpected error in a tool is logged by its
  exception type only, and the tool returns a fixed error message. Request
  logging of the HTTP client is turned off, because request URLs carry PDB
  IDs.
- **Audit trail.** The stacks don't record who called which tool: the server
  sees only the Gateway role. AWS Quick knows the signed-in user. The Gateway
  publishes invocation metrics per tool to CloudWatch (`AWS/Bedrock-AgentCore`
  namespace) without payloads. You can also turn on the Gateway's log
  delivery in the AgentCore console, but those logs include request and
  response bodies, which means structures, sequences and base64 DICOM files.
  Only turn it on if storing that data in your logs is acceptable, and set a
  retention period.
- **Outbound network access.** The Runtime uses public network mode. The
  server calls `https://data.rcsb.org` for PDB entry metadata.
- **Code loaded in the user's browser.** The widgets load their viewer code
  from a public CDN in the user's browser, and declare these domains in each
  widget's MCP Apps content security policy (`_meta.ui.csp`):

  | Widget | Loads scripts and styles from (`resourceDomains`) | Fetches data from (`connectDomains`) |
  | --- | --- | --- |
  | Structure | `https://cdn.jsdelivr.net` (Mol\* 5.13.1, MCP Apps SDK 2.0.3) | `https://models.rcsb.org`, `https://files.rcsb.org` (PDB entries) |
  | Alignment | `https://cdn.jsdelivr.net` (AlignmentViewer 0.3.4, MCP Apps SDK 2.0.3) | None |
  | DICOM | `https://cdn.jsdelivr.net` (dicom-parser 1.8.21, MCP Apps SDK 2.0.3) | None |

  The versions are pinned in the widget HTML. Review whether loading code
  from this CDN meets your requirements, or host the libraries yourself and
  update the widgets and their CSP in `server.py`.

## Clean up

```bash
make destroy CDK_ARGS="<the same CDK_ARGS you deployed with>"
```

This removes both stacks. These remain and are deleted separately:

- The AWS Quick connector, and any OAuth client you created for it.
- The container image in the CDK bootstrap ECR repository.
- The Runtime's CloudWatch log groups (under `/aws/bedrock-agentcore/`),
  which AgentCore creates outside the stacks.
