import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { applyVerification, loadLatestVerificationSpec } from "../lib/spec-verification";
import { verificationLabels, verificationMatches, verificationState } from "../lib/spec-editor-ui";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../components/demo-mode", () => ({ useDemoGuard: () => () => false }));
vi.mock("./demo-mode", () => ({ useDemoGuard: () => () => false }));

import { ScenarioCard } from "../components/scenario-card";

const execute = vi.fn();

describe("verification state derivation (no status column)", () => {
  it("derives unverified / verified / stale-verified from verified_at × stale_since", () => {
    expect(verificationState({ verifiedAt: null, staleSince: null })).toBe("unverified");
    expect(verificationState({ verifiedAt: new Date(), staleSince: null })).toBe("verified");
    expect(verificationState({ verifiedAt: new Date(), staleSince: new Date() })).toBe("stale-verified");
    expect(verificationLabels["stale-verified"]).toBe("待重新核实");
  });

  it("filters scenarios by verification state", () => {
    const verified = { verifiedAt: new Date(), staleSince: null };
    expect(verificationMatches(verified, "all")).toBe(true);
    expect(verificationMatches(verified, "verified")).toBe(true);
    expect(verificationMatches(verified, "unverified")).toBe(false);
    expect(verificationMatches({ verifiedAt: null, staleSince: null }, "stale-verified")).toBe(false);
  });
});

describe("applyVerification", () => {
  it("scope-checks the row, clears drift and appends a dual-version history record", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await applyVerification(
      { execute },
      { productId: 3, entityType: "scenario", entityId: 88, verifiedBy: "pm@example.com" },
      { specVersionId: 44, sha: "abc1234def" },
    );
    const [updateSql, updateParams] = execute.mock.calls[0];
    expect(updateSql).toContain("UPDATE scenarios s JOIN features f");
    expect(updateSql).toContain("s.stale_since = NULL");
    expect(updateParams).toEqual(["pm@example.com", 88, 3]);
    const [insertSql, insertParams] = execute.mock.calls[1];
    expect(insertSql).toContain("INSERT INTO spec_verifications");
    expect(insertParams).toEqual([3, "scenario", 88, 44, "abc1234def", "pm@example.com"]);
  });

  it("rejects rows outside the product or already deleted", async () => {
    execute.mockClear();
    execute.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(applyVerification(
      { execute },
      { productId: 3, entityType: "feature", entityId: 9, verifiedBy: "pm@example.com" },
      { specVersionId: 44, sha: "abc" },
    )).rejects.toThrow("spec_entity_invalid");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("loadLatestVerificationSpec", () => {
  it("binds verification to the product's newest spec snapshot and its commit", async () => {
    execute.mockResolvedValue([[{ specVersionId: 71, sha: "7fa4230abc" }]]);
    expect(await loadLatestVerificationSpec(3, execute)).toEqual({ specVersionId: 71, sha: "7fa4230abc" });
  });

  it("reports missing snapshots so the action can refuse instead of verifying against nothing", async () => {
    execute.mockResolvedValue([[]]);
    expect(await loadLatestVerificationSpec(3, execute)).toBeNull();
  });
});

describe("scenario card verification badge", () => {
  const base = { id: 8, featureId: 5, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" as const, source: "manual" as const, evidence: [] };

  it("renders the derived state and the re-verify action", () => {
    const html = renderToStaticMarkup(createElement(ScenarioCard, {
      slug: "codelphi",
      scenario: { ...base, verifiedAt: new Date("2026-11-08T00:00:00Z"), verifiedBy: "pm@example.com", staleSince: new Date() },
      onEdit: () => {},
      onDelete: () => {},
    }));
    expect(html).toContain("待重新核实");
    expect(html).toContain("重新核实");
  });

  it("renders unverified items with a verify action", () => {
    const html = renderToStaticMarkup(createElement(ScenarioCard, { slug: "codelphi", scenario: base, onEdit: () => {}, onDelete: () => {} }));
    expect(html).toContain("未核实");
    expect(html).toContain("标记已核实");
  });
});
