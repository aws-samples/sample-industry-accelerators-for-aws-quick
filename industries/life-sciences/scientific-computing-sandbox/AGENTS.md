# Scientific Computing Sandbox

Read the root [AGENTS.md](../../../AGENTS.md) first, then `README.md` for the
architecture, session model and deploy flow.

## What this accelerator is

A CDK (TypeScript) app with three stacks, two Lambda handlers, and the Python
MCP server that the runtimes host. Each sandbox environment is an MCP server on
AgentCore Runtime. AWS Quick starts a new MCP session for every tool call, so
Gateway MCP sessions cannot keep a sandbox. Instead the sandbox tools Lambda
gives each user one Runtime session (one microVM) per environment, derived from
the verified caller `sub`. One Gateway target, `sandbox`, serves every
environment: its tools take an `environment` argument, and `list_environments`
describes the environments from a generated catalog without starting a
sandbox.

- `<projectName>-Network` (`lib/stacks/network-stack.ts`,
  `lib/constructs/isolated-network.ts`): the isolated VPC, its endpoints and
  their policies, security groups, DNS Firewall and rejected-traffic flow logs.
- `<projectName>-Runtime` (`lib/stacks/sandbox-runtime-stack.ts`): per deployed
  environment in `lib/sandbox/catalog.json`, a Docker image asset
  (`containers/sandbox/Dockerfile` with `ENVIRONMENT=<id>`, its build context
  excluding the layers it does not build on), an AgentCore Runtime (MCP, IAM
  inbound auth, VPC mode, idle timeout and maximum lifetime) and a minimal
  execution role.
- `<projectName>-Gateway` (`lib/stacks/gateway-stack.ts`): the Gateway with
  the `CUSTOM_JWT` authorizer and the REQUEST interceptor
  (`lambda/caller-identity-interceptor`), one Lambda target served by the
  sandbox tools Lambda (`lambda/sandbox-tools`, in the isolated VPC), the
  AgentCore interface endpoint it calls the runtimes through, and one runtime
  resource policy per runtime.
- `containers/sandbox/` (Python 3.13, uv): `code_sandbox_mcp.server` (MCP
  tools, `/ping`) and `code_sandbox_mcp.sandbox` (processes, jobs, files,
  limits) on the official `mcp` SDK. Each environment layer lives in
  `environments/<id>/` and is installed into a separate virtual environment,
  `/opt/sandbox`, one Dockerfile stage per layer on top of its parent's.
  `scripts/sandbox_environments.py` validates the layers, locks them
  (`make lock`) and generates the catalog (`npm run environments:catalog`).
- `skills/scientific-computing-sandbox/SKILL.md` is optional agent guidance. No code reads it;
  a unit test checks that it names every tool and environment.

## Commands

| Command | Use |
| --- | --- |
| `make test-unit` | Type-check, CDK and Lambda unit tests, and `uv run --frozen pytest` in `containers/sandbox`; no AWS or container engine |
| `make test-container SANDBOX_ENVIRONMENT=<id>` | Build one arm64 image (default `chem`), run it on loopback, check it is not root, and smoke-test it |
| `make test-containers` | `make test-container` for every deployed environment, then `make image-report` |
| `make lock` | Re-resolve every layer's hashed `requirements.txt` for linux/arm64 (needs PyPI) and regenerate the catalog |
| `npm run environments:catalog` | Regenerate `lib/sandbox/catalog.json` and the README environment table |
| `npm run tools:snapshot` | Regenerate `lib/tools/server-tools.json` from the server |

Run `make test-container` for each affected environment (or
`make test-containers`) after any change under `containers/`.

## Sandbox server

- **Runtime contract.** Listen on `0.0.0.0:8000` with MCP at `/mcp`, stateless
  Streamable HTTP with JSON responses (`http_options()` sets
  `stateless_http=True`, `json_response=True`). AgentCore Gateway rejects SSE
  responses on `tools/call`. The Runtime routes requests by the platform's
  `Mcp-Session-Id`, so stateless mode still lands every call of a session on
  the same microVM. The bind default outside the container is `127.0.0.1`;
  only the Dockerfile sets `MCP_HOST=0.0.0.0`.
- **Host guard.** The SDK's DNS-rebinding check is disabled only for
  non-loopback binds (`transport_security()`), because the Runtime accepts
  only SigV4 `InvokeAgentRuntime` calls and never publishes the port. Do not
  add a JWT authorizer, public ingress or a proxy in front of the container
  without restoring an explicit allowed-hosts policy.
- **Session model.** There are no sandbox IDs: the microVM is the sandbox.
  Isolation between users comes from the tools Lambda's `sub`-derived Runtime
  session IDs plus the runtime resource policy. The server never sees or
  decides identity: never add a tool or parameter that lets a caller name a
  session, and never read identity from tool arguments or request headers.
  Report the Runtime session ID only as a digest.
- **Stateless transport.** The tools Lambda sends one `tools/call` per
  invocation, without `initialize`, and sets its own `Mcp-Session-Id`. The
  server must keep accepting that (a pytest checks it).
- **Fresh processes.** Every `execute_code` call starts a new process
  (`nice -n 10`, its own process group, `child_env()` only). Never pass the
  server's environment to children.
- **Liveness.** `/ping` returns `HealthyBusy` while any job runs. Set
  `time_of_last_update` only when the status changes; a timestamp that
  advances on every ping keeps sessions alive until their maximum lifetime.
- **Bounds.** Code 256 KiB, synchronous timeouts 1-600 s, output tails
  256 KiB per stream, `read_file` and `write_file` 1 MiB, listings 5,000
  entries, 8 running jobs, 256 retained jobs. Enforce them both in the tool
  schemas (pydantic `Field`) and in `sandbox.py`.
- **Errors.** Raise `SandboxError` with a fixed code and a message without
  caller-controlled content; `tool_errors` turns any other exception into
  `INTERNAL_ERROR`.
- **Logging.** `MCPServer(log_level="WARNING")` also sets uvicorn's level,
  whose INFO access log would record the Runtime's `/ping` every few seconds.
  Never log tool arguments, code, paths, file contents, output or the session
  ID.

## Environments, catalog and image

- Each layer's own packages are exactly pinned in
  `environments/<id>/pyproject.toml`. `make lock` resolves them with
  `uv pip compile` for linux/arm64, passing the parent's `requirements.txt`
  as an input, so a child never changes a parent pin (a pytest checks this).
  If a child cannot resolve against a parent pin, report the conflict instead
  of loosening the parent. Bound transitive dependencies in a layer's
  `constraints.txt` only when needed (as `python-dateutil<3` in `general`).
- A layer's `overrides.txt` (`uv pip compile --overrides`) may replace a
  dependency's declared requirement only for a security fix that an exact
  upstream pin blocks, after checking the dependent does not rely on the old
  version. `sctraj` overrides pygpcca's `jinja2==3.0.3` with `jinja2>=3.1.6`
  (pygpcca never imports jinja2). It holds because layers install with
  `--no-deps`.
- To take a package from an index other than PyPI, add an explicit
  `[[tool.uv.index]]` and a `[tool.uv.sources]` entry for that one direct
  dependency; `make lock` writes the package's page on that index into the
  lock as a `--find-links` line. Never use `--extra-index-url`: uv would look
  up every package there first. No environment currently does this, and no
  environment may lock `torch` or a GPU build (pytests check both).
- Layers install with `uv pip install --require-hashes` into `/opt/sandbox`
  (`install-environment.sh`, with `build-requirements.txt` as hashed build
  constraints for the pure-Python source distributions). Root owns
  `/opt/sandbox`, which has no pip. Never install sandbox packages into the
  server's environment or server packages into `/opt/sandbox` (the smoke test
  checks both directions).
- `[tool.code-sandbox]` (title, parent, use-for, notes, packages with
  summary and import name, programs with a check command) and
  `project.description` are what agents read through `list_environments`, the
  `environment` argument, `get_sandbox_info` and the Runtime descriptions.
  Keep them accurate. Never hand-edit `lib/sandbox/catalog.json` or the README
  table between its markers; pytests fail when either is stale.
- Environment IDs are at most 11 characters, because Runtime names
  (`<projectName>_<id>`) are limited to 48 and `projectName` to 36.
- Keep the base image pinned by digest, the process non-root (uid 10001), and
  every image `linux/arm64` and under AgentCore Runtime's compressed image
  limit for the platform version (2 GB on V1; `make image-report` measures
  the compressed size). `sctraj` is the largest, about 1.7 GB uncompressed
  and 0.5 GB compressed. Keep one
  `env-<id>` stage per layer, `FROM env-<parent>` (a pytest checks this), with
  system libraries only in the stage that needs them (`libxrender1`,
  `libxext6` and `libexpat1` for `rdkit.Chem.Draw` in `env-chem`). The server
  is installed on top of the environment, so server changes rebuild only the
  top layers. Packages without linux/arm64 wheels cannot build (no compiler).
- `lib/tools/server-tools.json` is the source of the sandbox target's inline
  tool schema (`gatewayTools()` adds `list_environments`, the `environment`
  argument and `reset_sandbox`; `toGatewaySchema` converts it). Server tool
  descriptions must not depend on the environment, and no server tool may
  define an `environment` argument (pytests check both). Regenerate the
  snapshot with `npm run tools:snapshot`, never by hand. Server schemas must
  stay within what `toGatewaySchema` can express (single types, `anyOf` only
  with `null`); state bounds and enums in the descriptions.

## Runtime and Gateway

- **Runtime platform version: keep V1**, set explicitly on every runtime
  through `RUNTIME_PLATFORM_VERSION` (a unit test checks it). AgentCore is
  changing the create-time default to V2, so without it new runtimes would
  get V2 while existing ones keep V1 (an update that omits the version keeps
  the current one). V2 restores a memory snapshot and loads image files
  lazily, which made new-session start and first imports much slower for
  these large images: reading every file of a 1.5 GB environment took
  minutes instead of under a second. Don't switch without remeasuring, with
  a build warmup hook whose `disk` call reads the files a session's first
  imports read. `image_report.py` reads the constant to apply the matching
  image size limit. The script runs no commands: the `image-report` Makefile
  target calls the container CLI and saves its output, which the script
  reads (a pytest checks this).
- **Execution role.** Sandboxed code can read the execution role's
  credentials from the microVM's metadata endpoint (verified). The stack
  creates the role and passes the `Runtime` construct an immutable view
  (`withoutPolicyUpdates()`), because the construct would otherwise add
  workload-identity token actions. Keep it to image pull, the runtime's own
  log groups and `cloudwatch:PutMetricData` in the `bedrock-agentcore`
  namespace. Never grant S3, Secrets Manager, KMS, STS, IAM, model invocation,
  workload identity or other data-plane permissions (a unit test checks the
  action prefixes). The server has no tracing SDK, so there is no X-Ray
  statement either (X-Ray accepts only `Resource: "*"`).
- **Runtime access.** Keep the runtimes on IAM inbound auth. Only the tools
  Lambda's role gets `SANDBOX_RUNTIME_ACTIONS`
  (`bedrock-agentcore:InvokeAgentRuntime`,
  `bedrock-agentcore:StopRuntimeSession`), scoped to the runtime ARNs; never
  on `*` or to the Gateway role.
- **Resource policies.** `McpGateway` owns each runtime's single
  `AWS::BedrockAgentCore::ResourcePolicy`. It allows those actions only for
  the tools Lambda's role and keeps two denies: `DenyAllOtherPrincipals`
  (otherwise any principal in the account could bypass the Gateway or enter
  another user's session by computing its ID) and
  `DenyOutsideSandboxVpcEndpoint` (`aws:SourceVpce`; otherwise the tools
  Lambda role's credentials would work from anywhere). Do not create a second
  resource policy for a runtime, and do not move or rename the policy
  constructs (`McpGateway/RuntimeResourcePolicy-<env>`): a new logical ID
  makes CloudFormation create a second policy and then delete the old one,
  leaving the runtime without a policy. A unit test pins the logical IDs.
- **Caller identity.** The interceptor verifies every token with
  `aws-jwt-verify` against the issuer and `jwks_uri` from the discovery
  document, and the same allowed clients, audiences and scopes as the Gateway
  (`JWT_*` environment variables, JSON arrays). It fetches the discovery
  document once per container and does not cache a failed fetch. It fails
  closed when neither clients nor audiences are allowed, and always overwrites
  `CALLER_SUB_HEADER`. It stays outside the VPC, because it reaches the
  identity provider over the internet. Only targets with
  `propagateCallerIdentity` allowlist the header.
- **Tools Lambda.** It reads identity only from
  `context.clientContext.custom.bedrockAgentCorePropagatedHeaders[CALLER_SUB_HEADER]`,
  never from tool arguments, and fails closed with `UNAUTHENTICATED`. Treat
  `lambda:InvokeFunction` on it as part of the trust boundary: an invoker can
  supply any caller in the client context (the integration tests rely on
  this). It accepts only the keys of its `RUNTIMES` map as `environment`
  (checked with `Object.hasOwn`), removes the argument before forwarding, and
  never echoes or logs other values. `list_environments` is answered from the
  bundled catalog and must never start a sandbox.
- **Session IDs.** `runtimeSessionId(sub, env)` is
  `sha256("code-sandbox:v1:<env>:<sub>")`, also sent as `mcpSessionId`.
  Changing `SESSION_NAMESPACE` gives every user a new sandbox; changing the
  derivation in any other way can merge users.
- **Retries.** The Runtime client runs with `maxAttempts: 1`, and the handler
  retries only throttling and JSON-RPC `-32003`/`-32005` (session starting or
  stopping), which AgentCore returns before the request reaches the sandbox.
  Do not add retries that could run a caller's code twice.
- **Logging and errors.** The Lambdas log only the environment (once
  validated, otherwise `null`), tool, outcome code and duration; the
  interceptor only the outcome and a fixed reason. Error codes from a sandbox
  are untrusted (sandboxed code can replace the server): the tools Lambda
  passes on only `SANDBOX_ERROR_CODES` and reports any other code as
  `SANDBOX_ERROR`. A unit test checks the set against the server's source.
- **Gateway target.** One Lambda target, `SANDBOX_TARGET_NAME` (`sandbox`),
  with `GATEWAY_IAM_ROLE` credentials and
  `metadataConfiguration.allowedRequestHeaders = [CALLER_SUB_HEADER]`. The
  Gateway role's trust policy limits `aws:SourceArn` to
  `gateway/<gatewayName>-*`: another Gateway that could assume the role could
  invoke the tools Lambda with any caller header (a unit test checks it). The
  target name is the tool prefix; renaming it replaces the target and changes
  every tool name. AgentCore cannot change a target's type in place (for
  example from MCP server to Lambda). Adding an environment adds a runtime and
  a resource policy, not a target. Gateway MCP sessions do not help with AWS
  Quick and are not configured.
- **Tool annotations.** The server declares honest MCP annotations
  (`list_environments`, `get_sandbox_info`, `get_job`, `read_file` and
  `list_files` read-only; `execute_code`, `write_file`, `cancel_job` and
  `reset_sandbox` destructive; tests assert them). Lambda target schemas
  cannot carry annotations, so AWS Quick treats every tool as write-capable.
  If AgentCore adds annotations to Lambda target tool definitions, map them in
  `McpGateway`.
- **Lifecycle.** `idleTimeoutSeconds` must be at most `maxLifetimeSeconds`
  (both 60-28,800 s). Update the README and the skill if the defaults change.
- **projectName** is capped at 36 characters so the longest derived name,
  `<projectName>-caller-identity-interceptor`, fits Lambda's 64.

## Network (no internet)

- The runtimes and the tools Lambda run in `IsolatedNetwork`'s isolated
  subnets. Never add an internet gateway, NAT gateway, default route,
  peering, VPN, transit gateway attachment or public subnet, and never give a
  security group a `0.0.0.0/0` rule (unit tests check these).
- Add a VPC endpoint only for a service the platform itself needs, with a
  policy limited to this account's principals (`aws:PrincipalAccount`) or to
  specific resources. Keep the S3 gateway endpoint limited to `s3:GetObject`
  on the ECR layer bucket.
- Keep the DNS Firewall allowlist (`ALLOWED_DNS_DOMAINS`) to zones only AWS
  controls: security groups do not apply to the VPC resolver, so any other
  allowed domain is a way out.
- CDK drops its inline match-nothing egress rule from a security group as
  soon as any egress rule is added, which would leave EC2's default
  allow-all egress. `IsolatedNetwork` re-adds the match-nothing rule last;
  keep that (a unit test checks every group).
- The subnets are placed by AZ ID (`AvailabilityZoneId`), because AZ names map
  to different zones in each account. Keep `AGENTCORE_AVAILABILITY_ZONE_IDS`
  in line with the AgentCore VPC documentation.
- AgentCore keeps network interfaces for up to 8 hours after a runtime is
  deleted or moved. Never change a security group's description or construct
  ID, or the subnets' AZ IDs or CIDRs, casually: replacing them fails while
  interfaces use them (a unit test pins the group IDs and descriptions).
- The bedrock-agentcore endpoint lives in the Gateway stack because its
  policy names the tools Lambda role. The Lambda's dependency on the endpoint
  is on the `CfnFunction` only; on the function construct it would include the
  role and create a cycle.
- `@aws-cdk/core:defaultCrossStackReferences` is `strong`: the Gateway stack
  imports runtime and network values, and the Runtime stack imports network
  values. Update the Gateway stack before removing or replacing a runtime, and
  both before changing the network.
