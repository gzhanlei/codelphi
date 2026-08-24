# PPTCreator Partner 接口契约 v1

> 这是 CoDelphi 网关 ↔ PPTCreator 之间的**唯一接缝文档**（通用语义见 `CONTRACT-partner.md`）。双方实现与验收以本文档为准；
> 变更走设计文档评审轮（`DESIGN-b2b-capability-platform.md`），改完同步本文档版本号。
> PPTCreator 侧工单（GitHub Issue）直接引用本文档条目号（C1、C2…）。
>
> 依据：设计文档 §2.1 Partner 通则、§8 改造清单。v1.2 · 2026-08-24（C2 切到 MCP `create_ppt_from_documents`；方向二 / REST `/generate` 废弃）。

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

P0 入参走 PPTCreator MCP **`create_ppt_from_documents`**（方向一，材料包）。网关 **不** 调 `create_ppt_from_text` / `create_ppt_from_document`，也 **不** 发 REST `POST /generate`（PPTCreator 无此路由，partner 入口只有 `POST {base}/mcp`）。

```
POST {partner_base}/mcp
Headers: C1 四个头 + Accept: application/json, text/event-stream
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_ppt_from_documents",
    "arguments": {
      "title": "章标题",
      "documents": [
        { "role": "textbook",         "name": "课文",     "content": "……至少 10 字" },
        { "role": "teaching_design",  "name": "课程设计", "content": "……当前 design 构件 JSON" },
        { "role": "reference",        "name": "材料 2",   "content": "……其余材料" },
        { "role": "reference",        "name": "大纲",     "content": "……当前 outline 构件 JSON" }
      ],
      "note":     "可选，教师补充说明（首轮做课）",
      "critique": "可选，返工意见（Rebuild）"
    }
  }
}
→ 200 MCP result.content[0].text = { "project_id": "...", "status": "queued" }
```

查询：同一入口 `tools/call` `get_generation_status` `{ "project_id" }`。终态 `COMPLETED` / `FAILED`（不是 REST 的 succeeded/failed）。讲稿 JSON 为 `{ "pages": [{ "page", "notes" }] }`。

- `documents[]`：1–5 项；**恰好一份** `role=textbook`；其余为 `teaching_design` 或 `reference`
- 每项 `content` 与 `document_id` 二选一；网关 P0 只走 `content`（min 10 字符），不传 `document_id`
- 网关组装：第一份项目材料 → `textbook`；当前 `design` artifact → `teaching_design`；其余材料与 `outline` → `reference`。超额截断时保 textbook + teaching_design
- `note`/`critique` 为工具顶层字段（不是嵌套 `spec`），必须进入生成提示词，不得丢弃

## C3. 状态查询（Query）

PPTCreator 实例：`POST {base}/mcp` `tools/call` `get_generation_status` `{ "project_id" }`。字段语义如下（终态枚举在 PPTCreator 为 `COMPLETED`/`FAILED`，网关按此映射）。

```
→ {
    "status":   "COMPLETED|FAILED|GENERATING|…",
    "error":    { "code": "...", "message": "..." },   // 仅 FAILED
    "usage":    { "pages": 12, "llm_tokens": 83421 },  // 仅 COMPLETED
    "cost":     { "currency": "CNY", "vendor_cost": "1.234000" },
    "result":   { "pptx_url": "...", "notes_url": "...", "script_url": "..." }
  }
```

- `usage.llm_tokens` 必须回报——没有这条 PPT 毛利是盲的
- **`usage.pages` = 产出 pptx 的实际页数**（C4 的讲稿页数对齐校验以此为基准）。pages 缺省或为 0 时，codelphi 侧过渡期只校验 notes 非空、跳过对齐；但 partner 必须回报真实页数，长期不设例外
- 下载 URL 为预签名 GET，**TTL ≥ 网关轮询周期上限**（现 PPTCreator 默认 300s，需对齐到网关可配置值）；网关拿到后**回拷本侧对象存储**，不向教师转手平台临时链

## C4. 讲稿回报（硬约束，对应 §8 第 9 条）

- 完成响应必须带**逐页 notes**（JSON `{pages:[{page,notes}]}`，与页数严格对齐），可选附整份 script docx
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
