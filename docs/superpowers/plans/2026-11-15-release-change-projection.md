# Release Change Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate AI release-change entries by deriving one persisted display projection per canonical feature from `spec_changes`, with stable source links and post-commit AI copy rewriting.

**Architecture:** Partition extraction remains responsible for features/scenarios and internal reviewed audit candidates, not final release changelogs. `insertSpecVersion` returns persisted canonical changes; release persistence groups them by canonical `feature_key`, inserts one `changes` row per group plus `change_sources`, and AI rewrites only the persisted row after commit. Fuzzy text equality is removed from merge/persistence decisions.

**Tech Stack:** TypeScript, Next.js, MySQL 8, Vitest, Zod.

**Spec:** `docs/specsight-gap-improvement-plan.md` BM-11 and the user-approved root-cause design in this session. This plan supersedes BM-11's fuzzy `changes` merge approach while preserving feature/scenario folding.

## Global Constraints

- Use the existing Tencent Cloud MySQL 8; no new database or dependency.
- Every generated fact retains traceable code evidence; manual features/scenarios are never overwritten.
- Preserve previous-spec anchoring, full-rebuild diff behavior, feature/scenario folding, coverage receipts, and merge-integrity reporting.
- Regression redlines from CoDelphi MCP: `AI 规格分析与发布变化` HP-1/HP-3/HP-5/HP-6/EC-1 and `分析覆盖披露与完整性账本` HP-1/HP-2/EC-1.
- Post-push reconciliation anchors: `ai 规格分析与发布变化`, `变化条目变体去重与存量清理`, `分析覆盖披露与完整性账本`.
- Do not run production deployment, DNS, webhook, Docker, or historical production data mutation.

## Review Focus

- Mixed added/removed facts in one feature must retain every source fact without producing an added/removed contradiction.
- AI rewrite failure or malformed output must leave the deterministic persisted projection intact.
- Retrying an existing release must not duplicate or overwrite its current change rows.
- A feature with no user-facing spec delta but internal reviewed candidates must retain the audit trail outside user-facing `changes`.
- Large evidence sets must be deduplicated deterministically without exceeding the existing five-evidence-item contract.

---

### Task 1: Canonical projection and AI rewrite contract

**Files:**
- Create: `lib/release-change-projection.ts`
- Create: `tests/release-change-projection.test.ts`

**Interfaces:**
- Produces: `ReleaseChangeFact`, `ReleaseChangeProjection`, `buildReleaseChangeProjections(facts)`, `rewriteReleaseChangeProjections(execute, deps, projections, language)`.
- A projection owns one canonical feature and stable `sourceSpecChangeIds`; AI receives facts but cannot change grouping or source links.

- [ ] Write failing tests using the real release-229 wording variants: multiple canonical facts in one feature produce one projection with all source IDs and unioned evidence; another feature remains independent; mixed kinds preserve all summaries; malformed AI output leaves fallback text unchanged.
- [ ] Run `npx vitest run tests/release-change-projection.test.ts`; expect missing-module failure.
- [ ] Implement deterministic grouping, evidence union, fallback copy, a one-call-per-feature rewrite prompt/parser, and per-row update only after valid output.
- [ ] Re-run the focused test; expect PASS.
- [ ] Commit the focused projection contract.

### Task 2: Persist canonical changes and source links

**Files:**
- Create: `migrations/074_release_change_sources.sql`
- Modify: `lib/spec-versions.ts`
- Modify: `lib/analysis.ts`
- Test: `tests/spec-versions.test.ts`, `tests/analysis-persistence.test.ts`, `tests/analysis-run.test.ts`

**Interfaces:**
- Consumes: Task 1 projection types/builder.
- Produces: `insertSpecVersion` additionally returns persisted `specChanges` with database IDs and a baseline marker; `upsertRelease` persists projections and `change_sources`, returning projection IDs for post-commit rewrite. A first baseline derives added projections from canonical features without fabricating `spec_changes`.

- [ ] Add failing persistence tests proving one row per canonical feature, one source link per `spec_change_id`, idempotent retry behavior, and reviewed candidates excluded from user-facing `changes`.
- [ ] Run focused tests; expect failures because source persistence is absent.
- [ ] Add the MySQL migration, return inserted spec-change IDs, replace free-text release insertion with canonical projections, and retain reviewed candidates in a separate audit table.
- [ ] Re-run focused tests; expect PASS.
- [ ] Commit the persistence change.

### Task 3: Remove partition changelog generation and fuzzy merge decisions

**Files:**
- Modify: `lib/ai.ts`, `lib/extraction-merge.ts`, `lib/analysis.ts`, `scripts/dedupe-release-changes.ts`
- Test: `tests/ai-prompt-language.test.ts`, `tests/extraction-merge.test.ts`, `tests/dedupe-release-changes.test.ts`, `tests/bm11-feature-variant-fold.test.ts`

**Interfaces:**
- Consumes: Task 2 persistence and Task 1 post-commit rewriter.
- Partition `changes` may contain only `kind=reviewed` audit candidates; user-facing rows come exclusively from Task 2.

- [ ] Write failing tests proving partition instructions forbid final changelogs, merge performs no description-similarity decisions, release 229 variants cannot multiply user-facing rows, and legacy `--apply` is refused.
- [ ] Run focused tests; expect failures on the old behavior.
- [ ] Update prompts and merge logic, wire post-commit AI rewriting with fallback, and disable destructive fuzzy cleanup while retaining dry-run diagnostics.
- [ ] Re-run focused tests; expect PASS.
- [ ] Update BM-11 documentation to describe canonical projection instead of fuzzy release-changelog folding.
- [ ] Commit the pipeline change.

### Task 4: Full verification, review, push, and CoDelphi reconciliation

**Files:**
- Verify all changed files and generated artifacts.

- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`; expect all PASS.
- [ ] Inspect `git status` and remove only artifacts created by this implementation's verification runs.
- [ ] Run a fresh whole-branch review; fix Critical/Important findings with RED→GREEN tests.
- [ ] Integrate and push the verified commit so CoDelphi analyzes the SHA.
- [ ] Call `list_releases`, then `get_release` for the pushed SHA; verify changes are limited to canonical release projection, reviewed-audit separation, and removal of fuzzy changelog folding. Investigate and report any unplanned delta.
