# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Remote MCP server with MCP Apps widgets showing protein 3D structures in Mol*, sequence alignments and DICOM images.

`show_structure` takes a PDB ID (e.g. "1CRN") or mmCIF/PDB text. The widget (`structure.html`) gets the data in
`structuredContent`: the structure text, or the PDB ID, which the widget downloads from RCSB. The model only gets a
text summary of the structure.

`show_alignment` takes sequence/alignment text (see `alignment.py`), shown by `alignment.html` with CDCgov
AlignmentViewer.

`show_dicom` takes a base64-encoded DICOM file or a bundled sample (see `dicom.py`), shown by `dicom.html`, which
decodes the pixels in the browser. Without a file the viewer opens empty and the user opens DICOM files from their
computer in it: they never leave the browser.

The server runs remotely on Amazon Bedrock AgentCore Runtime, so it never reads files: structures, alignments and
DICOM images (base64) are given in the tool arguments. `main()` serves stateless Streamable HTTP with plain JSON
responses on `/mcp` (the AgentCore Runtime MCP contract), or stdio for local development.
"""

import argparse
import logging
import os
import re
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
from mcp.server.apps import Apps, ResourceCsp
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from typing_extensions import TypedDict

from bio_viewers_mcp.alignment import AlignmentFormat, load_alignment
from bio_viewers_mcp.dicom import DicomSample, load_dicom

WIDGET_URI = "ui://bio-viewers/structure.html"
WIDGET_HTML = Path(__file__).parent / "structure.html"
ALIGNMENT_URI = "ui://bio-viewers/alignment.html"
ALIGNMENT_HTML = Path(__file__).parent / "alignment.html"
DICOM_URI = "ui://bio-viewers/dicom.html"
DICOM_HTML = Path(__file__).parent / "dicom.html"
THEME_CSS = Path(__file__).parent / "theme.css"
# Structure and alignment text is sent whole to the widget, in the tool result
STRUCTURE_MAX_MB = float(os.getenv("STRUCTURE_MAX_MB", "5"))
ALIGNMENT_MAX_MB = float(os.getenv("ALIGNMENT_MAX_MB", "5"))
# DICOM files are limited by their decoded size, they come in base64 (4/3 larger)
DICOM_MAX_MB = float(os.getenv("DICOM_MAX_MB", "5"))
# HTTP request bodies carry the tool arguments, room for the largest accepted text plus the JSON-RPC envelope
MAX_REQUEST_BODY_BYTES = int((max(STRUCTURE_MAX_MB, ALIGNMENT_MAX_MB, DICOM_MAX_MB * 4 / 3) + 1) * 1024 * 1024)
# Mol* and the MCP Apps SDK are loaded by the widget from the CDN, PDB entries are downloaded from RCSB
CDN = "https://cdn.jsdelivr.net"
RCSB_MODELS = "https://models.rcsb.org"
RCSB_FILES = "https://files.rcsb.org"
RCSB_DATA = "https://data.rcsb.org/rest/v1/core/entry"
PDB_ID = re.compile(r"^[0-9][A-Za-z0-9]{3}$")
MMCIF_TEXT = re.compile(r"^(data_|_atom_site\.)", re.MULTILINE)
PDB_TEXT = re.compile(r"^(ATOM  |HETATM)", re.MULTILINE)
WATER = {"HOH", "WAT", "DOD", "H2O"}
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
# httpx logs each request URL at INFO, with the tool arguments in it (PDB IDs)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

apps = Apps()


# Data sent to the widget in `structuredContent`, as read by `structure.html`
class ChainInfo(TypedDict):
    id: str
    residues: int


class StructureSummary(TypedDict):
    atoms: int
    models: int
    chains: list[ChainInfo]
    ligands: list[str]


class Stat(TypedDict):
    label: str
    value: str


class StructureData(TypedDict):
    kind: Literal["pdb", "text"]
    id: str  # PDB ID, or the title of structure text
    title: str | None
    subtitle: str | None  # Source of the structure
    stats: list[Stat]  # Key figures shown under the title
    format: Literal["mmcif", "pdb"]
    data: str | None  # Structure text
    urls: list[str]  # PDB entries, tried in order, (url, binary) as "bcif:<url>" or "cif:<url>"
    summary: StructureSummary | None


# ---------------------------------------------------------------------------------------------------------------------
# Parsing a summary of the structure for the model: chains, residues and ligands of the first model


def _atom(group: str, chain: str, comp: str, seq: str, model: str) -> tuple[str, str, str, str, str]:
    return group.strip(), chain.strip(), comp.strip(), seq.strip(), model.strip()


def pdb_atoms(text: str) -> tuple[list[tuple[str, str, str, str, str]], str | None]:
    """Atoms (group, chain, residue name, residue number, model) and title of PDB format text"""
    atoms = []
    title: list[str] = []
    model = "1"
    for line in text.splitlines():
        record = line[:6]
        if record.startswith(("ATOM", "HETATM")):
            atoms.append(_atom(record, line[21:22], line[17:20], line[22:27], model))
        elif record == "MODEL ":
            model = line[10:14].strip() or model
        elif record == "TITLE ":
            title.append(line[10:80].strip())
    return atoms, " ".join(title) or None


CIF_TOKEN = re.compile(r"'(?:[^']|'(?!\s|$))*'|\"(?:[^\"]|\"(?!\s|$))*\"|\S+")


def cif_atoms(text: str) -> tuple[list[tuple[str, str, str, str, str]], str | None]:
    """Atoms and title of mmCIF text, from the `_atom_site` loop and `_struct.title`"""
    lines = text.splitlines()
    title = None
    atoms = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("_struct.title"):
            value = line[len("_struct.title") :].strip()
            if not value and i + 1 < len(lines):
                # Value on the next line, or a `;` text field
                i += 1
                value = lines[i].strip()
                if value.startswith(";"):
                    parts = [value[1:]]
                    while i + 1 < len(lines) and not lines[i + 1].startswith(";"):
                        i += 1
                        parts.append(lines[i].strip())
                    value = " ".join(p for p in parts if p)
            title = value.strip("'\"") or None
        elif line.startswith("loop_") and i + 1 < len(lines) and lines[i + 1].startswith("_atom_site."):
            cols: list[str] = []
            i += 1
            while i < len(lines) and lines[i].startswith("_atom_site."):
                cols.append(lines[i].split()[0][len("_atom_site.") :])
                i += 1
            idx = {c: n for n, c in enumerate(cols)}

            def col(row: list[str], *names: str, idx: dict[str, int] = idx) -> str:
                for name in names:
                    if name in idx and idx[name] < len(row):
                        return row[idx[name]]
                return ""

            while i < len(lines) and not lines[i].startswith(("_", "loop_", "#", "data_")):
                row = CIF_TOKEN.findall(lines[i])
                if row:
                    atoms.append(
                        _atom(
                            col(row, "group_PDB"),
                            col(row, "auth_asym_id", "label_asym_id"),
                            col(row, "auth_comp_id", "label_comp_id"),
                            col(row, "auth_seq_id", "label_seq_id"),
                            col(row, "pdbx_PDB_model_num") or "1",
                        )
                    )
                i += 1
            continue
        i += 1
    return atoms, title


def summarize(atoms: list[tuple[str, str, str, str, str]]) -> StructureSummary:
    models = list(dict.fromkeys(a[4] for a in atoms))
    first = [a for a in atoms if a[4] == models[0]] if models else []
    residues: dict[str, set[str]] = {}
    ligands: Counter[str] = Counter()
    for group, chain, comp, seq, _ in first:
        if group == "ATOM":
            residues.setdefault(chain or "-", set()).add(seq)
        elif comp not in WATER:
            ligands[comp] += 1
    return StructureSummary(
        atoms=len(first),
        models=len(models),
        chains=[ChainInfo(id=c, residues=len(r)) for c, r in residues.items()],
        ligands=sorted(ligands),
    )


def summary_stats(s: StructureSummary) -> list[Stat]:
    chains = ", ".join(f"{c['id']} {c['residues']}" for c in s["chains"])
    stats = [Stat(label="Atoms", value=f"{s['atoms']:,}")]
    stats.append(Stat(label="Chains (residues)", value=f"{len(s['chains'])}" + (f" · {chains}" if chains else "")))
    if s["models"] > 1:
        stats.append(Stat(label="Models", value=str(s["models"])))
    if s["ligands"]:
        stats.append(
            Stat(label="Ligands", value=", ".join(s["ligands"][:12]) + (" …" if len(s["ligands"]) > 12 else ""))
        )
    return stats


def summary_lines(s: StructureSummary) -> list[str]:
    chains = ", ".join(f"{c['id']} ({c['residues']} residues)" for c in s["chains"]) or "none"
    lines = [f"{s['atoms']} atoms, {len(s['chains'])} polymer chains: {chains}"]
    if s["models"] > 1:
        lines.append(f"{s['models']} models, the first one is summarized")
    if s["ligands"]:
        lines.append(f"Ligands and other heteroatoms: {', '.join(s['ligands'][:30])}")
    return lines


# ---------------------------------------------------------------------------------------------------------------------
# Loading structure text and PDB entries


def text_format(text: str) -> Literal["mmcif", "pdb"] | None:
    """Format of structure text from its content: mmCIF data blocks or atom loops, PDB ATOM/HETATM records"""
    if MMCIF_TEXT.search(text):
        return "mmcif"
    if PDB_TEXT.search(text):
        return "pdb"
    return None


def load_text(text: str, fmt: Literal["mmcif", "pdb"]) -> tuple[StructureData, str]:
    size = len(text.encode("utf-8"))
    if size > STRUCTURE_MAX_MB * 1024 * 1024:
        raise ToolError(f"The structure text is {size / 1024 / 1024:.1f} MB, above the {STRUCTURE_MAX_MB:g} MB limit")
    name = "mmCIF" if fmt == "mmcif" else "PDB"
    atoms, title = cif_atoms(text) if fmt == "mmcif" else pdb_atoms(text)
    if not atoms:
        raise ToolError(f"No atoms found in the structure text, is it valid {name}?")
    summary = summarize(atoms)
    data = StructureData(
        kind="text",
        id="Structure",
        title=title,
        subtitle=f"{name} text given to the tool",
        stats=[Stat(label="Format", value=name), *summary_stats(summary)],
        format=fmt,
        data=text,
        urls=[],
        summary=summary,
    )
    lines = [f"Shown to the user: 3D structure from {name} text given to the tool"]
    if title:
        lines.append(f"Title: {title}")
    return data, "\n".join(lines + summary_lines(summary))


async def load_pdb(pdb_id: str) -> tuple[StructureData, str]:
    pdb_id = pdb_id.upper()
    lines = [f"Shown to the user: 3D structure of the PDB entry {pdb_id}"]
    title = None
    stats: list[Stat] = []
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.get(f"{RCSB_DATA}/{pdb_id}")
        if res.status_code == 404:
            raise ToolError(f"PDB entry {pdb_id} not found at RCSB")
        res.raise_for_status()
        entry: dict[str, Any] = res.json()
        info = entry.get("rcsb_entry_info", {})
        title = entry.get("struct", {}).get("title")
        method = ", ".join(e["method"] for e in entry.get("exptl", []) if "method" in e) or None
        resolution = (info.get("resolution_combined") or [None])[0]
        released = (entry.get("rcsb_accession_info", {}).get("initial_release_date") or "")[:10] or None
        if method:
            stats.append(Stat(label="Method", value=method.capitalize()))
        if resolution:
            stats.append(Stat(label="Resolution", value=f"{resolution:.2f} Å"))
        if released:
            stats.append(Stat(label="Released", value=released))
        if info.get("deposited_atom_count"):
            stats.append(Stat(label="Atoms", value=f"{info['deposited_atom_count']:,}"))
        if info.get("deposited_polymer_entity_instance_count"):
            stats.append(Stat(label="Chains", value=str(info["deposited_polymer_entity_instance_count"])))
        if title:
            lines.append(f"Title: {title}")
        details = [method, f"{resolution:.2f} Å" if resolution else None, released and f"released {released}"]
        if any(details):
            lines.append(" · ".join(d for d in details if d))
        if info.get("deposited_atom_count"):
            lines.append(
                f"{info['deposited_atom_count']} atoms, "
                f"{info.get('deposited_polymer_entity_instance_count', '?')} polymer chains, "
                f"{info.get('deposited_nonpolymer_entity_instance_count', 0)} non-polymer instances"
            )
    except httpx.HTTPError as e:
        # The widget can still download the structure
        lines.append(f"Could not get the entry metadata from RCSB: {type(e).__name__}")
    data = StructureData(
        kind="pdb",
        id=pdb_id,
        title=title,
        subtitle="RCSB Protein Data Bank",
        stats=stats,
        format="mmcif",
        data=None,
        urls=[f"bcif:{RCSB_MODELS}/{pdb_id}.bcif", f"cif:{RCSB_FILES}/download/{pdb_id}.cif"],
        summary=None,
    )
    return data, "\n".join(lines)


# ---------------------------------------------------------------------------------------------------------------------
# Tools and widgets


@contextmanager
def content_errors(tool: str) -> Iterator[None]:
    """Turn an unexpected exception into a fixed `ToolError`.

    The MCP SDK logs any exception other than `ToolError` with its traceback, and parser exception messages can quote
    the structure, sequence or DICOM content they failed on. Only the exception type is logged here.
    """
    try:
        yield
    except ToolError:
        raise
    except Exception as e:
        logger.warning("%s failed unexpectedly: %s", tool, type(e).__name__)
        raise ToolError(f"{tool} could not process this input") from None


@apps.tool(
    resource_uri=WIDGET_URI,
    annotations=ToolAnnotations(
        title="Show protein structure",
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=True,
    ),
)
async def show_structure(structure: str) -> CallToolResult:
    """Show a protein 3D structure to the user in an interactive Mol* viewer.

    `structure` is either a PDB ID (e.g. "1CRN", "4HHB"), downloaded from RCSB, or the full text of a structure in
    mmCIF or PDB format (for example a predicted structure). This server cannot read files from the user's computer:
    pass the file content itself. Returns a summary of the structure: title, chains, residues and ligands."""
    structure = structure.strip()
    if not structure:
        raise ToolError("Give a PDB ID or the text of an mmCIF or PDB structure")
    with content_errors("show_structure"):
        if PDB_ID.match(structure):
            data, text = await load_pdb(structure)
        elif fmt := text_format(structure):
            data, text = load_text(structure, fmt)
        else:
            raise ToolError(
                "Expected a 4-character PDB ID (e.g. 1CRN) or mmCIF/PDB structure text. "
                "File paths cannot be read by this remote server, pass the file content instead"
            )
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=dict(data))


@apps.tool(
    resource_uri=ALIGNMENT_URI,
    annotations=ToolAnnotations(
        title="Show sequence alignment",
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    ),
)
async def show_alignment(
    alignment: str, title: str | None = None, format: AlignmentFormat | None = None
) -> CallToolResult:
    """Show sequences or a multiple sequence alignment to the user in an interactive alignment viewer (based on
    CDCgov AlignmentViewer): residues colored by type, with a consensus, a conservation track and an overview.

    `alignment` is the alignment or sequence text: FASTA (aligned or not, A2M), A3M, Clustal or Stockholm. A single
    bare sequence is also accepted. This server cannot read files from the user's computer: pass the file content
    itself. `format` is detected from the content when omitted; set it to "a3m" for A3M, whose lower case insertions
    otherwise read as FASTA residues. `title` is shown above the alignment. Returns a summary: size, gaps,
    conservation, identity to the consensus."""
    with content_errors("show_alignment"):
        data, text = load_alignment(alignment, ALIGNMENT_MAX_MB, title, format)
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=dict(data))


@apps.tool(
    resource_uri=DICOM_URI,
    annotations=ToolAnnotations(
        title="Show DICOM image",
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    ),
)
async def show_dicom(
    dicom: str | None = None, sample: DicomSample | None = None, title: str | None = None
) -> CallToolResult:
    """Show a medical image (DICOM) to the user in an interactive viewer: window/level with presets, zoom, pan,
    pixel values (Hounsfield units for CT) and scrolling through frames and slices.

    `dicom` is the content of a DICOM file encoded in base64 (a `data:` URL prefix is accepted). This server cannot
    read files from the user's computer: pass the file content itself. `sample` shows a bundled anonymized test image
    instead: "ct" (a CT slice) or "mr" (an MR slice). Without `dicom` or `sample` the viewer opens empty and the user
    can open DICOM files (one image, a multi-frame file or a whole series) from their computer: the files stay in the
    user's browser. Prefer that for patient images. `title` is shown above the image. Returns a technical summary of
    the header (modality, size, frames, pixel encoding, spacing, window), without patient or study information."""
    with content_errors("show_dicom"):
        data, text = load_dicom(dicom, sample, DICOM_MAX_MB, title)
    return CallToolResult(content=[TextContent(type="text", text=text)], structured_content=dict(data))


def widget_html(path: Path) -> str:
    """Widget page with the shared AWS Quick theme inlined, hosts render a single self-contained document"""
    return path.read_text().replace("<!-- QUICK_THEME -->", f"<style>\n{THEME_CSS.read_text()}</style>")


apps.add_html_resource(
    WIDGET_URI,
    widget_html(WIDGET_HTML),
    title="Protein structure viewer",
    csp=ResourceCsp(resource_domains=[CDN], connect_domains=[RCSB_MODELS, RCSB_FILES]),
)
apps.add_html_resource(
    ALIGNMENT_URI,
    widget_html(ALIGNMENT_HTML),
    title="Sequence alignment viewer",
    # AlignmentViewer and the MCP Apps SDK from the CDN, sequences come in the tool result
    csp=ResourceCsp(resource_domains=[CDN]),
)
apps.add_html_resource(
    DICOM_URI,
    widget_html(DICOM_HTML),
    title="DICOM image viewer",
    # dicom-parser and the MCP Apps SDK from the CDN, images come in the tool result or from the user's files
    csp=ResourceCsp(resource_domains=[CDN]),
)


mcp = MCPServer(
    "bio-viewers",
    title="Protein structure, sequence alignment and DICOM image viewers",
    instructions=(
        "Use show_structure to show protein 3D structures to the user, from a PDB ID or mmCIF/PDB structure text. "
        "Use show_alignment to show sequences or multiple sequence alignments from FASTA, A3M, Clustal or "
        "Stockholm text. Use show_dicom to show medical images (DICOM): pass a base64 DICOM file, a sample, or nothing "
        "to let the user open DICOM files from their computer in the viewer. Pass content, not file paths: this "
        "server cannot read the user's files."
    ),
    extensions=[apps],
)


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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Protein structure, sequence alignment and DICOM image viewers MCP server"
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default=os.getenv("MCP_TRANSPORT", "stdio"),
        help="stdio for a local client, streamable-http for AgentCore Runtime (default: $MCP_TRANSPORT or stdio)",
    )
    parser.add_argument("--host", default=os.getenv("MCP_HOST", "127.0.0.1"), help="HTTP bind address")
    parser.add_argument("--port", type=int, default=int(os.getenv("MCP_PORT", "8000")), help="HTTP port")
    args = parser.parse_args()
    if args.transport == "stdio":
        mcp.run()
        return
    # AgentCore Runtime and Gateway: stateless request/response with plain JSON bodies, no sessions or SSE
    mcp.run(
        "streamable-http",
        host=args.host,
        port=args.port,
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        max_request_body_size=MAX_REQUEST_BODY_BYTES,
        transport_security=transport_security(args.host),
    )


if __name__ == "__main__":
    main()
