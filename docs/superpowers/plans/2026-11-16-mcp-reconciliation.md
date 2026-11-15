# CoDelphi MCP Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with TDD.

**Goal:** Add deterministic release reconciliation, canonical/risk read projections, feedback lifecycle reads, scoped release health, and SHA-specific release waiting to CoDelphi MCP.

**Architecture:** Keep persisted records as the only fact source. Pure TypeScript functions compute intent/path matches, limited duplicate evidence, health ratios and verdicts; `lib/mcp/server.ts` only handles organization-scoped queries and response shaping. Raw responses remain compatible; canonical/risk views and pagination are opt-in.

**Tech Stack:** TypeScript, Next.js, MySQL 8, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-mcp-reconciliation-design.md` and the verified facts in `docs/superpowers/specs/2026-11-16-mcp-phase0-data-model.md`.

## Global Constraints

- No LLM, Jaccard, edit distance, or name-only identity upgrade.
- stableKey is name-level only. Unknown scenario identities remain null/unresolved.
- No feedback-to-verification inference: unavailable unless an explicit association exists.
- `pass` covers only supplied intents and readable evidence. Source coverage is disclosure, not a hard veto.
- All counts are organization/product scoped and return numerator, denominator, exclusions and orphan counts.
- Raw MCP responses remain compatible; paginated responses keep `{ release, changes }`.
- MCP writes remain limited to `send_feedback`; regression anchors do not trigger analysis or verification.
- Regression redlines from MCP: preserve raw tools, organization anti-enumeration, evidence links, previous release/read behavior and source-linked projection semantics.

## Review Focus

- stableKey matches must never become identity_proven; direct scenario evidence must not be lost.
- Path-only intent cannot produce pass; missing vs unverified must remain distinct.
- Duplicate claims based only on shared paths must be warnings, not duplicate clusters.
- Product scoping must exclude other products' legacy rows and zero-fact legacy changes from ratio denominators.
- Corrective analysis and verification must stay independent; latest SHA retry must win over older runs.

---

### Task 1: Deterministic reconcile engine

**Files:**
- Create `lib/mcp/reconcile.ts`
- Create `tests/mcp-reconcile.test.ts`

**Interfaces:**
- `reconcileRelease(input: ReconcileReleaseInput): ReconcileReleaseResult`
- `evidencePathsFromSubject(subject: unknown): string[]`

- [ ] Write failing tests for nested feature evidence, direct scenario evidence, stableKey=name_only, path-only=review, partial matches, unexpected, duplicate projection vs shared evidence warning, and verdict priorities.
- [ ] Run `npx vitest run tests/mcp-reconcile.test.ts`; expect missing module failure.
- [ ] Implement deterministic intent matching, duplicate projection detection, duplicate-scenario detection only with in-version proof, and verdict calculation without before/after payloads.
- [ ] Re-run the focused test; expect PASS. Commit.

### Task 2: Canonical, risk, pagination, and MCP wiring

**Files:**
- Create `lib/mcp/projections.ts`
- Create `tests/mcp-projections.test.ts`
- Modify `lib/mcp/server.ts`
- Modify `tests/mcp-server.test.ts`

**Interfaces:**
- `view?: "raw" | "canonical" | "risk"` on get_feature/get_release/lookup_by_files.
- `get_release` accepts optional offset/limit with stable id ordering and compatible `{release,changes}` shape.

- [ ] Write failing tests for canonical exact-row collapse with rawRecordIds and source retention, unresolved identities left intact, risk top-10 stable ordering, uncovered paths, pagination validation, raw compatibility and organization scoping.
- [ ] Run focused tests; expect missing projection behavior.
- [ ] Implement projections and wire all three existing tools plus the new `reconcile_release` tool/schema.
- [ ] Re-run focused tests; expect PASS. Commit.

### Task 3: Feedback, health, waiting, and migration

**Files:**
- Create `lib/mcp/operations.ts`
- Create `tests/mcp-operations.test.ts`
- Create `migrations/076_feedback_regression_keys.sql`
- Modify `lib/mcp/server.ts`
- Modify `tests/mcp-server.test.ts`

**Interfaces:**
- `get_feedback`: correctiveAnalysis and independent verification.
- `get_project_summary.releaseHealth`: scoped counts/ratios/migration/run status.
- `wait_for_release`: exact after_sha, latest attempt, completed/failed/timeout.
- `send_feedback.regressionStableKey`: optional name-level primary anchor.

- [ ] Write failing tests for feedback #14 unavailable verification, corrective analysis status, scoped ratio denominator, orphan counts, latest retry, success+release required, and regression anchor validation.
- [ ] Run focused tests; expect missing operations behavior.
- [ ] Implement operations, migration and MCP schemas/dispatch. No automatic regression or verification.
- [ ] Re-run focused tests; expect PASS. Commit.

### Task 4: Verification, review, deployment, and production reconciliation

**Files:**
- Update `docs/coding-agent-mcp.md` and relevant MCP design notes.

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`; expect PASS.
- [ ] Run fresh whole-branch review and fix Critical/Important findings with RED→GREEN tests.
- [ ] Apply migration 076 through the existing deployment path and deploy the new image with smoke checks.
- [ ] Production-verify `reconcile_release`, `get_feedback(14)`, `wait_for_release`, canonical/risk views, pagination and `releaseHealth`.
- [ ] CoDelphi `list_releases`/`get_release` reconciliation for the new SHA; report any unplanned behavior or unavailable semantics honestly.
