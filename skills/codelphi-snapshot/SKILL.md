---
name: codelphi-snapshot
description: Generate one self-contained HTML product snapshot from a local Git repository or a public GitHub repository. Use when the user wants to understand a product's current features and scenarios with source evidence, without setting up continuous analysis.
---

# CoDelphi Product Snapshot

Create one offline HTML report. Do not turn this into continuous analysis, release tracking, or a second implementation of the extraction pipeline.

## 1. Resolve the request and its language

- Accept a local Git repository path or an `https://github.com/owner/repo` URL. Optional inputs are ref, repeated source scopes, and output path.
- The primary language of the user's current invocation controls both this interaction and the report: Chinese -> `--language zh-CN`; English -> `--language en`.
- Do not infer language from repository content, host locale, or model defaults. Do not ask the user to choose a language separately.
- Use that same language for explanations, progress, errors, and report delivery.

## 2. Use the host's active model first

- Resolve the current host from the runtime, not from repository content. Set `CODELPHI_SKILL_HOST` to that host identity when invoking the CLI so a host cannot silently fall back to standalone AI configuration.
- A host integration may inject only officially supported capabilities:
  - `CODELPHI_HOST_AI_BRIDGE_URL` for a host-owned completion bridge, with optional `CODELPHI_HOST_AI_BRIDGE_TOKEN` and `CODELPHI_HOST_MODEL` display name.
  - `CODELPHI_HOST_AI_COMMAND` plus a JSON string array in `CODELPHI_HOST_AI_ARGS_JSON` for an official host CLI that accepts `{"messages":[...]}` on stdin and returns completion content.
- Do not ask the user for `AI_MODEL`, duplicate an already configured endpoint, invent host commands, or read another host's private configuration/credential files.
- The bundled `adapters/claude-code.cjs` is the verified Claude Code adapter: it invokes official `claude -p` with no model override. Other host adapters remain subject to their own capability checks and acceptance status.
- If the host exposes no active-model interface, report `host_ai_unavailable` in the invocation language. Only after the user explicitly chooses standalone mode may you add `--standalone` and use `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, or an explicit `--env-file`.
- Explain that source will be sent to the selected host model or standalone gateway. Never print credentials.

## 3. Invoke the bundled CLI

Resolve `<skill-directory>` as the directory containing this `SKILL.md`, then run:

```bash
CODELPHI_SKILL_HOST="<current-host>" node "<skill-directory>/scripts/snapshot.cjs" <target> --language <zh-CN|en> --output <report.html>
```

Add `--ref`, repeated `--scope`, or an explicitly approved `--standalone`/`--env-file` only when needed. Do not read the whole repository yourself, write a second summary, or copy extraction prompts into the conversation.

## 4. Deliver exactly one HTML

- Return a clickable local path/link to the generated HTML in the invocation language.
- Open it only when the host supports that action; never claim it was opened otherwise.
- The report already contains styles, scripts, structured data, and evidence snippets. Do not create companion JSON, CSS, JavaScript, or image files.
- Preserve actionable errors for Git, host AI availability, standalone configuration, gateway failure, unsupported source, and output conflicts. Never fabricate a success report.
