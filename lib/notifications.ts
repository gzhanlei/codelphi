import { defaultExecute, type Execute } from "./db";
import { requiredEnv } from "./env";
import { evidenceUrl } from "./evidence-url";
import { decryptSecret, encryptSecret } from "./secret-box";
import type { Evidence } from "./types";
import type { RunContext } from "./analysis";

export type NotificationChannelKind = "slack" | "webhook";

const kindLabels: Record<string, string> = { added: "新增", changed: "变化", removed: "移除" };
const maxEvidenceLinksPerChange = 3;

export function notificationSecret() {
  return requiredEnv("SESSION_SECRET");
}

export interface NotificationChannelView {
  id: number;
  kind: NotificationChannelKind;
  enabled: boolean;
  target: string;
}

export async function listNotificationChannels(productId: number, execute: Execute = defaultExecute): Promise<NotificationChannelView[]> {
  const [rows] = await execute(
    "SELECT id, kind, enabled, target_encrypted FROM notification_channels WHERE product_id = ? ORDER BY id",
    [productId],
  ) as [Array<{ id: number; kind: NotificationChannelKind; enabled: number; target_encrypted: string }>, unknown];
  const secret = notificationSecret();
  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind,
    enabled: Number(row.enabled) === 1,
    target: maskTarget(decryptSecret(row.target_encrypted, secret)),
  }));
}

/** 渠道目标只展示到 host+path，webhook URL 的签名段不入 UI。 */
export function maskTarget(target: string) {
  try {
    const url = new URL(target);
    return `${url.host}${url.pathname}`.slice(0, 80);
  } catch {
    return "***";
  }
}

export async function saveNotificationChannel(productId: number, kind: NotificationChannelKind, target: string, execute: Execute = defaultExecute) {
  await execute(
    `INSERT INTO notification_channels (product_id, kind, target_encrypted, enabled)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE target_encrypted = VALUES(target_encrypted), enabled = 1`,
    [productId, kind, encryptSecret(target, notificationSecret())],
  );
}

export async function setNotificationChannelEnabled(productId: number, channelId: number, enabled: boolean, execute: Execute = defaultExecute) {
  const [result] = await execute(
    "UPDATE notification_channels SET enabled = ? WHERE id = ? AND product_id = ?",
    [enabled ? 1 : 0, channelId, productId],
  ) as [{ affectedRows?: number }, unknown];
  if (!result.affectedRows) throw new Error("notification_channel_not_found");
}

export async function deleteNotificationChannel(productId: number, channelId: number, execute: Execute = defaultExecute) {
  const [result] = await execute(
    "DELETE FROM notification_channels WHERE id = ? AND product_id = ?",
    [channelId, productId],
  ) as [{ affectedRows?: number }, unknown];
  if (!result.affectedRows) throw new Error("notification_channel_not_found");
}

export interface NotificationChange {
  kind: string;
  entityType: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

function changeEvidence(change: NotificationChange): Evidence[] {
  const subject = change.after ?? change.before;
  if (typeof subject !== "object" || subject === null || !("evidence" in subject)) return [];
  const evidence = (subject as { evidence?: unknown }).evidence;
  return Array.isArray(evidence) ? evidence : [];
}

/** 通知消息与发布页 behavior-change-item 同构：功能/场景 + 变化类型 + 摘要 + 证据链接。 */
export function renderNotificationText(productName: string, releaseUrl: string, changes: readonly NotificationChange[], evidenceUrls: ReadonlyArray<ReadonlyArray<string | null>>): string | null {
  if (changes.length === 0) return null;
  const lines = [`【CoDelphi】${productName} 检测到 ${changes.length} 条规格行为变化`, releaseUrl];
  changes.forEach((change, index) => {
    const subject = change.entityType === "scenario" && change.scenarioReference
      ? `${change.featureName} · ${change.scenarioReference}`
      : change.featureName;
    lines.push(`${index + 1}. [${kindLabels[change.kind] ?? change.kind}] ${subject} — ${change.summary}`);
    const links = (evidenceUrls[index] ?? []).filter((url): url is string => url !== null);
    if (links.length > 0) lines.push(`   证据: ${links.join(" ")}`);
  });
  return lines.join("\n");
}

export interface AnalysisNotificationInput {
  run: Pick<RunContext, "id" | "productId" | "productName" | "productSlug" | "owner" | "name" | "afterSha">;
  releaseUrl: string;
  specVersionId: number | null;
}

export interface NotificationDependencies {
  execute?: Execute;
  post?: (target: string, body: string) => Promise<void>;
}

async function postJson(target: string, body: string) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`notification target ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/**
 * 分析成功事务提交后的 best-effort 投递：无变化静默；单渠道失败只落 deliveries，
 * 不影响其他渠道，也绝不回滚分析状态。
 */
export async function deliverAnalysisNotifications(input: AnalysisNotificationInput, dependencies: NotificationDependencies = {}) {
  const execute = dependencies.execute ?? defaultExecute;
  const post = dependencies.post ?? postJson;
  const { run, releaseUrl, specVersionId } = input;
  if (specVersionId === null) return;

  const [channelRows] = await execute(
    "SELECT id, kind, target_encrypted FROM notification_channels WHERE product_id = ? AND enabled = 1 ORDER BY id",
    [run.productId],
  ) as [Array<{ id: number; kind: NotificationChannelKind; target_encrypted: string }>, unknown];
  if (channelRows.length === 0) return;

  const [changeRows] = await execute(
    `SELECT kind, entity_type AS entityType, feature_name AS featureName, scenario_reference AS scenarioReference,
            summary, before_json AS beforeJson, after_json AS afterJson
     FROM spec_changes WHERE spec_version_id = ? ORDER BY id`,
    [specVersionId],
  ) as [Array<{ kind: string; entityType: string; featureName: string; scenarioReference: string; summary: string; beforeJson: unknown; afterJson: unknown }>, unknown];
  const changes: NotificationChange[] = changeRows.map((row) => ({
    kind: row.kind,
    entityType: row.entityType,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference ?? "",
    summary: row.summary,
    before: typeof row.beforeJson === "string" ? JSON.parse(row.beforeJson) : row.beforeJson,
    after: typeof row.afterJson === "string" ? JSON.parse(row.afterJson) : row.afterJson,
  }));

  const evidenceUrls = changes.map((change) =>
    changeEvidence(change).slice(0, maxEvidenceLinksPerChange).map((item) => evidenceUrl(run, run.afterSha, item)),
  );
  const text = renderNotificationText(run.productName, releaseUrl, changes, evidenceUrls);
  if (text === null) return;

  const secret = notificationSecret();
  const webhookPayload = JSON.stringify({
    product: { slug: run.productSlug, name: run.productName },
    releaseUrl,
    specVersionId,
    changes: changes.map((change, index) => ({
      kind: change.kind,
      entityType: change.entityType,
      featureName: change.featureName,
      scenarioReference: change.scenarioReference,
      summary: change.summary,
      evidenceUrls: (evidenceUrls[index] ?? []).filter((url): url is string => url !== null),
    })),
    sentAt: new Date().toISOString(),
  });

  for (const row of channelRows) {
    const target = decryptSecret(row.target_encrypted, secret);
    const body = row.kind === "slack" ? JSON.stringify({ text }) : webhookPayload;
    try {
      await post(target, body);
      await recordDelivery(execute, Number(row.id), run.id, "sent", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown notification error";
      await recordDelivery(execute, Number(row.id), run.id, "failed", message.slice(0, 2000)).catch(() => undefined);
    }
  }
}

function recordDelivery(execute: Execute, channelId: number, runId: number, status: "sent" | "failed", error: string | null) {
  return execute(
    `INSERT INTO notification_deliveries (channel_id, analysis_run_id, status, error)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), error = VALUES(error)`,
    [channelId, runId, status, error],
  );
}

/** 管理端测试按钮：向渠道发一条探测消息。 */
export async function sendNotificationChannelTest(channelId: number, productName: string, execute: Execute = defaultExecute, post: (target: string, body: string) => Promise<void> = postJson) {
  const [rows] = await execute(
    "SELECT id, kind, target_encrypted, product_id FROM notification_channels WHERE id = ? LIMIT 1",
    [channelId],
  ) as [Array<{ id: number; kind: NotificationChannelKind; target_encrypted: string; product_id: number }>, unknown];
  const row = rows[0];
  if (!row) throw new Error("notification_channel_not_found");
  const target = decryptSecret(row.target_encrypted, notificationSecret());
  const text = `【CoDelphi】${productName} 通知渠道测试成功。此后该产品每次分析发现规格行为变化都会推送到这里。`;
  await post(target, JSON.stringify(row.kind === "slack" ? { text } : { test: true, product: productName, sentAt: new Date().toISOString() }));
  return { productId: Number(row.product_id) };
}
