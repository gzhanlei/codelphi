# Host adapters

Claude Code has a verified adapter at `adapters/claude-code.cjs` (2026-11-17): it invokes official `claude -p` with no model override and completed a real public-repository snapshot. Other product-specific hosts remain unverified.

The bundled CLI already accepts two explicit, host-neutral injection mechanisms: a host-owned local completion bridge and an official host completion CLI. Programmatic callers may also provide an in-process `StructuredCompletionClient` through `runSnapshot`.

Do not add adapters that scrape another host's private configuration or credentials, and do not infer authorization from the mere presence of an executable.
