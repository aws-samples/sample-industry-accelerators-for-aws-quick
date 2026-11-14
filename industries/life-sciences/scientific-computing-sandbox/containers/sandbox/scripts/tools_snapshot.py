# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Tool catalog of the sandbox server, as `lib/tools/server-tools.json` stores it for the Gateway target schema and the
CDK tests.

    uv run python scripts/tools_snapshot.py > ../../lib/tools/server-tools.json

The tools are the same in every environment (the tests check that the descriptions do not depend on it), so one
snapshot serves all of them.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

KEYS = ("name", "title", "description", "inputSchema", "annotations")


def _configure(environment: str) -> None:
    os.environ["SANDBOX_ENVIRONMENT"] = environment
    os.environ["SANDBOX_ENVIRONMENT_FILE"] = str(
        Path(__file__).parent.parent / "environments" / environment / "pyproject.toml"
    )


async def snapshot() -> list[dict[str, Any]]:
    from code_sandbox_mcp.server import mcp

    tools = [t.model_dump(by_alias=True, exclude_none=True) for t in await mcp.list_tools()]
    return [{k: t[k] for k in KEYS if k in t} for t in tools]


def render(tools: list[dict[str, Any]]) -> str:
    return json.dumps(tools, indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    _configure(sys.argv[1] if len(sys.argv) > 1 else "general")
    print(render(asyncio.run(snapshot())), end="")
