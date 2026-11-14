# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Code sandbox MCP server for Amazon Bedrock AgentCore Runtime.

Each AgentCore Runtime session runs in its own microVM, and the sandbox tools Lambda in front of this server sends
every call by one user to one Runtime session per environment (derived from the user's verified identity). So the
sandbox is simply the microVM this server runs in: there are no sandbox IDs or ownership records here. Files under
/workspace and background jobs last until the Runtime stops the session after its idle timeout, the microVM reaches its
maximum lifetime, or the user calls the Lambda's `reset_sandbox`. After that the next call starts in a fresh microVM
with an empty /workspace; `get_sandbox_info` lets the model notice.

`main()` serves stateless Streamable HTTP with plain JSON responses on `/mcp` (the AgentCore Runtime MCP contract;
AgentCore Gateway rejects SSE responses on `tools/call`) plus the Runtime's `/ping` health check, or stdio for local
development. Run it only inside its container: it executes arbitrary code as the user it runs as.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import os
import platform
import secrets
import shutil
import time
import tomllib
from collections.abc import Awaitable, Callable
from functools import wraps
from pathlib import Path
from typing import Annotated, Any, Literal, ParamSpec

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from code_sandbox_mcp import sandbox
from code_sandbox_mcp.sandbox import SandboxError

ENVIRONMENT = os.environ.get("SANDBOX_ENVIRONMENT", "local")
ENVIRONMENT_FILE = Path(os.environ.get("SANDBOX_ENVIRONMENT_FILE", "/opt/sandbox-environment.toml"))
SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
# Room for the largest write_file content (1 MiB of characters, up to 4 bytes each in UTF-8) plus the JSON-RPC envelope
MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
PACKAGES_TIMEOUT_S = 60

# Tool arguments, results and exception text can carry code, paths and data: the SDK logs rejected arguments and
# failure messages at INFO, so keep only warnings and errors, and never log tool content here.
logging.basicConfig(level=logging.WARNING)
log = logging.getLogger("code_sandbox_mcp")


def environment_metadata() -> tuple[str, str]:
    """Title and description of the sandbox environment, from its pyproject.toml (copied into the image)."""
    try:
        with open(ENVIRONMENT_FILE, "rb") as fh:
            data = tomllib.load(fh)
        title = str(data.get("tool", {}).get("code-sandbox", {}).get("title") or ENVIRONMENT)
        return title, str(data["project"]["description"])
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return ENVIRONMENT, "Python standard library only."


TITLE, DESCRIPTION = environment_metadata()
STARTED = time.monotonic()
SANDBOX = sandbox.Sandbox()

# Tool descriptions must not depend on the environment: every environment's server lists the same tools, and the
# Gateway publishes one schema for all of them (lib/tools/server-tools.json).
mcp = MCPServer(
    "code-sandbox",
    title=f"Scientific Computing Sandbox ({ENVIRONMENT})",
    # Also uvicorn's level: at INFO it logs every request, including the Runtime's /ping every few seconds.
    log_level="WARNING",
    instructions=(
        f"A remote code sandbox, environment '{ENVIRONMENT}' ({TITLE}): {DESCRIPTION} Each user has one Linux "
        "microVM (2 vCPU, 8 GB) per environment with a /workspace directory, shared by all of their conversations. "
        "Use execute_code to run Python or bash, write_file/read_file/list_files for files, and background=true with "
        "get_job for long work. Each call is a fresh process: keep state in files. Files are lost when the sandbox "
        "stops after a period without calls; call get_sandbox_info to check the sandbox and its installed packages."
    ),
)

P = ParamSpec("P")


def tool_errors(fn: Callable[P, Awaitable[str]]) -> Callable[P, Awaitable[str]]:
    """Turns failures into MCP tool errors with a fixed code, and never surfaces unexpected exception text."""

    @wraps(fn)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> str:
        try:
            return await fn(*args, **kwargs)
        except SandboxError as exc:
            raise ToolError(f"{exc.code}: {exc.message}") from None
        except Exception as exc:  # noqa: BLE001 - exception text may echo paths or data
            log.error("tool %s failed with %s", fn.__name__, type(exc).__name__)
            raise ToolError("INTERNAL_ERROR: The sandbox could not complete the request") from None

    return wrapper


def result(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


# ---------------------------------------------------------------------------------------------------------------------
# Sandbox information


_packages: dict[str, str] | None = None
_instance: str | None = None
_sessions: dict[str, float] = {}

PACKAGES_SCRIPT = (
    "import importlib.metadata as m, json, re; "
    "print(json.dumps(sorted({re.sub(r'[-_.]+', '-', d.metadata['Name'] or '').lower(): d.version "
    "for d in m.distributions()}.items())))"
)


async def installed_packages() -> dict[str, str]:
    """Python distributions installed in the sandbox environment (read once, by its own interpreter), keyed by their
    PEP 503 normalized names, as list_environments reports them."""
    global _packages
    if _packages is None:
        proc = await asyncio.create_subprocess_exec(
            sandbox.PYTHON,
            "-c",
            PACKAGES_SCRIPT,
            env=sandbox.child_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), PACKAGES_TIMEOUT_S)
        except TimeoutError:
            proc.kill()
            raise
        _packages = {name: version for name, version in json.loads(stdout) if name and name != "pip"}
    return _packages


def microvm_uptime() -> float | None:
    """Seconds since the microVM booted. The wall clock inside a restored microVM is not elapsed time."""
    try:
        return round(float(Path("/proc/uptime").read_text().split()[0]), 1)
    except (OSError, ValueError, IndexError):
        return None


def memory_mib() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def sandbox_instance() -> str:
    """Random ID of this sandbox process, created on first use.

    It is created lazily because a microVM can be restored from a snapshot taken after the module was imported, in
    which case an ID made at import time would be the same in every sandbox.
    """
    global _instance
    if _instance is None:
        _instance = secrets.token_hex(8)
    return _instance


def session_info(ctx: Context) -> dict[str, Any]:
    """A short digest of the Runtime session ID (never the ID itself) and how long this process has served it."""
    session = (ctx.headers or {}).get(SESSION_HEADER) if ctx else None
    if not session:
        return {"runtime_session": None, "session_age_seconds": None}
    digest = hashlib.sha256(session.encode()).hexdigest()[:12]
    first_seen = _sessions.setdefault(digest, time.monotonic())
    return {"runtime_session": digest, "session_age_seconds": round(time.monotonic() - first_seen, 1)}


# ---------------------------------------------------------------------------------------------------------------------
# Tools

READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

PathArg = Annotated[str, Field(description="Path in the sandbox: absolute, or relative to /workspace.")]
MaxOutput = Annotated[
    int,
    Field(
        ge=1,
        le=sandbox.MAX_OUTPUT_BYTES,
        description=f"Maximum bytes of stdout and of stderr to return (the tail), 1 to {sandbox.MAX_OUTPUT_BYTES}.",
    ),
]


@mcp.tool(title="Get sandbox information", annotations=READ, structured_output=False)
@tool_errors
async def get_sandbox_info(ctx: Context) -> str:
    """Describe the user's sandbox for this environment: its title and description, installed Python packages and
    versions, CPUs, memory, free disk, running jobs, limits, files in /workspace, and how long the sandbox has been up.
    Call it before the first execute_code of a task: the sandbox is shared by the user's conversations and may hold
    files from earlier work. Call it again if files you created are missing: a sandbox that was stopped after being
    idle comes back empty, with a new sandbox_instance."""
    disk = shutil.disk_usage(sandbox.WORKDIR)
    workspace_entries = sum(1 for _ in sandbox.WORKDIR.iterdir()) if sandbox.WORKDIR.is_dir() else 0
    return result(
        {
            "environment": ENVIRONMENT,
            "title": TITLE,
            "description": DESCRIPTION,
            "sandbox_instance": sandbox_instance(),
            **session_info(ctx),
            "microvm_uptime_seconds": microvm_uptime(),
            "server_uptime_seconds": round(time.monotonic() - STARTED, 1),
            "workdir": str(sandbox.WORKDIR),
            "workspace_entries": workspace_entries,
            "python_version": platform.python_version(),
            "python_packages": await installed_packages(),
            "cpu_count": os.cpu_count(),
            "memory_mib": memory_mib(),
            "disk_free_gib": round(disk.free / 2**30, 2),
            "running_jobs": SANDBOX.running_jobs(),
            "limits": {
                "max_timeout_seconds": sandbox.MAX_TIMEOUT_S,
                "max_output_bytes": sandbox.MAX_OUTPUT_BYTES,
                "max_read_bytes": sandbox.MAX_READ_BYTES,
                "max_write_chars": sandbox.MAX_WRITE_CHARS,
                "max_running_jobs": sandbox.MAX_RUNNING_JOBS,
            },
        }
    )


@mcp.tool(
    title="Execute code",
    description=(
        "Run Python or bash code in the sandbox and return status, exit_code, stdout and stderr. Python runs in the "
        "environment's own virtual environment, which has only that environment's packages (get_sandbox_info lists "
        "them); packages cannot be installed. Each call is a new process: no variables survive between calls, so "
        "write intermediate results to files under /workspace (in a directory named for the task, since other "
        "conversations share the sandbox) and read them back in later calls. Save figures and images to files. The "
        "sandbox has no internet access: code cannot download data, call web APIs or fetch example datasets, so "
        "pass inputs with write_file. Use background=true for work longer than about a minute, then poll get_job."
    ),
    annotations=ToolAnnotations(
        read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=True
    ),
    structured_output=False,
)
@tool_errors
async def execute_code(
    code: Annotated[
        str,
        Field(
            min_length=1,
            max_length=sandbox.MAX_CODE_CHARS,
            description=f"Source code to run, up to {sandbox.MAX_CODE_CHARS} characters.",
        ),
    ],
    language: Annotated[Literal["python", "bash"], Field(description="python (default) or bash.")] = "python",
    cwd: Annotated[str | None, Field(description="Working directory (default /workspace).")] = None,
    timeout_seconds: Annotated[
        int,
        Field(
            ge=1,
            le=sandbox.MAX_TIMEOUT_S,
            description=(
                f"Seconds to wait before the process is killed, 1 to {sandbox.MAX_TIMEOUT_S} (default "
                f"{sandbox.DEFAULT_TIMEOUT_S}). Ignored with background=true."
            ),
        ),
    ] = sandbox.DEFAULT_TIMEOUT_S,
    background: Annotated[
        bool, Field(description="Start the process and return a job_id at once; poll it with get_job.")
    ] = False,
    max_output_bytes: MaxOutput = sandbox.DEFAULT_OUTPUT_BYTES,
) -> str:
    return result(
        await SANDBOX.execute(code, language, cwd, timeout_seconds, background, max_output_bytes),
    )


@mcp.tool(title="Get job", annotations=READ, structured_output=False)
@tool_errors
async def get_job(
    job_id: Annotated[
        str | None,
        Field(max_length=64, description="Job ID from execute_code. Omit it to list all jobs in this sandbox."),
    ] = None,
    wait_seconds: Annotated[
        int,
        Field(
            ge=0,
            le=sandbox.MAX_TIMEOUT_S,
            description=f"Seconds to wait for the job to finish before returning, 0 to {sandbox.MAX_TIMEOUT_S}.",
        ),
    ] = 0,
    max_output_bytes: MaxOutput = sandbox.DEFAULT_OUTPUT_BYTES,
) -> str:
    """Get the status, exit_code and output tail of a job started by execute_code, optionally waiting for it to
    finish. Without job_id, list the jobs in this sandbox."""
    return result(await SANDBOX.get_job(job_id, wait_seconds, max_output_bytes))


@mcp.tool(
    title="Cancel job",
    annotations=ToolAnnotations(
        read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False
    ),
    structured_output=False,
)
@tool_errors
async def cancel_job(job_id: Annotated[str, Field(max_length=64, description="Job ID to cancel.")]) -> str:
    """Kill a running job and its child processes and return its final status and output tail."""
    return result(SANDBOX.cancel_job(job_id))


@mcp.tool(title="Read file", annotations=READ, structured_output=False)
@tool_errors
async def read_file(
    path: PathArg,
    encoding: Annotated[
        Literal["text", "base64"], Field(description="text (UTF-8, default) or base64 for binary files.")
    ] = "text",
    offset: Annotated[int, Field(ge=0, description="Byte offset to start reading from (default 0).")] = 0,
    max_bytes: Annotated[
        int,
        Field(
            ge=1,
            le=sandbox.MAX_READ_BYTES,
            description=f"Maximum bytes to read, 1 to {sandbox.MAX_READ_BYTES} (default {sandbox.DEFAULT_READ_BYTES}).",
        ),
    ] = sandbox.DEFAULT_READ_BYTES,
) -> str:
    """Read a file from the sandbox, up to 1 MiB per call (use offset to page through larger files). Use
    encoding=base64 for binary files such as PNG images."""
    return result(SANDBOX.read_file(path, encoding, offset, max_bytes))


@mcp.tool(
    title="Write file",
    annotations=ToolAnnotations(
        read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False
    ),
    structured_output=False,
)
@tool_errors
async def write_file(
    path: PathArg,
    content: Annotated[
        str,
        Field(
            max_length=sandbox.MAX_WRITE_CHARS,
            description=f"File content, up to {sandbox.MAX_WRITE_CHARS} characters: text, or base64 with encoding=base64.",
        ),
    ],
    encoding: Annotated[Literal["text", "base64"], Field(description="text (default) or base64.")] = "text",
    append: Annotated[bool, Field(description="Append instead of overwriting.")] = False,
    executable: Annotated[bool, Field(description="Make the file executable.")] = False,
) -> str:
    """Write a file into the sandbox (for example input data such as CSV, TSV, SMILES, SDF or VCF text), creating
    parent directories. Overwrites an existing file unless append=true."""
    return result(SANDBOX.write_file(path, content, encoding, append, executable))


@mcp.tool(title="List files", annotations=READ, structured_output=False)
@tool_errors
async def list_files(
    path: Annotated[str | None, Field(description="Directory (default /workspace).")] = None,
    recursive: Annotated[bool, Field(description="Include subdirectories (at most 5000 entries).")] = False,
) -> str:
    """List the files in a sandbox directory with their type and size."""
    return result(SANDBOX.list_files(path, recursive))


# ---------------------------------------------------------------------------------------------------------------------
# AgentCore Runtime health check


@mcp.custom_route("/ping", methods=["GET"], include_in_schema=False)
async def ping(_: Request) -> JSONResponse:
    """`HealthyBusy` while jobs run, so the Runtime does not stop the session as idle."""
    return JSONResponse(SANDBOX.ping_status())


# ---------------------------------------------------------------------------------------------------------------------
# Entry point


def transport_security(host: str) -> TransportSecuritySettings | None:
    """Host/Origin validation for the HTTP transport.

    On loopback the SDK enables DNS rebinding protection itself (None keeps that default). Elsewhere the server only
    runs inside AgentCore Runtime, which accepts nothing but SigV4-signed InvokeAgentRuntime calls and forwards them
    with a platform-chosen Host header; the container port is never published, so the Host header is not a trust
    boundary and the check is disabled there.
    """
    if host in LOOPBACK_HOSTS:
        return None
    return TransportSecuritySettings(enable_dns_rebinding_protection=False)


def http_options(host: str) -> dict[str, Any]:
    """Streamable HTTP settings shared by `main()` and the tests."""
    return {
        "streamable_http_path": "/mcp",
        "stateless_http": True,
        "json_response": True,
        "max_request_body_size": MAX_REQUEST_BODY_BYTES,
        "transport_security": transport_security(host),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Code sandbox MCP server (run it inside its container)")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default=os.getenv("MCP_TRANSPORT", "stdio"),
        help="stdio for a local client, streamable-http for AgentCore Runtime (default: $MCP_TRANSPORT or stdio)",
    )
    parser.add_argument("--host", default=os.getenv("MCP_HOST", "127.0.0.1"), help="HTTP bind address")
    parser.add_argument("--port", type=int, default=int(os.getenv("MCP_PORT", "8000")), help="HTTP port")
    args = parser.parse_args()
    sandbox.WORKDIR.mkdir(parents=True, exist_ok=True)
    if args.transport == "stdio":
        mcp.run()
        return
    # AgentCore Runtime and Gateway: stateless request/response with plain JSON bodies, no SSE
    mcp.run("streamable-http", host=args.host, port=args.port, **http_options(args.host))


if __name__ == "__main__":
    main()
