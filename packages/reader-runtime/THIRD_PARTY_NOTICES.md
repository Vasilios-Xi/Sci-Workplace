# Reader Runtime third-party notices

The bundled reader runtime contains Python, Docling, docling-core,
docling-parse, docling-ibm-models, PyTorch, torchvision, Transformers,
pdfplumber, pypdf, pypdfium2, Pillow, NumPy and their transitive dependencies.

Release packaging must retain the license and model-license evidence emitted by
the upstream distributions. The generated `runtimeInventory` records every
discoverable distribution, license file, model payload and license source with
SHA-256. The bundle and host startup verifiers reject missing parser metadata,
missing model-license evidence, omitted payloads, unlisted files, or any hash
mismatch.
