/**
 * 客户端提案的发布（修订稿 §4.6、§6）。
 *
 * 一个事务里完成，任何一步失败全部回滚，包括已经插入的 run 行：
 *   1. 锁：有仓库行就锁仓库行；首次发布还没有仓库行，锁产品行，再建立绑定。
 *   2. 幂等：插入 client_upload 的 run 行。幂等键或提案哈希撞上唯一键，说明是重传：回滚，读出原来那次的回执。
 *   3. 基线核对：拿到锁之后才读当前版本，必须等于提案的基线。
 *   4. 合并：saveResultInTransaction，和托管分析同一个入口，只是行为变更集合和行号区间是客户端算好的。
 *   5. 来源信息、流程图、理解层候选。
 * 隔离级别显式声明为 REPEATABLE READ（生产库默认是 READ COMMITTED）。隔离级别本身不让两次发布串行，
 * 靠的是锁：锁是事务的第一条语句，拿到锁之后才建立读快照，所以后到的事务一定看得到先到的那次提交。
 *
 * 事务提交之后只有通知，尽力而为。服务端在这条路径上不读源码、不调模型。
 */
import type { Pool, PoolConnection } from "mysql2/promise";
import { saveResultInTransaction, type RunContext } from "../analysis";
import type { AnalysisCoverageReceipt } from "../analysis-coverage";
import { CLIENT_MODE_ERROR, CLIENT_UPLOAD_TRIGGER } from "../analysis-executor";
import type { ChangeContext } from "../code-hosting/types";
import type { Execute } from "../db";
import { deliverAnalysisNotifications } from "../notifications";
import { loadVersionFeatureMap } from "../spec-versions";
import { diffSpec, specFeatureKey, type SpecFeature } from "../spec-diff";
import { loadPresentationLedger, presentationLedgerFingerprint, saveProductPresentation } from "../product-presentation-service";
import { buildImportedPresentation } from "../snapshot-import";
import { changeOf, coverageOf, provenanceOf, runContextOf, type PublishIdentity, type VerificationCounts } from "./adapt";
import type { Proposal } from "./contract";
import { storeClientFlows, type ClientFlowSummary } from "./flows";

export type ProposalRejectionCode =
  | "product_not_found"
  | "artifact_contains_source"
  | "analysis_mode_is_server"
  | "incremental_not_supported"
  | "repository_not_bound"
  | "repository_mismatch"
  | "repository_identity_conflict"
  | "repository_already_bound"
  | "base_changed"
  | "proposal_rejected";

/** 服务端拒绝一份提案。code 回给客户端，status 是路由用的状态码，details 只放机器可读的东西。 */
export class ProposalRejection extends Error {
  constructor(
    readonly code: ProposalRejectionCode,
    message: string,
    readonly details: unknown = null,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ProposalRejection";
  }
}

export interface PublishTarget {
  productId: number;
  organizationId: number;
  productSlug: string;
  productName: string;
}

export interface PublishReceipt {
  /** true 表示这份提案之前已经发布过，这是原来那次的回执，没有产生新版本。 */
  replayed: boolean;
  repositoryId: number;
  specVersionId: number;
  releaseId: number | null;
  revisionSha: string;
  verification: VerificationCounts;
  flows?: ClientFlowSummary;
}

/** 提案只能发给由客户端分析的产品（修订稿 §6：受控试点，运营逐个产品开启）。 */
export async function loadPublishTarget(pool: Pool, slug: string, organizationId: number): Promise<PublishTarget> {
  const [rows] = (await pool.execute(
    "SELECT id, slug, name, organization_id AS organizationId, analysis_executor AS analysisExecutor FROM products WHERE slug = ? AND organization_id = ? LIMIT 1",
    [slug, organizationId],
  )) as unknown as [Array<{ id: number; slug: string; name: string; organizationId: number; analysisExecutor: string }>, unknown];
  const product = rows[0];
  if (!product) throw new ProposalRejection("product_not_found", `no product named ${slug} in this organization`, null, 404);
  if (product.analysisExecutor !== "client") {
    throw new ProposalRejection("analysis_mode_is_server", `${CLIENT_MODE_ERROR}: this product is analysed on the server; proposals are not accepted`, null, 409);
  }
  return { productId: Number(product.id), organizationId: Number(product.organizationId), productSlug: product.slug, productName: product.name };
}

type RepositoryProvider = "github" | "gitee" | "gitlab" | "gitea" | "local";

interface LockedRepository {
  id: number;
  productId: number;
  provider: RepositoryProvider;
  host: string | null;
  owner: string;
  name: string;
}

/** 重传的信号：不是失败，是「这份提案已经发布过」。带上仓库 id，回滚之后用它读原来的回执。 */
class Replay extends Error {
  constructor(readonly repositoryId: number) {
    super("proposal already published");
    this.name = "ProposalReplay";
  }
}

class BaseChanged extends Error {
  constructor(readonly baseId: number | null, readonly currentId: number | null) {
    super("base changed");
    this.name = "ProposalBaseChanged";
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Array<Record<string, unknown>>;
}

const executeOf = (connection: PoolConnection): Execute => (statement, parameters) => connection.execute(statement, parameters);

const sameName = (left: string | null, right: string | null): boolean => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();

const PROVIDERS: readonly RepositoryProvider[] = ["github", "gitee", "gitlab", "gitea", "local"];

function repositoryOf(row: Record<string, unknown>): LockedRepository {
  const provider = String(row.provider) as RepositoryProvider;
  if (!PROVIDERS.includes(provider)) throw new ProposalRejection("repository_mismatch", `repository ${String(row.id)} has an unknown provider`, { provider: row.provider });
  return { id: Number(row.id), productId: Number(row.product_id ?? row.productId), provider, host: row.host === null || row.host === undefined ? null : String(row.host), owner: String(row.owner), name: String(row.name) };
}

/** 主机名：记录里没有就按提案补上；两边都有就必须是同一个（自托管实例靠它区分）。 */
async function reconcileHost(connection: PoolConnection, repository: LockedRepository, claimedHost: string | null): Promise<string | null> {
  if (repository.host === null) {
    if (claimedHost !== null) await connection.execute("UPDATE repositories SET host = ? WHERE id = ?", [claimedHost, repository.id]);
    return claimedHost;
  }
  // 同一个 provider/owner/name 换了一个主机名，是另一个仓库（自托管实例靠主机名区分），不是字段写错了。
  if (claimedHost === null || repository.host.toLowerCase() !== claimedHost.toLowerCase()) {
    throw new ProposalRejection("repository_identity_conflict", `repository ${repository.id} is hosted at ${repository.host}, the proposal says ${claimedHost ?? "no host"}`, { repositoryId: repository.id });
  }
  return repository.host;
}

/** 事务的第一条语句：锁住这个产品发布要动的那一行，并核对仓库身份（修订稿 §6）。 */
async function lockRepository(connection: PoolConnection, proposal: Proposal, target: PublishTarget): Promise<LockedRepository> {
  const claimed = proposal.repository;
  if (claimed.repositoryId !== null) {
    // 事务的第一条语句就是锁定读：读到的是最新提交的那一行。
    const row = rowsOf(await connection.execute("SELECT id, product_id, provider, host, owner, name FROM repositories WHERE id = ? FOR UPDATE", [claimed.repositoryId]))[0];
    if (!row) throw new ProposalRejection("repository_not_bound", `repository ${claimed.repositoryId} does not exist`, { repositoryId: claimed.repositoryId }, 409);
    const fromId = repositoryOf(row);
    if (fromId.productId !== target.productId) {
      throw new ProposalRejection("repository_not_bound", `repository ${fromId.id} is not bound to this product`, { repositoryId: fromId.id }, 409);
    }
    if (fromId.provider !== claimed.provider || !sameName(fromId.owner, claimed.owner) || !sameName(fromId.name, claimed.name)) {
      throw new ProposalRejection("repository_mismatch", `repository ${fromId.id} does not match the identity in the proposal`, { repositoryId: fromId.id });
    }
    return { ...fromId, host: await reconcileHost(connection, fromId, claimed.host) };
  }
  // 首次发布：客户端还没有仓库 id。锁产品行，同一个产品的首次发布由此串行。
  await connection.execute("SELECT id FROM products WHERE id = ? FOR UPDATE", [target.productId]);
  const bound = rowsOf(await connection.execute("SELECT id, product_id, provider, host, owner, name FROM repositories WHERE product_id = ? LIMIT 1 FOR UPDATE", [target.productId]))[0];
  if (bound) {
    // 这个产品已经有仓库了（比如在另一台机器上克隆后重新发布，或者产品是托管接入的）：身份必须对得上。
    const repository = repositoryOf(bound);
    if (repository.provider !== claimed.provider || !sameName(repository.owner, claimed.owner) || !sameName(repository.name, claimed.name)) {
      throw new ProposalRejection("repository_mismatch", "this product is bound to a different repository", { repositoryId: repository.id });
    }
    return { ...repository, host: await reconcileHost(connection, repository, claimed.host) };
  }
  const branch = proposal.revision.branch ?? "main";
  if (claimed.provider === "local") {
    // 纯本地仓库按产品绑定；owner 用产品号拼出来，唯一键 (provider, owner, name) 才不会让两个产品撞上。
    const [inserted] = (await connection.execute(
      "INSERT INTO repositories (product_id, provider, owner, name, default_branch) VALUES (?, 'local', ?, ?, ?)",
      [target.productId, `local-product-${target.productId}`, claimed.name, branch],
    )) as unknown as [{ insertId: number }, unknown];
    return { id: Number(inserted.insertId), productId: target.productId, provider: "local", host: null, owner: `local-product-${target.productId}`, name: claimed.name as string };
  }
  const taken = rowsOf(await connection.execute("SELECT id, host FROM repositories WHERE provider = ? AND owner = ? AND name = ? LIMIT 1 FOR UPDATE", [claimed.provider, claimed.owner, claimed.name]))[0];
  if (taken) {
    const storedHost = taken.host === null || taken.host === undefined ? null : String(taken.host);
    if (storedHost !== null && claimed.host !== null && storedHost.toLowerCase() !== claimed.host.toLowerCase()) {
      throw new ProposalRejection("repository_identity_conflict", `this repository is registered at ${storedHost}, the proposal says ${claimed.host}`, { repositoryId: Number(taken.id) });
    }
    throw new ProposalRejection("repository_already_bound", "this repository is already bound to another product", { repositoryId: Number(taken.id) });
  }
  const [inserted] = (await connection.execute(
    "INSERT INTO repositories (product_id, provider, owner, name, default_branch, host) VALUES (?, ?, ?, ?, ?, ?)",
    [target.productId, claimed.provider, claimed.owner, claimed.name, branch, claimed.host],
  )) as unknown as [{ insertId: number }, unknown];
  return { id: Number(inserted.insertId), productId: target.productId, provider: claimed.provider, host: claimed.host, owner: claimed.owner as string, name: claimed.name };
}

/** 插入回执用的 run 行。撞上幂等键或提案哈希就是重传。 */
async function insertRunRow(connection: PoolConnection, proposal: Proposal, target: PublishTarget, repository: LockedRepository): Promise<number> {
  try {
    const [inserted] = (await connection.execute(
      `INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status, account_id, client_idempotency_key, client_proposal_hash)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      [repository.id, CLIENT_UPLOAD_TRIGGER, proposal.base?.sha ?? null, proposal.revision.sha, target.organizationId, proposal.idempotencyKey, proposal.proposalHash.slice("sha256:".length)],
    )) as unknown as [{ insertId: number }, unknown];
    return Number(inserted.insertId);
  } catch (error) {
    const driver = error as { code?: string; message?: string };
    if (driver.code !== "ER_DUP_ENTRY") throw error;
    if (/client_idempotency|client_proposal/.test(driver.message ?? "")) throw new Replay(repository.id);
    // 同一个提交上已经有活跃的 run（analysis_runs_active_unique）：客户端分析的产品不该出现，出现了也不抢。
    throw new ProposalRejection("proposal_rejected", "another active run already exists for this revision");
  }
}

/** 拿到锁之后才读当前版本。取不到指定的版本时合并入口会返回空而不报错，所以这一步必须在这里做。 */
async function assertBase(connection: PoolConnection, repositoryId: number, proposal: Proposal): Promise<void> {
  const current = rowsOf(await connection.execute("SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1", [repositoryId]))[0];
  const currentId = current ? Number(current.id) : null;
  if (currentId !== (proposal.base?.specVersionId ?? null)) throw new BaseChanged(proposal.base?.specVersionId ?? null, currentId);
}

function isCollapseRejection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("spec_collapse_rejected");
}

interface Published {
  receipt: PublishReceipt;
  run: RunContext;
  change: ChangeContext;
}

async function publishInTransaction(connection: PoolConnection, proposal: Proposal, target: PublishTarget, now: () => Date): Promise<Published> {
  const repository = await lockRepository(connection, proposal, target);
  const runId = await insertRunRow(connection, proposal, target, repository);
  await assertBase(connection, repository.id, proposal);
  const execute = executeOf(connection);

  const provider = repository.provider === "local" ? "github" : repository.provider;
  const run = runContextOf(proposal, {
    runId,
    repositoryId: repository.id,
    productId: target.productId,
    organizationId: target.organizationId,
    productSlug: target.productSlug,
    productName: target.productName,
    owner: repository.provider === "local" ? "" : repository.owner,
    name: repository.provider === "local" ? "" : repository.name,
    provider,
  });
  const change = changeOf(proposal);
  const coverage: AnalysisCoverageReceipt | undefined = coverageOf(proposal);
  let saved: Awaited<ReturnType<typeof saveResultInTransaction>>;
  try {
    saved = await saveResultInTransaction(connection, run, proposal.proposal, change, null, coverage);
  } catch (error) {
    // 坍缩护栏拒绝：对客户端是「这份提案没被接受」，不是服务端故障。
    if (isCollapseRejection(error)) throw new ProposalRejection("proposal_rejected", (error as Error).message);
    throw error;
  }
  if (!saved.activate) throw new Error("a client publish must be the latest run of its repository");

  const proposalKeys = new Set(proposal.proposal.features.map((feature) => specFeatureKey(feature.name)));
  const verification: VerificationCounts = {
    reanalyzed: proposal.proposal.features.length,
    // 合并后留在版本里、提案本身没有的功能，是现有合并逻辑从上一版沿用下来的。
    deterministicallyCarried: saved.features.filter((feature) => !proposalKeys.has(specFeatureKey(feature.name))).length,
    clientDeclaredUnaffected: 0,
  };
  const provenance = provenanceOf(proposal, { receivedAt: now().toISOString(), specVersionId: saved.specVersionId, counts: verification });
  await connection.execute("UPDATE spec_versions SET provenance_json = ? WHERE id = ?", [JSON.stringify(provenance), saved.specVersionId]);
  const flows = await storeClientFlows(execute, { repositoryId: repository.id, specVersionId: saved.specVersionId, flows: proposal.flows });
  await storeClientPresentation(execute, { productId: target.productId, specVersionId: saved.specVersionId, proposal, merged: saved.features });

  return {
    receipt: { replayed: false, repositoryId: repository.id, specVersionId: saved.specVersionId, releaseId: saved.releaseId, revisionSha: proposal.revision.sha, verification, flows },
    run,
    change,
  };
}

/** 理解层候选：按现有的校验逐条过（引用的功能必须在合并后的版本里），通过才存。人工内容优先的规则在读取侧。 */
async function storeClientPresentation(execute: Execute, input: { productId: number; specVersionId: number; proposal: Proposal; merged: SpecFeature[] }): Promise<boolean> {
  const payload = buildImportedPresentation(
    input.proposal.presentation,
    input.merged.map((feature) => ({
      name: feature.name,
      summary: feature.summary,
      scenarios: feature.scenarios.map((scenario) => ({
        reference: scenario.reference,
        context: scenario.context,
        action: scenario.action,
        outcome: scenario.outcome,
        category: scenario.category,
        step: scenario.step ?? null,
        evidence: scenario.evidence.map((item) => ({ path: item.path, startLine: item.startLine ?? null, endLine: item.endLine ?? null })),
      })),
    })),
    input.proposal.language,
  );
  if (!payload) return false;
  // 指纹按合并后的工作台账本算，和托管刷新用的是同一个函数：读取侧据此判断这份理解层是不是最新的。
  const ledger = await loadPresentationLedger(execute, input.productId);
  const fingerprint = presentationLedgerFingerprint({ features: ledger?.features ?? [], scenarios: ledger?.scenarios ?? [], language: input.proposal.language });
  await saveProductPresentation(execute, { productId: input.productId, specVersionId: input.specVersionId, source: "client_generated", fingerprint, payload, modelName: input.proposal.client.model });
  return true;
}

async function replayReceipt(pool: Pool, proposal: Proposal, repositoryId: number): Promise<PublishReceipt> {
  const rows = rowsOf(await pool.execute(
    `SELECT sv.id AS specVersionId, rel.id AS releaseId FROM analysis_runs r
     JOIN spec_versions sv ON sv.analysis_run_id = r.id
     LEFT JOIN releases rel ON rel.analysis_run_id = r.id
     WHERE r.repository_id = ? AND r.trigger_type = ? AND (r.client_idempotency_key = ? OR r.client_proposal_hash = ?)
     ORDER BY r.id DESC LIMIT 1`,
    [repositoryId, CLIENT_UPLOAD_TRIGGER, proposal.idempotencyKey, proposal.proposalHash.slice("sha256:".length)],
  ));
  const row = rows[0];
  // 撞了唯一键却没有版本：原来那次的事务回滚了，唯一键也就不存在了。走不到这里。
  if (!row) throw new ProposalRejection("proposal_rejected", "an earlier upload of this proposal did not produce a version");
  return { replayed: true, repositoryId, specVersionId: Number(row.specVersionId), releaseId: row.releaseId == null ? null : Number(row.releaseId), revisionSha: proposal.revision.sha, verification: { reanalyzed: 0, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 } };
}

/** 基线过期时回给客户端的东西（修订稿 §4.6）：当前版本、基线到当前之间变化的功能、reusable 还是 reanalyze。 */
async function describeBaseChange(pool: Pool, proposal: Proposal, change: BaseChanged): Promise<ProposalRejection> {
  const execute: Execute = (statement, parameters) => pool.execute(statement, parameters);
  const ids = [change.baseId, change.currentId].filter((id): id is number => id !== null);
  const versions = ids.length === 0 ? new Map<number, SpecFeature[]>() : await loadVersionFeatureMap(execute, ids);
  const baseFeatures = change.baseId === null ? null : versions.get(change.baseId) ?? [];
  const currentFeatures = change.currentId === null ? [] : versions.get(change.currentId) ?? [];
  const changed = [...new Set(diffSpec(baseFeatures, currentFeatures).map((item) => specFeatureKey(item.featureName)))];
  const currentRow = change.currentId === null ? undefined : rowsOf(await pool.execute("SELECT sha FROM spec_versions WHERE id = ?", [change.currentId]))[0];
  const currentSha = currentRow ? String(currentRow.sha) : null;
  const scope = new Set(proposal.proposal.features.map((feature) => specFeatureKey(feature.name)));
  const verdict = currentSha !== (proposal.base?.sha ?? null) || changed.some((key) => scope.has(key)) ? "reanalyze" : "reusable";
  return new ProposalRejection("base_changed", "the ledger moved on since this proposal was based on it", {
    current: { specVersionId: change.currentId, revisionSha: currentSha },
    changedFeatureKeys: changed,
    verdict,
  });
}

/** 事务提交之后的通知，尽力而为：失败只记日志，不影响已经发布的版本，也不重试。 */
async function notify(published: Published): Promise<void> {
  try {
    await deliverAnalysisNotifications({
      run: published.run,
      releaseUrl: published.change.url,
      specVersionId: published.receipt.specVersionId,
      collapse: null,
      featureCollapses: [],
      misplacedCount: 0,
    });
  } catch (error) {
    console.error("[client-proposal] notification delivery failed", error);
  }
}

/**
 * 发布一份提案。调用方已经用 parseProposal 校验过内容，也做过了服务端的隐私复查。
 * 回执里 replayed 为 true 时没有产生新版本。
 */
export async function publishProposal(pool: Pool, proposal: Proposal, target: PublishTarget, options: { now?: () => Date } = {}): Promise<PublishReceipt> {
  if (proposal.mode !== "full") throw new ProposalRejection("incremental_not_supported", "incremental proposals are not accepted yet: publish a full analysis");
  const now = options.now ?? (() => new Date());
  const connection = await pool.getConnection();
  let published: Published | null = null;
  let receipt: PublishReceipt;
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    published = await publishInTransaction(connection, proposal, target, now);
    await connection.commit();
    receipt = published.receipt;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // 事务已经不在了。
    }
    if (error instanceof Replay) receipt = await replayReceipt(pool, proposal, error.repositoryId);
    else if (error instanceof BaseChanged) throw await describeBaseChange(pool, proposal, error);
    else throw error;
  } finally {
    connection.release();
  }
  if (published) await notify(published);
  return receipt;
}

/** 拒绝审计：另起一个小事务写一行，所以不会被发布的回滚带掉。只记机器可读的东西，不存请求体。 */
export async function recordProposalRejection(
  pool: Pool,
  entry: { organizationId: number; productId: number | null; repositoryId: number | null; revisionSha: string | null; proposalHash: string | null; code: string; details: unknown },
): Promise<void> {
  const details = entry.details === null || entry.details === undefined ? null : JSON.stringify(entry.details).slice(0, 8_000);
  try {
    await pool.execute(
      `INSERT INTO client_proposal_rejections (organization_id, product_id, repository_id, revision_sha, proposal_hash, error_code, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.organizationId, entry.productId, entry.repositoryId, entry.revisionSha?.slice(0, 12) ?? "", entry.proposalHash?.slice("sha256:".length) ?? null, entry.code, details],
    );
  } catch (error) {
    console.error("[client-proposal] could not record the rejection", error);
  }
}
