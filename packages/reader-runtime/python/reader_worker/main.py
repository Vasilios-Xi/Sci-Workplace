from __future__ import annotations

import argparse
import difflib
import hashlib
import html
import importlib.metadata
import json
import os
import re
import sys
import traceback
import unicodedata
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from statistics import median
from typing import Any, Iterable

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader


for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


# A numbered caption must have an explicit caption separator ("Figure 4.",
# "Table 1:") or immediately introduce a panel marker ("Figure 4 a)").  A
# bare space is intentionally not enough: prose such as "Figure 4 indicates
# that ..." is a figure mention, not a caption.  Keeping those two concepts
# separate prevents duplicate figure IDs and, more importantly, prevents a
# later prose mention from overwriting the real crop for the same figure.
# Supplementary and Extended Data labels are part of the immutable identity:
# Figure 1, Figure S1, Supplementary Figure 1 and Extended Data Figure 1 must
# not silently collapse onto the same asset ID.
CAPTION_RE = re.compile(
    r"^(?:(?P<scope>supplementary|extended\s+data)\s+)?"
    r"(?P<kind>fig(?:ure)?\.?|table)\s*"
    r"(?P<number>[A-Z]?\d+(?:[A-Z](?=\s*[.:|｜-]))?)(?![-–—][A-Z0-9])"
    r"(?:\s*[.:|｜-]\s*|\s+(?=(?:\([a-z]\)|[a-z]\))))",
    re.IGNORECASE,
)
GRAPHICAL_ABSTRACT_RE = re.compile(
    r"^(?:toc\s+graphic|graphical\s+abstract|graphical\s+toc|table\s+of\s+contents\s+(?:graphic|image))[\s.:：-]*$",
    re.IGNORECASE,
)
FIGURE_MENTION_TEMPLATE = r"\b(?:fig(?:ure)?\.?)\s*{number}(?!\d)"
TABLE_MENTION_TEMPLATE = r"\btable\s*{number}(?!\d)"
REFERENCE_HEADING_RE = re.compile(
    r"^(?:(?:additional|supplementary)\s+)?(?:references|bibliography|参考文献)$",
    re.IGNORECASE,
)
REFERENCE_SECTION_END_RE = re.compile(
    r"^(?:acknowledg(?:e)?ments?|author\s+contributions?|data\s+availability|"
    r"code\s+availability|ethics\s+declarations?|competing\s+interests?|"
    r"methods?|supplementary\s+(?:information|methods?)|extended\s+data)\b",
    re.IGNORECASE,
)
GENERIC_SECTION_HEADING_RE = re.compile(
    r"^(?:abstract|introduction|background|main|results?|discussion|conclusions?|"
    r"methods?|references|bibliography|acknowledg(?:e)?ments?)\b",
    re.IGNORECASE,
)
REPOSITORY_CITATION_RE = re.compile(
    r"(?:\bet\s+al\.\s*\(\d{4}\)|\bdoi\s*:|\bpp?\.\s*\d|"
    r"this\s+is\s+the\s+author\s+version|published\s+version|"
    r"deposited\s+on|eprints\.|research\s+publications\s+by)",
    re.IGNORECASE,
)
SECTION_HEADING_RE = re.compile(
    r"^(abstract|introduction|background|results?|discussion|conclusions?|methods?|materials and methods|"
    r"data availability|code availability|acknowledg(?:e)?ments?|author contributions?|competing interests?)$",
    re.IGNORECASE,
)
DOCLING_CACHE_SCHEMA_VERSION = 5
DOCLING_TEXT_LABELS = {
    "title": "heading",
    "section_header": "heading",
    "caption": "caption",
    "text": "paragraph",
    "paragraph": "paragraph",
    "list_item": "paragraph",
    "footnote": "note",
    "reference": "reference",
    "formula": "formula",
}
CHEMICAL_ELEMENTS = {
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
    "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
    "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
    "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
    "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
}
SPACED_FORMULA_RE = re.compile(
    r"(?<![A-Za-z])(?:[A-Z][a-z]?\s*(?:\d+(?:\.\d+)?\s*)?){2,}(?![A-Za-z])"
)
PUBLISHER_GLYPH_PROBE_RE = re.compile(
    r"^(?:1234567890[()\[\]{}:;,.'\"!?|/\\+\-=]*)+$"
)


@dataclass
class ExtractedLine:
    text: str
    x0: float
    top: float
    x1: float
    bottom: float
    font_size: float
    page_width: float

    @property
    def bbox(self) -> list[float]:
        return [round(self.x0, 3), round(self.top, 3), round(self.x1, 3), round(self.bottom, 3)]


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def capabilities() -> dict[str, Any]:
    docling_version = package_version("docling") or package_version("docling-slim")
    return {
        "worker_version": "0.2.23",
        "capabilities": [
            "pdf-inspect",
            "selectable-text",
            "page-bbox",
            "page-render",
            "figure-crop",
            "formula-source-crop",
            "source-map",
            *( ["docling-structure"] if docling_version else [] ),
        ],
        "packages": {
            "docling": docling_version,
            "pdfplumber": package_version("pdfplumber"),
            "pypdf": package_version("pypdf"),
            "pypdfium2": package_version("pypdfium2"),
        },
    }


def inspect_pdf(pdf_path: str) -> dict[str, Any]:
    path = Path(pdf_path).resolve()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    source_sha256 = digest.hexdigest()
    reader = PdfReader(str(path))
    encrypted = bool(reader.is_encrypted)
    if encrypted:
        try:
            reader.decrypt("")
        except Exception:
            return {
                "path": str(path),
                "sha256": source_sha256,
                "size": path.stat().st_size,
                "encrypted": True,
                "page_count": len(reader.pages),
                "has_text_layer": False,
                "text_characters": 0,
                "page_text_characters": [],
            }

    page_counts = [len((page.extract_text() or "").strip()) for page in reader.pages]
    total = sum(page_counts)
    pages_with_text = sum(1 for value in page_counts if value >= 20)
    has_text_layer = bool(page_counts) and total >= 100 and pages_with_text / len(page_counts) >= 0.6
    return {
        "path": str(path),
        "sha256": source_sha256,
        "size": path.stat().st_size,
        "encrypted": encrypted,
        "page_count": len(reader.pages),
        "has_text_layer": has_text_layer,
        "text_characters": total,
        "page_text_characters": page_counts,
        "metadata": {str(key).lstrip("/"): str(value) for key, value in (reader.metadata or {}).items()},
    }


def normalize_text(value: str) -> str:
    value = html.unescape(value)
    value = value.replace("\u00ad", "")
    # Some publisher metadata is UTF-8 decoded as Windows-1252 before it
    # reaches pypdf (for example ``â€”`` instead of an em dash).  Repair the
    # common byte sequences deterministically; leaving them in the title makes
    # an otherwise valid paper look corrupt and also defeats title matching.
    mojibake = {
        "â€”": "—",
        "â€“": "–",
        "âˆ’": "−",
        "â€˜": "‘",
        "â€™": "’",
        "â€œ": "“",
        "â€\u009d": "”",
        "Â°": "°",
        "Âµ": "µ",
        "Ã—": "×",
        "â‰¤": "≤",
        "â‰¥": "≥",
    }
    for damaged, repaired in mojibake.items():
        value = value.replace(damaged, repaired)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def is_publisher_glyph_probe(value: str) -> bool:
    """Identify invisible publisher font-test strings without guessing at data.

    Some Nature PDFs embed ``1234567890():,;`` twice in the selectable text
    layer to exercise a subset font. The glyphs are not painted on the page,
    but pdfplumber exposes them as ordinary lines. Requiring the exact ordered
    digit sequence plus at least three distinct punctuation characters keeps
    the rule narrow enough that measurements, identifiers and phone numbers
    remain valid evidence.
    """
    compact = re.sub(r"\s+", "", normalize_text(value))
    if not compact or len(compact) > 96 or not PUBLISHER_GLYPH_PROBE_RE.fullmatch(compact):
        return False
    punctuation = {character for character in compact if not character.isdigit()}
    return len(punctuation) >= 3


def remove_nonsemantic_text_layer_artifacts(blocks: list[dict[str, Any]]) -> int:
    kept = [block for block in blocks if not is_publisher_glyph_probe(str(block.get("originalText", "")))]
    removed = len(blocks) - len(kept)
    blocks[:] = kept
    return removed


def normalize_scientific_text(value: str) -> str:
    """Compact Docling's visually separated chemical subscripts without guessing prose numbers."""
    normalized = normalize_text(value)

    def compact(match: re.Match[str]) -> str:
        candidate = match.group(0)
        if not re.search(r"\d", candidate):
            return candidate
        tokens = re.findall(r"[A-Z][a-z]?|\d+(?:\.\d+)?", candidate)
        elements = [token for token in tokens if not token[0].isdigit()]
        if len(elements) < 2 or any(element not in CHEMICAL_ELEMENTS for element in elements):
            return candidate
        previous_was_number = False
        for token in tokens:
            is_number = token[0].isdigit()
            if is_number and previous_was_number:
                return candidate
            previous_was_number = is_number
        return "".join(tokens)

    return SPACED_FORMULA_RE.sub(compact, normalized)


def dehyphenated_join(left: str, right: str) -> str:
    if left.endswith("-") and right and right[0].islower():
        return f"{left[:-1]}{right}"
    return f"{left} {right}".strip()


def line_from_raw(raw: dict[str, Any], page_width: float) -> ExtractedLine | None:
    text = normalize_text(str(raw.get("text", "")))
    if not text:
        return None
    chars = raw.get("chars") or []
    sizes = [float(char.get("size", 0)) for char in chars if float(char.get("size", 0)) > 0]
    font_size = median(sizes) if sizes else max(8.0, float(raw.get("bottom", 0)) - float(raw.get("top", 0)))
    return ExtractedLine(
        text=text,
        x0=float(raw.get("x0", 0)),
        top=float(raw.get("top", 0)),
        x1=float(raw.get("x1", page_width)),
        bottom=float(raw.get("bottom", 0)),
        font_size=font_size,
        page_width=page_width,
    )


def order_lines(lines: list[ExtractedLine], page_width: float) -> list[ExtractedLine]:
    if len(lines) < 8:
        return sorted(lines, key=lambda line: (line.top, line.x0))
    midpoint = page_width / 2
    left = [line for line in lines if line.x1 <= midpoint + 12]
    right = [line for line in lines if line.x0 >= midpoint - 12]
    spanning = [line for line in lines if line not in left and line not in right]
    two_column = len(left) >= 4 and len(right) >= 4
    if not two_column:
        return sorted(lines, key=lambda line: (line.top, line.x0))

    ordered: list[ExtractedLine] = []
    top_spanning = sorted([line for line in spanning if line.top < min(left[0].top, right[0].top)], key=lambda line: line.top)
    ordered.extend(top_spanning)
    ordered.extend(sorted(left, key=lambda line: (line.top, line.x0)))
    ordered.extend(sorted(right, key=lambda line: (line.top, line.x0)))
    ordered.extend(sorted([line for line in spanning if line not in top_spanning], key=lambda line: line.top))
    return ordered


def is_probable_heading(line: ExtractedLine, body_size: float) -> bool:
    text = line.text.strip().rstrip(":")
    if SECTION_HEADING_RE.match(text) or REFERENCE_HEADING_RE.match(text):
        return True
    if len(text) > 180 or text.endswith(('.', ';', ',')):
        return False
    if line.font_size >= body_size * 1.16:
        return True
    alpha = [char for char in text if char.isalpha()]
    return len(alpha) >= 4 and all(char.isupper() for char in alpha) and len(text.split()) <= 12


def can_merge(previous: ExtractedLine, current: ExtractedLine, body_size: float) -> bool:
    if CAPTION_RE.match(previous.text) or CAPTION_RE.match(current.text):
        return False
    if is_probable_heading(previous, body_size) or is_probable_heading(current, body_size):
        return False
    same_column = abs(previous.x0 - current.x0) <= max(28, body_size * 2.5)
    vertical_gap = current.top - previous.bottom
    return same_column and -2 <= vertical_gap <= max(8, body_size * 0.9)


def merge_lines(lines: list[ExtractedLine]) -> list[dict[str, Any]]:
    if not lines:
        return []
    body_size = median([line.font_size for line in lines if 6 <= line.font_size <= 18] or [10.0])
    groups: list[list[ExtractedLine]] = []
    for line in lines:
        if groups and can_merge(groups[-1][-1], line, body_size):
            groups[-1].append(line)
        else:
            groups.append([line])

    merged: list[dict[str, Any]] = []
    for group in groups:
        text = group[0].text
        for line in group[1:]:
            text = dehyphenated_join(text, line.text)
        x0 = min(line.x0 for line in group)
        top = min(line.top for line in group)
        x1 = max(line.x1 for line in group)
        bottom = max(line.bottom for line in group)
        font_size = median([line.font_size for line in group])
        merged.append({
            "text": normalize_text(text),
            "bbox": [round(x0, 3), round(top, 3), round(x1, 3), round(bottom, 3)],
            "font_size": font_size,
            "body_size": body_size,
        })
    return merged


def stable_hash(page: int, bbox: Iterable[float], text: str) -> str:
    canonical = f"{page}|{','.join(f'{value:.2f}' for value in bbox)}|{normalize_text(text)}"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def docling_hint(pdf_path: str, cache_path: Path) -> tuple[str, list[str], list[dict[str, Any]]]:
    if package_version("docling") is None and package_version("docling-slim") is None:
        return "pdfplumber", ["Docling 未安装，使用 pdfplumber 几何解析；安装后将自动启用结构增强。"], []
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if int(cached.get("schemaVersion", 0)) == DOCLING_CACHE_SCHEMA_VERSION:
                hints = list(cached.get("items") or [])
                return "docling+pdfplumber", [f"复用 Docling 结构缓存，共 {len(hints)} 个来源片段。"], hints
        except Exception:
            pass
    try:
        # The MVP accepts only PDFs with a selectable text layer. Disable OCR and
        # torch.compile (which requires a Windows C++ toolchain) while retaining
        # Docling layout and table inference.
        os.environ.setdefault("DOCLING_INFERENCE_COMPILE_TORCH_MODELS", "false")
        from docling.backend.docling_parse_backend import DoclingParseDocumentBackend
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.document import InputDocument
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.settings import settings
        from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

        settings.inference.compile_torch_models = False
        pipeline_options = PdfPipelineOptions(
            do_ocr=False,
            force_backend_text=True,
            do_table_structure=True,
            # Formula content is recovered deterministically from the selectable
            # PDF layer and the exact region is also rendered as an image asset.
            # CodeFormulaV2 is intentionally disabled here: in regression papers
            # its narrow layout boxes produced plausible-looking but incomplete
            # LaTeX, which is less trustworthy than the immutable source crop.
            do_formula_enrichment=False,
            document_timeout=300,
        )
        bundled_artifacts = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "model-artifacts"
        if bundled_artifacts.exists():
            pipeline_options.artifacts_path = bundled_artifacts
        configure_minimal_docling_factories(pipeline_options)
        # docling-parse currently fails to open some Windows paths containing
        # non-ASCII characters.  Feed the same bytes through an ASCII logical
        # filename so projects such as `精读参考` remain fully supported.
        source_bytes = Path(pdf_path).read_bytes()
        input_document = InputDocument(
            path_or_stream=BytesIO(source_bytes),
            filename=f"{hashlib.sha256(source_bytes).hexdigest()}.pdf",
            format=InputFormat.PDF,
            backend=DoclingParseDocumentBackend,
        )
        result = StandardPdfPipeline(pipeline_options).execute(input_document, raises_on_error=True)
        document = result.document
        hints: list[dict[str, Any]] = []
        for item_order, (item, level) in enumerate(document.iterate_items()):
            provenance = list(getattr(item, "prov", []) or [])
            if not provenance:
                continue
            label = getattr(getattr(item, "label", ""), "value", str(getattr(item, "label", "")))
            item_text = str(getattr(item, "text", "") or "")
            item_id = f"D{item_order:05d}"
            for provenance_index, prov in enumerate(provenance):
                page_number = int(prov.page_no)
                page = document.pages.get(page_number)
                page_height = float(page.size.height) if page is not None else 0.0
                bbox = prov.bbox.to_top_left_origin(page_height) if page_height else prov.bbox
                start, end = (int(value) for value in prov.charspan)
                fragment_text = item_text[start:end] if 0 <= start < end <= len(item_text) else item_text
                hints.append({
                    "order": len(hints),
                    "itemOrder": item_order,
                    "itemId": item_id,
                    "provenanceIndex": provenance_index,
                    "level": int(level),
                    "page": page_number,
                    "label": str(label),
                    "text": normalize_scientific_text(fragment_text),
                    "bbox": [round(float(value), 3) for value in bbox.as_tuple()],
                })
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"schemaVersion": DOCLING_CACHE_SCHEMA_VERSION, "items": hints}, ensure_ascii=False), encoding="utf-8")
        return "docling+pdfplumber", [f"Docling 结构增强成功，识别 {len(hints)} 个逐页来源片段。"], hints
    except Exception as exc:
        return "pdfplumber", [f"Docling 结构增强失败，已回退几何解析：{type(exc).__name__}: {exc}"], []


def configure_minimal_docling_factories(pipeline_options: Any) -> None:
    """Register only the selectable-text MVP models instead of loading Docling's full plugin catalog."""
    from docling.models.factories.layout_factory import LayoutFactory
    from docling.models.factories.ocr_factory import OcrFactory
    from docling.models.factories.picture_description_factory import PictureDescriptionFactory
    from docling.models.factories.table_factory import TableStructureFactory
    from docling.models.picture_description_base_model import PictureDescriptionBaseModel
    from docling.models.stages.layout.layout_object_detection_model import LayoutObjectDetectionModel
    from docling.models.stages.table_structure.table_structure_model import TableStructureModel
    import docling.pipeline.base_pipeline as base_pipeline_module
    import docling.pipeline.standard_pdf_pipeline as standard_pipeline_module

    ocr_options_type = type(pipeline_options.ocr_options)
    picture_options_type = type(pipeline_options.picture_description_options)

    class NoopOcrModel:
        def __init__(self, **_: Any) -> None:
            pass

        def __call__(self, _conv_res: Any, page_batch: Iterable[Any]) -> Iterable[Any]:
            yield from page_batch

        @classmethod
        def get_options_type(cls) -> type:
            return ocr_options_type

    class NoopPictureDescriptionModel(PictureDescriptionBaseModel):
        @classmethod
        def get_options_type(cls) -> type:
            return picture_options_type

        def _annotate_images(self, images: Iterable[Any]) -> Iterable[str]:
            for _ in images:
                yield ""

    ocr_factory = OcrFactory()
    ocr_factory.register(NoopOcrModel, "openscientific", __name__)
    layout_factory = LayoutFactory()
    layout_factory.register(LayoutObjectDetectionModel, "openscientific", __name__)
    table_factory = TableStructureFactory()
    table_factory.register(TableStructureModel, "openscientific", __name__)
    picture_factory = PictureDescriptionFactory()
    picture_factory.register(NoopPictureDescriptionModel, "openscientific", __name__)

    standard_pipeline_module.get_ocr_factory = lambda **_: ocr_factory
    standard_pipeline_module.get_layout_factory = lambda **_: layout_factory
    standard_pipeline_module.get_table_structure_factory = lambda **_: table_factory
    base_pipeline_module.get_picture_description_factory = lambda **_: picture_factory


def bbox_overlap(left: list[float], right: list[float]) -> float:
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    intersection = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    left_area = max(1.0, (left[2] - left[0]) * (left[3] - left[1]))
    right_area = max(1.0, (right[2] - right[0]) * (right[3] - right[1]))
    return intersection / min(left_area, right_area)


def hint_match_score(block: dict[str, Any], hint: dict[str, Any]) -> float:
    block_text = normalize_text(str(block.get("originalText", ""))).lower()
    hint_text = normalize_text(str(hint.get("text", ""))).lower()
    if block_text and hint_text:
        if block_text == hint_text:
            text_score = 1.0
        elif block_text in hint_text or hint_text in block_text:
            text_score = min(len(block_text), len(hint_text)) / max(len(block_text), len(hint_text))
        else:
            text_score = difflib.SequenceMatcher(None, block_text[:500], hint_text[:500]).ratio()
    else:
        text_score = 0.0
    geometry_score = bbox_overlap(list(block["bbox"]), list(hint["bbox"]))
    return text_score * 0.72 + geometry_score * 0.28


def apply_docling_structure(blocks: list[dict[str, Any]], hints: list[dict[str, Any]]) -> None:
    structural_labels = {
        "title": "heading",
        "section_header": "heading",
        "caption": "caption",
        "table": "table",
        "footnote": "note",
        "reference": "reference",
        "formula": "note",
    }
    matched_blocks: set[int] = set()
    for hint in hints:
        label = str(hint.get("label", ""))
        if label not in structural_labels and label not in {"text", "paragraph", "list_item"}:
            continue
        candidates = [
            (index, block, hint_match_score(block, hint))
            for index, block in enumerate(blocks)
            if index not in matched_blocks
            and int(block["page"]) == int(hint["page"])
            and not (label == "caption" and not CAPTION_RE.match(str(block.get("originalText", ""))))
            and not (block.get("type") == "caption" and label != "caption")
        ]
        if not candidates:
            continue
        index, block, score = max(candidates, key=lambda item: item[2])
        if score < 0.34:
            continue
        matched_blocks.add(index)
        block["confidence"] = "high" if score >= 0.7 else "medium"
        if label in structural_labels:
            block["type"] = structural_labels[label]


def bbox_center_inside(inner: list[float], outer: list[float], padding: float = 2.0) -> bool:
    center_x = (inner[0] + inner[2]) / 2
    center_y = (inner[1] + inner[3]) / 2
    return (
        outer[0] - padding <= center_x <= outer[2] + padding
        and outer[1] - padding <= center_y <= outer[3] + padding
    )


def is_substantive_visual_region(
    bbox: list[float], page_width: float, page_height: float
) -> bool:
    """Return whether an uncaptioned region is large enough to be a real visual.

    Docling can report an axis tick, legend swatch, publisher badge, or a single
    label as a table/picture region. Those regions remain internal coordinate
    evidence, but must never become standalone user-visible recognition jobs.
    """
    if len(bbox) != 4 or page_width <= 0 or page_height <= 0:
        return False
    width = max(0.0, float(bbox[2]) - float(bbox[0]))
    height = max(0.0, float(bbox[3]) - float(bbox[1]))
    return (
        width >= 96.0
        and height >= 42.0
        and width * height >= page_width * page_height * 0.012
    )


def is_substantive_formula_region(bbox: list[float], expression: str) -> bool:
    """Reject isolated glyphs that a layout model mislabeled as equations.

    A real displayed equation may be physically compact, so this gate is much
    less strict than the figure/table gate. It normally requires both a
    non-trivial source rectangle and mathematical structure. Some PDFs expose
    only the equation number in the text layer while Docling's formula bbox
    still spans the whole displayed equation; a wide equation row is therefore
    accepted even when its transcription is only ``(n)``. Rejected regions
    remain in the source map, but are never rendered or sent to a vision model.
    """
    if len(bbox) != 4:
        return False
    width = max(0.0, float(bbox[2]) - float(bbox[0]))
    height = max(0.0, float(bbox[3]) - float(bbox[1]))
    normalized = normalize_formula_transcription(expression)
    if not normalized or normalized.startswith("[公式转写失败"):
        return False
    scientific = re.sub(r"[^A-Za-z0-9\u0370-\u03ff]", "", normalized)
    has_structure = bool(
        re.search(r"[=<>≈≤≥+−×÷/∂∇∫∑_^→↔]", normalized)
        or re.search(r"\\(?:frac|sqrt|sum|int|partial|nabla|ce)\b", normalized)
    )
    equation_number_only = bool(re.fullmatch(r"\(?\s*[A-Za-z]?\d+(?:[.:-]\d+)?\s*\)?", normalized))
    wide_display_row = (
        width >= 144.0
        and height >= 6.0
        and width * height >= 1_200.0
        and width / max(height, 1.0) >= 5.0
    )
    return (
        width >= 20.0
        and height >= 6.0
        and width * height >= 120.0
        and (
            (len(scientific) >= 2 and has_structure)
            or (equation_number_only and wide_display_row)
        )
    )


def expanded_crop_bbox(
    bbox: list[float],
    page_width: float,
    page_height: float,
    *,
    minimum_width: float,
    minimum_height: float,
    padding_x: float,
    padding_y: float,
) -> list[float]:
    """Pad a crop and guarantee a useful rendered resolution within the page."""
    left = max(0.0, float(bbox[0]) - padding_x)
    top = max(0.0, float(bbox[1]) - padding_y)
    right = min(page_width, float(bbox[2]) + padding_x)
    bottom = min(page_height, float(bbox[3]) + padding_y)

    def expand(start: float, end: float, limit: float, minimum: float) -> tuple[float, float]:
        desired = min(limit, max(minimum, end - start))
        center = (start + end) / 2.0
        expanded_start = max(0.0, center - desired / 2.0)
        expanded_end = min(limit, expanded_start + desired)
        expanded_start = max(0.0, expanded_end - desired)
        return expanded_start, expanded_end

    left, right = expand(left, right, page_width, minimum_width)
    top, bottom = expand(top, bottom, page_height, minimum_height)
    return [left, top, right, bottom]


def consolidate_docling_text_blocks(
    raw_blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Replace physical PDF lines with Docling's logical, per-provenance text blocks.

    Docling items can span pages. `docling_hint` emits one hint per provenance
    charspan, so a logical paragraph remains source-addressable on every page
    without turning every typeset line or detached subscript into a model input.
    """
    text_hints = [
        hint for hint in hints
        if str(hint.get("label", "")) in DOCLING_TEXT_LABELS
        and normalize_text(str(hint.get("text", "")))
    ]
    if not text_hints:
        apply_docling_structure(raw_blocks, hints)
        return raw_blocks

    raw_assignments: dict[int, int] = {}
    for raw_index, block in enumerate(raw_blocks):
        candidates: list[tuple[int, float]] = []
        for hint_index, hint in enumerate(text_hints):
            if int(block["page"]) != int(hint["page"]):
                continue
            overlap = bbox_overlap(list(block["bbox"]), list(hint["bbox"]))
            if overlap >= 0.34 or bbox_center_inside(list(block["bbox"]), list(hint["bbox"])):
                candidates.append((hint_index, overlap))
        if candidates:
            raw_assignments[raw_index] = max(candidates, key=lambda item: item[1])[0]

    assigned_by_hint: dict[int, list[int]] = {}
    for raw_index, hint_index in raw_assignments.items():
        assigned_by_hint.setdefault(hint_index, []).append(raw_index)

    entries: list[tuple[float, dict[str, Any]]] = []
    for hint_index, hint in enumerate(text_hints):
        assigned = assigned_by_hint.get(hint_index, [])
        if assigned:
            sort_key = min(float(raw_blocks[index]["order"]) for index in assigned)
        else:
            same_page = [block for block in raw_blocks if int(block["page"]) == int(hint["page"])]
            following = [
                float(block["order"]) for block in same_page
                if float(block["bbox"][1]) >= float(hint["bbox"][1])
            ]
            sort_key = min(following, default=max((float(block["order"]) for block in same_page), default=0.0) + 0.5) - 0.1
        text = normalize_scientific_text(str(hint["text"]))
        block = {
            "id": "",
            "stableId": stable_hash(int(hint["page"]), hint["bbox"], text),
            "page": int(hint["page"]),
            "type": DOCLING_TEXT_LABELS[str(hint["label"])],
            "order": 0,
            "originalText": text,
            "bbox": [round(float(value), 3) for value in hint["bbox"]],
            "confidence": "high",
            "refs": [],
            "continuationKey": str(hint.get("itemId") or "") or None,
            "_doclingItemId": str(hint.get("itemId") or "") or None,
            "_doclingItemOrder": int(hint.get("itemOrder", hint.get("order", 0))),
            "_provenanceIndex": int(hint.get("provenanceIndex", 0)),
            "_doclingLabel": str(hint.get("label", "")),
            "_rawSortKey": sort_key,
        }
        entries.append((sort_key, block))

    logical_blocks = [entry[1] for entry in entries]

    def is_redundant_raw_fragment(block: dict[str, Any]) -> bool:
        """Drop a glyph fragment already represented by a nearby Docling item.

        Superscripts at the bottom edge of a paragraph can fall just outside
        Docling's bbox and survive as a second pdfplumber block.  Only compact,
        single-line fragments whose tokens are already present in the adjacent
        logical item are removed; genuinely missing text remains untouched.
        """
        raw_text = normalize_text(str(block.get("originalText", "")))
        raw_bbox = [float(value) for value in block["bbox"]]
        if not raw_text or len(raw_text) > 48 or raw_bbox[3] - raw_bbox[1] > 20.0:
            return False
        raw_tokens = [token.lower() for token in re.findall(r"\w+", raw_text, flags=re.UNICODE)]
        raw_compact = re.sub(r"[^\w]+", "", raw_text, flags=re.UNICODE).lower()
        contains_math_glyph = any(ord(character) > 0x2FFF for character in raw_text) or bool(
            re.search(r"[=+−×÷∕⁄]", raw_text)
        )
        for candidate in logical_blocks:
            if int(candidate["page"]) != int(block["page"]):
                continue
            candidate_bbox = [float(value) for value in candidate["bbox"]]
            vertical_gap = raw_bbox[1] - candidate_bbox[3]
            if vertical_gap < -4.0 or vertical_gap > 18.0:
                continue
            horizontal_overlap = max(
                0.0,
                min(raw_bbox[2], candidate_bbox[2]) - max(raw_bbox[0], candidate_bbox[0]),
            )
            if horizontal_overlap / max(1.0, raw_bbox[2] - raw_bbox[0]) < 0.35:
                continue
            candidate_text = normalize_text(str(candidate.get("originalText", "")))
            candidate_lower = candidate_text.lower()
            candidate_compact = re.sub(r"[^\w]+", "", candidate_text, flags=re.UNICODE).lower()
            if raw_compact and raw_compact in candidate_compact:
                return True
            if contains_math_glyph and raw_tokens and all(token in candidate_lower for token in raw_tokens):
                return True
        return False

    for raw_index, block in enumerate(raw_blocks):
        if raw_index not in raw_assignments:
            if is_redundant_raw_fragment(block):
                continue
            block["_doclingItemOrder"] = None
            block["_provenanceIndex"] = 0
            block["_doclingLabel"] = ""
            block["_rawSortKey"] = float(block["order"])
            entries.append((float(block["order"]), block))

    entries.sort(key=lambda entry: (int(entry[1]["page"]), entry[0], float(entry[1]["bbox"][1]), float(entry[1]["bbox"][0])))
    return [entry[1] for entry in entries]


def _running_signature(value: str) -> str:
    normalized = normalize_text(value).lower()
    normalized = re.sub(r"\d+", "#", normalized)
    return re.sub(r"[^a-z#]+", " ", normalized).strip()


def mark_running_matter(
    blocks: list[dict[str, Any]],
    page_sizes: dict[int, tuple[float, float]],
) -> None:
    """Classify page chrome without deleting immutable source evidence.

    Geometry handles vertical download watermarks while repetition handles
    alternating journal headers and page-numbered footers. The classifier is
    intentionally limited to the page margins so repeated scientific prose is
    never removed merely because it occurs more than once.
    """
    signatures: dict[str, set[int]] = {}
    for block in blocks:
        signature = _running_signature(str(block.get("originalText", "")))
        if signature:
            signatures.setdefault(signature, set()).add(int(block["page"]))

    # Line-numbered manuscripts expose every 5th line as an independent text
    # item.  They are page chrome, not 100+ tiny paragraphs to translate.  A
    # cluster of at least three narrow integer labels in an outer page margin
    # is sufficiently specific while also safely removing plot-axis ticks that
    # escaped a picture region.
    margin_numbers_by_page: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        page = int(block["page"])
        page_width, _ = page_sizes.get(page, (595.0, 842.0))
        x0, top, x1, bottom = (float(value) for value in block["bbox"])
        text = normalize_text(str(block.get("originalText", "")))
        in_outer_margin = x1 <= page_width * 0.085 or x0 >= page_width * 0.915
        if (
            in_outer_margin
            and bottom - top <= 15.0
            and re.fullmatch(r"\d{1,4}", text)
        ):
            margin_numbers_by_page.setdefault(page, []).append(block)
    manuscript_line_number_ids = {
        id(block)
        for candidates in margin_numbers_by_page.values()
        if len(candidates) >= 3
        for block in candidates
    }

    for block in blocks:
        page = int(block["page"])
        page_width, page_height = page_sizes.get(page, (595.0, 842.0))
        x0, top, x1, bottom = (float(value) for value in block["bbox"])
        width = max(0.0, x1 - x0)
        height = max(0.0, bottom - top)
        text = normalize_text(str(block.get("originalText", "")))
        lowered = text.lower()
        signature = _running_signature(text)
        repeated = len(signatures.get(signature, set())) >= 2
        vertical_watermark = (
            (x0 >= page_width * 0.955 and width <= page_width * 0.05)
            or (width <= max(10.0, page_width * 0.02) and height >= page_height * 0.35)
        )
        top_margin = bottom <= page_height * 0.09
        bottom_margin = top >= page_height * 0.90
        known_download_notice = "downloaded from http" in lowered or "terms-and-conditions" in lowered
        known_web_header = top_margin and (lowered.startswith("www.") or "wiley.com" in lowered)
        repeated_margin = repeated and (top_margin or bottom_margin)
        journal_footer = bottom_margin and bool(re.search(r"(?:©|copyright|adv\.?\s+\w+\s+mater|wileyonlinelibrary|doi)", lowered))
        publication_rights_notice = bool(
            re.match(
                r"^(?:(?:copyright\s*)?©\s*)?(?:\d{4}\s*)?(?:the\s+)?author(?:\(s\)|s)?\b",
                text,
                re.IGNORECASE,
            )
            and ("©" in text or lowered.startswith("copyright"))
        ) or (
            "open access article" in lowered
            and "creative commons" in lowered
            and ("published by" in lowered or "license" in lowered)
        )
        if (
            id(block) in manuscript_line_number_ids
            or vertical_watermark
            or known_download_notice
            or known_web_header
            or repeated_margin
            or journal_footer
            or publication_rights_notice
        ):
            block["type"] = "running_matter"
            block["continuationKey"] = None


def normalize_formula_transcription(value: str) -> str:
    """Return the formula payload without Docling protocol wrappers.

    The formula model normally returns LaTeX.  Keeping that text verbatim (apart
    from transport markers and whitespace) is important: chemical subscripts,
    equation numbers and operators must not be rewritten by language heuristics.
    """
    normalized = normalize_text(value)
    normalized = re.sub(r"^<formula>\s*", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s*</formula>$", "", normalized, flags=re.IGNORECASE)
    normalized = normalized.replace("<end_of_utterance>", "").strip()
    return normalized


def formula_hint_key(hint: dict[str, Any]) -> str:
    return ":".join((
        str(int(hint.get("page", 0))),
        str(hint.get("itemId") or hint.get("itemOrder") or hint.get("order") or ""),
        str(int(hint.get("provenanceIndex", 0))),
    ))


def extract_formula_text(page: Any, bbox: list[float]) -> str:
    """Extract searchable text only from one formula rectangle.

    Publishers frequently paint mathematical glyphs twice and place subscripts
    on a second baseline. ``dedupe_chars`` removes exact overprint duplicates;
    retaining line breaks keeps the script line available without pretending it
    is prose. The accompanying PNG remains authoritative for visual layout.
    """
    page_bbox = (
        max(0.0, float(bbox[0]) - 1.5),
        max(0.0, float(bbox[1]) - 1.5),
        min(float(page.width), float(bbox[2]) + 1.5),
        min(float(page.height), float(bbox[3]) + 1.5),
    )
    try:
        region = page.crop(page_bbox, strict=False).dedupe_chars(
            tolerance=0.5,
            extra_attrs=("fontname", "size"),
        )
        extracted = str(region.extract_text(x_tolerance=1, y_tolerance=3) or "")
    except Exception:
        return ""
    lines = [normalize_text(line) for line in extracted.splitlines()]
    return "\n".join(line for line in lines if line)


def _credible_formula_enrichment(enriched: str, fallback: str) -> bool:
    """Reject truncated or visually unrelated model transcriptions."""
    if not enriched:
        return False
    if enriched.count("{") != enriched.count("}") or enriched.rstrip().endswith(("\\", "{", "=", "+", "−", "-")):
        return False
    if not fallback:
        return True
    replacements = {
        r"\theta": "θ", r"\nabla": "∇", r"\partial": "∂", r"\cdot": "·",
        r"\Omega": "Ω", r"\lambda": "λ", r"\sigma": "σ", r"\varepsilon": "ε",
    }
    comparable = enriched
    for latex, glyph in replacements.items():
        comparable = comparable.replace(latex, glyph)
    enriched_key = re.sub(r"[^A-Za-z0-9θ∇∂·Ωλσε]+", "", comparable).lower()
    fallback_key = re.sub(r"[^A-Za-z0-9θ∇∂·Ωλσε]+", "", fallback).lower()
    if not enriched_key or not fallback_key:
        return False
    length_ratio = len(enriched_key) / max(1, len(fallback_key))
    similarity = difflib.SequenceMatcher(None, enriched_key, fallback_key).ratio()
    return 0.55 <= length_ratio <= 2.25 and similarity >= 0.5


def _formula_fallback_text(candidates: list[dict[str, Any]]) -> str:
    """Recover selectable PDF text when formula enrichment is unavailable.

    pdfplumber often exposes an equation as several physical fragments.  Merge
    them in geometric order and remove exact duplicates, while preserving every
    scientific token.  This fallback makes formula evidence useful offline and
    also protects parsing when a model artifact is missing or cannot run.
    """
    pieces: list[str] = []
    ordered = sorted(
        candidates,
        key=lambda block: (
            float(block.get("_rawSortKey", block.get("order", 0))),
            float(block["bbox"][1]),
            float(block["bbox"][0]),
        ),
    )
    for candidate in ordered:
        text = normalize_formula_transcription(str(candidate.get("originalText", "")))
        if not text:
            continue
        if pieces and text == pieces[-1]:
            continue
        pieces.append(text)
    return " ".join(pieces).strip()


def mark_formula_regions(
    blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
    page_fallbacks: dict[str, str] | None = None,
) -> None:
    """Preserve every detected equation as source-addressable evidence.

    Enriched Docling LaTeX is preferred.  Selectable PDF text is a deterministic
    fallback; a formula is never replaced by a generic "refer to PDF" marker.
    Formula blocks remain outside translation, but are available to retrieval,
    analysis, the reader and the Markdown publisher.
    """
    formula_hints = [hint for hint in hints if hint.get("label") == "formula"]
    remove_ids: set[int] = set()
    formula_blocks: list[dict[str, Any]] = []
    for hint in formula_hints:
        candidates = [
            block for block in blocks
            if block.get("type") not in {"running_matter", "caption", "reference", "figure_text"}
            and int(hint.get("page", 0)) == int(block["page"])
            and (
                bbox_overlap(list(block["bbox"]), list(hint["bbox"])) >= 0.24
                or bbox_center_inside(list(block["bbox"]), list(hint["bbox"]), padding=8.0)
            )
        ]
        raw_sort_key = min((float(block.get("_rawSortKey", block.get("order", 0))) for block in candidates), default=float(hint.get("order", 0)))
        fallback_candidates: list[dict[str, Any]] = []
        for candidate in candidates:
            text = normalize_text(str(candidate.get("originalText", "")))
            metadata_match = re.search(r"\b(?:Received|Revised|Accepted):\s*.+$", text, re.IGNORECASE)
            if metadata_match:
                formula_prefix = text[:metadata_match.start()].strip()
                if formula_prefix:
                    fallback_candidates.append({**candidate, "originalText": formula_prefix})
                candidate["originalText"] = metadata_match.group(0)
                candidate["type"] = "note"
                candidate["continuationKey"] = None
                candidate["bbox"][0] = min(float(candidate["bbox"][2]), float(hint["bbox"][2]) + 8.0)
            else:
                fallback_candidates.append(candidate)
                remove_ids.add(id(candidate))
        page = int(hint["page"])
        bbox = [round(float(value), 3) for value in hint["bbox"]]
        enriched_text = normalize_formula_transcription(str(hint.get("text", "")))
        fallback_text = normalize_formula_transcription(
            str((page_fallbacks or {}).get(formula_hint_key(hint), "")),
        ) or _formula_fallback_text(fallback_candidates)
        formula_text = enriched_text if _credible_formula_enrichment(enriched_text, fallback_text) else fallback_text or enriched_text
        if not formula_text:
            # Empty regions are retained as an explicit parse failure instead of
            # silently disappearing.  The quality gate/audit can then surface a
            # precise page and bbox for repair.
            formula_text = "[公式转写失败：原始区域已保留]"
        formula_blocks.append({
            "id": "",
            "stableId": stable_hash(page, bbox, f"formula:{hint.get('itemId') or hint.get('itemOrder')}"),
            "page": page,
            "type": "formula",
            "order": 0,
            "originalText": formula_text,
            "bbox": bbox,
            "confidence": "high" if enriched_text and formula_text == enriched_text else ("medium" if fallback_text else "low"),
            "refs": [],
            "continuationKey": None,
            "_doclingItemId": str(hint.get("itemId") or "") or None,
            "_doclingItemOrder": int(hint.get("itemOrder", hint.get("order", 0))),
            "_provenanceIndex": int(hint.get("provenanceIndex", 0)),
            "_doclingLabel": "formula",
            "_rawSortKey": raw_sort_key,
        })
    blocks[:] = [block for block in blocks if id(block) not in remove_ids]
    blocks.extend(formula_blocks)


def select_document_title(
    blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
    metadata: dict[str, Any],
    fallback: str,
) -> str:
    def is_title_candidate(value: str) -> bool:
        normalized = normalize_text(value)
        return (
            20 <= len(normalized) <= 320
            and not GENERIC_SECTION_HEADING_RE.match(normalized.rstrip(":"))
            and not REPOSITORY_CITATION_RE.search(normalized)
            and not re.match(r"^\d+(?:\.\d+)*\.?\s+", normalized)
        )

    metadata_title = next(
        (
            normalize_text(str(value))
            for key, value in metadata.items()
            if str(key).lower() == "title" and str(value).strip()
        ),
        "",
    )
    # Repository and preprint cover sheets can move the real article title to
    # page 2 or 3.  Five pages is deliberately bounded: it covers those front
    # sheets without allowing a later section heading to become the title.
    explicit_titles = [
        normalize_text(str(hint.get("text", ""))) for hint in hints
        if int(hint.get("page", 0)) <= 5
        and hint.get("label") == "title"
        and is_title_candidate(str(hint.get("text", "")))
    ]
    early_headings = [
        normalize_text(str(hint.get("text", ""))) for hint in hints
        if int(hint.get("page", 0)) <= 5
        and hint.get("label") == "section_header"
        and is_title_candidate(str(hint.get("text", "")))
    ]
    structural_title = max(explicit_titles or early_headings, key=len, default="")
    if structural_title and (not metadata_title or len(structural_title) >= len(metadata_title) * 1.2):
        return structural_title
    if (
        metadata_title
        and not metadata_title.lower().startswith("microsoft word")
        and is_title_candidate(metadata_title)
    ):
        return metadata_title
    if structural_title:
        return structural_title
    first = next(
        (
            normalize_text(str(block.get("originalText", ""))) for block in blocks
            if int(block.get("page", 0)) <= 2
            and block.get("type") in {"heading", "paragraph"}
            and is_title_candidate(str(block.get("originalText", "")))
            and block.get("type") != "running_matter"
        ),
        "",
    )
    return first or fallback


def mark_front_matter(
    blocks: list[dict[str, Any]],
    title: str,
    page_sizes: dict[int, tuple[float, float]] | None = None,
) -> None:
    """Separate authors, affiliations and contact footnotes from narrative.

    Some two-column journals place the author affiliation footnote between the
    left-column beginning and right-column continuation of the Introduction.
    Docling correctly labels the first line as a footnote, but PDF text
    extraction can expose its address and e-mail as independent paragraphs.
    Treat the entire compact contact group as front matter so it cannot split a
    scientific paragraph in the reading projection or model context.
    """
    for block in blocks:
        if re.match(
            r"^(?:Received|Revised|Accepted):\s*",
            normalize_text(str(block.get("originalText", ""))),
            re.IGNORECASE,
        ):
            block["type"] = "front_matter"
            block["continuationKey"] = None
    title_candidates = [
        block for block in blocks
        if int(block["page"]) <= 5 and block.get("type") != "running_matter"
    ]
    if not title_candidates:
        return
    normalized_title = normalize_text(title).lower()
    title_block = max(
        title_candidates,
        key=lambda block: difflib.SequenceMatcher(
            None,
            normalize_text(str(block.get("originalText", ""))).lower(),
            normalized_title,
        ).ratio(),
        default=None,
    )
    if title_block is not None:
        score = difflib.SequenceMatcher(
            None,
            normalize_text(str(title_block.get("originalText", ""))).lower(),
            normalized_title,
        ).ratio()
        if score >= 0.72:
            title_block["type"] = "heading"
            title_block["_logicalPriority"] = -2
        else:
            title_block = None

    title_page = int(title_block["page"]) if title_block is not None else 1
    early_blocks = [
        block for block in title_candidates
        if int(block["page"]) <= max(2, title_page)
    ]
    title_page_blocks = [
        block for block in early_blocks if int(block["page"]) == title_page
    ]
    for block in early_blocks:
        if int(block["page"]) >= title_page:
            continue
        if block.get("type") not in {"caption", "table", "figure_text", "formula"}:
            block["type"] = "front_matter"
            block["continuationKey"] = None

    body_heading = next(
        (
            block for block in title_page_blocks
            if block is not title_block
            and block.get("type") == "heading"
            and re.match(
                r"^(?:\d+(?:\.\d+)*\.?\s*)?(?:abstract|introduction|background|results?|discussion|methods?)\b",
                normalize_text(str(block.get("originalText", ""))),
                re.IGNORECASE,
            )
        ),
        None,
    )
    boundary = int(body_heading.get("_doclingItemOrder", 10**9)) if body_heading else 10**9
    explicit_abstract_heading = bool(
        body_heading
        and re.match(r"^(?:\d+(?:\.\d+)*\.?\s*)?abstract\b", normalize_text(str(body_heading.get("originalText", ""))), re.IGNORECASE)
    )
    abstract_candidates = [] if explicit_abstract_heading else [
        block for block in title_page_blocks
        if block is not title_block
        and block.get("type") == "paragraph"
        and int(block.get("_doclingItemOrder") or 0) < boundary
        and len(normalize_text(str(block.get("originalText", "")))) >= 450
    ]
    # Some journals run an unheaded abstract directly into an unheaded
    # introduction on page one. In that layout every substantial text item is
    # narrative; keeping only the longest candidate can hide the neighbouring
    # abstract/body paragraphs as author metadata. The first logical item is
    # the abstract anchor, while all long candidates remain reader evidence.
    abstract = min(
        abstract_candidates,
        key=lambda block: (
            int(block["_doclingItemOrder"])
            if block.get("_doclingItemOrder") is not None
            else 10**9
        ),
        default=None,
    )
    narrative_candidate_ids = {id(block) for block in abstract_candidates}
    if abstract is not None:
        abstract["_logicalPriority"] = -1
        abstract["_frontAbstract"] = True

    for block in title_page_blocks:
        if block is title_block or id(block) in narrative_candidate_ids or block is body_heading:
            continue
        item_order = block.get("_doclingItemOrder")
        if item_order is not None and int(item_order) >= boundary:
            continue
        if block.get("type") not in {"caption", "table", "figure_text", "formula"}:
            block["type"] = "front_matter"
            block["continuationKey"] = None

    page_height = float((page_sizes or {}).get(title_page, (0.0, 0.0))[1])
    if page_height <= 0:
        page_height = max(
            (
                float(block["bbox"][3]) for block in title_page_blocks
                if isinstance(block.get("bbox"), list) and len(block["bbox"]) >= 4
            ),
            default=792.0,
        )

    author_re = re.compile(
        r"(?:\b[A-Z](?:\.[- ]?|[- ])[A-Z][A-Za-z'\u2019-]+(?:,|\s+and\s+)){2,}",
        re.IGNORECASE,
    )
    affiliation_re = re.compile(
        r"\b(?:department|faculty|school|college|university|institute|institution|laboratory|"
        r"research\s+(?:center|centre)|academy|hospital)\b",
        re.IGNORECASE,
    )
    contact_re = re.compile(
        r"(?:\b(?:e-?mail|email)\s*:|"
        r"\bcorresponding\s+author\b|"
        r"\bcorrespondence\s*(?:to|:)|"
        r"\bcontact\s*(?:author|information|:)|"
        r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})",
        re.IGNORECASE,
    )
    postal_re = re.compile(
        r"(?:\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b|"
        r"\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b|"
        r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b)",
        re.IGNORECASE,
    )

    def looks_like_author_list(value: str) -> bool:
        """Recognize long author rows even when superscripts split names.

        Repository manuscripts often expose affiliation numbers as ordinary
        baseline text (``First Author 1,2, Second Author 3``). A conventional
        name regex then sees the commas inside the superscripts instead of the
        separators between authors. This fallback is used only in the geometric
        zone between the title and the abstract/body heading.
        """
        parts = re.split(r"\s*(?:,|;|&|\band\b)\s*", normalize_text(value), flags=re.IGNORECASE)
        name_segments = 0
        for part in parts:
            cleaned = re.sub(r"[\d\s†‡*#,+]+$", "", part).strip(" ()[]")
            name_words = re.findall(r"\b(?:[A-Z]\.|[A-Z][A-Za-z'\u2019-]{1,})\b", cleaned)
            lower_words = re.findall(r"\b[a-z]{3,}\b", cleaned)
            if 2 <= len(name_words) <= 6 and len(lower_words) <= 1:
                name_segments += 1
        return name_segments >= 4

    title_bottom = float(title_block["bbox"][3]) if title_block and len(title_block.get("bbox", [])) >= 4 else 0.0
    narrative_tops = [
        float(candidate["bbox"][1])
        for candidate in (abstract, body_heading)
        if candidate is not None and len(candidate.get("bbox", [])) >= 4
    ]
    narrative_top = min(narrative_tops, default=page_height * 0.68)

    contact_anchors: list[dict[str, Any]] = []
    for block in title_page_blocks:
        if block is title_block or block is abstract or block is body_heading:
            continue
        text = normalize_text(str(block.get("originalText", "")))
        if not isinstance(block.get("bbox"), list) or len(block["bbox"]) < 4:
            continue
        bbox = list(block["bbox"])
        height = float(bbox[3]) - float(bbox[1])
        # PDF text boxes are not pixel-aligned.  A wrapped affiliation footnote
        # in the Singh regression corpus is 45.056 pt high, so a hard 45 pt
        # cutoff left it in the narrative and blocked the real page-spanning
        # paragraph on either side.  Fifty-two points still covers only compact
        # title-page notes, while tolerating the normal font/bbox rounding drift.
        lower_page_compact = float(bbox[1]) >= page_height * 0.5 and height <= 52 and len(text) <= 400
        author_zone = (
            float(bbox[1]) >= title_bottom - 4
            and float(bbox[3]) <= narrative_top - 2
            and len(text) <= 1_600
        )
        docling_note = block.get("type") == "note" or block.get("_doclingLabel") in {"footnote", "note"}
        explicit_contact = bool(contact_re.search(text))
        explicit_author_list = author_zone and (bool(author_re.search(text)) or looks_like_author_list(text))
        compact_affiliation = lower_page_compact and bool(
            affiliation_re.search(text) or postal_re.search(text) or author_re.search(text)
        )
        if explicit_contact or explicit_author_list or (lower_page_compact and docling_note) or compact_affiliation:
            block["type"] = "front_matter"
            block["continuationKey"] = None
            contact_anchors.append(block)

    # Affiliation addresses often wrap to a short country/city line that has no
    # semantic keyword of its own. Extend only downwards, within the same narrow
    # column and across a small vertical gap, so body text above the note cannot
    # be swallowed.
    for anchor in contact_anchors:
        tail = anchor
        while True:
            tail_bbox = list(tail["bbox"])
            tail_width = max(1.0, float(tail_bbox[2]) - float(tail_bbox[0]))
            candidates: list[dict[str, Any]] = []
            for candidate in title_page_blocks:
                if candidate is tail or candidate is title_block or candidate is abstract or candidate is body_heading:
                    continue
                if candidate.get("type") in {"heading", "caption", "table", "figure_text", "formula", "running_matter"}:
                    continue
                candidate_bbox = list(candidate["bbox"])
                gap = float(candidate_bbox[1]) - float(tail_bbox[3])
                if gap < -1.5 or gap > 16:
                    continue
                overlap = max(
                    0.0,
                    min(float(tail_bbox[2]), float(candidate_bbox[2]))
                    - max(float(tail_bbox[0]), float(candidate_bbox[0])),
                )
                candidate_width = max(1.0, float(candidate_bbox[2]) - float(candidate_bbox[0]))
                if overlap / min(tail_width, candidate_width) < 0.55:
                    continue
                candidate_text = normalize_text(str(candidate.get("originalText", "")))
                candidate_height = float(candidate_bbox[3]) - float(candidate_bbox[1])
                if len(candidate_text) > 180 or candidate_height > 28:
                    continue
                candidates.append(candidate)
            if not candidates:
                break
            next_block = min(candidates, key=lambda candidate: float(candidate["bbox"][1]))
            next_block["type"] = "front_matter"
            next_block["continuationKey"] = None
            tail = next_block


def mark_ancillary_metadata(blocks: list[dict[str, Any]]) -> None:
    """Keep contact records and publisher metadata out of fine reading.

    Contact details are not confined to page one: ACS papers commonly append
    a full ``AUTHOR INFORMATION`` directory after the conclusions, while Cell
    Press methods include a ``Lead contact`` record.  Likewise, Elsevier may
    split ``Available online 22 August 2024`` into five layout items after the
    Introduction heading.  These remain source-addressable metadata but must
    never split or be sent as scientific narrative.
    """
    author_start_re = re.compile(
        r"^[^A-Za-z]*(?:author\s+information|authors?\s+and\s+affiliations?|affiliations?)[^A-Za-z]*$",
        re.IGNORECASE,
    )
    author_child_re = re.compile(
        r"^[^A-Za-z]*(?:corresponding\s+authors?|authors?|affiliations?|present\s+addresses?)[^A-Za-z]*$",
        re.IGNORECASE,
    )
    explicit_contact_re = re.compile(
        r"(?:\b(?:e-?mail|email)\s*:|"
        r"\bcorresponding\s+authors?\b|"
        r"\bcorrespondence\s*(?:to|:)|"
        r"\bplease\s+contact\b|"
        r"\bcomplete\s+contact\s+information\b|"
        r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})",
        re.IGNORECASE,
    )
    preserved_types = {"caption", "table", "table_row", "figure_text", "formula", "running_matter", "reference"}
    max_page = max((int(block.get("page", 1)) for block in blocks), default=1)

    author_information = False
    for block in blocks:
        text = normalize_text(str(block.get("originalText", ""))).strip()
        is_heading = block.get("type") == "heading"
        if is_heading and author_start_re.fullmatch(text):
            author_information = True
        elif author_information and is_heading and not author_child_re.fullmatch(text):
            author_information = False
        if (
            (author_information or explicit_contact_re.search(text))
            and block.get("type") not in preserved_types
        ):
            block["type"] = "front_matter"
            block["continuationKey"] = None

    # Nature-family articles place non-scientific publisher records after an
    # ``Additional information`` heading: peer-review notices, reprint links,
    # publisher notes and the open-access licence.  Keep them source-addressable
    # but outside fine reading.  The end-of-document and post-reference guards
    # prevent an ordinary scientific heading with the same words from starting
    # this mode in the body of a paper.
    additional_information_re = re.compile(r"^additional\s+information\s*:?$", re.IGNORECASE)
    publisher_boilerplate_re = re.compile(
        r"^(?:supplementary\s+information\b|"
        r"correspondence\s+and\s+requests\s+for\s+materials\b|"
        r"peer\s+review\s+information\b|"
        r"reprints?\s+and\s+permissions?\b|"
        r"www\.[^\s]+/reprints\b|"
        r"publisher['’]?s\s+note\b|"
        r"open\s+access\b.*\b(?:creative\s+commons|licensed)\b)",
        re.IGNORECASE,
    )
    publisher_metadata = False
    seen_reference = False
    for block in blocks:
        text = normalize_text(str(block.get("originalText", ""))).strip()
        if block.get("type") == "reference":
            seen_reference = True
        near_document_end = int(block.get("page", 1)) >= max(1, max_page - 2)
        if (
            additional_information_re.fullmatch(text)
            and (seen_reference or near_document_end)
        ):
            publisher_metadata = True
        if (
            (publisher_metadata or publisher_boilerplate_re.match(text))
            and block.get("type") not in preserved_types
        ):
            block["type"] = "front_matter"
            block["continuationKey"] = None

    # Detect fragmented publication dates by semantic neighbourhood rather
    # than their physical position; multi-column layout can place them after
    # the first body heading in extraction order.
    month_re = re.compile(
        r"^(?:January|February|March|April|May|June|July|August|September|October|November|December)$",
        re.IGNORECASE,
    )
    allowed_fragment_re = re.compile(
        r"^(?:Available|online|\d{1,2}|(?:19|20)\d{2}|"
        r"January|February|March|April|May|June|July|August|September|October|November|December)$",
        re.IGNORECASE,
    )
    by_page: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        if block.get("_doclingItemOrder") is not None:
            by_page.setdefault(int(block["page"]), []).append(block)
    for page_blocks in by_page.values():
        for anchor in page_blocks:
            anchor_text = normalize_text(str(anchor.get("originalText", "")))
            if anchor_text.lower() not in {"available", "online"} and "available online" not in anchor_text.lower():
                continue
            anchor_order = int(anchor.get("_doclingItemOrder", 0))
            neighbours = [
                candidate for candidate in page_blocks
                if abs(int(candidate.get("_doclingItemOrder", 0)) - anchor_order) <= 4
            ]
            neighbour_texts = [normalize_text(str(candidate.get("originalText", ""))) for candidate in neighbours]
            if not any(month_re.fullmatch(value) for value in neighbour_texts):
                continue
            if not any(re.fullmatch(r"(?:19|20)\d{2}", value) for value in neighbour_texts):
                continue
            for candidate in neighbours:
                candidate_text = normalize_text(str(candidate.get("originalText", "")))
                if allowed_fragment_re.fullmatch(candidate_text) and candidate.get("type") not in preserved_types:
                    candidate["type"] = "front_matter"
                    candidate["continuationKey"] = None


def mark_inline_section_headings(blocks: list[dict[str, Any]]) -> None:
    """Promote compact title-case method labels that Docling leaves as text."""
    connector = r"(?:and|or|of|for|in|on|the|with|without|via|to)"
    title_word = r"(?:[A-Z][A-Za-z0-9+\-/()]*)"
    inline_heading = re.compile(
        rf"^{title_word}(?:\s+(?:{connector}|{title_word})){{0,7}}\s*:\s*$"
    )
    for block in blocks:
        if block.get("type") != "paragraph":
            continue
        text = normalize_text(str(block.get("originalText", "")))
        if len(text) > 80 or not inline_heading.fullmatch(text):
            continue
        block["type"] = "heading"


def mark_reference_list_items(blocks: list[dict[str, Any]]) -> None:
    """Recognize bibliography lists even when the PDF omits a References heading."""
    max_page = max((int(block["page"]) for block in blocks), default=1)
    candidates = [
        block for block in blocks
        if block.get("_doclingLabel") == "list_item"
        and int(block["page"]) >= max(1, max_page - 2)
        and block.get("type") not in {"running_matter", "figure_text"}
    ]
    bibliographic = [
        block for block in candidates
        if re.search(r"\b(?:19|20)\d{2}\b", str(block.get("originalText", "")))
        and (
            re.search(r"\b[A-Z]\.\s*[A-Z]", str(block.get("originalText", "")))
            or re.search(r"\b(?:doi|vol\.|pp?\.|et al\.)\b", str(block.get("originalText", "")), re.IGNORECASE)
        )
    ]
    if len(candidates) < 3 or len(bibliographic) / len(candidates) < 0.6:
        return
    for block in candidates:
        block["type"] = "reference"
        block["continuationKey"] = None


def mark_reference_sections(blocks: list[dict[str, Any]]) -> None:
    """Classify explicit bibliography sections after Docling consolidation.

    Raw PDF extraction can identify a References heading correctly, only for
    Docling's logical text replacement to restore the individual entries as
    ordinary paragraphs. Reapply the section boundary on the final logical
    order and stop at acknowledgements, availability statements or Methods so
    supplementary prose is never swallowed by a bibliography that appeared
    earlier in the file.
    """
    references_mode = False
    for block in blocks:
        text = normalize_text(str(block.get("originalText", ""))).rstrip(":")
        if REFERENCE_HEADING_RE.fullmatch(text):
            references_mode = True
            block["type"] = "reference"
            block["continuationKey"] = None
            continue
        if (
            references_mode
            and block.get("type") == "heading"
            and REFERENCE_SECTION_END_RE.match(text)
        ):
            references_mode = False
            continue
        if references_mode and block.get("type") not in {
            "caption",
            "table",
            "figure_text",
            "formula",
            "front_matter",
            "running_matter",
        }:
            block["type"] = "reference"
            block["continuationKey"] = None


def sort_blocks_logically(blocks: list[dict[str, Any]]) -> None:
    """Use Docling item/provenance order instead of physical row order.

    This is essential for two-column documents where the next logical fragment
    can be physically to the left of a header or to the right of another block.
    """
    known_by_page: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        if block.get("_doclingItemOrder") is not None:
            known_by_page.setdefault(int(block["page"]), []).append(block)

    for block in blocks:
        item_order = block.get("_doclingItemOrder")
        provenance = int(block.get("_provenanceIndex", 0))
        if item_order is not None:
            logical = float(item_order) + provenance / 1000.0
        else:
            page_known = known_by_page.get(int(block["page"]), [])
            raw_key = float(block.get("_rawSortKey", block.get("order", 0)))
            nearest = min(
                page_known,
                key=lambda candidate: abs(float(candidate.get("_rawSortKey", 0)) - raw_key),
                default=None,
            )
            if nearest is not None:
                nearest_logical = float(nearest["_doclingItemOrder"]) + int(nearest.get("_provenanceIndex", 0)) / 1000.0
                direction = -0.0001 if raw_key < float(nearest.get("_rawSortKey", 0)) else 0.0001
                logical = nearest_logical + direction
            else:
                logical = int(block["page"]) * 10000.0 + raw_key
        block["_logicalOrder"] = logical

    blocks.sort(key=lambda block: (
        1 if block.get("type") == "running_matter" else 0,
        int(block.get("_logicalPriority", 0)),
        float(block.get("_logicalOrder", 0)),
        int(block["page"]),
        float(block["bbox"][1]),
        float(block["bbox"][0]),
    ))


def mark_semantic_paragraph_continuations(
    blocks: list[dict[str, Any]],
    page_sizes: dict[int, tuple[float, float]] | None = None,
    layout_hints: list[dict[str, Any]] | None = None,
) -> None:
    """Repair cross-page paragraph identity when Docling starts a new item.

    A continuation normally touches the bottom/top page bands. A journal may,
    however, insert one or two dedicated figure/table pages (or a visual at the
    top of the resume page) in the middle of one logical paragraph. Those visual
    interruptions are allowed only when every skipped page is visual-only and no
    semantic heading/body boundary occurs between the fragments. The evidence
    blocks remain separate so every page bbox stays addressable; only their
    logical continuation identity is unified.
    """
    visual_block_types = {"caption", "figure_text", "table", "table_row"}
    ignored_page_types = {"running_matter", "front_matter"}
    visual_hint_labels = {"picture", "table"}
    hints = layout_hints or []

    def page_height(page_number: int) -> float:
        page_size = (page_sizes or {}).get(page_number)
        if page_size:
            return float(page_size[1])
        return max(
            (float(block["bbox"][3]) for block in blocks if int(block["page"]) == page_number),
            default=792.0,
        )

    def hint_bbox(hint: dict[str, Any]) -> list[float] | None:
        bbox = hint.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            return None
        return [float(value) for value in bbox]

    def page_has_visual(page_number: int) -> bool:
        return any(
            int(block["page"]) == page_number and block.get("type") in visual_block_types
            for block in blocks
        ) or any(
            int(hint.get("page", 0)) == page_number and hint.get("label") in visual_hint_labels
            for hint in hints
        )

    def is_visual_only_page(page_number: int) -> bool:
        if not page_has_visual(page_number):
            return False
        return not any(
            int(block["page"]) == page_number
            and block.get("type") not in visual_block_types | ignored_page_types
            and normalize_text(str(block.get("originalText", "")))
            for block in blocks
        )

    def has_visual_before(page_number: int, y_position: float) -> bool:
        block_visual = any(
            int(block["page"]) == page_number
            and block.get("type") in visual_block_types
            and float(block["bbox"][3]) <= y_position + 12.0
            for block in blocks
        )
        hint_visual = any(
            int(hint.get("page", 0)) == page_number
            and hint.get("label") in visual_hint_labels
            and (bbox := hint_bbox(hint)) is not None
            and bbox[3] <= y_position + 12.0
            for hint in hints
        )
        return block_visual or hint_visual

    indexed = [
        (index, block) for index, block in enumerate(blocks)
        if block.get("type") in {"paragraph", "reference"}
        and normalize_text(str(block.get("originalText", "")))
    ]
    for (previous_index, previous), (current_index, current) in zip(indexed, indexed[1:]):
        previous_page = int(previous["page"])
        current_page = int(current["page"])
        page_delta = current_page - previous_page
        # Two intervening visual-only pages are enough for normal journal
        # layouts while keeping distant, unrelated paragraphs from coalescing.
        if page_delta < 0 or page_delta > 3:
            continue
        if current.get("type") != previous.get("type"):
            continue
        previous_height = page_height(previous_page)
        current_height = page_height(current_page)
        previous_reaches_column_end = float(previous["bbox"][3]) >= previous_height * 0.62
        edge_to_edge = (
            previous_reaches_column_end
            and float(current["bbox"][1]) <= current_height * 0.30
        )
        same_page_column_turn = (
            page_delta == 0
            and previous_reaches_column_end
            and float(current["bbox"][0]) >= float(previous["bbox"][2]) + 8
            # A figure or table may occupy the top of the right column, so the
            # continuation can begin halfway down that column. It still cannot
            # start below the unfinished left-column fragment's bottom edge.
            and float(current["bbox"][1]) <= float(previous["bbox"][3])
        )
        same_page_vertical_resume = False
        if page_delta == 0:
            previous_bbox = [float(value) for value in previous["bbox"]]
            current_bbox = [float(value) for value in current["bbox"]]
            vertical_gap = current_bbox[1] - previous_bbox[3]
            horizontal_overlap = max(
                0.0,
                min(previous_bbox[2], current_bbox[2]) - max(previous_bbox[0], current_bbox[0]),
            )
            minimum_width = max(
                1.0,
                min(previous_bbox[2] - previous_bbox[0], current_bbox[2] - current_bbox[0]),
            )
            same_page_vertical_resume = (
                -2.0 <= vertical_gap <= 24.0
                and horizontal_overlap / minimum_width >= 0.55
            )
        skipped_pages_are_visual = page_delta >= 1 and all(
            is_visual_only_page(page_number)
            for page_number in range(previous_page + 1, current_page)
        )
        current_y = float(current["bbox"][1])
        resumes_after_visual = (
            page_delta >= 1
            and previous_reaches_column_end
            and skipped_pages_are_visual
            and current_y <= current_height * 0.72
            and (
                current_y <= current_height * 0.30
                or has_visual_before(current_page, current_y)
            )
        )
        if page_delta == 1 and not (edge_to_edge or resumes_after_visual):
            continue
        if page_delta == 0 and not (same_page_column_turn or same_page_vertical_resume):
            continue
        if page_delta >= 2 and not resumes_after_visual:
            continue
        intervening = blocks[previous_index + 1:current_index]
        if resumes_after_visual:
            if any(
                block.get("type") not in visual_block_types | ignored_page_types
                and normalize_text(str(block.get("originalText", "")))
                for block in intervening
            ):
                continue
        elif any(
            block.get("type") not in visual_block_types | ignored_page_types
            and normalize_text(str(block.get("originalText", "")))
            for block in intervening
        ):
            continue
        previous_text = normalize_text(str(previous.get("originalText", "")))
        current_text = normalize_text(str(current.get("originalText", "")))
        if re.search(r"[.!?][\"'’”）)\]]*(?:\s*\d+(?:\s*[-–,]\s*\d+)*)?$", previous_text):
            continue
        starts_like_continuation = bool(
            re.match(r"^[('\"‘“]*[a-z]", current_text)
            or re.match(r"^(?:and|or|but|because|which|that|with|without|via|versus|vs\.?)\b", current_text, re.IGNORECASE)
            or re.match(r"^[+−-]?(?:\d|[A-Z][a-z]?[+/])", current_text)
        )
        # Chemical formulae and acronyms legitimately begin with capitals. Only
        # accept them after a visual interruption when the prior fragment ends
        # with a word that grammatically requires the missing object.
        dangling_join_cue = bool(re.search(
            r"\b(?:a|an|the|in|of|on|at|to|for|from|with|without|between|among|into|onto|by|using|via|and|or)\s*$",
            previous_text,
            re.IGNORECASE,
        ))
        starts_scientific_term = bool(re.match(
            r"^(?:[A-Z][a-z]?(?=\d|\b)|[A-Z]{2,}(?:s|es)?(?=\d|\b))",
            current_text,
        ))
        if not (
            starts_like_continuation
            or (
                (resumes_after_visual or same_page_vertical_resume)
                and dangling_join_cue
                and starts_scientific_term
            )
        ):
            continue
        continuation_key = str(previous.get("continuationKey") or previous.get("_doclingItemId") or previous.get("stableId"))
        previous["continuationKey"] = continuation_key
        current["continuationKey"] = continuation_key


def mark_visual_region_text(blocks: list[dict[str, Any]], hints: list[dict[str, Any]]) -> None:
    """Keep selectable labels inside figures/tables as evidence, not narrative."""
    regions = [hint for hint in hints if hint.get("label") in {"picture", "table"}]
    for block in blocks:
        if block.get("type") in {"caption", "reference", "running_matter", "front_matter"}:
            continue
        for region in regions:
            if int(block["page"]) != int(region["page"]):
                continue
            block_bbox = list(block["bbox"])
            region_bbox = list(region["bbox"])
            # Axis labels frequently straddle Docling's picture boundary by a
            # point or two.  Center containment is more stable than demanding
            # 72% area overlap and still cannot capture prose outside the
            # actual visual region.  Four points of padding covers clipped
            # superscripts at the edge of a plot.
            if (
                bbox_overlap(block_bbox, region_bbox) >= 0.50
                or bbox_center_inside(block_bbox, region_bbox)
                or (
                    block.get("type") in {"paragraph", "note"}
                    and len(normalize_text(str(block.get("originalText", "")))) <= 80
                    and bbox_center_inside(block_bbox, region_bbox, padding=24.0)
                )
            ):
                block["type"] = "figure_text"
                block["continuationKey"] = None
                break


def deduplicate_physical_blocks(blocks: list[dict[str, Any]]) -> int:
    """Collapse duplicate emissions of the same physical evidence region.

    Docling can expose one selectable label through more than one layout item
    (for example, a figure label inherited by two neighbouring picture groups).
    Such entries have the same page, normalized text and rounded PDF bbox, so
    they are one source object rather than two pieces of evidence. Identical
    text at a different coordinate remains untouched.
    """
    type_priority = {
        "caption": 100,
        "formula": 95,
        "table": 90,
        "table_row": 90,
        "figure_text": 90,
        "heading": 85,
        "reference": 80,
        "front_matter": 75,
        "running_matter": 75,
        "paragraph": 50,
        "note": 45,
    }
    confidence_priority = {"low": 0, "medium": 1, "high": 2}
    unique: list[dict[str, Any]] = []
    by_physical_identity: dict[str, dict[str, Any]] = {}
    removed = 0

    for block in blocks:
        identity = stable_hash(
            int(block["page"]),
            [float(value) for value in block["bbox"]],
            str(block.get("originalText", "")),
        )
        existing = by_physical_identity.get(identity)
        if existing is None:
            by_physical_identity[identity] = block
            unique.append(block)
            continue

        removed += 1
        if type_priority.get(str(block.get("type")), 0) > type_priority.get(str(existing.get("type")), 0):
            existing["type"] = block["type"]
        if confidence_priority.get(str(block.get("confidence")), -1) > confidence_priority.get(str(existing.get("confidence")), -1):
            existing["confidence"] = block["confidence"]

        existing_refs = list(existing.get("refs") or [])
        for ref in block.get("refs") or []:
            if ref not in existing_refs:
                existing_refs.append(ref)
        existing["refs"] = existing_refs

        if not existing.get("continuationKey") and block.get("continuationKey"):
            existing["continuationKey"] = block["continuationKey"]
        if not existing.get("_doclingItemId") and block.get("_doclingItemId"):
            existing["_doclingItemId"] = block["_doclingItemId"]
        for key in ("_rawSortKey", "_logicalOrder"):
            values = [value for value in (existing.get(key), block.get(key)) if value is not None]
            if values:
                existing[key] = min(float(value) for value in values)
        for key in ("_doclingItemOrder", "_provenanceIndex"):
            values = [value for value in (existing.get(key), block.get(key)) if value is not None]
            if values:
                existing[key] = min(int(value) for value in values)

    blocks[:] = unique
    return removed


def ensure_unique_stable_ids(blocks: list[dict[str, Any]]) -> None:
    """Fail in the parser with an actionable error instead of leaking SQLite."""
    seen: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for block in blocks:
        stable_id = str(block.get("stableId") or "")
        previous = seen.get(stable_id)
        if previous is None:
            seen[stable_id] = block
            continue
        duplicates.append(
            f"{stable_id} (p.{previous.get('page')}:{previous.get('id')} / p.{block.get('page')}:{block.get('id')})"
        )
    if duplicates:
        raise ValueError(
            "PARSER_QUALITY_GATE: duplicate stable evidence IDs remain after physical de-duplication: "
            + ", ".join(duplicates[:8])
        )


def caption_identity(match: re.Match[str]) -> str:
    """Return a stable, collision-resistant local figure/table ID.

    Plain numbered captions retain the legacy F001/T001 form. Supplementary
    scope is encoded as S even when the journal writes only "Supplementary
    Figure 1", and Extended Data receives an ED namespace. Attached panel
    suffixes remain part of the identity while a separated "a)" stays a panel
    marker rather than becoming a different figure.
    """
    raw = match.group("number").upper()
    parsed = re.fullmatch(r"(?P<prefix>[A-Z]?)(?P<digits>\d+)(?P<suffix>[A-Z]?)", raw)
    if not parsed:
        raise ValueError(f"Unsupported caption number: {raw}")
    prefix = parsed.group("prefix")
    digits = parsed.group("digits").zfill(3)
    suffix = parsed.group("suffix")
    scope = normalize_text(str(match.group("scope") or "")).lower()
    if scope == "supplementary" and not prefix:
        prefix = "S"
    label = f"{prefix}{digits}{suffix}"
    kind = "T" if match.group("kind").lower().startswith("table") else "F"
    return f"ED{kind}{label}" if scope.startswith("extended") else f"{kind}{label}"


def numbered_caption_asset_id(block: dict[str, Any]) -> str | None:
    match = CAPTION_RE.match(str(block.get("originalText", "")))
    return caption_identity(match) if match else None


def unmatched_visual_regions(
    hints: list[dict[str, Any]],
    figures: list[dict[str, Any]],
    label: str,
) -> list[dict[str, Any]]:
    """Return structural visual regions not represented by a FigureRecord.

    Docling can recognize a scientific table even when its PDF has no usable
    caption text. Those tables still need an explicit visual-analysis outcome.
    Overlap uses the smaller region area so the six-point crop padding does not
    make a successfully captioned table appear unmatched.
    """
    unmatched: list[dict[str, Any]] = []
    for hint in sorted(
        (item for item in hints if item.get("label") == label),
        key=lambda item: (int(item.get("page", 0)), int(item.get("order", 0))),
    ):
        page = int(hint.get("page", 0))
        bbox = [float(value) for value in hint.get("bbox", [])]
        if page <= 0 or len(bbox) != 4 or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue
        if any(
            int(figure.get("page", 0)) == page
            and bbox_overlap([float(value) for value in figure.get("bbox", [])], bbox) >= 0.50
            for figure in figures
            if len(figure.get("bbox", [])) == 4
        ):
            continue
        if any(
            int(previous.get("page", 0)) == page
            and bbox_overlap([float(value) for value in previous["bbox"]], bbox) >= 0.80
            for previous in unmatched
        ):
            continue
        unmatched.append(hint)
    return unmatched


def ensure_unique_caption_asset_ids(blocks: list[dict[str, Any]]) -> None:
    """Reject duplicate numbered captions before any crop can be overwritten."""
    seen: dict[str, dict[str, Any]] = {}
    duplicates: list[str] = []
    for block in blocks:
        if block.get("type") != "caption":
            continue
        asset_id = numbered_caption_asset_id(block)
        if asset_id is None:
            continue
        previous = seen.get(asset_id)
        if previous is None:
            seen[asset_id] = block
            continue
        duplicates.append(
            f"{asset_id} (p.{previous.get('page')}:{previous.get('id')} / "
            f"p.{block.get('page')}:{block.get('id')})"
        )
    if duplicates:
        raise ValueError(
            "PARSER_QUALITY_GATE: duplicate numbered figure/table captions remain before rendering: "
            + ", ".join(duplicates[:8])
        )


def ensure_unique_figure_ids(figures: list[dict[str, Any]]) -> None:
    """Guarantee the persistence layer never receives duplicate asset IDs."""
    seen: set[str] = set()
    duplicates: list[str] = []
    for figure in figures:
        asset_id = str(figure.get("id") or "")
        if asset_id in seen:
            duplicates.append(asset_id)
        seen.add(asset_id)
    if duplicates:
        raise ValueError(
            "PARSER_QUALITY_GATE: duplicate figure/table asset IDs remain after extraction: "
            + ", ".join(sorted(set(duplicates))[:8])
        )


def unresolved_script_fragments(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Find small numeric glyph runs that still overlap a narrative baseline."""
    unresolved: list[dict[str, Any]] = []
    for block in blocks:
        text = normalize_text(str(block.get("originalText", "")))
        height = float(block["bbox"][3]) - float(block["bbox"][1])
        if block.get("type") != "paragraph" or height > 10.5:
            continue
        if not re.fullmatch(r"[\d.,/;:+−+\-\s]+", text) or not re.search(r"\d", text):
            continue
        if len(re.findall(r"\d+(?:\.\d+)?", text)) < 2:
            continue
        overlaps_baseline = any(
            candidate is not block
            and candidate.get("type") == "paragraph"
            and int(candidate["page"]) == int(block["page"])
            and float(block["bbox"][1]) <= float(candidate["bbox"][3]) + 2.0
            and float(block["bbox"][3]) >= float(candidate["bbox"][1]) - 2.0
            for candidate in blocks
        )
        if overlaps_baseline:
            unresolved.append(block)
    return unresolved


def remove_orphan_combining_glyphs(blocks: list[dict[str, Any]]) -> int:
    """Drop zero-width combining marks emitted as standalone text items.

    Some ACS PDFs expose the overbar of a crystallographic symbol as its own
    Docling paragraph.  It carries no readable source content, appears at a
    zero-width bbox, and can sit between the two real pieces of a page-spanning
    paragraph in logical order.  Limit removal to Unicode combining/format
    marks in a near-zero-width paragraph or note so minus signs, formulae and
    other meaningful scientific symbols remain untouched.
    """
    kept: list[dict[str, Any]] = []
    removed = 0
    for block in blocks:
        text = normalize_text(str(block.get("originalText", "")))
        bbox = [float(value) for value in block.get("bbox", [0, 0, 0, 0])]
        visible = [character for character in text if not character.isspace()]
        is_orphan_mark = (
            block.get("type") in {"paragraph", "note"}
            and 0 < len(visible) <= 6
            and len(bbox) == 4
            and bbox[2] - bbox[0] <= 2.5
            and all(unicodedata.category(character) in {"Mn", "Mc", "Me", "Cf"} for character in visible)
        )
        if is_orphan_mark:
            removed += 1
            continue
        kept.append(block)
    blocks[:] = kept
    return removed


def dedicated_figure_page_anchor(
    blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
    page_number: int,
    region: list[float],
) -> dict[str, Any] | None:
    """Place a figure after a dedicated Figures heading when the page has no narrative body."""
    page_hints = [hint for hint in hints if int(hint.get("page", 0)) == page_number]
    narrative = [
        hint for hint in page_hints
        if hint.get("label") in {"text", "paragraph", "list_item"}
        and normalize_text(str(hint.get("text", "")))
    ]
    if narrative:
        return None
    headings = [
        block for block in blocks
        if int(block["page"]) == page_number
        and block.get("type") == "heading"
        and re.fullmatch(r"figures?", normalize_text(str(block.get("originalText", ""))), re.IGNORECASE)
        and float(block["bbox"][3]) <= region[1] + 12
    ]
    return headings[-1] if headings else None


def preceding_reading_anchor(
    caption_block: dict[str, Any],
    blocks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the nearest preceding block that is visible in the fine reader.

    A figure can appear before its first textual mention (for example at the top
    of a section page).  In that layout there is no mention-based anchor, while
    the caption itself is intentionally hidden from the bilingual narrative.
    Falling back to the nearest visible evidence block keeps the asset in the
    correct reading position and prevents a caption-only anchor from making the
    figure unreachable in the UI.
    """
    return max(
        (
            block for block in blocks
            if int(block.get("order", 0)) < int(caption_block.get("order", 0))
            and block.get("type") not in {
                "caption",
                "front_matter",
                "running_matter",
                "figure_text",
                "reference",
            }
            and normalize_text(str(block.get("originalText", "")))
            and block.get("id")
        ),
        key=lambda block: int(block.get("order", 0)),
        default=None,
    )


def preceding_visual_region_anchor(
    page_number: int,
    region: list[float],
    blocks: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Place an uncaptioned structural visual after the nearest readable text."""
    overlapping = [
        block for block in blocks
        if int(block.get("page", 0)) == page_number
        and (
            bbox_overlap([float(value) for value in block.get("bbox", [])], region) >= 0.25
            if len(block.get("bbox", [])) == 4
            else False
        )
    ]
    if overlapping:
        visual_order = min(int(block.get("order", 0)) for block in overlapping)
    else:
        following = [
            int(block.get("order", 0)) for block in blocks
            if int(block.get("page", 0)) == page_number
            and len(block.get("bbox", [])) == 4
            and float(block["bbox"][1]) >= region[1]
        ]
        visual_order = min(following, default=max((int(block.get("order", 0)) for block in blocks), default=0) + 1)
    return preceding_reading_anchor({"order": visual_order}, blocks)


def assign_block_ids(blocks: list[dict[str, Any]]) -> None:
    source_counter = 0
    caption_counter = 0
    for order, block in enumerate(blocks, start=1):
        if block["type"] == "caption":
            caption_counter += 1
            block["id"] = f"C{caption_counter:03d}"
        else:
            source_counter += 1
            block["id"] = f"S{source_counter:03d}"
        block["order"] = order


def matching_caption_hint(
    caption_block: dict[str, Any],
    hints: list[dict[str, Any]],
) -> dict[str, Any] | None:
    match = CAPTION_RE.match(str(caption_block.get("originalText", "")))
    if not match:
        return None
    kind = match.group("kind").lower()
    identity = caption_identity(match)
    candidates: list[dict[str, Any]] = []
    for hint in hints:
        if hint.get("label") != "caption" or int(hint.get("page", 0)) != int(caption_block["page"]):
            continue
        hint_match = CAPTION_RE.match(str(hint.get("text", "")))
        if not hint_match:
            continue
        same_kind = hint_match.group("kind").lower().startswith("table") == kind.startswith("table")
        if same_kind and caption_identity(hint_match) == identity:
            candidates.append(hint)
    return min(
        candidates,
        key=lambda hint: abs(float(hint["bbox"][1]) - float(caption_block["bbox"][1])),
        default=None,
    )


def matching_visual_region(
    caption_block: dict[str, Any],
    hints: list[dict[str, Any]],
    label: str,
    page_heights: dict[int, float],
) -> dict[str, Any] | None:
    """Match a picture/table to its caption, including adjacent-page layouts."""
    caption_page = int(caption_block["page"])
    same_page = [
        hint for hint in hints
        if hint.get("label") == label and int(hint.get("page", 0)) == caption_page
    ]
    if same_page:
        caption_top = float(caption_block["bbox"][1])
        return min(same_page, key=lambda hint: abs(float(hint["bbox"][3]) - caption_top))

    candidates: list[tuple[tuple[int, int, float], dict[str, Any]]] = []
    caption_hint = matching_caption_hint(caption_block, hints)
    if caption_hint:
        caption_order = int(caption_hint.get("order", -1))
        caption_bbox = [float(value) for value in caption_hint["bbox"]]
        current_height = page_heights.get(caption_page, 792.0)
        for hint in hints:
            if hint.get("label") != label:
                continue
            region_page = int(hint.get("page", 0))
            region_order = int(hint.get("order", -1))
            region_bbox = [float(value) for value in hint["bbox"]]
            if region_page == caption_page - 1:
                order_gap = caption_order - region_order
                previous_height = page_heights.get(region_page, 792.0)
                if (
                    0 < order_gap <= 3
                    and caption_bbox[1] <= current_height * 0.30
                    and region_bbox[3] >= previous_height * 0.45
                ):
                    candidates.append(((0, order_gap, previous_height - region_bbox[3]), hint))
            elif region_page == caption_page + 1:
                order_gap = region_order - caption_order
                next_height = page_heights.get(region_page, 792.0)
                if (
                    0 < order_gap <= 3
                    and caption_bbox[3] >= current_height * 0.70
                    and region_bbox[1] <= next_height * 0.55
                ):
                    candidates.append(((1, order_gap, region_bbox[1]), hint))
        if candidates:
            return min(candidates, key=lambda item: item[0])[1]

    # Submission manuscripts often place a Figure Legends section first and
    # append one full-page figure plate per page much later.  Docling labels
    # those legends as ordinary text, so same/adjacent-page matching cannot
    # work.  When at least two numbered legends are followed by the same number
    # of large, one-per-page visual regions, pair both sequences by order.
    current_match = CAPTION_RE.match(str(caption_block.get("originalText", "")))
    if not current_match:
        return None
    current_is_table = current_match.group("kind").lower().startswith("table")
    numbered_legends: list[tuple[str, dict[str, Any]]] = []
    seen_numbers: set[str] = set()
    for hint in sorted(hints, key=lambda item: int(item.get("order", 0))):
        match = CAPTION_RE.match(str(hint.get("text", "")))
        if not match or match.group("kind").lower().startswith("table") != current_is_table:
            continue
        number = caption_identity(match)
        if number in seen_numbers:
            continue
        seen_numbers.add(number)
        numbered_legends.append((number, hint))
    if len(numbered_legends) < 2:
        return None
    legend_numbers = [number for number, _ in numbered_legends]
    current_identity = caption_identity(current_match)
    if current_identity not in legend_numbers:
        return None
    last_legend_page = max(int(hint.get("page", 0)) for _, hint in numbered_legends)
    largest_region_by_page: dict[int, dict[str, Any]] = {}
    for hint in hints:
        if hint.get("label") != label:
            continue
        page = int(hint.get("page", 0))
        if page <= last_legend_page:
            continue
        bbox = [float(value) for value in hint["bbox"]]
        height = bbox[3] - bbox[1]
        width = bbox[2] - bbox[0]
        if width < 180.0 or height < page_heights.get(page, 792.0) * 0.22:
            continue
        existing = largest_region_by_page.get(page)
        if existing is None:
            largest_region_by_page[page] = hint
            continue
        existing_bbox = [float(value) for value in existing["bbox"]]
        if width * height > (existing_bbox[2] - existing_bbox[0]) * (existing_bbox[3] - existing_bbox[1]):
            largest_region_by_page[page] = hint
    trailing_plates = [largest_region_by_page[page] for page in sorted(largest_region_by_page)]
    if len(trailing_plates) < len(numbered_legends):
        return None
    legend_index = legend_numbers.index(current_identity)
    return trailing_plates[legend_index]


def caption_source_blocks(
    caption_block: dict[str, Any],
    blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Collect a multi-line caption, including a continuation at the top of the next page."""
    docling_item_id = caption_block.get("_doclingItemId")
    grouped: list[dict[str, Any]] = []
    if docling_item_id:
        grouped = [block for block in blocks if block.get("_doclingItemId") == docling_item_id]
        # A two-column legend can be emitted as two neighbouring Docling
        # caption items (one provenance item per column). Collect only those
        # explicitly labelled caption items. The previous punctuation-based
        # fallback swept every later block on the page into the legend when
        # the first column ended mid-sentence, reclassifying body paragraphs,
        # section headings, figure labels and the journal footer as captions.
        start_page = int(caption_block["page"])
        start_order = int(caption_block.get("_doclingItemOrder") or 0)
        later_starts = [
            int(candidate.get("_doclingItemOrder") or 0)
            for candidate in blocks
            if candidate is not caption_block
            and candidate.get("_doclingLabel") == "caption"
            and int(candidate.get("_doclingItemOrder") or 0) > start_order
            and CAPTION_RE.match(str(candidate.get("originalText", "")))
        ]
        next_start_order = min(later_starts, default=sys.maxsize)
        labelled = [
            block for block in blocks
            if block.get("_doclingLabel") == "caption"
            and start_page <= int(block["page"]) <= start_page + 1
            and start_order <= int(block.get("_doclingItemOrder") or 0) < next_start_order
        ]
        if labelled:
            seen: set[int] = set()
            return [
                block for block in labelled
                if not (id(block) in seen or seen.add(id(block)))
            ]
        # Docling provenance is authoritative even when a short caption does
        # not end in punctuation. Never fall through to page-wide geometry.
        return grouped
    page_number = int(caption_block["page"])
    caption_top = float(caption_block["bbox"][1])
    collected: list[dict[str, Any]] = list(grouped)
    for candidate in blocks:
        if int(candidate["page"]) != page_number or int(candidate["order"]) < int(caption_block["order"]):
            continue
        if float(candidate["bbox"][1]) < caption_top - 2:
            continue
        if candidate is not caption_block and CAPTION_RE.match(str(candidate.get("originalText", ""))):
            break
        if candidate is not caption_block and candidate.get("type") in {
            "heading", "reference", "running_matter", "front_matter",
            "figure_text", "formula", "table", "table_row",
        }:
            continue
        collected.append(candidate)

    hint = matching_caption_hint(caption_block, hints)
    hint_text = normalize_text(str(hint.get("text", ""))) if hint else ""
    needs_next_page = bool(hint_text and not re.search(r"[.!?][\"')\]]?$", hint_text))
    if needs_next_page:
        next_page = page_number + 1
        next_regions = [
            item for item in hints
            if int(item.get("page", 0)) == next_page and item.get("label") in {"picture", "table"}
        ]
        boundary = min((float(item["bbox"][1]) for item in next_regions), default=0.0)
        if boundary > 0:
            for candidate in blocks:
                if int(candidate["page"]) != next_page:
                    continue
                if float(candidate["bbox"][3]) >= boundary - 6:
                    continue
                if CAPTION_RE.match(str(candidate.get("originalText", ""))):
                    break
                collected.append(candidate)

    seen: set[int] = set()
    unique: list[dict[str, Any]] = []
    for candidate in collected:
        marker = id(candidate)
        if marker not in seen:
            seen.add(marker)
            unique.append(candidate)
    return unique


def mark_caption_continuations(blocks: list[dict[str, Any]], hints: list[dict[str, Any]]) -> None:
    starts = [block for block in blocks if CAPTION_RE.match(str(block.get("originalText", "")))]
    for start in starts:
        for block in caption_source_blocks(start, blocks, hints):
            block["type"] = "caption"


def graphical_abstract_regions(
    blocks: list[dict[str, Any]],
    hints: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Match unnumbered graphical-abstract labels to their Docling picture regions.

    Publishers commonly expose a TOC graphic as a `picture` followed by an
    unnumbered `caption`. Number-only figure extraction intentionally ignores
    such captions, so handle this small, explicit vocabulary separately and
    require both text and page geometry before creating an asset.
    """
    matches: list[dict[str, Any]] = []
    used_block_ids: set[int] = set()
    used_picture_orders: set[int] = set()
    caption_hints = [
        hint for hint in hints
        if hint.get("label") == "caption"
        and GRAPHICAL_ABSTRACT_RE.match(normalize_text(str(hint.get("text", ""))))
    ]
    for caption_hint in caption_hints:
        page_number = int(caption_hint.get("page", 0))
        block_candidates = [
            block for block in blocks
            if id(block) not in used_block_ids
            and int(block.get("page", 0)) == page_number
            and GRAPHICAL_ABSTRACT_RE.match(normalize_text(str(block.get("originalText", ""))))
        ]
        if not block_candidates:
            continue
        label_block = max(block_candidates, key=lambda block: hint_match_score(block, caption_hint))
        if hint_match_score(label_block, caption_hint) < 0.34:
            continue

        caption_bbox = [float(value) for value in caption_hint["bbox"]]
        picture_candidates = [
            hint for hint in hints
            if hint.get("label") == "picture"
            and int(hint.get("page", 0)) == page_number
            and int(hint.get("order", -1)) not in used_picture_orders
        ]
        if not picture_candidates:
            continue

        def picture_rank(picture: dict[str, Any]) -> tuple[int, float, int]:
            picture_bbox = [float(value) for value in picture["bbox"]]
            vertical_gap = picture_bbox[1] - caption_bbox[3]
            # A TOC image normally starts directly below its label. Pictures
            # above the label remain eligible only as a last resort.
            direction_penalty = 0 if vertical_gap >= -8.0 else 1
            return (
                direction_penalty,
                abs(vertical_gap),
                abs(int(picture.get("order", 0)) - int(caption_hint.get("order", 0))),
            )

        picture_hint = min(picture_candidates, key=picture_rank)
        picture_bbox = [float(value) for value in picture_hint["bbox"]]
        vertical_gap = picture_bbox[1] - caption_bbox[3]
        if vertical_gap < -40.0 or vertical_gap > 180.0:
            continue

        preceding = max(
            (
                block for block in blocks
                if int(block.get("order", 0)) < int(label_block.get("order", 0))
                and block.get("type") not in {"caption", "reference"}
            ),
            key=lambda block: int(block.get("order", 0)),
            default=None,
        )
        matches.append({
            "block": label_block,
            "picture": picture_hint,
            "placedAfter": preceding["id"] if preceding else None,
        })
        used_block_ids.add(id(label_block))
        used_picture_orders.add(int(picture_hint.get("order", -1)))
    return matches


def render_crop(
    pdf: pdfium.PdfDocument,
    page_index: int,
    bbox: list[float],
    output_path: Path,
    scale: float = 2.0,
) -> tuple[int, int]:
    page = pdf[page_index]
    bitmap = page.render(scale=scale, rotation=0)
    image = bitmap.to_pil()
    left, top, right, bottom = [max(0, int(value * scale)) for value in bbox]
    right = min(image.width, right)
    bottom = min(image.height, bottom)
    if right - left < 10 or bottom - top < 10:
        raise ValueError(f"Crop too small: {bbox}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    crop = image.crop((left, top, right, bottom))
    crop.save(output_path, format="PNG", optimize=True)
    dimensions = crop.size
    bitmap.close()
    page.close()
    return dimensions


def render_page(pdf_path: str, page_number: int, output_path: str, scale: float = 1.6) -> dict[str, Any]:
    path = Path(pdf_path).resolve()
    target = Path(output_path).resolve()
    pdf = pdfium.PdfDocument(str(path))
    try:
        if page_number < 1 or page_number > len(pdf):
            raise ValueError(f"Page {page_number} is outside 1..{len(pdf)}")
        page = pdf[page_number - 1]
        width = float(page.get_width())
        height = float(page.get_height())
        if target.exists() and target.stat().st_size > 0:
            page.close()
            return {
                "path": str(target),
                "page": page_number,
                "width": width,
                "height": height,
                "scale": scale,
            }
        bitmap = page.render(scale=scale, rotation=0)
        try:
            image = bitmap.to_pil()
            target.parent.mkdir(parents=True, exist_ok=True)
            image.save(target, format="PNG", optimize=True)
        finally:
            bitmap.close()
            page.close()
    finally:
        pdf.close()
    return {
        "path": str(target),
        "page": page_number,
        "width": width,
        "height": height,
        "scale": scale,
    }


def parse_pdf(pdf_path: str, output_dir: str, revision_hash: str) -> dict[str, Any]:
    path = Path(pdf_path).resolve()
    output_root = Path(output_dir).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    inspection = inspect_pdf(str(path))
    expected_revision = revision_hash.strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_revision):
        raise ValueError("INVALID_REVISION_HASH: expected a lowercase SHA-256 value")
    if inspection["sha256"] != expected_revision:
        raise ValueError(
            f"REVISION_MISMATCH: staged PDF is {inspection['sha256']}, expected {expected_revision}"
        )
    if inspection["encrypted"] and not inspection["has_text_layer"]:
        raise ValueError("PDF is encrypted and cannot be read without a password")
    if not inspection["has_text_layer"]:
        raise ValueError("UNSUPPORTED_SCANNED_PDF: PDF does not contain a sufficient selectable text layer")

    parser_name, warnings, docling_hints = docling_hint(str(path), output_root / "docling_structure.json")
    blocks: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    counter = 0
    caption_counter = 0
    references_mode = False
    title = ""
    page_sizes: dict[int, tuple[float, float]] = {}
    formula_fallbacks: dict[str, str] = {}

    with pdfplumber.open(str(path)) as document:
        for page_number, page in enumerate(document.pages, start=1):
            page_sizes[page_number] = (float(page.width), float(page.height))
            for formula_hint in (
                hint for hint in docling_hints
                if hint.get("label") == "formula" and int(hint.get("page", 0)) == page_number
            ):
                formula_fallbacks[formula_hint_key(formula_hint)] = extract_formula_text(
                    page,
                    [float(value) for value in formula_hint["bbox"]],
                )
            raw_lines = page.extract_text_lines(layout=False, return_chars=True, strip=True) or []
            lines = [line for raw in raw_lines if (line := line_from_raw(raw, float(page.width))) is not None]
            lines = order_lines(lines, float(page.width))
            merged = merge_lines(lines)
            page_ids: list[str] = []

            for item in merged:
                text = item["text"]
                if not text or re.fullmatch(r"\d+", text):
                    continue
                caption_match = CAPTION_RE.match(text)
                if caption_match:
                    caption_counter += 1
                    block_id = f"C{caption_counter:03d}"
                    block_type = "caption"
                else:
                    counter += 1
                    block_id = f"S{counter:03d}"
                    section_text = text.rstrip(":").strip()
                    if references_mode and REFERENCE_SECTION_END_RE.match(section_text):
                        references_mode = False
                    if REFERENCE_HEADING_RE.fullmatch(section_text):
                        references_mode = True
                    if references_mode and not REFERENCE_HEADING_RE.fullmatch(section_text):
                        block_type = "reference"
                    elif is_probable_heading(
                        ExtractedLine(text, item["bbox"][0], item["bbox"][1], item["bbox"][2], item["bbox"][3], item["font_size"], float(page.width)),
                        item["body_size"],
                    ):
                        block_type = "heading"
                    else:
                        block_type = "paragraph"

                block = {
                    "id": block_id,
                    "stableId": stable_hash(page_number, item["bbox"], text),
                    "page": page_number,
                    "type": block_type,
                    "order": len(blocks) + 1,
                    "originalText": text,
                    "bbox": item["bbox"],
                    "confidence": "high",
                    "refs": [],
                }
                blocks.append(block)
                page_ids.append(block_id)
                if not title and page_number <= 2 and block_type in {"heading", "paragraph"} and len(text) > 20:
                    title = text
            pages.append({"page": page_number, "blockIds": page_ids})

    blocks = consolidate_docling_text_blocks(blocks, docling_hints)
    artifact_count = remove_nonsemantic_text_layer_artifacts(blocks)
    if artifact_count:
        warnings.append(f"已剔除 {artifact_count} 个出版社文本层字形探针；这些字符在页面上不可见且不属于论文内容。")
    orphan_mark_count = remove_orphan_combining_glyphs(blocks)
    if orphan_mark_count:
        warnings.append(f"已剔除 {orphan_mark_count} 个无语义的零宽度组合字形，避免干扰段落连续性。")
    title = select_document_title(
        blocks,
        docling_hints,
        dict(inspection.get("metadata") or {}),
        title or path.stem,
    )
    mark_running_matter(blocks, page_sizes)
    mark_formula_regions(blocks, docling_hints, formula_fallbacks)
    mark_caption_continuations(blocks, docling_hints)
    mark_visual_region_text(blocks, docling_hints)
    mark_front_matter(blocks, title, page_sizes)
    mark_inline_section_headings(blocks)
    duplicate_count = deduplicate_physical_blocks(blocks)
    if duplicate_count:
        warnings.append(f"已合并 {duplicate_count} 个由版面结构重复返回的同一物理来源块。")
    sort_blocks_logically(blocks)
    mark_ancillary_metadata(blocks)
    mark_reference_sections(blocks)
    mark_reference_list_items(blocks)
    mark_semantic_paragraph_continuations(blocks, page_sizes, docling_hints)
    detached = unresolved_script_fragments(blocks)
    if detached:
        locations = ", ".join(f"p.{block['page']}:{block['originalText']}" for block in detached[:8])
        raise ValueError(f"PARSER_QUALITY_GATE: unresolved detached superscript/subscript fragments: {locations}")
    assign_block_ids(blocks)
    pages = [
        {
            "page": page_number,
            "blockIds": [block["id"] for block in blocks if int(block["page"]) == page_number],
            "width": round(float(page_sizes.get(page_number, (0.0, 0.0))[0]), 3),
            "height": round(float(page_sizes.get(page_number, (0.0, 0.0))[1]), 3),
        }
        for page_number in range(1, int(inspection["page_count"]) + 1)
    ]
    if not title:
        title = path.stem

    running_count = sum(1 for block in blocks if block.get("type") == "running_matter")
    front_count = sum(1 for block in blocks if block.get("type") == "front_matter")
    reference_count = sum(1 for block in blocks if block.get("type") == "reference")
    formula_count = sum(1 for block in blocks if block.get("type") == "formula")
    if running_count:
        warnings.append(f"已隔离 {running_count} 个页眉、页脚或下载水印来源块，不进入精读与模型上下文。")
    if front_count:
        warnings.append(f"已隔离 {front_count} 个作者、机构或联系信息来源块。")
    if reference_count:
        warnings.append(f"已识别 {reference_count} 个参考文献来源块，保留索引但不逐条翻译。")
    if formula_count:
        warnings.append(f"已识别 {formula_count} 个公式来源块；已保留文本层索引、原文坐标和逐公式原图。")

    # Run this before rendering so a malformed second caption can never write
    # over the first figure's asset path.
    ensure_unique_caption_asset_ids(blocks)
    figures: list[dict[str, Any]] = []
    profile_image_path: Path | None = None
    pdf = pdfium.PdfDocument(str(path))
    try:
        page_heights = {
            page_index + 1: float(pdf[page_index].get_height())
            for page_index in range(len(pdf))
        }
        profile_page_number = next(
            (
                int(block["page"])
                for block in blocks
                if normalize_text(str(block.get("originalText", ""))).casefold()
                == normalize_text(title).casefold()
            ),
            1,
        )
        profile_page_number = min(max(profile_page_number, 1), len(pdf)) if len(pdf) else 1
        if len(pdf) > 0:
            candidate_profile_path = output_root / "assets" / "title-page.png"
            try:
                profile_page = pdf[profile_page_number - 1]
                first_width = float(profile_page.get_width())
                first_height = float(profile_page.get_height())
                profile_page.close()
                render_crop(
                    pdf,
                    profile_page_number - 1,
                    [0.0, 0.0, first_width, first_height],
                    candidate_profile_path,
                    scale=2.0,
                )
                profile_image_path = candidate_profile_path
            except Exception as exc:
                warnings.append(f"论文首页整页渲染失败：{type(exc).__name__}: {exc}")
        for index, block in enumerate(
            [entry for entry in blocks if entry["type"] == "formula"],
            start=1,
        ):
            page_number = int(block["page"])
            page_height = float(pdf[page_number - 1].get_height())
            page_width = float(pdf[page_number - 1].get_width())
            region = [float(value) for value in block["bbox"]]
            asset_id = f"E{index:03d}"
            if not is_substantive_formula_region(region, str(block.get("originalText", ""))):
                warnings.append(
                    f"{asset_id} 公式候选仅包含微小字形或缺少数学结构；保留来源坐标但不创建视觉模型输入。"
                )
                continue
            crop_bbox = expanded_crop_bbox(
                region,
                page_width,
                page_height,
                minimum_width=96.0,
                minimum_height=28.0,
                padding_x=7.0,
                padding_y=5.0,
            )
            asset_path = output_root / "assets" / f"equation-{index:03d}.png"
            try:
                pixel_width, pixel_height = render_crop(pdf, page_number - 1, crop_bbox, asset_path, scale=3.0)
            except Exception as exc:
                warnings.append(f"{asset_id} 公式原图裁切失败：{type(exc).__name__}: {exc}")
                continue
            if asset_id not in block["refs"]:
                block["refs"].append(asset_id)
            figures.append({
                "id": asset_id,
                "kind": "formula",
                "contentVisual": True,
                "page": page_number,
                "captionId": None,
                "captionBlockIds": [],
                "imagePath": str(asset_path),
                "bbox": [round(value, 3) for value in crop_bbox],
                "placedAfter": block["id"],
                "altText": f"Equation {index}",
                "originalCaption": str(block["originalText"]),
                "approximate": False,
                "pixelWidth": pixel_width,
                "pixelHeight": pixel_height,
            })
        for block in [entry for entry in blocks if entry["type"] == "caption"]:
            match = CAPTION_RE.match(block["originalText"])
            if not match:
                continue
            kind = match.group("kind").lower()
            number = match.group("number")
            is_table = kind.startswith("table")
            asset_id = caption_identity(match)
            asset_name = (
                f"{'table' if is_table else 'fig'}{number}.png"
                if not match.group("scope") and number.isdigit()
                else f"{asset_id.lower()}.png"
            )
            caption_page_number = int(block["page"])
            caption_top = float(block["bbox"][1])
            docling_label = "table" if is_table else "picture"
            closest_region = matching_visual_region(block, docling_hints, docling_label, page_heights)
            image_page_number = int(closest_region["page"]) if closest_region is not None else caption_page_number
            page_height = float(pdf[image_page_number - 1].get_height())
            page_width = float(pdf[image_page_number - 1].get_width())
            if closest_region is not None and not is_substantive_visual_region(
                [float(value) for value in closest_region["bbox"]], page_width, page_height
            ):
                warnings.append(
                    f"{asset_id} 匹配到的区域过小，已拒绝将图内标签作为独立识图对象并改用版面回退裁剪。"
                )
                closest_region = None
                image_page_number = caption_page_number
                page_height = float(pdf[image_page_number - 1].get_height())
                page_width = float(pdf[image_page_number - 1].get_width())
            if closest_region is not None:
                region = [float(value) for value in closest_region["bbox"]]
                crop_bbox = [
                    max(0.0, region[0] - 6.0),
                    max(0.0, region[1] - 6.0),
                    min(page_width, region[2] + 6.0),
                    min(page_height, region[3] + 6.0),
                ]
                approximate = False
            else:
                previous_caption_bottom = max(
                    [
                        float(entry["bbox"][3])
                        for entry in blocks
                        if entry["page"] == caption_page_number
                        and entry["order"] < block["order"]
                        and CAPTION_RE.match(str(entry.get("originalText", "")))
                    ]
                    or [28.0]
                )
                crop_top = max(36.0, previous_caption_bottom + 8.0)
                crop_bottom = max(crop_top + 72, caption_top - 8)
                crop_bottom = min(crop_bottom, page_height - 36)
                crop_bbox = [36.0, crop_top, page_width - 36.0, crop_bottom]
                approximate = True
            asset_path = output_root / "assets" / asset_name
            pixel_width = 0
            pixel_height = 0
            try:
                pixel_width, pixel_height = render_crop(pdf, image_page_number - 1, crop_bbox, asset_path)
            except Exception as exc:
                warnings.append(f"{asset_id} 裁切失败：{type(exc).__name__}: {exc}")

            mention_pattern = re.compile(
                (TABLE_MENTION_TEMPLATE if is_table else FIGURE_MENTION_TEMPLATE).format(number=re.escape(number)),
                re.IGNORECASE,
            )
            mention = next(
                (
                    entry for entry in blocks
                    if entry["order"] < block["order"]
                    and entry["type"] in {"paragraph", "heading"}
                    and mention_pattern.search(entry["originalText"])
                ),
                None,
            )
            caption_blocks = caption_source_blocks(block, blocks, docling_hints)
            caption_block_ids = [entry["id"] for entry in caption_blocks]
            full_caption = normalize_text(" ".join(str(entry["originalText"]) for entry in caption_blocks))
            page_anchor = dedicated_figure_page_anchor(blocks, docling_hints, image_page_number, crop_bbox)
            fallback_anchor = preceding_reading_anchor(block, blocks)
            figures.append({
                "id": asset_id,
                "kind": "table" if is_table else "figure",
                "contentVisual": True,
                "page": image_page_number,
                "captionId": block["id"],
                "captionBlockIds": caption_block_ids,
                "imagePath": str(asset_path),
                "bbox": [round(value, 3) for value in crop_bbox],
                "placedAfter": (
                    page_anchor["id"] if page_anchor
                    else mention["id"] if mention
                    else fallback_anchor["id"] if fallback_anchor
                    else None
                ),
                "altText": f"{'Table' if is_table else 'Figure'} {number}",
                "originalCaption": full_caption or block["originalText"],
                "approximate": approximate,
                "pixelWidth": pixel_width,
                "pixelHeight": pixel_height,
            })
            for caption_entry in caption_blocks:
                caption_entry["refs"].append(asset_id)
            for visual_text in blocks:
                if (
                    visual_text.get("type") == "figure_text"
                    and int(visual_text["page"]) == image_page_number
                    and bbox_overlap(list(visual_text["bbox"]), crop_bbox) >= 0.72
                    and asset_id not in visual_text["refs"]
                ):
                    visual_text["refs"].append(asset_id)

        # A structurally recognized table remains scientific visual evidence
        # even when the PDF provides no parseable numbered caption. Emit a
        # record for every unmatched table region so Deep Reading can return a
        # verified/needs_review/failed outcome instead of silently omitting it.
        unmatched_tables = []
        ignored_micro_visuals = 0
        for region_hint in unmatched_visual_regions(docling_hints, figures, "table"):
            page_number = int(region_hint["page"])
            page_height = float(pdf[page_number - 1].get_height())
            page_width = float(pdf[page_number - 1].get_width())
            region = [float(value) for value in region_hint["bbox"]]
            # Captionless Docling regions are occasionally only an axis label,
            # icon, colour key or publisher badge. Keep them as internal
            # figure_text evidence, but never create a user-facing visual unit.
            if not is_substantive_visual_region(region, page_width, page_height):
                ignored_micro_visuals += 1
                continue
            unmatched_tables.append(region_hint)
        if ignored_micro_visuals:
            warnings.append(f"已收纳 {ignored_micro_visuals} 个微小图内区域，不创建独立图表识别条目。")

        for index, region_hint in enumerate(unmatched_tables, start=1):
            page_number = int(region_hint["page"])
            page_height = float(pdf[page_number - 1].get_height())
            page_width = float(pdf[page_number - 1].get_width())
            region = [float(value) for value in region_hint["bbox"]]
            crop_bbox = [
                max(0.0, region[0] - 6.0),
                max(0.0, region[1] - 6.0),
                min(page_width, region[2] + 6.0),
                min(page_height, region[3] + 6.0),
            ]
            asset_id = f"TU{index:03d}"
            while any(str(figure.get("id")) == asset_id for figure in figures):
                index += 1
                asset_id = f"TU{index:03d}"
            asset_path = output_root / "assets" / f"table-uncaptioned-{index:03d}.png"
            pixel_width = 0
            pixel_height = 0
            try:
                pixel_width, pixel_height = render_crop(pdf, page_number - 1, crop_bbox, asset_path)
            except Exception as exc:
                warnings.append(f"{asset_id} 无图注表格裁切失败：{type(exc).__name__}: {exc}")

            table_text_blocks = [
                entry for entry in blocks
                if int(entry.get("page", 0)) == page_number
                and entry.get("type") == "figure_text"
                and len(entry.get("bbox", [])) == 4
                and (
                    bbox_overlap([float(value) for value in entry["bbox"]], region) >= 0.25
                    or bbox_center_inside([float(value) for value in entry["bbox"]], region, padding=4.0)
                )
            ]
            table_text = normalize_text(" ".join(str(entry.get("originalText", "")) for entry in table_text_blocks))
            anchor = preceding_visual_region_anchor(page_number, region, blocks)
            figures.append({
                "id": asset_id,
                "kind": "table",
                "contentVisual": True,
                "page": page_number,
                "captionId": None,
                "captionBlockIds": [],
                "imagePath": str(asset_path),
                "bbox": [round(value, 3) for value in crop_bbox],
                "placedAfter": anchor["id"] if anchor else None,
                "altText": f"Uncaptioned table {index}",
                "originalCaption": table_text[:4000] or f"Uncaptioned table on page {page_number}",
                "approximate": False,
                "pixelWidth": pixel_width,
                "pixelHeight": pixel_height,
            })
            for table_text_block in table_text_blocks:
                if asset_id not in table_text_block["refs"]:
                    table_text_block["refs"].append(asset_id)

        for index, match in enumerate(graphical_abstract_regions(blocks, docling_hints), start=1):
            block = match["block"]
            region = [float(value) for value in match["picture"]["bbox"]]
            page_number = int(block["page"])
            page_height = float(pdf[page_number - 1].get_height())
            page_width = float(pdf[page_number - 1].get_width())
            if not is_substantive_visual_region(region, page_width, page_height):
                warnings.append("图形摘要候选区域过小，已作为内部图内标签收纳。")
                continue
            crop_bbox = [
                max(0.0, region[0] - 6.0),
                max(0.0, region[1] - 6.0),
                min(page_width, region[2] + 6.0),
                min(page_height, region[3] + 6.0),
            ]
            asset_id = f"GA{index:03d}"
            asset_path = output_root / "assets" / f"graphical-abstract-{index}.png"
            pixel_width = 0
            pixel_height = 0
            try:
                pixel_width, pixel_height = render_crop(pdf, page_number - 1, crop_bbox, asset_path)
            except Exception as exc:
                warnings.append(f"{asset_id} 裁切失败：{type(exc).__name__}: {exc}")

            # Keep the original S-anchor stable for citations, but make its PDF
            # hit target cover the label and the actual graphic instead of only
            # the two words "TOC Graphic".
            label_bbox = [float(value) for value in block["bbox"]]
            source_bbox = [
                min(label_bbox[0], crop_bbox[0]),
                min(label_bbox[1], crop_bbox[1]),
                max(label_bbox[2], crop_bbox[2]),
                max(label_bbox[3], crop_bbox[3]),
            ]
            block["bbox"] = [round(value, 3) for value in source_bbox]
            block["stableId"] = stable_hash(page_number, source_bbox, str(block["originalText"]))
            block["type"] = "caption"
            block["refs"].append(asset_id)
            figures.append({
                "id": asset_id,
                "kind": "figure",
                "contentVisual": True,
                "page": page_number,
                "captionId": block["id"],
                "captionBlockIds": [block["id"]],
                "imagePath": str(asset_path),
                "bbox": [round(value, 3) for value in crop_bbox],
                "placedAfter": match["placedAfter"],
                "altText": normalize_text(str(block["originalText"])) or "Graphical abstract",
                "originalCaption": normalize_text(str(block["originalText"])) or "Graphical abstract",
                "approximate": False,
                "pixelWidth": pixel_width,
                "pixelHeight": pixel_height,
            })
    finally:
        pdf.close()

    ensure_unique_stable_ids(blocks)
    ensure_unique_figure_ids(figures)
    return {
        "parser": parser_name,
        "parserVersion": capabilities()["worker_version"],
        "paper": {
            "title": title,
            "sourcePath": str(path),
            "sourceType": "pdf",
            "pageCount": inspection["page_count"],
            "language": "en",
            "textCharacters": inspection["text_characters"],
            "encrypted": inspection["encrypted"],
            "hasTextLayer": inspection["has_text_layer"],
            **({"profileImagePath": str(profile_image_path), "profilePage": profile_page_number} if profile_image_path else {}),
        },
        "blocks": blocks,
        "figures": figures,
        "pages": pages,
        "warnings": warnings,
        "revisionHash": expected_revision,
    }


def dispatch(operation: str, payload: dict[str, Any]) -> Any:
    if operation == "capabilities":
        return capabilities()
    if operation == "inspect":
        return inspect_pdf(str(payload["pdfPath"]))
    if operation == "parse":
        return parse_pdf(
            str(payload["pdfPath"]),
            str(payload["outputDir"]),
            str(payload["revisionHash"]),
        )
    if operation == "render_page":
        return render_page(
            str(payload["pdfPath"]),
            int(payload["page"]),
            str(payload["outputPath"]),
            float(payload.get("scale", 1.6)),
        )
    raise ValueError(f"Unknown operation: {operation}")


def serve() -> int:
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        request_id = "unknown"
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", "unknown"))
            result = dispatch(str(request["operation"]), dict(request.get("payload") or {}))
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            response = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": type(exc).__name__,
                    "message": str(exc),
                },
            }
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


def write_json_output(path_value: str, value: Any) -> Path:
    """Atomically publish a one-shot command result inside the staged job root."""
    path = Path(path_value).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
    return path


def emit_openlab_progress(progress: float, stage: str) -> None:
    print(f"::openlab-progress {max(0.0, min(1.0, progress)):.3f} {stage}", flush=True)


def run_one_shot(args: argparse.Namespace) -> int:
    command = str(args.command)
    if command == "capabilities":
        result = capabilities()
        if args.output:
            write_json_output(str(args.output), result)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if command == "inspect":
        emit_openlab_progress(0.1, "检查 PDF")
        result = inspect_pdf(str(args.input))
        write_json_output(str(args.output), result)
        emit_openlab_progress(1.0, "检查完成")
        return 0
    if command == "parse":
        emit_openlab_progress(0.03, "准备解析")
        output_dir = Path(str(args.output_dir)).resolve()
        result = parse_pdf(str(args.input), str(output_dir), str(args.revision))
        emit_openlab_progress(0.95, "写入来源映射")
        write_json_output(str(output_dir / "reader_document.json"), result)
        emit_openlab_progress(1.0, "解析完成")
        return 0
    if command == "render-page":
        emit_openlab_progress(0.1, "渲染 PDF 页面")
        result = render_page(str(args.input), int(args.page), str(args.output), float(args.scale))
        metadata_output = getattr(args, "metadata_output", None)
        if metadata_output:
            write_json_output(str(metadata_output), result)
        emit_openlab_progress(1.0, "页面渲染完成")
        return 0
    raise ValueError(f"Unknown one-shot command: {command}")


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenScientific PDF worker")
    parser.add_argument("--serve", action="store_true", help="Run the NDJSON worker loop")
    parser.add_argument("--capabilities", action="store_true", help="Print capability JSON")
    commands = parser.add_subparsers(dest="command")

    capabilities_command = commands.add_parser("capabilities", help="Write the runtime capability descriptor")
    capabilities_command.add_argument("--output", help="Optional JSON output path")

    inspect_command = commands.add_parser("inspect", help="Inspect one staged PDF without model calls")
    inspect_command.add_argument("--input", required=True, help="Staged PDF path")
    inspect_command.add_argument("--output", required=True, help="Inspection JSON output path")

    parse_command = commands.add_parser("parse", help="Parse one staged text-layer PDF")
    parse_command.add_argument("--input", required=True, help="Staged PDF path")
    parse_command.add_argument("--revision", required=True, help="Expected immutable document SHA-256")
    parse_command.add_argument("--output-dir", required=True, help="Output directory below the job root")

    render_command = commands.add_parser("render-page", help="Render a one-based PDF page to PNG")
    render_command.add_argument("--input", required=True, help="Staged PDF path")
    render_command.add_argument("--page", required=True, type=int, help="One-based page number")
    render_command.add_argument("--output", required=True, help="PNG output path")
    render_command.add_argument("--metadata-output", help="Optional render metadata JSON output path")
    render_command.add_argument("--scale", type=float, default=1.6, help="Render scale")

    args = parser.parse_args()
    if args.capabilities:
        print(json.dumps(capabilities(), ensure_ascii=False, indent=2))
        return 0
    if args.serve:
        return serve()
    if args.command:
        try:
            return run_one_shot(args)
        except Exception:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            return 1
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
