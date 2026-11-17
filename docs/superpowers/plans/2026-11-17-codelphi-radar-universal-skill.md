# CoDelphi Radar Universal Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any agent host analyze a repository with its own model through prepare/finalize work orders, while sharing one extraction contract with standalone and the main product.

**Architecture:** Extract prompt construction into a versioned work-order contract, then split snapshot analysis into deterministic preparation and finalization. Standalone executes work orders through the existing completion client; host agents write the same structured results to disk for deterministic validation and HTML generation.

**Tech Stack:** TypeScript, Node.js 22, Zod, Vitest, esbuild, Next.js, existing Git/source index and snapshot renderer.

**Spec:** `docs/superpowers/specs/2026-11-17-codelphi-radar-universal-skill-design.md`

## Global Constraints

- Public name is `codelphi-radar`; internal snapshot types may remain for compatibility.
- Host mode must not require a completion CLI, bridge, token, adapter, or `AI_*` variables.
- Standalone and the main product keep programmatic completion; host agents use prepare/finalize files.
- One prompt/schema/validation path; no prompt copied into `SKILL.md`.
- No partition-count cap and no second repository or Git submodule.
- Final delivery is exactly one HTML; work directories are not deliverables.
- Preserve unrelated workspace changes and existing standalone behavior.
- Do not hide schema failures or emit a success HTML when required results are missing or invalid.

## Review Focus

- Missing/duplicate results and contract-version mismatches must identify the exact partition; pin in Task 3.
- Failed partitions must resume without rerunning completed results; pin in Task 3.
- Empty `release.title`/`release.summary` must fail validation rather than produce a report; pin in Tasks 1 and 3.
- Bundle execution without source checkout, root `node_modules`, AI keys, or host bridge must still work; pin in Task 4.
- Existing standalone, incremental, carry-forward, and manual-entry behavior must not regress; pin in Task 5.
- Git lazy-fetch failures must remain distinguishable from model/schema failures; pin in Task 5.

---

### Task 1: Versioned extraction work-order contract

**Files:**
- Create: `lib/extraction-contract.ts`
- Modify: `lib/ai.ts:417-455`
- Test: `tests/extraction-contract.test.ts`

**Interfaces:**
- Produces: `CONTRACT_VERSION`, `ExtractionWorkOrder`, `buildExtractionWorkOrder`, `buildAnalysisMessages`, and existing `parseAnalysisContent` reuse.
- Consumes: current `AnalysisResult`, `ChangeContext`, prompt sections, and partition source types.

- [ ] **Step 1: Write failing contract tests**

Assert identical inputs produce the same system/user messages through `analyzeWithAI` and `buildExtractionWorkOrder`. Assert work orders contain `contractVersion`, stable partition ID, messages, numbered sources, and evidence allow paths. Assert a result missing `release.title` or `release.summary` is rejected by `parseAnalysisContent`.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/extraction-contract.test.ts`
Expected: contract module and message builder do not exist.

- [ ] **Step 3: Extract message building and define the contract**

Move prompt construction out of `analyzeWithAI` without changing its text. Define `buildExtractionWorkOrder` to return versioned messages, sources, change/context, partition metadata, and evidence allow paths. `analyzeWithAI` must call the same builder and existing parser.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/extraction-contract.test.ts tests/ai.test.ts tests/ai-prompt-language.test.ts`
Expected: all contract and existing AI prompt tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/extraction-contract.ts lib/ai.ts tests/extraction-contract.test.ts
git commit -m "feat: add versioned extraction work orders"
```

### Task 2: Split snapshot preparation and finalization

**Files:**
- Create: `lib/snapshot/workflow.ts`
- Modify: `lib/snapshot/analyze.ts`
- Modify: `lib/snapshot/run.ts`
- Test: `tests/snapshot-workflow.test.ts`
- Test: `tests/snapshot-analyze.test.ts`

**Interfaces:**
- Produces: `prepareSnapshotAnalysis`, `executeSnapshotWorkOrder`, and `finalizeSnapshotAnalysis`.
- Consumes: Task 1 work orders and existing target resolution, planning, coverage, merge, presentation, and renderer.

- [ ] **Step 1: Write failing workflow tests**

Verify preparation resolves the fixed revision and returns work orders without any model client. Verify finalization accepts valid results, merges them, rejects missing/invalid results, and produces the same analysis shape as the existing snapshot path. Verify no model call occurs during preparation.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/snapshot-workflow.test.ts tests/snapshot-analyze.test.ts`
Expected: workflow functions do not exist.

- [ ] **Step 3: Implement the shared workflow**

Extract target planning and work-order creation from `analyzeProductSnapshot`. Execute each work order through the existing completion client for standalone. Finalize with the existing merge, evidence sanitization, coverage, warnings, presentation, and cleanup. Keep `analyzeProductSnapshot` and `runSnapshot` as compatibility wrappers over this workflow.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/snapshot-workflow.test.ts tests/snapshot-analyze.test.ts tests/snapshot-cli.test.ts`
Expected: all workflow, snapshot, and CLI tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/snapshot/workflow.ts lib/snapshot/analyze.ts lib/snapshot/run.ts tests/snapshot-workflow.test.ts tests/snapshot-analyze.test.ts tests/snapshot-cli.test.ts
git commit -m "refactor: share snapshot preparation and finalization"
```

### Task 3: Host-native prepare/finalize workspace protocol

**Files:**
- Create: `lib/snapshot/workspace.ts`
- Modify: `scripts/snapshot.ts`
- Test: `tests/snapshot-workspace.test.ts`

**Interfaces:**
- Produces: `prepareSnapshotWorkspace(options)` and `finalizeSnapshotWorkspace(directory)`; CLI `prepare` and `finalize` subcommands.
- Consumes: Task 2 workflow and Task 1 `CONTRACT_VERSION`.

- [ ] **Step 1: Write failing workspace tests**

Test prepare writes `manifest.json` and versioned work orders without a model interface. Simulate host-written results and verify finalize emits one HTML. Test missing results, duplicate results, empty release fields, and version mismatch identify the partition and do not emit HTML. Test rerun finalization resumes only missing/failed partitions.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/snapshot-workspace.test.ts`
Expected: workspace protocol and subcommands do not exist.

- [ ] **Step 3: Implement workspace persistence and CLI subcommands**

Persist manifest/work orders/results atomically, validate each result with the shared parser and evidence allow set, and finalize through Task 2. Keep existing one-shot CLI behavior as the standalone path. `prepare` must not resolve a host completion client; `finalize` must not silently fall back to standalone.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/snapshot-workspace.test.ts tests/snapshot-cli.test.ts`
Expected: all workspace and existing CLI tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add lib/snapshot/workspace.ts scripts/snapshot.ts tests/snapshot-workspace.test.ts tests/snapshot-cli.test.ts
git commit -m "feat: support host-native radar workspaces"
```

### Task 4: Rename and distribute codelphi-radar

**Files:**
- Create: `skills/codelphi-radar/SKILL.md`
- Create: `app/skills/codelphi-radar/page.tsx`
- Modify: `scripts/build-snapshot-skill.ts`
- Modify: `package.json`
- Modify: `docs/local-snapshot.md`
- Remove: `skills/codelphi-snapshot/` after the new package is verified
- Test: `tests/snapshot-skill.test.ts`
- Test: `tests/radar-install-page.test.ts`

**Interfaces:**
- Produces: `dist/codelphi-radar/` with `SKILL.md` and `scripts/snapshot.cjs`; `npm run radar:skill`; `/skills/codelphi-radar` installation page.
- Consumes: Task 3 host workspace protocol and existing standalone bundle.

- [ ] **Step 1: Write failing distribution tests**

Build the bundle into a temporary directory with no source checkout, root `node_modules`, or AI variables. Run prepare, simulate host results, and finalize to Chinese HTML without any host bridge. Keep the existing explicit standalone test. Assert the install page offers local/GitHub usage, bundle download, scope/language instructions, and no fake installer command.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/snapshot-skill.test.ts tests/radar-install-page.test.ts`
Expected: Radar bundle and installation page do not exist.

- [ ] **Step 3: Implement the renamed bundle and installation page**

Write `codelphi-radar/SKILL.md` around prepare → host results → finalize without embedded extraction prompts or host API requirements. Rename build output and npm command, preserve standalone compatibility, and add the installation/download page. Remove old adapter-based package files only after the new tests pass.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/snapshot-skill.test.ts tests/radar-install-page.test.ts`
Expected: all distribution and installation tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add skills/codelphi-radar app/skills/codelphi-radar/page.tsx scripts/build-snapshot-skill.ts package.json docs/local-snapshot.md tests/snapshot-skill.test.ts tests/radar-install-page.test.ts skills/codelphi-snapshot
git commit -m "feat: distribute codelphi radar skill"
```

### Task 5: End-to-end verification and current documentation

**Files:**
- Modify: `docs/local-snapshot.md`
- Modify: `README.md`
- Modify: `AGENTS.md` only if its documented workflow changes

**Interfaces:**
- Consumes: all previous tasks and their final public interfaces.

- [ ] **Step 1: Run focused regression tests**

Run: `npx vitest run tests/extraction-contract.test.ts tests/snapshot-workflow.test.ts tests/snapshot-workspace.test.ts tests/snapshot-skill.test.ts tests/radar-install-page.test.ts tests/analysis-run.test.ts tests/ai.test.ts`
Expected: all focused tests pass, including standalone and carry-forward controls.

- [ ] **Step 2: Run real host-native acceptance**

Use the built `codelphi-radar` package to prepare a small public repository or committed fixture, complete work orders through the current host without a completion adapter, and finalize one HTML. Verify fixed revision, features/scenarios, source evidence, required release fields, and no network dependency in the generated HTML. Do not use the temporary `kimi-code-host-adapter.cjs`.

- [ ] **Step 3: Run full project verification**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run build`
Run: `npm run radar:skill`
Expected: every command exits 0 and the bundle is reproducible.

- [ ] **Step 4: Review workspace and commit documentation**

Update current documentation to distinguish host-native and standalone execution. Run `git diff --check` and `git status --short`; remove only artifacts created by this implementation, preserve unrelated work, then commit documentation with `docs: document codelphi radar`.

- [ ] **Step 5: Perform whole-branch review**

Review the full diff for contract drift, missing-result handling, unsafe output writes, bundle independence, and accidental inclusion of other sessions' files. Any critical or important finding gets a failing test before one fix pass and full verification.
