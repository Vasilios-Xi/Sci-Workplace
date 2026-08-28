# Sci Workplace Zotero Companion

This restricted Zotero 7–9 companion exists only because Zotero versions before 10 do not support Local API writes.

It registers four loopback endpoints: health/status, session pairing, bounded item search, and idempotent collection/item/OA-attachment sync. Pairing requires a Zotero confirmation and creates a random in-memory session key. It does not expose arbitrary code execution, does not accept filesystem paths, and never edits Zotero's SQLite database directly.

Zotero 10+ does not need this extension; Sci Workplace automatically uses the official Local API write flow instead.
