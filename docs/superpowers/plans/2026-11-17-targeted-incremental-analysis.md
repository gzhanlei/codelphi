# Targeted Incremental Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make incremental analysis read only diff and affected evidence files, and let every analysis run use as many partitions as its actual scope requires.

**Architecture:** Add a required-only discovery mode to the existing slice planner, resolve affected evidence through `spec_file_index`, and use the same scoped paths for planning and coverage receipts. Full analysis retains BFS discovery; all multi-partition entry points stop only when no new readable candidates remain.

**Tech Stack:** TypeScript, Next.js 16, React 19, Vitest, MySQL 8, existing remote source index and slice planner.

**Spec:** `docs/superpowers/specs/2026-11-17-targeted-incremental-analysis-design.md`

## Global Constraints

- Incremental `requiredPaths = change.files ∪ affected-feature evidence paths`; unrelated files must not enter AI.
- Full-analysis fallbacks retain the existing BFS behavior.
- Do not impose a run-level partition count, tree expansion count, blob fetch count, or total content byte cap on the main analysis path.
- Preserve per-partition and per-file technical limits, real per-call billing, evidence validation, carry-forward, and manual entries.
- New receipts keep `partitionsCapped` only for historical compatibility and always write `false`.
- Preserve unrelated modified and untracked files already present in the workspace; stage only files owned by each task.
- Do not rerun or rewrite production run 342 or historical receipts.

## Review Focus

- Deleted or missing required paths must be skipped without causing a non-progressing partition loop; pin in Task 3.
- Paths appearing in both diff and affected evidence must be read only once; pin in Tasks 1 and 4.
- More than six partitions must make progress with no omitted candidates and `partitionsCapped=false`; pin in Task 3.
- Missing previous specs or zero affected features must still trigger full BFS; pin in Task 4.
- Scoped coverage must exclude missing and non-implementation paths and must not enumerate the whole tree; pin in Task 4.
- Manual scenarios and unaffected generated features must survive incremental re-extraction; pin in Task 4.

---

### Task 1: Required-only slice planning

**Files:**
- Modify: `lib/slice-planner/types.ts:40-47`
- Modify: `lib/slice-planner/index.ts:261-279`
- Test: `tests/slice-planner-selection.test.ts`

**Interfaces:**
- Produces: `SlicePlanInput.discovery?: "full" | "required_only"` and `SlicePlanInput.requiredPaths?: readonly string[]`.
- Consumes: existing `diffPaths`, `excludePaths`, `SlicePlanner.plan`, and remote source index fixtures.

- [ ] **Step 1: Write failing planner tests**

Add tests proving that `discovery: "required_only"` selects only `requiredPaths ?? diffPaths`, does not call `listDir` for BFS, includes unchanged required evidence, and deduplicates paths shared with diff. Add a control proving default `discovery: "full"` still walks scope directories.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/slice-planner-selection.test.ts`
Expected: new required-only test fails because unrelated BFS files are still selected.

- [ ] **Step 3: Implement planner inputs and branch**

Default `discovery` to `full`. Select `requiredPaths ?? diffPaths` first; invoke `walkScopeDirectories` only for `full`. Keep existing exclusions, path ordering, and per-partition budgets unchanged.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/slice-planner-selection.test.ts`
Expected: all planner selection tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/slice-planner/types.ts lib/slice-planner/index.ts tests/slice-planner-selection.test.ts
git commit -m "feat: add required-only source discovery"
```

### Task 2: Load affected evidence paths

**Files:**
- Modify: `lib/spec-file-index.ts:45-67`
- Test: `tests/spec-file-index.test.ts`

**Interfaces:**
- Produces: `loadAffectedEvidencePaths(repositoryId: number, affectedKeys: ReadonlySet<string>, execute?: Execute): Promise<string[]>`.
- Consumes: current `spec_file_index`, `spec_features.stable_key`, and affected keys from `loadAffectedFeatureKeys`.

- [ ] **Step 1: Write failing query tests**

Test two affected keys with duplicate evidence rows: returned paths are unique and lexicographically sorted. Test an empty key set returns `[]` without executing SQL.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/spec-file-index.test.ts`
Expected: failure because `loadAffectedEvidencePaths` is not exported.

- [ ] **Step 3: Implement the query**

Join `spec_file_index` to `spec_features`, filter repository and stable keys, select distinct paths ordered by path, and return `string[]` without changing affected-key resolution.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/spec-file-index.test.ts`
Expected: all spec file index tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/spec-file-index.ts tests/spec-file-index.test.ts
git commit -m "feat: load affected feature evidence paths"
```

### Task 3: Remove partition and aggregate read caps

**Files:**
- Modify: `lib/remote-analysis.ts:32-49,120-179`
- Modify: `lib/analysis-coverage.ts:39-46,73-117`
- Modify: `lib/analysis.ts:420-430`
- Modify: `lib/snapshot/analyze.ts`
- Modify: `scripts/measure-first-analysis.ts`
- Modify: `lib/env.ts:47-51`
- Test: `tests/remote-analysis.test.ts`
- Test: `tests/analysis-coverage.test.ts`
- Test: `tests/analysis-run.test.ts`
- Test: `tests/snapshot-analyze.test.ts`

**Interfaces:**
- Produces: `getPartitionedAnalysisSources(request, runtime)` with no numeric partition cap; `computeCoverageReceipt(input)` without `maxPartitions`.
- Consumes: Task 1 planner inputs and existing single-window consumers.
- Compatibility: `AnalysisCoverageReceipt.partitionsCapped` remains present and is always `false` for new receipts.

- [ ] **Step 1: Write failing unlimited-partition tests**

Add a fake planner that returns seven non-empty, non-overlapping partitions and then an empty slice. Assert all seven are returned and the eighth plan call establishes exhaustion. Assert `getRemoteAnalysisSources` still returns one partition. Assert a receipt with seven partitions has `partitionsCapped=false`. Remove the obsolete cap-reached test and snapshot cap warning expectation.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/remote-analysis.test.ts tests/analysis-coverage.test.ts tests/analysis-run.test.ts tests/snapshot-analyze.test.ts`
Expected: main path stops at six partitions or new API signatures are missing.

- [ ] **Step 3: Implement unbounded planning and receipt updates**

Use a single-window boolean only for `getRemoteAnalysisSources`; the main partition loop continues until no new readable candidates. Set main analysis aggregate index budgets to `Number.POSITIVE_INFINITY`, remove the default 1000-directory enumeration cap, delete `analysisMaxPartitions`, and update all production and test call sites. New receipts always set `partitionsCapped: false`; remove snapshot partition-limit warnings and options.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/remote-analysis.test.ts tests/analysis-coverage.test.ts tests/analysis-run.test.ts tests/snapshot-analyze.test.ts`
Expected: all targeted tests pass, including seven-partition cases and single-window compatibility.

- [ ] **Step 5: Commit Task 3**

```bash
git add lib/remote-analysis.ts lib/analysis-coverage.ts lib/analysis.ts lib/snapshot/analyze.ts scripts/measure-first-analysis.ts lib/env.ts tests/remote-analysis.test.ts tests/analysis-coverage.test.ts tests/analysis-run.test.ts tests/snapshot-analyze.test.ts
git commit -m "feat: remove analysis partition limits"
```

### Task 4: Integrate targeted incremental analysis and scoped receipts

**Files:**
- Modify: `lib/analysis.ts:323-350,420-430`
- Modify: `lib/analysis-coverage.ts`
- Test: `tests/analysis-run.test.ts`
- Test: `tests/analysis-coverage.test.ts`

**Interfaces:**
- Consumes: Task 1 `discovery/requiredPaths`, Task 2 `loadAffectedEvidencePaths`, Task 3 unbounded planning.
- Produces: `enumerateRequiredImplementationSurface(index, paths): Promise<Array<{ path: string; size: number }>>` for scoped receipts.

- [ ] **Step 1: Write failing integration tests**

For an incremental run with three diff paths and two affected evidence paths, assert the partitioned request has `discovery: "required_only"`, exactly those five unique `requiredPaths`, and the real three `diffPaths`. Assert unrelated files are absent, unchanged related evidence is present, and full-tree implementation enumeration is not called. Add a control proving `affectedKeys=null` retains full discovery. Keep existing carry-forward and manual-entry tests as required regression controls.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/analysis-run.test.ts tests/analysis-coverage.test.ts`
Expected: incremental request still performs full discovery and whole-tree coverage enumeration.

- [ ] **Step 3: Implement scoped request and coverage surface**

Load affected evidence only when `affectedKeys !== null`; pass sorted unique required paths to the planner. For incremental receipts, stat only required paths, skip missing and non-implementation entries, and avoid `enumerateImplementationSurface`. Full receipts retain whole-tree enumeration. Keep real diff coverage separate from the required-path union.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/analysis-run.test.ts tests/analysis-coverage.test.ts`
Expected: targeted integration, scoped coverage, full fallback, and carry-forward tests pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add lib/analysis.ts lib/analysis-coverage.ts tests/analysis-run.test.ts tests/analysis-coverage.test.ts
git commit -m "fix: scope incremental analysis to related code"
```

### Task 5: Remove internal assembly metrics from user views

**Files:**
- Modify: `components/product-overview.tsx:74-102`
- Modify: `components/spec-workspace.tsx:53-78`
- Modify: `lib/product-overview.ts`
- Modify: `lib/ui-strings/product.ts`
- Modify: `lib/coverage-display.ts`
- Modify: `app/globals.css`
- Test: `tests/product-overview-component.test.ts`
- Test: `tests/spec-workspace-coverage.test.ts`

**Interfaces:**
- Consumes: existing overview and workspace props; no API or receipt schema change.

- [ ] **Step 1: Write failing rendering assertions**

Assert no `overview-trust-line`, no `coverage-disclosure`, no assembly percentage/file count/partition wording, and no missing-receipt message. Assert the static-analysis boundary link and its manual-completion guidance remain in the spec workspace.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/product-overview-component.test.ts tests/spec-workspace-coverage.test.ts`
Expected: current metric elements are still rendered.

- [ ] **Step 3: Remove metric presentation and dead formatting paths**

Remove `TrustLine`, overview coverage projections, the coverage disclosure wrapper, and now-unused strings/helpers/styles. Preserve the completeness disclosure and move the existing static-boundary content into a standalone paragraph without coverage metrics.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/product-overview-component.test.ts tests/spec-workspace-coverage.test.ts tests/coverage-display.test.ts`
Expected: all rendering and remaining formatting tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add components/product-overview.tsx components/spec-workspace.tsx lib/product-overview.ts lib/ui-strings/product.ts lib/coverage-display.ts app/globals.css tests/product-overview-component.test.ts tests/spec-workspace-coverage.test.ts tests/coverage-display.test.ts
git commit -m "fix: hide internal assembly metrics"
```

### Task 6: Align current documentation and verify the deliverable

**Files:**
- Modify: `docs/analysis-pipeline.md`
- Modify: `docs/superpowers/specs/2026-11-17-targeted-incremental-analysis-design.md` only if implementation reveals a documented mismatch
- Modify: `AGENTS.md` only if a documented workflow changes

**Interfaces:**
- Consumes: all preceding tasks and their actual final interfaces.

- [ ] **Step 1: Update current behavior documentation**

Describe required-only incremental scope, unlimited partition counts, retained per-partition limits, scoped receipts, and removed user-facing assembly metrics. Remove `ANALYSIS_MAX_PARTITIONS` from current configuration tables; leave historical benchmark reports as historical records.

- [ ] **Step 2: Run focused regression tests**

Run: `npx vitest run tests/slice-planner-selection.test.ts tests/spec-file-index.test.ts tests/remote-analysis.test.ts tests/analysis-coverage.test.ts tests/analysis-run.test.ts tests/snapshot-analyze.test.ts tests/product-overview-component.test.ts tests/spec-workspace-coverage.test.ts`
Expected: all focused tests pass with no unexpected old-cap assertions.

- [ ] **Step 3: Run full project verification**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run build`
Expected: all commands exit 0; report any unrelated failure by exact file and error rather than hiding it.

- [ ] **Step 4: Review final diff and workspace artifacts**

Run: `git diff --check` and `git status --short`.
Expected: no whitespace errors; generated test artifacts are removed only when created by this implementation, and unrelated workspace changes remain untouched.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/analysis-pipeline.md
git commit -m "docs: align analysis pipeline with targeted increments"
```
