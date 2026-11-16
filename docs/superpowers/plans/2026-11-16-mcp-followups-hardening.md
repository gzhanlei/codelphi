# MCP Follow-up Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with TDD.

**Goal:** Complete all deferred MCP compatibility and correctness items without changing raw behavior or inventing identities.

**Architecture:** Small deterministic fixes in existing pure functions and MCP dispatch. No new persistence, AI, or semantic merge rules.

**Spec:** `docs/superpowers/specs/2026-11-15-mcp-reconciliation-design.md`, `docs/superpowers/specs/2026-11-16-mcp-phase0-data-model.md`, and the deferred review findings.

## Global Constraints

- stableKey remains name-level only; unknown identities remain unresolved.
- Raw responses, organization anti-enumeration and eligible-health denominators stay unchanged.
- `pass` remains scoped to supplied intents and readable evidence.
- verification remains unavailable without explicit feedback linkage.

### Task 1: Runtime semantics and compatibility

- Short SHA uses deterministic repository/product-scoped prefix matching; ambiguous prefixes return review, not completed.
- Timeout preserves a persisted releaseId; missing corrective run returns unknown.
- Parameter errors map to INVALID_PARAMS; totalChangeCount is explicit about eligible scope.
- Canonical get_release supports the same offset/limit contract as raw.
- Legacy get_release_notes includes direct scenario evidence.
- Add tests first for each behavior and run focused suites plus typecheck/build/full tests; commit.

### Task 2: Projection semantics, scope, and test hardening

- Add identity scope to canonical identityStatus without breaking existing response compatibility: retain `identityStatus` and add `identityScope` (`live`, specVersionId, or release SHA).
- Replace pipe-delimited canonical keys with collision-safe tuple serialization; add a feature name containing `|`.
- Keep risk/canonical semantics explicit: raw scenario records, canonical groups and source IDs are not conflated.
- Add SQL ordering and mock alias coverage for latest-run selection and paginated changes.
- Update affected documentation and tests; commit.

### Task 3: Verification, deployment, and reconciliation

- Run full tests/typecheck/build and independent review; fix Critical/Important issues with TDD.
- Deploy the production image and verify short/full SHA waiting, canonical pagination, legacy notes evidence and releaseHealth.
- CoDelphi list_releases/get_release reconciliation for the new SHA, then report remaining evidence limits.
