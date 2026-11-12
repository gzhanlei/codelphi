import { describe, expect, it } from "vitest";
import { describeFeatureFlowEmptyState } from "../lib/feature-flow-view";

describe("feature flow empty-state reason text", () => {
  it("explains chain-less features in plain language", () => {
    const text = describeFeatureFlowEmptyState("MAIN_CHAIN_MISSING");
    expect(text).toContain("没有形成可表达的先后主链");
    expect(text).toContain("「场景」标签");
    expect(text).not.toContain("MAIN_CHAIN_MISSING");
  });

  it("explains overly broad features with split suggestion", () => {
    expect(describeFeatureFlowEmptyState("TOO_MANY_ENTRIES")).toContain("拆分");
  });

  it("explains scale-limit and evidence gaps without leaking codes", () => {
    expect(describeFeatureFlowEmptyState("TOO_MANY_NODES")).toContain("24 个节点");
    expect(describeFeatureFlowEmptyState("RETRY_EVIDENCE_MISSING")).toContain("重试");
    expect(describeFeatureFlowEmptyState("UNKNOWN_SCENARIO_REFERENCE")).toContain("下次分析会自动重试");
  });

  it("falls back to a generic honest explanation for unknown codes", () => {
    expect(describeFeatureFlowEmptyState("SOME_FUTURE_CODE")).toContain("未通过证据校验");
  });

  it("tells users the graph is pending when nothing was attempted", () => {
    expect(describeFeatureFlowEmptyState(null)).toContain("尚未生成");
    expect(describeFeatureFlowEmptyState(undefined)).toContain("尚未生成");
  });
});
