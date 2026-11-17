import { buildAnalysisMessages, type analyzeWithAI } from "./ai";
import type { ChangeContext, SourceFile } from "./code-hosting/types";

export const CONTRACT_VERSION = "1.0.0";

export interface ExtractionWorkOrder {
  contractVersion: string;
  id: string;
  messages: ReturnType<typeof buildAnalysisMessages>;
  sources: SourceFile[];
  change: ChangeContext;
  context: Omit<Parameters<typeof analyzeWithAI>[2], "client" | "billing">;
  allowPaths: string[];
}

export function buildExtractionWorkOrder(input: {
  id: string;
  sources: SourceFile[];
  change: ChangeContext;
  context: ExtractionWorkOrder["context"];
}): ExtractionWorkOrder {
  return {
    contractVersion: CONTRACT_VERSION,
    id: input.id,
    messages: buildAnalysisMessages(input.sources, input.change, input.context),
    sources: input.sources,
    change: input.change,
    context: input.context,
    allowPaths: [...new Set([...input.sources.map((source) => source.path), ...input.change.files.map((file) => file.path)])].sort(),
  };
}

export { buildAnalysisMessages };
