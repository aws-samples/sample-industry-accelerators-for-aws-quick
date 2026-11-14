# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""Sequences and multiple sequence alignments for the `show_alignment` widget (`alignment.html`).

Reads FASTA (aligned or not, including A2M), A3M, Clustal and Stockholm text given to the tool. The server is remote,
so it never reads files. The widget gets the sequences in `structuredContent`, the model gets a text summary:
alphabet, size, gaps, conservation and the identity of each sequence to the consensus.
"""

import re
from collections import Counter
from typing import Literal

from mcp.server.mcpserver.exceptions import ToolError
from typing_extensions import TypedDict

AlignmentFormat = Literal["fasta", "a3m", "clustal", "stockholm"]
Format = AlignmentFormat
GAPS = set("-.")
NUCLEOTIDES = set("ACGTUN")
# Characters kept in sequences: letters, gaps, stop codons and unknown residues
NOT_RESIDUE = re.compile(r"[^A-Za-z\-.*?]")
# A sequence given alone, without a FASTA header
BARE_SEQUENCE = re.compile(r"^[A-Za-z*\-.]{10,}$")
# A file name given instead of its content (dots are also gaps, so `msa.sto` would read as a sequence)
FILE_NAME = re.compile(
    r"\.(fa|fasta|fas|fna|faa|ffn|mfa|afa|afasta|a2m|a3m|aln|clustal|clw|sto|stk|stockholm|txt)(\.gz)?$",
    re.IGNORECASE,
)
MAX_LISTED = 25


class Stat(TypedDict):
    label: str
    value: str


class AlignmentData(TypedDict):
    title: str
    subtitle: str | None
    alphabet: Literal["nucleotide", "protein"]
    aligned: bool
    length: int  # Longest sequence
    ids: list[str]
    seqs: list[str]  # Upper case, gaps as "-"
    stats: list[Stat]  # Key figures shown under the title


# ---------------------------------------------------------------------------------------------------------------------
# Parsers, each returning (id, sequence) pairs


def parse_fasta(text: str, a3m: bool = False) -> list[tuple[str, str]]:
    records: list[tuple[str, list[str]]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith(">"):
            records.append((line[1:].strip() or f"seq{len(records) + 1}", []))
        elif records:
            records[-1][1].append(line)
        else:
            raise ToolError("FASTA text must start with a '>' header line")
    out = []
    for name, parts in records:
        seq = "".join(parts)
        if a3m:
            # Lower case letters and dots are insertions relative to the first sequence
            seq = re.sub(r"[a-z.]", "", seq)
        out.append((name, seq))
    return out


def parse_blocks(text: str, stockholm: bool) -> list[tuple[str, str]]:
    """Clustal and Stockholm: interleaved blocks of `name sequence` lines, in the order of their first block"""
    seqs: dict[str, list[str]] = {}
    for line in text.splitlines():
        if stockholm:
            if line.startswith("//"):
                break
            if not line.strip() or line.startswith("#"):
                continue
        else:
            # Header, empty lines and conservation lines (starting with spaces)
            if not line.strip() or line[0].isspace() or line.upper().startswith(("CLUSTAL", "MUSCLE", "PROBCONS")):
                continue
        parts = line.split()
        if len(parts) < 2:
            continue
        seqs.setdefault(parts[0], []).append(parts[1])
    return [(name, "".join(parts)) for name, parts in seqs.items()]


def detect_format(text: str) -> Format:
    head = text.lstrip()[:200].upper()
    if head.startswith("# STOCKHOLM"):
        return "stockholm"
    if head.startswith(("CLUSTAL", "MUSCLE", "PROBCONS")):
        return "clustal"
    return "fasta"


def parse(text: str, fmt: Format) -> list[tuple[str, str]]:
    if fmt in ("fasta", "a3m"):
        records = parse_fasta(text, a3m=fmt == "a3m")
    else:
        records = parse_blocks(text, stockholm=fmt == "stockholm")
    cleaned = [(name, NOT_RESIDUE.sub("", seq).upper().replace(".", "-")) for name, seq in records]
    cleaned = [(name, seq) for name, seq in cleaned if seq]
    if not cleaned:
        raise ToolError(f"No sequences found, expected {fmt.upper() if fmt != 'stockholm' else 'Stockholm'} content")
    return cleaned


def stockholm_title(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith(("#=GF DE", "#=GF ID")):
            return line[7:].strip() or None
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Summary for the model


def consensus_of(seqs: list[str], length: int) -> tuple[str, list[float]]:
    """Most common residue of each column, and its fraction of all the sequences (gaps count against it)"""
    consensus, conservation = [], []
    for col in range(length):
        counts = Counter(s[col] for s in seqs if col < len(s) and s[col] not in GAPS)
        if counts:
            residue, n = counts.most_common(1)[0]
            consensus.append(residue)
            conservation.append(n / len(seqs))
        else:
            consensus.append("-")
            conservation.append(0.0)
    return "".join(consensus), conservation


def mean_pairwise_identity(seqs: list[str], length: int) -> float | None:
    """Identical residue pairs over pairs where both sequences have a residue, counted per column in O(n * L)"""
    same = both = 0
    for col in range(length):
        counts = Counter(s[col] for s in seqs if s[col] not in GAPS)
        k = sum(counts.values())
        both += k * (k - 1) // 2
        same += sum(c * (c - 1) // 2 for c in counts.values())
    return same / both if both else None


def identity_to(seq: str, consensus: str) -> float | None:
    pairs = [(a, b) for a, b in zip(seq, consensus, strict=False) if a not in GAPS and b not in GAPS]
    return sum(a == b for a, b in pairs) / len(pairs) if pairs else None


def summary(records: list[tuple[str, str]], data: AlignmentData, source: str) -> tuple[str, list[Stat]]:
    """Text for the model and key figures for the widget"""
    seqs, length = data["seqs"], data["length"]
    stats = [
        Stat(label="Sequences", value=f"{len(seqs):,}"),
        Stat(label="Alphabet", value=data["alphabet"].capitalize()),
    ]
    residues = [len(s) - sum(s.count(g) for g in GAPS) for s in seqs]
    kind = "multiple sequence alignment" if data["aligned"] else "sequences" if len(seqs) > 1 else "sequence"
    plural = "s" if len(seqs) > 1 else ""
    lines = [f"Shown to the user: {kind} from {source}, {len(seqs)} {data['alphabet']} sequence{plural}"]
    if data["aligned"]:
        cells = len(seqs) * length
        gaps = sum(s.count("-") for s in seqs)
        consensus, conservation = consensus_of(seqs, length)
        conserved = sum(c == 1 for c in conservation)
        lines.append(f"Alignment length {length} columns, {gaps / cells:.1%} gaps")
        lines.append(f"Fully conserved columns: {conserved} ({conserved / length:.1%})")
        stats += [
            Stat(label="Columns", value=f"{length:,}"),
            Stat(label="Gaps", value=f"{gaps / cells:.1%}"),
            Stat(label="Conserved columns", value=f"{conserved:,}"),
        ]
        identity = mean_pairwise_identity(seqs, length) if len(seqs) > 1 else None
        if identity is not None:
            lines.append(f"Mean pairwise identity: {identity:.1%}")
            stats.append(Stat(label="Mean identity", value=f"{identity:.1%}"))
        shown = consensus[:200] + ("..." if length > 200 else "")
        lines.append(f"Consensus (majority residue per column): {shown}")
    else:
        consensus = ""
        if len(seqs) == 1:
            lines.append(f"A single sequence of {residues[0]} residues")
            stats.append(Stat(label="Length", value=f"{residues[0]:,}"))
        else:
            stats.append(Stat(label="Length", value=f"{min(residues):,}–{max(residues):,}"))
            lines.append(
                f"Not aligned (lengths differ): {min(residues)} to {max(residues)} residues, shown from their start"
            )
    lines.append("Sequences (residues without gaps" + (", identity to consensus" if consensus else "") + "):")
    for (name, _), seq, n in list(zip(records, seqs, residues, strict=True))[:MAX_LISTED]:
        ident = identity_to(seq, consensus) if consensus else None
        lines.append(f"- {name}: {n}" + (f", {ident:.1%}" if ident is not None else ""))
    if len(seqs) > MAX_LISTED:
        lines.append(f"- ... and {len(seqs) - MAX_LISTED} more")
    lines.append("The user can scroll, zoom and click a column in the widget, which tells you the column selected.")
    return "\n".join(lines), stats


# ---------------------------------------------------------------------------------------------------------------------
# Loading


def is_text(value: str) -> bool:
    return "\n" in value or value.lstrip().startswith((">", "CLUSTAL", "# STOCKHOLM"))


def load_alignment(
    value: str, max_mb: float, title: str | None = None, fmt: Format | None = None
) -> tuple[AlignmentData, str]:
    """Sequences from FASTA/A3M/Clustal/Stockholm text, or a single bare sequence"""
    value = value.strip()
    if not value:
        raise ToolError("Give alignment or sequence text: FASTA, A3M, Clustal or Stockholm")
    size = len(value.encode("utf-8"))
    if size > max_mb * 1024 * 1024:
        raise ToolError(f"The alignment text is {size / 1024 / 1024:.1f} MB, above the {max_mb:g} MB limit")
    if is_text(value):
        text, source = value, "text given to the tool"
        fmt = fmt or detect_format(value)
    elif BARE_SEQUENCE.match(value) and not FILE_NAME.search(value):
        text, fmt, source = f">sequence\n{value}", "fasta", "a sequence given to the tool"
    else:
        raise ToolError(
            "Expected FASTA, A3M, Clustal or Stockholm text, or a single sequence. "
            "File paths cannot be read by this remote server, pass the file content instead"
        )
    records = parse(text, fmt)
    seqs = [seq for _, seq in records]
    lengths = {len(s) for s in seqs}
    residues = Counter(c for s in seqs[:500] for c in s if c not in GAPS)
    total = sum(residues.values())
    nucleotide = total > 0 and sum(residues[c] for c in NUCLEOTIDES) / total >= 0.9
    name = title or (stockholm_title(text) if fmt == "stockholm" else None)
    data = AlignmentData(
        title=name
        or (
            "Sequence alignment"
            if len(lengths) == 1 and len(seqs) > 1
            else "Sequence"
            if len(seqs) == 1
            else "Sequences"
        ),
        subtitle=None,
        alphabet="nucleotide" if nucleotide else "protein",
        aligned=len(lengths) == 1 and len(seqs) > 1,
        length=max(lengths),
        ids=[n for n, _ in records],
        seqs=seqs,
        stats=[],
    )
    text, data["stats"] = summary(records, data, source)
    return data, text
