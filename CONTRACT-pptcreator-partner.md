# PPTCreator Partner 接口契约 v1

> 这是 codelphi 网关 ↔ PPTCreator 之间的**唯一接缝文档**。双方实现与验收以本文档为准；
> 变更走设计文档评审轮（`DESIGN-b2b-capability-platform.md`），改完同步本文档版本号。
> PPTCreator 侧工单（GitHub Issue）直接引用本文档条目号（C1、C2…）。
>
> 依据：设计文档 §2.1 Partner 通则、§8 改造清单。v1.1 · 2026-08-24（codelphi 侧 M3 实现后澄清：spec.note/critique、usage.pages 口径、上下文头适用全部端点）。

## C0. 角色

- codelphi 网关是**唯一调用方**（partner 身份）；终端教师永不直接接触 PPTCreator
- PPTCreator C 端站点逻辑零改动；partner 流量 = 纯机构流量，worker 只认 partner 上下文
- partner 流量跳过 PPTCreator 全部 C 端计费：入口 `checkUserCredits` 预检、worker `deductCreditsGuarded` 实扣、`downloadLocked` 下载锁，**三处全部旁路**

## C1. 认证与上下文

| 头 | 值 | 说明 |
|---|---|---|
| `X-Partner-Key` | 共享密钥 | 服务账号认证；支持双 key 轮换窗口；mTLS 留作后续升级 |
| `X-Org-Id` | codelphi org id | 记账与隔离用，PPTCreator 只做透传与日志 |
| `X-Member-Id` | codelphi member id | 同上 |
| `X-Job-Id` | 网关 step job id | 幂等键：同一 `X-Job-Id` 重复提交不得重复生成 |

partner key 不出仓库、不进日志正文；泄露即轮换。**四个头适用于所有 partner 端点**（含 C3 的查询）——PPTCreator 侧按 org 做隔离校验时以这些头为准。

## C2. 提交生成（Submit）

P0 入参（方向二过渡期，单文档）：

```
POST {partner_base}/generate
{
  "job_id":      "网关 step job id（同 C1 头）",
  "title":       "章标题",
  "document":    { "kind": "text", "text": "预合成后的单份材料" },
  "spec": {
    "style":         "可选，风格 preset",
    "language":      "可选，默认按材料检测",
    "target_slides": "可选页数",
    "notes_required": true,
    "note":          "可选，教师补充说明（学时/专业/风格等，首轮做课时传入）",
    "critique":      "可选，返工意见（Rebuild 时传入，与 note 二选一）"
  }
}
→ 202 { "platform_job_id": "..." }
```

- **多文档（方向一）**：PPTCreator 侧 Document 1:N 落地后，`document` 改为 `documents[]`，每份带 `role`（`textbook`/`teaching_design`/`reference`）。v1 合同预留该字段，P0 不启用
- `note`/`critique` 必须进入生成提示词，不得丢弃——返工意见到不了生成端等于返工没做

## C3. 状态查询（Query）

```
GET {partner_base}/jobs/{platform_job_id}
→ {
    "status":   "queued|running|succeeded|failed",
    "progress": 0-100,
    "error":    { "code": "...", "message": "..." },   // 仅 failed 时
    "usage":    { "pages": 12, "llm_tokens": 83421 },  // 仅 succeeded 时
    "cost":     { "currency": "CNY", "vendor_cost": "1.234000" },
    "result":   { "pptx_url": "...", "notes_url": "...", "script_url": "..." }
  }
```

- `usage.llm_tokens` 必须回报——没有这条 PPT 毛利是盲的
- **`usage.pages` = 产出 pptx 的实际页数**（C4 的讲稿页数对齐校验以此为基准）。pages 缺省或为 0 时，codelphi 侧过渡期只校验 notes 非空、跳过对齐；但 partner 必须回报真实页数，长期不设例外
- 下载 URL 为预签名 GET，**TTL ≥ 网关轮询周期上限**（现 PPTCreator 默认 300s，需对齐到网关可配置值）；网关拿到后**回拷本侧对象存储**，不向教师转手平台临时链

## C4. 讲稿回报（硬约束，对应 §8 第 9 条）

- 完成响应必须带**逐页 notes**（JSON，与页数严格对齐），可选附整份 script docx
- 现状需改：现行 MCP `get_generation_status` 无讲稿字段；worker 讲稿 docx 失败是 `console.warn` 后继续成功
- **notes 为空或页数不齐 = job failed**（`error.code = "notes_missing"`），不得标成功——数字人链与套件「讲稿」构件都以此为合法输入

## C5. 行为不变量（对应 §8 第 1–8 条）

1. partner 认证后请求上下文带 org/member/job，worker 只认此上下文，不用 userId 白名单
2. 旁路 MCP 入口 credits 预检
3. 旁路 worker 实扣与下载锁
4. 用量/成本按 C3 回报
5. partner 不按人限流；保留 `partner:{orgId}` 全局护栏
6. `Project.source=partner` + `orgId`，C 端 dashboard 列表默认 `source IS NULL`
7. 下载鉴权校验调用方仍是该机构成员（经网关转发时由网关校验；URL TTL 对齐 C3）
8. partner 流量拒绝/忽略单页重生 API（成本护栏）

## C6. 验收测试（partner 模式完工定义）

打一条 partner 生成，断言全部成立：

- `UserProfile.freeCreditsRemaining` 不变
- `downloadLocked = false`
- 网关 `UsageRecord` settled，`vendor_cost` 与 C3 回报一致
- C 端 dashboard 不可见该记录
- 讲稿非空且页数与 pptx 对齐

## C7. 错误面

partner 接口错误返回结构化 JSON：`{ "error": { "code", "message", "retryable" } }`。
网关侧映射：adapter 超时/5xx → 该 step failed（不升级为 `billing_unavailable`）；`retryable=true` 由网关按新 job 重试。
