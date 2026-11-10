import { describe, expect, it } from "vitest";
import { describeLedgerOverall, formatLedgerDimensions, summarizeLedgerIssues, toLedgerDetailsView } from "../lib/completeness-ledger-view";

const details = {
  sourceCoverage: { state: "partial" },
  behavioralEnumeration: { state: "complete" },
  extractionCompletion: { state: "complete" },
  evidenceIntegrity: { state: "complete" },
  mergeIntegrity: { state: "partial" },
  verification: { state: "not_applicable" },
  overall: "partial",
} as const;

describe("toLedgerDetailsView", () => {
  it("parses a saved ledger details object", () => {
    expect(toLedgerDetailsView(details)).toMatchObject({ overall: "partial", sourceCoverage: { state: "partial" } });
  });

  it("rejects malformed rows instead of rendering them", () => {
    expect(toLedgerDetailsView(null)).toBeNull();
    expect(toLedgerDetailsView({})).toBeNull();
    expect(toLedgerDetailsView({ ...details, sourceCoverage: { state: "green" } })).toBeNull();
    expect(toLedgerDetailsView({ ...details, overall: "fine" })).toBeNull();
  });
});

describe("describeLedgerOverall", () => {
  it("maps overall to honest labels and tones", () => {
    expect(describeLedgerOverall("complete")).toEqual({ label: "完整分析", tone: "ok" });
    expect(describeLedgerOverall("partial")).toEqual({ label: "部分完整", tone: "warn" });
    expect(describeLedgerOverall("failed")).toEqual({ label: "完整性不足", tone: "bad" });
    expect(describeLedgerOverall("not_applicable")).toEqual({ label: "不适用", tone: "muted" });
  });
});

describe("summarizeLedgerIssues", () => {
  it("lists only partial/failed dimensions with reasons, in canonical order", () => {
    expect(summarizeLedgerIssues(details)).toEqual([
      { label: "源码覆盖", state: "partial", reason: "未覆盖全部实现面，未覆盖部分不产生结论" },
      { label: "合并完整性", state: "partial", reason: "合并层有截断/冲突/护栏检出" },
    ]);
  });

  it("returns empty for a fully green ledger", () => {
    const green = {
      sourceCoverage: { state: "complete" },
      behavioralEnumeration: { state: "complete" },
      extractionCompletion: { state: "complete" },
      evidenceIntegrity: { state: "complete" },
      mergeIntegrity: { state: "complete" },
      verification: { state: "not_applicable" },
      overall: "complete",
    } as const;
    expect(summarizeLedgerIssues(green)).toEqual([]);
  });
});

describe("formatLedgerDimensions", () => {
  it("renders all six dimensions with state markers", () => {
    const text = formatLedgerDimensions(details);
    expect(text).toContain("源码覆盖 部分");
    expect(text).toContain("行为枚举 ✓");
    expect(text).toContain("核验 —");
    expect(text.split("·")).toHaveLength(6);
  });
});
