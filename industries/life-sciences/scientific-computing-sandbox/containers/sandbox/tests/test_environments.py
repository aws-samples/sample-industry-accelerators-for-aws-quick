# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The environment layers: definitions, locks, the generated catalog, and the Dockerfile stages."""

import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest

SANDBOX_DIR = Path(__file__).parent.parent


def _module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "sandbox_environments", SANDBOX_DIR / "scripts" / "sandbox_environments.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


envs = _module()
LAYERS = envs.load_layers()
BY_ID = {layer.id: layer for layer in LAYERS}
DEPLOYED = [layer for layer in LAYERS if layer.deploy]


def test_layers_form_one_tree_rooted_at_general() -> None:
    assert LAYERS[0].id == "general" and LAYERS[0].parent is None
    assert {layer.id for layer in DEPLOYED} == {
        "general",
        "chem",
        "dicom",
        "vcf",
        "rnaseq",
        "multiomics",
        "sctraj",
    }
    assert not BY_ID["scbase"].deploy
    assert [item.id for item in envs.lineage(BY_ID["sctraj"], LAYERS)] == ["general", "scbase", "sctraj"]


@pytest.mark.parametrize("layer", LAYERS, ids=lambda layer: layer.id)
def test_lock_pins_every_direct_dependency(layer) -> None:
    locked = envs.read_lock(layer.lock_file)
    for name, version in layer.pins.items():
        assert locked.get(name) == version, f"{layer.id}: {name}=={version} is not in its lock; run `make lock`"
    text = layer.lock_file.read_text()
    entries = re.findall(r"^[A-Za-z0-9][^\s]*==\S+ \\\n((?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\n)+)", text, re.M)
    assert len(entries) == len(locked), f"{layer.id}: every lock entry needs hashes"


@pytest.mark.parametrize("layer", [layer for layer in LAYERS if layer.parent], ids=lambda layer: layer.id)
def test_child_lock_keeps_every_parent_pin(layer) -> None:
    """A child stage installs on top of its parent's: a changed pin would duplicate or replace a parent package."""
    parent = envs.read_lock(BY_ID[layer.parent].lock_file)
    child = envs.read_lock(layer.lock_file)
    changed = {name: (version, child.get(name)) for name, version in parent.items() if child.get(name) != version}
    assert not changed, f"{layer.id} changes pins of {layer.parent}: {changed}; run `make lock`"


def test_no_gpu_builds_or_unexpected_heavy_frameworks() -> None:
    for layer in LAYERS:
        locked = envs.read_lock(layer.lock_file)
        gpu = [name for name in locked if name.startswith(("nvidia-", "cuda-")) or name in ("triton", "jaxlib")]
        assert not gpu, f"{layer.id}: {gpu}"
        assert "torch" not in locked, f"{layer.id}: PyTorch is not part of any environment"


def test_other_indexes_serve_only_their_own_package() -> None:
    """A layer's explicit index supplies only the package that names it, and the lock tells the build where it is."""
    for layer in LAYERS:
        lines = [line for line in layer.lock_file.read_text().splitlines() if line.startswith("--")]
        assert lines == [f"--find-links {page}" for page in layer.find_links], layer.id


@pytest.mark.parametrize(
    "uv, message",
    [
        (
            {"index": [{"name": "x", "url": "https://example.test/simple"}], "sources": {"numpy": {"index": "x"}}},
            "explicit",
        ),
        ({"index": [{"name": "x", "url": "http://example.test", "explicit": True}]}, "https"),
        (
            {
                "index": [{"name": "x", "url": "https://example.test", "explicit": True}],
                "sources": {"numpy": {"index": "y"}},
            },
            "name one",
        ),
        (
            {
                "index": [{"name": "x", "url": "https://example.test", "explicit": True}],
                "sources": {"rich": {"index": "x"}},
            },
            "pinned",
        ),
        ({"sources": {"numpy": {"git": "https://example.test/numpy.git"}}}, "name one"),
    ],
)
def test_rejects_unsafe_index_sources(uv, message) -> None:
    with pytest.raises(ValueError, match=message):
        envs._find_links("demo", uv, {"numpy": "2.5.4"})


def test_catalog_is_current() -> None:
    assert envs.CATALOG_FILE.read_text() == envs.render_catalog(envs.catalog()), (
        "lib/sandbox/catalog.json is stale: run `npm run environments:catalog`"
    )


def test_readme_environment_table_is_current() -> None:
    readme = envs.README_FILE.read_text()
    assert envs.updated_readme(readme, envs.render_readme_table(envs.catalog())) == readme, (
        "the README environment table is stale: run `npm run environments:catalog`"
    )


def test_catalog_lists_versions_from_the_locks() -> None:
    catalog = envs.catalog()
    by_id = {env["id"]: env for env in catalog["environments"]}
    chem = by_id["chem"]
    assert [p["name"] for p in chem["packages"]] == ["numpy", "pandas", "scipy", "rdkit", "mmpdb"]
    assert {p["name"]: p.get("import") for p in chem["packages"]}["mmpdb"] == "mmpdblib"
    assert chem["installed"]["rdkit"] == BY_ID["chem"].pins["rdkit"]
    sctraj = by_id["sctraj"]
    assert {"scanpy", "scvelo", "cellrank", "squidpy"} <= {p["name"] for p in sctraj["packages"]}
    assert "matplotlib" in {p["name"] for p in sctraj["also_installed"]}
    assert [p["name"] for p in by_id["dicom"]["programs"]] == ["dcm2niix"]


def test_dockerfile_has_a_stage_per_layer_on_its_parent() -> None:
    dockerfile = (SANDBOX_DIR / "Dockerfile").read_text()
    stages = {child: parent for parent, child in re.findall(r"^FROM (\S+) AS env-(\w+)$", dockerfile, re.M)}
    assert set(stages) == set(BY_ID), "add a Dockerfile stage for each environment layer"
    for layer in LAYERS:
        assert stages[layer.id] == (f"env-{layer.parent}" if layer.parent else "base"), layer.id
        assert f"source=environments/{layer.id}/requirements.txt" in dockerfile, layer.id


def test_build_requirements_are_hashed_and_pinned() -> None:
    locked = envs.read_lock(SANDBOX_DIR / "build-requirements.txt")
    assert {"uv", "setuptools"} <= set(locked)
    assert "--hash=sha256:" in (SANDBOX_DIR / "build-requirements.txt").read_text()


def test_dockerignore_admits_only_what_the_build_needs() -> None:
    ignore = (SANDBOX_DIR / ".dockerignore").read_text().split()
    assert ignore[0] == "**"
    assert "!environments/*/requirements.txt" in ignore and "!environments/*/pyproject.toml" in ignore
