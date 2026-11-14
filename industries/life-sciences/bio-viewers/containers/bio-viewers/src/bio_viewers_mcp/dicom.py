# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""DICOM images for the `show_dicom` widget (`dicom.html`).

The tool takes a base64-encoded DICOM Part 10 file, or the name of a sample image bundled with pydicom, or nothing:
the widget then opens empty and the user can open DICOM files from their computer in it, which stay in their browser.
The server is remote, so it never reads files from paths given to the tool.

The widget gets the file in `structuredContent` and decodes the pixels itself. The model gets a technical summary of
the header only (modality, size, frames, pixel encoding, spacing, window). DICOM headers carry protected health
information: patient, study, institution, physician, dates and UIDs are never put in the summary, in errors or logs.
"""

import base64
import binascii
import logging
import re
import warnings
from importlib.resources import files
from io import BytesIO
from typing import Any, Literal

import pydicom
from mcp.server.mcpserver.exceptions import ToolError
from pydicom.dataset import Dataset
from pydicom.uid import UID
from typing_extensions import TypedDict

DicomSample = Literal["ct", "mr"]
# Anonymized test images that pydicom ships in its package
SAMPLES: dict[str, tuple[str, str]] = {
    "ct": ("CT_small.dcm", "Sample CT slice"),
    "mr": ("MR_small.dcm", "Sample MR slice"),
}
# Transfer syntaxes the widget decodes: native pixels, RLE, and 8-bit JPEG through the browser's image decoder
DECODABLE = {
    "1.2.840.10008.1.2",  # Implicit VR Little Endian
    "1.2.840.10008.1.2.1",  # Explicit VR Little Endian
    "1.2.840.10008.1.2.2",  # Explicit VR Big Endian
    "1.2.840.10008.1.2.5",  # RLE Lossless
    "1.2.840.10008.1.2.4.50",  # JPEG Baseline (Process 1)
    "1.2.840.10008.1.2.4.51",  # JPEG Extended (Process 2 & 4), 8-bit only
}
JPEG = {"1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51"}
# Photometric interpretations the widget's own decoders (native and RLE) convert, as in `decodeFrame` of
# `dicom.html`. The browser's JPEG decoder also handles subsampled color such as YBR_FULL_422
GRAYSCALE = {"MONOCHROME1", "MONOCHROME2"}
COLOR = {"RGB", "YBR_FULL"}
MODALITIES = {
    "CR": "computed radiography",
    "CT": "computed tomography",
    "DX": "digital radiography",
    "IO": "intra-oral radiography",
    "MG": "mammography",
    "MR": "magnetic resonance",
    "NM": "nuclear medicine",
    "OT": "other",
    "PT": "positron emission tomography",
    "RF": "radiofluoroscopy",
    "SC": "secondary capture",
    "SM": "slide microscopy",
    "US": "ultrasound",
    "XA": "X-ray angiography",
    "XC": "external-camera photography",
}
# Prefix of a data URL some clients put before base64 content
DATA_URL = re.compile(r"^data:[\w.+/-]*;base64,", re.IGNORECASE)
NOT_BASE64 = re.compile(r"[^A-Za-z0-9+/=]")
NOT_DICOM = (
    "Expected a base64-encoded DICOM file. File paths cannot be read by this remote server, pass the file content "
    "instead, or call the tool without a file so that the user opens it in the viewer"
)

# pydicom reports invalid values through warnings and its logger, with the values in the message: they may be PHI
logging.getLogger("pydicom").setLevel(logging.CRITICAL)


class DicomFile(TypedDict):
    name: str
    data: str  # Base64 of the DICOM file


class DicomData(TypedDict):
    title: str
    subtitle: str | None
    files: list[DicomFile]  # Decoded and summarized by the widget, empty to let the user open files


# ---------------------------------------------------------------------------------------------------------------------
# Header summary, technical attributes only


def _number(value: Any) -> str:
    return f"{float(value):g}"


def _first(value: Any) -> Any:
    """First value of a multi-valued attribute (window center and width can hold several)"""
    if value is None:
        return None
    if isinstance(value, (list, tuple)) or type(value).__name__ == "MultiValue":
        return value[0] if len(value) else None
    return value


def transfer_syntax(ds: Dataset) -> UID | None:
    meta = getattr(ds, "file_meta", None)
    uid = meta.get("TransferSyntaxUID") if meta is not None else None
    return UID(str(uid)) if uid else None


def summary_lines(ds: Dataset) -> list[str]:
    modality = str(ds.get("Modality") or "").strip()
    lines = [
        f"Modality: {modality} ({MODALITIES[modality]})"
        if modality in MODALITIES
        else f"Modality: {modality or 'not given'}"
    ]
    frames = int(ds.get("NumberOfFrames") or 1)
    photometric = str(ds.get("PhotometricInterpretation") or "").strip()
    bits = ds.get("BitsStored") or ds.get("BitsAllocated")
    signed = " signed" if ds.get("PixelRepresentation") == 1 else ""
    lines.append(
        f"{ds.Columns} × {ds.Rows} pixels, {frames} frame{'s' if frames > 1 else ''}, "
        f"{bits}-bit{signed} {photometric or 'unknown photometric interpretation'}"
    )
    spacing = ds.get("PixelSpacing")
    thickness = ds.get("SliceThickness")
    details = []
    if spacing and len(spacing) == 2:
        details.append(f"pixel spacing {_number(spacing[0])} × {_number(spacing[1])} mm")
    if thickness not in (None, ""):
        details.append(f"slice thickness {_number(thickness)} mm")
    if details:
        lines.append(details[0][0].upper() + ", ".join(details)[1:])
    if body := str(ds.get("BodyPartExamined") or "").strip():
        lines.append(f"Body part: {body}")
    center, width = _first(ds.get("WindowCenter")), _first(ds.get("WindowWidth"))
    if center is not None and width is not None:
        lines.append(f"Window center/width: {_number(center)}/{_number(width)}")
    ts = transfer_syntax(ds)
    lines.append(f"Transfer syntax: {ts.name if ts else 'not given (no file meta information)'}")
    unsupported = undecodable(ds, ts, photometric)
    if unsupported:
        lines.append(
            f"The viewer cannot decode {' and '.join(unsupported)}: it shows uncompressed, RLE and 8-bit JPEG images "
            "in grayscale, RGB or YBR_FULL. Suggest converting the file to uncompressed (Explicit VR Little Endian)"
        )
    return lines


def undecodable(ds: Dataset, ts: UID | None, photometric: str) -> list[str]:
    """What keeps the widget from decoding the image, mirroring the checks of `decodeFrame` in `dicom.html`"""
    if ts and ts not in DECODABLE:
        return [f"its transfer syntax ({ts.name})"]
    bits = ds.get("BitsAllocated", 16)
    color = ds.get("SamplesPerPixel", 1) == 3
    if ts in JPEG:
        return ["JPEG with more than 8 bits"] if bits != 8 else []
    unsupported = []
    if photometric not in (COLOR if color else GRAYSCALE) and (photometric or color):
        detail = " outside JPEG" if photometric == "YBR_FULL_422" else ""
        unsupported.append(f"its photometric interpretation ({photometric or 'not given'}{detail})")
    if color and bits != 8:
        unsupported.append(f"{bits}-bit color")
    elif not color and bits not in (8, 16, 32):
        unsupported.append(f"{bits}-bit pixels")
    return unsupported


def read_dicom(raw: bytes) -> Dataset:
    """Dataset of a DICOM file, with or without the Part 10 preamble, that must hold an image"""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            ds = pydicom.dcmread(BytesIO(raw), force=True)
            ds.get("Rows")  # Parses the elements, deferred by dcmread
        except Exception as e:  # pydicom raises many types on invalid input, their messages may hold values
            raise ToolError(NOT_DICOM) from e
    if "PixelData" not in ds or not ds.get("Rows") or not ds.get("Columns"):
        if len(ds) == 0 or not any(tag.group == 0x0008 for tag in ds.keys()):
            raise ToolError(NOT_DICOM)
        raise ToolError("This DICOM file holds no image (no pixel data), the viewer only shows images")
    return ds


def decode_base64(value: str, max_mb: float) -> bytes:
    value = DATA_URL.sub("", value.strip(), count=1)
    value = "".join(value.split())
    # Base64 is 4/3 of the file size
    if len(value) * 3 / 4 > max_mb * 1024 * 1024:
        raise ToolError(f"The DICOM file is {len(value) * 3 / 4 / 1024 / 1024:.1f} MB, above the {max_mb:g} MB limit")
    if not value or NOT_BASE64.search(value):
        raise ToolError(NOT_DICOM)
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
    except (binascii.Error, ValueError) as e:
        raise ToolError(NOT_DICOM) from e


# ---------------------------------------------------------------------------------------------------------------------
# Loading


def load_dicom(
    dicom: str | None, sample: DicomSample | None, max_mb: float, title: str | None = None
) -> tuple[DicomData, str]:
    """Widget data and model summary for a base64 DICOM file, a bundled sample, or an empty viewer"""
    if dicom and sample:
        raise ToolError("Give either a DICOM file or a sample, not both")
    if sample:
        if sample not in SAMPLES:
            raise ToolError(f"Unknown sample, choose one of: {', '.join(SAMPLES)}")
        name, label = SAMPLES[sample]
        raw = (files("pydicom.data") / "test_files" / name).read_bytes()
        source, subtitle = f"the {label.lower()} bundled with the server", "pydicom test data"
        title = title or label
    elif dicom and dicom.strip():
        raw = decode_base64(dicom, max_mb)
        name, source, subtitle = "image.dcm", "the DICOM file given to the tool", "DICOM file given to the tool"
    else:
        data = DicomData(title=title or "DICOM viewer", subtitle=None, files=[])
        text = (
            "Shown to the user: an empty DICOM viewer. The user can open DICOM files from their computer in it; the "
            "files stay in the user's browser and are not sent to this server or to you. The viewer tells you the "
            "technical details of the images opened, without patient or study information."
        )
        return data, text
    ds = read_dicom(raw)
    lines = [f"Shown to the user: DICOM image from {source}", *summary_lines(ds)]
    lines.append(
        "Patient, study and institution information is left out of this summary. The user can adjust the window, "
        "zoom, pan and scroll the frames in the viewer, and open more DICOM files from their computer."
    )
    data = DicomData(
        title=title or "DICOM image",
        subtitle=subtitle,
        files=[DicomFile(name=name, data=base64.b64encode(raw).decode("ascii"))],
    )
    return data, "\n".join(lines)
