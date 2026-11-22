import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Execute } from "../lib/db";
import { ExecutionBatchError } from "../lib/execution-batch/plans";
import {
  beginBatchRequest,
  loadBatchRequest,
  markBatchRequestDispatchStarted,
  markBatchRequestOutcome,
  persistBatchResponse,
  reconcileBatchRequestReceipt,
} from "../lib/execution-batch/requests";
import { MAX_BATCH_RESPONSE_BYTES } from "../lib/execution-batch/types";

const RUN_ID = 77;
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const FINGERPRINT = "f".repeat(64);

function dupError(): Error & { code?: string } {
  const error = new Error("Duplicate entry") as Error & { code?: string };
  error.code = "ER_DUP_ENTRY";
  return error;
}

// —— llm_call_receipts 假表（recordRequestScopedReceipt 经 getDb）——
interface ReceiptRow {
  request_key: string | null;
  request_fingerprint: string | null;
  provider_request_id: string | null;
  usage_status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  usage_json: string | null;
  llm_cost_amount: string | null;
  duration_ms: number | null;
}

const receiptState = vi.hoisted(() => ({ router: null as unknown as ((sql: string, params: unknown[]) => Promise<unknown>) | null }));
vi.mock("../lib/db", () => ({
  getDb: () => ({
    execute: (sql: string, params: unknown[]) => {
      if (!receiptState.router) throw new Error("receipt router not installed");
      return receiptState.router(sql, params);
    },
  }),
}));

const receiptRows: ReceiptRow[] = [];
let failReceiptInsert: "dup" | "error" | null = null;

const receiptRouter = async (sql: string, rawParams: unknown[]): Promise<unknown> => {
  const params = rawParams as Array<string | number | null>;
  const normalized = String(sql).replace(/\s+/g, " ").trim();
  if (normalized.startsWith("INSERT INTO llm_call_receipts")) {
    if (failReceiptInsert === "error") throw new Error("db down");
    const key = params[24] as string | null;
    if (failReceiptInsert === "dup" || (key !== null && receiptRows.some((row) => row.request_key === key))) throw dupError();
    receiptRows.push({
      request_key: key,
      request_fingerprint: params[25] as string | null,
      provider_request_id: params[4] as string | null,
      usage_status: params[6] as string,
      input_tokens: params[7] as number | null,
      output_tokens: params[8] as number | null,
      cache_hit_tokens: params[9] as number | null,
      cache_miss_tokens: params[10] as number | null,
      usage_json: params[11] as string | null,
      llm_cost_amount: params[17] as string | null,
      duration_ms: params[26] as number | null,
    });
    return [{ insertId: receiptRows.length }];
  }
  if (normalized.includes("FROM llm_call_receipts WHERE request_key = ?")) {
    return [receiptRows.filter((row) => row.request_key === params[0]).map((row) => ({ ...row }))];
  }
  if (normalized.startsWith("UPDATE llm_call_receipts SET provider_request_id = ?")) {
    const row = receiptRows.find((candidate) => candidate.request_key === params[9] && candidate.request_fingerprint === params[10]);
    if (!row) return [{ affectedRows: 0 }];
    row.provider_request_id = params[0] as string | null;
    row.input_tokens = params[1] as number | null;
    row.output_tokens = params[2] as number | null;
    row.cache_hit_tokens = params[3] as number | null;
    row.cache_miss_tokens = params[4] as number | null;
    row.usage_json = params[5] as string | null;
    row.usage_status = params[6] as string;
    row.llm_cost_amount = params[7] as string | null;
    row.duration_ms = params[8] as number | null;
    return [{ affectedRows: 1 }];
  }
  throw new Error(`unexpected receipt statement: ${sql}`);
};

// —— analysis_behavior_batch_requests 假表 ——
interface BatchRow {
  request_key: string;
  run_id: number;
  batch_attempt_uuid: string;
  request_stage: string;
  request_sequence: number;
  request_fingerprint: string;
  describe_response_hash: string | null;
  provider_request_id: string | null;
  request_outcome: string;
  failure_class: string | null;
  raw_response: string | null;
  response_byte_length: number | null;
  stored_byte_length: number | null;
  response_hash: string | null;
  provider_finish_reason: string | null;
}

const batchRows = new Map<string, BatchRow>();
let corruptStoredResponse = false;

const batchExecute: Execute = async (statement, rawParams) => {
  const params = rawParams as Array<string | number | null>;
  const normalized = String(statement).replace(/\s+/g, " ").trim();
  if (normalized.startsWith("INSERT INTO analysis_behavior_batch_requests")) {
    const key = String(params[2]);
    if (batchRows.has(key)) throw dupError();
    batchRows.set(key, {
      request_key: key,
      run_id: Number(params[0]),
      batch_attempt_uuid: String(params[1]),
      request_stage: String(params[3]),
      request_sequence: Number(params[4]),
      request_fingerprint: String(params[5]),
      describe_response_hash: (params[6] as string | null) ?? null,
      provider_request_id: null,
      request_outcome: "prepared",
      failure_class: null,
      raw_response: null,
      response_byte_length: null,
      stored_byte_length: null,
      response_hash: null,
      provider_finish_reason: null,
    });
    return [{ insertId: batchRows.size }];
  }
  if (normalized.startsWith("SELECT request_key") && normalized.includes("FROM analysis_behavior_batch_requests")) {
    const row = batchRows.get(String(params[0]));
    return [row ? [{ ...row }] : []];
  }
  if (normalized.startsWith("SELECT raw_response") && normalized.includes("FROM analysis_behavior_batch_requests")) {
    const row = batchRows.get(String(params[0]));
    return [row && row.request_outcome === "response_received" ? [{ ...row }] : []];
  }
  if (normalized.startsWith("UPDATE analysis_behavior_batch_requests SET request_outcome = 'dispatch_started'")) {
    const row = batchRows.get(String(params[0]));
    if (!row || row.request_outcome !== "prepared") return [{ affectedRows: 0 }];
    row.request_outcome = "dispatch_started";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'response_received'")) {
    const row = batchRows.get(String(params[2]));
    if (!row || row.request_outcome !== "dispatch_started") return [{ affectedRows: 0 }];
    row.request_outcome = "response_received";
    row.provider_request_id = (params[0] as string | null) ?? row.provider_request_id;
    row.provider_finish_reason = (params[1] as string | null) ?? row.provider_finish_reason;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET raw_response = ?")) {
    const row = batchRows.get(String(params[4]));
    if (!row || row.request_outcome !== "response_received") return [{ affectedRows: 0 }];
    const raw = params[0] as string;
    row.raw_response = corruptStoredResponse ? raw.slice(0, 10) : raw;
    row.response_byte_length = Number(params[1]);
    row.stored_byte_length = Number(params[2]);
    row.response_hash = String(params[3]);
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'response_persisted'")) {
    const row = batchRows.get(String(params[0]));
    if (!row || row.request_outcome !== "response_received") return [{ affectedRows: 0 }];
    row.request_outcome = "response_persisted";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'persistence_failed'")) {
    const row = batchRows.get(String(params[0]));
    if (!row || row.request_outcome !== "response_received") return [{ affectedRows: 0 }];
    row.request_outcome = "persistence_failed";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'confirmed_not_sent'")) {
    const row = batchRows.get(String(params[0]));
    if (!row || row.request_outcome !== "prepared") return [{ affectedRows: 0 }];
    row.request_outcome = "confirmed_not_sent";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'failed'")) {
    const row = batchRows.get(String(params[1]));
    if (!row || !["prepared", "dispatch_started"].includes(row.request_outcome)) return [{ affectedRows: 0 }];
    row.request_outcome = "failed";
    row.failure_class = (params[0] as string | null) ?? null;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'outcome_unknown'")) {
    const row = batchRows.get(String(params[0]));
    if (!row || row.request_outcome !== "dispatch_started") return [{ affectedRows: 0 }];
    row.request_outcome = "outcome_unknown";
    return [{ affectedRows: 1 }];
  }
  throw new Error(`unexpected batch statement: ${statement}`);
};

function beginDescribe(sequence = 1): Promise<Awaited<ReturnType<typeof beginBatchRequest>>> {
  return beginBatchRequest(batchExecute, {
    runId: RUN_ID,
    batchAttemptUuid: ATTEMPT,
    requestStage: "describe",
    requestSequence: sequence,
    requestFingerprint: FINGERPRINT,
  });
}

describe("batch request lifecycle (Task 4)", () => {
  beforeEach(() => {
    batchRows.clear();
    receiptRows.length = 0;
    failReceiptInsert = null;
    corruptStoredResponse = false;
    receiptState.router = receiptRouter;
  });

  it("prepared request does not prove dispatch and missing response does not prove not sent", async () => {
    const request = await beginDescribe();
    expect(request.requestKey).toBe(`${ATTEMPT}|describe|1`);
    expect(request.requestOutcome).toBe("prepared");
    // prepared 仍未派发：有证据未发出时允许 confirmed_not_sent
    await markBatchRequestOutcome(batchExecute, { requestKey: request.requestKey, outcome: "confirmed_not_sent" });
    const settled = await loadBatchRequest(batchExecute, request.requestKey);
    expect(settled?.requestOutcome).toBe("confirmed_not_sent");
    // 但 dispatch_started 之后没有响应不能反推未发送：confirmed_not_sent 被拒绝
    const second = await beginDescribe(2);
    await markBatchRequestDispatchStarted(batchExecute, second.requestKey);
    await expect(
      markBatchRequestOutcome(batchExecute, { requestKey: second.requestKey, outcome: "confirmed_not_sent" }),
    ).rejects.toMatchObject({ code: "execution_batch_request_state" });
  });

  it("dispatch started without response becomes outcome unknown rather than confirmed not sent", async () => {
    const request = await beginDescribe();
    await markBatchRequestDispatchStarted(batchExecute, request.requestKey);
    await markBatchRequestOutcome(batchExecute, { requestKey: request.requestKey, outcome: "outcome_unknown" });
    const settled = await loadBatchRequest(batchExecute, request.requestKey);
    expect(settled?.requestOutcome).toBe("outcome_unknown");
    // outcome_unknown 是终态：不得再改写
    await expect(
      markBatchRequestOutcome(batchExecute, { requestKey: request.requestKey, outcome: "failed", failureClass: "transport_failure" }),
    ).rejects.toMatchObject({ code: "execution_batch_request_state" });
  });

  it("received response cannot be parsed before persistence and readback verification", async () => {
    const request = await beginDescribe();
    // prepared 阶段没有可持久化的响应：不得跳过 dispatch 直接持久化
    await expect(
      persistBatchResponse(batchExecute, { requestKey: request.requestKey, rawResponse: "{\"ok\":true}", providerFinishReason: "stop" }),
    ).rejects.toMatchObject({ code: "execution_batch_request_state" });
    await markBatchRequestDispatchStarted(batchExecute, request.requestKey);
    const persisted = await persistBatchResponse(batchExecute, {
      requestKey: request.requestKey,
      rawResponse: "{\"ok\":true}",
      providerRequestId: "gw-1",
      providerFinishReason: "stop",
    });
    expect(persisted.requestOutcome).toBe("response_persisted");
    expect(persisted.providerRequestId).toBe("gw-1");
    expect(persisted.providerFinishReason).toBe("stop");
  });

  it("persists exact response bytes and verifies readback hash", async () => {
    const request = await beginDescribe();
    await markBatchRequestDispatchStarted(batchExecute, request.requestKey);
    const raw = "{\"regions\":[{\"id\":\"R1\",\"facts\":\"中文🎉\"}]}";
    const persisted = await persistBatchResponse(batchExecute, { requestKey: request.requestKey, rawResponse: raw });
    const byteLength = Buffer.byteLength(raw, "utf8");
    expect(persisted.responseByteLength).toBe(byteLength);
    expect(persisted.storedByteLength).toBe(byteLength);
    expect(persisted.responseHash).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
    expect(persisted.requestOutcome).toBe("response_persisted");
  });

  it("rejects oversized truncated or mismatched stored responses", async () => {
    const oversized = await beginDescribe(1);
    await markBatchRequestDispatchStarted(batchExecute, oversized.requestKey);
    await expect(
      persistBatchResponse(batchExecute, { requestKey: oversized.requestKey, rawResponse: "x".repeat(MAX_BATCH_RESPONSE_BYTES + 1) }),
    ).rejects.toMatchObject({ code: "execution_batch_response_persistence_failed" });
    expect((await loadBatchRequest(batchExecute, oversized.requestKey))?.requestOutcome).toBe("persistence_failed");

    corruptStoredResponse = true;
    const mismatched = await beginDescribe(2);
    await markBatchRequestDispatchStarted(batchExecute, mismatched.requestKey);
    await expect(
      persistBatchResponse(batchExecute, { requestKey: mismatched.requestKey, rawResponse: "{\"ok\":true}" }),
    ).rejects.toMatchObject({ code: "execution_batch_response_persistence_failed" });
    expect((await loadBatchRequest(batchExecute, mismatched.requestKey))?.requestOutcome).toBe("persistence_failed");
  });

  it("marks failed with a required failure class from prepared or dispatch started", async () => {
    const fromPrepared = await beginDescribe(1);
    await expect(
      markBatchRequestOutcome(batchExecute, { requestKey: fromPrepared.requestKey, outcome: "failed" }),
    ).rejects.toThrow(/failure_class/);
    await markBatchRequestOutcome(batchExecute, { requestKey: fromPrepared.requestKey, outcome: "failed", failureClass: "local_pre_dispatch" });
    expect((await loadBatchRequest(batchExecute, fromPrepared.requestKey))?.failureClass).toBe("local_pre_dispatch");
    const fromDispatch = await beginDescribe(2);
    await markBatchRequestDispatchStarted(batchExecute, fromDispatch.requestKey);
    await markBatchRequestOutcome(batchExecute, { requestKey: fromDispatch.requestKey, outcome: "failed", failureClass: "provider_rejected" });
    expect((await loadBatchRequest(batchExecute, fromDispatch.requestKey))?.failureClass).toBe("provider_rejected");
  });
});

describe("batch receipt idempotency and reconciliation (Task 4)", () => {
  beforeEach(() => {
    batchRows.clear();
    receiptRows.length = 0;
    failReceiptInsert = null;
    receiptState.router = receiptRouter;
  });

  function receiptInput(overrides: Partial<Parameters<typeof reconcileBatchRequestReceipt>[0]> = {}): Parameters<typeof reconcileBatchRequestReceipt>[0] {
    return {
      runId: RUN_ID,
      accountId: 1,
      chargeComponent: "main",
      callKind: "batch",
      attemptId: ATTEMPT,
      callStage: "describe",
      model: "test-model",
      outcome: "success",
      usageRaw: { prompt_tokens: 10, completion_tokens: 5 },
      providerRequestId: "gw-1",
      durationMs: 1500,
      requestKey: `${ATTEMPT}|describe|1`,
      requestFingerprint: FINGERPRINT,
      ...overrides,
    };
  }

  it("deduplicates only the same actual request receipt", async () => {
    expect(await reconcileBatchRequestReceipt(receiptInput())).toBe("inserted");
    // 同 request_key + 同 fingerprint 的重复投递 → no-op，不产生第二行
    expect(await reconcileBatchRequestReceipt(receiptInput())).toBe("noop");
    expect(receiptRows).toHaveLength(1);
  });

  it("does not deduplicate different stages or sequences", async () => {
    await reconcileBatchRequestReceipt(receiptInput());
    await reconcileBatchRequestReceipt(receiptInput({ requestKey: `${ATTEMPT}|judge|1`, callStage: "judge" }));
    await reconcileBatchRequestReceipt(receiptInput({ requestKey: `${ATTEMPT}|describe|2`, providerRequestId: "gw-2" }));
    expect(receiptRows).toHaveLength(3);
    expect(new Set(receiptRows.map((row) => row.request_key)).size).toBe(3);
  });

  it("allows monotonic unknown to known usage reconciliation but rejects overwrite", async () => {
    // 先落一条 unknown（provider id 缺失、token 未知）
    await reconcileBatchRequestReceipt(receiptInput({ usageRaw: null, providerRequestId: null, durationMs: null }));
    expect(receiptRows[0]?.usage_status).toBe("unknown");
    // 查到真实 usage/provider id → 单调补全
    expect(await reconcileBatchRequestReceipt(receiptInput())).toBe("reconciled");
    expect(receiptRows[0]?.usage_status).toBe("known");
    expect(receiptRows[0]?.input_tokens).toBe(10);
    expect(receiptRows[0]?.provider_request_id).toBe("gw-1");
    expect(receiptRows[0]?.duration_ms).toBe(1500);
    // 已知值被不同值覆盖 → 账务冲突（不得 last-write-wins）
    await expect(
      reconcileBatchRequestReceipt(receiptInput({ usageRaw: { prompt_tokens: 99, completion_tokens: 5 } })),
    ).rejects.toThrow(/llm receipt conflict/);
    // duration 观测取第一次记录：相同 usage 的重复回执不改写
    expect(await reconcileBatchRequestReceipt(receiptInput({ durationMs: 9999 }))).toBe("noop");
    expect(receiptRows[0]?.duration_ms).toBe(1500);
    // 指纹不同 = 不同实际请求，不得复用同一 request key
    await expect(
      reconcileBatchRequestReceipt(receiptInput({ requestFingerprint: "e".repeat(64) })),
    ).rejects.toThrow(/llm receipt conflict/);
  });

  it("keeps legacy best-effort semantics while surfacing duplicate conflicts", async () => {
    await reconcileBatchRequestReceipt(receiptInput());
    // 重复同一请求且内容一致 → no-op（不冲突）
    expect(await reconcileBatchRequestReceipt(receiptInput())).toBe("noop");
    // 已知 provider id 与新值冲突 → 明确失败
    await expect(
      reconcileBatchRequestReceipt(receiptInput({ providerRequestId: "gw-other" })),
    ).rejects.toThrow(/llm receipt conflict/);
    // 非重复的普通写失败仅告警（batch_requests 权威 + 保守结算兜底）
    failReceiptInsert = "error";
    expect(
      await reconcileBatchRequestReceipt(receiptInput({ requestKey: `${ATTEMPT}|judge|9`, callStage: "judge" })),
    ).toBe("noop");
    expect(receiptRows).toHaveLength(1);
  });
});

describe("batch request begin idempotency (Task 4)", () => {
  beforeEach(() => {
    batchRows.clear();
    receiptRows.length = 0;
    receiptState.router = receiptRouter;
  });

  it("re-begin with the same fingerprint returns the prepared row instead of duplicating", async () => {
    const first = await beginDescribe();
    const second = await beginDescribe();
    expect(second.requestKey).toBe(first.requestKey);
    expect(second.requestOutcome).toBe("prepared");
    expect(batchRows.size).toBe(1);
    // 同 key 不同指纹 = 契约冲突
    await expect(
      beginBatchRequest(batchExecute, {
        runId: RUN_ID,
        batchAttemptUuid: ATTEMPT,
        requestStage: "describe",
        requestSequence: 1,
        requestFingerprint: "e".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "execution_batch_receipt_conflict" });
  });
});

describe("execution batch error typing (Task 4)", () => {
  it("exposes codes as ExecutionBatchError instances", () => {
    const error = new ExecutionBatchError("execution_batch_request_state", "bad transition");
    expect(error.code).toBe("execution_batch_request_state");
    expect(error.name).toBe("ExecutionBatchError");
  });
});
