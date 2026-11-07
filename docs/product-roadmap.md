# CoDelphi 产品规划

> 2026-11-06 基于竞品调研（对话记录）与 [用户画像](user-personas.md) 制定。缺口编号 A–E 沿用画像文档的「缺口编号速查」。
>
> 约束继承自 `AGENTS.md` 与架构现状：腾讯云 MySQL 8、Chandler OAuth 红线、密钥仅环境变量、Webhook 依赖持久进程 `after()`（不能 serverless）、自动分析不得覆盖 manual 数据。

## 一、定位与北极星

**定位不变**：把 GitHub 仓库变成一份可追溯的产品规格——竞争策略是「可信的行为规格时间线」品类，不与 DeepWiki 卷通用代码 wiki。

**北极星指标**：**每周「消费行为变化」的人次** = 发布页 spec_changes 浏览 + 通知点击 + 回归清单操作。理由：四个角色的理想旅程都汇聚在同一个动作上——「看到并消化一次行为变化」；分析产量（run 数）不代表价值，消费才代表。

**资产原则**：所有里程碑共享同一份资产（spec 版本链 + 证据 + manual 语义），只是换受众、换动线、换出口。不新造引擎，除非明确标注（M9）。

## 二、阶段总览

| 阶段 | 主题 | 里程碑 | 解决谁的问题 |
|---|---|---|---|
| **一：触达** | 让已有的 80% 被看见 | M1 通知分发、M2 QA 回归清单、M3 稳定引用+搜索+导出、M4 管线加固 | PM / QA / CTO |
| **二：开发者动线** | 从交接文档变成 PR 流工具 | M5 反向影响索引+PR 预演 ⭐、M6 功能聚合视图、M7 测试骨架导出、M8 漂移提醒、M9 增量分析 | 开发者 |
| **三：生态与边界** | 同一份资产多卖一个出口 | M10 MCP server、M11 分享页+可信 changelog、M12 多代码托管、M13 外部仓库跟踪 | 增长与新场景 |

排序依据（画像文档结论）：PM/QA/CTO 的理想用法八成已落地，缺的只是触达；开发者 80% 是缺口但共享数据；每个阶段内部按「解锁其他工作的程度」排序。

---

## 阶段一：触达

### M1 通知分发（缺口：通知分发；全局第一优先级）

**目标**：分析完成且有行为变化时，把 diff 摘要推到 PM/QA/CTO 的日常动线（Slack / 通用 webhook）。Email 延后（需引入 SMTP 供应商决策，破坏「零外部服务依赖」的部署简洁性，单独评估）。

**功能描述**：
- 触发点：`performAnalysis` 成功且本次 `spec_changes` 非空 → 渲染摘要并投递；无变化默认静默（可配置）。
- 消息形态：产品名 + release 链接 + N 条变化列表（功能/场景 + 变化类型 + 证据链接），与 `components/behavior-change-item.tsx` 的信息结构一致。
- 渠道：Slack incoming webhook、通用 webhook（JSON payload = 未来自动化/对接企业微信/钉钉的口子）。

**技术要点**：
- 新表 `notification_channels(id, product_id, kind, target_encrypted, enabled, created_at)`；`target_encrypted` 复用 `lib/secret-box.ts` AES-256-GCM。
- 投递在分析事务提交后 best-effort 执行（复用 `after()` 语义），投递失败只记日志，不回滚分析状态；新表 `notification_deliveries(channel_id, analysis_run_id, status, error)` 记录可观测。
- 管理入口：产品页设置区 + 组织级默认渠道（阶段一内可先只做产品级）。

**验收**：push → 分析成功 → 5 分钟内 Slack 收到含证据链接的变化摘要；无变化不扰民；通知失败不影响分析结果；`npm test` 覆盖渲染与去重。

**规模**：M ｜ **依赖**：M4 建议先行或并行（见下）。

### M2 QA 回归清单（画像：QA 杀手场景，性价比最高）

**目标**：把发布页的行为变化流变成 QA 的工作界面——回归范围即 diff，勾选状态可持久、可导出。

**功能描述**：
- 发布页新增「回归清单」区：按功能分组的 `spec_changes`（情境/操作/结果 前后对比复用 `behavior-change-item`），每条可勾选（已验证/不适用/待测）。
- 一键导出 Markdown 清单（贴进测试计划/工单）。
- 「未发现规格行为变化」的 release 显式给出瘦身回归建议文案。

**技术要点**：新表 `regression_items(release_id, spec_change_id, status, checked_by, checked_at)`；导出纯服务端渲染。

**验收**：QA 打开发布页 → 勾选 → 导出 → 状态跨会话保持。

**规模**：M ｜ **依赖**：无。

### M3 稳定引用 + 搜索 + 规格导出（基建，M5/M10 的地基）

**目标**：让场景可以被「引用」，让 spec 可以被「检索」和「机器读取」。

**功能描述**：
- 功能/场景稳定链接：`/products/[slug]/spec/feature/[stable_key]`，始终解析到包含该条目的最新 spec_version（`stable_key` 已有唯一索引，`migrations/002_spec_versions.sql:19-25`）。
- 产品内搜索框：LIKE 起步（功能名/场景文本/路径），数据量证明需要后再上 FULLTEXT。
- 机器可读导出：`GET /api/products/[slug]/spec.json`（当前快照 + 证据），为 M10 MCP 提供同源数据。

**验收**：PM 在需求文档里贴场景链接，打开总是最新版；搜索命中功能/场景；spec.json 可被 curl 拿到。

**规模**：M ｜ **依赖**：无。**M5 的 PR 评论必须引用这些稳定链接，故 M3 先行。**

### M4 管线加固（技术债清偿）

**目标**：通知会放大管线的每个瑕疵，先修已知的坑再放大。

**内容**（全部来自 make-it-right 审计遗留）：`queueAnalysis` 同 sha 竞态、邀请时区缺陷、4 个 lib 文件的 Execute 副本、保存反馈时序差异。

**规模**：S–M ｜ **建议在 M1 上线前完成竞态项**，其余可穿插。

---

## 阶段二：开发者动线

### M5 反向影响索引 + PR 预演（缺口 B ⭐ 唯一改变使用频率的功能）

**目标**：开发者提 PR 时，CoDelphi 主动出现在 PR 流里——「此 PR 会触碰哪些规格」。

**功能描述**：
- 订阅 `pull_request`（opened/synchronize）事件：取 PR 变更文件 → 与反向索引求交集 → 在 PR 评论受影响的功能/场景（M3 稳定链接 + 证据路径）。
- 同一 PR 的评论**原地更新**（隐藏 marker 标识），不刷屏。

**技术要点**：
- ⚠️ **前置依赖：GitHub App 权限升级**。当前 App 是纯只读（manifest 明确「仅 Contents/Metadata 读取 + Push 事件」，`lib/github-manifest.ts`），需增加 `pull_requests: write` 权限与 pull_request 事件订阅。**已安装 App 需要走权限更新迁移**——README 已记录历史迁移坑（secret 不一致 401、事件订阅遗漏），必须写迁移指南并分步灰度。
- 新表 `spec_file_index(repository_id, path, feature_id, scenario_id, spec_version_id)`，每次分析成功后从 evidence JSON 重建（事务内）。
- 索引只读、预演不写 spec；变更文件交集为空则不评论。

**验收**：PR 触碰某功能证据文件 → 评论列出功能与场景链接；追加 commit → 同一评论更新；不影响 push 分析主链路。

**规模**：L ｜ **依赖**：M3（稳定链接）、App 权限迁移。

### M6 功能 → 实现聚合视图（缺口 A）

**目标**：功能页一屏回答「改这个功能要动哪里」。

**描述**：功能详情区新增「实现分布」：该功能所有场景 evidence 文件去重、按一级目录聚类、GitHub 链接直达。

**技术要点**：纯读查询，直接聚合 `spec_scenarios`/`spec_features` 的 evidence JSON，不依赖 M5 的索引表（独立可上线；M5 后切换到索引表查询）。

**规模**：S ｜ **依赖**：无。

### M7 场景 → 测试骨架导出（缺口 C）

**目标**：把 QA 语言变成开发资产，让 spec 从「读的文档」变成「引用的资产」。

**描述**：按功能导出 Gherkin `.feature`（情境/操作/结果 → Given/When/Then，`HP-n/EC-n/ER-n` 作为 tag）与 Markdown 用例名清单；下载接口。

**规模**：S ｜ **依赖**：无。

### M8 规格漂移提醒（缺口 D）

**目标**：manual 语义从「保护」升级为「主动信号」。

**描述**：当一次分析的行为变化触及含 manual 内容的功能，且该 manual 条目未随之更新 → 产品页徽标「N 条人工规格可能过时」+ 计入 M1 通知摘要；人工重新保存后清除。

**技术要点**：`spec_features` 加 `manual_stale_since`/关联 change id（或独立表）；清除时机挂在 manual 保存路径（`lib/spec-editor-service.ts`）。

**验收**：人为改代码触发行为变化 → 徽标出现 → 编辑 manual 后消失。

**规模**：M ｜ **依赖**：M1（通知摘要引用）。

### M9 增量分析引擎（唯一的新引擎工作，规模与成本解药）

**目标**：把「每次 push 全仓重提取」改为「只重提取受影响模块」，降成本、突破大仓库预算上限（当前 80 文件/600 行段，`lib/remote-analysis.ts:29-38`）。

**方案要点**：
- 用 `spec_file_index`（M5）把 diff 文件映射到受影响功能 → 切片规划器 scope 只覆盖这些模块；
- 未触及功能**沿用上一版 generated 条目**进快照（合并语义需新写「generated carry-forward」，与 `loadManualSpec` 的 manual 合并路径并存）；
- 不变量必须保持：`assertEvidence` 校验、manual 保护（`lib/analysis.ts:50-79`）、预算上限；
- diff 过宽/索引缺失/置信度不足 → 自动回退全量分析；
- 按产品级 feature flag 切换，灰度期跑影子对比（同 push 双跑增量+全量，diff 结果一致性达标再放量——corpus 影子回归已有先例）。**放量记录（2026-11-07）**：门槛落地后（功能集 100% 一致 + (ref,category) Jaccard ≥ 0.70，噪声底依据 0.80），dogfooding 产品过门槛，迁移 026 全库切默认增量（新产品自动继承）；保守回退链（首次分析/宽 diff/高占比 → 全量）保证新产品首个 run 自动建全量基线。

**规模**：L，高风险 ｜ **依赖**：M5 索引；放在阶段二末尾，等索引经真实数据验证后再动引擎。

---

## 阶段三：生态与边界

### M10 MCP server（缺口 E）

- 只读工具集：`list_features` / `get_feature(stable_key)` / `list_changes(release)` / `search_spec`；数据同源 `spec.json`（M3）。
- 形态：独立 stdio 进程，复用 `lib/db.ts` 直连 MySQL，不进 Next.js 进程；不造 IDE 聊天 UI（不与 DeepWiki 硬碰）。
- 规模：M。

### M11 分享页 + 可信 changelog

- 按 release 生成分享 token（扩展 demo 模式语义，`lib/env.ts:24-31` → token 表），公开页展示行为变化 + 证据**路径**（代码内容仍需仓库权限，链接对无权限者不可达——隐私边界要写清楚）。
- 导出 release notes Markdown 草稿（双向闭环的第一步）。
- 规模：M。

### M12 多代码托管（Gitee/GitLab）

- 在 `lib/code-hosting/` registry 后实现分析 adapter（github-provider 为范本）；`repository_providers` 表已预留（migrations 012/013）；每家含 webhook 验签差异。
- 依据：信创/代码不出域是 DeepWiki 覆盖不到的缝隙。按需求拉动，一次一家。
- 规模：L / 家。

### M13 外部仓库跟踪（「盯别人仓库」）

- 只读跟踪公开仓库（竞品/上游依赖），产品类型 `external`：行为变化推送（复用 M1）即「NewReleases 告诉你它发新版了，CoDelphi 告诉你它改了什么行为」。
- ⚠️ 需产品决策：突破 Chandler 封闭白名单假设，设计「任何登录用户可建外部跟踪」的权限档位；与内部产品严格隔离展示。
- 规模：L + 决策成本高，由 M1/M5 的成熟度与真实需求信号触发。

---

## 三、指标体系

| 阶段 | 指标 |
|---|---|
| 一 | 通知投递成功率 ≥99%；M1 触达后 48h 内发布页/回归清单访问转化；M2 每个有变化的 release 被勾选的比例；M3 搜索/引用链接使用次数 |
| 二 | PR 预演覆盖率（% PR 获得评论）；评论后开发者更新 manual 的比例（价值信号）；M9 增量模式 token 成本降幅（目标 ≥60%）、影子对比一致率（放行门槛：功能集 100% 强制一致 + (ref,category) Jaccard ≥ 0.70——0.70 依据全量 vs 全量噪声底实测 0.80，2026-11-07 排查记录见 memory 与 docs/m9-workbench-carry-forward-handoff.md）、回退全量率 |
| 三 | MCP 工具调用周活；分享页独立访问；外部跟踪产品数 |

## 四、风险与依赖

| 风险 | 缓解 |
|---|---|
| GitHub App 权限迁移踩坑（历史：secret 不一致 401、事件订阅遗漏） | M5 前置写迁移指南；先在测试 App 上演练；生产灰度 |
| 通知扰民 | 无变化默认静默；按 run 而非按 commit 合并；渠道可独立关闭 |
| M9 增量分析引入正确性回归 | 影子对比 + feature flag + 自动回退全量；manual 保护与 assertEvidence 进回归测试 |
| LLM 成本随产品数增长 | 预算常量已有上限；阶段二前不动成本结构，M9 是正解，勿提前优化 |
| `after()` 单机串行承载 webhook+评论+通知 | 内部规模足够；为 M13 外部跟踪预留「队列worker 独立进程」的演进预案（仍用 analysis_runs 表，不加 Redis） |

## 五、非目标（明确不做）

- **不做架构图**：已诚实下线（`README.md:34`），不回潮。
- **不做 IDE 内聊天 UI**：走 M10 MCP，让开发者的 agent 来问。
- **不追公开 OSS wiki 人群、不追绿地 SDD**：前者被 Cognition 补贴覆盖，后者是 GitHub 官方主场。
- **不引入 Redis/独立队列服务**：`analysis_runs` 表 + `after()` 足够，除非规模证明。
- **不新增账号体系**：Chandler OAuth + PKCE 红线（`AGENTS.md`）。
- **不用 AI 覆盖 manual**：一切新功能（含 M8/M9）继承该红线。

## 六、决策记录

1. **通知先行于一切开发者功能**：一份投入解锁三个角色（画像结论 1）。
2. **M3 先于 M5**：PR 评论必须引用稳定链接，否则评论无法沉淀为可导航资产。
3. **M9 压轴阶段二**：索引（M5）需经真实数据验证后再动引擎；成本优化不抢用户价值的位置。
4. **Email 延后**：引入 SMTP 供应商违反当前零外部服务依赖的部署简洁性；Slack + 通用 webhook 已覆盖内部动线。
5. **M13 需要单独的产品决策**：权限模型从「封闭公司」放开是方向性变化，不混入常规迭代。
