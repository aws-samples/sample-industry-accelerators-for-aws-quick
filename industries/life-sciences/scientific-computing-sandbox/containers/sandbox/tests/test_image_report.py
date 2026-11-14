# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The image report's size limits, the platform version it reads from the Runtime stack, and the report it builds
from what `make image-report` saves."""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

SANDBOX_DIR = Path(__file__).parent.parent


def _module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("image_report", SANDBOX_DIR / "scripts" / "image_report.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


report = _module()
GB = report.GB


def test_reads_the_platform_version_the_runtime_stack_deploys():
    assert report.stack_platform_version(report.RUNTIME_STACK.read_text()) == "V1"


def test_v1_allows_compressed_images_up_to_2_gb():
    assert report.size_failure("sctraj", 2 * GB, "V1") is None
    assert "above AgentCore Runtime's 2 GB limit on V1" in report.size_failure("sctraj", 2 * GB + 1, "V1")


def test_v2_images_over_2_gb_need_a_resource_configuration():
    assert report.size_failure("sctraj", 2 * GB, "V2") is None
    assert "need a resource configuration" in report.size_failure("sctraj", 3 * GB, "V2")
    assert "above AgentCore Runtime's 10 GB limit on V2" in report.size_failure("sctraj", 10 * GB + 1, "V2")


LAYERS = [
    {"id": "general", "parent": None, "lineage": ["general"], "deploy": True},
    {"id": "scbase", "parent": "general", "lineage": ["general", "scbase"], "deploy": False},
    {"id": "sctraj", "parent": "scbase", "lineage": ["general", "scbase", "sctraj"], "deploy": True},
]


def _inspect_output(size: int, layers: list[str]) -> str:
    return json.dumps([{"Size": size, "RootFS": {"Type": "layers", "Layers": layers}}])


def _write_report_dir(directory: Path, sctraj_layers: list[str], sctraj_compressed: int = 500_000_000) -> Path:
    stages = {
        "general": (300_000_000, ["a"]),
        "scbase": (900_000_000, ["a", "b"]),
        "sctraj": (1_700_000_000, ["a", "b", "c"]),
    }
    for layer, (size, digests) in stages.items():
        (directory / f"layer-{layer}.json").write_text(_inspect_output(size, digests))
    (directory / "image-general.json").write_text(_inspect_output(310_000_000, ["a", "server"]))
    (directory / "image-sctraj.json").write_text(_inspect_output(1_710_000_000, [*sctraj_layers, "server"]))
    (directory / "image-general.gzip-bytes").write_text("  100000000\n")
    (directory / "image-sctraj.gzip-bytes").write_text(f"{sctraj_compressed}\n")
    return directory


def test_reports_deployed_environments_from_the_saved_inspect_output(tmp_path):
    lines, failures = report.report(_write_report_dir(tmp_path, ["a", "b", "c"]), LAYERS, "V1")
    assert failures == []
    assert "| `general` | 310 | 100 | 300 | - | yes |" in lines
    assert "| `sctraj` | 1710 | 500 | 800 | scbase | yes |" in lines
    assert not any(line.startswith("| `scbase`") for line in lines)


def test_fails_when_an_image_does_not_reuse_an_ancestor_layer(tmp_path):
    _, failures = report.report(_write_report_dir(tmp_path, ["a", "changed", "c"]), LAYERS, "V1")
    assert failures == ["sctraj does not contain its ancestor stages' layers unchanged"]


def test_fails_when_an_image_is_over_the_compressed_limit(tmp_path):
    _, failures = report.report(_write_report_dir(tmp_path, ["a", "b", "c"], 2 * GB + 1), LAYERS, "V1")
    assert len(failures) == 1
    assert "sctraj is 2.00 GB compressed, above AgentCore Runtime's 2 GB limit on V1" in failures[0]


def test_missing_or_invalid_inputs_stop_the_report(tmp_path):
    _write_report_dir(tmp_path, ["a", "b", "c"])
    (tmp_path / "image-sctraj.gzip-bytes").write_text("\n")
    with pytest.raises(SystemExit, match="does not hold a byte count"):
        report.report(tmp_path, LAYERS, "V1")
    (tmp_path / "image-sctraj.json").unlink()
    with pytest.raises(SystemExit, match="image-sctraj.json not found"):
        report.report(tmp_path, LAYERS, "V1")


def test_the_script_runs_no_commands():
    source = (SANDBOX_DIR / "scripts" / "image_report.py").read_text()
    assert "subprocess" not in source
    assert "os.system" not in source
