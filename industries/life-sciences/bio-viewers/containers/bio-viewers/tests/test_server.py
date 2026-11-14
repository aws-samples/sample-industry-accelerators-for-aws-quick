# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""The server as AgentCore Runtime and Gateway reach it: stateless Streamable HTTP with JSON bodies on /mcp."""

import base64
import logging
import re
from collections.abc import Iterator
from importlib.resources import files
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from bio_viewers_mcp import server

# AWS Quick does not support the latest MCP revision yet and negotiates this one
QUICK_PROTOCOL_VERSION = "2025-03-26"
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def container_host() -> str:
    """The bind address the Dockerfile gives the server in AgentCore Runtime (its MCP_HOST)."""
    match = re.search(r"^\s*MCP_HOST=(\S+)", (Path(__file__).parent.parent / "Dockerfile").read_text(), re.M)
    assert match, "the Dockerfile must set MCP_HOST"
    return match.group(1)


# The tests serve the app the way the container does.
CONTAINER_HOST = container_host()

PDB_TEXT = """\
TITLE     A SMALL TEST PEPTIDE
ATOM      1  N   GLY A   1      11.104   6.134  -6.504  1.00  0.00           N
ATOM      2  CA  GLY A   1      11.639   6.071  -5.147  1.00  0.00           C
ATOM      3  N   ALA A   2      12.000   7.000  -4.000  1.00  0.00           N
ATOM      4  N   SER B   1      13.000   8.000  -3.000  1.00  0.00           N
HETATM    5  C1  NAG B 101      14.000   9.000  -2.000  1.00  0.00           C
HETATM    6  O   HOH A 201      15.000  10.000  -1.000  1.00  0.00           O
END
"""

MMCIF_TEXT = """\
data_TEST
_struct.title 'Test structure'
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.label_comp_id
_atom_site.auth_asym_id
_atom_site.auth_comp_id
_atom_site.auth_seq_id
_atom_site.pdbx_PDB_model_num
ATOM 1 GLY A GLY 1 1
ATOM 2 ALA A ALA 2 1
HETATM 3 HEM A HEM 100 1
#
"""

FASTA = ">seq1\nMKV-LA\n>seq2\nMKVQLA\n>seq3\nMRV-LA\n"

# Anonymized test images bundled with pydicom
TEST_FILES = files("pydicom.data") / "test_files"
CT_SMALL = (TEST_FILES / "CT_small.dcm").read_bytes()


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = server.mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        max_request_body_size=server.MAX_REQUEST_BODY_BYTES,
        transport_security=server.transport_security(CONTAINER_HOST),
        host=CONTAINER_HOST,
    )
    with TestClient(app, base_url="http://bedrock-agentcore.invalid") as c:
        yield c


def rpc(client: TestClient, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    res = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={**HEADERS, "MCP-Protocol-Version": QUICK_PROTOCOL_VERSION},
    )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/json")
    body = res.json()
    assert "error" not in body, body
    return body["result"]


def call(client: TestClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return rpc(client, "tools/call", {"name": name, "arguments": arguments})


# ---------------------------------------------------------------------------------------------------------------------
# Transport


def test_initialize_negotiates_the_quick_protocol_version(client: TestClient) -> None:
    res = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": QUICK_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
        headers=HEADERS,
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    # Stateless: no session for the gateway to track
    assert "mcp-session-id" not in res.headers
    result = res.json()["result"]
    assert result["protocolVersion"] == QUICK_PROTOCOL_VERSION
    assert result["serverInfo"]["name"] == "bio-viewers"


def test_tools_list_links_each_tool_to_its_widget(client: TestClient) -> None:
    tools = {t["name"]: t for t in rpc(client, "tools/list")["tools"]}
    assert set(tools) == {"show_structure", "show_alignment", "show_dicom"}
    assert tools["show_structure"]["_meta"]["ui"]["resourceUri"] == server.WIDGET_URI
    assert tools["show_alignment"]["_meta"]["ui"]["resourceUri"] == server.ALIGNMENT_URI
    assert tools["show_dicom"]["_meta"]["ui"]["resourceUri"] == server.DICOM_URI
    for tool in tools.values():
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["annotations"]["destructiveHint"] is False
        assert tool["annotations"]["idempotentHint"] is True
    assert tools["show_structure"]["inputSchema"]["required"] == ["structure"]
    assert tools["show_alignment"]["inputSchema"]["required"] == ["alignment"]
    assert "required" not in tools["show_dicom"]["inputSchema"] or tools["show_dicom"]["inputSchema"]["required"] == []
    assert tools["show_dicom"]["annotations"]["openWorldHint"] is False
    assert tools["show_structure"]["annotations"]["openWorldHint"] is True
    assert tools["show_alignment"]["annotations"]["openWorldHint"] is False


@pytest.mark.parametrize("uri", [server.WIDGET_URI, server.ALIGNMENT_URI, server.DICOM_URI])
def test_widgets_are_self_contained_mcp_app_resources(client: TestClient, uri: str) -> None:
    listed = {r["uri"] for r in rpc(client, "resources/list")["resources"]}
    assert uri in listed
    (content,) = rpc(client, "resources/read", {"uri": uri})["contents"]
    assert content["mimeType"] == "text/html;profile=mcp-app"
    assert "<!-- QUICK_THEME -->" not in content["text"]
    assert "--qs-color-bg-secondary" in content["text"]
    # Behind a gateway the tool name is prefixed, the widget takes it from the host context
    assert "toolInfo?.tool?.name" in content["text"]


def test_transport_security_is_kept_on_loopback() -> None:
    assert server.transport_security("127.0.0.1") is None
    assert server.transport_security(CONTAINER_HOST).enable_dns_rebinding_protection is False


# ---------------------------------------------------------------------------------------------------------------------
# show_structure


def test_show_structure_from_pdb_text(client: TestClient) -> None:
    result = call(client, "show_structure", {"structure": PDB_TEXT})
    assert not result.get("isError")
    data = result["structuredContent"]
    assert data["kind"] == "text"
    assert data["format"] == "pdb"
    assert data["data"] == PDB_TEXT.strip()
    assert data["title"] == "A SMALL TEST PEPTIDE"
    assert data["summary"]["atoms"] == 6
    assert data["summary"]["chains"] == [{"id": "A", "residues": 2}, {"id": "B", "residues": 1}]
    # Water is left out of the ligands
    assert data["summary"]["ligands"] == ["NAG"]
    assert "2 polymer chains" in result["content"][0]["text"]


def test_show_structure_from_mmcif_text(client: TestClient) -> None:
    data = call(client, "show_structure", {"structure": MMCIF_TEXT})["structuredContent"]
    assert data["format"] == "mmcif"
    assert data["title"] == "Test structure"
    assert data["summary"]["chains"] == [{"id": "A", "residues": 2}]
    assert data["summary"]["ligands"] == ["HEM"]


def test_show_structure_from_pdb_id(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    entry = {
        "struct": {"title": "CRAMBIN"},
        "exptl": [{"method": "X-RAY DIFFRACTION"}],
        "rcsb_entry_info": {"resolution_combined": [1.5], "deposited_atom_count": 327},
    }
    transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json=entry) if req.url.path.endswith("/1CRN") else httpx.Response(404)
    )
    real = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))
    result = call(client, "show_structure", {"structure": "1crn"})
    data = result["structuredContent"]
    assert data["kind"] == "pdb"
    assert data["id"] == "1CRN"
    assert data["data"] is None
    assert data["urls"] == ["bcif:https://models.rcsb.org/1CRN.bcif", "cif:https://files.rcsb.org/download/1CRN.cif"]
    assert "CRAMBIN" in result["content"][0]["text"]


def test_rcsb_requests_are_not_logged(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    requests: list[httpx.Request] = []

    def handle(req: httpx.Request) -> httpx.Response:
        requests.append(req)
        return httpx.Response(200, json={})

    real = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handle), **kw))
    caplog.set_level(logging.DEBUG, logger="bio_viewers_mcp")
    caplog.set_level(logging.INFO)
    call(client, "show_structure", {"structure": "9XYZ"})
    # The request URL carries the tool argument
    assert len(requests) == 1
    assert "9XYZ" not in caplog.text


LEAK_MARKER = "MKVSECRETSEQUENCE"


def _crash(*args: object, **kwargs: object) -> None:
    raise ValueError(f"cannot parse {LEAK_MARKER}")


@pytest.mark.parametrize(
    ("tool", "target", "arguments"),
    [
        ("show_structure", "load_text", {"structure": PDB_TEXT}),
        ("show_alignment", "load_alignment", {"alignment": FASTA}),
        ("show_dicom", "load_dicom", {"sample": "ct"}),
    ],
)
def test_unexpected_errors_do_not_leak_content(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    tool: str,
    target: str,
    arguments: dict[str, Any],
) -> None:
    # Parser exception messages can quote the content: neither the result nor the logs may carry them
    monkeypatch.setattr(server, target, _crash)
    caplog.set_level(logging.DEBUG)
    result = call(client, tool, arguments)
    assert result["isError"] is True
    assert result["content"][0]["text"].endswith(f"{tool} could not process this input")
    assert LEAK_MARKER not in caplog.text
    assert "Traceback" not in caplog.text
    assert "ValueError" in caplog.text


@pytest.mark.parametrize("value", ["/etc/passwd", "~/structures/model.cif", "model.pdb", "not a structure"])
def test_show_structure_never_reads_files(client: TestClient, value: str) -> None:
    result = call(client, "show_structure", {"structure": value})
    assert result["isError"] is True
    assert "pass the file content instead" in result["content"][0]["text"]
    assert "structuredContent" not in result or result["structuredContent"] is None


def test_show_structure_rejects_text_above_the_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "STRUCTURE_MAX_MB", 0.0001)
    result = call(client, "show_structure", {"structure": PDB_TEXT * 10})
    assert result["isError"] is True
    assert "above the" in result["content"][0]["text"]


# ---------------------------------------------------------------------------------------------------------------------
# show_alignment


def test_show_alignment_from_fasta(client: TestClient) -> None:
    result = call(client, "show_alignment", {"alignment": FASTA, "title": "Test MSA"})
    data = result["structuredContent"]
    assert data["title"] == "Test MSA"
    assert data["aligned"] is True
    assert data["ids"] == ["seq1", "seq2", "seq3"]
    assert data["length"] == 6
    assert data["alphabet"] == "protein"
    assert "multiple sequence alignment" in result["content"][0]["text"]


def test_show_alignment_from_clustal(client: TestClient) -> None:
    clustal = "CLUSTAL W\n\nseqA    ACGT-ACGT\nseqB    ACGTTACGT\n         **** ****\n"
    data = call(client, "show_alignment", {"alignment": clustal})["structuredContent"]
    assert data["ids"] == ["seqA", "seqB"]
    assert data["alphabet"] == "nucleotide"


def test_show_alignment_a3m_drops_insertions(client: TestClient) -> None:
    a3m = ">query\nMKVLA\n>hit\nMKaaVLA\n"
    data = call(client, "show_alignment", {"alignment": a3m, "format": "a3m"})["structuredContent"]
    assert data["seqs"] == ["MKVLA", "MKVLA"]


def test_show_alignment_from_a_bare_sequence(client: TestClient) -> None:
    data = call(client, "show_alignment", {"alignment": "MKVLAAGIVGLLLAQ"})["structuredContent"]
    assert data["ids"] == ["sequence"]
    assert data["aligned"] is False


@pytest.mark.parametrize("value", ["/data/msa.fasta", "~/msa.a3m", "alignment.sto"])
def test_show_alignment_never_reads_files(client: TestClient, value: str) -> None:
    result = call(client, "show_alignment", {"alignment": value})
    assert result["isError"] is True
    assert "pass the file content instead" in result["content"][0]["text"]


# ---------------------------------------------------------------------------------------------------------------------
# show_dicom


def test_show_dicom_from_base64(client: TestClient) -> None:
    encoded = base64.b64encode(CT_SMALL).decode()
    result = call(client, "show_dicom", {"dicom": encoded, "title": "Head CT"})
    assert not result.get("isError")
    data = result["structuredContent"]
    assert data["title"] == "Head CT"
    assert data["files"] == [{"name": "image.dcm", "data": encoded}]
    text = result["content"][0]["text"]
    assert "Modality: CT (computed tomography)" in text
    assert "128 × 128 pixels, 1 frame, 16-bit signed MONOCHROME2" in text
    assert "Transfer syntax: Explicit VR Little Endian" in text
    assert "cannot decode" not in text


def test_show_dicom_accepts_a_data_url_with_line_breaks(client: TestClient) -> None:
    encoded = base64.encodebytes(CT_SMALL).decode()  # Lines of 76 characters
    result = call(client, "show_dicom", {"dicom": f"data:application/dicom;base64,{encoded}"})
    assert not result.get("isError")
    assert base64.b64decode(result["structuredContent"]["files"][0]["data"]) == CT_SMALL


def test_show_dicom_keeps_patient_information_out_of_the_summary(client: TestClient) -> None:
    import pydicom

    ds = pydicom.dcmread(TEST_FILES / "CT_small.dcm")
    text = call(client, "show_dicom", {"sample": "ct"})["content"][0]["text"]
    identifiers = [ds.PatientName, ds.PatientID, ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID]
    identifiers += [ds.get("InstitutionName"), ds.get("StudyDate"), ds.get("ReferringPhysicianName")]
    for value in filter(None, map(str, identifiers)):
        assert value not in text


@pytest.mark.parametrize(("sample", "modality"), [("ct", "CT"), ("mr", "MR")])
def test_show_dicom_samples(client: TestClient, sample: str, modality: str) -> None:
    result = call(client, "show_dicom", {"sample": sample})
    assert result["structuredContent"]["subtitle"] == "pydicom test data"
    assert f"Modality: {modality}" in result["content"][0]["text"]


def test_show_dicom_without_a_file_opens_an_empty_viewer(client: TestClient) -> None:
    result = call(client, "show_dicom", {})
    assert result["structuredContent"]["files"] == []
    assert "stay in the user's browser" in result["content"][0]["text"]


def test_show_dicom_reports_images_the_viewer_cannot_decode(client: TestClient) -> None:
    raw = (TEST_FILES / "JPEG2000.dcm").read_bytes()
    text = call(client, "show_dicom", {"dicom": base64.b64encode(raw).decode()})["content"][0]["text"]
    assert "The viewer cannot decode its transfer syntax (JPEG 2000 Image Compression)" in text


def _variant(**attrs: object) -> str:
    """CT_small with header attributes changed, as base64"""
    from io import BytesIO

    import pydicom

    ds = pydicom.dcmread(TEST_FILES / "CT_small.dcm")
    for name, value in attrs.items():
        setattr(ds, name, value)
    out = BytesIO()
    ds.save_as(out)
    return base64.b64encode(out.getvalue()).decode()


@pytest.mark.parametrize(
    ("attrs", "reason"),
    [
        # The widget converts YBR_FULL_422 only through the browser's JPEG decoder
        ({"SamplesPerPixel": 3, "BitsAllocated": 8, "PhotometricInterpretation": "YBR_FULL_422"}, "outside JPEG"),
        ({"SamplesPerPixel": 3, "PhotometricInterpretation": "RGB"}, "16-bit color"),
        ({"PhotometricInterpretation": "PALETTE COLOR"}, "PALETTE COLOR"),
        ({"BitsAllocated": 1}, "1-bit pixels"),
    ],
)
def test_show_dicom_summary_matches_what_the_viewer_decodes(
    client: TestClient, attrs: dict[str, object], reason: str
) -> None:
    text = call(client, "show_dicom", {"dicom": _variant(**attrs)})["content"][0]["text"]
    assert "The viewer cannot decode" in text
    assert reason in text


@pytest.mark.parametrize("value", ["/data/scan.dcm", "C:\\scans\\ct.dcm", "~/scan.dcm", "scan", "aGVsbG8gd29ybGQ="])
def test_show_dicom_never_reads_files(client: TestClient, value: str) -> None:
    result = call(client, "show_dicom", {"dicom": value})
    assert result["isError"] is True
    assert "pass the file content instead" in result["content"][0]["text"]


def test_show_dicom_rejects_dicom_without_pixels(client: TestClient) -> None:
    from io import BytesIO

    import pydicom

    ds = pydicom.dcmread(TEST_FILES / "CT_small.dcm")
    del ds.PixelData
    out = BytesIO()
    ds.save_as(out)
    result = call(client, "show_dicom", {"dicom": base64.b64encode(out.getvalue()).decode()})
    assert result["isError"] is True
    assert "no pixel data" in result["content"][0]["text"]


def test_show_dicom_rejects_a_file_and_a_sample(client: TestClient) -> None:
    result = call(client, "show_dicom", {"dicom": base64.b64encode(CT_SMALL).decode(), "sample": "ct"})
    assert result["isError"] is True


def test_show_dicom_rejects_files_above_the_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "DICOM_MAX_MB", 0.01)
    result = call(client, "show_dicom", {"dicom": base64.b64encode(CT_SMALL).decode()})
    assert result["isError"] is True
    assert "above the" in result["content"][0]["text"]


# ---------------------------------------------------------------------------------------------------------------------
# CDK tool catalog


async def test_cdk_tool_snapshot_matches_the_server() -> None:
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root / "scripts"))
    from tools_snapshot import render, snapshot

    stored = (root.parents[1] / "lib" / "tools" / "bio-viewers-tools.json").read_text()
    assert stored == render(await snapshot()), (
        "Regenerate lib/tools/bio-viewers-tools.json (see scripts/tools_snapshot.py)"
    )
