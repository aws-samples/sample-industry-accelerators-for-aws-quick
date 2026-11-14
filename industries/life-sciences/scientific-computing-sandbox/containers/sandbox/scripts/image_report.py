# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Size and layer-sharing report for locally built environment images (`make image-report`).

    uv run --frozen python scripts/image_report.py REPORT_DIR [--platform-version V2]

Reads what `make image-report` writes to REPORT_DIR with the container CLI; the script runs no commands itself:

- `layer-<layer>.json`: `image inspect` output for `code-sandbox-layer:<layer>` (the env-<layer> Dockerfile stage), for
  every layer.
- `image-<environment>.json`: `image inspect` output for `code-sandbox-mcp:<environment>`, for every deployed
  environment.
- `image-<environment>.gzip-bytes`: that image's compressed size in bytes, from `save` piped through `gzip -c`, which
  compresses at the default level as a registry push does.

For each environment it prints the image's uncompressed and compressed size, the size of its own layer stage beyond its
parent's, and checks that the image contains every image layer of each ancestor stage unchanged (so the ancestors are
stored once).

AgentCore Runtime limits the compressed image size: 2 GB on platform version V1, 10 GB on V2, where images over 2 GB
also need a resource configuration. The platform version defaults to RUNTIME_PLATFORM_VERSION in the Runtime stack.
Fails when an image exceeds the limit or does not reuse an ancestor's layers.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
CATALOG = REPO / "lib" / "sandbox" / "catalog.json"
RUNTIME_STACK = REPO / "lib" / "stacks" / "sandbox-runtime-stack.ts"
GB = 1000**3
# Compressed image size limits per platform version.
LIMIT_BYTES = {"V1": 2 * GB, "V2": 10 * GB}
# On V2, larger images need a resource configuration, which the Runtime stack does not set.
V2_WITHOUT_RESOURCE_CONFIGURATION_BYTES = 2 * GB


def stack_platform_version(source: str) -> str:
    """The platform version the Runtime stack deploys, from its RUNTIME_PLATFORM_VERSION constant."""
    match = re.search(r"^export const RUNTIME_PLATFORM_VERSION = agentcore\.PlatformVersion\.(\w+);$", source, re.M)
    if not match:
        raise SystemExit(f"RUNTIME_PLATFORM_VERSION not found in {RUNTIME_STACK}")
    return match.group(1)


def size_failure(env_id: str, compressed: int, platform_version: str) -> str | None:
    """Why an image of this compressed size cannot run on the platform version, or None if it can."""
    limit = LIMIT_BYTES[platform_version]
    if compressed > limit:
        return (
            f"{env_id} is {compressed / GB:.2f} GB compressed, above AgentCore Runtime's "
            f"{limit / GB:.0f} GB limit on {platform_version}"
        )
    if platform_version == "V2" and compressed > V2_WITHOUT_RESOURCE_CONFIGURATION_BYTES:
        return (
            f"{env_id} is {compressed / GB:.2f} GB compressed; V2 images over 2 GB need a resource configuration, "
            "which the Runtime stack does not set"
        )
    return None


def _input(report_dir: Path, name: str) -> str:
    path = report_dir / name
    if not path.is_file():
        raise SystemExit(f"{path} not found; run `make image-report`, which writes it")
    return path.read_text()


def inspected(report_dir: Path, name: str) -> tuple[int, list[str]]:
    """An image's uncompressed size and layer digests, from its saved `image inspect` output."""
    data = json.loads(_input(report_dir, name))[0]
    return int(data["Size"]), list(data["RootFS"]["Layers"])


def compressed_size(report_dir: Path, env_id: str) -> int:
    """An environment image's gzipped size in bytes, as `make image-report` measured it."""
    name = f"image-{env_id}.gzip-bytes"
    text = _input(report_dir, name).strip()
    if not text.isdigit() or int(text) == 0:
        raise SystemExit(f"{report_dir / name} does not hold a byte count: {text!r}")
    return int(text)


def report(report_dir: Path, layers: list[dict[str, Any]], platform_version: str) -> tuple[list[str], list[str]]:
    """The report's lines and the failures, for the layers in the catalog."""
    stages = {e["id"]: inspected(report_dir, f"layer-{e['id']}.json") for e in layers}
    lines = [
        f"Platform version {platform_version}: compressed limit {LIMIT_BYTES[platform_version] / GB:.0f} GB",
        "",
        "| Environment | Image size (MB) | Compressed (MB) | Stage adds over parent (MB) | Parent "
        "| Reuses every ancestor layer |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    failures = []
    for env in (e for e in layers if e["deploy"]):
        size, image_layers = inspected(report_dir, f"image-{env['id']}.json")
        compressed = compressed_size(report_dir, env["id"])
        parent = env["parent"]
        own = stages[env["id"]][0] - (stages[parent][0] if parent else 0)
        reused = all(set(stages[a][1]) <= set(image_layers) for a in env["lineage"])
        lines.append(
            f"| `{env['id']}` | {size / 1e6:.0f} | {compressed / 1e6:.0f} | {own / 1e6:.0f} | {parent or '-'} "
            f"| {'yes' if reused else 'NO'} |"
        )
        if failure := size_failure(env["id"], compressed, platform_version):
            failures.append(failure)
        if not reused:
            failures.append(f"{env['id']} does not contain its ancestor stages' layers unchanged")
    return lines, failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report_dir", type=Path, help="directory holding the files `make image-report` writes")
    parser.add_argument(
        "--platform-version",
        choices=sorted(LIMIT_BYTES),
        help="check against this platform version's limit instead of the one the Runtime stack deploys",
    )
    args = parser.parse_args()
    platform_version = args.platform_version or stack_platform_version(RUNTIME_STACK.read_text())
    layers = json.loads(CATALOG.read_text())["environments"]
    lines, failures = report(args.report_dir, layers, platform_version)
    print("\n".join(lines))
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
