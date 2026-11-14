# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Tool catalog of the server, as `lib/tools/bio-viewers-tools.json` stores it for the CDK tests.

uv run python scripts/tools_snapshot.py > ../../lib/tools/bio-viewers-tools.json
"""

import asyncio
import json
from typing import Any

from bio_viewers_mcp.server import mcp

KEYS = ("name", "title", "description", "inputSchema", "annotations")


async def snapshot() -> list[dict[str, Any]]:
    tools = [t.model_dump(by_alias=True, exclude_none=True) for t in await mcp.list_tools()]
    return [{k: t[k] for k in KEYS if k in t} for t in tools]


def render(tools: list[dict[str, Any]]) -> str:
    return json.dumps(tools, indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    print(render(asyncio.run(snapshot())), end="")
