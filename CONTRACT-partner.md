# CoDelphi Partner 接入合同 v1

> 给**其他能力提供方**的接缝文档。网关 ↔ 你的平台之间只认这一份语义；路径名可以和 PPTCreator 不同，语义不能另起一套闸门。
>
> PPTCreator 是第一份填好的实例，细节见 `CONTRACT-pptcreator-partner.md`（C0–C8）。新平台复制文末检查表，**缺一格就不能标「已接入」**。
>
> 依据：设计文档 §2.1 Partner 通则、§15 C.1–C.4。v1 · 2026-08-24。
> 变更走设计评审，改完同步本文档版本号。

## 0. 你在接什么

CoDelphi 卖给机构的是**预设包**（一套产物），不是你的 2C 产品。教师只看见工作台；**永远不登录你的站点、不拿你的 OAuth、不持有你的 key**。

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| 教师 / 工作台 | 上传材料、点主按钮、确认、下载本侧产物 | 直连你 |
| CoDelphi 网关 | 唯一调用方；authorize/settle；回拷产物到本侧存储 | 把你的临时 URL 转手给教师 |
| 你的平台 | 按服务账号执行一次生成，回报成本与产物指针 | 收教师 token、扣自家 2C 积分、把机构稿件露在个人 dashboard |

网关后面是 `internal/execution/adapters/<你>`。教师侧 MCP 只挂网关，工具名按 **capability**（如 `ppt`），不按平台品牌。平台故障或换路由，教师看见的名字不变。

P0 已接：`ppt`+`script`+课件大纲（PPTCreator，大纲见 C8）。网关自造 `design`/`outline` LLM **已撤回**（设计 §2.4）。下一批候选：数字人成片、AI3D、OpenMAIC——接之前先定 §2 的 `job_kind`。

## 1. 角色与不变量

1. **唯一调用方是网关。** 你禁止再向教师、DSH、工作台要 Chandler / 网关用户 token。
2. **partner 流量 = 纯机构流量。** 走服务账号，不走你现有的「登录用户生成」主路径。
3. **渠道即账本。** 机构配额只在网关扣。你的 C 端积分、下载锁、按人日限额，对 partner 请求必须旁路。缺这一条，机构活会记到员工个人账上。
4. **一次网关 step job = 一次你侧生成。** 幂等键是网关传入的 `X-Job-Id`。同一 id 重复提交不得再跑一遍。重试由网关开**新** job（新 id）。
5. **失败隔离。** 你超时 / 5xx → 该 step failed，预扣退回。不要让网关把整站标成 `billing_unavailable`（那只表示网关自己的账本挂了）。
6. **并发护栏。** 网关按 `(org, platform)` 限 in-flight。你侧可保留 `partner:{orgId}` 全局护栏防被打满，但**不要按人限流**——否则机构第 21 个教师会撞你的 C 端日限额。

## 2. 先定 job_kind（否则协议会对不上）

默认合同覆盖第一种。第二、三种单独立项，不要假装和 PPT 一样。

| job_kind | 完成时教师得到什么 | 你回报什么 | 例子 |
|---|---|---|---|
| `batch_file`（默认） | 文件下载（本侧签名 URL） | 产物预签名 GET URL + 成本 | PPT、成片 mp4、glb |
| `hosted_session` | 可打开的课 / 会话 | 托管入口（必须能被网关鉴权包装） | OpenMAIC 课堂 |
| `realtime_stream` | 推流 / SDK | **不走 submit/query** | 实时数字人 |

OpenMAIC：若只导出文件，降级为 `batch_file`。若师生要进课堂互动，先拍隔离、下课销毁、内容是否进公共库，再写附录。

## 3. 认证与上下文（所有端点）

| 头 | 值 | 说明 |
|---|---|---|
| `X-Partner-Key` | 共享密钥 | 服务账号。双 key 轮换窗口。mTLS 可后续升级，P0 不强制 |
| `X-Org-Id` | CoDelphi org id | 记账与隔离；你只透传、打日志、做 `partner:{orgId}` 护栏 |
| `X-Member-Id` | CoDelphi member id | 同上 |
| `X-Job-Id` | 网关 step job id | 幂等键 |

四个头适用于 **Submit / Query / Cancel / 拉材料** 全部端点，不是只在创建时带一次。key 不出仓库、不进日志正文；泄露即轮换。分环境（staging / prod）两套 key。

你的用户体系只用来**认出这是 partner 流量从而跳过 C 端计费**，不要用它当机构身份。

## 4. 材料与产物（禁止 multipart 飞文件、禁止转手临时链）

教材正文会进每一个被调用的平台。合同附件要有你的**数据处理清单**：是否自托管、是否出境、是否用于训练。

统一交换：

1. 教师材料已在网关对象存储（`org/{org_id}/...`）。
2. 网关给你**短 TTL 的 GET URL**，或直接在 JSON 里给 `content`（PPTCreator P0：`documents[]` 材料包，见其契约 C2）。你来拉/读，不要让教师再传一遍。
3. 你完成时给出产物 URL（预签名 GET）。TTL 必须 **≥ 网关轮询上限**（按分钟级任务至少 15–30 分钟；300s 不够轮询）。
4. 网关**回拷本侧**再给教师签名链。教师拿到的永远不是你的临时 URL。
5. 视频 / 3D 包 / 课资源禁止经 JSON 返回值传二进制。

`note`（首轮补充说明）和 `critique`（返工意见）若出现在 spec 里，必须进入你的生成提示词。丢了等于返工没做。

## 5. HTTP 语义（路径可改，字段语义不可改）

下面用 PPTCreator 已落地的形状当默认。你的路由可以是 `/v1/jobs` 而不是 `/generate`，但状态机、幂等、成本字段要能对上。

### 5.1 Submit

```
POST {partner_base}/generate
Headers: C1 四个头
{
  "job_id":     "同 X-Job-Id",
  "title":      "项目标题",
  "capability": "网关 capability，如 ppt / avatar / asset_3d",
  "input":      { "kind": "text|urls", "text": "...", "urls": ["https://...签名GET"] },
  "spec":       { "note": "可选", "critique": "可选", /* 平台自有字段 */ }
}
→ 202 { "platform_job_id": "你侧任务 id" }
```

- 同步做不完就 202。不要让网关 HTTP 卡死等成片。
- 同一 `job_id` 已存在：返回**同一个** `platform_job_id`，不要新开任务。

### 5.2 Query

```
GET {partner_base}/jobs/{platform_job_id}
Headers: C1 四个头
→ {
    "status":   "queued|running|succeeded|failed",
    "progress": 0-100,
    "error":    { "code": "...", "message": "..." },
    "usage":    { /* 见 5.4，仅 succeeded */ },
    "cost":     { "currency": "CNY", "vendor_cost": "1.234000" },
    "result":   { /* 产物 URL 字典，键由附录约定 */ }
  }
```

`vendor_cost` 是**你这一侧实际烧掉的钱**（你再调的 LLM / GPU / 存储），小数字符串，单位元。没有这条，该能力毛利是盲的。网关按它写 `UsageRecord.vendor_cost`。

### 5.3 Cancel

```
POST {partner_base}/jobs/{platform_job_id}/cancel
Headers: C1 四个头
→ 200 { "status": "canceled|running" }
```

尽最大努力。你没停住，网关仍会把 step 标 failed / expired 并退预扣——你侧应变孤儿任务，不要继续扣自己的钱还回报成功。

### 5.4 Cost / usage

在 adapter 元数据里写死「钱发生在哪一侧」，不要每次口头问。

| 谁付钱 | vendor_cost 谁报 | 例子 |
|---|---|---|
| 你内部又调了付费 vendor | 你报 | PPTCreator 的 LLM token |
| 网关直连 vendor | 网关自己算 | design/outline DeepSeek |

`usage` 至少回报对账需要的量纲（token / 秒 / 页 / 字节）。缺量纲的能力不要接进 License 护栏。

## 6. 错误面

JSON：`{ "error": { "code": "...", "message": "...", "retryable": true|false } }`。

| 你的情况 | 建议 | 网关行为 |
|---|---|---|
| 5xx / 超时 / 过载 | `retryable: true` | 该 step failed；运营可开新 job 重试 |
| 输入不合法、材料拉不下 | `retryable: false` | 该 step failed，不自动重打 |
| 业务硬约束没满足（如讲稿空） | 专用 code，标 failed | **不得** `succeeded` |

网关映射：adapter 故障 ≠ `billing_unavailable`。

## 7. SkipBilling 与 Isolate（2C 平台必改 worker，不只改入口）

只改网关入口预检不够，漏改点几乎都在 worker：

- 入口积分预检旁路
- worker 实扣旁路
- 下载锁旁路（机构稿不能因为「没积分」下不了）
- 若有个人 dashboard：B2B 行打 `source=partner` + `org_id`，C 端默认列表排除
- 拒绝把「按页/按局部重生」这类贵接口暴露给 partner——网关 P0 整份重出，避免被抠爆

验收时必须打一条真实 partner 生成，断言你的 C 端积分不变、锁未开、dashboard 看不见。没有这条自动化测试，就当 partner 模式不存在。

## 8. CoDelphi 侧怎么把你编进套件（你需要知道的边界）

你不实现工作台，也不实现 License。接入时我们会：

1. 定 `capability` 字符串（进 License.snapshot 护栏）和 `platform` 字符串（进 Job.platform、并发键）。
2. 在 `internal/preset` 某条预设的 `steps[]` 里加一步：`{ capability, platform, emits[] }`。教师主按钮不会变成「选引擎」。
3. 写 `internal/execution/adapters/<platform>`，只实现本文 §5。
4. 运营开通 License 时勾选含该 capability 的预设包。没授权的包，工作台不会出现对应动作。

不要让教师在对话里「挑选生成平台」。挑的是产物种类（预设包），包内部仍是一条龙。

## 9. 验收（通用，所有平台）

打一条 partner 生成，下列全部成立才算接入：

- [ ] 无教师 token、无你的 OAuth 码，仅 `X-Partner-Key` + 三个人身份头
- [ ] 同一 `X-Job-Id` 提交两次，只生成一次
- [ ] 你的 C 端积分 / 下载锁 / 个人 dashboard 不受影响
- [ ] Query 在 succeeded 时带 `vendor_cost` 与约定 usage
- [ ] 网关 `UsageRecord` settled，`vendor_cost` 与 Query 一致
- [ ] 教师下载的 URL 是网关域名下的签名链，不是你的临时链
- [ ] 人为杀掉你的 worker：网关 TTL 内预扣退回，step 为 failed / expired
- [ ] 附录里该平台特有的硬约束（PPT 的讲稿对齐、成片的时长等）也过

对账：根池 `used` == `sum(UsageRecord settled)` == 你侧调用次数/成本能对上。对不上不接下一个能力。

## 10. 接入流程

1. 填写文末检查表，寄回。`job_kind` 含糊的先停。
2. 开 staging：网关 staging key ↔ 你 staging 端点。
3. 双方各写一条自动化验收（你测积分/隔离；网关测 settle / 回拷）。
4. 数据处理清单进合同附件。
5. 生产 key、限流 `partner:{orgId}`、轮换窗口。
6. 预设包目录合并该 step 后，才对试点机构开通。

当前联调窗口优先仍是 PPTCreator（`CONTRACT-pptcreator-partner.md`）。新平台不要插队把 P0 数字课对账打乱。

---

## 附录 A · 平台检查表（复制后填）

平台正式名称：________  
是否自托管 / 是否出境 / 是否用于训练：________  
job_kind：`batch_file` / `hosted_session` / `realtime_stream`  
capability：________    platform 字符串：________  
钱发生在哪一侧：________  

| # | 项 | 你侧落点（文件/路由） | 验收 |
|---|---|---|---|
| 1 | 服务账号认证 + 四头（含 Query/Cancel） | | 无头 401；错 key 401 |
| 2 | 请求上下文只认网关 org/member/job | | 不用你的 userId 白名单 |
| 3 | Submit → platform_job_id；job_id 幂等 | | 重复提交不双跑 |
| 4 | Query：状态 / 错误 / usage / vendor_cost / 产物 URL | | succeeded 字段齐 |
| 5 | Cancel 尽最大努力 | | 孤儿任务不成功扣费 |
| 6 | SkipBilling：入口预检 + worker 实扣 + 下载锁 | | C 端积分不变、不锁 |
| 7 | Isolate：dashboard 不可见 B2B 产物 | | 列表排除 partner |
| 8 | 材料用签名 URL（或书面同意的过渡形态） | | 无大文件进 JSON |
| 9 | 产物 URL TTL ≥ 网关轮询；允许网关回拷 | | 教师链为本侧 |
| 10 | 不按人限流；可保留 partner:org 护栏 | | 第 21 人能用 |
| 11 | 拒绝贵的局部重生 API（若有） | | partner 调了被拒 |
| 12 | note/critique 进提示词 | | 返工意见可见于产物 |
| 13 | 本平台硬约束（自行增行） | | 不满足则 failed |

本平台硬约束举例：PPT+讲稿必须逐页 notes 且与页数对齐（见 PPTCreator C4）；数字人成片需与讲稿时长对齐（合成器 spike 结论写入后再填）。

## 附录 B · 已接入 / 候选

| 平台 | 合同 | 状态 |
|---|---|---|
| PPTCreator | `CONTRACT-pptcreator-partner.md` | P0 实例；假 server 测过，真端点联调中 |
| 网关 LLM（design/outline） | 非 partner，直连 vendor | 已接入 |
| 数字人 / AI3D / OpenMAIC | 填附录 A | 未开；先定 job_kind |
