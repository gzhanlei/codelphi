import type { analyzeWithAI } from "../ai";
import type { StructuredCompletionClient } from "../llm-client";
import { createStandaloneClientFromEnv } from "../llm-client";
import type { SourceScopeRoot } from "../remote-source-index";
import { analyzeProductSnapshot } from "./analyze";
import { resolveHostClient, type HostAiAdapter, type HostClientSession } from "./host-ai";
import { buildSnapshotReportData } from "./report-data";
import { renderSnapshotHtml } from "./report-html";
import { resolveSnapshotTarget } from "./target";
import type { SnapshotReportData, SnapshotProgressEvent } from "./types";

export interface SnapshotRunOptions {
  target: string;
  ref?: string;
  scopeRoots?: SourceScopeRoot[];
  outputLanguage: "zh-CN" | "en";
  client?: StructuredCompletionClient;
  environment?: Record<string, string | undefined>;
  analyze?: typeof analyzeWithAI;
  now?: () => Date;
  standalone?: boolean;
  hostContext?: { host: string; adapters?: HostAiAdapter[] };
  onProgress?: (event: SnapshotProgressEvent) => void;
}

export interface SnapshotRunResult {
  report: SnapshotReportData;
  html: string;
}

export async function runSnapshot(options: SnapshotRunOptions): Promise<SnapshotRunResult> {
  let hostSession: HostClientSession | null = null;
  let target: Awaited<ReturnType<typeof resolveSnapshotTarget>> | null = null;
  try {
    let client: StructuredCompletionClient;
    if (options.client) client = options.client;
    else if (options.hostContext && !options.standalone) {
      hostSession = await resolveHostClient({
        host: options.hostContext.host,
        environment: options.environment ?? process.env,
        adapters: options.hostContext.adapters,
      });
      client = hostSession.client;
    } else {
      client = createStandaloneClientFromEnv(options.environment ?? process.env);
    }
    target = await resolveSnapshotTarget(options.target, options.ref);
    const analysis = await analyzeProductSnapshot({
      backend: target.backend,
      identity: target.identity,
      productName: target.identity.name,
      scopeRoots: options.scopeRoots,
      outputLanguage: options.outputLanguage,
      client,
      ...(options.analyze ? { analyze: options.analyze } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const report = buildSnapshotReportData(analysis);
    return { report, html: renderSnapshotHtml(report) };
  } finally {
    if (target) await target.cleanup();
    if (hostSession) await hostSession.dispose();
  }
}
