# Release Projection Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with TDD.

**Goal:** Harden canonical release projections, expose reviewed audit data, rebuild legacy releases safely, and deploy/reconcile the complete solution.

**Architecture:** Keep `spec_changes` as the only behavioral delta source. Add bounded best-effort AI rewriting, a deterministic transactional rebuild/backup/restore path, and server-rendered reviewed audit read models. Production changes use the existing Docker migration/deploy pipeline; destructive legacy writes require a reviewed dry-run and backup first.

**Tech Stack:** TypeScript, Next.js App Router, MySQL 8, Vitest, Docker.

**Spec:** `docs/specsight-gap-improvement-plan.md` BM-12 plus the user's explicit request to deploy, rewrite old releases, and complete all deferred items.

## Global Constraints

- Preserve canonical projection/source-link invariants and all prior regression redlines from `lookup_by_files`.
- No fuzzy text comparison in rebuild/delete decisions.
- Every production legacy rewrite is preceded by a dry-run and a restorable backup; transactions roll back on error.
- Do not mutate manual features/scenarios. Use the existing Tencent Cloud MySQL 8 and Docker deployment path, explicitly authorized by the user.
- New reviewed API/UI has no current ledger evidence coverage; verify against existing route/access patterns and component tests.
- Post-push reconciliation anchors: `ai 规格分析与发布变化`, `发布变化规范投影与来源关联`, `发布变化存量去重脚本`, `发布变化来源关联与审计存储`.

### Task 1: Projection hardening

- Modify `lib/release-change-projection.ts`, `lib/analysis.ts`, `tests/release-change-projection.test.ts`, `tests/analysis-run.test.ts`, `tests/ai-prompt-language.test.ts`.
- RED→GREEN: sentence-boundary fallback truncation; empty fallback `userImpact`; bounded AI rewrite count with deterministic skips; outer post-commit failure guard; rename the outdated prompt test.
- Keep source IDs and grouping immutable. Verify focused tests, typecheck, full suite, and build; commit.

### Task 2: Reviewed audit read model

- Create `app/api/products/[slug]/releases/[id]/reviewed/route.ts` and tests.
- Modify `lib/product-details.ts`, `lib/release-client.ts`, `components/product-changes.tsx`, `components/release-card.tsx`, and relevant tests/localized strings.
- RED→GREEN: member/demo-consistent read access, invalid release 404, server-loaded reviewed items rendered as `kind=reviewed`, pagination preserves them.
- Verify focused tests, typecheck, full suite, and build; commit.

### Task 3: Transactional legacy rebuild, backup, and restore

- Create `migrations/075_release_change_projection_backups.sql`, `scripts/rebuild-release-change-projections.ts`, and tests.
- Dry-run lists each eligible legacy release, old/new row counts, and source counts; already source-linked releases skip by default. Zero-fact releases never wipe existing rows.
- Apply locks one release, writes a complete JSON backup, deletes/reinserts only that release's projections and source links in one transaction, and emits a backup ID. Restore reinstates exact legacy rows and sources.
- RED→GREEN planner/executor tests cover skip, backup, rollback, restore, and release 229 variants. Verify full checks; commit.

### Task 4: Review and integration

- Run fresh whole-branch review and fix Critical/Important findings with TDD.
- Run `npm run typecheck`, `npm test`, `npm run build`; inspect generated files and repository status.
- Fast-forward main and push; commit only intended files.

### Task 5: Production deploy and data reconciliation

- Build and transfer the production Docker image using the documented existing channel; run the authorized `deploy.sh` migration/smoke path.
- Run the rebuild dry-run, inspect every proposal, then apply with backups. Merge feedback #14's three duplicate features using the existing guarded planner after reviewing its dry-run.
- Verify production UI/API and run CoDelphi `list_releases`/`get_release` reconciliation for the new SHA; investigate any unplanned behavior delta.
