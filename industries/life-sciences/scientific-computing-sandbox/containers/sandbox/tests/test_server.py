# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The server as AgentCore Runtime and Gateway reach it: stateless Streamable HTTP with JSON bodies on /mcp."""

import base64
import json
import os
import re
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from code_sandbox_mcp import sandbox, server

# AWS Quick does not support the latest MCP revision yet and negotiates this one
QUICK_PROTOCOL_VERSION = "2025-03-26"
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
SESSION_ID = "11111111-2222-3333-4444-555555555555"
SNAPSHOT = Path(__file__).parent.parent.parent.parent / "lib" / "tools" / "server-tools.json"


def container_host() -> str:
    """The bind address the Dockerfile gives the server in AgentCore Runtime (its MCP_HOST)."""
    match = re.search(r"^\s*MCP_HOST=(\S+)", (Path(__file__).parent.parent / "Dockerfile").read_text(), re.M)
    assert match, "the Dockerfile must set MCP_HOST"
    return match.group(1)


# The tests serve the app the way the container does.
CONTAINER_HOST = container_host()


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = server.mcp.streamable_http_app(host=CONTAINER_HOST, **server.http_options(CONTAINER_HOST))
    with TestClient(app, base_url="http://bedrock-agentcore.invalid") as c:
        yield c


def rpc(client: TestClient, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    res = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={**HEADERS, "MCP-Protocol-Version": QUICK_PROTOCOL_VERSION, server.SESSION_HEADER: SESSION_ID},
    )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/json")
    body = res.json()
    assert "error" not in body, body
    return body["result"]


def call(client: TestClient, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    out = rpc(client, "tools/call", {"name": name, "arguments": arguments or {}})
    assert not out.get("isError"), out
    return json.loads(out["content"][0]["text"])


def call_error(client: TestClient, name: str, arguments: dict[str, Any]) -> str:
    """The error message, without the SDK's `Error executing tool <name>: ` prefix."""
    out = rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert out.get("isError") is True, out
    text = out["content"][0]["text"]
    prefix = f"Error executing tool {name}: "
    return text.removeprefix(prefix)


def test_initialize_negotiates_quick_protocol(client: TestClient) -> None:
    init = rpc(
        client,
        "initialize",
        {"protocolVersion": QUICK_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
    )
    assert init["protocolVersion"] == QUICK_PROTOCOL_VERSION
    assert "'chem' (Cheminformatics)" in init["instructions"]
    assert "RDKit" in init["instructions"]


def test_accepts_a_caller_chosen_mcp_session_id(client: TestClient) -> None:
    """The tools Lambda sends its own session ID as Mcp-Session-Id; a stateless server must not reject it."""
    res = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_files", "arguments": {}}},
        headers={**HEADERS, "MCP-Protocol-Version": QUICK_PROTOCOL_VERSION, "Mcp-Session-Id": "a" * 64},
    )
    assert res.status_code == 200, res.text
    assert not res.json()["result"].get("isError"), res.text


def test_tools_and_annotations(client: TestClient) -> None:
    tools = {t["name"]: t for t in rpc(client, "tools/list")["tools"]}
    assert set(tools) == {
        "get_sandbox_info",
        "execute_code",
        "get_job",
        "cancel_job",
        "read_file",
        "write_file",
        "list_files",
    }
    for name in ("get_sandbox_info", "get_job", "read_file", "list_files"):
        assert tools[name]["annotations"]["readOnlyHint"] is True, name
        assert tools[name]["annotations"]["destructiveHint"] is False, name
    for name in ("execute_code", "cancel_job", "write_file"):
        assert tools[name]["annotations"]["readOnlyHint"] is False, name
        assert tools[name]["annotations"]["destructiveHint"] is True, name
    assert tools["execute_code"]["annotations"]["openWorldHint"] is True
    # Every environment's server lists the same tools: the Gateway publishes one schema for all of them.
    for tool in tools.values():
        for environment_specific in ("'chem'", " chem ", server.TITLE, server.DESCRIPTION, "RDKit"):
            assert environment_specific not in json.dumps(tool), (tool["name"], environment_specific)
        assert "environment" not in tool["inputSchema"].get("properties", {}), "reserved for the Gateway"
    for tool in tools.values():
        schema = tool["inputSchema"]
        assert schema["type"] == "object"
        assert isinstance(schema.get("required", []), list)


def test_tool_snapshot_matches_server() -> None:
    import asyncio
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "tools_snapshot", Path(__file__).parent.parent / "scripts" / "tools_snapshot.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    expected = module.render(asyncio.run(module.snapshot()))
    assert SNAPSHOT.read_text() == expected, "lib/tools/server-tools.json is stale: run `npm run tools:snapshot`"


def test_execute_python_and_files_persist_between_calls(client: TestClient) -> None:
    out = call(client, "execute_code", {"code": "open('state.txt', 'w').write('42')\nprint('saved')"})
    assert out["status"] == "succeeded"
    assert out["exit_code"] == 0
    assert out["stdout"] == "saved\n"
    again = call(client, "execute_code", {"code": "print(open('state.txt').read())"})
    assert again["stdout"] == "42\n"
    listing = call(client, "list_files", {})
    assert {"path": "state.txt", "type": "file", "size": 2} in listing["entries"]


def test_execute_bash_reports_failure(client: TestClient) -> None:
    out = call(client, "execute_code", {"language": "bash", "code": "echo out; echo err >&2; exit 3"})
    assert out["status"] == "failed"
    assert out["exit_code"] == 3
    assert out["stdout"] == "out\n"
    assert out["stderr"] == "err\n"


def test_child_environment_is_scrubbed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "do-not-leak")
    out = call(client, "execute_code", {"code": "import os, json; print(json.dumps(dict(os.environ)))"})
    env = json.loads(out["stdout"])
    assert not any(k.startswith("AWS_") for k in env)
    assert env["HOME"] == os.environ["SANDBOX_HOME"]


def test_timeout_kills_process(client: TestClient) -> None:
    started = time.monotonic()
    out = call(client, "execute_code", {"language": "bash", "code": "sleep 30", "timeout_seconds": 1})
    assert out["status"] == "timed_out"
    assert time.monotonic() - started < 10


def test_output_is_truncated_to_tail(client: TestClient) -> None:
    out = call(client, "execute_code", {"code": "print('x' * 5000 + 'END')", "max_output_bytes": 100})
    assert out["stdout_truncated"] is True
    assert out["stdout"].endswith("END\n")
    assert len(out["stdout"].encode()) <= 100


def test_background_job_lifecycle_and_ping(client: TestClient) -> None:
    assert client.get("/ping").json()["status"] == "Healthy"
    job = call(client, "execute_code", {"language": "bash", "code": "sleep 30", "background": True})
    assert job["status"] == "running"
    ping = client.get("/ping").json()
    assert ping["status"] == "HealthyBusy"
    assert client.get("/ping").json()["time_of_last_update"] == ping["time_of_last_update"]
    listed = call(client, "get_job", {})
    assert job["job_id"] in [j["job_id"] for j in listed["jobs"]]
    cancelled = call(client, "cancel_job", {"job_id": job["job_id"]})
    assert cancelled["status"] == "cancelled"
    assert client.get("/ping").json()["status"] == "Healthy"


def test_get_job_waits_for_completion(client: TestClient) -> None:
    job = call(client, "execute_code", {"code": "import time; time.sleep(0.5); print('done')", "background": True})
    out = call(client, "get_job", {"job_id": job["job_id"], "wait_seconds": 20})
    assert out["status"] == "succeeded"
    assert out["stdout"] == "done\n"


def test_unknown_job(client: TestClient) -> None:
    assert call_error(client, "get_job", {"job_id": "nope"}).startswith("JOB_NOT_FOUND")


def test_running_job_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox, "MAX_RUNNING_JOBS", 1)
    job = call(client, "execute_code", {"language": "bash", "code": "sleep 30", "background": True})
    try:
        assert call_error(client, "execute_code", {"code": "print(1)"}).startswith("TOO_MANY_JOBS")
    finally:
        call(client, "cancel_job", {"job_id": job["job_id"]})


def test_write_and_read_text_and_base64(client: TestClient) -> None:
    written = call(client, "write_file", {"path": "inputs/mols.smi", "content": "CCO ethanol\n"})
    assert written["bytes_written"] == 12
    call(client, "write_file", {"path": "inputs/mols.smi", "content": "c1ccccc1 benzene\n", "append": True})
    text = call(client, "read_file", {"path": "inputs/mols.smi"})
    assert text["content"] == "CCO ethanol\nc1ccccc1 benzene\n"
    assert text["truncated"] is False

    png = bytes(range(256))
    call(client, "write_file", {"path": "bin.dat", "content": base64.b64encode(png).decode(), "encoding": "base64"})
    data = call(client, "read_file", {"path": "bin.dat", "encoding": "base64", "offset": 16, "max_bytes": 16})
    assert base64.b64decode(data["content"]) == png[16:32]
    assert data["truncated"] is True
    assert call_error(client, "read_file", {"path": "bin.dat"}).startswith("NOT_TEXT")


def test_file_errors_do_not_echo_paths(client: TestClient) -> None:
    message = call_error(client, "read_file", {"path": "secret-name-xyz.txt"})
    assert message.startswith("FILE_NOT_FOUND")
    assert "secret-name-xyz" not in message
    assert call_error(client, "write_file", {"path": "x", "content": "@@", "encoding": "base64"}).startswith(
        "INVALID_INPUT"
    )


def test_schema_bounds_are_enforced(client: TestClient) -> None:
    call_error(client, "execute_code", {"code": "print(1)", "timeout_seconds": sandbox.MAX_TIMEOUT_S + 1})
    call_error(client, "execute_code", {"code": "x" * (sandbox.MAX_CODE_CHARS + 1)})
    call_error(client, "execute_code", {"code": "print(1)", "language": "ruby"})
    call_error(client, "read_file", {"path": "x", "max_bytes": sandbox.MAX_READ_BYTES + 1})


def test_sandbox_info(client: TestClient) -> None:
    info = call(client, "get_sandbox_info")
    assert info["environment"] == "chem"
    assert info["title"] == "Cheminformatics"
    assert "RDKit" in info["description"]
    assert info["runtime_session"] and SESSION_ID not in json.dumps(info)
    assert info["sandbox_instance"] == call(client, "get_sandbox_info")["sandbox_instance"]
    assert "pytest" in info["python_packages"]
    assert info["limits"]["max_timeout_seconds"] == sandbox.MAX_TIMEOUT_S


def test_unexpected_errors_are_generic(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_: Any, **__: Any) -> None:
        raise RuntimeError("detail-with-user-data")

    monkeypatch.setattr(server.SANDBOX, "list_files", boom)
    message = call_error(client, "list_files", {})
    assert message.startswith("INTERNAL_ERROR")
    assert "detail-with-user-data" not in message


def test_loopback_keeps_dns_rebinding_protection() -> None:
    assert server.transport_security("127.0.0.1") is None
    assert server.transport_security(CONTAINER_HOST) is not None
