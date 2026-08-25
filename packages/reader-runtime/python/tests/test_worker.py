from __future__ import annotations

import tempfile
import unittest
import hashlib
import os
from pathlib import Path

from PIL import Image

from reader_worker.main import (
    CAPTION_RE,
    caption_identity,
    consolidate_docling_text_blocks,
    deduplicate_physical_blocks,
    graphical_abstract_regions,
    inspect_pdf,
    mark_ancillary_metadata,
    mark_formula_regions,
    mark_front_matter,
    mark_inline_section_headings,
    mark_reference_list_items,
    mark_reference_sections,
    mark_running_matter,
    mark_semantic_paragraph_continuations,
    mark_visual_region_text,
    matching_visual_region,
    parse_pdf,
    remove_orphan_combining_glyphs,
    render_page,
    select_document_title,
    sort_blocks_logically,
    unmatched_visual_regions,
)


ROOT = Path(__file__).resolve().parents[2]
REFERENCE_ROOT = Path(os.environ.get("OPENLAB_READER_REFERENCE_ROOT", ROOT / "精读参考"))
REGRESSION_ROOT = Path(os.environ.get("OPENLAB_READER_REGRESSION_ROOT", "F:/test"))
REFERENCE_PDF = REFERENCE_ROOT / "Lewis_2021_NatureMaterials_accepted_manuscript.pdf"
WILEY_REGRESSION_PDF = REGRESSION_ROOT / "全文-1.pdf"
HALIDE_REGRESSION_PDF = REGRESSION_ROOT / "全文-03.pdf"
LLZO_REGRESSION_PDF = REGRESSION_ROOT / "全文.pdf"
REPOSITORY_COVER_REGRESSION_PDF = REGRESSION_ROOT / "全文-02.pdf"
FULLTEXT_04_REGRESSION_PDF = REGRESSION_ROOT / "全文-04.pdf"
WILEY_LIS_REGRESSION_PDF = next(
    REGRESSION_ROOT.glob("Wu 等 - 2024 - Integrating lithium sulfide*.pdf"),
    REGRESSION_ROOT / "__missing_wiley_lis_regression__.pdf",
)
SINGH_REGRESSION_PDF = next(
    REGRESSION_ROOT.glob("Singh 等 - 2023 - Non-linear kinetics*.pdf"),
    REGRESSION_ROOT / "__missing_singh_regression__.pdf",
)


def revision_for(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class GraphicalAbstractTests(unittest.TestCase):
    def test_numbered_caption_requires_caption_syntax_not_a_prose_mention(self) -> None:
        self.assertIsNotNone(CAPTION_RE.match("Figure 4. a) SEM image of the electrode"))
        self.assertIsNotNone(CAPTION_RE.match("Table 1 : Summary of fitted values"))
        self.assertIsNotNone(CAPTION_RE.match("Figure 4 a) SEM image of the electrode"))
        self.assertIsNone(CAPTION_RE.match("Figure 4 indicates that the electrode is polycrystalline"))
        self.assertIsNone(CAPTION_RE.match("Figure 1d-i show cross-sectional images of the cells"))
        self.assertIsNone(CAPTION_RE.match("Figure 1-3 show the repeated measurements"))

    def test_caption_identity_preserves_supplementary_and_extended_data_scope(self) -> None:
        cases = {
            "Figure 4. Main figure": "F004",
            "Figure 4a. Panel-specific figure": "F004A",
            "Figure S1. Supplementary figure": "FS001",
            "Supplementary Figure 1. Supplementary figure": "FS001",
            "Supplementary Table S2: Supplementary table": "TS002",
            "Extended Data Fig. 1. Extended result": "EDF001",
        }
        for caption, expected in cases.items():
            with self.subTest(caption=caption):
                match = CAPTION_RE.match(caption)
                self.assertIsNotNone(match)
                self.assertEqual(caption_identity(match), expected)
        panel_caption = CAPTION_RE.match("Figure 4 a) SEM image")
        self.assertIsNotNone(panel_caption)
        self.assertEqual(caption_identity(panel_caption), "F004")

    def test_finds_only_unrepresented_structural_table_regions(self) -> None:
        hints = [
            {"order": 1, "page": 2, "label": "table", "bbox": [70, 100, 530, 260]},
            {"order": 2, "page": 3, "label": "table", "bbox": [70, 120, 530, 300]},
            {"order": 3, "page": 3, "label": "table", "bbox": [72, 122, 528, 298]},
        ]
        figures = [{"id": "T001", "page": 2, "bbox": [64, 94, 536, 266]}]

        unmatched = unmatched_visual_regions(hints, figures, "table")

        self.assertEqual(len(unmatched), 1)
        self.assertEqual(unmatched[0]["page"], 3)

    def test_removes_zero_width_combining_mark_without_dropping_scientific_symbols(self) -> None:
        blocks = [
            {"type": "paragraph", "originalText": "̅", "bbox": [492.263, 137.663, 492.263, 146.49]},
            {"type": "paragraph", "originalText": "−", "bbox": [100, 100, 101, 110]},
            {"type": "formula", "originalText": "̅", "bbox": [200, 100, 200, 110]},
        ]

        removed = remove_orphan_combining_glyphs(blocks)

        self.assertEqual(removed, 1)
        self.assertEqual([block["originalText"] for block in blocks], ["−", "̅"])

    def test_marks_wrapped_title_page_affiliation_note_despite_bbox_rounding(self) -> None:
        title = "Non-Linear Kinetics of the Lithium Metal Anode"
        blocks = [
            {"page": 1, "type": "heading", "originalText": title, "bbox": [50, 77, 538, 141], "_doclingItemOrder": 2},
            {"page": 1, "type": "heading", "originalText": "1. Introduction", "bbox": [50, 540, 121, 551], "_doclingItemOrder": 5},
            {
                "page": 1, "type": "note", "_doclingLabel": "footnote",
                "originalText": "Institute of Materials Science Technical University of Munich, Germany",
                "bbox": [306, 625.994, 496, 671.05], "_doclingItemOrder": 17,
                "continuationKey": "D00017",
            },
        ]

        mark_front_matter(blocks, title, {1: (595, 792)})

        self.assertEqual(blocks[2]["type"], "front_matter")
        self.assertIsNone(blocks[2]["continuationKey"])

    def test_marks_end_matter_after_additional_information_outside_fine_reading(self) -> None:
        blocks = [
            {"page": 8, "type": "reference", "originalText": "A. Author. Journal 1, 1 (2020).", "continuationKey": None},
            {"page": 9, "type": "heading", "originalText": "Additional information", "continuationKey": "D1"},
            {"page": 9, "type": "paragraph", "originalText": "Peer review information Nature thanks the reviewers.", "continuationKey": "D2"},
            {"page": 9, "type": "paragraph", "originalText": "Reprints and permissions information is available at", "continuationKey": "D3"},
            {"page": 10, "type": "paragraph", "originalText": "Publisher's note Springer Nature remains neutral.", "continuationKey": "D4"},
            {"page": 10, "type": "paragraph", "originalText": "Open Access This article is licensed under a Creative Commons licence.", "continuationKey": "D5"},
        ]

        mark_ancillary_metadata(blocks)

        self.assertEqual(blocks[0]["type"], "reference")
        self.assertTrue(all(block["type"] == "front_matter" for block in blocks[1:]))
        self.assertTrue(all(block["continuationKey"] is None for block in blocks[1:]))

    def test_isolates_repeated_headers_and_vertical_download_watermark(self) -> None:
        blocks = [
            {"page": 1, "type": "paragraph", "originalText": "www.example-journal.org", "bbox": [470, 40, 550, 51]},
            {"page": 2, "type": "paragraph", "originalText": "www.example-journal.org", "bbox": [470, 40, 550, 51]},
            {"page": 1, "type": "paragraph", "originalText": "Downloaded from https://publisher.example/terms-and-conditions", "bbox": [579, 15, 584, 767]},
            {"page": 1, "type": "paragraph", "originalText": "©2024 The Authors. This is an open access article published by Wiley under the Creative Commons Attribution License.", "bbox": [50, 671, 291, 705]},
            {"page": 1, "type": "paragraph", "originalText": "Scientific body text", "bbox": [54, 120, 278, 250]},
        ]

        mark_running_matter(blocks, {1: (595, 792), 2: (595, 792)})

        self.assertEqual([block["type"] for block in blocks[:4]], ["running_matter"] * 4)
        self.assertEqual(blocks[4]["type"], "paragraph")

    def test_isolates_manuscript_line_numbers_in_the_outer_margin(self) -> None:
        blocks = [
            {"page": 3, "type": "paragraph", "originalText": value, "bbox": [26, top, 38, top + 8]}
            for value, top in (("5", 150), ("10", 260), ("15", 370), ("20", 480))
        ] + [
            {"page": 3, "type": "paragraph", "originalText": "The scientific paragraph remains visible.", "bbox": [72, 150, 540, 260]},
        ]

        mark_running_matter(blocks, {3: (612, 792)})

        self.assertTrue(all(block["type"] == "running_matter" for block in blocks[:4]))
        self.assertEqual(blocks[-1]["type"], "paragraph")

    def test_picture_edge_axis_label_is_not_a_narrative_paragraph(self) -> None:
        blocks = [
            {"page": 5, "type": "paragraph", "originalText": "3.2 40.2 4 5 12", "bbox": [172, 606.9, 225, 611.2]},
            {"page": 5, "type": "paragraph", "originalText": "Mechanistic understanding", "bbox": [40, 661, 280, 671]},
        ]
        hints = [
            {"page": 5, "label": "picture", "text": "", "bbox": [66.6, 55.9, 560.7, 608.9]},
        ]

        mark_visual_region_text(blocks, hints)

        self.assertEqual(blocks[0]["type"], "figure_text")
        self.assertEqual(blocks[1]["type"], "paragraph")

    def test_table_edge_units_are_kept_as_table_evidence(self) -> None:
        blocks = [
            {"page": 11, "type": "paragraph", "originalText": "GPa", "bbox": [345, 364, 366, 376]},
            {"page": 11, "type": "heading", "originalText": "Results and Discussion", "bbox": [72, 382, 212, 395]},
        ]
        hints = [
            {"page": 11, "label": "table", "text": "", "bbox": [71, 127, 540, 350]},
        ]

        mark_visual_region_text(blocks, hints)

        self.assertEqual(blocks[0]["type"], "figure_text")
        self.assertEqual(blocks[1]["type"], "heading")

    def test_removes_a_detached_math_fragment_already_in_docling_paragraph(self) -> None:
        logical_text = (
            "Here, the surface overpotential is defined by 𝜙𝜙s - 𝜙𝜙e, where 𝜙𝜙e is the "
            "potential in the electrolyte."
        )
        raw = [
            {"id": "S001", "page": 7, "type": "paragraph", "order": 1, "originalText": logical_text,
             "bbox": [72, 605, 543, 706], "confidence": "high", "refs": []},
            {"id": "S002", "page": 7, "type": "paragraph", "order": 2, "originalText": "𝜙𝜙 𝜙𝜙e",
             "bbox": [365, 713, 509, 728], "confidence": "high", "refs": []},
        ]
        hints = [
            {"order": 1, "itemOrder": 30, "itemId": "D00030", "provenanceIndex": 0,
             "page": 7, "label": "text", "text": logical_text, "bbox": [72, 605, 543, 706]},
        ]

        result = consolidate_docling_text_blocks(raw, hints)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["originalText"], logical_text)

    def test_matches_separate_figure_legends_to_trailing_full_page_plates(self) -> None:
        caption = {
            "page": 32, "type": "caption", "originalText": "Fig. 2. Polymer electrolyte design.",
            "bbox": [72, 160, 540, 210],
        }
        hints = [
            {"order": 244, "page": 32, "label": "text", "text": "Fig. 1. Design logic.", "bbox": [72, 80, 540, 140]},
            {"order": 245, "page": 32, "label": "text", "text": "Fig. 2. Polymer electrolyte design.", "bbox": [72, 160, 540, 210]},
            {"order": 246, "page": 33, "label": "text", "text": "Fig. 3. Electrochemical properties.", "bbox": [72, 80, 540, 140]},
            {"order": 409, "page": 41, "label": "picture", "text": "", "bbox": [51, 36, 564, 530]},
            {"order": 410, "page": 42, "label": "picture", "text": "", "bbox": [79, 121, 624, 403]},
            {"order": 411, "page": 43, "label": "picture", "text": "", "bbox": [24, 55, 545, 723]},
        ]

        matched = matching_visual_region(caption, hints, "picture", {page: 792 for page in range(32, 44)})

        self.assertIsNotNone(matched)
        self.assertEqual(matched["page"], 42)

    def test_uses_third_page_title_after_repository_cover_sheets(self) -> None:
        title = "Single-phase local-high-concentration solid polymer electrolytes for lithium metal batteries"
        abstract = "Solid polymers are promising electrolytes for lithium metal batteries. " * 10
        blocks = [
            {"page": 1, "type": "paragraph", "originalText": "Repository cover sheet", "bbox": [50, 80, 540, 120], "_doclingItemOrder": 1},
            {"page": 2, "type": "paragraph", "originalText": "Submission history", "bbox": [50, 80, 540, 120], "_doclingItemOrder": 2},
            {"page": 3, "type": "heading", "originalText": title, "bbox": [50, 80, 540, 125], "_doclingItemOrder": 19},
            {"page": 3, "type": "paragraph", "originalText": "W. Zhang, V. Koverga, S. Liu, J. Zhou", "bbox": [50, 140, 540, 175], "_doclingItemOrder": 20},
            {"page": 3, "type": "paragraph", "originalText": "Department of Engineering, University of Maryland", "bbox": [50, 180, 540, 200], "_doclingItemOrder": 21},
            {"page": 3, "type": "paragraph", "originalText": "Email: author@example.edu", "bbox": [50, 205, 540, 220], "_doclingItemOrder": 22},
            {"page": 4, "type": "paragraph", "originalText": abstract, "bbox": [50, 80, 540, 280], "_doclingItemOrder": 34},
        ]
        hints = [{"page": 3, "label": "section_header", "text": title}]

        selected = select_document_title(blocks, hints, {}, "fallback")
        mark_front_matter(blocks, selected, {1: (612, 792), 2: (612, 792), 3: (612, 792), 4: (612, 792)})

        self.assertEqual(selected, title)
        self.assertEqual(blocks[2]["type"], "heading")
        self.assertTrue(all(block["type"] == "front_matter" for block in blocks[:2]))
        self.assertTrue(all(block["type"] == "front_matter" for block in blocks[3:6]))
        self.assertEqual(blocks[6]["type"], "paragraph")

    def test_hides_appended_author_directory_and_fragmented_publication_date(self) -> None:
        blocks = [
            {"page": 1, "type": "paragraph", "originalText": "Available", "_doclingItemOrder": 16},
            {"page": 1, "type": "paragraph", "originalText": "online", "_doclingItemOrder": 16},
            {"page": 1, "type": "paragraph", "originalText": "22", "_doclingItemOrder": 17},
            {"page": 1, "type": "paragraph", "originalText": "August", "_doclingItemOrder": 18},
            {"page": 1, "type": "paragraph", "originalText": "2024", "_doclingItemOrder": 19},
            {"page": 10, "type": "heading", "originalText": "■ AUTHOR INFORMATION", "_doclingItemOrder": 90},
            {"page": 10, "type": "heading", "originalText": "Corresponding Authors", "_doclingItemOrder": 91},
            {"page": 10, "type": "paragraph", "originalText": "A. Varzi - Institute Ulm; Email: author@example.edu", "_doclingItemOrder": 92},
            {"page": 10, "type": "heading", "originalText": "Authors", "_doclingItemOrder": 93},
            {"page": 10, "type": "paragraph", "originalText": "P. Ganesan - Institute Ulm, Germany", "_doclingItemOrder": 94},
            {"page": 10, "type": "heading", "originalText": "Author Contributions", "_doclingItemOrder": 95},
            {"page": 10, "type": "paragraph", "originalText": "P.G. designed the experiments.", "_doclingItemOrder": 96},
            {"page": 12, "type": "paragraph", "originalText": "Please contact Prof. Lei Fu (lei@example.edu) for queries.", "_doclingItemOrder": 122},
        ]

        mark_ancillary_metadata(blocks)

        self.assertTrue(all(block["type"] == "front_matter" for block in blocks[:10]))
        self.assertEqual(blocks[10]["type"], "heading")
        self.assertEqual(blocks[11]["type"], "paragraph")
        self.assertEqual(blocks[12]["type"], "front_matter")

    def test_repairs_common_utf8_metadata_mojibake_in_title_selection(self) -> None:
        damaged = "Tracking dendrites and solid electrolyte interphase formation with dynamic polarizationâ€”NMR spectroscopy"
        selected = select_document_title([], [], {"Title": damaged}, "fallback")
        self.assertEqual(
            selected,
            "Tracking dendrites and solid electrolyte interphase formation with dynamic polarization—NMR spectroscopy",
        )

    def test_rejoins_same_column_body_around_an_ignored_publication_notice(self) -> None:
        blocks = [
            {
                "page": 1, "type": "paragraph", "originalText": "Sulfur-based SSEs are the most promising ones for",
                "bbox": [384.63, 382.353, 546.893, 456.551], "stableId": "left", "continuationKey": "D00007",
            },
            {
                "page": 1, "type": "paragraph", "originalText": "ASSLSBs due to their high ionic conductivity.",
                "bbox": [305.925, 459.061, 546.884, 478.467], "stableId": "right", "continuationKey": "D00027",
            },
            {
                "page": 1, "type": "running_matter", "originalText": "©2024 The Authors. Creative Commons license.",
                "bbox": [50.811, 671.327, 291.048, 705.43], "stableId": "license", "continuationKey": None,
            },
        ]

        mark_semantic_paragraph_continuations(blocks, {1: (595, 792)})

        self.assertEqual(blocks[0]["continuationKey"], blocks[1]["continuationKey"])

    def test_docling_provenance_controls_two_column_continuation_order(self) -> None:
        blocks = [
            {"page": 3, "type": "paragraph", "originalText": "right continuation", "bbox": [310, 80, 540, 300], "_doclingItemOrder": 30, "_provenanceIndex": 4, "_rawSortKey": 2},
            {"page": 3, "type": "running_matter", "originalText": "www.example.org", "bbox": [470, 40, 550, 51], "_doclingItemOrder": 30, "_provenanceIndex": 3, "_rawSortKey": 1},
            {"page": 2, "type": "paragraph", "originalText": "paragraph begins", "bbox": [54, 500, 278, 750], "_doclingItemOrder": 30, "_provenanceIndex": 0, "_rawSortKey": 0},
            {"page": 3, "type": "paragraph", "originalText": "left continuation", "bbox": [54, 80, 278, 700], "_doclingItemOrder": 30, "_provenanceIndex": 2, "_rawSortKey": 3},
        ]

        sort_blocks_logically(blocks)

        self.assertEqual([block["originalText"] for block in blocks[:3]], ["paragraph begins", "left continuation", "right continuation"])
        self.assertEqual(blocks[-1]["type"], "running_matter")

    def test_separates_wiley_front_matter_from_headingless_abstract(self) -> None:
        abstract = "This study investigates silicon anodes. " * 20
        title = "Unveiling the Mechanical and Electrochemical Evolution of Nanosilicon Composite Anodes"
        hints = [
            {"page": 1, "label": "text", "text": abstract},
            {"page": 1, "label": "section_header", "text": title},
        ]
        blocks = [
            {"page": 1, "type": "paragraph", "originalText": abstract, "_doclingItemOrder": 0},
            {"page": 1, "type": "paragraph", "originalText": "D. Cao, T. Ji", "_doclingItemOrder": 1},
            {"page": 1, "type": "heading", "originalText": title, "_doclingItemOrder": 18},
            {"page": 1, "type": "paragraph", "originalText": "Daxian Cao and colleagues", "_doclingItemOrder": 19},
            {"page": 1, "type": "heading", "originalText": "1. Introduction", "_doclingItemOrder": 20},
            {"page": 12, "type": "note", "originalText": "Received: November 21, 2022", "_doclingItemOrder": 119},
        ]

        selected = select_document_title(blocks, hints, {"Title": "All-Solid-State Batteries"}, "fallback")
        mark_front_matter(blocks, selected)

        self.assertEqual(selected, title)
        self.assertEqual(blocks[0]["type"], "paragraph")
        self.assertTrue(blocks[0]["_frontAbstract"])
        self.assertEqual(blocks[1]["type"], "front_matter")
        self.assertEqual(blocks[3]["type"], "front_matter")
        self.assertEqual(blocks[4]["type"], "heading")
        self.assertEqual(blocks[5]["type"], "front_matter")

    def test_preserves_unheaded_abstract_and_unheaded_page_one_body_run(self) -> None:
        title = "High capacity and stable all-solid-state battery with a nanoporous carbon electrode"
        abstract = "Extensive research demonstrates the scientific result. " * 12
        introduction_one = "All-solid-state batteries have attracted growing scientific interest. " * 10
        introduction_two = "Conventional electrode designs nevertheless remain mechanically limited. " * 10
        blocks = [
            {"page": 1, "type": "heading", "originalText": title, "bbox": [150, 150, 550, 230], "_doclingItemOrder": 2},
            {"page": 1, "type": "paragraph", "originalText": "A. Author, B. Author", "bbox": [150, 240, 450, 255], "_doclingItemOrder": 3},
            {"page": 1, "type": "paragraph", "originalText": abstract, "bbox": [150, 270, 550, 380], "_doclingItemOrder": 4},
            {"page": 1, "type": "paragraph", "originalText": introduction_one, "bbox": [150, 405, 550, 475], "_doclingItemOrder": 5},
            {"page": 1, "type": "paragraph", "originalText": introduction_two, "bbox": [150, 480, 550, 570], "_doclingItemOrder": 6},
            {"page": 1, "type": "paragraph", "originalText": "Department of Engineering, Example University. E-mail: author@example.edu", "bbox": [150, 710, 550, 738], "_doclingItemOrder": 7},
        ]

        mark_front_matter(blocks, title, {1: (595, 792)})

        self.assertEqual(blocks[0]["type"], "heading")
        self.assertEqual(blocks[1]["type"], "front_matter")
        self.assertEqual([block["type"] for block in blocks[2:5]], ["paragraph"] * 3)
        self.assertTrue(blocks[2]["_frontAbstract"])
        self.assertNotIn("_frontAbstract", blocks[3])
        self.assertEqual(blocks[5]["type"], "front_matter")

    def test_uses_second_page_article_title_and_hides_repository_cover(self) -> None:
        citation = (
            "Ning, Z. et al. (2023) Dendrite initiation and propagation in lithium metal "
            "solid-state batteries. Nature, 618, pp. 287-293. doi:10.1038/example"
        )
        title = "Dendrite Initiation and Propagation in Lithium Metal Solid-State Batteries"
        blocks = [
            {"page": 1, "type": "paragraph", "originalText": citation, "bbox": [50, 100, 540, 140], "_doclingItemOrder": 1},
            {"page": 1, "type": "paragraph", "originalText": "This is the author version of the work.", "bbox": [50, 170, 540, 190], "_doclingItemOrder": 2},
            {"page": 2, "type": "heading", "originalText": title, "bbox": [50, 60, 540, 90], "_doclingItemOrder": 3},
            {"page": 2, "type": "paragraph", "originalText": "A. Author, B. Author", "bbox": [50, 100, 540, 120], "_doclingItemOrder": 4},
            {"page": 2, "type": "note", "originalText": "*Correspondence: author@example.edu", "bbox": [50, 190, 540, 205], "_doclingItemOrder": 5},
            {"page": 2, "type": "heading", "originalText": "Abstract", "bbox": [50, 220, 150, 240], "_doclingItemOrder": 6},
            {"page": 2, "type": "paragraph", "originalText": "The scientific abstract remains visible.", "bbox": [50, 250, 540, 300], "_doclingItemOrder": 7},
        ]
        hints = [
            {"page": 1, "label": "text", "text": citation},
            {"page": 2, "label": "section_header", "text": title},
            {"page": 2, "label": "section_header", "text": "Abstract"},
        ]

        selected = select_document_title(blocks, hints, {}, "fallback")
        mark_front_matter(blocks, selected, {1: (595, 792), 2: (595, 792)})

        self.assertEqual(selected, title)
        self.assertTrue(all(block["type"] == "front_matter" for block in blocks[:2]))
        self.assertEqual(blocks[2]["type"], "heading")
        self.assertEqual(blocks[3]["type"], "front_matter")
        self.assertEqual(blocks[4]["type"], "front_matter")
        self.assertEqual(blocks[5]["type"], "heading")
        self.assertEqual(blocks[6]["type"], "paragraph")

    def test_marks_explicit_reference_sections_without_swallowing_methods(self) -> None:
        blocks = [
            {"page": 10, "type": "heading", "originalText": "References", "continuationKey": None},
            {"page": 10, "type": "paragraph", "originalText": "Author, A. Journal 1, 1-9 (2024).", "continuationKey": "D1"},
            {"page": 11, "type": "heading", "originalText": "ACKNOWLEDGEMENTS", "continuationKey": None},
            {"page": 11, "type": "paragraph", "originalText": "We thank the facility.", "continuationKey": "D2"},
            {"page": 12, "type": "heading", "originalText": "Methods", "continuationKey": None},
            {"page": 12, "type": "paragraph", "originalText": "Samples were assembled in argon.", "continuationKey": "D3"},
            {"page": 13, "type": "heading", "originalText": "Additional References", "continuationKey": None},
            {"page": 13, "type": "paragraph", "originalText": "Author, B. Journal 2, 2-8 (2025).", "continuationKey": "D4"},
        ]

        mark_reference_sections(blocks)

        self.assertEqual([block["type"] for block in blocks], [
            "reference", "reference", "heading", "paragraph",
            "heading", "paragraph", "reference", "reference",
        ])

    def test_hides_author_contact_footnote_and_rejoins_two_column_body(self) -> None:
        title = "Interlayer Design for Halide Electrolytes in All-Solid-State Lithium Metal Batteries"
        blocks = [
            {
                "stableId": "title", "page": 1, "type": "heading", "originalText": title,
                "bbox": [50, 77, 520, 118], "_doclingItemOrder": 1,
            },
            {
                "stableId": "intro", "page": 1, "type": "heading", "originalText": "1. Introduction",
                "bbox": [50, 454, 122, 465], "_doclingItemOrder": 2,
            },
            {
                "stableId": "left", "page": 1, "type": "paragraph",
                "originalText": "The electrolyte reacts with lithium on the lithium",
                "bbox": [50, 473, 292, 559], "_doclingItemOrder": 3, "continuationKey": "D00003",
            },
            {
                "stableId": "authors", "page": 1, "type": "note",
                "originalText": "Z. Wang, T. Wang, N. Zhang Department of Chemical Engineering University of Maryland",
                "bbox": [50, 579, 234, 604], "_doclingItemOrder": 4, "_doclingLabel": "footnote",
            },
            {
                "stableId": "address", "page": 1, "type": "paragraph",
                "originalText": "College Park, MD 20740, USA",
                "bbox": [50, 606, 149, 613], "_doclingItemOrder": 5,
            },
            {
                "stableId": "email", "page": 1, "type": "paragraph",
                "originalText": "E-mail: author@example.edu",
                "bbox": [50, 615, 139, 622], "_doclingItemOrder": 6,
            },
            {
                "stableId": "right", "page": 1, "type": "paragraph",
                "originalText": "anode side, it forms an insulating interphase.",
                "bbox": [385, 178, 547, 285], "_doclingItemOrder": 7, "continuationKey": "D00007",
            },
        ]

        mark_front_matter(blocks, title, {1: (595, 792)})
        sort_blocks_logically(blocks)
        mark_semantic_paragraph_continuations(blocks, {1: (595, 792)})

        contacts = {block["stableId"]: block for block in blocks if block["stableId"] in {"authors", "address", "email"}}
        self.assertTrue(all(block["type"] == "front_matter" for block in contacts.values()))
        left = next(block for block in blocks if block["stableId"] == "left")
        right = next(block for block in blocks if block["stableId"] == "right")
        self.assertEqual(left["continuationKey"], right["continuationKey"])

    def test_scientific_contact_language_is_not_mistaken_for_contact_metadata(self) -> None:
        title = "Stability of Solid Electrolytes"
        scientific_body = (
            "The electrolyte remains stable in contact with lithium metal, and the corresponding "
            "electrochemical response confirms that the interface remains conductive. " * 5
        )
        blocks = [
            {
                "stableId": "title", "page": 1, "type": "heading", "originalText": title,
                "bbox": [50, 70, 520, 110], "_doclingItemOrder": 1,
            },
            {
                "stableId": "abstract-heading", "page": 1, "type": "heading", "originalText": "Abstract",
                "bbox": [50, 150, 130, 165], "_doclingItemOrder": 2,
            },
            {
                "stableId": "abstract", "page": 1, "type": "paragraph", "originalText": scientific_body,
                "bbox": [50, 180, 540, 430], "_doclingItemOrder": 3,
            },
        ]

        mark_front_matter(blocks, title, {1: (595, 792)})

        self.assertEqual(blocks[2]["type"], "paragraph")

    def test_promotes_compact_title_case_method_label_to_heading(self) -> None:
        blocks = [
            {
                "stableId": "method-label", "page": 9, "type": "paragraph",
                "originalText": "Statistical Analysis :", "bbox": [48, 600, 140, 612],
            },
            {
                "stableId": "ordinary-prose", "page": 9, "type": "paragraph",
                "originalText": "For example: the samples were compared.", "bbox": [48, 620, 540, 650],
            },
        ]

        mark_inline_section_headings(blocks)

        self.assertEqual(blocks[0]["type"], "heading")
        self.assertEqual(blocks[1]["type"], "paragraph")

    def test_rejoins_lower_right_column_continuation_below_a_figure(self) -> None:
        blocks = [
            {
                "stableId": "left", "page": 3, "type": "paragraph", "order": 1,
                "originalText": "The electrolytes demonstrated varying abilities. Specifically,",
                "bbox": [50, 537, 292, 721], "continuationKey": "D00031",
            },
            {
                "stableId": "right", "page": 3, "type": "paragraph", "order": 2,
                "originalText": "as illustrated in Figure 2b, the corrosion potential increased.",
                "bbox": [306, 405, 547, 720], "continuationKey": "D00032",
            },
        ]

        mark_semantic_paragraph_continuations(blocks, {3: (595, 792)})

        self.assertEqual(blocks[0]["continuationKey"], blocks[1]["continuationKey"])

    def test_rejoins_paragraph_across_a_visual_only_page_and_resume_page_figure(self) -> None:
        blocks = [
            {
                "stableId": "conclusion-start", "page": 6, "type": "paragraph", "order": 1,
                "originalText": "We also suppress lithium dendrite growth in",
                "bbox": [303, 679, 544, 721], "continuationKey": "D00063",
            },
            {
                "stableId": "figure-five-caption", "page": 7, "type": "caption", "order": 2,
                "originalText": "Figure 5. Lithium dendrite suppression capabilities.",
                "bbox": [51, 640, 547, 687], "continuationKey": "D00064",
            },
            {
                "stableId": "figure-six-caption", "page": 8, "type": "caption", "order": 3,
                "originalText": "Figure 6. Full cell performance.",
                "bbox": [48, 306, 544, 342], "continuationKey": "D00072",
            },
            {
                "stableId": "conclusion-resume", "page": 8, "type": "paragraph", "order": 4,
                "originalText": "Li3YbCl6 and Li3LuCl6 halide solid electrolytes by coating Li6PI3.",
                "bbox": [48, 361, 289, 545], "continuationKey": "D00073",
            },
        ]
        hints = [
            {"page": 7, "label": "picture", "bbox": [112, 70, 484, 641]},
            {"page": 8, "label": "picture", "bbox": [118, 70, 473, 306]},
        ]

        mark_semantic_paragraph_continuations(
            blocks,
            {6: (595, 782), 7: (595, 782), 8: (595, 782)},
            hints,
        )

        self.assertEqual(blocks[0]["continuationKey"], blocks[3]["continuationKey"])

    def test_does_not_rejoin_across_a_visual_page_when_a_section_boundary_intervenes(self) -> None:
        blocks = [
            {
                "stableId": "body-start", "page": 6, "type": "paragraph", "order": 1,
                "originalText": "The measurement was performed in",
                "bbox": [303, 679, 544, 721], "continuationKey": "D00063",
            },
            {
                "stableId": "figure-caption", "page": 7, "type": "caption", "order": 2,
                "originalText": "Figure 5. Cycling performance.",
                "bbox": [51, 640, 547, 687], "continuationKey": "D00064",
            },
            {
                "stableId": "new-section", "page": 8, "type": "heading", "order": 3,
                "originalText": "4. Experimental Section",
                "bbox": [48, 340, 220, 356], "continuationKey": "D00072",
            },
            {
                "stableId": "new-body", "page": 8, "type": "paragraph", "order": 4,
                "originalText": "Li3YbCl6 powder was prepared by milling.",
                "bbox": [48, 361, 289, 545], "continuationKey": "D00073",
            },
        ]
        hints = [
            {"page": 7, "label": "picture", "bbox": [112, 70, 484, 641]},
            {"page": 8, "label": "picture", "bbox": [118, 70, 473, 306]},
        ]

        mark_semantic_paragraph_continuations(
            blocks,
            {6: (595, 782), 7: (595, 782), 8: (595, 782)},
            hints,
        )

        self.assertNotEqual(blocks[0]["continuationKey"], blocks[3]["continuationKey"])

    def test_recognizes_unheaded_bibliography_list_and_formula_geometry(self) -> None:
        blocks = [
            {"page": 11, "type": "paragraph", "originalText": "FF=FFFF (1)", "bbox": [100, 120, 400, 155], "_doclingLabel": ""},
            *[
                {"page": 12, "type": "paragraph", "originalText": f"A. Author, B. Writer, Journal 20{20 + index}, 1, {index}.", "bbox": [50, 200 + index * 20, 540, 215 + index * 20], "_doclingLabel": "list_item"}
                for index in range(3)
            ],
        ]
        hints = [{"page": 11, "label": "formula", "bbox": [90, 110, 410, 165], "itemOrder": 100, "provenanceIndex": 0}]

        mark_formula_regions(blocks, hints)
        mark_reference_list_items(blocks)

        formulas = [block for block in blocks if block["type"] == "formula"]
        self.assertEqual(len(formulas), 1)
        self.assertEqual(formulas[0]["originalText"], "FF=FFFF (1)")
        self.assertEqual(formulas[0]["confidence"], "medium")
        self.assertNotIn("refer to the PDF", formulas[0]["originalText"])
        self.assertEqual(sum(1 for block in blocks if block["type"] == "reference"), 3)

    def test_matches_picture_on_previous_page_to_top_page_caption(self) -> None:
        caption = {
            "id": "C003", "page": 7, "type": "caption", "order": 28,
            "originalText": "Figure 2. Cross-page figure.", "bbox": [72, 74, 526, 152],
        }
        hints = [
            {"order": 27, "page": 6, "label": "picture", "text": "", "bbox": [176, 406, 419, 762]},
            {"order": 28, "page": 7, "label": "caption", "text": caption["originalText"], "bbox": caption["bbox"]},
        ]

        match = matching_visual_region(caption, hints, "picture", {6: 792, 7: 792})

        self.assertIsNotNone(match)
        self.assertEqual(match["page"], 6)
        self.assertEqual(match["bbox"], [176, 406, 419, 762])

    def test_repairs_cross_page_paragraph_identity_without_merging_evidence(self) -> None:
        blocks = [
            {
                "stableId": "a", "page": 4, "type": "paragraph", "order": 1,
                "originalText": "Its conductivity was measured to be 2.1 mS", "bbox": [72, 663, 543, 700],
                "continuationKey": "D00016",
            },
            {
                "stableId": "b", "page": 5, "type": "paragraph", "order": 2,
                "originalText": "cm -1 at 20 °C, enabling cycling.", "bbox": [72, 74, 543, 306],
                "continuationKey": "D00017",
            },
        ]

        mark_semantic_paragraph_continuations(blocks)

        self.assertEqual(blocks[0]["continuationKey"], "D00016")
        self.assertEqual(blocks[1]["continuationKey"], "D00016")
    def test_matches_unnumbered_toc_caption_to_picture_and_previous_anchor(self) -> None:
        blocks = [
            {
                "id": "S021", "page": 2, "type": "paragraph", "order": 21,
                "originalText": "Abstract conclusion.", "bbox": [72, 74, 526, 230],
            },
            {
                "id": "S022", "page": 2, "type": "heading", "order": 22,
                "originalText": "TOC Graphic", "bbox": [72, 274, 156, 288],
            },
        ]
        hints = [
            {"order": 12, "page": 2, "label": "picture", "text": "", "bbox": [74, 294, 312, 431]},
            {"order": 13, "page": 2, "label": "caption", "text": "TOC Graphic", "bbox": [72, 275, 159, 287]},
        ]

        matches = graphical_abstract_regions(blocks, hints)

        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["block"]["id"], "S022")
        self.assertEqual(matches[0]["picture"]["bbox"], [74, 294, 312, 431])
        self.assertEqual(matches[0]["placedAfter"], "S021")

    def test_docling_provenance_replaces_lines_and_detached_subscripts(self) -> None:
        blocks = [
            {"id": "S001", "page": 2, "type": "paragraph", "order": 1, "originalText": "The electrolyte (Li SnP S ) failed.", "bbox": [72, 100, 540, 112], "confidence": "high", "refs": []},
            {"id": "S002", "page": 2, "type": "paragraph", "order": 2, "originalText": "10 2 12", "bbox": [250, 104, 300, 112], "confidence": "high", "refs": []},
        ]
        hints = [{
            "order": 1, "itemId": "D00001", "page": 2, "label": "text",
            "text": "The electrolyte (Li 10 SnP 2 S 12) failed.", "bbox": [72, 98, 540, 114],
        }]

        result = consolidate_docling_text_blocks(blocks, hints)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["originalText"], "The electrolyte (Li10SnP2S12) failed.")
        self.assertEqual(result[0]["continuationKey"], "D00001")

    def test_marks_selectable_picture_labels_as_non_narrative_evidence(self) -> None:
        blocks = [
            {"id": "S001", "page": 4, "type": "paragraph", "order": 1, "originalText": "Voltage (V)", "bbox": [100, 120, 180, 132], "confidence": "high", "refs": []},
            {"id": "S002", "page": 4, "type": "paragraph", "order": 2, "originalText": "Body text", "bbox": [72, 500, 540, 520], "confidence": "high", "refs": []},
        ]
        hints = [{"page": 4, "label": "picture", "bbox": [80, 90, 500, 450]}]

        mark_visual_region_text(blocks, hints)

        self.assertEqual(blocks[0]["type"], "figure_text")
        self.assertEqual(blocks[1]["type"], "paragraph")

    def test_deduplicates_only_the_same_physical_evidence_region(self) -> None:
        blocks = [
            {
                "id": "S001", "stableId": "first", "page": 3, "type": "paragraph", "order": 1,
                "originalText": "SE", "bbox": [294.413, 274.494, 308.271, 288.904],
                "confidence": "medium", "refs": [], "_doclingItemOrder": 23,
            },
            {
                "id": "S002", "stableId": "second", "page": 3, "type": "figure_text", "order": 2,
                "originalText": "SE", "bbox": [294.413, 274.494, 308.271, 288.904],
                "confidence": "high", "refs": ["F001"], "_doclingItemOrder": 28,
            },
            {
                "id": "S003", "stableId": "third", "page": 3, "type": "figure_text", "order": 3,
                "originalText": "SE", "bbox": [394.413, 274.494, 408.271, 288.904],
                "confidence": "high", "refs": [], "_doclingItemOrder": 29,
            },
        ]

        removed = deduplicate_physical_blocks(blocks)

        self.assertEqual(removed, 1)
        self.assertEqual(len(blocks), 2)
        self.assertEqual(blocks[0]["type"], "figure_text")
        self.assertEqual(blocks[0]["confidence"], "high")
        self.assertEqual(blocks[0]["refs"], ["F001"])
        self.assertEqual(blocks[0]["_doclingItemOrder"], 23)
        self.assertEqual(blocks[1]["bbox"][0], 394.413)


@unittest.skipUnless(REFERENCE_PDF.exists(), "reference PDF not available")
class ReferencePdfTests(unittest.TestCase):
    def test_inspection_detects_complete_text_layer(self) -> None:
        result = inspect_pdf(str(REFERENCE_PDF))
        self.assertEqual(result["page_count"], 30)
        self.assertTrue(result["has_text_layer"])
        self.assertGreater(result["text_characters"], 50_000)
        self.assertTrue(all(count > 100 for count in result["page_text_characters"]))
        self.assertEqual(result["sha256"], revision_for(REFERENCE_PDF))
        self.assertEqual(result["size"], REFERENCE_PDF.stat().st_size)

    def test_parse_rejects_a_staged_file_from_another_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "REVISION_MISMATCH"):
                parse_pdf(str(REFERENCE_PDF), directory, "0" * 64)

    def test_parse_builds_page_map_and_figures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(REFERENCE_PDF), directory, revision_for(REFERENCE_PDF))
            self.assertEqual(result["parser"], "docling+pdfplumber")
            self.assertEqual(result["paper"]["pageCount"], 30)
            self.assertEqual(len(result["pages"]), 30)
            self.assertGreater(len(result["blocks"]), 40)
            self.assertGreaterEqual(len(result["figures"]), 5)
            block_ids = [block["id"] for block in result["blocks"]]
            self.assertEqual(len(block_ids), len(set(block_ids)))
            content_figures = [figure for figure in result["figures"] if not figure["id"].startswith("E")]
            equation_assets = [figure for figure in result["figures"] if figure["id"].startswith("E")]
            for figure in content_figures:
                self.assertTrue(Path(figure["imagePath"]).is_file())
                self.assertGreater(Path(figure["imagePath"]).stat().st_size, 1_000)
                self.assertFalse(figure["approximate"])
                self.assertTrue(figure["placedAfter"])
                self.assertGreaterEqual(len(figure["captionBlockIds"]), 1)
                self.assertGreater(len(figure["originalCaption"]), 300)
                with Image.open(figure["imagePath"]) as image:
                    self.assertGreater(image.width, 700)
                    self.assertGreater(image.height, 200)
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in equation_assets))

            page_two_paragraphs = [block for block in result["blocks"] if block["page"] == 2 and block["type"] == "paragraph"]
            self.assertEqual(len(page_two_paragraphs), 1)
            self.assertIn("Li10SnP2S12", page_two_paragraphs[0]["originalText"])

            page_three_tail = next(block for block in result["blocks"] if block["originalText"].endswith("three-dimensional"))
            page_four_head = next(block for block in result["blocks"] if block["originalText"].startswith("reconstructions of materials"))
            self.assertEqual(page_three_tail["continuationKey"], page_four_head["continuationKey"])

            figure_one = next(figure for figure in result["figures"] if figure["id"] == "F001")
            self.assertGreater(len(figure_one["captionBlockIds"]), 1)
            figure_anchor = next(block for block in result["blocks"] if block["id"] == figure_one["placedAfter"])
            self.assertEqual(figure_anchor["originalText"], "Figures")
            visual_labels = [block for block in result["blocks"] if block["page"] == 16 and block["type"] == "figure_text"]
            self.assertGreater(len(visual_labels), 5)
            self.assertTrue(all("F001" in block["refs"] for block in visual_labels))

            rendered = render_page(str(REFERENCE_PDF), 3, str(Path(directory) / "page-3.png"), 1.2)
            self.assertEqual(rendered["page"], 3)
            self.assertGreater(rendered["width"], 500)
            self.assertGreater(rendered["height"], 700)
            self.assertTrue(Path(rendered["path"]).is_file())


@unittest.skipUnless(WILEY_REGRESSION_PDF.exists(), "local Wiley regression PDF not available")
class WileyRegressionPdfTests(unittest.TestCase):
    def test_filters_page_chrome_and_preserves_two_column_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(WILEY_REGRESSION_PDF), directory, revision_for(WILEY_REGRESSION_PDF))
            blocks = result["blocks"]
            self.assertEqual(result["paper"]["pageCount"], 13)
            self.assertTrue(result["paper"]["title"].startswith("Unveiling the Mechanical and Electrochemical Evolution"))
            content_figures = [figure for figure in result["figures"] if not figure["id"].startswith("E")]
            equation_assets = [figure for figure in result["figures"] if figure["id"].startswith("E")]
            self.assertEqual(len(content_figures), 7)
            self.assertEqual(len(equation_assets), 9)
            self.assertTrue(all(not figure["approximate"] for figure in result["figures"]))
            self.assertGreaterEqual(sum(block["type"] == "running_matter" for block in blocks), 120)
            self.assertGreaterEqual(sum(block["type"] == "front_matter" for block in blocks), 15)
            self.assertEqual(sum(block["type"] == "reference" for block in blocks), 27)
            self.assertEqual(sum(block["type"] == "formula" for block in blocks), 9)
            formulas = [block for block in blocks if block["type"] == "formula"]
            self.assertTrue(all(block["originalText"].strip() for block in formulas))
            self.assertTrue(all("Formula region" not in block["originalText"] for block in formulas))
            self.assertTrue(all(any(ref.startswith("E") for ref in block["refs"]) for block in formulas))
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in equation_assets))
            self.assertFalse(any(
                block["type"] != "running_matter"
                and (
                    float(block["bbox"][0]) >= 570
                    or "Downloaded from http" in block["originalText"]
                    or block["originalText"].lower().startswith("www.")
                )
                for block in blocks
            ))
            d30 = [block for block in blocks if block.get("_doclingItemId") == "D00030" and block["type"] == "paragraph"]
            self.assertEqual([block["page"] for block in d30], [2, 3, 3])
            self.assertTrue(d30[0]["originalText"].startswith("As illustrated in Figure 1"))
            self.assertTrue(d30[1]["originalText"].startswith("electron and ion conduction pathways"))
            self.assertTrue(d30[2]["originalText"].startswith("the electron conduction in the Si-SE"))

            contact_language = next(block for block in blocks if block["originalText"].startswith("the most promising anode materials"))
            self.assertEqual(contact_language["type"], "paragraph")
            page_two_resume = next(block for block in blocks if block["originalText"].startswith("change occurring in the Si anode"))
            self.assertEqual(contact_language["continuationKey"], page_two_resume["continuationKey"])

            morphology_left = next(block for block in blocks if block["originalText"].endswith("In comparison, there"))
            morphology_right = next(block for block in blocks if block["originalText"].startswith("are fewer pores or gaps"))
            self.assertEqual(morphology_left["continuationKey"], morphology_right["continuationKey"])

            capacity_left = next(block for block in blocks if block["originalText"].endswith("lower average"))
            capacity_right = next(block for block in blocks if block["originalText"].startswith("capacities of 118, 101"))
            self.assertEqual(capacity_left["continuationKey"], capacity_right["continuationKey"])


@unittest.skipUnless(HALIDE_REGRESSION_PDF.exists(), "local halide regression PDF not available")
class HalideRegressionPdfTests(unittest.TestCase):
    def test_hides_first_page_author_note_without_interrupting_introduction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(HALIDE_REGRESSION_PDF), directory, revision_for(HALIDE_REGRESSION_PDF))
            blocks = result["blocks"]
            contact_fragments = (
                "Department of Chemical and Biomolecular Engineering",
                "College Park, MD 20740",
                "@umd.edu",
            )
            contacts = [
                block for block in blocks
                if any(fragment in block["originalText"] for fragment in contact_fragments)
            ]
            self.assertEqual(len(contacts), 3)
            self.assertTrue(all(block["type"] == "front_matter" for block in contacts))

            left = next(block for block in blocks if block["originalText"].endswith("on the lithium"))
            right = next(block for block in blocks if block["originalText"].startswith("anode side, Li6PS5Cl"))
            self.assertEqual(left["continuationKey"], right["continuationKey"])

            corrosion_left = next(block for block in blocks if block["originalText"].endswith("Specifically,"))
            corrosion_right = next(block for block in blocks if block["originalText"].startswith("as illustrated in Figure 2b"))
            self.assertEqual(corrosion_left["continuationKey"], corrosion_right["continuationKey"])

            interlayer_left = next(block for block in blocks if block["originalText"].endswith("Li dendrite initiation)"))
            interlayer_right = next(block for block in blocks if block["originalText"].startswith("and the interlayer thickness"))
            self.assertEqual(interlayer_left["continuationKey"], interlayer_right["continuationKey"])

            coating_left = next(block for block in blocks if block["originalText"].endswith("reduced to form"))
            coating_right = next(block for block in blocks if block["originalText"].startswith("a Li6PI3 layer"))
            self.assertEqual(coating_left["continuationKey"], coating_right["continuationKey"])

            conclusion_left = next(block for block in blocks if block["originalText"].endswith("Li dendrite growth in"))
            conclusion_right = next(block for block in blocks if block["originalText"].startswith("Li3YbCl6 and Li3LuCl6 halide solid electrolytes"))
            self.assertEqual(conclusion_left["continuationKey"], conclusion_right["continuationKey"])

            statistics = next(block for block in blocks if block["originalText"] == "Statistical Analysis :")
            self.assertEqual(statistics["type"], "heading")

            figures = result["figures"]
            self.assertTrue(all(figure["placedAfter"] for figure in figures))
            figure_two = next(figure for figure in figures if figure["id"] == "F002")
            figure_two_anchor = next(block for block in blocks if block["id"] == figure_two["placedAfter"])
            self.assertTrue(figure_two_anchor["originalText"].startswith("of 0.4C rate at 30"))


@unittest.skipUnless(LLZO_REGRESSION_PDF.exists(), "local LLZO regression PDF not available")
class LlzoRegressionPdfTests(unittest.TestCase):
    def test_keeps_abstract_and_extracts_all_primary_visuals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(LLZO_REGRESSION_PDF), directory, revision_for(LLZO_REGRESSION_PDF))
            blocks = result["blocks"]
            self.assertEqual(result["paper"]["pageCount"], 20)
            self.assertTrue(result["paper"]["title"].startswith("Kinetic versus Thermodynamic Stability of LLZO"))

            abstract = next(block for block in blocks if block["originalText"].startswith("Li7La3Zr2O12(LLZO) garnet-based oxides"))
            self.assertEqual(abstract["type"], "paragraph")

            figure_ids = {figure["id"] for figure in result["figures"]}
            self.assertEqual(figure_ids, {"GA001", "F001", "F002", "F003", "F004", "F005", "F006", "T001"})
            graphical_abstract = next(figure for figure in result["figures"] if figure["id"] == "GA001")
            self.assertEqual(graphical_abstract["page"], 2)
            self.assertEqual(graphical_abstract["originalCaption"], "TOC Graphic")
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in result["figures"]))


@unittest.skipUnless(REPOSITORY_COVER_REGRESSION_PDF.exists(), "repository-cover regression PDF not available")
class RepositoryCoverRegressionPdfTests(unittest.TestCase):
    def test_uses_article_title_hides_contacts_and_classifies_bibliographies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(REPOSITORY_COVER_REGRESSION_PDF), directory, revision_for(REPOSITORY_COVER_REGRESSION_PDF))
            blocks = result["blocks"]

            self.assertEqual(result["paper"]["pageCount"], 22)
            self.assertEqual(
                result["paper"]["title"],
                "Dendrite Initiation and Propagation in Lithium Metal Solid-State Batteries",
            )
            self.assertTrue(all(block["type"] == "front_matter" for block in blocks if block["page"] == 1))

            author_list = next(block for block in blocks if block["originalText"].startswith("Ziyang Ning"))
            self.assertEqual(author_list["type"], "front_matter")

            correspondence = next(block for block in blocks if "*Correspondence:" in block["originalText"])
            self.assertEqual(correspondence["type"], "front_matter")
            affiliations = [
                block for block in blocks
                if block["page"] == 2 and "University of Oxford" in block["originalText"]
            ]
            self.assertTrue(affiliations)
            self.assertTrue(all(block["type"] == "front_matter" for block in affiliations))

            abstract_start = next(block for block in blocks if block["originalText"].startswith("All-solid-state batteries with a Li anode"))
            abstract_resume = next(block for block in blocks if block["originalText"].startswith("to the surface. Once filled"))
            self.assertEqual(abstract_start["type"], "paragraph")
            self.assertEqual(abstract_start["continuationKey"], abstract_resume["continuationKey"])

            references_heading = next(block for block in blocks if block["originalText"] == "References")
            acknowledgements = next(block for block in blocks if block["originalText"] == "ACKNOWLEDGEMENTS")
            self.assertEqual(references_heading["type"], "reference")
            self.assertEqual(acknowledgements["type"], "heading")
            between = [
                block for block in blocks
                if references_heading["order"] < block["order"] < acknowledgements["order"]
                and block["type"] not in {"running_matter", "figure_text"}
            ]
            self.assertTrue(between)
            self.assertTrue(all(block["type"] == "reference" for block in between))

            methods = next(block for block in blocks if block["originalText"].startswith("A 5 mm pristine Li6PS5Cl disk"))
            self.assertEqual(methods["type"], "paragraph")
            additional_heading = next(block for block in blocks if block["originalText"] == "Additional References")
            additional_entry = next(block for block in blocks if block["originalText"].startswith("Baranowski, L. L."))
            self.assertEqual(additional_heading["type"], "reference")
            self.assertEqual(additional_entry["type"], "reference")

            content_figures = [figure for figure in result["figures"] if not figure["id"].startswith("E")]
            self.assertEqual({figure["id"] for figure in content_figures}, {"F001", "F002", "F003", "F004"})
            self.assertTrue(all(not figure["approximate"] for figure in result["figures"]))
            self.assertTrue(all(figure["placedAfter"] for figure in result["figures"]))
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in result["figures"]))


@unittest.skipUnless(FULLTEXT_04_REGRESSION_PDF.exists(), "new-paper regression PDF not available")
class Fulltext04RegressionPdfTests(unittest.TestCase):
    def test_deduplicates_overlapping_figure_labels_before_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(FULLTEXT_04_REGRESSION_PDF), directory, revision_for(FULLTEXT_04_REGRESSION_PDF))
            blocks = result["blocks"]
            stable_ids = [block["stableId"] for block in blocks]

            self.assertEqual(result["paper"]["pageCount"], 7)
            self.assertEqual(
                result["paper"]["title"],
                "High capacity and stable all-solid-state Li ion battery using SnO2-embedded nanoporous carbon",
            )
            self.assertEqual(len(stable_ids), len(set(stable_ids)))
            self.assertTrue(any("已合并 1 个" in warning for warning in result["warnings"]))
            unheaded_narrative = [
                block for block in blocks
                if block["originalText"].startswith((
                    "Extensive research efforts",
                    "All-solid-state lithium ion batteries",
                    "Conventional researches on ASS",
                ))
            ]
            self.assertEqual(len(unheaded_narrative), 3)
            self.assertTrue(all(block["type"] == "paragraph" for block in unheaded_narrative))
            copyright_notice = next(block for block in blocks if block["originalText"].startswith("© The Author"))
            self.assertEqual(copyright_notice["type"], "running_matter")
            self.assertEqual(len(result["figures"]), 5)
            self.assertTrue(all(not figure["approximate"] for figure in result["figures"]))
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in result["figures"]))


@unittest.skipUnless(WILEY_LIS_REGRESSION_PDF.exists(), "Wiley lithium-sulfur regression PDF not available")
class WileyLithiumSulfurRegressionPdfTests(unittest.TestCase):
    def test_hides_open_access_notice_and_preserves_interrupted_sentence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(WILEY_LIS_REGRESSION_PDF), directory, revision_for(WILEY_LIS_REGRESSION_PDF))
            blocks = result["blocks"]

            self.assertEqual(result["paper"]["pageCount"], 10)
            self.assertNotIn("&#", result["paper"]["title"])
            license_notice = next(block for block in blocks if block["originalText"].startswith("©2024 The Authors"))
            self.assertEqual(license_notice["type"], "running_matter")
            sentence_start = next(block for block in blocks if block["originalText"].startswith("To fundamentally address"))
            sentence_resume = next(block for block in blocks if block["originalText"].startswith("ASSLSBs due to"))
            self.assertEqual(sentence_start["type"], "paragraph")
            self.assertEqual(sentence_start["continuationKey"], sentence_resume["continuationKey"])
            page_five_start = next(block for block in blocks if block["originalText"].startswith("Li/Li2S/LGPS/S cell was revealed"))
            page_five_resume = next(block for block in blocks if block["originalText"].startswith("and a S loading of"))
            self.assertEqual(page_five_start["continuationKey"], page_five_resume["continuationKey"])


@unittest.skipUnless(SINGH_REGRESSION_PDF.exists(), "Singh regression PDF not available")
class SinghRegressionPdfTests(unittest.TestCase):
    def test_does_not_treat_a_figure_mention_as_a_duplicate_caption(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = parse_pdf(str(SINGH_REGRESSION_PDF), directory, revision_for(SINGH_REGRESSION_PDF))
            blocks = result["blocks"]
            figures = result["figures"]
            content_figures = [figure for figure in figures if not figure["id"].startswith("E")]

            self.assertEqual(result["paper"]["pageCount"], 12)
            self.assertNotIn("&#", result["paper"]["title"])
            self.assertEqual([figure["id"] for figure in content_figures], [
                "F001", "F002", "F003", "F004", "F005", "F006", "F007", "F008",
            ])
            self.assertEqual(len({figure["id"] for figure in figures}), len(figures))
            self.assertTrue(all(Path(figure["imagePath"]).is_file() for figure in figures))

            prose_mention = next(
                block for block in blocks
                if block["originalText"].startswith("Figure 4 indicates that our microelectrodes")
            )
            self.assertEqual(prose_mention["type"], "paragraph")
            figure_four = next(figure for figure in figures if figure["id"] == "F004")
            self.assertTrue(figure_four["originalCaption"].startswith("Figure 4."))
            self.assertNotIn("indicates that our microelectrodes", figure_four["originalCaption"])


if __name__ == "__main__":
    unittest.main()
