import { defaultExecute, type Execute } from "./db";
import { buildDigest, type DigestContent, type DigestChange } from "./digest";
import { collectEvidencePaths } from "./release-notes-service";
import { deliverDigestNotifications } from "./notifications";

/**
 * Digest 周报编排（A2 §4.3，GTM 桥面后续）：滚动 7 天窗口（UTC，止于昨日），
 * 每产品若窗口内有行为变化且本期未生成过 → buildDigest 落 digests 表并投递。
 * 无变化的周不生成不发（buildDigest 返回 null，沿用现有通知规则）；生成过的不重发
 * （digests UNIQUE(product_id, period_start)）。确定性组装零生成文本（R1 幻觉面为零）。
 */

export interface DigestWindow {
  /** DATE 键 YYYY-MM-DD（digests.period_start）。 */
  periodStart: string;
  periodEnd: string;
  /** SQL 比较字面量 YYYY-MM-DD HH:mm:ss（UTC 墙钟，与 committed_at 写入口径一致）。 */
  fromLiteral: string;
  toLiteral: string;
}

/** 滚动 7 天窗口，止于昨日 UTC 末日。 */
export function digestWindow(now: Date = new Date()): DigestWindow {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(todayUtc - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - 6 * 24 * 3600 * 1000);
  const dateKey = (date: Date) => date.toISOString().slice(0, 10);
  return {
    periodStart: dateKey(start),
    periodEnd: dateKey(end),
    fromLiteral: `${dateKey(start)} 00:00:00`,
    toLiteral: `${dateKey(end)} 23:59:59`,
  };
}

async function loadWindowChanges(execute: Execute, productId: number, window: DigestWindow): Promise<DigestChange[]> {
  const result = await execute(
    `SELECT c.id, c.kind, c.entity_type AS entityType, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary, c.highlight_type AS highlightType,
            c.before_json AS beforeJson, c.after_json AS afterJson,
            r.title AS releaseTitle, r.url AS releaseUrl
     FROM spec_changes c
     JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND r.committed_at >= ? AND r.committed_at <= ? AND c.wording_only = 0
     ORDER BY r.committed_at DESC, c.id`,
    [productId, window.fromLiteral, window.toLiteral],
  );
  const rows = (Array.isArray(result) ? result[0] : result) as Array<{ id: number; kind: string; entityType: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null; beforeJson: unknown; afterJson: unknown; releaseTitle: string; releaseUrl: string | null }>;
  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    entityType: row.entityType,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    summary: row.summary,
    highlightType: row.highlightType,
    evidencePaths: [...collectEvidencePaths(row.beforeJson), ...collectEvidencePaths(row.afterJson)],
    releaseTitle: row.releaseTitle,
    releaseUrl: row.releaseUrl ?? "",
  }));
}

const kindLabels: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };

/** 纯函数：digest → 渠道/邮件文本（确定性，无生成文本）。 */
export function renderDigestText(productName: string, content: DigestContent): string {
  const lines = [
    `【CoDelphi】${productName} 周期行为摘要（${content.period.start} ~ ${content.period.end}）`,
    `本期行为变化 ${content.changes.length} 条。`,
    "",
  ];
  for (const change of content.changes) {
    const kind = kindLabels[change.kind] ?? change.kind;
    const subject = change.scenarioReference ? `${change.featureName} · ${change.scenarioReference}` : change.featureName;
    lines.push(`- ${kind} ${subject}：${change.summary}${change.highlightType ? `（${change.highlightType}）` : ""}`);
    if (change.evidencePaths.length > 0) lines.push(`  证据：${change.evidencePaths.slice(0, 4).join("、")}`);
  }
  return lines.join("\n");
}

export async function runDigestSweepOnce(execute: Execute = defaultExecute, now: Date = new Date(), dependencies: { post?: (target: string, body: string) => Promise<void>; sendEmail?: (to: string, subject: string, text: string) => Promise<void> } = {}): Promise<{ generated: number; skipped: number; products: number }> {
  const window = digestWindow(now);
  const [productRows] = await execute(
    `SELECT DISTINCT p.id, p.name FROM products p
     JOIN releases r ON r.product_id = p.id
     WHERE r.committed_at >= ? AND r.committed_at <= ?`,
    [window.fromLiteral, window.toLiteral],
  ) as [Array<{ id: number; name: string }>, unknown];
  let generated = 0;
  let skipped = 0;
  for (const product of productRows) {
    const [existing] = await execute(
      "SELECT id FROM digests WHERE product_id = ? AND period_start = ? LIMIT 1",
      [product.id, window.periodStart],
    ) as [Array<{ id: number }>, unknown];
    if (existing.length > 0) {
      skipped += 1;
      continue;
    }
    const changes = await loadWindowChanges(execute, product.id, window);
    const content = buildDigest({ periodStart: window.periodStart, periodEnd: window.periodEnd, changes });
    if (!content) continue; // 无变化的周不生成不发，也不留空行
    await execute(
      "INSERT INTO digests (product_id, period_start, period_end, content_json) VALUES (?, ?, ?, ?)",
      [product.id, window.periodStart, window.periodEnd, JSON.stringify(content)],
    );
    const text = renderDigestText(product.name, content);
    await deliverDigestNotifications({
      productId: product.id,
      productName: product.name,
      subject: `【CoDelphi】${product.name} 周期行为摘要（${window.periodStart} ~ ${window.periodEnd}）`,
      text,
      webhookPayload: JSON.stringify({ type: "digest", product: { id: product.id, name: product.name }, period: content.period, changes: content.changes, audiences: content.audiences }),
    }, { execute, ...dependencies });
    generated += 1;
  }
  return { generated, skipped, products: productRows.length };
}
