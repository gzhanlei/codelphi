# PPTCreator Partner 接口契约 v1

> 这是 CoDelphi 网关 ↔ PPTCreator 之间的**唯一接缝文档**（通用语义见 `CONTRACT-partner.md`）。双方实现与验收以本文档为准；
> 变更走设计文档评审轮（`DESIGN-b2b-capability-platform.md`），改完同步本文档版本号。
> PPTCreator 侧工单（GitHub Issue）直接引用本文档条目号（C1、C2…）。
>
> 依据：设计文档 §2.1 Partner 通则、§8 改造清单。v1.8 · 2026-08-25（C8.3：做片必须在 `writeSpeechV2` / `htmlOutline` 后停住，把课件大纲交给网关对照教案，通过后再烧 HTML+PPTX。对照不得等整份 pptx 做完）。

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
      "style": "editorial-bone",
      "documents": [
        { "role": "textbook",         "name": "课文.pdf", "url": "https://app.codelphi.com/media/.../课文.pdf?exp=&sig=" },
        { "role": "teaching_design",  "name": "教案.md", "content": "# 教案\\n..." },
        { "role": "reference",        "name": "材料 2.docx", "url": "https://app.codelphi.com/media/.../材料2.docx?exp=&sig=" }
      ],
      "stage":    "outline",
      "note":     "可选，教师补充说明（首轮做课件）",
      "critique": "可选，返工意见（大纲对不上教案时重排页）",
      "confirmed_outline": [ { "order": 1, "type": "COVER", "title": "导数" } ]
    }
    }
  }
}
→ 200 MCP result.content[0].text = { "project_id": "...", "status": "queued" }
```

查询：同一入口 `tools/call` `get_generation_status` `{ "project_id" }`。终态 `OUTLINE_READY` / `COMPLETED` / `FAILED`（不是 REST 的 succeeded/failed）。讲稿 JSON 为 `{ "pages": [{ "page", "notes" }] }`。

- `documents[]`：1–5 项；**恰好一份** `role=textbook`；其余为 `teaching_design` 或 `reference`
- 每项 `content` / `url` / `document_id` **三选一**：
  - `url`：短 TTL 签名 GET，指向教师上传的原文件（pdf/docx/md/txt）。网关 **不** 预抽文本；PPTCreator 拉文件后用自己的解析器抽文本
  - `content`：UTF-8 纯文本，min 10 字符。网关用来传本侧 **教案**（`role=teaching_design`）。不要把课件大纲 JSON 或网关自造的「课程教学大纲」冒充教案
  - `document_id`：PPTCreator 已上传并解析完成的文档（网关 P0 不用）
- 网关组装：课材料 → `textbook` / `reference`（文件走 `url`）；本侧教案 → `teaching_design`（markdown `content`）。**先写教案，再做片。** 首轮做片走 C8.3 `stage=outline`，对照通过后再 `stage=pptx` + `confirmed_outline`
- `teaching_design` 必须约束 **页分配 / 讲稿**（`writeSpeechV2`：教材默认 lecture-writer 的 `generateLectureScript` / `deriveSlideSpecs`；highlight-first 的 select / allocate），**不得只进 ContentAnalyst**。ContentAnalyst 继续把教案当结构约束、禁从教案抽话题
- `note`/`critique` 为工具顶层字段（不是嵌套 `spec`），必须进入生成提示词，不得丢弃。大纲对不上教案时，网关带 `critique` **只重跑编排**（C8.3 `stage=outline`，新 `X-Job-Id`，**不**把跑偏大纲锁进 `confirmed_outline`）
- `style`：网关固定传 `editorial-bone`（课件默认皮肤，canonical preset；**不要**传 family 裸名 `editorial`，也不要省略——对方缺省是 `swiss-ikb`，叠 editorial 回退就是四不像）
- `stage` / `confirmed_outline`：见 C8。网关首轮做片发 `stage=outline`，对照通过后再发 `stage=pptx` + `confirmed_outline` + `project_id`。缺 `stage` 的旧调用方过渡期按一次出齐 `pptx`

## C3. 状态查询（Query）

PPTCreator 实例：`POST {base}/mcp` `tools/call` `get_generation_status` `{ "project_id" }`。字段语义如下（终态枚举在 PPTCreator 为 `OUTLINE_READY`/`COMPLETED`/`FAILED`，网关按此映射）。

```
→ {
    "status":   "OUTLINE_READY|COMPLETED|FAILED|GENERATING|…",
    "error":    { "code": "...", "message": "..." },   // 仅 FAILED
    "usage":    { "pages": 12, "llm_tokens": 83421 },  // OUTLINE_READY 与 COMPLETED
    "cost":     { "currency": "CNY", "vendor_cost": "1.234000" },
    "result":   { "pptx_url": "...", "notes_url": "...", "script_url": "...", "outline_url": "..." }
  }
```

- `OUTLINE_READY`（C8.3）：`result.outline_url` 必有；**不得**带 `pptx_url`。`usage.pages` = 大纲 `slides.length`。`writeSpeechV2` 已有逐页讲稿时应带 `notes_url`（形同 C4），便于网关对照教学过程/讲授稿；没有 notes 时网关只对照页标题 vs 教学重点
- `COMPLETED`：C8.1 + C4，必须带 pptx / notes / outline

- `usage.llm_tokens` 必须回报——没有这条 PPT 毛利是盲的
- **`usage.pages`**：`OUTLINE_READY` 时 = 大纲页数；`COMPLETED` 时 = 产出 pptx 的实际页数（C4 的讲稿页数对齐校验以此为基准）。pages 缺省或为 0 时，codelphi 侧过渡期只校验 notes 非空、跳过对齐；但 partner 必须回报真实页数，长期不设例外
- 下载 URL 为预签名 GET，**TTL ≥ 网关轮询周期上限**（现 PPTCreator 默认 300s，需对齐到网关可配置值）；网关拿到后**回拷本侧对象存储**，不向教师转手平台临时链

## C4. 讲稿回报（硬约束，对应 §8 第 9 条）

- 完成响应必须带**逐页 notes**（JSON `{pages:[{page,notes}]}`，与页数严格对齐），可选附整份 script docx
- **notes 为空或页数不齐 = job failed**（`error.code = "notes_missing"`），不得标成功——数字人链与套件「讲稿」构件都以此为合法输入
- 网关回拷：`notes_url` → 本侧 `script-vN.json`（校验用，可作数字人输入）；有 `script_url` 时当前「讲稿」构件指向 `script-vN.docx`（教师下载）

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
- **课件大纲非空且 slides.length = usage.pages**（C8.1；C8.3 的 `OUTLINE_READY` 同样）
- `stage=outline`：终态 `OUTLINE_READY`，有大纲、无 pptx，未跑 HTML 排版 / Playwright
- 大纲对不上教案后再打 `stage=outline` + `critique`：新大纲，仍无 pptx
- 对照通过后同 `project_id` `stage=pptx` + `confirmed_outline`：终态 `COMPLETED`，pptx/notes/outline 齐；不得再自由编排
- 带 `confirmed_outline` 再生成：页序/标题与提交大纲一致（允许 COVER/BACK_COVER 结构不变量修正），不得丢弃该字段

## C7. 错误面

partner 接口错误返回结构化 JSON：`{ "error": { "code", "message", "retryable" } }`。
网关侧映射：adapter 超时/5xx → 该 step failed（不升级为 `billing_unavailable`）；`retryable=true` 由网关按新 job 重试。
`notes_missing` / `outline_missing` → 该 step failed，预扣退回。`OUTLINE_READY` 缺大纲同样 `outline_missing`。

## C8. 课件大纲交回 / 写回 / 停住（2026-08-25）

PPTCreator 提供做片，不提供做课件。C 端已有 `/html-outline`（`ConfirmedOutlineSlide[]`，可 `source=generated-deck`）。Partner 路径必须把同一份结构交回网关，并在再生成时吃回来。入口仍是 `POST {base}/mcp`，不另开 REST。

课件大纲在 **`writeSpeechV2` 写完 `htmlOutline` 时已经冻住**（worker `html-export.ts` 的 `writeBackHtmlOutline`，在 `generateHtmlSlidesV2` / Playwright 之前）。教学对错必须在这一层判，不能等 HTML+PPTX 烧完。C8.1/C8.2 已落地（工单 **#125**）；C8.3 停住握手见 **#127**。

**C8.1 交回（硬约束）**

- `get_generation_status` COMPLETED 的 `result` 必须带 `outline_url`（预签名 GET，TTL 同 C3），或等价的内联 `outline` 对象。网关回拷为本侧 `outline` 构件。
- JSON 与 C 端 `htmlOutline.slides` / `ConfirmedOutlineSlide` 同形：

```
{
  "source": "generated-deck",
  "slides": [
    { "order": 1, "type": "COVER", "title": "…", "chapter": "…", "topicId": null, "sourcePreview": "…", "highlightIds": [] }
  ]
}
```

`type` 枚举：`COVER` | `CONTENT` | `SECTION_HEADER` | `BACK_COVER` | `QUOTE`。`slides.length` 必须等于 `usage.pages`。
- **大纲缺失、空 slides、或与页数不齐 = job failed**（`error.code = "outline_missing"`），不得标成功。不得只交 pptx。

**C8.2 写回（硬约束）**

- `create_ppt_from_documents` 增加可选顶层 `confirmed_outline`（与上表 `slides` 同形的数组，或带 `slides` 的对象）。有则写入 worker `ctx.confirmedOutline`（C 端已有路径：跳过自由编排、以用户/网关确认的页序为准），**不得丢弃**。
- `highlightIds` / `topicId` / `sourcePreview` 原样透传；网关改过标题/增删/调序后可能没有这些字段，partner 按 C 端「新增页无 topicId」兜底。
- 同一 `X-Job-Id` 幂等语义同 C1。

**C8.3 大纲阶段停住（硬约束）**

做片必须能在 `writeSpeechV2` 产出 `spokenSlidesV2` / `htmlOutline` 之后、`generateHtmlSlidesV2` 与 Playwright PPTX **之前**停住，把大纲交给网关对照教案。不得把 ContentAnalyst 当课件结构（话题 ≠ 页）；不得在 SlideDesigner / HTML / PPTX 层再判教学。

`create_ppt_from_documents` 增加顶层 `stage`：`"outline"` | `"pptx"`。

| `stage` | worker 停在 | `get_generation_status` 终态 | `result` |
|---|---|---|---|
| `outline` | `writeBackHtmlOutline` 之后 | `OUTLINE_READY` | 必有 `outline_url`（形同 C8.1；`source` 可为 `planned` 或 `generated-deck`）；尽量带 `notes_url`；**禁止** `pptx_url`；禁止 HTML 排版与渲染 |
| `pptx` | 现有完整管线终点 | `COMPLETED` | C8.1 + C4（pptx / notes / outline） |

缺 `stage` 时过渡期按 `pptx`，兼容未改的调用方。**网关主路径已切** outline → 对照 → pptx。若对方忽略 `stage` 仍一次出齐 `COMPLETED`（带 `pptx_url`），网关按旧对照兜底，便于 PPTCreator #127 落地后只改对方即可联调。

握手：

1. 网关提交课本 + `teaching_design`，`stage=outline`，无 `confirmed_outline`。Partner 自行编排（吃教案的页分配/讲稿约束）。
2. 网关用教案对照大纲（教学重点是否落页、教学过程是否被页序覆盖）。空大纲不是偏差，是对方没交。
3. **对不上**：再提交 `stage=outline` + `critique`，新 `X-Job-Id`，**不**带跑偏的 `confirmed_outline`。只重跑 `writeSpeechV2`（ContentAnalyst 有 cache 则跳过）。仍不出 pptx。
4. **对得上**：同一 `project_id` 提交 `stage=pptx` + `confirmed_outline`（刚交回的那份）。**跳过** ContentAnalyst 与 `writeSpeechV2`，从 pipeline cache / 已确认 `htmlOutline` 接着 `generateHtmlSlidesV2` → fit-loop → Playwright。不得再自由改页序。

实现也可拆成 `plan_ppt_from_documents` + 现有 create；语义必须与上表相同。C 端已有 `from-analysis` / pipeline cache，优先复用，不要另造一条排版管线。

教材默认 lecture-writer：对照页标题用 `deriveSlideSpecs` 即够；对照教学过程/讲授稿需要 `generateLectureScript` 的逐页讲稿。highlight-first：停在 `allocate`，不要等到 `page-content`。

**C 端 `/html-outline` 表单不改。** 教师不登录 PPTCreator。
