---
name: bio-viewers
description: Show protein 3D structures (PDB IDs or mmCIF/PDB text), sequence alignments (FASTA, A3M, Clustal, Stockholm), and DICOM medical images to the user in interactive viewers. Use when the user asks to see, view, visualize, or compare a protein structure, a set of sequences, or a medical image or scan.
---

# Bio Viewers

Three tools render interactive viewers inline in the chat (MCP Apps). The model receives a text summary; the viewer receives the full data.

## show_structure

Show a protein 3D structure in a Mol* viewer.

- `structure`: a 4-character PDB ID (for example `1CRN`, `4HHB`), downloaded from RCSB, **or** the full text of an mmCIF or PDB file (for example a predicted model).
- The server is remote and cannot read the user's files. When the user refers to a file, pass its content, not its path.
- The result summarizes title, method, resolution, chains, residues, and ligands. Use it to answer follow-up questions.

## show_alignment

Show sequences or a multiple sequence alignment in an alignment viewer with consensus and conservation tracks.

- `alignment`: FASTA (aligned or not, A2M), A3M, Clustal, or Stockholm text, or one bare sequence. Pass content, not a file path.
- `format` (optional): detected from the content; set it to `a3m` for A3M so lower-case insertions are dropped.
- `title` (optional): shown above the alignment.
- The result reports sequence count, alignment length, gap fraction, conserved columns, mean pairwise identity, the consensus, and each sequence's identity to the consensus.

## show_dicom

Show a medical image in a DICOM viewer: window/level with CT presets, zoom, pan, pixel values (Hounsfield units for CT), and frame or slice scrolling.

- No arguments: opens an empty viewer in which the user opens DICOM files (one image, a multi-frame file, or a whole series) from their computer. The files stay in the user's browser. **Prefer this for patient images.**
- `dicom` (optional): the content of a DICOM file in base64. Pass content, not a file path.
- `sample` (optional): `ct` or `mr`, a bundled anonymized test image, for demonstrations.
- `title` (optional): shown above the image.
- The result is a technical header summary (modality, size, frames, pixel encoding, spacing, window). It never includes patient, study, or institution information; do not ask the user for it. When the user opens files in the viewer, it tells you the same technical details.
- The viewer decodes uncompressed, RLE, and 8-bit JPEG images. For JPEG 2000, JPEG Lossless, or JPEG-LS files, suggest converting to uncompressed DICOM.
- This is a review aid. Do not present observations from the image as a diagnosis.

## Tips

- Prefer a PDB ID when the user names a deposited structure; it avoids sending large text.
- Structure and alignment text, and DICOM files, are limited to about 5 MB per call.
- If the chat shows only the text summary and no viewer, the client does not render MCP Apps; share the summary instead.
