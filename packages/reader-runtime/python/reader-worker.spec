import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, copy_metadata

ROOT = Path(SPECPATH).parent
datas = []
hiddenimports = [
    "docling.backend.docling_parse_backend",
    "docling.models.inference_engines.object_detection.transformers_engine",
    "docling.models.stages.layout.layout_object_detection_model",
    "docling.models.stages.table_structure.table_structure_model",
    "docling.pipeline.standard_pdf_pipeline",
    "docling_ibm_models.tableformer.common",
    "docling_ibm_models.tableformer.data_management.tf_predictor",
    "docling_parse.pdf_parser",
    "transformers.models.rt_detr.configuration_rt_detr",
    "transformers.models.rt_detr.configuration_rt_detr_resnet",
    "transformers.models.rt_detr.image_processing_rt_detr",
    "transformers.models.rt_detr.image_processing_pil_rt_detr",
    "transformers.models.rt_detr.modeling_rt_detr",
    "transformers.models.rt_detr.modeling_rt_detr_resnet",
    "transformers.models.rt_detr_v2.configuration_rt_detr_v2",
    "transformers.models.rt_detr_v2.modeling_rt_detr_v2",
]

for distribution in (
    "docling",
    "docling-core",
    "docling-ibm-models",
    "docling-parse",
    "pdfplumber",
    "pypdf",
    "pypdfium2",
    "torch",
    "torchvision",
    "transformers",
):
    try:
        datas += copy_metadata(distribution)
    except Exception:
        pass

# The native docling-parse backend resolves CMaps, glyph maps and font metrics
# relative to its package directory.  PyInstaller classifies these as data, so
# they must be added explicitly for frozen Windows workers.
datas += collect_data_files("docling_parse")

models = Path(os.environ.get("OPENLAB_READER_MODEL_SOURCE", ROOT / "python" / "model-artifacts"))
layout_model = models / "docling-project--docling-layout-heron"
if layout_model.exists():
    datas.append((str(layout_model), "model-artifacts/docling-project--docling-layout-heron"))
table_model = models / "docling-project--docling-models" / "model_artifacts" / "tableformer" / "accurate"
if table_model.exists():
    datas.append((
        str(table_model),
        "model-artifacts/docling-project--docling-models/model_artifacts/tableformer/accurate",
    ))

a = Analysis(
    [str(ROOT / "python" / "reader_worker" / "main.py")],
    pathex=[str(ROOT / "python")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "easyocr",
        "IPython",
        "jax",
        "matplotlib",
        "notebook",
        "onnxruntime",
        "pptx",
        "rapidocr",
        "tensorboard",
        "tensorflow",
        "tkinter",
        "transformers.cli",
        "docx",
        "openpyxl",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="reader-worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="reader-worker",
)
