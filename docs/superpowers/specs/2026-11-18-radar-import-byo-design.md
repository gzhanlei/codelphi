# Radar 快照导入与 BYO 知识服务设计（L1–L4 产品阶梯）

## 1. 产品问题与价值假设

本设计回答 2026-11-18 产品讨论收敛出的三个问题：radar 分析过的仓库如何进入 CoDelphi 而不重复付费分析；本地分析与远端仓库如何建立身份联系；分析永远留在本地、CoDelphi 只保存结果的模式如何成立。

商业定位前提（已定调，不再重议）：CoDelphi 卖的是**人类团队的知识维护**——AI 提取 + 人工核实签发 + 漂移检测 + 发布账。coding agent 在这个故事里是免费的分析算力与分发渠道（radar skill 在用户 agent 内运行、消耗用户自己的模型额度），以及按需复核线索源（受 `2026-11-16-mcp-agent-value-loop-design.md` 的价值环治理）。本设计不包含任何「MCP 提升 agent 编码」的价值宣称；该假设未通过正式试点，不作为商业基础。

价值假设分三条，各自独立检验：

1. **L2 导入转化**：radar 用户中有可观测比例把快照导入账本（免费/赠 SAU），而非放弃。
2. **导入→核实转化**：导入草稿中有可观测比例被人工核实（哪怕是部分核实），证明草稿值得核实。
3. **L3 BYO 存量**：存在愿意为「分析本地化 + 服务端零代码」付费的订阅客户。

停止条件见 §17。

## 2. 产品阶梯与边界

| 层 | 分析位置 | 上传内容 | CoDelphi 成本 | 计费 | 定位 |
|---|---|---|---|---|---|
| L1 radar 一次性 | 用户本地，用户模型 | 不上传 | 0 | 免费 | 引流；一次性交付必须自足完整 |
| L2 导入草稿 | 用户本地（已有快照） | 合并快照 JSON 一次 | ≈0 | 导入 0 SAU，首次成功赠 SAU | 转化第一步 |
| L3 BYO 持续 | 用户本地 + 周期上传 | 快照/delta | ≈0 | 订阅（纯服务） | 合规/隐私客户 |
| L4 直连托管 | 服务端 | —（服务端克隆） | LLM 真实成本 | SAU | 现状；便利型客户 |

不变约束：

- radar 一次性报告必须完整自足，不得降级为「不完整的试用版」诱导升级。
- 升级永远 opt-in；L1 不引入任何需要 CoDelphi 账号的步骤。
- L3 与 L4 是不相交客群（合规禁止服务端克隆代码的组织根本进不来 L4），按两个市场运营，不互相定价对照。

## 3. 已确认事实与现有机器

本设计大量复用已上线机制，逐项列明以防止重复建设：

- **分析引擎同源**：radar（`lib/snapshot/*`）与账本服务端分析共用 `lib/ai.ts` 的提取契约与 `AnalysisResult` 形状；feature/scenario 命名同源，stableKey 名称级匹配可直接复用。
- **合并机器**：BM-1 增量分析（FUR=0 验收）、BM-6 确定性变体折叠（等价捷径 + 0.5 合并兜底）、carry-forward 回填均已上线，导入对账与 BYO 合并走同一套，不新建第二个内核。
- **人工保护**：`source = 'manual'` 不可被自动分析覆盖是仓库级红线（AGENTS.md），导入不得触碰。
- **核实生命周期**：`verified_at × stale_since` 四态真值表与 `spec_verifications` 历史链已上线（见价值环设计 §4），导入草稿直接继承该语义。
- **API key 基础设施**：MCP key 的签发、旋转、组织隔离已上线，上传鉴权复用（§9）。
- **gift 钱包**：履约赠 SAU 机制已上线（订阅履约 gift 入账），导入赠予复用。
- **快照产物现状**：radar work dir 持久化 `manifest.json`（含 `contractVersion` 与 identity）、`work-orders/*.json`、`results/*.json`（分区结果）、`presentation.json`、`radar.html`、usage 流水。**没有合并后的快照 JSON**——合并只发生在渲染 HTML 的内存过程中。导入物契约需要新增导出（§4），这是确定性组装，零 AI 成本。
- **treeSha 已算未带**：`lib/snapshot/git-backend.ts` 的 `GitSnapshot` 已计算 `treeSha`（内容寻址树哈希），但 `SnapshotIdentity` 未携带——本地分析的身份记录里没有「内容一致」的确定性锚。补齐是一行级改动（§5）。
- **GitHub 目标仅公网 https**：`lib/snapshot/target.ts` 明确拒绝非公网 URL；本地路径分支对任意仓库可用（私有仓库的官方路径是本地 clone，§10）。
- **已知计数疑点**：SalesBuddy 报告页显示「分析分区 430」，work dir 实际 117 工单——疑为断点复用残留计数，随 P0 修正（§13）。

## 4. 导入物契约：snapshot.json 导出

### 4.1 导出物

radar run 完成时在 work dir 持久化合并快照 `snapshot.json`：

```jsonc
{
  "artifactKind": "codelphi-radar-snapshot",
  "exportVersion": 1,
  "contractVersion": "1.0.0",          // 透传自 manifest.json
  "identity": { /* SnapshotIdentity，扩展后含 treeSha/originRemote */ },
  "exportedAt": "2026-11-18T12:00:00Z",
  "language": "zh-CN",
  "product": { "description": "...", "evidence": [...] },
  "features": [ /* 合并后的 AnalysisResult.features，含全部场景与证据 */ ],
  "presentation": { /* SnapshotPresentation */ },
  "coverage": { /* AnalysisCoverageReceipt */ },
  "effectiveCoverage": { /* SnapshotEffectiveCoverage */ },
  "warnings": [],
  "mergeStats": { /* changesTruncated/scenariosDeduped/featuresFolded */ },
  "passes": { /* retries/sanitize */ }
}
```

约束：

- 导出是确定性组装：同一 work dir 重复导出必须产出逐字节相同结果；数组保持引擎产出顺序，不做排序美化。
- `features` 是合并终态，不携带分区中间产物；分区数、重试数等运行统计进 `passes`/`mergeStats`。
- 导出失败不阻塞 `radar.html` 产出（HTML 是 L1 主交付物）；导出仅在与 CoDelphi 交互（导入/BYO）时必需。
- `radar.html` 中「分析分区」计数口径修正为 work orders 实际数，断点复用残留不得计入展示值。

### 4.2 校验规则

导入端点按序校验，任何一步失败即拒绝并返回结构化错误，不做部分导入：

1. `artifactKind` 与 `exportVersion` 识别；不识别的版本返回 upgrade 提示，不猜字段。
2. `contractVersion` 门：仅接受与当前服务端提取契约兼容的版本；不兼容返回 409 review，不做自动转换。快照升级后允许重新导出再导。
3. zod 全量 schema 校验（features/scenarios/证据锚点形状）；证据 `path` 规范化规则与账本一致（禁绝对路径与 `..`，上限沿用账本既有约束）。
4. 规模上限：features/scenarios/证据条数超过当前产品型账本上限的，拒绝并提示分仓分析，不静默截断。
5. `identity.workingTreeDirty = true` 的快照可导入，但只能作为草稿，不得作为增量基线（§5）。

## 5. 身份锚定与三级匹配

### 5.1 身份扩展（P0 代码改动，两处一行级）

- `SnapshotIdentity` 增加 `treeSha: string` 与 `originRemote: string | null`；`resolveSnapshotTarget` 本地分支从 `GitSnapshot.treeSha` 透传前者，并读取 `git remote get-url origin` 归一化（`git@host:owner/repo` → `https://host/owner/repo`，剥去凭证段）为后者；GitHub 分支两者天然已有。
- `manifest.json` 携带扩展后 identity，导出物随之继承。旧 work dir（无新字段）导出时如实置空，不伪造。

### 5.2 三级匹配

导入时及「已有草稿的产品后续绑定仓库」时执行同一匹配，按优先级：

| 级 | 条件 | 结果 |
|---|---|---|
| 1 | `identity.revision` 提交在远端可达（服务端 fetch 或 GitHub API 查证） | `linked_sha`：自动绑定产品；workspace 记录 seeded 基线，绑定的首次原生分析从该 SHA 起**增量**（复用 BM-1 diff 机器 + carry-forward），不是全量重跑 |
| 2 | 提交不可达（历史改写）但存在远端提交 `treeSha` 相等 | `linked_tree`：自动绑定产品；草稿照常入账；首次原生分析为全量，走折叠合并（历史改写后无法 diff，不假装增量省钱） |
| 3 | 两者皆不中 | `unlinked`：产品创建为未绑定；用户可后续补声明仓库 URL 重试 1/2 级，或直连仓库触发 |

约束：

- 匹配是确定性 git 事实判断，不做模糊相似度匹配；`linked_tree` 的 treeSha 相等即「内容一致」的可验证证明，不引入文本相似度兜底。
- 三级都未命中且用户未声明 URL 时，草稿保持未绑定状态可用（浏览、核实、MCP 按需查询），只是没有 push 增量能力。
- **本设计的全部价值宣称都基于级 1**；级 2 的成本（全量首跑）在设计上如实计入，不宣传为「省去分析」。

### 5.3 seeded 基线记录与首跑对账

- 级 1 命中的 workspace 记录：`seededSnapshotSha`（= 分析 SHA）、`seededTreeSha`、`seededDirty=false`（dirty 快照不得进入本路径）、`seededContractVersion`、`seededAt`。
- 首跑增量前先做护栏核验：草稿 `coverage` 回执与增量预期一致；差异超出护栏阈值（沿用现网覆盖率骤降告警口径）时回退全量重跑并如实计费/计成本，不做静默拼接。
- 首跑产出的发布走既有 per-push 发布账，变化与草稿的折叠合并结果在 `get_release` 中可对账；计划外变化按既有流程回查。
- 首跑之后，seeded 标记转为普通基线，后续增量与现网无差别。

## 6. 实体映射、保护与幂等

- **来源标记**：导入的 feature/scenario 一律 `source = 'ai_snapshot_import'`，与 `generated`/`manual` 区分；`manual` 硬红线语义不变——导入永不创建或覆盖 `manual` 条目，与既有 `manual` 冲突的条目按折叠合并的既有规则处理并进入人工队列复核。
- **身份映射**：feature 走 stableKey 名称级匹配；scenario 引用（HP-1 等）保留原值，引用是功能内作用域，不与跨功能身份混淆（沿用价值环设计的边界：scenario reference 不作为跨版本稳定身份）。
- **变体折叠**：导入与首次原生 run 的合并走 BM-6 折叠，导入不得绕过折叠直接铺行；折叠后仍近似的对进入人工队列（既有 keeper↔去重脚本的近似对处理先例）。
- **幂等**：同 workspace 重复导入同一 `revision + treeSha` 的快照为幂等 no-op（返回既有导入回执）；导入不同 revision 视为一次 BYO 更新（§8），走折叠，不并列铺行。
- **回滚**：导入事务原子；导入回执记录快照 identity 全量坐标，支持整批撤销（撤销不删除已产生的人工核实记录，核实记录独立于来源条目生命周期）。

## 7. 草稿的可见性与披露

- 账本读侧面（规格页、总览、MCP `search_scenarios`/`lookup_by_files`）对导入草稿**照常命中**，条目携带 `source = ai_snapshot_import` 与核实状态（导入后初始为 `unverified`），不搞读写隔离；「已核实/存在冲突」维度只有人工核实流程能产生，radar 快照天生全 AI 候选，页面措辞不得暗示其他状态。
- MCP 对草稿的定位遵循价值环拍板：**按需复核线索，非默认工作流**；MCP instructions 与文档措辞同步，不出现「自动验收」「行为契约」表述。
- 规格页对导入产品渲染来源注脚：「本产品知识由本地 radar 快照导入（SHA `xxxx`，contractVersion `x`），未经服务端独立分析」——与 R1 完整性披露同一渲染纪律。
- `unverified` 只表示未核实，不表示「无测试」；沿用价值环设计 §4 的全部不得推断边界。

## 8. BYO 持续模式与证据模式

### 8.1 证据模式

上传时可声明 `evidenceMode`，服务端持久化行为分叉：

| | A `excerpts`（默认） | B `anchors` |
|---|---|---|
| 持久化 | 规格 + 有界代码摘录（沿用证据消毒上限） | 规格 + 仅 `{path, startLine, endLine}` 锚点 |
| 服务端代码存量 | 仅被引用摘录行 | 零字节 |
| 服务端核实流 | 可用（核实人看得到摘录） | 核实动作仍可记录，但界面只显示锚点，核实人须在本地仓库对照；产品页如实标注「证据为锚点，服务端无摘录」 |
| MCP 证据返回 | 摘录 | 锚点（agent 本地有仓库，自行读取；token 更省） |

约束：

- 模式 B 的剥离发生在**服务端持久化之前**（上传层确定性变换），服务端任何表不得残留摘录字节；持久化后与入库前载荷一致性由测试断言。
- 模式是 workspace 级属性，可从 A 收紧到 B，不可从 B 放宽到 A（B 导入的摘录已不存在，无从放宽；A→B 为单向收紧，向用户明示不可逆）。
- 用户本地的 `radar.html` 无论服务端为何模式都含摘录——隐私宣称的主语永远是「CoDelphi 服务器」，产品页注明该边界，不夸大为「代码摘录不存在」。

### 8.2 上传节奏与发布账

- **v1（里程碑节奏）**：周期性全量快照上传，服务端按折叠合并；每次上传在发布账产生一条 `source = 'snapshot_upload'` 的发布记录（`committedAt` 取快照 identity），漂移检测沿 treeSha 链进行。
- 单调性：同产品后上传的 `treeSha` 必须不同于历史（内容未变 → 幂等 no-op 回执）；显式 `resync` 标记才允许回退到旧树，且记入发布账注记。
- **v2（本地增量）**：基线 SHA → 本地 diff → 仅变更分区重分析 → delta 上传。v2 独立设计评审后实施，不在本设计交付范围；delta 契约必须带 `contractVersion` 与基线坐标，服务端合并仍走既有机器。

## 9. 上传通道与鉴权

- 复用现有 API key 基础设施：新增 key 作用域 `snapshot:write`；签发/旋转/撤销沿用现有 UI 与表结构。
- 通道：`scripts/snapshot.ts` 新增 `upload` 子命令（或等价 CLI），读取 work dir 的 `snapshot.json`，按 `--evidence-mode` 剥离后 POST 至 `/api/products/import-snapshot`；密钥仅经环境变量注入，不落盘不提交。
- 服务端：组织隔离沿用现网解析；限流按 key 计（初值：每 key 每小时 10 次导入/上传，超出 429）；载荷大小上限与 §4.2 规模上限一致。
- 失败语义：校验失败返回结构化错误清单（可逐条修复后重传），网络失败客户端可安全重试（幂等键 = workspace + revision + treeSha）。

## 10. 私有仓库边界

- **官方路径（零改动）**：私有仓库用本地 clone 喂 radar（本地分支本就不校验公网性）。SKILL.md 与文档把本地 clone 写为私有仓库的标准做法；CoDelphi 全程不经手任何凭据。
- **P1 增强（可选）**：`target.ts` 接受 `git@host:owner/repo` SSH URL 与 `GITHUB_TOKEN` 环境变量注入的 https clone；凭据仅存在于用户机器进程环境。增强后 `parseGitHubRepository` 的 URL 归一化须与 §5.1 的 originRemote 归一化共用一份实现。
- **披露红线**：`radar.html` 与 `snapshot.json` 含真实代码摘录；当 `identity.source = local` 或仓库判定为私有可达时，报告页渲染显著提示「本报告含源码摘录，请勿公开分发」。SKILL.md 同步提醒。

## 11. 激励与计费

- 导入/上传**不消耗 SAU**；首次导入成功的 workspace 赠 1 SAU（复用 gift 钱包发放），每 workspace 仅一次，重复导入、多产品刷赠由 gift 发放的每 workspace 去重挡住；异常批量行为进人工队列。
- 首次原生分析（绑定了仓库且触发增量/全量 run）按现网计费规则执行：级 1 seeded 增量的成本本就远低于全量，属于双方同时省钱，不另设折扣。
- L3 订阅定价原则：按服务（存储、核实工作流、发布账、MCP 检索、席位）定价，与 token 无关；具体定价另行拍板，不在本设计范围。

## 12. 与价值环的治理关系

- MCP 相关改动（草稿披露、证据锚点返回形态）全部落在既有工具的输出层，不新增 MCP 工具；任何「对 agent 有净价值」的宣称以 `2026-11-16` 设计 §9 的二十任务正式试点结论为准，试点未通过前，本设计的文档与营销面不出现 agent 增益表述。
- `.radar/` 静态知识包是**待检验假设**（净时间模型与 MCP 不同：一次性读取 vs 每查询成本），不列入本设计交付；若立项，须先过同一价值环（同任务 ±知识包对照），通过后单独设计。

## 13. 阶段划分

**P0（最小闭环，本设计首批交付）**

1. `SnapshotIdentity` 扩展 `treeSha`/`originRemote` + manifest/导出继承（`lib/snapshot/types.ts`、`target.ts`、`workspace.ts`）。
2. work dir `snapshot.json` 确定性导出（`scripts/snapshot.ts`）。
3. 报告页分区计数口径修正（`report-data.ts`/`report-html.ts`：展示值 = 实际 work orders）。
4. 导入端点：校验链（§4.2）+ 实体映射 + 幂等 + 来源标记 + 事务（新增服务端模块）。
5. 三级匹配与 seeded 基线（§5）。
6. 草稿读侧披露（§7）。
7. `upload` 子命令 + `snapshot:write` key 作用域 + 限流（§9）。
8. 导入赠 SAU（复用 gift 钱包）。
9. 私有仓库披露红线（§10）。

**P1**：BYO 持续 v1（周期全量上传 + per-upload 发布账 + treeSha 链漂移）；证据模式 B；`git@`/token clone 增强；上传失败重试与断点。

**P2（各自独立评审后立项）**：本地 delta 增量（v2）；`.radar/` 静态包（价值环门控）；无 agent 环境用户的「托管代跑」SKU 评估。

## 14. 不做清单

- 不做符号级索引（grep/ctags/LSP 已解决；知识面只存本地检索拿不到的语义与锚点）。
- 不做设计决策章节与任何「为什么这样设计」的自由叙事（无人工核实即无签发）。
- 不做自动验收；`reconcile_release` 语义不变（独立复核信号，非判据）。
- 不让导入绕过变体折叠、`manual` 保护或核实生命周期。
- 不做 MCP 强制工作流或 session-start 注入；agent 面一律按需。
- 不引入 PostgreSQL、本地数据库容器或新密钥存储方式（MySQL 8、环境变量，仓库既有约定）。
- 不在模式 B 下宣称服务端可核验证据；不做 A→B 之外的证据模式放宽。
- 不为了导入而放宽快照 schema 校验；转换与降级宁可拒绝。

## 15. 影响面反查与对账锚点（2026-11-18 实查，经试点 T4/T5 修正）

- `lib/snapshot/types.ts`、`git-backend.ts`、`scripts/snapshot.ts`：反查为空，无存量红线。
- **`lib/snapshot/target.ts`：命中功能 20080「产品现状快照生成」（8 场景）**——HP-2 浅克隆+按需 fetch、ER-1 invalid_target、ER-2 ref 校验、ER-3 克隆失败先清理临时目录。P0-1（identity 扩展）与 P1（git@/token 增强）以这些场景为对账锚点；ER-3「失败先清理」是增强改动不得破坏的红线。
- **`lib/snapshot/workspace.ts`：命中功能 20069「产品快照分析工作区」（11 场景）**——HP-3 finalizeSnapshotWorkspace（合并+报告产出，**snapshot.json 导出的落点**）、EC-1 workspace_target_mismatch、EC-3 skippedExisting（**「430 vs 117」计数疑点的机制旁证**：旧批次工作单被跳过但计数器未同步）、EC-5 未知工作单、ER-1 缺结果不产报告。P0-2/P0-3 对账锚点在此。
- `lib/snapshot/report-data.ts`：命中功能 20080 的 EC-1..EC-4（presentation 回退、证据预算/截断/不可用、简介无证据置 null）——P0-3 计数修正不得触碰证据预算契约。
- `lib/ai.ts`：命中「AI 规格分析与发布变化」（13 场景，锚点 HP-5 逐字沿用/HP-24 注入客户端）与「版本化提取工作单契约」（HP-1/HP-2 工作单契约与证据清洗）。**P0 不触碰 `lib/ai.ts`**；若后续提取契约演进波及 `contractVersion` 语义，HP-1/HP-2 为对账锚点。
- `lib/mcp/server.ts`：当前反查为空（价值环设计 §2 记录过该文件曾有覆盖，提示文件可能已重组）；P0 不改 MCP 工具面，仅读侧来源披露——实施时以**当时的**逐文件反查为准，不以本节过期结论代替。
- `deploy.sh`（试点 T3 顺带实证）：命中「生产部署与回滚」与「Docker 构建与部署」——回滚链语义（ER-1/ER-2/HP-9）是任何部署脚本改动（含 prev= 日志修正）的红线。
- 服务端导入为全新模块，无存量红线；新增路由、限流与组织隔离沿用现网公共中间件。

## 16. 测试与生产验收

单元/集成测试至少覆盖：

- 导出确定性：同一 work dir 两次导出逐字节一致；identity 扩展字段在 local/github 两分支正确填充，旧 work dir 缺字段如实置空。
- 校验链：artifactKind/exportVersion/contractVersion 不匹配逐类拒绝；schema 违例、规模超限、绝对路径证据逐类拒绝；部分导入不发生。
- 三级匹配：SHA 可达/不可达 + treeSha 相等/不等 × 已连接/未连接的组合；dirty 快照不得 seeded；级 2 明确走全量首跑。
- 幂等与冲突：同 revision 重复导入 no-op 回执；导入与既有 `manual` 条目冲突进人工队列且 `manual` 内容零改动；折叠合并不产生并列重复行。
- 模式 B：入库后任何表无摘录字节（测试断言载荷剥离完整性）；A→B 单向收紧；MCP 锚点返回形态。
- 草稿披露：规格页来源注脚渲染；`search_scenarios`/`lookup_by_files` 命中草稿时来源与核实状态字段在位。
- 赠予：每 workspace 仅首次导入赠一次；0 SAU 计费路径不产生钱包扣减记录。
- 计数修正：报告页「分析分区」等于实际 work orders 数。

生产验收：

1. 用 SalesBuddy work dir（117 工单）在 staging 导入，核对 features/scenarios 计数与快照一致、折叠零并列重复、发布账出现 `snapshot_upload` 记录。
2. 同仓库直连后首跑：级 1 路径确认增量发生（非全量）且 `get_release` 可对账；级 2 构造历史改写用例确认全量兜底。
3. 模式 B 产品在 MCP 与规格页确认零摘录字节、锚点返回正确。
4. 草稿在 `lookup_by_files` 命中时来源/状态披露正确；`manual` 保护用例零扰动。

交付前运行 `npm run typecheck`、`npm test`、`npm run build`，随后独立代码审查与部署（部署需用户明确指令）。

## 17. 停止条件

- **L2 转化**：P0 上线后若 50 次 radar run 内导入率无信号（< 5%），暂停投入，回查是发现渠道问题还是价值问题，不自动加量推广。
- **导入→核实**：导入草稿 30 天内核实率为零的批次超过半数，说明草稿不值得核实，回查 concepts v2 生命周期层是否缺位，而非加大导入激励。
- **L3 BYO**：定价拍板后一个季度无付费客户，下线 L3 面板与通道，保留导入能力（L2 价值独立成立）。
- **滥用**：赠予去重失效或批量刷赠出现，先关赠予再查因，宁可错关不可放任。
- 以上任一停止条件触发时，对应能力降级或下线，不以「已投入」为由保留。
