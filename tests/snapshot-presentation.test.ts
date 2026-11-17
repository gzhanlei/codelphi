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
    ] }));
    const presentation = await createSnapshotPresentation({ result, language: "en", client: { complete } });
    expect(presentation.coreCapabilities).toHaveLength(3);
    expect(presentation.coreCapabilities[0].featureNames).toEqual(["Interactive map", "Place search"]);
    expect(presentation.coreCapabilities[0].scenarioRefs).toHaveLength(2);
    const messages = complete.mock.calls[0]![0];
    expect(messages[1].content).toContain("Do not add facts");
  });

  it("rejects unknown feature or scenario references", async () => {
    const complete = vi.fn(async () => JSON.stringify({ tagline: "Invalid", coreCapabilities: [{ name: "Invented", summary: "Invalid", featureNames: ["Missing feature"], scenarioRefs: [] }] }));
    await expect(createSnapshotPresentation({ result, language: "en", client: { complete } })).rejects.toThrow(/feature|coverage/i);
  });

  it("falls back to a bounded complete projection without inventing summaries", () => {
    const many = structuredClone(result);
    many.features = Array.from({ length: 8 }, (_, index) => ({ name: `Feature ${index + 1}`, summary: `Summary ${index + 1}`, scenarios: result.features[0].scenarios }));
    const presentation = fallbackSnapshotPresentation(many, "zh-CN");
    expect(presentation.coreCapabilities.length).toBeLessThanOrEqual(6);
    expect(presentation.coreCapabilities.flatMap((capability) => capability.featureNames)).toHaveLength(8);
    expect(presentation.coreCapabilities.at(-1)?.name).toBe("其他能力");
    for (const capability of presentation.coreCapabilities) {
      for (const featureName of capability.featureNames) expect(many.features.some((feature) => feature.name === featureName)).toBe(true);
    }
  });
});
