import { describe, expect, it } from "vitest";
import { deliverySummary, visualSummary } from "../lib/archify-receipt";

describe("Archify receipt summaries", () => {
  it("keeps delivery hashes, validation and evidence", () => {
    const receipt = { ok: true, specification: { sha256: "spec", bytes: 10 }, artifact: { sha256: "html", bytes: 20 }, validation: { checksPassed: 9 }, evidence: { verified: true, references: 3 } };
    const { ok: _ok, ...summary } = receipt;
    expect(deliverySummary(receipt)).toEqual(summary);
  });

  it("summarizes visual acceptance and tolerates missing fields", () => {
    expect(visualSummary({ ok: true, visualReview: "pending", containment: { status: "pass" }, captures: { contactSheet: "sheet.html" } })).toEqual({ visualReview: "pending", containment: "pass", contactSheet: "sheet.html" });
    expect(visualSummary({ ok: true })).toEqual({ visualReview: undefined, containment: undefined, contactSheet: undefined });
  });
});
