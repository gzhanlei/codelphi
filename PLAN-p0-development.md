# P0 开发计划 · B2B 多能力生成平台

> 依据：`DESIGN-b2b-capability-platform.md`（§1–§10、§21 为准）。本文档把设计落成可分配的工单。
> 设计变更先改设计文档，再同步本计划；两文档冲突时以设计文档为准。
>
> 2026-08-24 第一版。

## 0. 范围与完工定义

**P0 交付（商业切片）：** 工作台上传章材料 →「做课」→ 课程设计/大纲（网关新 LLM adapter）→ 确认门（教师点「通过，继续」）→ PPT + 讲稿（PPTCreator partner）进套件，可预览/下载，Artifact 留版本。记账全通，日对账跑通。

**P0 不做：** 练习、讲解视频、3D 教具、OpenMAIC（spike 未证伪前不进架构）、机构自助 CSV 导入（P1）、unit 设帽 UI。返工对话（DSH）可后嵌，但**空聊天不上线**。

**完工定义（试点校能签合同的口径）：**

1. 运营能把一笔公对公收款变成 active License（合同号、快照、审计齐全）
2. 运营 CSV 导入教师名单 → 邀请邮件 → chandler 注册/登录 → 跳进工作台，身份绑在学院 Org 上
3. 教师新建一章、传材料、点「做课」：设计/大纲先出，确认门后才烧 PPT；构件齐后可下载 pptx + 讲稿 + 设计/大纲文档
4. PPT 生成时：机构护栏计数变化、PPTCreator C 端积分不动、C 端 dashboard 不可见、讲稿随结果回报且页数对齐
5. 护栏触达时工作台横幅 + 统一话术（联系本机构管理员），`quota_exhausted`
6. 人为杀死 PPTCreator worker / 网关 worker 后，TTL 内预扣自动退回
7. 日对账脚本：根池 `used` == `sum(UsageRecord where settled)` == partner 调用侧对得上
8. 同一构件多次重建产生多版本，历史版本可回看可下载；UsageRecord 挂 step_job_id 不受影响
9. 返工对话若已嵌入：token 进 `agent_llm` 账，过宽帽闸门

达不到 3、4、7，不接第二个能力，不进试点校。

## 1. 仓库与模块划分

| 仓库 | 内容 | 备注 |
|---|---|---|
| `codelphi`（新仓） | Go + MySQL + sqlc。`cmd/gateway`（HTTP/MCP 入口）；`internal/billing`（Org/Member/License/Quota/UsageRecord/AuditLog，Authorize/Settle 唯一实现）；`internal/execution`（lesson 状态机、adapters/*、合成器预留）；`internal/identity`（JWKS、token exchange、成员解析）；`internal/storage`（对象存储、签名 URL） | billing 不 import adapter；execution 只调 `billing.Authorize/Settle`，不直接 UPDATE 配额表 |
| `codelphi` 同仓 `web/` | 套件工作台 + 运营后台（一个 Web 应用，部署在 `app.codelphi.com`） | 团队已有 Next.js 生产经验（PPTCreator），按此建；只走网关 HTTP API，不直连数据库 |
| DSH fork | 云端多租户 host + 受限 preset（返工对话运行时） | 可后嵌，见 §7 |
| `PPTCreator`（既有仓） | partner 模式改造，§8 十条 | 走该仓 GitHub Issue 流程 |

## 2. 里程碑与依赖

```
M0 地基 ──► M1 计费闭环 ──► M3 lesson 状态机 ──► M5 工作台贯通 ──► M5b 预设包内核 ──► M6 试点验收
     └──► M2 PPTCreator partner（并行，跨仓）──► 汇入 M3/M5
M4 运营后台（与 M3 并行）
S1 合成器 spike / S2 OpenMAIC spike（独立时间盒，不挡 P0）
DSH 返工（M5 之后嵌入，不挡首轮交付）
```

| 里程碑 | 内容 | 依赖 | 出口标准 |
|---|---|---|---|
| M0 地基 | 新仓骨架；MySQL schema 全表；对象存储打通（上传/签名 URL/回拷）；部署管线到 101.32.49.240 | — | 空服务上线，健康检查 + 迁移工具可用 |
| M1 计费闭环 | Org/Member/License/QuotaPool/UsageRecord/AuditLog；authorize/settle；reservation TTL 扫尾；多 License 先到期者优先；日对账脚本 | M0 | §8.1 测试门禁全绿；对账脚本在造数场景对齐 |
| M2 PPTCreator partner | §8 十条全部落地 + 验收测试 | —（跨仓并行） | partner 生成一条：C 端积分不变、不锁下载、dashboard 不可见、讲稿非空页数对齐 |
| M3 lesson 状态机 | Project/Material/CoursePackage/Artifact（留版本）；设计→大纲→`awaiting_confirm`→PPT+讲稿；每 step 独立 authorize/settle；design/outline LLM adapter 新做；PPTCreator adapter | M1、M2 | `submit_lesson` 全链路造数据跑通，确认门等待期无预扣 |
| M4 运营后台 | License pending→active（高额双人确认）、suspend + 审计；CSV 批量导入成员；用量报表（成员 Top）；成本预警（按 capability 拆开） | M1 | 完工定义 1、2 的运营侧可演示 |
| M5 工作台贯通 | chandler OIDC 登录 + token exchange；org/unit 选择回显；章列表；新建章 + 传材料 + 补充说明表单；做课按钮；进度；确认门按钮；版本/预览/下载；失败横幅话术 | M3、M4 | 完工定义 2–6、8 全过 |
| M5b 预设包内核 | License.presets + Project.preset_id + execution 读目录；工作台 copy 来自包；P0 只内置 digital_lesson | M5 | 单包路径与现在一致；测试夹具多包时新建必选；原 execution 门禁仍绿 |
| M6 试点验收 | 造数 + 真机演练完工定义 1–9；对账连跑七天无漂移 | M5b | 可签合同 |

**两条并行关键路径（§18 H）：** 网关路径（M1→M3）与客户端路径（M4→M5）并行推进；客户端不许直连数据库、不许绑 DSH 私有头，契约以网关 HTTP/MCP 为准。

**进度记录（2026-08-24）：M0 完成。** 仓库骨架（cmd/gateway + billing/execution/identity/storage）、13 表 goose 迁移（本地 MySQL 9.6 验证）、sqlc 打通、storage 接口 + local 驱动、systemd unit + scripts/{deploy,migrate}.sh（二进制部署，不用 Docker）。已部署至生产机 124.156.160.168：`https://app.codelphi.com/healthz` 返回 ok（db=unconfigured，等生产 MySQL DSN）。partner 协同接缝见 `CONTRACT-pptcreator-partner.md`（C1–C7）。

**进度记录（2026-08-24）：M1 完成。** `internal/billing`：Authorize（org 暂停/成员停用 → License 先到期者优先不跨池 → 个人帽 → unit 帽 → 根池，单事务逐层条件更新预扣，未设帽层无行跳过，deny 落审计）/ Settle（幂等、终态条件认领、actual 差值调平、失败全额退）/ SweepExpired（TTL 24h 可配，与 Settle 抢行靠条件更新）/ Reconcile + `cmd/reconcile`（根池按 license+capability+period 对齐，漂移退出码非零）。迁移 0002 加 `usage_records.hit_pools`（记录命中层）。14 个测试全过（`go test -race`）：并发抢最后配额、settle 幂等、退款、TTL 迟到 settle 无害、扫尾/settle 竞态、多 License 不跨池、`member_cap_exhausted` 与 `quota_exhausted` 分流、四种 deny、暂停不杀在途、差值调平、对账对齐与篡改检测。遗留：gateway HTTP 层尚未接 billing（随 M3/M5）；成本告警未实现（字段已就位，随 M4 看板）。

**进度记录（2026-08-24）：身份链完成（M1 收尾）。** `internal/identity`：JWKS 验签器（RS256，缓存 5 分钟、拉失败留旧缓存、kid 未命中强制刷新一次；iss=`workmembership` 字符串比对、aud=`cm_aca9bb839faa4a4a96839b389f312636`）、Resolver（§5 全部归属规则 + 进程内短缓存 + `Invalidate` 主动失效，默认/显式两条缓存键都清）、HTTP 中间件（401/403 + 结构化 reason）。迁移 0003 补 `member_units` M:N 表（0001 漏建，设计 §3 本就要求）。19 个测试全过（自签 RSA + httptest 假 JWKS + 真实 MySQL）。约定：每个 internal 包独立测试库（并行跑互不清表）。chandler 对接参数（JWKS URL/issuer/client_id/secret）已进生产 `gateway.env`。未接线 gateway 路由（M5）。

**进度记录（2026-08-24）：M3 完成。** `internal/execution`：lesson 权威状态机（design → outline → `awaiting_confirm` → ppt+script，合法迁移集写死 + 条件 UPDATE 兜底并发；确认门等待期零预扣；每 step 独立 authorize/settle；Rebuild 整份重出版本迁移；并发公平 (org,platform) 信号量）+ `adapters/llm`（OpenAI 兼容，默认 DeepSeek `deepseek-chat`，schema 校验不过即 fail，JSON + Markdown 双产物，token 实测回报，单价可配）+ `adapters/pptcreator`（按契约 C1–C4，方向二单文档预合成，notes 缺失/不齐即 `notes_missing` failed，产物回拷本侧 storage）。10 个测试 `-race` 全绿（happy path 三门禁断言、notes 缺失退款、partner 5xx 不拖挂 billing、Rebuild 三版本、并发双确认幂等、信号量公平、非法迁移拒绝、schema 违规 fail、材料 kind 拦截）。
**契约反馈（已升 v1.1）**：spec 补 `note`/`critique` 字段；`usage.pages` 定义为 pptx 实际页数；C1 四个上下文头适用全部 partner 端点（含查询）——PPTCreator 侧按此实现。
**遗留进 M5**：编排是进程内同步调用，进程重启时 in-flight job 停在 running——M5 接线 HTTP 层时补「重启恢复/超时收敛」逻辑（残留预扣已由 TTL 扫尾兜底）。

**进度记录（2026-08-24）：M5 网关面完成，工作台已部署。** 生产 `db:ok`，试点 member 已手工插入。列表为「我的项目」、路由 `/projects`。未做：预设包内核（M5b）；M4；真 partner 联调。

## 2.1 M5b 预设包内核

决议：设计 §2.3。卖预设包，不贴行业；壳一套；单包无选择器；多包只在新建时选。P0 仍只卖 `digital_lesson`，但内核按「目录可有第二条」建。

### 现行实现焊死点

| 层 | 现状 | 问题 |
|---|---|---|
| License.snapshot | `[{capability,quota,unit}]`，billing 只认能力 | 无法表达「卖了哪个包」 |
| `package_templates` | 销售 SKU | 与运行时套件同名；无 presets[] |
| `projects` | 只写 title；`type_label` 未用 | 创建不绑预设 |
| `course_packages` / `jobs.kind=lesson` | 课语义进表名 | P0 不强制改名；新字段用 preset |
| `artifacts.kind` | ENUM 七值 | 第二包要 ALTER；生产尚无行，现在改 VARCHAR |
| `execution.Service` | 拓扑与四件齐写死 | 第二包只能 if 分叉 |
| HTTP | create 不收 preset；submit/confirm 走 lesson | 工作台无法按包渲染 |
| MCP | `submit_lesson` | 保留为数字课别名 |
| Web | 「做课」/构件名写死 | 单包时正确，应改为读包 copy |
| Collection | 无 | M5b 不上文件夹 UI；禁止用 OrgUnit 冒充 |

账本 Authorize/Settle 不用为预设重做。

### 目标

1. Preset 目录在代码里（`internal/preset`），P0 仅 `digital_lesson`（steps / kinds / copy）。
2. `licenses.presets` JSON 列，与 snapshot 能力数组分开（避免改 billing 反序列化）。空/NULL = 兼容视为 `["digital_lesson"]`。试点行补上。
3. `projects.preset_id` 创建时写入。单包可省略 body；多包缺省 → `preset_unspecified`。
4. execution 按 preset 跑步骤；ready = 该包声明的 kinds 齐。现有测试保持绿。
5. `GET /v1/presets`（或并入 `/v1/me`）返回 entitlements + copy。工作台文案走 copy。
6. goose `0004`：`artifacts.kind` → VARCHAR(64)；projects/course_packages 加 `preset_id` 默认 `digital_lesson`。

### 不做

公关第二条流水线；Collection UI；`org.industry`；DAG；顶部产品线切换；改 snapshot 数组为对象；删 MCP `submit_lesson`。

### 工单

- **B1 迁移 + 目录**：`0004_presets.sql` + `internal/preset`。测试：目录自检；未知 id 拒绝。
- **B2 execution 读目录**：Start/Confirm/Rebuild/refreshPackageStatus。测试：原 happy path / 确认门零预扣 / rebuild 必须绿；缺目录则 submit 失败。
- **B3 HTTP**：presets 列出；create 收 `preset_id`；submit 校验 License 仍包含该包。测试：单包省略 201；伪造包 id 400/403。
- **B4 工作台**：读 copy。单包无选择器。多包用测试夹具验证新建必选。
- **B5 试点 License 补 presets**；M4 开通表单写此列。

### 出口

`go test ./internal/... -count=1 -race` 全绿。试点账号仍直接做课。测试 License 挂两个 preset_id 时新建必须选。

## 3. 工单分解 · 网关（billing / identity）

### A. 数据模型（M0/M1，sqlc 迁移）

Org、OrgUnit、Member、PackageTemplate、License、QuotaPool、Project、Material、CoursePackage、Artifact、UsageRecord、AuditLog —— 字段以设计文档 §3 为准，不增不减。要点核对：

- `Member.(org_id, chandler_sub)` 联合唯一
- License 套餐快照 JSON 落列，无 UPDATE 路径（变更 = 新 License/LicenseAmendment）
- `UsageRecord.job_id` 唯一索引（幂等键）；Artifact 版本行 + 当前指针
- 配额周期 `period_start/period_end` 按授权年，高校对齐学年（9 月起），不硬编码自然年

### B. authorize / settle（M1）

- authorize 顺序：License 有效期与状态（多 License 取先到期者）→ 能力在套餐内 → 成员个人帽（若存在）→ unit 帽（若存在）→ 根池；每层 `used + estimated <= total` 条件更新，单事务
- 计数器只存在于根池 + 显式设帽节点；未设帽节点无行、天然跳过（记账纪律：计数器服务闸门，台账服务报表，两者不交叉）
- settle 按 jobId 幂等：`reserved → settled | refunded | expired`；一次尝试一个 job_id，重试 = 新 job 新预扣
- reservation TTL 扫尾任务：到期 `reserved → expired` 自动退回；与 settle 抢同一行靠条件更新
- 宽限：`org_suspended` 不杀 in-flight；运营后台可见「暂停后仍在跑的 job」
- 日对账脚本：根池 `used` == `sum(UsageRecord.amount where settled)`（按 license+period）；帽行不进对账
- 成本预警：`sum(vendor_cost)/实收金额` 超 60% 告警，按 capability 拆开

### C. 身份链（M1 打通、M5 接入）

- Chandler JWKS：缓存 5 分钟、拉失败留旧缓存；`iss` 字符串比对；`aud` == 本网关 client_id；校 `exp`
- 双 client（`codelphi-web` / `codelphi-gateway`）+ token exchange：工作台 OIDC 登录后换发网关 Bearer
- `X-Org-Id` / `X-Unit-Id`：必须是该 sub 的 active membership/归属，否则 `org_mismatch`/`unit_mismatch`（记安全日志）；未带且唯一归属可默认但**回显实际值**；多归属 → `org_unspecified`/`unit_unspecified`；**绝不接受模型填写**
- 成员解析短缓存 + disable 主动失效（删 `member:{sub}:{org}` 键，Redis）
- 错误面即引导脚本：结构化字段含 `remaining`、`reset_at`、`admin_hint`，reason 表以设计 §5 为准

## 4. 工单分解 · 网关（execution / MCP）

### D. lesson 状态机（M3）

- 拓扑硬编码：设计 → 大纲 → `awaiting_confirm` → PPT+讲稿；缺件后补、单件重试；不做 DAG
- `awaiting_confirm` 是正式状态：工作台「通过，继续」触发状态迁移后才提交 PPT step；等待期无任何预扣
- **扣费粒度 = step**：每 step 各自 authorize/settle，不整单预扣
- Job 字段含 `platform`、`platform_job_id`、`job_kind`；换平台重试 = 新 job
- 并发公平按 `(org, platform)`；adapter 超时/5xx 只 fail 该 job，billing 挂才 `billing_unavailable` fail-closed

### E. design/outline LLM adapter（M3，新做）

- 无姐妹平台可接，网关直连 LLM vendor；capability 记 `design`/`outline`
- 产出有 schema 的 artifact（不是自由 Markdown）；成本按 token 计 `vendor_cost`
- vendor 在配置里显式、可换，默认国内模型（招标合规口径的最低线）

### F. PPTCreator adapter（M3）

- partner 服务账号认证；上下文带 `X-Org-Id`/`X-Member-Id`/`X-Job-Id`
- 材料用本侧签名 URL 交换，不经 MCP 传大文件；产物**回拷**本侧对象存储再签发，不转手平台临时链
- 多文档输入：方向一（PPTCreator Document 1:N）落地前，用方向二（adapter 侧预合成单文档）顶住 P0；spec 不依赖「哪份是课文」的区分
- 讲稿回报（§8 第 9 条）为硬依赖：notes 为空 = step failed，不当成功

### G. MCP 工具面（M3 起）

- P0 只挂：`get_package`（构件列表 + 当前指针 + 最近 N 版 + 签名 URL）、`submit_lesson`（含 `rebuild` + `critique`）
- 不暴露 `submit_ppt`、不 `create_project`（建课在工作台）；`project_unspecified` 一律 deny
- 文件永不进工具返回值，只进签名 URL

## 5. 工单分解 · PPTCreator partner（M2，跨仓）

§8 十条逐条一个工单，走 PPTCreator 仓 GitHub Issue 流程：

| # | 工单 | 验收 |
|---|---|---|
| 1 | partner 认证（API key 或 mTLS），上下文传 org/member/job | 无 OAuth 流程可通 |
| 2 | 旁路 MCP 入口 `checkUserCredits` | partner 请求不 402 |
| 3 | 旁路 worker `deductCreditsGuarded` / `downloadLocked` | 无双扣、生成即可下载 |
| 4 | 用量/成本回报（页数 + LLM token） | 状态查询/webhook 带得出 |
| 5 | 限流权属移交：不按人限流，保留 `partner:{orgId}` 护栏 | 机构第 21 个成员可用 |
| 6 | `Project.source=partner` + `orgId`，C 端列表默认 `source IS NULL` | dashboard 不可见 |
| 7 | 下载鉴权校验仍是该机构成员，TTL 对齐网关轮询 | 离职成员不可下载 |
| 8 | partner 流量拒绝/忽略单页重生 API | agent 抠不了单页 |
| 9 | **讲稿必须回报**：逐页 notes（JSON，与页数对齐）+ 可选 script docx；notes 为空 = job failed（现行 MCP status 无讲稿字段、worker 讲稿失败被吞，均需改） | 讲稿非空且页数对齐 |
| 10 | **多文档输入**：方向一 Document 1:N（随既有多文档路线图）；P0 期间配合网关侧方向二联调 | 多材料章节可生成 |

**整体验收测试（partner 模式完工定义）：** 打一条 partner 生成，断言 `UserProfile.freeCreditsRemaining` 不变、`downloadLocked=false`、网关 UsageRecord settled、C 端 dashboard 不可见、讲稿非空且页数对齐。

不动的：解析/渲染管线、字体体系、Web 应用本身、C 端积分与 OAuth 体系。

## 6. 工单分解 · 工作台与运营后台（M4/M5）

### 工作台（教师面）

- 登录：chandler OIDC RP；一人多机构时先选身份（回显实际 org）
- 首页 = 我的章/课列表（无聊天入口）；`viewer` 角色只见用量
- 新建一章：标题 + 上传材料（pdf/docx/image/text → 网关对象存储）+ 可选补充说明（表单，进 `submit_lesson` spec）
- 做课按钮 → 套件进度（构件逐个亮起）；确认门「通过，继续」；离开可回来进度还在
- 构件齐：在线预览 + 下载；版本列表可回看旧版
- 失败 = 页面横幅 + 统一话术（联系本机构管理员），不弹助手
- 「对这一份提意见」入口：有半成品才出现（DSH 未嵌时该按钮置灰或隐藏）

### 运营后台（我方运营面）

- License：销售建 pending（合同号/快照/应付）→ 财务确认到账（可填回单号）→ active（高额双人确认）；开错走 suspended + 审计，不删行；到期前提醒
- CSV 批量导入成员（工号/姓名/邮箱/unit 名 → 发邀请）；成员停用（触发缓存主动失效）
- 用量报表：成员 Top、按 unit/项目聚合（一律从 UsageRecord，禁止 `SUM(children.used)`）
- 成本预警看板：按 License、按 capability 的成本/实收比
- 「暂停后仍在跑的 job」列表

## 7. DSH 返工运行时（后嵌，不挡 M5）

- 云端多租户 host：共享进程 + 会话按 `member_id` 分区持久化（MySQL vs 对象存储 backend，P0 内定）；**禁止**一教师一进程/一块 SQLite；每条 host API 做 member 鉴权
- 受限 preset：只挂网关 MCP；无 shell/fs/终端、关 `web_fetch`、不 `create_project`
- 会话键 = member × project × artifact 版本；入口只有工作台「对这一份提意见」
- token：用工作台已换发的网关 Bearer，不持任何平台 key
- 系统提示注入当前构件（页数、讲稿摘要、教师选中的页）；指代「这一页」必须能落地
- 产出只有 rebuild spec（`submit_lesson(rebuild, critique)`），不当文件柜；不用 plan/approval 冒充确认
- `agent_llm` 计量：每次模型调用前按 token 上限 authorize、按实际 usage settle（宽帽）；billing 不可用 fail-closed
- **空聊天不上线**：无半成品不加载 DSH

## 8. Spike（独立时间盒）

| Spike | 时间盒 | 内容 | 出口 |
|---|---|---|---|
| S1 合成器 | 不挡商业 P0；讲解视频开门前必须有结论 | 复用 PPTCreator `scripts/visual-diff.ts` 的 soffice 路径（隔离 user profile、CJK 字体、逐页 PNG）：成品 pptx → LibreOffice headless 逐页出图 → ffmpeg 播放条 + 人像旁挂。验收对比物 = 同 pptx 在 PowerPoint/WPS 的观感，人眼抽查真实 deck | 保真可接受 / 不可接受；同时产出数字人 adapter 规格（绿幕/纯底、时长对齐）与 §8 第 9 条是否需带每页时长 |
| S2 OpenMAIC | 两周 | 唯一判决：是否贡献套件里 PPT **以外**的构件（互动课、练习引擎、大纲结构）。只做 PPT → 砍掉 | 结论进设计文档 §10；未证伪前不进 P0 架构、无 `classroom` 工具 |

## 9. 测试门禁（先于实现存在，合并即跑）

继承设计 §11 B.10 / §13 E，并按第十轮补充：

- authorize 并发：两个请求抢最后一份配额，只有一个 allow
- settle 幂等：同一 job_id 两次 success，`used` 只变一次
- 失败退款：reserved → refunded，链上各层回滚；重试新 job_id 不打到 refunded 行
- reservation TTL：过期自动退；迟到的 settle 无害拒绝
- 多 License：旧池未尽时新池 `used` 不变；单 job 不跨池
- **按 step 扣费：** `awaiting_confirm` 期间根池无该 lesson 任何预扣；确认后 PPT step 才 authorize
- 同一父池两 unit 并发只够一笔：一 allow 一 deny，均为 `quota_exhausted`
- 改帽与消费并发：无死锁
- `X-Org-Id`/`X-Unit-Id` 不属于该 sub/成员：deny + 安全日志，无预扣
- 成员 disable 后下一请求即 deny（缓存主动失效）
- 调岗后历史 UsageRecord.unit_id 不变
- 根池对账用全表 settled；unit 报表从 UsageRecord 聚合，禁止 `SUM(children.used)`
- 无 Project 的 submit：deny `project_unspecified`
- PPTCreator partner：积分不变、不锁下载、C 端不可见、讲稿非空页数对齐、单页重生被拒
- agent_llm：调用前预扣、按实际 settle、帽到即拒

## 10. 部署与环境

- 业务域名 `app.codelphi.com` → 生产机 124.156.160.168（本机持密钥可直接部署；`scripts/deploy.sh` 一条命令完成交叉编译/传输/systemd 重启，不用 Docker）；部署管线 M0 已建
- 生产数据库：腾讯云 MySQL 集群；本地 MySQL 供开发；sqlc 迁移文件进仓。**DSN 必须带 `loc=Local`**（服务器在 +08，驱动默认按 UTC 解释 DATETIME，不配会导致 TTL/周期比较偏 8 小时）
- Redis：限流 + 成员解析短缓存（生产实例随 M1 就位）
- 对象存储：材料与产物的唯一交换格式（org 前缀、生命周期策略：到期后 90 天只读、之后按前缀删除）；**选型开工前拍板**（默认同云厂商 COS，见 §11）
- vendor key / partner key / client_secret：进程环境或密钥管理，不出仓库、不进日志；partner key 可轮换（双 key 窗口）

## 11. 开工前待确认清单

1. 对象存储选型（默认腾讯 COS）
2. DSH 会话持久化 backend（MySQL vs 对象存储，P0 内定）
3. design/outline LLM vendor 的具体型号与密钥来源（默认国内、可换）。**注意**：网关侧（design/outline、agent_llm 计量）和 PPTCreator 的 2C 生成管线都烧 LLM token，两边配置时留意共用限额
4. PPTCreator 方向一（Document 1:N）排期 —— 决定 P0 是否启用方向二过渡
5. 数字人平台、AI3D 正式产品名（不挡 P0，挡讲解视频/3D 排期）

## 12. 风险登记

| 风险 | 影响 | 对策 |
|---|---|---|
| §8 第 9/10 条（讲稿回报、多文档）未落地 | 套件缺讲稿构件、多材料章节进不了生成 | M2 最高优先；方向二过渡 |
| DSH 云端化工作量 ≥ partner 改造（§18） | 返工对话延期 | 后嵌不挡 M5；空聊天不上线 |
| LibreOffice 渲染保真不达标 | 讲解视频链受阻 | S1 提前；不挡商业 P0 |
| OpenMAIC spike 证真 | P1 练习/互动课路线变化 | 两周时间盒，结论进设计 §10 |
| 教材正文合规（出境/训练）无书面答案 | 招标死 | 设计 §10 仍开放第 1 条，销售开口前书面 |
| 内部报价模型未建 | 第一份合同定价拍脑袋 | 设计 §10 仍开放第 3 条，商务文档另写 |
