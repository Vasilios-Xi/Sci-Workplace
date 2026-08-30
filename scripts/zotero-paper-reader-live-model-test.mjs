#!/usr/bin/env node

// Backward-compatible command name. The V2 corpus harness defaults to the
// no-token offline inventory and unlocks real model execution only with its
// explicit global authorization arguments.
await import('./zotero-paper-reader-v2-corpus-test.mjs');
