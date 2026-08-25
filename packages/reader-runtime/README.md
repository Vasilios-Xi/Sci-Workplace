# Sci Workplace Reader Runtime

`openlab.reader-runtime` is a host-managed, offline PDF parsing toolchain. It is
shipped with Sci Workplace rather than with an individual plugin so large Docling
models and native libraries do not count against plugin package limits.

The runtime never calls a model or the network. Plugins submit revision-bound
documents to the Sci Workplace job service; the host stages those inputs and invokes
one of these one-shot commands:

- `capabilities --output <json>`
- `inspect --input <pdf> --output <json>`
- `parse --input <pdf> --revision <sha256> --output-dir <directory>`
- `render-page --input <pdf> --page <one-based-page> --output <png>`

The legacy NDJSON `--serve` transport remains available while OpenScientific
parity tests are migrated. Runtime bundles are produced under `dist/`, which is
not source-controlled. `pnpm bundle` imports a verified prebuilt worker from
`OPENLAB_READER_RUNTIME_SOURCE` or a sibling OpenScientific checkout; a clean
release build may instead build that same source with PyInstaller.

Every bundle has two complementary manifests. `integrity.json` contains the
SHA-256 and size of every payload file. `openlab-toolchain.json` embeds a
deterministic `runtimeInventory` that identifies the Worker, the seven required
parser distributions, every bundled model file, all discoverable distribution
metadata, and all third-party license files. Sci Workplace recomputes and validates
both manifests at startup, rejects omitted or unlisted files, and keeps the
runtime completely offline (`network=false`).

To freeze the patched worker itself, set `OPENLAB_READER_PYTHON` to a Python
environment containing the pinned dependencies and
`OPENLAB_READER_MODEL_SOURCE` to OpenScientific's offline `model-artifacts`
directory, then run `pnpm freeze`. The output is written below `.freeze/dist`
and can be imported with `pnpm bundle:refresh -- --source <path>`.
