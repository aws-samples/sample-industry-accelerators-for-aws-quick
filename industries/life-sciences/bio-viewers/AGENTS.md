# Bio viewers accelerator

Read the root [AGENTS.md](../../../AGENTS.md) first, then this file's
[README](README.md) for the architecture and deploy flow.

## What this is

- `<projectName>-Runtime` (`lib/stacks/bio-viewers-runtime-stack.ts`): an
  AgentCore Runtime (MCP protocol, default IAM inbound auth, public network
  mode) running `containers/bio-viewers/Dockerfile`.
- `<projectName>-Gateway` (`lib/stacks/gateway-stack.ts`): the AgentCore
  Gateway with the shared `CUSTOM_JWT` authorizer, an MCP server target that
  calls the Runtime with SigV4 (Gateway role), and the Runtime resource
  policy. It takes Runtime values through strong cross-stack references.
- `containers/bio-viewers/` (Python 3.13, uv): the MCP server. Tools
  `show_structure`, `show_alignment` and `show_dicom` link MCP Apps widgets
  (`ui://bio-viewers/structure.html`, `alignment.html`, `dicom.html`).

## Commands

| Command | Use |
| --- | --- |
| `make test-unit` | `make test-python`, `npm run build`, `npm test` |
| `make test-python` | `uv run --frozen pytest` in `containers/bio-viewers` |
| `npm run tools:snapshot` | Regenerate `lib/tools/bio-viewers-tools.json` from the server |
| `uvx ruff@0.15.0 format --line-length 120` | Python formatting, run in `containers/bio-viewers` |

## Changing the server

1. Edit `containers/bio-viewers/src/bio_viewers_mcp/`, then run
   `make test-python`.
2. After changing dependencies, run `uv lock` and
   `uv export --frozen --no-dev --no-emit-project -o requirements.txt` in
   `containers/bio-viewers`. The Dockerfile installs `requirements.txt` with
   `--require-hashes`.
3. After changing a tool's name, description, schema or annotations, run
   `npm run tools:snapshot`. A pytest fails until you do. Never hand-edit the
   snapshot; the Gateway discovers tools from the server, and the snapshot
   only feeds the tests.
4. Update `skills/bio-viewers/SKILL.md` and the README tool table in the same
   change.

## Server invariants

- **No file access.** The server is remote: never read paths from tool
  arguments (the container filesystem is not the user's, and reading it would
  expose the image). Tools accept content only and reject path-like input.
  `show_dicom`'s `sample` maps a fixed literal (`ct`, `mr`) to a bundled
  pydicom test file; never accept a path or file name from arguments.
- **Runtime contract.** Listen on `0.0.0.0:8000` with MCP at `/mcp`,
  stateless Streamable HTTP with JSON responses (`stateless_http=True`,
  `json_response=True`). AgentCore Gateway rejects SSE responses on
  `tools/call`. The bind default outside the container is `127.0.0.1`; only
  the Dockerfile sets `MCP_HOST=0.0.0.0`. `initialize` must keep answering
  protocol version `2025-03-26`, which AWS Quick uses.
- **stdio mode.** `MCP_TRANSPORT=stdio` (the default outside the container)
  runs the server for a local MCP client. Keep it working; the README
  documents it.
- **Host guard.** `transport_security()` in `server.py` disables DNS
  rebinding protection only for non-loopback binds, because the Runtime
  accepts only SigV4 `InvokeAgentRuntime` calls and never publishes the port.
  Don't put public ingress or another proxy in front of the container without
  restoring an explicit allowed-hosts policy.
- **Image.** Keep the base image pinned by digest, dependencies installed
  with `--require-hashes`, the process non-root (uid 10001), and the platform
  `linux/arm64`.
- **Widgets.** The widgets load Mol*, AlignmentViewer, dicom-parser and the
  MCP Apps SDK from `cdn.jsdelivr.net` at pinned versions, and the structure
  widget fetches PDB entries from `models.rcsb.org` and `files.rcsb.org`. Keep
  each `ResourceCsp` in `server.py` in sync with what its widget loads, and
  update the CSP table in the README Security section with it. `theme.css` is
  inlined at the `<!-- QUICK_THEME -->` marker. When a widget calls its tool
  again, it must use the host-context tool name (`toolInfo.tool.name`),
  because the Gateway prefixes tool names and a local stdio client does not.
- **Payload size.** `STRUCTURE_MAX_MB`, `ALIGNMENT_MAX_MB` and `DICOM_MAX_MB`
  (default 5; DICOM is the decoded size, base64 adds 4/3) also set the HTTP
  body limit.
- **DICOM and PHI.** The `show_dicom` summary (`dicom.py`), the widget's
  corner annotations and stats, and its `updateModelContext` messages carry
  technical attributes only (modality, body part, size, frames, pixel
  encoding, spacing, window, transfer syntax). Never add patient, study,
  institution, physician, date or UID attributes, and never put pydicom
  exception text or warnings (which can quote values) in errors or logs.
  Files the user opens in the widget are decoded in the browser and must
  never be sent to the server.
- **Logging.** Structures and sequences may be proprietary. Don't log tool
  arguments, results or exception text derived from them. httpx's INFO
  request logging stays silenced in `server.py` because request URLs carry
  PDB IDs; a test checks this.
- **Annotations.** Every tool declares `readOnlyHint: true`,
  `destructiveHint: false`, `idempotentHint: true`. `openWorldHint` is `true`
  for `show_structure` (RCSB) and `false` for the others. AWS Quick
  classifies tools from these hints; keep them honest.

## Runtime and Gateway invariants

- Keep the Runtime on IAM inbound auth. Grant `InvokeAgentRuntime` only to
  the Gateway role (`runtime.grantInvokeRuntime`), never on `*`.
- `McpGateway` owns the Runtime's single `AWS::BedrockAgentCore::ResourcePolicy`,
  which denies `InvokeAgentRuntime` to every principal except the Gateway
  role. Keep the deny, and don't create a second resource policy for the
  Runtime. The Gateway target depends on the policy, because the Gateway
  lists the server's tools when the target is created.
- Use an `mcpServer` target with `GATEWAY_IAM_ROLE` and
  `iamCredentialProvider: { service: 'bedrock-agentcore' }`. Lambda targets
  don't carry tool `_meta` or resources, which MCP Apps need. The endpoint is
  `https://bedrock-agentcore.<region>.<urlSuffix>/runtimes/<url-encoded runtime ARN>/invocations?qualifier=DEFAULT`,
  assembled from known ARN parts in the Runtime stack.
- The server needs outbound HTTPS to `data.rcsb.org`, so the Runtime uses
  public network mode.
- The Gateway caches the target's tool and resource listings. After a tool or
  widget change, the target must be synchronized
  (`aws bedrock-agentcore-control synchronize-gateway-targets`).

## Naming

- The Runtime name is `projectName` with non-alphanumerics replaced by `_`,
  plus `_bio_viewers`. Runtime names allow 48 characters, which is why
  `PROJECT_NAME_MAX_LENGTH` is 36.
- The Gateway target name, and so the tool prefix, is `TARGET_NAME`
  (`bio-viewers`) in `lib/tools/bio-viewers-tools.ts`. The integration tests
  use the same constant.
- `@aws-cdk/core:defaultCrossStackReferences` is `strong`, so CloudFormation
  won't delete Runtime values the Gateway stack imports. Update the Gateway
  stack before you remove or replace the Runtime.
