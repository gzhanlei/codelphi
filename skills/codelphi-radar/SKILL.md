---
name: codelphi-radar
description: Understand a local Git repository or a public GitHub repository as a product and generate one self-contained HTML brief with features, scenarios, and source evidence. Use when the user wants to understand what a codebase does without setting up continuous analysis.
---

# CoDelphi Radar

Generate one offline HTML product brief. Do not turn this into continuous analysis, release tracking, or a second implementation of the extraction pipeline.

## 1. Resolve the request and language

- Accept a local Git repository path or an `https://github.com/owner/repo` URL. Optional inputs are ref, repeated source scopes, and a work directory.
- The primary language of the user's current invocation controls both the interaction and the report: Chinese -> `--language zh-CN`; English -> `--language en`.
- Do not infer language from repository content, host locale, or model defaults.

## 2. Prepare work orders

Resolve `<skill-directory>` as the directory containing this `SKILL.md`, then run:

```bash
node "<skill-directory>/scripts/snapshot.cjs" prepare <target> --workdir <work-directory> --language <zh-CN|en>
```

Add `--ref` or repeated `--scope` only when needed. The CLI resolves the fixed commit, plans relevant source, and writes `manifest.json` and `work-orders/<partition-id>.json`.

Preparation does not require a model API, completion CLI, bridge, token, adapter, or `AI_*` variables. Do not read the whole repository yourself or write a second extraction prompt.

## 3. Complete each work order with the host's current model

First try the CLI completion pass — it is dramatically faster than per-partition agent execution when any completion backend exists:

```bash
CODELPHI_SKILL_HOST=<your-host-identity> node "<skill-directory>/scripts/snapshot.cjs" complete --workdir <work-directory> --concurrency 4
```

Set `CODELPHI_SKILL_HOST` to the identity of the host you are running in (`claude-code`, `codex`, `gemini`, `cursor`, `kimi`, `qwen`, `opencode`, `antigravity`) so the command may use that host's own headless CLI as a completion backend; leave it unset to disable CLI autodetect. The command detects a backend in order: explicit standalone AI configuration (`--env-file` or `AI_API_KEY`/`AI_MODEL`), a host-injected bridge (`CODELPHI_HOST_AI_BRIDGE_URL`/`TOKEN` or `CODELPHI_HOST_AI_COMMAND`/`CODELPHI_HOST_AI_ARGS_JSON`), then the current host's own headless CLI (matched only against `CODELPHI_SKILL_HOST`, never across vendors). If it reports no available backend, fall back to the agent flow below.

For every `work-orders/<partition-id>.json`:

1. Run `node "<skill-directory>/scripts/snapshot.cjs" show --workdir <work-directory> --partition <partition-id>` and use the returned work order. This refreshes feature-name continuity from completed results.
2. Execute the returned system and user messages using the current host model and its normal reasoning capability.
3. Write only the resulting JSON object to `results/<partition-id>.json`, using UTF-8 and the exact filename.
4. Keep the work order's `contractVersion` semantics: product/release/changes/features are required, release title and summary must be non-empty, and every factual item must cite an allowed source path with a valid line number.

Do not invent source evidence, emit Markdown fences, skip partitions, or write a report yourself. If a result is invalid, fix only that partition's result.

## 4. Finalize the report

After all results exist, run:

```bash
node "<skill-directory>/scripts/snapshot.cjs" finalize --workdir <work-directory>
```

The CLI applies the shared schema, evidence validation, merge, deterministic presentation, and HTML renderer. It rejects missing, duplicate, invalid, or contract-incompatible results without emitting a success report.

Return only the clickable path to `<work-directory>/radar.html` in the invocation language. The work directory and intermediate JSON are not deliverables.

## 5. Explicit standalone fallback

Use standalone mode only when the user explicitly chooses it or supplies `--env-file`. In that mode, invoke the same CLI without `prepare`/`finalize`:

```bash
node "<skill-directory>/scripts/snapshot.cjs" <target> --standalone --language <zh-CN|en> --output <report.html>
```

Standalone uses `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL`; never print those credentials. Do not silently fall back to standalone when host-native work orders are available.
