# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Calls a running environment container the way AgentCore Runtime does: plain JSON-RPC POSTs to /mcp, and GET /ping.

    uv run --frozen python scripts/smoke_test.py http://127.0.0.1:18000 --environment chem

`make test-container` builds and runs the image first. Checks, for every environment: the tools, package isolation,
environment scrubbing, background jobs and /ping; that every package in lib/sandbox/catalog.json is installed at its
catalog version and imports; that every catalog program runs; and a small analysis with the environment's main
packages. Needs no network access beyond the container.
"""

import argparse
import base64
import json
import sys
import time
from pathlib import Path

import httpx

PROTOCOL_VERSION = "2025-03-26"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    # AgentCore Runtime forwards requests with a platform-chosen Host header and its session ID
    "Host": "bedrock-agentcore.internal",
    "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "smoke-test-session-0000000000000000",
}
CATALOG = Path(__file__).resolve().parents[3] / "lib" / "sandbox" / "catalog.json"

# A small analysis per environment, using its main packages. Each prints one summary line.
ANALYSES = {
    "general": """
import numpy as np, pandas as pd
from scipy import stats
rng = np.random.default_rng(0)
df = pd.DataFrame({"group": ["a"] * 50 + ["b"] * 50, "value": np.r_[rng.normal(0, 1, 50), rng.normal(1, 1, 50)]})
t = stats.ttest_ind(*[g["value"] for _, g in df.groupby("group")])
assert t.pvalue < 0.05
print("t-test p", f"{t.pvalue:.2e}")
""",
    "chem": """
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors, Draw, rdFingerprintGenerator, rdFMCS, DataStructs
mol = Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")
hs = Chem.AddHs(mol)
assert AllChem.EmbedMolecule(hs, randomSeed=42) == 0
AllChem.MMFFOptimizeMolecule(hs)
Draw.MolToFile(mol, "aspirin.png", size=(300, 300))
gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
salicylic = Chem.MolFromSmiles("Oc1ccccc1C(=O)O")
sim = DataStructs.TanimotoSimilarity(gen.GetFingerprint(mol), gen.GetFingerprint(salicylic))
mcs = rdFMCS.FindMCS([mol, salicylic])
print(round(Descriptors.MolWt(mol), 2), Chem.MolToSmiles(mol), f"tanimoto={sim:.2f}", f"mcs_atoms={mcs.numAtoms}")
""",
    "dicom": """
import glob, subprocess, shutil, os
import nibabel as nib, pydicom
from pydicom.data import get_testdata_file
src = get_testdata_file("CT_small.dcm", download=False)
ds = pydicom.dcmread(src)
ds.PatientName = "Anonymous"
os.makedirs("dicom_in", exist_ok=True); os.makedirs("nifti_out", exist_ok=True)
ds.save_as("dicom_in/slice.dcm")
subprocess.run(["dcm2niix", "-z", "y", "-o", "nifti_out", "dicom_in"], check=True, capture_output=True)
img = nib.load(glob.glob("nifti_out/*.nii.gz")[0])
assert glob.glob("nifti_out/*.json"), "no BIDS sidecar"
print(ds.Modality, ds.pixel_array.shape, "-> NIfTI", img.shape)
""",
    "vcf": """
import pysam
open("mini.vcf", "w").write(
    "##fileformat=VCFv4.2\\n##contig=<ID=chr1,length=1000>\\n"
    '##INFO=<ID=gnomAD_AF,Number=1,Type=Float,Description="AF">\\n'
    "#CHROM\\tPOS\\tID\\tREF\\tALT\\tQUAL\\tFILTER\\tINFO\\n"
    "chr1\\t100\\t.\\tA\\tG\\t50\\tPASS\\tgnomAD_AF=0.0001\\nchr1\\t200\\t.\\tC\\tT\\t50\\tPASS\\tgnomAD_AF=0.2\\n"
)
pysam.tabix_index("mini.vcf", preset="vcf", force=True)
vcf = pysam.VariantFile("mini.vcf.gz")
rare = [r.pos for r in vcf.fetch("chr1", 0, 1000) if r.info["gnomAD_AF"] < 0.01]
assert rare == [100], rare
print("rare variants", rare)
""",
    "rnaseq": """
import numpy as np, pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.default_inference import DefaultInference
from pydeseq2.ds import DeseqStats
rng = np.random.default_rng(0)
counts = pd.DataFrame(rng.negative_binomial(5, 0.1, size=(6, 200)), index=[f"s{i}" for i in range(6)],
                      columns=[f"g{j}" for j in range(200)])
counts.iloc[3:, :10] *= 8
meta = pd.DataFrame({"condition": ["control"] * 3 + ["treated"] * 3}, index=counts.index)
dds = DeseqDataSet(counts=counts, metadata=meta, design="~condition", inference=DefaultInference(n_cpus=1), quiet=True)
dds.deseq2()
stats = DeseqStats(dds, contrast=["condition", "treated", "control"], inference=DefaultInference(n_cpus=1), quiet=True)
stats.summary()
hits = stats.results_df.query("padj < 0.05").index
assert {"g0", "g1"} <= set(hits), list(hits)[:10]
print("significant genes", len(hits))
""",
    "multiomics": """
import numpy as np, pandas as pd
import mofapy2, gseapy, sklearn
from combat.pycombat import pycombat
from sklearn.decomposition import PCA
rng = np.random.default_rng(0)
data = pd.DataFrame(rng.normal(5, 1, size=(100, 12)), index=[f"g{i}" for i in range(100)],
                    columns=[f"s{j}" for j in range(12)])
data.iloc[:, 6:] += 3
corrected = pycombat(data, [1] * 6 + [2] * 6)
gap = abs(corrected.iloc[:, :6].values.mean() - corrected.iloc[:, 6:].values.mean())
assert gap < 0.5, gap
pcs = PCA(n_components=2).fit_transform(corrected.T)
# Over-representation against local gene sets, the offline replacement for Enrichr.
genes = list(data.index)
ora = gseapy.enrich(gene_list=genes[:10], gene_sets={"up": genes[:15], "other": genes[50:80]}, background=genes,
                    outdir=None).results
top = ora.sort_values("Adjusted P-value").iloc[0]
assert top["Term"] == "up", ora[["Term", "Adjusted P-value"]]
print("combat batch gap", round(gap, 3), "pcs", pcs.shape, "top gene set", top["Term"])
""",
    "sctraj": """
import numpy as np, anndata as ad, scanpy as sc
import scvelo, cellrank, squidpy
rng = np.random.default_rng(0)
# Three cell groups, each expressing its own 50 marker genes.
x = rng.poisson(1, size=(300, 200)).astype(np.float32)
for group in range(3):
    x[group * 100 : (group + 1) * 100, group * 50 : (group + 1) * 50] += rng.poisson(8, size=(100, 50))
adata = ad.AnnData(x)
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
sc.pp.pca(adata, n_comps=10)
sc.pp.neighbors(adata)
sc.tl.leiden(adata, flavor="igraph", n_iterations=2, resolution=0.3)
sc.tl.umap(adata)
clusters = adata.obs["leiden"].nunique()
assert clusters >= 3, clusters
print("leiden clusters", clusters, "umap", adata.obsm["X_umap"].shape)
""",
}


class Client:
    def __init__(self, base: str) -> None:
        self.base = base
        self.rpc_id = 0

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self.rpc_id += 1
        res = httpx.post(
            f"{self.base}/mcp",
            headers=HEADERS,
            json={"jsonrpc": "2.0", "id": self.rpc_id, "method": method, "params": params or {}},
            timeout=660,
        )
        res.raise_for_status()
        assert res.headers["content-type"].startswith("application/json"), res.headers["content-type"]
        body = res.json()
        assert "error" not in body, body
        return body["result"]

    def call(self, name: str, arguments: dict | None = None) -> dict:
        out = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        assert not out.get("isError"), out
        return json.loads(out["content"][0]["text"])

    def run(self, code: str, language: str = "python", timeout: int = 600) -> dict:
        out = self.call("execute_code", {"code": code, "language": language, "timeout_seconds": timeout})
        assert out["status"] == "succeeded", out
        return out

    def ping(self) -> str:
        return httpx.get(f"{self.base}/ping", headers={"Host": HEADERS["Host"]}, timeout=10).json()["status"]


def check_sandbox(client: Client, environment: str) -> dict:
    init = client.rpc(
        "initialize",
        {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}},
    )
    assert init["protocolVersion"] == PROTOCOL_VERSION, init
    tools = client.rpc("tools/list")["tools"]
    assert len(tools) == 7, [t["name"] for t in tools]

    info = client.call("get_sandbox_info")
    assert info["environment"] == environment, info
    assert "mcp" not in info["python_packages"], "server packages leaked into the sandbox environment"
    assert "pip" not in info["python_packages"], "the sandbox environment should have no pip"
    assert info["workdir"] == "/workspace"

    env = client.run(
        "id -u; env | grep -c ^AWS_ || true; (touch /opt/sandbox/x 2>/dev/null && echo writable) || true", "bash"
    )
    uid, aws_vars, *rest = env["stdout"].split()
    assert uid != "0" and aws_vars == "0" and not rest, env

    assert client.ping() == "Healthy"
    job = client.call("execute_code", {"language": "bash", "code": "sleep 60", "background": True})
    assert client.ping() == "HealthyBusy"
    client.call("cancel_job", {"job_id": job["job_id"]})
    deadline = time.monotonic() + 10
    while client.ping() != "Healthy":
        assert time.monotonic() < deadline, "ping stayed HealthyBusy after cancel_job"
        time.sleep(0.2)
    return info


def check_catalog(client: Client, entry: dict, info: dict) -> None:
    """Every catalog package is installed at its catalog version and imports; every program runs."""
    installed = info["python_packages"]
    for name, version in entry["installed"].items():
        assert installed.get(name) == version, f"{name}: catalog {version}, installed {installed.get(name)}"
    imports = [p["import"] for p in entry["packages"] + entry["also_installed"] if p.get("import")]
    client.run("import importlib\nfor name in %r:\n    importlib.import_module(name)\nprint('ok')" % imports)
    for program in entry["programs"]:
        client.run(" ".join(program["check"]) + " > /dev/null", "bash")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", nargs="?", default="http://127.0.0.1:18000")
    parser.add_argument("--environment", default="chem")
    args = parser.parse_args()
    entry = next(e for e in json.loads(CATALOG.read_text())["environments"] if e["id"] == args.environment)

    client = Client(args.base)
    info = check_sandbox(client, args.environment)
    check_catalog(client, entry, info)
    analysis = client.run(ANALYSES[args.environment])["stdout"].strip().splitlines()[-1]
    if args.environment == "chem":
        png = client.call("read_file", {"path": "aspirin.png", "encoding": "base64"})
        assert base64.b64decode(png["content"]).startswith(b"\x89PNG"), "not a PNG"
        assert analysis.startswith("180.16 CC(=O)Oc1ccccc1C(=O)O"), analysis

    print(
        f"ok {args.environment}: {len(entry['installed'])} packages at catalog versions, "
        f"{len(entry['programs'])} programs; {analysis}"
    )


if __name__ == "__main__":
    sys.exit(main())
