/**
 * 客户端交上来的流程图怎么存（修订稿 §5.4、§6「落库之后」）。
 *
 * 流程图生成不读源码，所以搬到了客户端。服务端只做两件事：
 *   - 场景没变的功能，沿用上一版的图（和托管分析的沿用规则相同）；
 *   - 客户端为某个功能交了图，就用合并后真正落库的场景校验它。通过才存，指纹按合并后的场景算，不信客户端报的指纹；
 *     不通过只记原因，不在服务端重新生成。
 * 合并后的场景和客户端看到的不一样（有人工编辑）时，就会落到「不通过」这一步。
 */
import type { Execute } from "../db";
import { copyInheritedFeatureFlowGraphs, loadVersionFeatureRecords, saveFeatureFlowError, saveFeatureFlowGraph } from "../feature-flow-store";
import { FlowValidationError, scenarioFingerprint, validateFeatureFlowGraph } from "../semantic-feature-flow";
import type { Proposal } from "./contract";

export interface ClientFlowSummary {
  /** 从上一版沿用的图的数量。 */
  inherited: number;
  stored: number;
  /** 校验没过、记了原因的。 */
  rejected: number;
  /** 提案里有图、但合并后的版本里没有这个功能（被人工条目、折叠或劫持门禁去掉了）。 */
  unmatched: number;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Array<Record<string, unknown>>;
}

/** 在发布事务里调用：execute 是那个事务的连接。 */
export async function storeClientFlows(execute: Execute, input: { repositoryId: number; specVersionId: number; flows: Proposal["flows"] }): Promise<ClientFlowSummary> {
  const summary: ClientFlowSummary = { inherited: 0, stored: 0, rejected: 0, unmatched: 0 };
  const previous = rowsOf(await execute("SELECT id FROM spec_versions WHERE repository_id = ? AND id < ? ORDER BY id DESC LIMIT 1", [input.repositoryId, input.specVersionId]))[0];
  if (previous) summary.inherited = await copyInheritedFeatureFlowGraphs(execute, Number(previous.id), input.specVersionId);
  const records = await loadVersionFeatureRecords(execute, input.specVersionId);
  const byKey = new Map(records.map((record) => [record.stableKey, record]));
  for (const flow of input.flows) {
    const record = byKey.get(flow.featureStableKey);
    if (!record) {
      summary.unmatched += 1;
      continue;
    }
    const fingerprint = scenarioFingerprint(record.feature.scenarios);
    try {
      const graph = validateFeatureFlowGraph(flow.graph, record.feature.scenarios);
      await saveFeatureFlowGraph(execute, record.id, graph, fingerprint);
      summary.stored += 1;
    } catch (error) {
      if (!(error instanceof FlowValidationError)) throw error;
      await saveFeatureFlowError(execute, record.id, error.code, fingerprint);
      summary.rejected += 1;
    }
  }
  return summary;
}
