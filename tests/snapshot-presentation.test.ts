import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import type { StructuredCompletionMessage } from "../lib/llm-client";
import { createSnapshotPresentation, fallbackSnapshotPresentation } from "../lib/snapshot/presentation";

const result: AnalysisResult = {
  product: { description: "A product for casual users", evidence: [{ path: "src/index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [
    { name: "Interactive map", summary: "Explore historical borders on a map", scenarios: [{ reference: "HP-1", context: "A visitor", action: "Moves the timeline", outcome: "Sees borders for that year", category: "happy", evidence: [{ path: "src/map.ts", startLine: 1 }] }] },
    { name: "Place search", summary: "Find places by historical names", scenarios: [{ reference: "HP-1", context: "A reader", action: "Searches an ancient name", outcome: "Flies to its location", category: "happy", evidence: [{ path: "src/search.ts", startLine: 1 }] }] },
    { name: "Voice guide", summary: "Hear explanations while playing", scenarios: [{ reference: "HP-1", context: "A learner", action: "Starts playback", outcome: "Hears the story", category: "happy", evidence: [{ path: "src/voice.ts", startLine: 1 }] }] },
    { name: "Deployment", summary: "Container configuration", scenarios: [{ reference: "HP-1", context: "An operator", action: "Builds an image", outcome: "Runs statically", category: "happy", evidence: [{ path: "Dockerfile", startLine: 1 }] }] },
  ],
};

describe("snapshot presentation", () => {
  it("groups existing features into evidence-linked core capabilities without adding facts", async () => {
    const complete = vi.fn(async (_messages: StructuredCompletionMessage[]) => JSON.stringify({ tagline: "Explore history on a map.", coreCapabilities: [
      { name: "Explore history visually", summary: "Move through time and place on one map.", featureNames: ["Interactive map", "Place search"], scenarioRefs: [{ featureName: "Interactive map", reference: "HP-1" }, { featureName: "Place search", reference: "HP-1" }] },
      { name: "Learn with guidance", summary: "Listen while history unfolds.", featureNames: ["Voice guide"], scenarioRefs: [{ featureName: "Voice guide", reference: "HP-1" }] },
      { name: "Technical foundation", summary: "Deployment details for reference.", featureNames: ["Deployment"], scenarioRefs: [{ featureName: "Deployment", reference: "HP-1" }] },
    ], journeys: [
      { name: "Explore a place with narration", steps: [{ featureName: "Interactive map", reference: "HP-1" }, { featureName: "Voice guide", reference: "HP-1" }] },
    ], concepts: [
      { name: "Place", summary: "A location the reader can find by its historical name.", scenarioRefs: [{ featureName: "Place search", reference: "HP-1" }], relations: [{ targetName: "Voice guide", summary: "Narrates the place being explored", scenarioRef: { featureName: "Voice guide", reference: "HP-1" } }] },
      { name: "Voice guide", summary: "The narration that accompanies exploration.", scenarioRefs: [{ featureName: "Voice guide", reference: "HP-1" }], relations: [] },
    ] }));
    const presentation = await createSnapshotPresentation({ result, language: "en", client: { complete } });
    expect(presentation.status).toBe("generated");
    expect(presentation.coreCapabilities).toHaveLength(3);
    expect(presentation.coreCapabilities[0].featureNames).toEqual(["Interactive map", "Place search"]);
    expect(presentation.coreCapabilities[0].scenarioRefs).toHaveLength(2);
    expect(presentation.journeys[0].steps.map((step) => step.featureName)).toEqual(["Interactive map", "Voice guide"]);
    expect(presentation.concepts[0].relations[0].targetName).toBe("Voice guide");
    const messages = complete.mock.calls[0]![0];
    expect(messages[1].content).toContain("Do not add facts");
  });

  it("splits large repositories into compact domain grouping and journey synthesis", async () => {
    const many = structuredClone(result);
    many.features = Array.from({ length: 45 }, (_, index) => ({ name: `Feature ${index + 1}`, summary: `Summary ${index + 1}`, scenarios: result.features[0].scenarios }));
    const complete = vi.fn(async (messages: StructuredCompletionMessage[]) => {
      if (messages[1].content.includes("Domain plan")) {
        return JSON.stringify({ tagline: "A large product", domains: [{ name: "All capabilities", summary: "Everything" }] });
      }
      if (messages[1].content.includes("Feature assignment batch")) {
        return JSON.stringify({ assignments: many.features.map((feature) => ({ featureName: feature.name, domainName: "All capabilities" })) });
      }
      return JSON.stringify({ journeys: [{ name: "Complete a cross-module task", steps: [{ featureName: "Feature 1", reference: "HP-1" }, { featureName: "Feature 2", reference: "HP-1" }] }], concepts: [] });
    });
    const presentation = await createSnapshotPresentation({ result: many, language: "en", client: { complete } });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(presentation.journeys[0].name).toBe("Complete a cross-module task");
    expect(presentation.journeys[0].evidenceStatus).toBe("scenario_composition");
    const planPrompt = complete.mock.calls[0][0][1].content;
    const detailPrompt = complete.mock.calls[2][0][1].content;
    expect(planPrompt).not.toContain('"scenarios"');
    expect(detailPrompt).toContain("Feature 1");
    expect(detailPrompt).toContain("Feature 38");
    expect(detailPrompt).toContain("product-level goals");
    expect(detailPrompt).toContain("provider-specific");
  });

  it("caps excess concept citations without discarding the concept or project map", async () => {
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Explore history", coreCapabilities: [
      { name: "Explore", summary: "Explore", featureNames: ["Interactive map", "Place search"], scenarioRefs: [] },
      { name: "Listen", summary: "Listen", featureNames: ["Voice guide"], scenarioRefs: [] },
      { name: "Operate", summary: "Operate", featureNames: ["Deployment"], scenarioRefs: [] },
    ], journeys: [], concepts: [{ name: "Place", summary: "A historical place", scenarioRefs: [
      { featureName: "Place search", reference: "HP-1" },
      { featureName: "Place search", reference: "HP-1" },
      { featureName: "Place search", reference: "HP-1" },
      { featureName: "Place search", reference: "HP-1" },
    ], relations: [] }] }));
    const presentation = await createSnapshotPresentation({ result, language: "en", client: { complete } });
    expect(presentation.concepts[0].scenarioRefs).toHaveLength(3);
    expect(presentation.coreCapabilities.flatMap((capability) => capability.featureNames)).toHaveLength(4);
  });

  it("rejects unknown feature or scenario references", async () => {
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Invalid", coreCapabilities: [{ name: "Invented", summary: "Invalid", featureNames: ["Missing feature"], scenarioRefs: [] }] }));
    await expect(createSnapshotPresentation({ result, language: "en", client: { complete } })).rejects.toThrow(/feature|coverage/i);
  });

  it("rejects a journey step that points to an unknown scenario", async () => {
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Explore history", coreCapabilities: [
      { name: "Explore", summary: "Explore", featureNames: ["Interactive map", "Place search"], scenarioRefs: [] },
      { name: "Listen", summary: "Listen", featureNames: ["Voice guide"], scenarioRefs: [] },
      { name: "Operate", summary: "Operate", featureNames: ["Deployment"], scenarioRefs: [] },
    ], journeys: [{ name: "Invalid", steps: [{ featureName: "Interactive map", reference: "HP-1" }, { featureName: "Voice guide", reference: "HP-99" }] }], concepts: [] }));
    await expect(createSnapshotPresentation({ result, language: "en", client: { complete } })).rejects.toThrow(/scenario reference/i);
  });

  it("rejects error scenarios presented as a typical user journey", async () => {
    const input = structuredClone(result);
    input.features[3].scenarios[0].category = "error";
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Explore history", coreCapabilities: [
      { name: "Explore", summary: "Explore", featureNames: ["Interactive map", "Place search"], scenarioRefs: [] },
      { name: "Listen", summary: "Listen", featureNames: ["Voice guide"], scenarioRefs: [] },
      { name: "Operate", summary: "Operate", featureNames: ["Deployment"], scenarioRefs: [] },
    ], journeys: [{ name: "Not a typical journey", steps: [{ featureName: "Interactive map", reference: "HP-1" }, { featureName: "Deployment", reference: "HP-1" }] }], concepts: [] }));
    await expect(createSnapshotPresentation({ result: input, language: "en", client: { complete } })).rejects.toThrow(/happy path/i);
  });

  it("allows a non-UI library to have no user journey instead of inventing one", async () => {
    const library = structuredClone(result);
    library.product.description = "A command-line parser library";
    library.features = [{ name: "Parse documents", summary: "Parse structured files into syntax trees", scenarios: result.features[0].scenarios }];
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Parse structured documents programmatically", coreCapabilities: [{ name: "Document parsing", summary: "Turn files into syntax trees", featureNames: ["Parse documents"], scenarioRefs: [] }], journeys: [], concepts: [] }));
    const presentation = await createSnapshotPresentation({ result: library, language: "en", client: { complete } });
    expect(presentation.status).toBe("generated");
    expect(presentation.journeys).toEqual([]);
    expect(presentation.coreCapabilities.flatMap((capability) => capability.featureNames)).toEqual(["Parse documents"]);
  });

  it("falls back to an honest feature index without fake domains or journeys", () => {
    const many = structuredClone(result);
    many.features = Array.from({ length: 8 }, (_, index) => ({ name: `Feature ${index + 1}`, summary: `Summary ${index + 1}`, scenarios: result.features[0].scenarios }));
    const presentation = fallbackSnapshotPresentation(many, "zh-CN");
    expect(presentation.status).toBe("fallback");
    expect(presentation.coreCapabilities).toHaveLength(1);
    expect(presentation.coreCapabilities[0].name).toBe("完整功能索引");
    expect(presentation.coreCapabilities[0].featureNames).toHaveLength(8);
    expect(presentation.journeys).toEqual([]);
    expect(presentation.concepts).toEqual([]);
    for (const featureName of presentation.coreCapabilities[0].featureNames) {
      expect(many.features.some((feature) => feature.name === featureName)).toBe(true);
    }
  });
});
