---
name: codelphi-radar
description: Understand a local Git repository or a public GitHub repository as a product. Generate one self-contained HTML brief with features, scenarios, and source evidence; or, for a CoDelphi product that is enabled for client-side analysis, publish the analysis to CoDelphi from the user's own machine without uploading source files or patches. Use when the user wants to understand what a codebase does, or to update the ledger of a CoDelphi product that is enabled for client-side analysis.
---

# CoDelphi Radar

Generate one offline HTML product brief, or publish one analysis to CoDelphi when the product is enabled for it (section 6). Do not turn this into release tracking or a second implementation of the extraction pipeline.

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

After the partition results are complete, the same command also generates and validates `presentation.json`: the product-domain map, evidence-linked user journeys, and domain concepts. Existing partition results are reused rather than extracted again.

For every `work-orders/<partition-id>.json`:

1. Run `node "<skill-directory>/scripts/snapshot.cjs" show --workdir <work-directory> --partition <partition-id>` and use the returned work order. This refreshes feature-name continuity from completed results.
2. Execute the returned system and user messages using the current host model and its normal reasoning capability.
3. Write only the resulting JSON object to `results/<partition-id>.json`, using UTF-8 and the exact filename.
4. Keep the work order's `contractVersion` semantics: product/release/changes/features are required, release title and summary must be non-empty, and every factual item must cite an allowed source path with a valid line number.

Do not invent source evidence, emit Markdown fences, skip partitions, or write a report yourself. If a result is invalid, fix only that partition's result.

After all partition results exist, run the same `complete` command once. It reuses every existing partition result and only generates the presentation. If presentation generation or validation fails, finalization visibly degrades to a complete feature index instead of presenting alphabetically selected features as core capabilities.

## 4. Finalize the report

After all results exist, run:

```bash
node "<skill-directory>/scripts/snapshot.cjs" finalize --workdir <work-directory>
```

The CLI applies the shared schema, evidence validation, merge, saved presentation validation, and HTML renderer. It rejects missing, duplicate, invalid, or contract-incompatible results without emitting a success report.

Return only the clickable path to `<work-directory>/radar.html` in the invocation language. The work directory and intermediate JSON are not deliverables.

## 5. Explicit standalone fallback

Use standalone mode only when the user explicitly chooses it or supplies `--env-file`. In that mode, invoke the same CLI without `prepare`/`finalize`:

```bash
node "<skill-directory>/scripts/snapshot.cjs" <target> --standalone --language <zh-CN|en> --output <report.html>
```

Standalone uses `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL`; never print those credentials. `AI_TIMEOUT_MS` controls the request timeout. `AI_MAX_TOKENS` controls the output token budget per request (default 16000); increase it when the provider returns `finish_reason=length`, not the request timeout. When usage accounting is requested, set `CODELPHI_USAGE_LOG` to a JSONL path to record each successful call's duration, request id, model, and raw gateway usage; the log contains no credentials. Do not silently fall back to standalone when host-native work orders are available.

## 6. Publish an analysis to CoDelphi (client-side analysis)

Use this only when the user has a CoDelphi product that is enabled for client-side analysis. It replaces uploading a radar snapshot. Source files, patches, and source excerpts never leave the machine: what is uploaded is a proposal (features, scenarios, evidence paths and line numbers) produced with the user's own model key. Model requests go to the user's model provider and do not pass through CoDelphi.

Set it up once, from any directory (the settings are stored outside the repository, in `~/.config/codelphi/credentials.env` or `%APPDATA%\codelphi\credentials.env`; never print them):

```bash
node "<skill-directory>/scripts/snapshot.cjs" config
```

It asks for the CoDelphi server address and upload key, then for the model provider, key and model name. It verifies both groups with a real call and says where requests will go before any key is entered. `config --show` lists what is set without showing keys.

Publish from the repository:

```bash
node "<skill-directory>/scripts/snapshot.cjs" publish <local-repo> --slug <product-slug> --language <zh-CN|en>
```

- Without `--full` it does nothing when the ledger already sits on the local commit. Add `--full` to analyse again on top of the current version. Incremental analysis is not available yet.
- A full analysis takes many minutes and spends the user's model budget. Give it a work directory so that an interruption does not cost the same work twice:

```bash
node "<skill-directory>/scripts/snapshot.cjs" publish <local-repo> --slug <product-slug> --language <zh-CN|en> --workdir <work-directory> --prepare
node "<skill-directory>/scripts/snapshot.cjs" publish <local-repo> --slug <product-slug> --language <zh-CN|en> --workdir <work-directory> --finalize
```

`--prepare` analyses and saves the proposal without uploading. If it is interrupted, run it again: finished work is reused. `--finalize` uploads the saved proposal and does not call a model. The work directory holds intermediate results, including raw model output. Do not commit it and do not read it into the conversation.

- `status <local-repo> --slug <product-slug>` shows the binding and whether the local commit is ahead of the ledger.
- Text that looks like source code is removed before upload and listed on the terminal; the command reports how many items were removed.

Do not call the CoDelphi API yourself, do not upload anything on the user's behalf outside `publish`, and do not paste the proposal into the conversation.
