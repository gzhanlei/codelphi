import { describe, expect, it } from "vitest";
import { buildAnswerSynthesisPrompt, buildFeatureSelectPrompt, matchFeaturesByNameGrams } from "../lib/spec-ask";

describe("bilingual spec ask prompts (EN output mode)", () => {
  it("renders synthesis and feature-select prompts in English", () => {
    const synthesis = buildAnswerSynthesisPrompt({ question: "how big?", specVersionId: 3, features: [], scenarios: [] }, "en");
    expect(synthesis).toContain("Write in English");
    expect(synthesis).toContain("answerable:false");

    const select = buildFeatureSelectPrompt({ question: "q", productName: "Radar", catalog: [{ id: 1, name: "Login", summary: "s" }] }, "en");
    expect(select).toContain("asking about the product \"Radar\"");
    expect(select).toContain("[Feature catalog]");
  });

  it("keeps the zh prompts byte-identical", () => {
    const synthesis = buildAnswerSynthesisPrompt({ question: "多大？", specVersionId: 3, features: [], scenarios: [] }, "zh-CN");
    expect(synthesis).toContain("基于下面的产品规格条目回答用户问题。用简体中文。");
    const select = buildFeatureSelectPrompt({ question: "多大？", productName: "雷达", catalog: [] }, "zh-CN");
    expect(select).toContain("用户正在询问产品「雷达」");
  });

  it("matches English feature names by word tokens in the lexical fallback", () => {
    expect(matchFeaturesByNameGrams("how large can the repository be", [{ id: 1, name: "Repository size limits", summary: "" }])).toHaveLength(1);
    expect(matchFeaturesByNameGrams("tell me about export formats", [{ id: 1, name: "Login", summary: "" }])).toHaveLength(0);
  });
});
