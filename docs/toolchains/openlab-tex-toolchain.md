# Sci Workplace TeX Toolchain offline package

The TeX distribution is intentionally not embedded in the Sci Workplace installer. A portable, locally licensed TeX Live tree can be distributed as a directory or ZIP with an `openlab-toolchain.json` compatibility manifest at its root.

```json
{
  "schemaVersion": 1,
  "id": "openlab.texlive.2026.1",
  "kind": "texlive",
  "name": "Sci Workplace TeX Live 2026",
  "version": "2026.1",
  "executables": {
    "latexmk": "texlive/bin/windows/latexmk.exe",
    "synctex": "texlive/bin/windows/synctex.exe",
    "pdflatex": "texlive/bin/windows/pdflatex.exe",
    "xelatex": "texlive/bin/windows/xelatex.exe"
  },
  "expectedSha256": "optional-tree-hash-produced-by-the-release-pipeline"
}
```

The installer rejects absolute executable paths, symbolic links/junctions, traversal entries, more than 100,000 files and more than 20 GiB of expanded data. It copies the package into the Electron user-data toolchain directory, hashes the complete tree and records the version and executable list in the event stream.

Projects select the installed toolchain by ID. Jobs resolve executable names through that manifest. TeX jobs are offline by default; Sci Workplace injects `-no-shell-escape`, `-interaction=nonstopmode`, `-halt-on-error`, `-file-line-error` and `-synctex=1`. The application does not install missing packages or update TeX Live over the network.

The package publisher must also ship the TeX Live license inventory and any additional tool licenses beside the tree. Those license files become part of the package hash and may be included in an Artifact environment manifest.
