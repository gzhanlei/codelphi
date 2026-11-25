# 客户端增量分析与 Delta Merge Contract 设计

日期：2026-11-24  
状态：2026-11-24 通过设计终审，同日按产品形态讨论的结论修订（§24.7）。产品负责人决定修订部分不再送外部评审，按本文档开工；进入实施的三项前置条件已满足（§22.1），先做身份层，再做增量协议
修订：2026-11-24 经一轮自查与四轮外部评审修订至终审；逐条变更见 §24，待确认取舍见 §24.2；同日按产品形态讨论修订，见 §24.7

## 1. 背景与目标

CoDelphi 当前由 GitHub push webhook 或页面操作在服务端执行 `runAnalysis`。客户端 Radar 已能在本地完成全量快照并上传 `snapshot.json`，但现有导入只适用于空产品，不能基于服务端已有规格持续增量同步。

本设计将持续分析拆成两个职责明确的子系统：

- **客户端是增量分析执行器**：从服务端取得权威基线，固定 Git 分析窗口，计算 diff，识别影响范围，读取必要源码，执行 AI 提取并生成带完整性信息的 delta。
- **服务端是行为账本维护器**：验证基线、delta 契约和并发状态，保护人工内容，合并完整规格，维护证据有效性、功能生命周期、发布、回归任务和分析水位。

分析与部署解耦。服务端部署不调用、不等待客户端或服务端 AI 分析；客户端分析发布是独立工作流。

核心质量原则：

> 每次只重新分析必要的部分，但每次生成的规格版本，都必须能够解释为什么其他部分仍然可信。

未被重新分析，不等于已证明不受影响。宁可保守扩大分析范围或要求 full resync，也不能在不确定时静默缩小范围。

## 2. 目标与非目标

### 2.1 目标

1. 服务端已有全量规格时，客户端只分析新增 commit 窗口及其受影响证据，不重复全仓分析。
2. 服务端始终保存完整规格；客户端只上传受影响、新增、退休或明确核对无变化的 delta。
3. 服务端能够独立重算直接证据影响，并拒绝漏报、未解决、基线冲突或不完整的 delta。
4. carry-forward 同时保留规格内容和证据来源，不伪造新的证据验证。
5. 功能删除采用有历史记录的 retire，不做物理删除。
6. 一次 delta 的基线检查、规格版本、发布、回归任务、证据状态和水位推进具备原子性与幂等性。
7. 客户端模式下服务端不主动拉取源码或重新执行源码分析，只处理客户端上传的 diff 以执行确定性校验；diff 只作传输态校验输入，不落任何表（§10.3）；不执行主分析或后置 AI 增强，不扣分析 SAU。
8. 保留现有一次性全量快照导入和服务端托管分析能力，默认行为不变。

### 2.2 非目标

- 首期不建设完整调用图、符号级依赖图、LSP 服务或动态运行时追踪。
- 不让服务端重新读取整个仓库来验证客户端声明。
- 不要求全量分析与增量分析的文本逐字相同；验收比较功能身份、行为语义、证据有效性和生命周期结果。
- 首期不支持多个长期分支写入同一规格版本链。
- 不取代人工核实生命周期；机器证据有效性与人工 `verified_at` 是不同维度。
- 不在本设计中修改生产部署、DNS、Webhook 或容器镜像配置。
- 首期不改写现网托管模式的行为性判定语义（patch-scan、BM-8）。客户端模式的分类规则独立版本化，两套语义的已知差异在 §8.3 显式登记。
- 首期不支持同一 head 的重建式全量重同步，也不支持多仓库产品的多条增量链。

## 3. 现状事实与约束

以下事实于 2026-11-24 对照代码逐条核实，是本设计的约束来源；与代码不符之处以代码为准并回写本节。

**服务端合并链**

- `saveResult`（`lib/analysis.ts`）在单事务内串联：产品简介补空 → `insertSpecVersion`（manual 合并、carried 合并、BM-4 身份劫持门禁、锚点级保真 `preserveUnchangedEvidence`、BM-11 变体折叠、可见性冲突、`diffSpec`、坍缩与跨域放置检测）→ 别名登记 → 文件索引重建 → `markSpecDrift` → 覆盖率回执 → 工作台 `upsertGeneratedSpec` → `upsertRelease`（release、release_files、changes、回归任务）→ run 置成功。提交后另有投影改写、流程图同步、通知、发布稿润色、影子分析、完整性账本等后置步骤，其中多项调用模型。
- 托管增量判定是五条件门禁 `resolveAnalysisMode`：无上一版、受影响集为空、diff 文件数超过 200、受影响功能占比超过 0.6，或本就是全量模式时回退全量；RC2 回退按 patch-scan 的行为变更集重新计算受影响面。增量提取装配 `required_only` 分区，必选路径 = diff 文件 ∪ 受影响功能的基线证据路径。
- 托管增量提取已有经盲评验证的输出契约（`lib/ai.ts` 的 `incrementalScopeSection`，W0-10 三类输出）：清单内受影响功能完整重提取、清单外新发现必须独立输出、未归属的行为变更文件显式交给模型核对；单功能输出条数不超过锚条数 +3。锚点级保真规则（`preserveUnchangedEvidence`）：旧行锚点不与行为变更 hunk 相交即原样保留，并按 hunk 确定性重映射行号；相交或无行号才交给模型裁决。
- `spec_versions.analysis_run_id` 非空且唯一，每个规格版本必须对应一条 run。`releases` 以 `(repository_id, sha)` 唯一，`spec_version_id` 也唯一；`analysis_runs.trigger_type` 是 `VARCHAR(16)`。

**身份与键**

- 现网 `spec_features.stable_key` 在每次落版本时由功能名重新计算（`insertFeatures` 调 `specFeatureKey(name)`），场景身份是 `(功能名, reference)`，manual 墓碑同样按名称与 reference 记录。现行 `stableKey` 是名称级键，不是跨版本身份；功能改名即换键。这与同日 `2026-11-24-mcp-map-change-design.md` 记录的事实一致。
- 名称键的消费方成串：`spec_changes.feature_key` 与 `spec_features.stable_key`、`spec_scenarios.reference` 的连接（回归任务 `ensureRegressionTasks`、`markSpecDrift`、`loadFeatureHistory`、稳定链接 `lib/stable-links.ts`）都依赖“键 = 名称小写化”。任何让改名保留身份的方案都必须让这些消费方继续可用（§9.2、§20）。
- 功能树的父子关系 `parent_key` 也是父功能的名称键。

**工作台与人工保护**

- 工作台 `features` 以 `(product_id, name)` 唯一，`scenarios` 以 `(feature_id, reference)` 唯一，并承载 `display_name`、`parent_id`、人工核实列（`verified_at/verified_by`）与漂移标记（`stale_since/stale_change_id`）。用户在工作台编辑自动条目的名称、摘要、父子关系或场景内容，会把该行就地转为 `manual`；只改显示名（`display_name`）不转换来源。工作台编辑不产生新的规格版本。
- 文件索引 `spec_file_index` 由整个最新版本重建，包含 manual 场景的证据，因此 manual 条目会出现在“直接命中”结果里。
- `upsertGeneratedSpec` 目前只下线并重写 `source='generated'` 的工作台条目；`source='ai_snapshot_import'` 的条目既不下线也不更新（`ON DUPLICATE KEY UPDATE` 受 source 守卫）。“导入条目与 generated 同属自动条目”是本设计要达成的目标，不是现状。
- 版本层的 `spec_features.source`、`spec_scenarios.source` 仍是 `VARCHAR(16)`，放不下 `ai_snapshot_import`（17 字符）；migration 078 只加宽了工作台两张表。

**行为性判定与模式语义**

- patch-scan（`behavioralChangePaths`）是现有共享纯函数：测试、文档、CI 与锁文件路径不构成行为变更（BM-8）；只有 JS/TS/Python 识别注释与格式重排，其他语言一律按行为变更；patch 缺失、为空或超过 4,000 字符按行为变更；不感知 rename 等文件状态。
- 零行为变更窗口（BM-10）整体沿用上一版并继承覆盖率回执；输出语言切换（migration 072）强制全量重建。
- PR 预演（`lib/pr-preview.ts`）是确定性索引查询：只用 PR 文件清单里的路径反查索引，不调用模型，不持久化 diff。
- 触发模式 `push/daily/push_count` 是托管计费的校准机制，兜底 sweep 以“最近一次成功 run 的 `after_sha`”为水位。

**客户端 Radar 与导入通道**

- Radar 的 `prepareSnapshotAnalysis` 里 `change.files` 为空、`previousFeatureNames` 为空；工作目录绑定单一 revision（`workspace_target_mismatch`）；GitHub URL 目标使用 `--depth 1 --no-checkout` 浅克隆；`snapshot.json` 导出是确定性的。
- `snapshot.json` 导入（`/api/products/import-snapshot`）只写工作台草稿（`source='ai_snapshot_import'`），不产生规格版本、发布或文件索引。现行导入只在 origin 是 github.com 时建 `repositories` 行，其余产品处于未绑定状态；而规格版本必须有仓库行。`repositories` 没有远端地址列，身份是 `provider`、`owner`、`name` 三列，都非空且三者唯一（§16.3）。
- 导入鉴权是 `snapshot_write` 作用域的 API Key；限流为每 Key 每小时 10 次；分块组装器是路由私有函数，组装态只存单实例内存。导入产物里的代码摘录只传输、不入库（BYO 设计 §8.1 证据模式 B）。

约束不变：不引入 PostgreSQL、本地数据库容器、Redis 或新的密钥存储方式，继续使用 MySQL 8 与环境变量。

## 4. 术语

| 术语 | 含义 |
|---|---|
| 基线 | 服务端当前接受的 `repositoryId + branch + baseSha + baseTreeSha + baseSpecVersionId + contractVersion` |
| 分析窗口 | 固定的 `baseSha..headSha`，包含一次或多次 commit |
| 直接影响 | 变更路径命中基线证据索引，或重命名旧路径命中索引 |
| 扩展影响 | 由确定性规则从直接命中进一步得到的封闭受影响集合 |
| 全局影响 | 无法通过当前规则形成可信封闭集合，必须扩大分析或 full resync 的影响 |
| declared | 客户端声明可能受影响的旧功能集合 |
| analyzed | 客户端已完成重提取或确定性重核对并达到终态的旧功能集合 |
| unresolved | 无法确认影响、读取、分析或证据校验的旧功能/文件集合 |
| carry-forward | 服务端从基线原样继承未受影响且符合合并条件的条目 |
| retire | 在当前版本中停止活跃，同时保留历史及退休原因 |
| 机器证据有效性 | 证据版本与影响检查状态，不代表人工核实，也不代表运行时行为已被测试 |
| 自动条目 | `source` 为 `generated` 或 `ai_snapshot_import` 的功能或场景；可被自动操作 |
| manual 条目 | `source='manual'` 的功能或场景；只受人工权威规则约束，不接受自动操作 |
| 身份键 | 契约字段 `stableKey`/`scenarioStableKey` 的取值，跨版本稳定；与现网按名称计算的名称键不是一回事（§3、§9.2） |
| 名称键 | `specFeatureKey(name)` 与 `(功能名, reference)`；现网 `spec_features.stable_key`、`spec_changes.feature_key` 存的是它 |

## 5. 总体流程

```text
客户端 GET analysis-baseline
  → 固定 branch/base/head/tree/specVersion/contractVersion
  → 校验 clean commit、分支、Git 祖先关系与输出语言
  → 本地计算完整 diff 与 rename/delete 映射
  → 确定性文件分类与影响识别
  → direct / expanded_closed / no_behavior / no_detected_behavior_change / global_unbounded / unknown
  → 对可安全增量的范围生成工作单
  → 只读取 diff、受影响旧证据和必要上下文
  → 客户端执行 AI 或确定性无行为处理
  → 生成 delta、featureOperations、workOrderReceipts、coverage
  → 服务端计算规范化 deltaHash
  → 单事务锁仓库并复核当前基线
  → 服务端重算直接影响和确定性分类
  → 校验集合关系、生命周期、证据、完整性和 manual 冲突
  → 合并完整规格并生成版本、发布、回归任务、审计和水位
  → 提交后返回 releaseId/specVersionId/runId/服务端合并回执
```

服务端部署流程与上述流程没有依赖关系。

## 6. 基线契约

### 6.1 接口

新增：

```http
GET /api/products/{slug}/analysis-baseline
Authorization: Bearer <snapshot_write key>
```

服务端从 API key 取得组织，从 slug 取得产品和仓库，不能由客户端指定其他组织或 repositoryId。仓库必须已启用 `client` 执行模式（§17）；否则返回 `analysis_mode_mismatch`，不下发可被误用的基线。产品下的分析仓库沿用现行“一产品一仓库”模型，出现多行时失败关闭。

响应：

```jsonc
{
  "repositoryId": 3,
  "branch": "main",
  "baseSha": "abc...",
  "baseTreeSha": "def...",
  "baseSpecVersionId": 123,
  "contractVersion": "1.0.0",
  "impactRulesVersion": "impact-v1",
  "diffContractVersion": "git-diff-v1",
  "outputLanguage": "zh-CN",
  "sourceRoots": [],
  "features": [
    {
      "stableKey": "billing",
      "name": "Billing",
      "source": "generated",
      "parentKey": null,
      "summary": "...",
      "scenarios": [
        {
          "scenarioStableKey": "billing-happy-1",
          "reference": "HP-1",
          "source": "generated",
          "context": "...",
          "action": "...",
          "outcome": "...",
          "category": "happy",
          "step": 1,
          "evidence": [
            { "path": "src/billing/create-invoice.ts", "startLine": 10, "endLine": 30 }
          ],
          "provenance": {
            "evidenceRevision": "abc...",
            "lastVerifiedRevision": "abc...",
            "evidenceStatus": "valid",
            "evidenceReason": "reanalyzed",
            "evidenceAuthority": "client_delta",
            "impactStatus": "expanded_closed_outside",
            "impactCheckAuthority": "deterministic_rule",
            "lastImpactCheckedRevision": "abc...",
            "lastImpactRulesVersion": "impact-v1"
          }
        }
      ]
    }
  ],
  "fileIndex": [
    { "path": "src/billing/create-invoice.ts", "featureKeys": ["billing"] }
  ],
  "consumerIndexes": [
    {
      "path": "src/shared/permissions.ts",
      "featureKeys": ["billing", "admin", "login"],
      "closed": true,
      "indexVersion": "declared-registry-v1"
    }
  ],
  "evidenceProvenance": {
    "status": "valid | pending_review | stale | unknown | mixed"
  }
}
```

`features` 用于命名连续性、场景措辞锚定和证据读取，同时告诉客户端哪些条目是 manual（`source='manual'`，功能级与场景级分别给出）。`source` 以工作台当前状态为准，即基线版本叠加当前 manual 规格，口径与下一次合并时的 `mergeSpecSources` 相同；工作台编辑不产生新版本，只看版本快照会把编辑后已转为 manual 的条目当成自动条目。`fileIndex` 与服务端当前 `spec_file_index` 同源；服务端重算直接命中时以基线版本的 `spec_scenarios.evidence` 为准，索引只作加速，两者不一致按服务端缺陷失败关闭。`consumerIndexes` 只包含服务端可重算的确定性消费者索引，来源与首期范围见 §8.1；上面的条目只是形状示意，首期为空。响应不包含源码摘录。

基线响应可达数 MB（SalesBuddy 实测 1024 功能、4495 场景），必须 gzip 传输并以 `baseSpecVersionId` 作为 ETag。客户端不得把整份基线写进模型上下文，只取声明功能与 `fileIndex` 所需部分。

无基线时返回 `baseSpecVersionId=null`、`baseSha=null`，客户端不得构造伪造 delta。对于准备持续使用 `client` 模式的产品，首次全量快照发布必须同时创建初始 spec version、release、文件索引和水位，使下一次 `publish` 能直接增量；现有仅供浏览的一次性草稿导入可以保留原行为。只有旧草稿、没有规格版本的既有导入产品，必须先通过显式全量发布或确定性回填建立基线，不能假装已有增量起点。两条路径的条件见 §16.3。

### 6.2 基线一致性

客户端工作单和 delta 必须同时携带：

```jsonc
{
  "repositoryId": 3,
  "branch": "main",
  "baseSha": "abc...",
  "baseTreeSha": "def...",
  "headSha": "xyz...",
  "headTreeSha": "uvw...",
  "baseSpecVersionId": 123,
  "contractVersion": "1.0.0",
  "impactRulesVersion": "impact-v1",
  "diffContractVersion": "git-diff-v1",
  "language": "zh-CN"
}
```

- `baseSpecVersionId` 是合并与并发权威；SHA 是 Git 窗口权威，两者缺一不可。
- 既有服务端基线没有 tree SHA 时，`baseTreeSha=null`。客户端可提交本地计算的 tree SHA 作为**客户端声明**，服务端不得标成独立验证事实；首次成功 delta 后的 head tree SHA 成为后续连续性锚。
- `repositoryId` 必须与服务端解析结果一致。
- 三个版本字段各管一段语义，任一不兼容即拒绝，不做自动转换：
  - `contractVersion` 是提取契约版本（现行 `lib/extraction-contract.ts` 的 `CONTRACT_VERSION`），约束工作单的 prompt、输出 schema 与证据允许集语义。
  - `diffContractVersion` 是 Git diff 生成规则（§7.1）。
  - `impactRulesVersion` 是文件分类、影响识别与服务端合并判定的规则（§8、§9）。delta 产物自身的形状由 `exportVersion` 约束。
- `language` 必须等于基线 `outputLanguage`。输出语言切换在现网即强制全量重建（migration 072），增量不得产出混合语言的规格；不一致返回 `full_resync_required`，原因为 `output_language_changed`。

## 7. Git 与分支语义

| 情况 | 处理 |
|---|---|
| 正常向前提交 | 增量分析 `baseSha..headSha` |
| 多 commit 一次推送 | 一次分析整个窗口，不逐个重复扫描共同证据 |
| head 与 base 相同 | 幂等 no-op，不创建新版本 |
| head 是 base 的祖先，本地落后于账本 | 空操作，不创建新版本；提示本地落后。需要时先更新本地，不转全量重同步 |
| base 与 head 互不为祖先，两者分叉 | `full_resync_required`，由用户确认后执行 |
| force push 或基线不在当前分支历史 | `full_resync_required` |
| 分析期间本地 HEAD 继续前进 | 本轮仍绑定原 head；下一轮从本轮已接受 head 继续 |
| 分支与基线分支不同 | `branch_conflict`，不得混入同一版本链 |
| detached HEAD | 允许：head 是确定 commit，但必须位于跟踪分支的历史上，否则 `branch_conflict` |
| 输出语言与基线不一致 | `full_resync_required`，由显式全量重同步以新语言重建 |
| 本地缺少 base 对应的提交对象（浅克隆，或账本由另一份克隆推进） | 有远端时先显式 fetch，补齐后按祖先关系分类。补不齐不得增量，也不自动转全量：先提示更新本地；确认该提交已经不可达，例如远端历史被改写、本地是改写之后的新克隆，再由用户显式执行全量重同步。没有远端时同样处理 |
| 仓库有远端，本地 head 与远端默认分支的最新提交不同 | 不发布：本地领先提示先推送，本地落后提示先拉取，两者分叉提示先协调 |
| 仓库有远端，本地 head 与远端最新提交相同，远端最新提交是 base 的祖先 | 不发布。账本领先于远端：远端历史被改写，或此前发布过未推送的提交。需要全量重同步时由用户确认 |
| 仓库没有远端 | 发布对象是本地跟踪分支的最新提交，本地 head 必须与它相同；其余判断相同 |
| working tree dirty | 拒绝持续发布，防止把未提交内容伪装成 commit 事实 |
| commit SHA 相同 | 不再以工作区状态另造 delta；tree 身份随 commit 固定 |

跟踪分支是有远端时代码托管平台上配置的默认分支，不假定为 `main`；没有远端时，是首次发布时为该产品登记的本地分支（§16.3）。有远端指仓库有名为 `origin` 的远端，与 Radar 现有的 `readOriginRemote` 一致；没有 `origin` 的仓库按没有远端处理，命令行在输出里说明。

发布的目标提交是跟踪分支的最新提交。有远端时，本地 head 必须与远端默认分支的最新提交相同，只发布已经推送的提交；没有远端时，本地 head 必须与本地跟踪分支的最新提交相同。

判定按固定顺序进行，一次只落到一个状态。表里几行可能同时成立，先命中的一行决定处理方式。关系必须用 Git 提交图判断，不能只比较提交号：提交号不相等只能说明两个提交不同。

前提是本地 head 在跟踪分支的历史上，否则按上表里分支和 detached HEAD 两行处理，不进入下面的判断。

1. 取目标提交，也就是跟踪分支的最新提交。有远端时先 fetch，再在本地读远端跟踪引用；读不到返回 `remote_unavailable`，不做发布判断。没有远端时，目标提交是本地跟踪分支的最新提交。
2. 本地是否已有需要的提交，包括目标提交和 base。有远端而缺对象时，fetch 后回到第 1 步；fetch 之后仍然缺 base，按“本地缺少 base 对应的提交对象”一行处理。
3. 本地 head 与 base 相同：一致，空操作。
4. 本地 head 与目标提交不同：不发布。有远端时，本地领先提示先推送，本地落后提示先拉取，两者分叉提示先协调；没有远端时，提示先检出跟踪分支的最新提交。
5. 到这一步本地 head 就是目标提交。base 是它的祖先，进入增量发布，窗口是 `base..head`。它是 base 的祖先，空操作，不创建新版本：没有远端时提示本地落后，有远端时说明账本领先于远端。两者互不为祖先，`full_resync_required`，由用户确认后执行。

fetch 只更新远端跟踪引用，不改工作区，也不切换当前检出的分支。`publish` 不得为了让判定通过，对用户的工作区执行检出、合并、变基或重置，并且要说明自己执行了哪些 Git 操作。

目标提交由命令行在本地读取，不经服务端，也不依赖代码托管平台的适配。已实测（Git 2.54.0）：克隆会把远端的默认分支记在 `refs/remotes/origin/HEAD`，没有这条记录时 `git fetch` 会补上；fetch 只更新远端跟踪引用，本地 head、当前分支和未提交的改动都不动；远端不可达时 fetch 以非零退出。平台之后改了默认分支，这条本地记录不会跟着变，要用 `git remote set-head origin --auto` 刷新，它同样要访问远端。所以命令行每次发布都刷新一次，刷新失败按 `remote_unavailable` 处理。

上传前再复查一次。分析可能持续几分钟，这段时间里跟踪分支可能被推进，例如一个 PR 被合并；也可能被改写。上传前 `publish` 再取一次目标提交，有远端时重新 fetch：分析开始时的目标提交仍是它的祖先、或与它相等，才上传。远端只是向前推进时不放弃：目标提交仍在默认分支的历史上，这次发布有效，账本落后的一截由下一次发布补上。既不是祖先也不相等时不上传，提示远端历史已改写。这是客户端的乐观检查，不是强一致保证：服务端在事务里不查远端，只校验账本基线（§14.1）。

`publish` 读取的全部内容必须来自固定 head 的 Git 对象，而不是工作区文件。现有本地后端经 `git cat-file` 读 blob，已经满足这一点，dirty 检查是对它的兜底。dirty 判定沿用 `resolveGitSnapshot` 的现行口径（`git status --porcelain`，未跟踪文件也算 dirty）。

首期只接受服务端配置的单一分析分支，也就是仓库行的 `default_branch`。其他分支返回 `branch_not_tracked`。切换分析分支时必须显式建立新基线或 full resync，不能把旧分支水位直接沿用。

`--full-resync` 在 head 等于当前水位 sha 时是 no-op。首期不支持同一 head 的重建式重同步；现网 `reanalyze-latest` 的“同 sha 重分析并把发布重指到新版本”能力不带入 client 模式。

### 7.1 Git Diff Contract

`diffContractVersion=git-diff-v1` 独立于 `impactRulesVersion`。客户端必须按固定参数从 Git 对象生成 diff，不能依赖当前工作区、用户配置或平台默认值。文件清单与补丁分两次调用生成，不得合并成一条命令：`--raw -z` 与 `--patch` 合用时，Git 实际输出的是“全部 raw 记录 + 一个分隔 NUL + 全部补丁”的混合流，这种排布没有文档保证，解析必然脆弱。

```text
# 文件清单：模式、blob id、状态与相似度（NUL 分隔）
git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --find-renames=50% --raw -z <baseSha> <headSha> --
git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --find-renames=50% --name-status -z <baseSha> <headSha> --
# 补丁：同一组参数，单独一次调用
git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --find-renames=50% --patch <baseSha> <headSha> --
```

两次调用只有输出格式不同，文件顺序相同。补丁按这个顺序与清单逐段对应；不得解析补丁头行来取路径，因为头行会按 `core.quotePath` 对非 ASCII 路径做八进制转义，对含引号的路径做 C 转义。

用 `--raw -z` 做清单，是因为每条记录自带新旧文件模式与 blob id（形如 `:100644 100644 <oldBlob> <newBlob> R100\0old\0new\0`）。服务端据此可以独立核对纯重命名（同一 blob）、symlink（模式 `120000`）与 submodule（模式 `160000`）变化，不必采信客户端的分类结论。

契约字段：

```jsonc
{
  "diffContractVersion": "git-diff-v1",
  "renameDetection": { "enabled": true, "similarityThreshold": 50, "renameLimit": "<契约常量>", "copyDetection": false },
  "submodulePolicy": "global_unbounded",
  "symlinkPolicy": "global_unbounded",
  "binaryFilePolicy": "content_detect",
  "pathEncoding": "utf-8-reject-other",
  "generator": {
    "minGitVersion": "<契约常量>",
    "verifiedGitVersions": ["<落地时填入实测版本>"],
    "patchBytesStableAcrossVersions": false
  },
  "patchComplete": true
}
```

规则：

- rename 是清单里的显式记录，不由服务端根据名称猜测。`oldPath/newPath`、状态和 patch 必须一致；delete+add 不得在协议层擅自改写成 rename。纯重命名（同一 blob 或 `R100`）不得携带内容 hunk。
- rename 检测的全部参数由契约钉死（相似度阈值与 `renameLimit`）。rename 检测在 Git 内部是多阶段匹配，上限的作用范围随版本演进；这里不对它的退化形态做任何假设，只要求两端用同一组参数，使同一窗口在任何环境下得到同一份清单。
- 路径字段取 Git tree 的原始字节（UTF-8），统一 `/` 分隔，大小写保留并精确比较；拒绝绝对路径、`..`、NUL、非 UTF-8 和规范化后冲突的路径。NFC 归一只用于冲突检测，不改写路径本身：NFC 相等或仅大小写不同的路径按 `global_unbounded` 处理。
- `--no-textconv` 与 `core.quotePath=false` 必须显式给出。前者避免 `.gitattributes` 配置的 textconv 过滤器让补丁内容随用户环境变化；后者只影响补丁头行的转义形态，钉死它是为了让补丁字节可复现。
- symlink 与 submodule 变化为 `global_unbounded`；二进制内容按 §8.3 的路径规则分类；仅文件模式变化（如可执行位）为 `no_detected_behavior_change`。
- 二进制以 blob 内容判定（前 8000 字节含 NUL，与 Git 自身的二进制启发式一致），不得以补丁形态推断：`.gitattributes` 的 `-diff` 属性会让纯文本文件也输出 `Binary files … differ`。
- 单文件 patch 超过 1,000,000 字节、总 patch 超过 16,000,000 字节、变更文件超过 2,000 个或组装 delta 超过 64,000,000 字节时拒绝，错误码 `delta_too_large`。这里是传输与资源安全上限，不是知识数量上限；超限窗口转全量重同步。
- 任何 patch 截断、缺失、无法解析或 `patchComplete=false` 都失败关闭，不得把截断 patch 当作完整 diff。
- 服务端按同一 diff 契约解释记录并检查内部一致性（清单与 `impactClassifications` 的路径、状态、模式逐项吻合，纯重命名无 hunk），但不声称在没有 Git 对象的情况下重新计算了 rename 相似度或验证了真实仓库 diff。
- 补丁文本受 Git 版本的 xdiff 实现影响，不承诺跨版本逐字节一致。幂等因此依赖重传同一份已生成的 `delta.json`，而不是重新生成（§14.3）。
- 固定命令参数不等于固定 Git 行为。`generator` 记录生成端的确定性边界：Git 最低版本与已验证版本集合是契约常量，首次落地时填入实测版本（本节的行为在 git 2.54.0 上实测）。不同 Git 版本可以生成同一契约，但只保证清单一致（路径、状态、模式、blob id、rename 关系），不保证补丁字节一致。客户端在 delta 里声明自己的 Git 版本，服务端对低于最低版本的声明直接拒绝，并且不得把这串版本号标成已验证事实。
- 清单与补丁的关联校验失败时，错误回执定位到清单里的文件序号、路径和失败的检查项。非 UTF-8 路径按十六进制转义显示，不回显原始字节；回执不携带补丁内容。
- “服务端检查了 delta 内部一致”与“客户端提交的是真实仓库的 diff”是两件事，回执里分开命名：前者是 `diffInternalConsistency`，属于 `serverVerified`；后者是 `diffAuthenticity`，属于 `clientDeclared`（§11.2）。API 与产品界面沿用这两个名字，不得把前者说成“服务端验证了 Git diff”。

## 8. Impact Classification

### 8.1 原则

影响识别分两层：

1. **直接证据命中**：服务端和客户端使用同一基线索引与同一纯函数计算。
2. **全局影响扩展**：对共享基础设施、公共接口、全局配置等执行确定性分类。`expanded_closed` 表示已有确定性消费者索引能列出完整影响集合，允许增量；`global_unbounded` 表示无法证明集合封闭，必须 full resync。两者是不同终态，不能共用 `global_review` 之类的中间状态。

没有命中证据索引，只表示“没有直接证据命中”，不表示“没有影响”。`expanded_closed` 的封闭性只能来自服务端也可重算的确定性索引或规则，不能来自客户端对调用关系的自由推断；首期不为此建设完整调用图。

**consumer index 的来源。** 封闭消费者集必须有生产者，否则 `expanded_closed` 无从成立。`impact-v1` 不包含任何 consumer index 的生产者：首期 `consumerIndexes` 恒为空，`expanded_closed` 是为后续规则版本保留的终态，共享文件一律落入 `global_unbounded`。要让某个共享文件获得封闭集，只能由仓库显式声明 registry（路径到封闭消费者功能集合的映射），其声明入口、校验与失效规则须随对应的 `impactRulesVersion` 单独评审。这一点直接决定首期的增量可用率（§19.4）。

**“扩大分析范围”的含义。** 客户端可以在 delta 内声明比 `serverRequiredAffectedFeatureKeys` 更多的受影响功能并重分析它们，这叫扩大范围，只适用于文件分类不含 `global_unbounded` 与 `unknown` 的窗口。文件分类一旦含这两者，扩大声明集不能解除拒绝，只能 full resync。

### 8.2 每个文件的分类记录

客户端必须上传逐文件记录。路径、状态、新旧模式与 blob id 必须与 §7.1 的 `--raw -z` 清单逐项一致，由服务端直接核对；分类结论由服务端使用相同 `impactRulesVersion` 重算。

```jsonc
{
  "path": "middleware/auth.ts",
  "oldPath": null,
  "status": "modified | added | deleted | renamed",
  "oldMode": "100644",
  "newMode": "100644",
  "oldBlobSha": "...",
  "newBlobSha": "...",
  "binary": false,
  "classification": "direct | expanded_closed | global_unbounded | no_behavior | no_detected_behavior_change | unknown",
  "behaviorImpact": "none | possible | unknown",
  "reason": "shared_permission_middleware",
  "directFeatureKeys": [],
  "expandedFeatureKeys": [],
  "analysisDisposition": "analyzed | skipped_deterministic | full_resync_required | unresolved",
  "declarationSource": "deterministic_rule | client_inference"
}
```

`classification` 与 `reason` 是规则码，取值集合属于 `impactRulesVersion`，不是自由文本。客户端推断必须单独标记，不能伪装成服务端已验证事实。

### 8.3 分类规则

| 变更类型 | 默认分类与处理 |
|---|---|
| 普通实现文件，命中证据索引 | `direct`；重分析命中的旧功能 |
| 新普通实现文件，未命中旧索引 | 允许作为新功能候选分析；不得因此忽略同窗口其他影响 |
| 文件删除 | 旧路径执行直接影响计算；相关功能必须 upsert、unchanged 或 retire，不能无声 carry |
| 纯重命名且 blob 相同 | 旧、新路径共同映射；可确定性重锚证据并记 `no_detected_behavior_change` |
| 重命名且内容变化 | 按旧、新路径计算直接影响并重分析 |
| 共享模块已有确定性完整消费者索引 | `expanded_closed`；direct 与全部扩展消费者都进入 serverRequired 并重分析 |
| `shared/`、`common/`、公共 utils、barrel/public API、全局类型定义 | 若规则不能证明封闭消费集，则 `global_unbounded` |
| middleware、路由注册、权限策略、依赖注入或 registry | `global_unbounded`；默认要求 full resync |
| 数据库迁移脚本：`migrations/`、`migration/` 目录下的文件，以及所有 `.sql` 文件 | `no_detected_behavior_change`，原因码 `schema_artifact`。迁移脚本已移出分析目标（2026-11-25，见下文与 §23），不需要补丁证据；纯重命名仍按上面的纯重命名一行处理，带上重锚信息 |
| ORM 模型与 schema 定义：`models/`、`*.entity.ts`、`*.prisma`、`*.graphql`，以及数据库权限或 RLS | `global_unbounded`，不得按普通文件 carry |
| 环境变量、运行时配置、功能开关 | `global_unbounded` 或 `unknown`，不得归入无行为 |
| 依赖清单、lockfile、构建产物版本变化 | `global_unbounded`；不能按文档处理 |
| CI/部署配置 | 至少 `no_detected_behavior_change`；影响运行入口、环境或权限时 `global_unbounded` |
| 测试代码 | `no_detected_behavior_change`；记录验证可信度影响，不声称产品行为已证明不变 |
| README、非运行时文档 | 经确定性 diff 检查后可为 `no_behavior` |
| 仅注释、空白或格式化 | 只有 patch-scan 能确定无语义代码变化时才为 `no_behavior` |
| 单纯变量重命名 | 不自动认定无行为；无法确定时进入 AI 分析或 `unknown` |
| 动态调用、反射、约定式注册且无法静态判定 | `unknown` 或 `global_unbounded` |
| 二进制内容 | 命中已知非行为资产规则（`impact-v1`：文档目录或常见图片、音视频、字体扩展名）时为 `no_detected_behavior_change`，原因 `binary_asset`；否则 `unknown` |
| 版本控制与编辑器配置（`.gitattributes`、`.gitignore`、`.editorconfig` 等） | `no_detected_behavior_change` |

一个文件同时命中多行时取最保守的一档：`global_unbounded` > `unknown` > `expanded_closed` 与 `direct` > `no_detected_behavior_change` > `no_behavior`。迁移脚本那一行也遵守这条：路径同时落在别的全局规则里时（例如 `config/migrations/001.sql`）取全局规则。

**迁移脚本已移出分析目标（2026-11-25 产品负责人决定）。** 原因来自现网账本：抽查 30 条引用迁移脚本的场景，真正从建表语句分析出行为描述的只有 4 条，另有 4 条转述的是迁移文件头部的开发者注释；11 条是一次性的迁移事件（“迁移 027 回填了…”），11 条是把运行时行为错挂到了迁移文件上。迁移文件对行为描述的贡献小、噪声大，却是全量重同步的头号来源（§19.4）。决定之后，托管分析与客户端分类器用同一个判定：

- 选材不选它，窗口 diff 的强制装入也跳过它。
- 提示词的“文件变化”一节不带它的补丁；证据允许集不含它，模型仍然引用它的场景按不可溯源剔除。
- 受影响功能反查、必选路径和 PR 预演都不按它查。改了迁移脚本的功能不因此被重新分析。
- 覆盖率口径不算它：实现面分母、装配面分子、diff 口径、库存清单的入选面都不含它，否则每次带迁移的提交都会显示成有遗漏。
- 只改迁移脚本的提交走零变更通道：不调模型，上一版规格原样沿用。
- 现有账本里引用迁移脚本的锚点留作历史，不批量清理；发布页照实列出迁移文件，只是不再标为行为变更。

ORM 模型代码与 schema 定义文件不在此列，仍按上一行的全局规则处理。

表中“公共 utils”“barrel”“路由注册”是类别描述，不是可执行规则。`impact-v1` 必须把它们落成明确的路径模式清单，两端跑同一份实现；没有落成模式的类别一律按 `global_unbounded`。全局规则针对的是装配点，而不是被装配的实现：路由处理函数、中间件函数体本身是普通实现文件，走 `direct`；把它们挂接起来的注册与装配文件才是 `global_unbounded`。

与现网托管语义的已知差异在此登记，不做隐藏：patch-scan（BM-8）把锁文件与 CI 路径视为非行为变更，本表对锁文件取更严的 `global_unbounded`。这是有意的收紧，取舍见 §24.2。

`no_behavior` 与 `no_detected_behavior_change` 的文件级判定复用 patch-scan（`behavioralChangePaths`）及其路径分级，并随 `impact-v1` 做一处扩展：感知文件状态，纯重命名的空 patch 不再被当成行为变更。patch-scan 现行的保守边界原样保留——只有 JS/TS/Python 识别注释与格式重排，其他语言一律按行为变更；patch 缺失、为空或超过 4,000 字符按行为变更。它的已知盲区同样带入：`.md` 一律按文档处理，源码树内的 Markdown 提示词文件会被判为 `no_behavior`。该盲区在托管模式同样存在；若要按仓库覆盖，只能作为 `impactRulesVersion` 的后续版本内容。

共享文件即使命中部分历史证据，也不能据此证明未命中功能不受影响。只要分类为 `global_unbounded` 且没有封闭扩展证明，delta 不得激活。

### 8.4 服务端独立检查与残余边界

服务端独立重算并持久化以下集合：

```text
serverDirectAffectedFeatureKeys
serverExpandedAffectedFeatureKeys
serverRequiredAffectedFeatureKeys =
  serverDirectAffectedFeatureKeys ∪ serverExpandedAffectedFeatureKeys
serverGlobalImpactFiles
```

`serverRequiredAffectedFeatureKeys` 只含自动功能。manual 条目的命中单独汇总为 `serverManualReviewFeatureKeys`，只用于披露与漂移标记，不构成客户端义务（§9.4）。

检查内容包括：

- changed/deleted/renamed path 与基线 `fileIndex` 的直接交集。
- `expanded_closed` 的确定性消费者索引、封闭集合证明及其版本。
- 文件分类规则及其结果，以及 `global_unbounded`、未知分类的拒绝条件。
- `serverRequiredAffectedFeatureKeys ⊆ declaredAffectedFeatureKeys`，直接和扩展影响都不能漏报。
- 激活时 `serverGlobalImpactFiles = ∅`。

客户端可以声明额外影响并扩大分析范围，但不能用声明替代服务端的 closed 证明，也不能通过增加 `context` 规避 unbounded 拒绝。

**证据覆盖召回边界。** 直接命中以基线证据锚为索引，而证据锚只是实现面的有损投影（全量单趟召回在代码注释里记录的实测值是 40–50%）。改动一个“属于某功能实现、却不是该功能任何场景证据锚”的文件，不产生直接命中，该功能会被 carry。这是索引口径的上限，不是客户端漏报。首期的对策不是建调用图，而是把现网增量提取的第三类输出（W0-10 ③）搬到客户端并定为义务：

- 每个行为性变更文件若未被 `serverRequiredAffectedFeatureKeys` 的证据覆盖（未归属行为变更文件），必须进入至少一个成功工作单，由模型显式核对“是否影响清单外的既有功能”。
- 模型指出清单外受影响功能时，客户端必须把该功能加入 `declaredAffectedFeatureKeys` 并重分析（`declarationSource=client_inference`），或标 `unresolved`；不得静默丢弃。
- 服务端无法验证这一步的执行质量，只能核对“未归属文件均被成功工作单覆盖”。这条边界的实际漏报率必须在 Golden Repository 上测量（§19.2），并作为启用客户端模式的门槛之一。
- 为做这项核对而读取的上下文文件属于可读集：可以读，不能作为证据引用（§10.3）。

服务端不能在没有源码的情况下证明动态调用的完整影响，也不能证明客户端上传的 diff 与真实 Git 仓库逐字节一致。这些保留为客户端声明和机制边界，不得在 UI 或回执中宣称服务端已独立验证运行时行为。

## 9. Delta Merge Contract

这是本设计的核心契约。任何 API 字段都必须服务于以下规则，而不能替代规则。

### 9.1 功能集合

对基线中的功能定义（下列 `…FeatureKeys` 均指功能身份键，身份键与名称键的区别见 §9.2）：

- `baselineFeatureKeys`：当前基线中活跃的功能身份，按 `source` 划分为 `baselineAutoFeatureKeys`（`generated`、`ai_snapshot_import`）与 `baselineManualFeatureKeys`（`manual`）。
- `historicalFeatureKeys`：版本链中出现过、包括已退休的功能身份。
- `declaredAffectedFeatureKeys`：客户端声明可能受影响的基线自动功能。
- `analyzedFeatureKeys`：已完成 AI 重提取或确定性重核对并达到成功终态的基线自动功能。
- `unresolvedFeatureKeys`：无法确认影响或无法完成分析的基线自动功能。
- `retiredFeatureKeys`：本版退休的基线自动功能，等于全部 retire 操作的键集，不单独上传。
- `introducedFeatureKeys`：全新功能，不得与当前或历史身份冲突。
- `reintroducedFeatureKeys`：明确恢复的历史身份，不属于当前基线。
- `carriedForwardFeatureKeys`：由服务端计算，客户端不能指定其生效。

强制关系：

```text
declaredAffectedFeatureKeys ⊆ baselineAutoFeatureKeys
analyzedFeatureKeys ⊆ declaredAffectedFeatureKeys
unresolvedFeatureKeys ⊆ declaredAffectedFeatureKeys
analyzedFeatureKeys ∩ unresolvedFeatureKeys = ∅
declaredAffectedFeatureKeys = analyzedFeatureKeys ∪ unresolvedFeatureKeys
retiredFeatureKeys = keys of all retire operations ⊆ analyzedFeatureKeys
introducedFeatureKeys ∩ (baselineFeatureKeys ∪ historicalFeatureKeys) = ∅
reintroducedFeatureKeys ⊆ historicalFeatureKeys
reintroducedFeatureKeys ∩ baselineFeatureKeys = ∅
serverRequiredAffectedFeatureKeys ⊆ declaredAffectedFeatureKeys
serverGlobalImpactFiles = ∅（否则拒绝 delta）
unresolvedFeatureKeys = ∅（激活必要条件）
```

激活时 `unresolvedFeatureKeys = ∅`，于是 `declaredAffectedFeatureKeys = analyzedFeatureKeys`。两者分开定义，是为了让失败回执能区分“客户端认为受影响”与“客户端已完成分析”。

Feature Operations 与上述集合必须双向闭合：

```text
oldOperationKeys = analyzedFeatureKeys
introducedOperationKeys = introducedFeatureKeys
reintroducedOperationKeys = reintroducedFeatureKeys
retiredFeatureKeys = keys of all retire operations
oldOperationKeys ∩ introducedOperationKeys = ∅
oldOperationKeys ∩ reintroducedOperationKeys = ∅
introducedOperationKeys ∩ reintroducedOperationKeys = ∅
```

每个 stableKey 在 operations 中最多出现一次；每个 analyzed 旧功能恰好有一个成功终态操作；每个 unresolved 功能不得出现成功终态操作；每个 existing operation 必须属于 `baselineAutoFeatureKeys`；每个 introduced operation 不得属于当前或历史身份；每个 reintroduced operation 必须指向明确历史身份；每个 retire 操作必须产生对应退休记录。服务端不得猜测缺失操作是 unchanged、retire 还是 carry。

纯 blob 重命名的确定性重锚也计入 `analyzedFeatureKeys`，操作类型为 `unchanged`，证据原因记 `rename_revalidated`。

`retiredFeatureKeys ⊆ analyzedFeatureKeys` 中的“分析”包括有完整删除证据的确定性退休核对，不强制调用 AI。

**manual 条目不进入上述集合运算。** manual 功能与 manual 场景不能被自动操作：客户端不得为 `baselineManualFeatureKeys` 中的功能、或为任何 `source='manual'` 的场景出具操作，出现即以 `manual_conflict` 拒绝。它们的证据被变更命中时由服务端按既有规则处理——内容逐字保留，工作台行打漂移标记（`markSpecDrift`，即人工核实四态里的“待重新核实”），机器 provenance 记 `pending_review`——并且不阻塞 delta 激活。自动功能里夹杂的 manual 场景同理：功能操作只覆盖该功能的自动场景，manual 场景由服务端原样保留，并按场景身份（而不是 reference）覆盖回合并结果。自动场景的 reference 不得占用同功能内 manual 场景（含已停用的墓碑行）的 reference，冲突时由服务端给自动场景重新编号。

与 manual 有关的四种情况是四件事，实现时不得合并：

| 情况 | 处理 | 是否阻塞激活 |
|---|---|---|
| 服务端发现 manual 条目的证据路径被变更命中 | 内容保留，打漂移标记，机器 provenance 记 `pending_review`，回执披露 | 否 |
| 客户端主动提交针对 manual 条目的 upsert、retire 或改名 | `manual_conflict` 拒绝 | 是，整批拒绝 |
| 取基线之后，自动条目被用户改成 manual | 事务内按工作台现状复核，`manual_conflict` 拒绝 | 是，整批拒绝 |
| 自动条目的更新与 manual 条目发生身份、名称或 reference 冲突 | 拒绝冲突的操作，不覆盖 manual。reference 冲突能靠给自动场景重新编号化解的，由服务端化解 | 身份与名称冲突即拒绝 |

两条边界：不能因为某个 manual 条目命中变更就拒绝整个 delta，也不能因为 manual 命中不阻塞就允许客户端修改它。

### 9.2 Feature Identity 与 Operations

Feature identity、展示名称和生命周期是三个独立维度。

**身份键与名称键的落库约定。** 契约里的 `stableKey`/`scenarioStableKey` 是身份键，落在新身份层（§20）。现网的 `spec_features.stable_key`、`spec_scenarios` 的 `(feature, reference)`、`spec_changes.feature_key/scenario_reference`，以及 §3 列出的一串按名称键连接的消费方，保持名称级语义不变：新版本里它们继续按当版名称与 reference 取值。改名保留身份，靠的是身份层里“两个名称键指向同一身份”的记录，而不是改写既有列的含义。代价是跨版本解析身份时多查一次身份层；收益是既有消费方零回归，历史版本不需要改写。

- **已有功能更新或改名**：`origin=existing`，stableKey 必须属于 `baselineAutoFeatureKeys` 并原样沿用；不得要求身份键等于 `specFeatureKey(newName)`。名称变化不产生 introduced，也不切断历史或回归关联。新名称不得与 manual 墓碑或现存 manual 功能同名。
- **全新功能**：`origin=introduced`，由服务端按现有命名规则验证或分配新 stableKey；若与当前或历史身份冲突，拒绝其伪装成新功能。
- **功能合并**：旧功能以 `retire + replacementStableKey` 指向保留身份；目标可以是 existing、introduced 或 reintroduced，但关系必须显式。
- **功能拆分**：通过 `splitIntoStableKeys` 和各新身份的 `derivedFromStableKeys` 显式关联。旧身份可以保留给其中一部分，也可以 retire；不能只凭名称推断拆分。
- **历史恢复**：`origin=reintroduced`，必须提供 `restoredFromSpecVersionId` 和历史 stableKey，区别于全新引入。
- **功能树**：`parentKey` 随 `upsert` 显式携带（可为空），必须指向本版本中存在的功能身份，不得悬垂或成环；`unchanged` 保持原父节点。现行 `parent_key` 是父功能的名称键，身份层落地后父子引用改为身份键。
- **场景身份**：reference（HP-1 等）是功能内展示引用，不是跨版本身份；场景同样使用独立 stableKey 与生命周期操作，见 §9.3。

每个基线旧功能必须有明确终态，不能依靠“没有出现在 features 数组中”推断删除。`feature` 对象只含功能自身的字段（名称、摘要、父节点），场景内容一律放在 `scenarioOperations`（§9.3）：

```jsonc
{
  "featureOperations": [
    {
      "operation": "upsert",
      "stableKey": "feature-a",
      "origin": "existing",
      "feature": { "name": "Feature A", "summary": "...", "parentKey": null },
      "scenarioOperations": [ /* 见 §9.3 */ ]
    },
    {
      "operation": "unchanged",
      "stableKey": "feature-b",
      "origin": "existing",
      "reason": "reanalyzed_no_change | rename_revalidated"
    },
    {
      "operation": "retire",
      "stableKey": "feature-c",
      "origin": "existing",
      "reason": "implementation_removed | merged_into_other | no_longer_exposed",
      "removedPaths": ["src/feature-c.ts"],
      "replacementStableKey": null
    },
    {
      "operation": "upsert",
      "stableKey": "feature-d",
      "origin": "introduced",
      "feature": { "name": "Feature D", "summary": "...", "parentKey": "feature-a" },
      "scenarioOperations": [ /* 见 §9.3 */ ]
    }
  ]
}
```

规则：

- `upsert`、`unchanged`、`retire` 的旧功能都必须属于 `analyzedFeatureKeys`。
- 服务端校验 operation 的身份来源、集合关系及 identity links；existing 改名仍沿用原 stableKey，只有 introduced 才执行新身份分配或冲突验证。
- `unchanged` 表示已核对，不得用于未读取、失败或跳过。
- `retire` 必须有原因和可审计依据：`implementation_removed` 要求该功能的基线自动场景已全部退休或合并，且 `removedPaths` 是 diff 中真实删除或迁出的路径（服务端核对）；`merged_into_other` 与 `no_longer_exposed` 要求对应的场景级操作闭合。历史版本不变，当前工作台自动条目置为 inactive。
- `replacementStableKey` 可表达合并迁移，但不自动改变 manual tombstone。
- manual 功能或场景不能被自动 upsert、retire 或改名。冲突进入人工复核，人工内容原样保留。
- 后续版本出现同名自动功能时，无历史身份才可 introduced；存在历史身份则必须显式 reintroduced 并给出来源版本。历史退休记录不删除，manual tombstone 仍按现有规则阻止复活。
- **同名输出撞上 carried 身份**：模型把新发现写成某个 carried 功能的名字（现网 BM-4 称身份劫持）时，客户端不得把它当作 introduced 上传，也不得静默丢弃——要么把该功能加入 `declaredAffectedFeatureKeys` 做完整重提取并以 `existing` 出具操作，要么标 `unresolved`。服务端对“introduced 的名称键撞上任何基线或历史身份”一律返回 `identity_conflict`。

### 9.3 Scenario Identity 与 Operations

场景身份独立于 reference 和场景文本。基线必须为每个场景返回 `scenarioStableKey`，该身份在所属 feature identity 下唯一并跨版本稳定；reference 可以因展示排序变化，不能作为跨版本唯一身份。

场景操作枚举为 `upsert | unchanged | retire | reintroduced | unresolved`。`unresolved` 不是成功终态，只用于让失败回执定位到具体场景。每个被重分析功能的 feature operation 都对应一组 `scenarioOperations`（何时可以整体省略见下文）；场景展示内容位于各 scenario operation 内：

```jsonc
{
  "scenarioOperations": [
    {
      "operation": "upsert",
      "scenarioStableKey": "scenario-a1",
      "origin": "existing",
      "reference": "HP-1",
      "scenario": { "context": "...", "action": "...", "outcome": "...", "category": "happy", "step": 1, "evidence": [] }
    },
    {
      "operation": "unchanged",
      "scenarioStableKey": "scenario-a2",
      "origin": "existing",
      "reason": "lines_remapped"
    },
    {
      "operation": "retire",
      "scenarioStableKey": "scenario-a3",
      "origin": "existing",
      "reason": "behavior_removed | merged_into_other",
      "replacementScenarioStableKey": "scenario-a1"
    },
    {
      "operation": "upsert",
      "scenarioStableKey": "scenario-a4",
      "origin": "introduced",
      "reference": "HP-3",
      "scenario": { "context": "...", "action": "...", "outcome": "...", "category": "edge", "step": 2, "evidence": [] }
    }
  ]
}
```

约束：

- 场景操作按下面的闭合等式逐功能核对；manual 场景不出现在操作里，也不进入等式。
- 任一 `unresolvedScenarioKeys` 非空，则所属 feature 必须归入 `unresolvedFeatureKeys`，整个 delta 不得激活。`unresolvedScenarioKeys` 由场景操作中的 `unresolved` 推导，不单独上传。场景 `unresolved` 不连坐同功能的其他场景：它们照常是成功终态，只是所属功能被归入 unresolved。
- existing scenario 必须属于该功能的基线身份；introduced scenario 不得冲突当前或历史身份。历史恢复同样需要显式 `reintroduced` 和来源版本。
- 每个 retire scenario 必须有理由和退休记录；合并时使用 `replacementScenarioStableKey`，历史版本保持不变。
- manual 场景不接受自动操作，继续由 manual 权威规则保护。
- 首期不做复杂语义相似度匹配。客户端提出身份映射，服务端验证身份归属、唯一性、操作闭合和证据；无法确定映射时为 unresolved，必要时 full resync。
- 证据 provenance 精确到 scenario 及其证据锚，功能级状态只是派生聚合。

**场景操作闭合等式。** 对每个被重分析的既有功能 f：

```text
baselineAutoScenarioKeys(f)
  = explicitScenarioOps(f) ∪ autoRetainedScenarioKeys(f)
explicitScenarioOps(f) ∩ autoRetainedScenarioKeys(f) = ∅
touchedScenarioKeys(f) ⊆ explicitScenarioOps(f)
```

`explicitScenarioOps(f)` 是客户端为该功能提交的场景操作，`autoRetainedScenarioKeys(f)` 由服务端计算：基线自动场景里没有提交操作、且旧行锚点全部未被行为性 hunk 触及的那一部分。等式里没有猜测的余地。一个没被提交的场景，要么服务端能证明它的证据行没动（确定性保留，回执里记明），要么就是闭合违例，`scenario_closure_violation`。模型漏抽一个场景，只有在它的证据行确实没动时才会被保留；证据行动过而模型没提，整个 delta 被拒绝。

功能级操作的隐含规则随之确定：

- `unchanged` 且省略 `scenarioOperations`：只在 `autoRetainedScenarioKeys(f) = baselineAutoScenarioKeys(f)` 时成立，即该功能没有任何场景的证据行被触及。它不能与任何场景操作同时出现——“功能没变”和“某场景 upsert”互相矛盾，直接拒绝。省略不免除重分析：该功能仍必须出现在某个成功工作单的 `scopedFeatureKeys` 里（§10.2）。
- `upsert`（含改名、改摘要、改父节点）：没有被触及的场景可以不提交，由服务端确定性保留；被触及的场景必须逐项有明确终态。
- 只要该功能有任何一个场景被触及，功能级 `unchanged` 的省略形式就不可用，必须逐场景提交。

两个例子。`Feature A: unchanged` 加 `Scenario A1: upsert`：拒绝。`Feature A: upsert`、`A1: upsert`、`A2` 省略、`A3: retire`：A2 的证据行没动则保留并记入回执，动过则闭合违例。

新场景与历史墓碑的区分：introduced 的身份由服务端新分配，不等于任何历史身份；reintroduced 必须指向一个已退休的自动场景身份，指向 manual 墓碑的身份一律拒绝。

**锚点级退休门禁。** 这道闸门防止“模型这一趟没输出”被当成行为消失，规则与现网锚点级保真（`preserveUnchangedEvidence`）同源。单趟提取的召回有限，重分析时漏掉一个仍然存在的场景并不少见；如果漏掉即退休，增量会比全量更容易丢真场景。对每个被重分析的既有自动功能，服务端逐个基线自动场景判定其旧行锚点是否被“行为性变更”触及——锚点路径在行为变更集内，且锚点与该文件的变更 hunk 相交，或锚点没有行号：

- 未触及：操作只能是 `unchanged`，或客户端有明确证据表明行为确有变化时的 `upsert`。`retire` 不被接受，唯一例外是功能整体退休。
- 已触及：`upsert`、`unchanged`、`retire` 均可；`retire` 必须给出理由，合并退休必须指向同版本内存在的替代场景。
- 功能整体退休时，其场景一律 `retire`，理由 `feature_retired`，不受锚点门禁约束。

纯 blob 重命名视为未触及：操作为 `unchanged`，原因 `rename_revalidated`，证据路径改指新路径。

**行号重映射由服务端计算。** 场景所在文件有变更 hunk、但旧行锚点不与行为性 hunk 相交时，锚点的新行号由服务端按 hunk 偏移确定性重算（复用 `remapOldLine`）。功能因别的场景被 `direct` 命中、而这个场景的代码行其实没动，是增量里的常见情形；不重映射，这些场景的证据链接在 head 上就会指错行。此时该场景要么由客户端提交 `unchanged`（`evidence` 可以省略，由服务端填入重映射结果；也可以提交，但必须与重映射结果逐项一致，否则以 `evidence_anchor_mismatch` 拒绝），要么不提交操作而由服务端确定性保留。两种情况下行号都由服务端重映射。锚点与纯注释、空白或格式重排的 hunk 相交时也照此重映射，覆盖结果记 `content_changed_nonbehavioral`（§12.5）；这类锚点不算被触及。没有 hunk 相交也没有行号位移的场景，`evidence` 原样保留。

### 9.4 Carry-forward 条件

服务端按以下公式计算，而不是接受客户端提交的 carry 清单：

```text
eligibleCarry(k) =
  k ∈ baselineAutoFeatureKeys
  ∧ k ∉ serverRequiredAffectedFeatureKeys
  ∧ k ∉ declaredAffectedFeatureKeys
  ∧ k ∉ retiredFeatureKeys
  ∧ k 未被 global/unknown 规则阻断
```

manual 条目始终按 manual 权威规则单独合并，不属于 AI 自动 carry 的信任委托。其证据受变更影响时保留内容并标记 `pending_review`，不得自动标为有效。

只有 `eligibleCarry` 才能继承。客户端漏报直接或 closed 扩展命中功能时，服务端通过 `serverRequiredAffectedFeatureKeys ⊆ declaredAffectedFeatureKeys` 失败关闭；全局或未知影响无法形成可信集合时，整个 delta 失败关闭，而不是继续 carry 其余功能。

增量窗口里，carried 功能的证据文件不在本窗口的变更、删除或重命名路径上，这是它能原样继承的原因：文件没变，行号在 head 上依然有效，不需要重锚，也不产生新的核对记录。

carried 锚点的影响检查记录引用窗口级回执（§12.5）。它推进的是“这个窗口被检查过、判定无影响”的记录，不是证据核对记录。

### 9.5 激活条件

只有全部满足才可生成新的当前规格并推进水位：

1. 基线、分支、契约、语言和幂等检查通过。
2. 每个变更文件都有分类；`unknown` 文件为空，`serverGlobalImpactFiles` 为空。
3. 集合关系及 Feature Operations 双向约束全部成立，`unresolvedFeatureKeys` 为空，没有任何针对 manual 条目的操作。
4. 服务端重算的 direct 与 expanded_closed 影响集合没有漏报。
5. 每个 declared 旧功能恰好有一个成功终态操作；每个输出旧功能都在 declared 中；场景操作满足闭合等式（被触及的场景逐项有明确终态）并通过锚点级退休门禁，行号重映射与提交的锚点一致。
6. 每个需要分析的 diff 文件都被至少一个成功工作单显式认领（`assignedDiffPaths`），或具有可接受的确定性跳过理由。
7. 功能/场景退休操作通过身份、manual 和删除依据校验，identity links 完整，父子引用无悬垂。
8. 新证据属于产出它的工作单的可引用集（`workOrderCitablePaths`），路径归属校验通过，行号和来源回执符合契约；stale 证据不得作为成功 upsert 或自动恢复依据。
9. 现有证据保真、身份劫持、变体折叠、可见性冲突和坍缩护栏通过。
10. 服务端计算的 `coverage.complete=true`；该 complete 仅表示 **delta 合并契约完整**，不表示运行时行为完整或 AI 召回正确。
11. 窗口级影响检查回执（§12.5）已生成，每个被保留的自动证据锚都引用它并带覆盖结果。

任一条件失败，整个事务回滚，不生成部分“完整成功”版本。

## 10. Delta 产物与工作单回执

### 10.1 Delta 形状

新增独立产物 `delta.json`，不改变一次性 `snapshot.json` 的语义：

```jsonc
{
  "artifactKind": "codelphi-radar-delta",
  "exportVersion": 1,
  "repositoryId": 3,
  "branch": "main",
  "base": {
    "sha": "abc...",
    "treeSha": "def...",
    "specVersionId": 123
  },
  "head": {
    "sha": "xyz...",
    "treeSha": "uvw...",
    "message": "...",
    "committedAt": "..."
  },
  "contractVersion": "1.0.0",
  "impactRulesVersion": "impact-v1",
  "diffContractVersion": "git-diff-v1",
  "language": "zh-CN",
  "mode": "incremental | no_behavior | no_detected_behavior_change",
  "change": {
    "message": "...",
    "committedAt": "...",
    "url": "...",
    "files": [
      { "path": "src/a.ts", "oldPath": null, "status": "modified", "patch": "..." }
    ]
  },
  "impactClassifications": [],
  "declaredAffectedFeatureKeys": ["feature-a"],
  "analyzedFeatureKeys": ["feature-a"],
  "unresolvedFeatureKeys": [],
  "introducedFeatureKeys": [],
  "reintroducedFeatureKeys": [],
  "featureOperations": [],
  "workOrderReceipts": [],
  "result": {
    "product": { "description": "", "evidence": [] },
    "release": { "title": "...", "summary": "..." },
    "changes": []
  },
  "coverage": {},
  "warnings": []
}
```

`retiredFeatureKeys` 与 `unresolvedScenarioKeys` 不单独上传，由操作推导。`result.features` 不再作为隐式合并指令；实际功能内容位于 `featureOperations`，服务端可将其转换为现有 `AnalysisResult` 合并输入。`result.changes` 沿用现网口径，只能包含 `kind=reviewed` 的审计候选；发布变化一律由服务端从合并后的规格确定性生成（§15）。

### 10.2 工作单回执

每个工作单至少包含：

```jsonc
{
  "workOrderId": "delta-001",
  "baseSha": "abc...",
  "headSha": "xyz...",
  "contractVersion": "1.0.0",
  "modelName": "...",
  "status": "succeeded | failed | unresolved",
  "scopedFeatureKeys": ["feature-a"],
  "assignedDiffPaths": ["src/a.ts"],
  "unassignedBehavioralPaths": [],
  "contextPaths": [],
  "inputFiles": [
    {
      "path": "src/a.ts",
      "contentSha256": "...",
      "lineCount": 200,
      "role": "diff | affected_evidence | context"
    }
  ],
  "allowPaths": ["src/a.ts"],
  "outputFeatureKeys": ["feature-a"],
  "attempts": 1,
  "evidenceDropped": 0,
  "allCandidatesRejected": false,
  "error": null
}
```

回执里的字段各管一件事，不互相代替：`scopedFeatureKeys` 是工作单的责任范围，即分配；`assignedDiffPaths` 是它显式认领的变更路径；`inputFiles` 是声明读取的路径；`allowPaths` 是提取时实际执行的可引用集；`outputFeatureKeys` 是模型实际输出的功能。每个被重分析功能都必须出现在某个成功工作单的 `scopedFeatureKeys` 里，`outputFeatureKeys` 不得超出 `scopedFeatureKeys ∪ introducedFeatureKeys ∪ reintroducedFeatureKeys`。服务端验证不了客户端实际读了什么，但能验证这些声明彼此自洽，校验项见 §10.3。

合并回执给每个被重分析的功能一个核对方式 `disposition`：`reanalyzed` 表示模型重新输出过它；`deterministic_retained` 表示它只是被服务端确定性保留，即功能级 `unchanged` 的省略形式，或场景全部被自动保留。两者都是成功终态，但读侧不得把后者说成“客户端重核对过”。

`scopedFeatureKeys` 同时是把现网增量提取契约接到客户端的落点：工作单的 prompt 沿用 W0-10 三类输出，清单内功能取 `scopedFeatureKeys`，未归属的行为变更文件取 `unassignedBehavioralPaths`，措辞锚点取这些功能在基线中的场景原文；单功能输出条数上限沿用“锚条数 +3”。客户端把模型输出确定性地编译成 §9 的操作，服务端只核对回执之间的集合关系。

服务端可以验证工作单集合、可读集与可引用集、输出身份和终态的一致性；不能将客户端的 `contentSha256`、`attempts` 或 `modelName` 宣称为服务端重新读取后的验证。

工作单只可复用完全相同的 `repositoryId + branch + baseSha + headSha + baseSpecVersionId + contractVersion + impactRulesVersion + diffContractVersion`。基线或任一规则版本变化后不得复用旧 delta 结果。

### 10.3 非可信输入与分析范围安全

- patch、文件记录、URL、commit message、功能描述和发布说明都是非可信输入，执行严格 schema、长度和枚举校验，不进入 HTML 未转义输出或 SQL 拼接。
- 路径必须是规范化仓库相对路径，拒绝 `../`、绝对路径、重复路径、冲突的 rename/delete/add 记录和前后矛盾的 oldPath/newPath。
- patch 必须完整、可解析并符合 §7.1 的大小与数量上限；任一失败拒绝整个 delta。
- API 日志、错误日志、tracing、publication 审计和异常堆栈不得写入原始 patch、源码摘录或 API key；错误回执只返回路径、规则码和安全摘要。
- `contentSha256`、lineCount 和 AI 执行回执始终标记 `clientDeclared`，不能在服务端回执中升级为源码独立验证。
- 可引用集分两层。delta 级是上界：`deltaCitablePaths` = `changed paths ∪ renamed old/new paths ∪ declaredAffectedFeatureKeys 的基线 evidence paths`。这里用 declared 而不是 serverRequired：客户端按 §8.1 声明并重分析的额外功能，其证据文件同样必须可引用。真正决定能否引用的是工作单级。下式中 `baselineEvidencePaths(K)` 表示功能集合 K 在基线中的全部证据路径：

```text
workOrderCitablePaths(w) =
    assignedDiffPaths(w)
  ∪ renamedPathsFor(w)
  ∪ baselineEvidencePaths(scopedFeatureKeys(w))

assignedDiffPaths(w) ⊆ (changedPaths ∪ renamedPaths)
                      − baselineEvidencePaths(baselineAutoFeatureKeys − scopedFeatureKeys(w))

对每个 required diff 路径 p，记 owners(p) = 以 p 为证据的基线自动功能：
  p ∈ assignedDiffPaths(w) ⇒ owners(p) ⊆ scopedFeatureKeys(w)
  ∪ assignedDiffPaths(成功工作单) ⊇ requiredDiffPaths
```

一个路径允许被引用，不等于它可以证明任意功能。变更路径归它的证据所属功能：某个变更文件是工作单范围之外的功能的证据，就不能被本工作单认领。要让两个功能共享一处证据，把两个功能放进同一个工作单，而不是让每个工作单都能引用所有变更文件。每个 required diff 路径因此只有三种归宿：被一个满足归属的工作单认领；被多个功能共享时，由一个把它们全都纳入范围的工作单认领；或者有明确的确定性跳过理由。两个工作单各自认领同一个共享文件、各自只带一个功能，逐个工作单看 `allowPaths` 都合法，但两个都不满足归属约束，覆盖检查也过不了，整体拒绝。所以这类校验必须跨工作单做，逐个工作单校验 `allowPaths` 查不出来。

- 逐项校验：
  - 跨工作单两条约束。其一，各成功工作单 `assignedDiffPaths` 的并集覆盖全部 required diff 路径。其二，对每个被认领的路径，认领它的工作单都包含它的全部所属功能，即 `owners(p) ⊆ scopedFeatureKeys(w)`。
  - `allowPaths` 等于该工作单的 `workOrderCitablePaths(w)`，且 `workOrderCitablePaths(w) ⊆ deltaCitablePaths`。
  - 功能 f 的场景证据，必须落在认领了 f 的工作单的可引用集的并集内。`introduced` 与 `reintroduced` 场景至少有一个证据锚落在产出它的工作单的 `assignedDiffPaths` 上，新行为必须能追溯到本窗口。
  - 功能有被触及的场景时，认领它的工作单声明的 `inputFiles` 必须覆盖这些锚点所在的路径。只被分配、没有被声明读取的功能，不能支撑显式的 `unchanged`。
- 可读集只比可引用集多出上下文：`workOrderReadablePaths(w)` = `workOrderCitablePaths(w) ∪ contextPaths(w) ∪ unassignedBehavioralPaths`。`contextPaths` 是客户端为判断清单外影响而声明要读的文件，角色固定为 `context`，必须落在 `sourceRoots` 内，数量与字节沿用现有提取预算（`analysisSliceBudgets`），不得用来规避 unbounded 拒绝。`inputFiles` 必须是可读集的子集。
- 上下文文件读过不等于可以当证据。引用了 `contextPaths` 里的路径作为证据一律拒绝；未归属的行为变更文件可以交给任何工作单核对，但只有在显式认领了它的工作单里才可引用。服务端能核对的是引用与声明之间的自洽；读没读、读了多少属于 `clientDeclared`。
- 客户端可以只读取可读集的子集，但所有 required diff 必须被成功工作单认领并覆盖，或有确定性跳过依据。

**diff 是传输态数据。** `delta.json` 的补丁与 `snapshot.json` 的代码摘录性质相同：随请求到达，只用于当次确定性校验，事务结束后丢弃；任何表、日志、审计与反馈记录都不得残留。BYO 设计 §8.1 的“服务端代码存量零字节”约束不变。它与一次性导入的差别只在传输量，对外文案须如实写明“增量发布会把 diff 文本传到服务器，但不保存”（§21）。

### 10.4 零代码字节的工程边界

“服务端代码存量零字节”的定义是：源码内容不跨请求生命周期保留。请求处理期间的进程内存是唯一例外；除此之外，任何存储路径都不得留下补丁或摘录字节。

| 路径 | 规则 |
|---|---|
| 数据库 | 不落补丁与摘录，事务结束后丢弃（§14.3） |
| 分块上传的组装态 | 只存在于接收它的那个进程的内存，30 分钟无进展过期，进程重启即丢；不写临时文件，不溢出到磁盘 |
| 应用日志与诊断输出 | 不记录请求体、补丁片段、摘录；错误回执只带路径、规则码与安全摘要（§7.1） |
| 异常追踪与错误采样 | 仓库当前没有接入第三方错误追踪。日后接入时默认剥离请求体与补丁，这是接入的前置条件 |
| 反向代理 | 访问日志不得记录请求体。代理配置不在本仓库内，列为部署检查项 |
| 崩溃转储与调试输出 | 不得开启会带上请求体的转储；需要保留请求的诊断模式只能用于不含源码的请求 |

验收上，“任何表都没有补丁字节”只是其中一条。另加一条金丝雀断言：用带唯一标记串的补丁跑通整条 delta 处理链，断言该标记串不出现在捕获到的日志输出与错误回执里（§19.1）。

## 11. Coverage 与完整性证明

### 11.1 逐文件覆盖

coverage 必须能回答：哪些文件变更、为何跳过、哪些被分析、哪些触发扩展、哪些无法判断。至少包含：

```jsonc
{
  "changedFileCount": 12,
  "classifiedFileCount": 12,
  "analyzedFileCount": 8,
  "noBehaviorFileCount": 2,
  "noDetectedBehaviorFileCount": 2,
  "expandedImpactFileCount": 1,
  "unresolvedFileCount": 0,
  "unassignedBehavioralFileCount": 0,
  "declaredAffectedFeatureKeys": ["A", "B"],
  "analyzedFeatureKeys": ["A", "B"],
  "unresolvedFeatureKeys": [],
  "serverManualReviewFeatureKeys": [],
  "expectedCarriedForwardFeatureKeys": ["C", "D"],
  "retiredFeatureKeys": [],
  "workOrdersTotal": 2,
  "workOrdersSucceeded": 2,
  "evidenceMissingCount": 0,
  "complete": true
}
```

计数必须满足三条不变式：`classifiedFileCount = changedFileCount`；`analyzedFileCount + noBehaviorFileCount + noDetectedBehaviorFileCount + unresolvedFileCount = changedFileCount`；`expandedImpactFileCount` 不是独立分桶，而是 `analyzedFileCount` 当中因 `expanded_closed` 被连带分析的文件数。`unassignedBehavioralFileCount` 是未被 `serverRequiredAffectedFeatureKeys` 证据覆盖的行为性变更文件数（§8.4）。

`expectedCarriedForwardFeatureKeys` 只用于对账；实际 carry 清单由服务端计算并返回。

### 11.2 服务端计算而非照抄

服务端根据文件清单、重算分类、工作单回执、feature operations 和合并结果重新计算计数及 `complete`。客户端上传的汇总数字只作交叉核对，不一致即拒绝。

回执分开呈现：

- `serverVerified`：schema、hash、基线、直接索引、确定性分类、集合关系、manual、事务与版本链检查，以及 diff 内部一致性（`diffInternalConsistency`：清单、分类记录与补丁彼此吻合）。
- `clientDeclared`：Git diff 的真实性（`diffAuthenticity`：与真实仓库一致）、源码内容哈希、AI 执行过程、实际读取了哪些文件、动态影响推断和语义判断。

`coverage.complete=true` 不提升 `clientDeclared` 的信任等级。

**与现网两份“完整性”口径的关系。** `coverage.complete` 是本设计新增的合并契约完整性，它不等于也不替代现网的两样东西：

- 源覆盖率回执（`analysis_coverage_receipts`，规格页的覆盖率口径）。carry 版本的覆盖率就是被沿用版本的覆盖率：delta 沿用现网零行为变更窗口的做法，沿版本链继承最近一份有效回执并随新版本落一份；resync 落客户端回执，标 `clientDeclared`。
- R1 分析完整性账本（`analysis_completeness_ledger`，六维度）。客户端 run 同样要写，且必须如实降级：行为枚举、影子一致性等没有执行的维度记为未执行，其余维度只由服务端可复算的部分推导。不能因为“没有后置 AI”就整份留空，也不能记成满分。

## 12. 证据有效性、影响检查与版本来源

### 12.1 两类状态必须分开

为每个场景及其证据锚保存机器 provenance，功能级状态由场景和锚点聚合。至少包含：

| 字段 | 回答的问题 |
|---|---|
| `evidenceRevision` | 证据实际采集自哪个 commit |
| `lastVerifiedRevision` | 最近一次在哪个 commit 完成证据内容重核对 |
| `anchorRevision` | 证据行号所在的 commit 坐标系。行号被重映射后是 head；文件未变时与 `evidenceRevision` 等价。证据链接一律按当前版本 sha 解读行号，与现网一致 |
| `lastAffectedRevision` | 最近一次在哪个 commit 被判定可能受影响 |
| `evidenceStatus` | 原证据是 `valid`、`pending_review`、`stale` 还是 `unknown` |
| `evidenceReason` | 证据状态的机器原因 |
| `evidenceAuthority` | `client_delta`、`deterministic_rule`、`legacy`、`manual_review` |
| `impactStatus` | 本次变更对该证据的影响判断 |
| `impactCheckAuthority` | `deterministic_rule`、`client_inference`、`unverified`、`no_comparable_base` |
| `lastImpactCheckedRevision` | 最近一次完成影响检查的 commit |
| `lastImpactRulesVersion` | 完成该检查所用的影响规则版本 |

`evidenceStatus` 只描述证据是否经过核对、是否过期；`impactStatus` 只描述本次变更是否可能影响它。影响检查不能升级证据可信度，证据曾经 valid 也不能替代当前影响检查。

`impactStatus` 至少区分：

- `no_behavior`：确定性规则判定窗口不含产品行为语义，证明力以规则覆盖面为限（§13.1）。
- `no_impact_detected`：在当前规则下未检测到影响，但可能保留规则边界。
- `no_detected_behavior_change`：未发现行为变化，证明强度弱于 `no_behavior`。
- `expanded_closed_outside`：功能位于已证明封闭的影响集合之外。
- `possibly_affected`：需要重分析。
- `not_applicable`：没有可比较的窗口（不可比较的 resync），不做窗口级影响判断。
- `global_unbounded`、`unknown`、`pending_review`：不能作为安全 carry 依据。

这里 `verified` 是机器证据重核对术语，不写入人工 `verified_at/verified_by`，也不改变现有四态人工核实生命周期。

与人工核实列的交互由既有规则决定，在此固定：`upsert` 造成内容变化的自动条目，工作台 `verified_at` 按现行 upsert 规则清空；`unchanged` 与 carry 保留；`retire` 只停用工作台行，核实历史表不动。manual 条目被变更命中时打的漂移标记（`stale_since`）属于人工核实维度，与机器 provenance 的 `pending_review` 由同一次变更触发，但仍是两个维度。

### 12.2 状态迁移

| 情况 | evidenceRevision / lastVerifiedRevision | evidenceStatus | impactStatus 与检查记录 |
|---|---|---|---|
| 新证据采集成功 | head / head | `valid / reanalyzed` | `possibly_affected`，随后完成重分析 |
| 受影响但重分析后行为不变，证据在 head 重核对成功 | 原值或重锚后的 head / head | `valid / reanalyzed_no_change` | `possibly_affected`，随后完成重分析 |
| 纯 rename、blob 相同且行内容重锚成功 | head / head | `valid / rename_revalidated` | `no_detected_behavior_change` |
| 被保留的锚点所在文件有变更（含纯重命名），锚点不与任何 hunk 相交 | 原值 / 原值，`anchorRevision` 更新为 head | 保留原状态，不升级，原因 `lines_remapped` | 增量窗口记 `no_impact_detected`，快速路径取窗口结论；引用窗口级回执（§12.5），覆盖结果 `remapped` |
| manual 条目的证据被变更命中（服务端按基线索引计算） | 原值 / 原值 | `pending_review / manual_impact` | `possibly_affected`；记录 head 与当前规则版本；不阻塞激活，工作台同步打漂移标记 |
| 增量窗口中未进入 affected 集合的功能被 carry，锚点路径不在变更集内 | 原值 / 原值 | 保留原状态，不升级 | `no_impact_detected`；引用窗口级回执（§12.5），覆盖结果 `unaffected`，覆盖原因 `outside_affected_set` |
| `expanded_closed` 集合外 carry | 原值 / 原值 | 保留原状态，不升级 | `expanded_closed_outside`；引用窗口级回执，覆盖结果 `unaffected` |
| `no_behavior` 窗口 carry，锚点路径不在变更集内 | 原值 / 原值 | 保留原状态，不升级 | `no_behavior`；引用窗口级回执（§12.5），覆盖结果 `unaffected` |
| `no_detected_behavior_change` 窗口 carry，锚点路径不在变更集内 | 原值 / 原值 | 保留原状态，不升级 | `no_detected_behavior_change`；引用窗口级回执，不得写成强证明 |
| 被保留的锚点与 hunk 相交，且相交的 hunk 全部被 patch-scan 判定为纯注释、空白或格式重排 | 原值 / 原值，`anchorRevision` 更新为 head | 保留原状态，不升级，原因 `non_behavioral_hunk_touched` | 取窗口结论；覆盖结果 `content_changed_nonbehavioral`，不得说成“锚点未变” |
| 被保留的锚点与变更 hunk 相交但不满足上一行，或没有行号而所在文件有变更 | 原值 / 原值 | `stale / evidence_changed` | 取窗口结论；覆盖结果 `stale`。不阻塞水位推进，但该证据不得再当作有效 |
| 可能受影响但分析未完成 | 原值 / 原值 | `pending_review / impact_unresolved` | `possibly_affected`；`lastAffectedRevision=head`，delta 不得激活 |
| 证据文件或相关 hunk 变化但未重核对 | 原值 / 原值 | `stale / evidence_changed` | `possibly_affected`；不得成功 upsert 或通过 carry 自动恢复 |
| 既有历史数据无法确定来源 | null / null | `unknown / legacy_unknown` | 原影响记录未知，不伪造 |

carry-forward 不伪造新的 `lastVerifiedRevision`。例如功能 A 在 V10 的证据来自 `abc`，V11 只修改 B，则 V11 中 A 的 `evidenceStatus=valid` 可以保留，但 `evidenceRevision` 和 `lastVerifiedRevision` 仍是 `abc`；V11 只新增 `lastImpactCheckedRevision=xyz`、当前 `lastImpactRulesVersion` 和相应 `impactStatus` 审计。

`valid` 只表示证据自身仍有既有核对依据，不表示当前影响规则证明了所有动态行为。legacy `unknown` 可以被继承以保持历史连续性，但必须持续披露，不能因多次 carry 或一次弱影响检查自动升级为 `valid`。

### 12.3 影响规则版本变化

`lastImpactCheckedRevision` 必须与 `lastImpactRulesVersion` 一起解释。规则从 `impact-v1` 升到 `impact-v2` 后，v1 的检查记录不会自动代表 v2 结论：

- 历史版本保留原规则版本和原结论，不改写审计。
- 下一次合并必须使用 v2 对当前窗口重新评估；未完成时当前 `impactStatus=unknown` 或 `pending_review`，不得按 v1 结论 carry。
- 只有使用当前 `impactRulesVersion` 完成的 deterministic closed/no-impact 检查才能参与本次激活。

### 12.4 存储与展示

- 按版本存快照，历史不可变，但只存例外。回执每个版本一份，只含变更文件的分类与功能键集合；锚点级 provenance 只落被重分析的锚点，以及覆盖结果不是 `unaffected` 的锚点（`remapped`、`content_changed_nonbehavioral`、`stale`）。其余被保留的自动锚点不落行，按“版本、回执、默认覆盖”解析，默认覆盖是 `unaffected` 加窗口结论。一个版本的锚点级行数因此与变更规模成正比，而不是与规格规模成正比；上万锚点的产品不会每版复制一份全量。
- 规格版本只追加、不折叠，回执与例外行随版本保留。将来若做归档，三者一起归档，引用完整性由外键保证；当前版本的任何锚点引用都能沿外键回到原始回执。
- 精确来源保存在场景证据锚级；功能级聚合顺序为 `stale`、`pending_review`、`unknown`、`valid`，只有全部场景证据为 valid 时功能才显示 valid。工作台保存当前投影。
- MCP、规格页、merge receipt 和发布对账可返回证据实际 revision、最后重核对 revision、影响检查 revision、规则版本及客户端/服务端权威边界，不能把旧证据行号描述成当前 commit 已重新读取。

**读侧解析不变量。** 读侧按下式解析一个锚点的覆盖结果，缺例外记录不等于 `unaffected`：

```text
anchorCoverage(anchor, version) =
  explicitAnchorProvenance(anchor, version)
  ?? resolveDefaultCoverage(version.impactCheckReceipt, anchor)
```

`resolveDefaultCoverage` 只有在下面五条全部成立时才返回默认覆盖，否则返回 `unknown`：

- 该锚点属于这个版本，即它是这个版本里被保留的自动场景的证据；
- 该锚点在这个版本里没有被重分析；
- 该锚点在这个版本里没有例外记录；
- 回执的 `comparability` 允许默认覆盖，即 `comparable`；
- 回执就是这个版本的回执，窗口与 `impactRulesVersion` 都与版本记录一致。

没有回执的历史版本、不可比较的 resync、规则版本对不上的版本，都解析为 `unknown`，不会因为“没有例外行”被读成 `unaffected`。

### 12.5 影响检查回执

§12.1 的影响检查记录回答的是“这次变更是否可能影响这条证据”。它必须有一个明确的检查对象，否则读侧分不清“这条证据在新窗口里被检查过、判定无影响”和“这条证据只是没进 affected 集合而被沿用”。检查对象是**窗口**，不是单个证据锚：每次发布（delta、两种快速路径、resync）恰好生成一份窗口级 `impactCheckReceipt`，随规格版本保存，不可变。

```jsonc
{
  "specVersionId": 124,
  "baseSha": "abc...",
  "headSha": "xyz...",
  "kind": "incremental | no_behavior | no_detected_behavior_change | resync",
  "comparability": "comparable | uncomparable",
  "impactRulesVersion": "impact-v1",
  "diffContractVersion": "git-diff-v1",
  "impactCheckAuthority": "deterministic_rule | no_comparable_base",
  "defaultCoverage": { "outcome": "unaffected", "reason": "outside_affected_set" }, // comparable 时非空；uncomparable 时为 null
  "checkedFiles": [
    { "path": "src/a.ts", "classification": "direct", "reason": "..." }
  ],
  "serverRequiredAffectedFeatureKeys": ["A"],
  "unassignedBehavioralPaths": [],
  "manualReviewFeatureKeys": [],
  "staleAnchors": 0
}
```

回执字段之间有一组固定的蕴含，服务端按它校验回执本身，防止实现把 `defaultCoverage` 做成必填对象、再给不可比较的 resync 填一个默认的 `unaffected`：

```text
comparability = uncomparable
  ⇒ impactCheckAuthority = no_comparable_base
  ⇒ defaultCoverage = null
  ⇒ checkedFiles = []
  ⇒ 没有任何锚点引用这份回执

comparability = comparable
  ⇒ impactCheckAuthority = deterministic_rule
  ⇒ defaultCoverage = { outcome: "unaffected", reason: string }，非空
```

违反任一条的回执拒绝落库。delta 与两种快速路径恒为 `comparable`。

每个被保留的自动证据锚在逻辑上有三个字段：回执引用、覆盖结果、覆盖原因；物理存储只落例外（§12.4）。覆盖结果有四种，按锚点级事实判定，与窗口的行为性结论无关：

| 覆盖结果 | 锚点情况 | 证据行号 | evidenceStatus |
|---|---|---|---|
| `unaffected` | 锚点路径不在本窗口的变更集内 | 不变 | 保留原状态，不升级 |
| `remapped` | 锚点所在文件有变更（含纯重命名），但锚点不与任何 hunk 相交 | 服务端重映射：纯重命名改指新路径，其余重算行号；`anchorRevision` 更新为 head | 保留原状态，不升级 |
| `content_changed_nonbehavioral` | 锚点与 hunk 相交，且相交的 hunk 全部被 patch-scan 判定为纯注释、空白或格式重排 | 服务端重算行号；`anchorRevision` 更新为 head | 保留原状态，不升级；不得说成“锚点未变” |
| `stale` | 锚点与变更 hunk 相交但不满足上一行，或没有行号而所在文件有变更 | 不动 | `stale / evidence_changed` |

五条规则把回执和逐锚记录绑死：

- 窗口结论与锚点事实是两件事。`impactStatus` 取窗口结论，`no_behavior` 与 `no_detected_behavior_change` 是两个不同的取值；覆盖结果回答的是“这条证据的锚点在新版本里成了什么样”。`no_behavior` 只说明窗口的行为性分类，不自动把锚点判成 `unaffected`。
- `content_changed_nonbehavioral` 只承认内容级的非行为判定：相交的 hunk 被 patch-scan 证明只有注释、空白或格式重排，这种判定目前只对实现文件成立。文档、测试、CI 配置属于路径级的非行为分类，证明不了锚点内容没变，它们的锚点被 hunk 触及后一律是 `stale`。迁移脚本（§8.3）归入这一类：它已移出分析目标，所在文件改了也不会触发重分析，被改的行落在锚点上就按 `stale` 记。
- 引用了回执的锚点才推进 `lastImpactCheckedRevision` 和 `lastImpactRulesVersion`。没有被任何回执覆盖的证据锚，不因为版本水位推进而获得新的检查时间。legacy `unknown` 的锚点同样被回执覆盖，推进的是影响检查记录；它的 `evidenceStatus` 保持 `unknown`，不因此升级。
- 覆盖原因说明这条锚点为什么得到这个覆盖结果：`window_no_behavioral_change`、`outside_affected_set`、`non_behavioral_file_changed`、`non_behavioral_hunk_touched`、`evidence_lines_changed`。
- 被重分析的场景不引用窗口回执，它们的影响检查记录就是自身的重分析结果。manual 条目的锚点不进自动回执，命中变更时按 §9.1 处理。

快速路径因此不再有空洞。举个例子：窗口只改了一个 TypeScript 文件里的注释，判为 `no_behavior`，而注释恰好落在一个场景的证据锚行上。行为结论是 `no_behavior`；锚点事实是 `content_changed_nonbehavioral`，行号被重映射，证据状态保留，但不得被描述成“未变化”。同一个窗口里如果改的是 README，且锚点落在被改的行上，锚点事实是 `stale`。`no_detected_behavior_change` 窗口同理，落在变更文件上的锚点按上表分流；不在变更集内的才是 `unaffected`。`stale` 的数量进入回执，产品页据此提示“有证据需要重新核对”。

**可比较与不可比较的 resync。** resync 有两种，回执必须分开：

- `comparable`：旧 base 是 head 的祖先，客户端按 §7.1 提交了完整 diff。服务端照常分类文件、重映射锚点，`impactCheckAuthority` 是 `deterministic_rule`。
- `uncomparable`：force push、分支切换等情形，没有可信的 `base..head` 窗口，也就不带 diff。服务端不能声称用确定性规则检查过旧锚点。回执的 `impactCheckAuthority` 记 `no_comparable_base`，`checkedFiles` 为空，`defaultCoverage` 为空，没有任何锚点引用它。

不可比较的 resync 只承认两种结论：场景被全量结果重新复现，或者退休带有独立、明确的依据；其余一律 unresolved。锚点未变在这里不可用。复现出来的场景，证据来自 head 上的全量重提取，`evidenceAuthority` 记 `client_delta`，`impactStatus` 记 `not_applicable`。全量重建能证明一个场景在新版本里重新出现，不能证明它在两个 commit 之间从未受过影响，这两种证明不得共用一个 `deterministic_rule` 的结论。

## 13. `no_behavior` 与 `no_detected_behavior_change`

### 13.1 三态定义

- `no_behavior`：按 `impact-v1` 的确定性规则，窗口不含产品行为语义——仅文档路径，或 patch-scan 判定为纯注释、空白、格式重排的实现文件。这是规则级结论，证明力以规则覆盖面为限（§8.3 登记的盲区同样适用），不是对运行时行为的证明。
- `no_detected_behavior_change`：当前机制未检测到产品行为变化，但不构成同等强度的依据，例如测试-only、纯 blob rename、部分 CI 配置、已知非行为资产的二进制文件。
- `unknown`：无法判断，不能走快速路径。

`no_detected_behavior_change` 和 `unknown` 不得合并进 `no_behavior`。

### 13.2 水位推进

`no_behavior` 不调用 AI，创建零行为变化同步记录并推进到 head。

`no_detected_behavior_change` 在分类完整、无 unresolved 时也可不调用 AI 并推进水位，但发布和 provenance 必须如实记录其较弱语义；测试-only 变更还要记录验证可信度影响。

`unknown` 不推进水位，返回需要进一步分析或 full resync。

两种快速路径都由服务端从基线加载完整上一版并 carry，不要求客户端重新上传全量 features。它们生成的版本继承基线的源覆盖率回执（§11.2）。输出语言与基线不一致的窗口不能走快速路径（§6.2）。

快速路径同样生成窗口级 `impactCheckReceipt`（§12.5），所有被 carry 的自动锚点都引用它。窗口结论只回答“有没有行为变化”，不代替锚点级事实：不在变更集内的锚点是 `unaffected`；落在变更文件上的锚点按 §12.5 的表分流为 `remapped`、`content_changed_nonbehavioral` 或 `stale`。`stale` 不阻塞水位推进，但不得继续当作有效证据。

## 14. 原子事务与幂等

### 14.1 预处理与事务边界

耗时的 schema 校验、patch 解析、canonicalDelta 规范化与 SHA-256、文件分类、直接影响/closed 扩展候选计算、证据身份匹配、锚点级退休判定、行号重映射和 coverage 候选计算，尽量在持有数据库锁之前完成。它们只形成**待复核的确定性准备结果**，不是最终授权依据。

服务端随后在一个 MySQL 事务中按以下顺序执行：

1. 锁定始终存在的 repository 行，再按固定顺序锁定 watermark；首次建基线也不能依赖“锁定一条尚不存在的 watermark”。
2. 查询完整幂等身份 `kind + repositoryId + branch + baseSpecVersionId + baseSha + headSha + artifactHash`。若已有成功 publication，直接返回第一次成功回执，**不得先检查当前基线**。
3. 若相同 base/head 已存在不同 hash 的成功 publication，返回 `delta_conflict`。
4. 校验当前执行模式、branch、baseSha、baseSpecVersionId 与账户状态门控（§17，不加锁的一致性读）；当水位已记录 baseTreeSha 时必须等值匹配，历史 null 仅允许按 §6.2 的客户端声明语义接续。
5. 若同一 base 已被另一个 head 的成功 publication 消费，返回 `base_changed`；基线为空的首次发布改为复核“该仓库尚无任何规格版本与水位”。
6. 复核所有可能随并发或模式变化的条件，以及准备结果的最终约束：serverRequired、global、operations、场景闭合等式、工作单认领与路径归属、可读集与可引用集、锚点级退休门禁、行号重映射、证据、身份和 coverage。manual 状态按工作台现状复核，不采信取基线时的快照：用户可能在客户端分析期间把某个自动条目改成了 manual，此时针对它的操作以 `manual_conflict` 拒绝。
7. 创建 `trigger_type='client_delta'` 的 run，记录 base 与 head，不创建 SAU 预留。
8. 合并并插入 spec version、spec changes、功能/场景身份与生命周期记录、证据 provenance（含行号重映射结果）和窗口级影响检查回执（§12.5）。
9. 更新工作台自动条目（改名就地更新，保留行 id、用户设置的显示名、父子关系与人工核实列）、manual 漂移标记和退休状态。
10. 创建 release、release files、canonical change projections 和 regression tasks，并切换 `releases.is_current`。
11. 重建文件索引，继承或写入覆盖率回执，写入 delta 审计与新水位。
12. 将 run 和 publication 标记成功，写入可持久化通知/outbox 记录。
13. 提交事务。

因此，网络超时后的相同 delta 重传会在第 2 步命中原成功回执，即使当前水位已经从 A/100 推进到 B/101，也不会误报 `base_changed`。

任一步骤失败全部回滚，包括 run、release、regression tasks 和 publication。外部通知、网络调用和其他外部副作用不得在事务内执行。完整性账本（R1）在提交后按现网做法 best-effort 写入，不影响事务结果（§11.2）。

### 14.2 deltaHash

`deltaHash=SHA-256(canonicalDelta)` 由服务端计算，不接受客户端 hash 作为事实。在统一 publication 中，`artifactHash` 是 delta 的 `deltaHash` 或 resync 的 `snapshotHash`，`kind` 决定其解释。

规范化规则：

- object key 排序；UTF-8 JSON；数字格式统一。
- 集合字段排序并去重，包括各类 feature keys。
- 文件按 `oldPath/path/status` 稳定排序，证据按 path 和行号稳定排序。
- 功能按 featureStableKey、场景按 scenarioStableKey 形成规范身份；reference 和展示名称只是内容字段，有语义的步骤顺序由 `step` 表达，不依赖数组偶然顺序。
- 排除 chunk id、上传时间、客户端随机 request id 等传输字段。
- 包含 diff patch、影响分类、operations 和工作单回执；这些内容变化必须改变 hash。
- 补丁文本原样参与 hash。补丁字节可能随 Git 版本变化，所以客户端必须持久化首次上传的 `delta.json` 并以它重试，而不是重新生成。

### 14.3 幂等身份与冲突

幂等身份：

```text
kind + repositoryId + branch + baseSpecVersionId + baseSha + headSha + artifactHash
```

新增 `analysis_publications` 记录上述坐标、tree SHA、kind、artifactHash、回执和成功时间，并施加：

- 完整幂等身份唯一：重复上传返回第一次成功回执，不重复创建版本。
- `(repository_id, base_spec_version_id)` 唯一：同一基线只允许一个成功后继。
- 同一 base/head 不同 hash：返回 `delta_conflict`。
- 同一 base 不同 head 且基线已被消费：返回 `base_changed`。
- 校验或事务失败不落成功 publication，修正后可以重试。

`base_spec_version_id` 在 `analysis_publications` 与 `analysis_watermarks` 里一律用 `0` 表示“无基线”并保持 NOT NULL。MySQL 的唯一索引允许多个 NULL；用 NULL 表示首次发布，上面两条唯一约束对首发布就完全失效。

`delta_conflict` 与 `base_changed` 的回执必须带已成功 publication 的 `runId`、`specVersionId` 与 head。客户端据此判定“这个窗口已经被消费过”，直接重新取基线，而不是把冲突当成失败去重建工作目录。

原始 patch 和源码摘录不因审计而额外持久化；审计保存 hash、分类、集合、回执和必要元数据。这不是可选的部署模式：BYO 设计 §8.1 的“服务端代码存量零字节”是既有约束，传输层在任何部署下都只保留当次请求所需数据，事务结束后丢弃 patch（§10.3）。

### 14.4 锁竞争与唯一约束冲突

- 使用 MySQL InnoDB 事务，默认在 `REPEATABLE READ` 下以 repository 行作为仓库级串行化锁；固定锁定顺序为 `repository → watermark → publication → 版本写入`。首次基线同样先锁 repository，避免依赖不存在的 watermark 行或间隙锁行为。（2026-11-26 决定：发布事务要显式声明隔离级别，不依赖服务器的默认值。生产的默认值是 `READ COMMITTED`，见 §24.10 第 4 条。声明哪一个级别见 §24.11，实现随客户端增量协议一起做。）
- 锁范围只有 repository、watermark、publication 三类行。账户状态不加锁（§17）。
- 大型 JSON、hash、分类和身份匹配不得长时间占用仓库锁。事务外结果必须绑定 baseSpecVersionId、baseSha 和规则版本，事务内先复核基线再使用。
- 两个客户端即使同时完成事务外计算，也只能由 repository 锁和 `(repository_id, base_spec_version_id)` 唯一约束产生一个成功后继。
- 唯一约束冲突后必须回滚当前事务，再按安全只读查询区分：完整幂等身份已成功则返回原回执；同 base/head 不同 hash 返回 `delta_conflict`；其他同 base 成功记录返回 `base_changed`。不得将 duplicate key 直接暴露为 500 或重复插入。
- publication、run、release 等插入顺序保持固定，避免多表锁顺序不一致造成死锁；死锁或锁超时回滚整批并返回可重试冲突，不推进水位。

## 15. 服务端无 AI 持久化子集

客户端 delta 路径只复用确定性持久化能力，不调用 `runAnalysis`，并明确跳过：

- 主提取和行为枚举。
- release change projection AI rewrite。
- feature flow AI 生成。
- product presentation AI 刷新。
- release note AI 润色。
- incremental shadow 和其他平台影子分析。

发布变化使用 `spec_changes` 的 canonical projection。客户端若提供 presentation/release note 候选，必须通过独立 schema、引用和证据校验并标记 `ai_snapshot_import`；未提供时保留既有内容或标记不可用，不在服务端补跑模型。

| 数据 | 客户端模式合并规则 |
|---|---|
| Product description | 局部 delta 不覆盖整个产品描述；只有描述为空时可由经过证据校验的客户端候选填充，manual 永不自动覆盖 |
| Product presentation | 不触发服务端 AI；可保留原内容，或接收标记为 `client_generated` 且引用完整的候选，manual 优先 |
| Release title | 优先使用确定性的 commit subject/窗口标题；客户端候选标记 `client_generated`，manual 不覆盖 |
| Release summary | 可保存客户端候选，但来源必须为 `client_generated`，不得变成服务端验证事实；manual 不覆盖 |
| Spec changes / change projections | 只使用合并后规格生成的 deterministic canonical projection，不直接信任客户端 changes 文案 |
| Feature flow | 不在服务端自动生成，保留原内容或标记 unavailable |
| Regression tasks | 只根据确定性 spec changes、release files 和文件索引生成 |
| Coverage receipt | delta 沿用版本继承最近一份有效回执；resync 落客户端回执并标 `clientDeclared`（§11.2） |
| Completeness ledger（R1） | 提交后写入；没有执行的维度如实记未执行（§11.2） |
| 人工核实与漂移标记 | 沿用现行规则：`upsert` 造成内容变化即清空 `verified_at`，`unchanged` 与 carry 保留；manual 命中打 `stale_since`（§12.1） |
| Notifications | 确定性通知照常 best-effort 投递，不含模型生成内容 |

客户端产出的自动条目在版本层与工作台都标 `ai_snapshot_import`：它与 `generated` 同属自动条目，读侧又能据此如实披露“由客户端 Radar 产出、未经服务端分析”。版本层两张表的 `source` 列需先加宽（§20），`upsertGeneratedSpec` 需把两种来源同等当作自动条目下线与重写（§3）。

客户端 run 不预留、不捕获 SAU，不产生服务端 LLM receipt。确定性通知仍可按现有机制 best-effort 投递。

## 16. API 与客户端命令

### 16.1 上传接口

新增：

```http
POST /api/products/{slug}/analysis-deltas
Authorization: Bearer <snapshot_write key>
```

大产物复用现有分块上传协议（4MB 分片，`x-import-id`、`x-import-chunk-index`、`x-import-chunk-total` 头），但组装器目前是导入路由的私有函数，要先抽到共享模块再复用。continuous delta 与一次性 import 的 schema、目标解析和事务分开，避免再次引入 `product_has_content` 语义。

组装态是单实例内存，这一点必须写成部署前提，而不是留在实现细节里。现行生产是单容器：`docker-compose.prod.yml` 只有一个 `app` 服务，部署为原地重建，所以前提成立。一旦扩到多实例，或放到没有会话粘性的负载均衡后面，同一个 `x-import-id` 的分片会落到不同进程，组装必然失败。而且这种失败是静默的：新实例收到分片后会新建组装条目，照样返回已接收。

- 启用 client 模式前复核部署拓扑仍是单实例；多实例不在首期范围。
- 组装态只在内存，30 分钟无进展过期，进程重启即丢，不写临时文件。部署或重启时在途的上传整体失败。
- 客户端以末片是否带回发布回执判断组装是否成功。没有回执就从第 0 片整体重新上传，工作目录与已生成的工作单结果不重建。
- 日后若要多实例，优先用按 `x-import-id` 的会话粘性。把分片写进数据库或对象存储等于持久化源码字节，除非按 §10.4 单独定义加密、TTL 与清理规则，否则不做。

限流按端点分桶。一次性导入维持每 Key 每小时 10 次；delta 与 resync 是每次推送一条的常规通道，上限单独核定（初值每 Key 每小时 60 次，可配置）；基线读取单独分桶，额度宽于写入。超限返回 429 与 `Retry-After`，客户端退避重试，不得换 Key 绕过。

成功响应：

```jsonc
{
  "accepted": true,
  "runId": 456,
  "specVersionId": 124,
  "releaseId": 789,
  "mode": "incremental",
  "language": "zh-CN",
  "deltaHash": "...",
  "impactCheck": { "kind": "incremental", "staleAnchors": 0 },
  "serverMerge": {
    "decisions": [
      {
        "stableKey": "A",
        "decision": "upsert",
        "reason": "direct_or_expanded_impact_analyzed",
        "disposition": "reanalyzed",
        "previousEvidenceRevision": "abc...",
        "evidenceRevision": "xyz...",
        "lastVerifiedRevision": "xyz...",
        "lastImpactCheckedRevision": "xyz...",
        "lastImpactRulesVersion": "impact-v1"
      },
      {
        "stableKey": "B",
        "decision": "carry_forward",
        "reason": "no_direct_or_expanded_impact",
        "previousEvidenceRevision": "abc...",
        "evidenceRevision": "abc...",
        "lastVerifiedRevision": "abc...",
        "evidenceStatus": "valid",
        "impactStatus": "no_impact_detected",
        "coverageOutcome": "unaffected",
        "coverageReason": "outside_affected_set",
        "impactCheckAuthority": "deterministic_rule",
        "lastImpactCheckedRevision": "xyz...",
        "lastImpactRulesVersion": "impact-v1"
      }
    ],
    "coverageComplete": true
  },
  "evidenceProvenance": {
    "valid": 10,
    "unknown": 2,
    "pendingReview": 0,
    "stale": 0
  }
}
```

merge receipt 必须为每个基线、introduced、reintroduced 功能提供唯一去向：`upsert`、`unchanged`、`carry_forward`、`retire` 或 `reintroduced`；manual 条目则是 `manual_review`（内容保留、待重新核实）或 `carry_forward`。每条附原因、核对方式 `disposition`（§10.2）、证据 revision、影响检查 revision、覆盖结果与覆盖原因（§12.5）、规则版本和权威来源；场景级决策可按同一结构展开。用户、MCP 和后续 Agent 因此可以解释为什么某功能未重新分析、为什么仍沿用证据，以及是否存在 unresolved，而不只看到聚合计数。

错误至少包括：`analysis_mode_mismatch`、`baseline_not_found`、`repository_unbound`、`repository_mismatch`、`repository_ambiguous`、`base_changed`、`delta_conflict`、`branch_conflict`、`branch_not_tracked`、`target_mismatch`（原因含 `local_ahead`、`local_behind`、`diverged`、`not_at_branch_tip`）、`remote_unavailable`、`dirty_worktree`、`contract_version_mismatch`、`impact_rules_mismatch`、`diff_contract_mismatch`、`full_resync_required`（原因含 `output_language_changed`、`base_not_ancestor`、`global_unbounded`、`unknown_files`）、`impact_unresolved`、`identity_conflict`、`scenario_closure_violation`、`evidence_anchor_mismatch`、`context_not_citable`、`evidence_path_not_owned`、`coverage_incomplete`、`manual_conflict`、`evidence_invalid`、`invalid_artifact`、`delta_too_large`、`git_version_unsupported`、`subscription_required`、`spec_collapse_rejected`、`rate_limited`。错误回执统一带错误码、HTTP 状态、可定位的对象键（路径、功能或场景身份）和安全摘要；`base_changed`、`delta_conflict` 另带已成功 publication 的坐标（§14.3）。本地落后于账本、账本领先于远端这类既不发布也不算失败的状态，不返回错误码，回执如实报告状态和原因。

### 16.2 客户端命令

新增统一入口：

```bash
node snapshot.cjs publish <local-repo> \
  --workdir <work-directory> \
  --slug <product-slug> \
  --language <zh-CN|en>
```

发布用的密钥继续用环境变量 `CODELPHI_IMPORT_URL` 和 `CODELPHI_SNAPSHOT_KEY`，不写进仓库、分析产物或日志。除了环境变量，命令行也读取仓库之外的凭证环境文件（§17.1）；接入步骤里填写的 key 只写进这个文件。`--slug` 指向已启用 client 模式的产品；一次性导入里“按 origin 自动解析产品”的做法不适用于增量，slug 必须显式给出。

`publish` 负责 baseline → prepare delta → complete/resume → finalize delta → upload。现有 `prepare/complete/show/finalize/upload` 全量快照命令保留；delta 工作单和结果放在由 base/head 标识的独立 manifest 中，避免复用错误窗口。

`publish` 分两步落盘，中断后可以续跑：`--prepare` 取基线、固定窗口、算 diff、生成工作单；`--finalize` 合并结果并上传。中间的模型调用由命令行按 §17.1 的方式执行，结果按工作单落盘，重启后不重做已完成的工作单。Radar 现有的另一条通道，也就是宿主 agent 逐个执行 `show` 返回的工作单再写回结果（`skills/codelphi-radar/SKILL.md` 第 3 步），不用于 delta，因为模型调用只用 standalone（§17.1）。`--show` 保留为只读查看工作单。一步到位的 `publish` 是上述步骤的编排。

`--language` 在增量下是约束而不是选择：它必须等于基线 `outputLanguage`，不一致时命令直接退出并提示 full resync（§6.2）。

增量只支持本地克隆，且克隆必须同时含有 base 与 head 的 Git 对象。目标不是本地克隆而是 GitHub URL 时，Radar 做的是浅克隆（`--depth 1`），做不了 `base..head`，`publish` 一律转全量重同步。本地克隆缺 base 对象时，有远端就先 `git fetch` 补齐；补不齐或没有远端时按 §7“本地缺少 base 对应的提交对象”一行处理，不自动转全量重同步。没有远端的本地仓库照常增量。

### 16.3 显式全量重同步

`full_resync_required` 不会触发隐式全量分析。用户必须显式执行：

```bash
node snapshot.cjs publish <local-repo> \
  --workdir <work-directory> \
  --slug <product-slug> \
  --full-resync
```

全量重同步使用独立 `POST /api/products/{slug}/analysis-resyncs` 和完整快照契约，不复用 delta 的“缺失即 carry”语义，也不采用“缺失即删除”。它必须提交与 delta 同等的身份和生命周期对账：

```text
baselineFeatures
  → retained（明确仍存在，含 existing 改名）
  → retired（有充分依据消失或合并）
  → unresolved（无法判断）
  + introduced / reintroduced
```

每个基线自动功能和自动场景都必须恰好有一个 retained、retire 或 unresolved 终态；缺失本身不构成退休依据。§9.3 的闭合等式在这里同样成立：没有提交终态的基线自动场景，由服务端按同一规则确定性保留，或者判为闭合违例。所以“锚点未变”这一档不需要客户端逐条提交，客户端只需提交复现、退休与 unresolved。`unresolved` 非空时返回 `full_resync_incomplete`，不得激活。retained 沿用稳定身份，retire 必须记录理由和 replacement 关系，introduced/reintroduced 遵守 §9 的身份契约。manual 内容不参与自动操作并始终保留，不能被全量结果隐式覆盖或退休。

retained 的依据分两档，其中服务端能复算的那一档与 delta 的锚点门禁同源：

- 重提取复现：模型在全量输出里再次给出该场景，客户端按场景身份映射。
- 锚点未变：基线是 head 祖先时，场景的旧行锚点不与窗口内任何行为性 hunk 相交，可原样保留，行号由服务端重映射。

全量提取的召回不是 100%。把“这一趟没抽到”一律记成 unresolved，resync 在大仓库上几乎不可能激活；把它直接记成退休，则会在弱覆盖时整批丢场景（现网 2026-11-19 已为后一种形态做过一次根治）。锚点未变这一档，就是两者之间的确定性地带。force push、分支切换等无法 diff 的窗口没有这一档，每个基线场景只能靠复现、退休依据或 unresolved 收口。

锚点未变只证明该锚点对应的代码行没有被行为性 hunk 改动，不证明场景语义没被别处的变化影响，比如另一个文件里新增了一道前置权限检查。两条约束把这句话落成规则：

- 复现优先。全量输出里按身份映射到了某个基线场景，就以复现结果为准（内容变了就是更新），锚点未变不能用来压回复现结果。
- 清单外影响核对是锚点未变这一档的前提。窗口内所有未被基线证据覆盖的行为性变更文件，都必须经过 §8.4 的清单外影响核对。核对没有完成，或核对指向了某个功能，该功能的场景不得仅凭锚点未变 retained，归 unresolved。

**可比较与不可比较的 resync。** 两档依据、闭合等式和锚点重映射，都以存在可信窗口为前提。带完整 diff 的 resync 是可比较的（`comparable`），处理方式与 delta 相同。force push、分支切换等无法 diff 的 resync 是不可比较的（`uncomparable`）：

- 只有被全量结果重新复现的场景可以按复现结果更新；
- 退休必须带独立、明确的依据，例如证据路径在 head 已不存在，且该依据是客户端声明；
- 不能使用锚点未变作为 retained 依据；
- 无法确认的场景一律 unresolved，返回 `full_resync_incomplete`；
- 回执记 `no_comparable_base`，不产生任何确定性影响结论（§12.5）。

服务端仍锁定并校验当前基线，要求全量覆盖完整、证据有效、场景操作闭合、manual 保护和坍缩护栏通过，然后以原子事务建立新的全量版本、发布、文件索引、provenance 和水位。首次持续使用客户端模式的产品也通过该路径建立初始基线；一次性浏览导入不强制改变。

**首次基线的两条建立路径。** 路径 A 是本节的显式全量重同步，适用于所有没有可用基线的产品。路径 B 是确定性回填：把既有导入草稿直接固化为初始规格版本，零 AI。只允许在全部条件成立时执行：

- 产品有 `repositories` 行。没有远端的仓库在首次发布的开头完成绑定（见下文“仓库绑定”），所以这一条对它们同样成立；
- `products.seeded_snapshot_sha` 与 `seeded_tree_sha` 非空，`seeded_dirty = 0`，`seeded_contract_version` 与当前提取契约兼容；
- 工作台里的 `ai_snapshot_import` 条目仍是那次导入的原始内容，之后没有再导入过别的快照。

回填在一个事务内创建 `trigger_type='client_resync'` 的 run、初始 spec version、release、文件索引、水位和 publication（`kind=resync`）。其 provenance 的 `evidenceRevision` 取 `seeded_snapshot_sha`、`evidenceAuthority` 取 `client_delta`：来源 commit 已知，不按 legacy `unknown` 处理。不满足条件的草稿只能走路径 A。

**仓库绑定。** 规格版本、发布与水位都挂在 `repositories` 行上，所以没有仓库行的产品用不了增量。

现状（迁移 001、003、013，已核对）：这张表没有远端地址列。仓库身份是 `provider`、`owner`、`name` 三列，都非空，并且 `(provider, owner, name)` 唯一；`provider` 的取值是 GitHub、Gitee、GitLab、Gitea 四家托管平台；另有非空的 `default_branch`（默认 `main`）和可空的 `connection_id`。MCP、产品详情、PR 预演、通知等多处直接读前三列，`lib/evidence-url.ts` 拿 `owner`、`name` 拼 github.com 的地址。现行导入只在 origin 是 github.com 时建行（§3），其余产品没有仓库行。

要让没有远端的仓库、远端在支持范围之外的仓库都能绑定，按下面的默认做，取舍见 §24.2 第 12 条。

**行的形状。** 新增一种 `provider` 取值 `client`，表示仓库身份来自客户端登记，CoDelphi 不接入它的托管平台。没有远端的仓库，以及远端在支持范围之外的仓库，都用它。这种行的 `owner`、`name` 取产品所属组织的 slug 和产品的 slug，两者各自唯一，所以原有的唯一键照常成立；`default_branch` 存跟踪分支。新增可空的 `remote_url`，有远端就登记，只作展示。读前三列的消费方遇到 `client` 行时不再拼托管平台的地址：取代码托管适配器的路径先跳过它；证据链接返回空，界面按现有的回退显示路径和行号。不改这一处的话，哨兵值会被拼成一个看似合法、实际不存在的 github.com 地址。

**首次发布怎么确定仓库行。** 命令行用产品 slug 定位产品，按固定顺序：

1. 本地 git 配置里已经有这个产品的仓库标识，就用它，并核对它属于这个产品。
2. 没有，而产品下恰好有一条仓库行，就复用它，不新建。产品从托管模式切到客户端模式时走这一条，已有的发布历史和水位都留在同一行上。
3. 产品下没有仓库行，就新建。本地仓库的远端是 GitHub 时，按现行导入的做法建 `github` 行（没有连接，`connection_id` 为空）；其余情况建 `client` 行。
4. 产品下有多条仓库行时不猜，返回 `repository_ambiguous`，要求显式指定。

复用之前只做能确定的核对：仓库行登记的是 GitHub 时，本地远端归一化后必须是 `https://github.com/{owner}/{name}`（去掉末尾的 `.git`，主机名不区分大小写）；仓库行登记的是任何一家托管平台时，本地仓库必须有远端。对不上返回 `repository_mismatch`，不新建行。其余平台和 `client` 行核对不了，只给出提示。选错了产品的后果有界：本地仓库里没有基线对应的提交，会走到 §7“本地缺少 base 对应的提交对象”一行，全量重同步要用户确认之后才执行。

建好或选定之后，命令行把服务端分配的仓库标识写回本地 git 配置，按产品区分；这个配置不随仓库提交，之后的发布直接读它。

**建行与事务的先后。** §14.1 第 1 步要求锁定的 repository 行已经存在，所以绑定不能放在 delta 事务里。首次发布的全量重同步在事务开始之前先完成绑定：仓库行不存在就建，再锁定它进入事务。两个客户端同时做首次发布时，由 `(provider, owner, name)` 唯一键保证只建出一行，另一个读到已建好的行继续。

没有远端时平台上没有默认分支可取，跟踪分支由首次发布登记：命令行把当前检出的分支登记为这个产品的跟踪分支，写进 `default_branch`，并在输出里说明；之后只接受这个分支（§7）。


**赠予。** 经全量重同步首次创建产品的赠予与一次性导入同口径：每产品一次，复用 `grt:import-gift:{productId}` 幂等键；已有产品不重复赠。

全量重同步具有独立的 `snapshotHash`、幂等身份、并发基线检查、事务边界、历史审计和失败重试规则。`snapshotHash` 同样由服务端基于规范化完整快照计算；完整幂等命中先于当前基线检查并返回首次成功回执，同 base 只允许一个成功后继。delta 与 resync 共用 `analysis_publications`，以 `kind=delta|resync` 和对应 artifactHash 区分协议；`(repository_id, base_spec_version_id)` 的唯一约束横跨两类发布，防止 delta 与 full resync 各自消费同一基线。

force push、分支切换、global/unknown 无法收敛以及旧草稿缺少版本链时，都只能走这个显式入口。全量重同步失败时，既有当前版本和水位保持不变。

## 17. 执行模式与部署解耦

仓库增加 `analysis_execution=hosted|client`，默认 `hosted`。

`client` 模式下：

- push webhook 不创建服务端分析 run，只返回 `client_analysis_required` 回执。它不推进水位，也不进入 `pending_push_count`。
- daily/push_count sweep 与 queued-run 恢复只处理 `analysis_execution='hosted'` 的仓库。触发模式是托管计费的校准机制，对客户端没有意义。
- 页面“立即分析”和“补分析最新提交”不触发服务端 AI，展示客户端发布指引。产品有代码托管连接时，页面可以复用新鲜度函数按需判断账本是否落后（§17.1）；没有连接时如实显示“无法判断”。
- PR 预演保留。它是确定性索引查询——只用 PR 文件清单里的路径反查索引，不调用模型、不持久化 diff、不推进水位，与“零服务端 AI”不冲突。它依赖代码托管连接，没有连接的仓库自然没有预演；预演结论的新鲜度取决于客户端是否及时发布。
- 服务端部署只执行 migration、应用切换和 smoke，不等待 delta。

### 17.1 客户端如何触发发布

发布由客户端发起，是一次性命令，不做常驻服务。首期的做法：

- **执行方式**：命令行用独立配置的模型 API key 直连模型服务商（standalone）。不使用宿主 agent 的模型或订阅授权，也不调用宿主厂商的无头命令行。命令行由 agent 通过 shell 调用，或由用户手动执行。
- **模型 key 从哪里来**：命令行按顺序查找，用户填写的优先于自动找到的。先看环境变量；再看仓库之外的凭证环境文件，也就是用户填写的 `AI_API_KEY`、`AI_MODEL`、`AI_BASE_URL`；再看各家 agent 工具保存在本机的凭证，不限于某一家。都没有时进入接入步骤：命令行列出常用服务商，用户选一家、粘贴它的 API key，服务地址和模型由服务商目录补齐；目录里没有的，填服务地址后取模型清单来选。接入结果写进凭证环境文件，之后以它为准。agent 调用命令行时不能交互，命令行把接入步骤交给用户自己运行，并以非零退出。只把 API key 形式的凭证直接当模型 key；登录令牌和端点令牌能不能用没有结论（§24.2 第 13 条）。
- **接入步骤借鉴 Cindy 接入模型服务商的做法**：每家服务商在目录里是一条完整记录，包含名称、服务地址、协议和模型清单，鉴权方式是 API key。用户不必知道服务地址和模型 ID。保存之前可以取模型清单、选模型，并发一个最短的请求试连接，事先说明可能产生少量费用。只借鉴 API key 这一种鉴权方式，不做订阅登录；凭证按上面的规则放进凭证环境文件。
- **触发**：agent 在两种时机询问用户是否发布。一是自己把提交推送到默认分支成功之后；二是通过 MCP 读账本时，新鲜度显示默认分支领先于账本。没有远端的仓库，第一种时机改为本地跟踪分支有了新提交之后；第二种时机不存在，因为没有远端就没有新鲜度。
- **自动发布**：用户在对话里说过“以后不用问”之后，agent 把这条许可记在本机的仓库配置里，之后上述两种时机不再询问。记录只在本机，不随仓库提交，也不依赖远端地址。AGENTS.md 只规定何时询问、何时调用，本身不是许可，因为它可能被协作者或 PR 修改。
- **没有专门的确认机制**：需要用户决定的事，由 agent 在对话里说明并等待回答。全量重同步可能消耗较多模型额度，agent 必须先说明原因和代价。
- **CI 延后支持**：首期不在 CI 里运行发布。将来需要时另行设计；届时模型 API key 要存进 CI 的密钥，由用户自行承担这项风险。

现状（`lib/mcp/freshness.ts`，已核对）：比较可用时只返回 `repository`、`analyzedSha`、`comparedAgainst`、`changedBehavioralFiles`、`changedFiles`，其中 `comparedAgainst` 是分支名而不是提交；不可用时只有 `reason`。它不返回远端最新提交，没有检查时间，也没有强制刷新的入口。要得到变更文件数，得经代码托管适配器拉一次 diff。缓存是进程内的，按（仓库，已分析提交）存 5 分钟。


只导入快照、没有连接代码托管平台账号的产品，服务端没有访问权限，私有仓库无法比较。对这类用户，页面和 agent 都要提示“想用自动提醒，请连接账号”；没有连接时，发布由用户主动发起。

平台支持分阶段：GitHub 首期；GitLab、Gitee、Gitea 在适配和验证完成后开放；其他内部 git 服务不承诺。发布本身不依赖平台，因为目标提交由命令行在本地读取（§7）；这个范围只影响新鲜度、账号连接和证据链接。

模式切换使用显式状态机，不允许 hosted 与 client 同时消费同一水位。`hosted_draining` 是独立的过渡状态字段，不是第三个执行模式：

1. 切换请求先锁定 repository，与发布事务共用同一把行锁，二者串行；再检查 queued/running hosted run 及未决 client publication。
2. 有活跃 hosted run 时返回 `analysis_mode_switch_blocked`，或进入 `hosted_draining`：停止新 hosted 入队和新 client 上传，等待既有 run 完成；用户显式终止时也必须在 run 到达可确认终态后才能继续。
3. 从 client 切到 hosted 时，正在本地执行的工作单无法立即取消，但其后续 delta 会因执行模式不匹配被拒绝；服务端不得同时接受 hosted run。
4. 模式切换本身不推进水位，不改变 spec version，并记录操作者、前后模式、时间和关联 run 的审计事件。
5. 最终切换只在没有任何活跃执行者持有该水位时生效，两个模式不能并行消费同一 baseSpecVersionId。
6. 从 hosted 切到 client 时，`analysis_watermarks` 的首行由“最近一次成功 run 的 `after_sha` 与最新 spec version”初始化；此后到达的 webhook 按 client 模式处理。

**并发边界。** 发布、模式切换和账户状态由不同的事务触碰，锁范围必须分开：

- 模式切换与 delta 发布共用 repository 行锁，二者串行，不会同时推进水位。
- 服务端没有 Git 对象，验证不了祖先关系。本地提交与基线的关系由命令行在本地判断（§7）。
- 账户状态在发布事务内做不加锁的一致性读。计费侧的入队、预留、结算、释放都以 account 行为第一把锁，而发布事务的主要耗时在版本写入；持有 account 锁，一次大发布期间该账户的计费操作就要全部排队。这是一项明确的授权时效取舍，不是不存在竞态：账户状态以授权检查时读到的为准；检查之后账户再进入冻结、宽限或过期，不追溯取消已经开始的这次发布，它会成功。如果业务要求冻结立即阻止所有尚未提交的发布，当前设计不满足，需要另行定义，例如给 account 行加锁，或在冻结之后重放检查。读到的账户状态写进回执，供事后审计。

**账户门控。** “不扣 SAU”说的是额度，不是授权，两者不能互相推导。client 发布不预留、不扣减 SAU，但仍受账户状态约束，否则它会成为绕开订阅状态的另一条写入通道。最小策略与现有闸门同口径：

- API key 有效，作用域为 `snapshot_write`。
- 仓库执行模式为 `client`。
- 账户未处于对账冻结，`plan_status` 不是 `grace` 或 `expired`；`trialing` 与 `active` 放行。判定复用 `assertReservationEligibility` 的同一口径（全系统唯一实现），只是不做预留。账户行不存在同样拒绝，不静默放行。

被拒绝时返回 `subscription_required`（宽限、过期）或沿用 `reconciliation_hold`，不创建 run，不推进水位。`trialing` 账户放行，产品负责人已确认（§24.2 第 7 条）。

将来支持 CI 时，`analyze-and-publish` 与 `build-and-deploy` 仍是独立任务。若团队选择让部署等待最新账本，那只是该团队显式增加的流水线依赖，不是服务端部署自身的必要条件。

## 18. 失败处理

| 失败 | 行为 |
|---|---|
| 基线被其他客户端推进 | 整批拒绝，客户端重新获取基线并重新规划 |
| 本地 HEAD 前进 | 当前固定 head 可继续；下一轮处理新窗口 |
| diff 含 global/unknown | 不激活，只能 full resync；扩大声明集不能解除（§8.1） |
| AI 工作单失败或证据缺失 | unresolved，整批不激活 |
| 客户端漏报直接影响 | 服务端集合检查失败，整批回滚 |
| 客户端漏报间接影响但命中 global 规则 | 服务端分类检查失败 |
| 客户端漏报规则外动态影响 | 属于披露边界，不能宣称服务端已证明完整；通过保守规则与 Golden Repository 降低风险 |
| 客户端提交针对 manual 条目的操作，或取基线后自动条目被改成 manual | `manual_conflict`，整批拒绝；人工内容不变。四种 manual 情况见 §9.1 |
| 发布或回归任务失败 | 整个 delta 回滚，重传不会产生重复版本 |
| 通知失败 | 不回滚已提交账本，按 outbox/投递记录重试 |
| 后置 AI 增强不可用 | 客户端模式本就不执行，不影响主版本成功 |
| 基线不存在或产品未绑定仓库 | `baseline_not_found` / `repository_unbound`；先按 §16.3 建立基线 |
| 本地 git 配置里的仓库标识不属于 `--slug` 指向的产品，或所选产品已绑定的仓库与本地仓库对不上 | `repository_mismatch`，拒绝，不新建仓库行，不推进水位 |
| 产品下有多条仓库行 | `repository_ambiguous`，要求显式指定仓库 |
| 输出语言与基线不一致 | `full_resync_required`；显式全量重同步以新语言重建 |
| 本地缺少 base 对应的提交 | 有远端时先 fetch 补齐；补不齐或没有远端时不增量、不自动转全量重同步，提示更新本地；确认该提交已不可达后由用户显式全量重同步（§7） |
| 本地 head 与目标提交不同，或账本领先于远端 | 不发布，不创建新版本；按 §7 的状态给出提示，不自动转全量重同步 |
| 有远端但取不到远端状态 | `remote_unavailable`，不做发布判断 |
| 补丁超限、截断或路径冲突 | 整批拒绝（`delta_too_large` 等），不进入分类和合并；超限窗口转全量重同步 |
| 同窗口重传但内容不同 | `delta_conflict`，回执带已成功 publication 坐标；客户端据此判定窗口已消费 |
| 限流 | 429 加 `Retry-After`，客户端退避重试，已生成的工作单结果不丢 |
| manual 条目被变更命中 | 不阻塞：内容保留、打漂移标记、回执披露（§9.1） |
| 被触及的场景没有明确终态 | `scenario_closure_violation`，整批拒绝 |
| 账户处于宽限、过期或对账冻结 | `subscription_required` / `reconciliation_hold`，不创建 run（§17） |
| 分块上传中途进程重启或部署 | 末片没有带回发布回执，客户端从第 0 片整体重传，不留半成品 |

## 19. 验收实验

### 19.1 契约与集成测试

| 场景 | 必须验证 |
|---|---|
| 修改单个功能 | 只重分析直接受影响功能，其余由服务端 carry |
| 连续多个 commit | 一次处理完整 base..head 窗口 |
| README-only | 零 AI，`no_behavior`，水位推进 |
| 测试-only | `no_detected_behavior_change`，不伪装成强证明，水位按规则推进 |
| 共享工具函数 | 命中 global/扩展规则，不得错误 carry |
| 全局权限配置 | 拒绝普通增量，要求 full resync |
| 删除功能 | 当前版本正确 retire，历史仍可查 |
| 文件纯移动 | 功能身份连续，证据确定性重锚 |
| rename 加内容变化 | 旧、新路径影响均纳入重分析 |
| force push | `full_resync_required`，不推进水位 |
| 分支切换 | 不混入同一版本链 |
| 输出语言切换 | `full_resync_required`，不产出混合语言版本 |
| 浅克隆或缺 base 对象 | fetch 后补齐则正常增量；补不齐则不增量、不自动转全量重同步，提示更新本地；GitHub URL 目标转全量重同步 |
| 分析期间基线被推进 | 旧 delta 返回 `base_changed` |
| 成功响应丢失后同一 delta 重传 | 即使水位已推进，也先命中幂等并返回首次回执，不误报 base_changed |
| 同 base/head 不同 hash | 返回 `delta_conflict`，不创建第二个后继 |
| 同 base 不同 head 并发 | repository 锁与唯一约束保证只有一个成功，其余 `base_changed` |
| 首次发布并发（无基线） | `0` 哨兵加唯一约束保证只有一个首发布成功，另一个按幂等或冲突回执收口 |
| delta 与 full resync 竞争同一 base | 统一 publication 唯一约束保证全库只有一个后继，不允许跨路径双消费 |
| 已有功能改名 | 身份键、历史和回归关联保持连续，不产生 introduced；工作台行 id 不变；名称键消费方（回归任务、漂移标记、功能历史、稳定链接）零回归 |
| 功能合并、拆分、历史恢复 | identity links 和来源版本明确，不靠名称猜测 |
| 父节点改名后引用子功能 | 子功能的父子引用不悬垂 |
| introduced 名称撞上 carried 或历史身份 | `identity_conflict`；客户端转为声明重分析或 unresolved，不静默丢弃 |
| analyzed 功能缺少 operation | 双向集合检查失败，拒绝激活 |
| 同一 stableKey 重复 operation | 拒绝，不允许服务端猜终态 |
| 客户端漏报 expanded_closed 功能 | serverRequired 子集检查失败，不错误 carry |
| global_unbounded | 普通 delta 失败关闭，要求显式 full resync；扩大声明集不能解除 |
| manual 功能或场景被变更命中 | 不阻塞激活；manual 内容逐字保留并进入待重新核实；回执含 manual 去向 |
| 客户端对 manual 条目出具操作 | `manual_conflict` 拒绝 |
| 取基线后用户把自动条目改成 manual | 事务内按工作台现状复核，操作以 `manual_conflict` 拒绝；基线响应的 `source` 反映工作台现状 |
| 只改显示名的自动功能被 upsert | 名称按 delta 更新，用户设置的 `display_name` 保留 |
| 旧行锚点未被触及而客户端提交 retire | 锚点级退休门禁拒绝，不得误退休 |
| 文件有 hunk 但场景锚点不相交 | 服务端重映射行号；与提交锚点不一致即拒绝 |
| 证据覆盖召回边界 | 实现文件变更但不在任何证据锚上时，未归属文件进入工作单并由模型核对清单外影响；漏报率被测量并记录 |
| 弱影响检查 | 不升级 evidenceStatus，不改变 lastVerifiedRevision |
| impact 规则升级 | 旧规则结论不被冒充为新规则检查 |
| stale 证据 | 不得成功 upsert，也不得通过 carry 自动恢复 valid |
| AI 分析不完整 | 不允许完整成功版本，事务全回滚 |
| manual 冲突 | 人工内容逐字保留，不自动退休或覆盖 |
| 客户端故意漏报直接受影响功能 | 服务端拒绝，不静默 carry |
| declared 有而 analyzed 缺失 | unresolved 非空，拒绝激活 |
| analyzed 超出 declared | 集合关系失败，拒绝 |
| 场景缺失、改名或合并 | scenarioStableKey 与操作闭合，reference 不冒充身份 |
| full resync 旧功能缺失 | 无明确 retire 即 unresolved，拒绝误退休或无声遗留 |
| full resync 锚点未变的场景 | 可确定性 retained 并重映射行号；resync 得以激活 |
| full resync 成功重传 | 与 delta 一样先命中幂等并返回首次回执 |
| rename 相似度边界 | 固定 git-diff-v1 参数，不混用 delete+add 与 rename 语义；不同 Git 配置下同一窗口得到同一份清单 |
| patch 截断或路径冲突 | 整批拒绝，不进入分类和合并 |
| 补丁超限 | `delta_too_large`，不进入分类和合并 |
| `.gitattributes -diff` 的文本文件 | 按内容判定非二进制，正常进入分类 |
| textconv 与 quotePath 配置差异 | 补丁字节不随用户配置变化 |
| 清单与补丁顺序对应 | 含空格、中文、引号路径的仓库逐段对应正确 |
| 工作单读取上下文路径 | 可读、不可引用：引用上下文路径作证据即拒绝，读取超出可读集或预算上限即拒绝 |
| 客户端声明额外受影响功能 | 其基线证据文件在它所属工作单的可引用集内，可读可引用 |
| coverage 数字伪造 | 服务端重算不一致，拒绝 |
| 回归任务注入失败 | spec/release/run/publication 全部回滚 |
| 旧草稿确定性回填 | 条件齐全时零 AI 建立初始版本与水位；dirty 或被改动过的草稿拒绝回填 |
| 未绑定仓库的导入产品请求基线 | `repository_unbound` |
| hosted/client 切换有活跃 run | 切换被阻塞或 draining，两个模式不能消费同一水位 |
| 客户端模式 push webhook | 不创建服务端 AI run，不扣 SAU，不推进水位 |
| 本地落后于账本，head 是 base 的祖先 | 空操作，不创建新版本，不要求全量重同步 |
| 本地与账本分叉 | `full_resync_required`，须用户确认 |
| 有远端，本地 head 与远端默认分支最新提交不同 | 不发布，按领先、落后、分叉给出提示 |
| 没有远端的仓库 | 能完成首次发布和后续增量发布 |
| 没有远端的仓库首次发布 | 把当前检出的分支登记为跟踪分支并写回本地配置；之后在其他分支上发布返回 `branch_not_tracked` |
| 没有远端，本地 head 落后于跟踪分支 | 不发布，`target_mismatch`，提示先检出跟踪分支的最新提交 |
| 本地与远端相同，账本领先于远端 | 不发布，不创建新版本，不自动转全量重同步；用户确认后才全量 |
| 多个状态同时成立 | 按固定顺序只落到先命中的一行：本地同时落后于远端和账本时，提示先拉取，不要求全量重同步 |
| 本地缺 base，fetch 后补齐 | 补齐后按祖先关系分类，不转全量重同步 |
| 本地缺 base，fetch 后仍缺 | 不增量、不自动转全量重同步；用户确认不可达后显式全量 |
| 远端不可达 | `remote_unavailable`，不上传，不创建新版本 |
| 平台在克隆之后改了默认分支 | 命令行刷新 `origin/HEAD` 后按新的默认分支判断，不沿用旧记录 |
| 支持范围外的代码托管平台 | 目标提交在本地读取，照常发布；新鲜度如实返回不可用 |
| 分析期间远端历史被改写 | 上传前的复查不通过，不上传 |
| 分析期间远端只是向前推进 | 上传前的复查通过，正常发布 |
| 首次发布的仓库绑定 | 没有 GitHub 远端的仓库，包括完全没有远端的仓库，也能建立绑定 |
| 产品没有仓库行，本地仓库也没有远端 | 首次发布建 `client` 行，`owner`、`name` 取组织和产品的 slug，唯一键成立；跟踪分支写进 `default_branch` |
| 产品已有一条 GitHub 仓库行，本地远端不是同一个仓库，或本地没有远端 | `repository_mismatch`，拒绝，不新建行 |
| 产品下有多条仓库行 | `repository_ambiguous`，不猜 |
| 产品从托管模式切到客户端模式 | 复用原有的仓库行，发布历史和水位不换行 |
| 两个客户端同时首次发布 | 只建出一条仓库行，另一个读到已建好的行继续 |
| `client` 行的证据与新鲜度 | 证据没有链接，界面显示路径和行号，不拼出托管平台的地址；新鲜度返回不可用，不调用适配器 |
| `publish` 的模型调用 | 全部来自 standalone；宿主 agent 执行工作单的通道不参与，`--show` 只读 |
| 客户端模式新鲜度 | 只取远端提交号，不拉 diff；带检查时间，支持强制刷新 |
| 模型 key 的查找顺序 | 环境变量优先于凭证环境文件，凭证环境文件优先于 agent 工具的本地凭证；前两类都没有、第三类只有登录令牌或端点令牌时，不把它当成 API key 使用 |
| 找不到模型 key | 不能交互时给出填写凭证环境文件的指引并以非零退出；不上传，不创建 release |
| 接入步骤 | 用户选服务商、粘贴 API key，服务地址和模型由服务商目录补齐；保存前可以取模型清单并试连接；结果写进凭证环境文件 |
| 凭证环境文件和 agent 工具的凭证里都有 key | 用凭证环境文件里的 |
| 凭证不外泄 | key 不出现在日志、错误回执和 `--dry-run` 产物里；凭证环境文件权限过宽时提示 |
| 客户端模式 sweep | 不为 client 仓库补跑托管分析 |
| 客户端模式 PR 预演 | 零 AI 调用，结论来自最新已发布版本的索引 |
| 客户端模式后置任务 | 主路径及后置路径均无服务端 LLM 调用 |
| 持久化零代码字节 | delta 处理后任何表都没有补丁字节（测试断言） |
| 零代码字节金丝雀 | 带唯一标记串的补丁处理后，标记串不出现在日志输出与错误回执中 |
| 功能级 unchanged 与场景操作同时出现 | 拒绝：两种陈述互相矛盾 |
| 功能有场景被触及却使用 unchanged 省略形式 | `scenario_closure_violation`，拒绝 |
| upsert 功能下未被触及的场景省略 | 服务端确定性保留并记入回执；同一场景若被触及则拒绝 |
| 场景 unresolved 而同功能其他场景成功 | 所属功能归入 unresolved，delta 不激活 |
| reintroduced 指向 manual 墓碑身份 | 拒绝 |
| 快速路径的影响检查回执 | 每个被 carry 的自动锚点都引用窗口级回执，带覆盖结果与原因；未被覆盖的锚点不推进检查 revision |
| 快速路径中测试或文档证据的行号变化 | 不相交则重映射；相交或无行号则记 stale，不阻塞水位 |
| resync 中复现结果与锚点未变冲突 | 以复现结果为准 |
| resync 中清单外影响核对未完成 | 相关场景不得凭锚点未变 retained |
| 多实例下的分块上传 | 启用前复核部署拓扑；多实例不在首期范围 |
| 分块上传中途重启 | 末片无回执即整体重传，重传成功且不留半成品 |
| Git 版本声明低于最低版本 | 拒绝，且不标成已验证 |
| 账户宽限或过期时发布 | `subscription_required`，不创建 run |
| no_behavior 窗口中注释 hunk 触及实现证据锚 | 覆盖结果 `content_changed_nonbehavioral`，行号重映射，证据状态保留；impactStatus 仍是 `no_behavior` |
| no_behavior 窗口中 README hunk 触及文档证据锚 | 覆盖结果 `stale`，不阻塞水位 |
| 快速路径后的证据状态 | 读侧能分清四种覆盖结果，不把注释改动说成“未变化” |
| 不可比较的 resync | 回执记 `no_comparable_base`，没有任何确定性覆盖结果；未复现且无退休依据的场景为 unresolved |
| 可比较与不可比较 resync 的回执 | `comparability` 取值正确，只有前者带 `deterministic_rule` |
| 工作单引用范围之外功能的证据文件 | `evidence_path_not_owned`，拒绝 |
| 两个功能共享一处变更证据 | 放进同一工作单后可引用；分属两个工作单时拒绝 |
| 功能被分配但未被声明读取被触及的锚点 | 不能支撑显式 unchanged，拒绝 |
| 账户状态读取 | 不持有 account 行锁；宽限或过期状态在事务内被读到即拒绝 |
| provenance 存储规模 | 一个版本的锚点级行数随变更规模增长，不随规格规模增长；默认覆盖能解析回原始回执 |
| 不可比较 resync 的回执带着默认覆盖或锚点引用 | 拒绝落库 |
| 没有例外记录的锚点 | 只在回执 comparable 且属于本版本时解析为默认覆盖；没有回执的历史版本与不可比较的 resync 解析为 unknown |
| 账户在授权检查之后进入冻结 | 本次发布仍然成功，这是选定的时效语义；回执里留有检查时读到的账户状态 |
| 共享的变更文件被两个工作单分别认领、各带一个功能 | 跨工作单校验失败，整体拒绝 |

### 19.2 Golden Repository

建立固定仓库与冻结 commit 窗口，覆盖：

- 跨文件共享工具。
- middleware/auth 与权限策略。
- 迁移脚本（已移出分析目标，只改它的窗口走快速路径）。
- ORM 模型与 schema 定义（强制全量重同步）。
- 公共类型和 barrel export。
- 新功能、功能删除、功能合并。
- 文件移动、删除和 rename+modify。
- 测试-only、README-only、格式化。
- 动态注册或无法静态判断的调用。
- manual 编辑与自动 delta 冲突。
- 实现文件变更但不在任何证据锚上（证据覆盖召回边界）。
- 改了内容的重命名，相似度落在阈值附近。
- 路径含空格与非 ASCII 字符；仓库带 `.gitattributes` diff 属性与 textconv 配置。
- 注释、空白、格式化改动恰好落在实现证据锚行上的窗口。
- README 改动恰好落在文档证据锚行上的窗口。
- 可比较与不可比较两种 full resync，后者含 force push。
- 同一个变更文件被两个功能同时引用的窗口。

对每个窗口分别执行全量分析和客户端增量合并，比较：

1. 关键功能 stableKey 集合及 introduced/retired 生命周期。
2. 场景行为语义，不要求文本逐字一致。
3. 证据路径、行锚、evidenceRevision 和机器有效性。
4. carry-forward 是否有影响分析依据。
5. 发布变化和回归任务关键集合。
6. global/unknown 是否保守拒绝，而非静默缩小范围。
7. 未归属行为变更文件经模型核对后，清单外受影响功能的发现情况与漏报率。

任何关键功能丢失、错误退休、直接证据漏报或证据状态伪造都阻断启用客户端模式。

### 19.3 首次基线与连续增量专项验收

必须连续跑通以下真实流程，不能只验证单个接口：

```text
旧产品仅有一次性 snapshot 草稿
  → 显式 full resync
  → 完整 spec version + release + file index
  → 场景/功能稳定身份与证据 provenance
  → analysis watermark
  → GET baseline 并核对所有坐标
  → 第一次 delta 并生成新水位
  → 第二次 delta 验证前一 head 成为新 base
```

同一流程再用确定性回填（§16.3 路径 B）跑一遍：回填建立的版本可以直接作为第一次 delta 的基线，provenance 记录的是已知的来源 commit。

若首次版本缺少文件索引、稳定身份、证据 provenance 或水位，后续增量不得开始。该专项同时验证旧草稿不会被静默当作完整基线。

### 19.4 增量可用率：实施前的 go/no-go 试验

可用率风险应该在写第一行发布链代码之前回答，而不是在身份层、版本链、事务和回执都建好之后。这是进入实施的门槛，不是完成后的验收项：不达标就不开始身份层与增量协议的开发。分类器是纯函数，只需要冻结窗口的 diff、路径规则和一份现成的文件索引，不依赖任何要新建的表或事务。所以把这项测量前置为试验：

1. 取 Golden Repository 与至少两个真实仓库（建议 CoDelphi 自身加一个多语言仓库）的冻结 commit 窗口。
2. 只跑分类器（§8.3 的 `impact-v1` 规则），直接命中用这些仓库现网的 `spec_file_index`，不跑模型，不走发布链。
3. 统计每个窗口的归宿：`direct`、`no_behavior`、`no_detected_behavior_change`、`global_unbounded`、`unknown`。被迫 full resync 的窗口再按触发的具体规则拆开。
4. 每个窗口除归宿外再算下面的指标，一并出报告，按事先定好的阈值判断。

| 指标 | 目的 |
|---|---|
| 可增量窗口比例 | 判断功能是否经常可用 |
| 平均重分析功能占比 | 判断影响识别是否足够精细 |
| 平均分析文件数占比（增量相对全量） | 判断是否真的减少源码读取 |
| 预估 token 节省率（按读取字节估） | 判断成本收益 |
| full resync 触发原因分布 | 判断下一步该优化哪类规则 |
| 快速路径每次产生的 stale 锚点数及其占自动证据锚的比例 | 判断快速路径是否在消耗有效证据 |
| 连续多个快速路径窗口后 stale 是否累积，以及它只能靠什么恢复 | 判断有效证据比例会不会持续下降 |

一个窗口即使被判为 `direct`，如果它触发了八成功能重分析，也没有多少价值，所以重分析占比、文件数占比与 token 节省率三项不能省。stale 指标同样是确定性计算，同一份索引和补丁就能算出，不需要模型。stale 累积快，说明快速路径在消耗有效证据，应当作为产品可用性指标看待；不为了提高可用率而放宽 stale 规则。

**阈值（2026-11-24 产品负责人在跑试验之前确定）。** 两项都达标才算通过：可增量窗口比例不低于 70%；预估 token 节省率（按读取字节估）不低于 50%。其余指标只出报告，不设门槛。任一项不达标就不开始身份层与增量协议的开发，先调整规则或先建 registry，再按同样的阈值重测。

**口径（2026-11-24，与阈值同时写定，跑之前不改）。** 指标怎么算同样影响结论，所以和阈值一起先固定下来：

- 数据集：Golden Repository 的冻结窗口，加四个在生产库里有发布历史、本机有完整克隆的真实仓库：CoDelphi、repomap、dict_2026、Chandler。CoDelphi 是主数据集，Chandler 兼作多语言样本。
- 窗口：同一仓库相邻两次发布之间的提交区间。基线取前一次发布对应的规格版本，文件索引按 `rebuildSpecFileIndex` 的同一规则从该版本重建。后一个提交不是前一个的后代时，这个窗口记为非线性，不计入比例，单独报告。
- 可增量窗口：归宿为 `direct`、`no_behavior`、`no_detected_behavior_change` 的窗口。`global_unbounded` 与 `unknown` 按全量计。
- 重分析功能占比：必须重分析的基线自动功能数，除以基线自动功能总数。未命中索引的新实现文件各按一个新功能计。
- token 节省率：全量按窗口终点上全部实现文件的字节计；增量按本次变更的实现文件，加上必须重分析的功能的证据文件，在窗口终点上的字节计。快速路径不读源码，记 100%；全量窗口记 0%；增量的读取量超过全量时按全量计，记 0%。取所有窗口的算术平均。两头都有的固定开销（提示词、基线规格文本）不计。
- stale：快速路径窗口里，落在非实现文件变更行上的自动证据锚记为 stale。按发布顺序连续模拟，基线的锚点不随快速路径刷新，只有重分析到所属功能或全量重同步才恢复。

**试验结果（2026-11-24，按上面的阈值与口径）。**

结论：**通过**。主数据集 CoDelphi 的可增量窗口比例 73.3%，预估 token 节省率 72.6%。窗口比例只比阈值高 3.3 个百分点，余量不大。

| 主数据集 CoDelphi | 结果 |
|---|---|
| 窗口 | 255 个线性窗口；另有 1 个非线性窗口（第 253 个，`93201dbe → ca255b23`，一次部署了另一条分支的构建），不计入 |
| 窗口归宿 | direct 155、no_behavior 29、no_detected_behavior_change 3、global_unbounded 68、unknown 0 |
| 重分析功能占比（direct 窗口平均） | 8.5% |
| 增量读取量超过全量的窗口 | 0 |
| 按提交计的可增量比例 | 83.7% |
| stale | 32 个快速路径窗口，新增 stale 锚点 0 个，累计占比 0% |

全量重同步的触发原因，一个窗口可以同时命中多条：

| 规则 | 命中的窗口 | 其中单独触发 | 该规则若能封闭，可增量窗口比例变为 |
|---|---|---|---|
| `schema_migration` | 48 | 32 | 85.9% |
| `shared_module` | 17 | 6 | 75.7% |
| `runtime_config` | 13 | 5 | 75.3% |
| `dependency_manifest` | 9 | 3 | 74.5% |
| `assembly_point` | 4 | 2 | 74.1% |

所以下一步最该优化的是迁移规则：数据库迁移是全量重同步的头号来源，其余几条规则单独封闭都只能提高一两个百分点。迁移能不能细分，例如只新增表或列的迁移按影响范围有限处理，需要单独设计，这次试验不做这个决定。（后来的决定见下面的“决定后的重测”：没有细分迁移规则，而是把迁移脚本整体移出了分析目标。）

对照仓库不参与判定：

| 仓库 | 线性窗口 | 可增量窗口比例 | token 节省率 | 重分析功能占比（direct 窗口） |
|---|---|---|---|---|
| repomap（TypeScript） | 23 | 65.2% | 64.2% | 45.0% |
| dict_2026（Go） | 6 | 66.7% | 66.4% | 14.1% |
| Chandler（Go 加 TypeScript） | 5 | 0% | 0% | 无法计量 |

repomap 与 dict_2026 略低于 70%。Chandler 的 5 个窗口全部命中了装配点或运行时配置，样本太小，不能下结论，但说明这套规则在 Go 服务上偏严。

Golden Repository 的冻结窗口取自 CoDelphi 的发布顺序。§19.2 列的情形里，能从分类结果认出来的 16 个中找到 14 个；纯重命名、文档改动落在文档证据锚行上这两种真实历史里没有。靠分类结果认不出来的情形（force push、manual 冲突、相似度落在阈值附近、textconv 配置、功能合并、动态注册）要用专门合成的夹具补。

试验中看到的、没有改的三处规则偏宽：`*.config.*` 把测试工具的配置（如 `vitest.config.mts`）也当成了运行时配置；`.env.example` 这类模板文件被当成了环境变量；全局目录下的测试文件被当成了装配点。量化下来，收紧它们只让主数据集多出 3 个可增量窗口（变为 74.5%），对照仓库一个不变。收紧要动“同时命中多行取最保守一档”的读法，收益又小，所以这次不动，留给后续规则版本。

产物在 `artifacts/incremental-usability-trial/`：账本导出 `ledger-index.jsonl`，本次运行 `run-2026-11-24/` 下的 `report.md`、`report.json`、`windows.jsonl`。分类器、试验脚本和测试在分支 `feat/client-incremental`。
报告要能回答两个问题：日常开发中有多大比例的提交能走 delta 或快速路径；如果把 `global_unbounded` 里的某几条规则换成范围有限、可人工维护的声明式 consumer registry（§8.1），可用率能提高多少，值不值这部分建设成本。结论不理想时调整规则或先建 registry，不放宽失败关闭，也不带着“大多数提交都要全量”的结果进入全面开发。

**决定后的重测（2026-11-25）。** 上面的结果出来后，产品负责人查了现网账本，决定把迁移脚本移出分析目标（§8.3）。规则变了，同一份账本导出、同一批本地克隆重跑一遍，结果另记在这里。上面按事先写定的阈值与口径得到的 73.3% / 72.6% 仍然是进入实施的门槛结论，不被替换。

重跑之前先写下预期：只因为迁移规则而全量的 32 个窗口会变成可增量，即 219/255 = 85.9%；token 节省率会略降，因为全量读取的字节数不含迁移脚本之后分母变小了。

口径有三处随决定改动。它们发生在原始测量之后，不是事先写定的，如实标明：

1. 全量读取的字节不含迁移脚本，与托管分析一致。
2. 增量读取集跳过旧功能仍然引用的迁移证据：读了也不能当证据。
3. stale 模拟里，迁移脚本上的锚点按文档锚点的规矩算（§12.5），不按实现文件记“证据状态保留”。

Golden 情形里的 schema/migration 相应拆成迁移脚本和 ORM 模型与 schema 定义两条。

| 主数据集 CoDelphi | 决定前（11-24） | 决定后（11-25） |
|---|---|---|
| 可增量窗口比例 | 73.3% | **85.9%** |
| 预估 token 节省率 | 72.6% | **84.9%** |
| 窗口归宿 | direct 155、no_behavior 29、no_detected_behavior_change 3、global_unbounded 68 | direct 184、no_behavior 29、no_detected_behavior_change 6、global_unbounded 36 |
| 重分析功能占比（direct 窗口平均） | 8.5% | 14.2% |
| 按提交计的可增量比例 | 83.7% | 92.3% |
| stale | 32 个快速路径窗口，新增 stale 锚点 0 个 | 35 个快速路径窗口，新增 stale 锚点 0 个 |

两项目标仍然达标。token 节省率的走向和事先写的预期相反：不是略降，而是从 72.6% 升到 84.9%。预期只算对了分母变小这一头，漏了另一头——变成可增量的窗口原来记 0，现在按增量记。逐窗口核对的结果：

- 33 个窗口从全量变成可增量，CoDelphi 32 个、Chandler 1 个；其余窗口的归宿不变。
- 其中 30 个是 `direct`，不是快速路径。这些提交同时改了迁移脚本和普通代码，现在只按代码文件重分析受影响的功能。只有 3 个是纯迁移窗口，走快速路径。
- 72 个迁移文件改判为 `schema_artifact`，没有任何非迁移文件的分类变了。
- CoDelphi 两轮都是 `direct` 的 155 个窗口，平均 token 节省率从 98.75% 降到 98.74%，是分母变小的效果。可增量窗口从 187 个变成 219 个。

剩下的全量触发原因：`shared_module` 17 个窗口、`runtime_config` 13 个、`dependency_manifest` 9 个、`assembly_point` 4 个（一个窗口可以命中多条，合计 36 个窗口）。按单独触发明细，`shared_module` 若能封闭可到 91.0%，`runtime_config` 89.4%。

对照仓库：repomap 65.2% / 64.2%、dict_2026 66.7% / 66.4%，都没有变；Chandler 从 0% 变成 20%，5 个窗口里有 1 个同时改了迁移脚本和代码，现在是 `direct`。

Golden Repository 的冻结窗口：§19.2 列的情形里，能从分类结果认出来的 17 个中找到 14 个。纯重命名、ORM 模型与 schema 定义、文档改动落在文档证据锚行上这三种真实历史里没有，要用合成夹具补。

重跑的产物在 `run-2026-11-25-after-migration-decision/`，文件同上。

## 20. 数据迁移与兼容

预计需要：

- 仓库级 `analysis_execution`；独立 `analysis_watermarks` 表保存 repository、branch、当前 SHA/tree SHA、specVersionId 和最近 publication，无基线用 `0` 哨兵（§14.3）。
- `repositories`：新增 `provider` 取值 `client` 和可空的 `remote_url`，其余列不动，唯一键 `(provider, owner, name)` 照常成立（§16.3）。读 `provider`、`owner`、`name` 的消费方要处理 `client` 行，尤其是拼证据地址的地方。仓库标识在首次发布时写回客户端的本地 git 配置。
- 统一 `analysis_publications`，以 `kind=delta|resync` 区分协议并共享基线唯一约束。
- 身份层：`feature_identities`、`scenario_identities` 及 identity links（改名、合并、拆分、退休、恢复）。既有数据按确定性规则回填——功能身份键取首次出现时的名称键，场景身份键取 `(功能身份, reference)`；同一条版本链上名称键连续即身份连续。回填只给版本行补身份列，不改写它们已有的列。
- `spec_features`、`spec_scenarios`、`spec_changes` 与工作台 `features`/`scenarios` 各加身份键列。`spec_features.stable_key`、`spec_changes.feature_key/scenario_reference` 维持名称级语义（§3、§9.2）。比对在拿到两边的身份时按身份配对：名称键不同但身份相同的同一功能出 `changed`，而不是 removed 加 added。
- 父子关系改以身份引用；按名称键记录的墓碑要能拦住改了名的同一个功能，否则功能改名后会失配。
- `spec_features.source`、`spec_scenarios.source` 加宽到 32，容纳 `ai_snapshot_import`。
- 版本级 `impact_check_receipts`（每版一份，含 `comparability` 与默认覆盖）、锚点级 provenance 例外行（§12.4）与功能/场景退休记录。
- run trigger/source 支持 `client_delta`、`client_resync`，保留现有值。

既有 spec 的 provenance 以 `unknown/legacy_unknown` 初始化，不伪造 evidenceRevision 或 lastVerifiedRevision。经确定性回填建立的初始版本除外：它的来源 commit 已知（§16.3）。

实施顺序：先做 §19.4 的可用率试验，回答值不值得做；再把身份层作为第一个工程里程碑上线，先让托管 run 也经身份层落版本，在托管模式下验证名称键消费方零回归；最后叠加增量协议。

**身份层迁移期的兼容规则。** 身份层写入之后、旧消费方切换之前，读侧不能出现新旧身份解释不一致：

- 旧名称键列继续作为既有消费方的兼容投影，由同一次写入派生；身份层是跨版本身份的唯一权威。
- 回填在单个仓库内是一个事务。出现任何身份冲突（同一身份指向两个当版行、父子成环等）就整体回滚，不允许部分启用身份语义。
- 读取时缺身份映射一律失败关闭，不得在读取路径上按名称临时推断。名称到身份的解析只发生在回填规则里。
- 投影与身份层不一致时，以身份层为准判定冲突并拒绝激活，不静默取其一。
- 父子关系保留 `parent_key` 列作为当版名称键投影，新增的父身份键才是权威；同一版本内不得混用两种引用做判定。
- 回退：身份表是增量表，回退等于关掉身份读写开关、托管路径继续按名称键运行，不需要回滚数据。
- 验收：见下文“身份层的实现与验收”。仓库里没有能重放托管 run 的冻结夹具，改用两条做得到的证据。

**身份层的实现与验收（2026-11-25）。** 身份层的代码已经写完，在分支 `feat/client-incremental` 上，没有推送，也没有上线。实现时定下的细则：

- **表结构**（迁移 084，只做加法）：`feature_identities`、`scenario_identities` 两张登记表，`feature_identity_links`、`scenario_identity_links` 两张关系表；`spec_features`、`spec_scenarios`、`spec_changes` 和工作台的 `features`、`scenarios` 在末尾各加可空的身份列。身份列用逐字精确的排序规则（`utf8mb4_bin`）：现有的名称列不区分大小写和重音，身份比较要和应用层的名称键规则一致。SQL 里不把身份列和名称列放在一起比较。
- **登记表只追加**。已有的行不删，也不在上面记“现在在不在链上”。身份是产品级的，版本链是仓库级的，一个产品下有几个仓库时这一列说不清两边的状态。在不在链上看最新版本的身份列，退休和恢复由关系表按版本记录。行上唯一会变的值是“首次出现的版本”，而且只会往更早改。
- **场景身份键**是（功能身份，编号）的确定性编码，写成一个两元的 JSON 数组。不用分隔符拼接，名字里带分隔符也不会撞车。
- **分配身份的规则只有一份实现**（`lib/spec-identity.ts`），发布时的写入路径和回填脚本共用。名称键在上一版出现过就沿用；否则登记表里出现过就恢复；否则新建，功能身份取名称键本身，场景身份取（功能身份，编号）。同一版里两个条目落到同一个身份，或者上一版和登记表说法不一，都直接报错，不猜。
- **发布时身份先算后写**。算不出来就一个字节都不写。身份列接在列清单和参数的末尾，所以既有测试里按下标做的断言不用改。登记表和关系记录在同一个事务里写。工作台行写的是同一份身份；行上已经有身份的保留，空的才补，所以人工条目和快照导入先建的行会在下一次发布时补上。
- **按身份配对是比对的可选输入**。给了两边的身份就先按身份配对，没配上的（有一侧没有身份，或者两边身份不同）再按名称键配对。身份和名称连续一致时，结果和只按名称键配对逐项相同，顺序也相同。托管模式下模型的改名仍然折叠回旧名，所以今天只有发布页的比对重算把身份传进去；真正的改名要等客户端增量协议。
- **人工下线留下的墓碑按身份加宽**。名字能解析到“被下线的身份”的名称键，都进墓碑。检查墓碑的地方没有改，还是按名称键查。合并之后保留“不确定的消失”的那一步也带着墓碑，否则被去掉的条目会以旧名字回来（§24.10）。身份层之前下线的条目没有身份，仍然只按名称键拦。
- **开关** `SPEC_IDENTITY_LAYER`，默认开。设成 `false` 时发布照常进行，身份列留空，不写登记表，比对退回名称键。
- **回填脚本**是 `scripts/backfill-spec-identities.ts`。默认只演练并出报告，加 `--apply` 才写。每个仓库一个事务，遇到冲突整个仓库回滚，别的仓库照常。可以重复运行。它不碰工作台的两张表。

验收用的是 `scripts/verify-spec-identity.ts`。它读生产账本的只读导出，不连数据库，不写任何东西。两条证据：

1. 既有测试一个没改，原样通过。身份列和身份参数都接在末尾，`lib/spec-diff.ts`、`lib/spec-versions.ts`、`lib/product-details.ts` 各自的既有测试一个都没动。
2. 在生产账本的真实数据上离线演练。2026-11-25 导出了四个仓库的全部版本，带功能、场景全文和变化行：

| 仓库 | 版本 | 功能行 | 场景行 | 新建功能身份 | 新建场景身份 | 恢复功能 | 退休功能 | 相邻版本对 | 两种配对结果不同 | 变化行 | 找不到身份的变化行 | 回填冲突 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CoDelphi | 265 | 35,414 | 205,079 | 1,893 | 15,487 | 485 | 1,359 | 264 | 0 | 25,753 | 0 | 无 |
| repomap | 25 | 455 | 5,359 | 29 | 505 | 0 | 3 | 24 | 0 | 688 | 0 | 无 |
| dict_2026 | 7 | 104 | 554 | 16 | 113 | 0 | 0 | 6 | 0 | 57 | 0 | 无 |
| Chandler | 6 | 152 | 826 | 42 | 326 | 0 | 0 | 5 | 0 | 324 | 0 | 无 |

四个仓库的每个版本都算得出身份，回填没有遇到冲突。299 对相邻版本全部两边都带着身份，按名称键和按身份比对的结果逐项相同。26,822 条变化行都找到了身份。这份历史里没有改过名的功能，所以它检验的是“按身份配对不改变现有结果”，检验不到“改名记一条 changed”；那一条靠构造的测试。

**在真实 MySQL 上的演练。** 迁移 084 和所有新写的 SQL 起初没有在真实数据库上执行过。我在这里写过“这台机器上没有 MySQL”，那是没有核实的假设，机器上有，那句话是错的。现在有演练脚本 `scripts/verify-spec-identity-mysql.ts`。它在一个空的临时库里把上线要走的每一步都走一遍，每一步都用生产会用的入口：仓库自己的迁移入口从零建表，灌入上面那份导出，回填先演练再写入，之后库里每一行的身份都和按规则离线算出来的逐行对；再用真正的发布写入路径发版本。它只认 `SPEC_IDENTITY_VERIFY_DATABASE_URL`，库名必须以 `codelphi_test_spec_identity` 开头，每次都删掉重建，结束时删除。

本机 MySQL 9.6.0 上的一次完整通过（2026-11-25）：

| 步骤 | 结果 |
|---|---|
| 迁移 | `scripts/migrate.ts` 执行了 001 到 084 共 86 个迁移文件 |
| 表结构 | 四张新表；身份列都是可空的 `utf8mb4_bin`；唯一约束和外键与设计一致 |
| 回填写入之后逐行核对 | 303 个版本 274,765 行的身份、登记表 18,411 行、关系表 18,007 行，全部和离线算出来的一样 |
| 再写一遍 | 一行未变；登记表里一个被改晚了的“首次出现的版本”改回了最早的 |
| 发布写入 | 用 `insertSpecVersion` 和 `upsertGeneratedSpec` 发两个版本：版本行的身份、登记表、关系表、批量读取都对；工作台行上已有的身份没有被后来写入的覆盖；人工下线的功能没有回到版本里 |
| 发布之后再回填 | 一行未变 |

替身测试仍然有用，但它不是数据库。写读写模块时有一条插入语句四个列只写了三个占位符，是替身加了“占位符个数等于参数个数”的断言之后才拦住的。演练查出了一个替身和离线验收都看不出的缺陷，另外记下几条边界，见 §24.10。

**在生产的副本上又演练了一次（2026-11-26）。** 用 `mysqldump` 对生产库做一致性快照（只读），拷了全部 78 张表的结构和账本相关的 11 张表的数据，到本机的一个临时库。用户、登录令牌、账单这些表的数据没有拷。副本的默认字符集和排序规则照生产的设置。行数和生产逐项一致：10 个仓库、326 个版本、36,709 行功能、213,835 行场景、27,133 行变化。

- 迁移：仓库自己的入口只执行了 084，迁移记录从 85 条到 86 条，共 1.1 秒。四张新表和身份列的排序规则都是迁移里写明的，没有依赖库的默认值。
- 回填：演练报告 10 个仓库都没有冲突。写入后 326 个版本 277,677 行逐行和按规则算出来的一致，登记表 19,172 行、关系表 18,133 行。五张账本表里身份列以外的列校验和不变。再写一遍，一行未变。之前只验证过其中 4 个仓库，另外 6 个也都没有问题。

这次演练跑在本机的 MySQL 9.6.0 上，生产是 8.0.30。生产版本上的证据只有三条，都是只读取的：084 改的五张表满足“加末尾可空列只改元数据”的全部条件；回填里用派生表做批量更新的那条写法，在三张大表上的执行计划都走主键；`sql_mode` 和本机一致，都是严格模式。迁移和回填本身没有在 8.0 上执行过，见 §24.10。

**上线这一部分时的顺序和要注意的事：**

1. 迁移随镜像执行。084 只加表和可空列，旧应用照常运行。在末尾加可空列，从 MySQL 8.0.12 起只改元数据。
2. 新应用上线后，每次发布都写身份。在回填之前发布的版本也有身份，是按名称键新建的，和回填会算出来的一样。
3. 先跑回填演练，确认报告里没有冲突，再加 `--apply`。回填之前的版本身份列是空的，读侧遇到空的身份就退回名称键；回填不改动这些行的任何其他列。
4. 如果确认迁移或 SQL 有问题，把 `SPEC_IDENTITY_LAYER` 设成 `false` 可以让发布回到不写身份的状态，不需要回滚数据。

既有仓库默认 `hosted`，现有 webhook、计费和托管分析不变。一次性 `snapshot.json` 浏览导入保持原契约；持续 `client` 产品的首次全量发布必须建立规格版本和水位，旧草稿通过显式全量发布或确定性回填补齐后才能增量。已有 `ai_snapshot_import` 条目在持续合并时纳入自动条目集合，manual 不变；`upsertGeneratedSpec` 相应改为把 `ai_snapshot_import` 与 `generated` 同等当作自动条目下线与重写。

启用某个仓库的 `client` 模式是独立配置动作，不属于代码部署自动迁移。

## 21. 主要改动面与回归红线

预计改动：

- 客户端：`scripts/snapshot.ts`、`lib/snapshot/workflow.ts`、`lib/snapshot/workspace.ts`、`lib/snapshot/git-backend.ts`、`lib/snapshot/target.ts`、`lib/snapshot/git.ts`（diff 契约命令与输出上限）、delta 类型与导出。
- 共享增量：`lib/incremental.ts`、`lib/spec-file-index.ts`、`lib/remote-analysis.ts`、`lib/patch-scan.ts`（感知文件状态）、`lib/extraction-contract.ts` 与 `lib/ai.ts` 的增量上下文复用、diff 与影响分类纯函数。
- 身份层：`lib/spec-diff.ts`（`diffSpec`、`mergeSpecSources`、墓碑、折叠）、`lib/spec-versions.ts`，以及按名称键连接的消费方 `lib/spec-drift.ts`、`lib/feature-history.ts`、`lib/stable-links.ts`、`lib/regression-tasks.ts`、`lib/release-change-projection.ts`。
- 服务端：baseline/delta/resync 路由、delta schema 与发布编排、`lib/analysis.ts`（无 AI 持久化子集、`upsertGeneratedSpec` 的自动条目口径）、`lib/snapshot-import.ts` 与 `app/api/products/import-snapshot/route.ts`（组装器抽取、确定性回填）。
- 触发：`lib/github-webhook.ts`、`lib/analysis-trigger.ts`、`lib/billing/sweep.ts`、手动分析入口（`analyze`、`reanalyze-latest` 路由）。
- 仓库身份与证据链接：`lib/evidence-url.ts`、`lib/code-hosting/types.ts` 与 `registry.ts`（新增 `client` 行，没有适配器），以及读 `provider`、`owner`、`name` 拼地址的 `lib/product-details.ts`、`lib/spec-ask.ts`、`lib/notifications.ts`。
- 新鲜度：`lib/mcp/freshness.ts`、`lib/mcp/server.ts`（只比提交号、补字段、强制刷新）。
- 客户端凭证与接入：`lib/snapshot/host-ai.ts`（模型 key 的查找顺序、凭证环境文件），新增服务商目录与接入步骤。
- 文档：`skills/codelphi-radar/SKILL.md`、`docs/local-snapshot.md`、`docs/analysis-pipeline.md`、Radar/分析管线和部署说明；对外文案补“增量发布会把 diff 文本传到服务器，但不保存”的披露。
- MySQL migration 与对应测试。

2026-11-24 MCP 反查识别的主要红线（评审当日复核；账本快照 sha-7335917，落后 main 9 个文件）：

- 规格坍缩与跨域放置护栏。
- 规格落库与发布变化投影。
- 规格版本读取与稳定引用。
- 上一版规格锚点加载与读取（`lib/spec-versions.ts`）：基线响应与客户端措辞锚定直接复用。
- 行为账本差异判定（`lib/spec-diff.ts`）：身份层改造的主要战场。
- 规格漂移标记、规格核实与漂移标记（`lib/spec-drift.ts`）。
- 分析执行与规格落库。
- BYO 快照导入、理解层落库（`lib/snapshot-import.ts`）。
- 产品快照工作区 finalize 与工作单复用语义。
- 本地 Git target 的 revision 校验和失败清理。
- GitHub push 两阶段入队与幂等。
- 分析触发模式与兜底调度、分析任务恢复与触发调度（`lib/analysis-trigger.ts`）。
- AI 规格分析与回归任务。
- patch 行为性判定、行为性变更判定（`lib/patch-scan.ts`）。
- PR 行为预演评论与检查（`lib/pr-preview.ts`）。
- 产品呈现旅程挖掘：客户端模式不得隐式触发服务端 AI。

同日晚按产品形态讨论的修订（§24.7）新增了改动面，当日重新反查。账本快照 `9bfd6c0`，与远端默认分支一致：

| 文件 | 以它为证据的功能 | 要守住的行为 |
|---|---|---|
| `lib/mcp/freshness.ts` | 8 个：账本新鲜度、账本新鲜度查询、账本新鲜度与 stale 标注、账本新鲜度与搜索投影、账本新鲜度与等待发布、账本新鲜度与零变化核验、MCP 只读工具面与 API key 鉴权、MCP 只读工具面与 OAuth 连接 | 原始场景 28 条，归并后 8 条。比较失败返回不可用，不把“查不到”说成“新鲜”；按场景标注 stale 的投影 |
| `lib/mcp/server.ts` | 18 个，主要是 MCP 工具面与调用、发布变化查询与证据检索、未决生命周期披露、发布对账与零变化核验 | 原始场景 76 条，归并后 27 条，另有 `tests/mcp-impact-golden.test.ts` 以它为证据。只改新鲜度块的装配，不改动已有参数的含义 |
| `lib/evidence-url.ts` | 2 个：证据链接与证据强度分级、功能行为变迁史与实现文件聚合 | 原始场景 6 条，归并后 2 条。拿不到地址时返回空，界面按现有回退显示路径 |
| `lib/snapshot/host-ai.ts` | 2 个：codelphi radar skill 分发与安装页、codelphi radar 本地快照 skill 与安装页 | 原始场景 3 条，归并后 2 条。standalone 通道的现有行为不变 |

实施前需基于当时账本快照重新执行逐文件反查，不能以本节替代最新爆炸半径检查。

**迁移脚本移出分析目标的改动面（2026-11-25，已实施）。** 当日按账本快照 `9bfd6c0` 做了逐文件反查。A1、A2 两个提交已落在 `feat/client-incremental`，未推送：

| 文件 | 以它为证据的场景 | 改了什么 | 要守住的行为 |
|---|---|---|---|
| `lib/evidence.ts` | 8 | 新增迁移脚本判定、实现面判定和两个取改动清单的函数 | 证据分级不变：迁移脚本仍是 implementation 档，否则只引用它的场景会被误打“测试佐证” |
| `lib/slice-planner/index.ts`、`selection-policy.ts` | 32、14 | 噪声种类加 `schema`；强制装入循环跳过迁移脚本 | CI 与测试文件仍被强制装入；子树份额上限不变 |
| `lib/patch-scan.ts` | 8 | `behavioralChangePaths` 排除迁移脚本 | 注释、格式重排、未知语言、脚本文件的判定不变 |
| `lib/ai.ts`、`lib/extraction-pass.ts`、`lib/extraction-contract.ts`、`lib/behavioral-enumeration.ts` | 1、11 | 提示词的“文件变化”和三处证据允许集不含迁移脚本 | 范围外的证据仍被丢弃；消息结构不变 |
| `lib/analysis.ts` | 分析执行与规格落库 | 窗口 diff、受影响功能反查、必选路径、合成零回执都只算分析目标内的文件 | 增量模式回退全量的条件不变，diff 文件数仍按全部改动文件计 |
| `lib/analysis-coverage.ts`、`lib/full-analysis.ts`、`lib/snapshot/effective-coverage.ts`、`lib/behavior-inventory/index.ts` | 17 | 实现面口径用同一个判定 | 覆盖率仍能如实报告遗漏；库存编排的范围指纹随之变化 |
| `lib/pr-preview.ts` | 10 | 反查索引时跳过迁移路径 | PR 触碰的文件数照实报告 |
| `lib/impact-classification.ts`、`lib/incremental-trial.ts`、`lib/incremental-trial-metrics.ts` | 本次新增的文件 | 迁移脚本改判 `schema_artifact`；试验口径随之调整 | 规则版本仍是 `impact-v1`，它还没有发布过 |

有意不改的：`lib/spec-file-index.ts`（索引本身不变，否则 MCP 的零变化核验会把旧证据判成不可读）、`lib/spec-editor-service.ts`（人工编辑保护）、`lib/spec-drift.ts`、`lib/stable-links.ts`、`lib/feature-history.ts`、`lib/regression-tasks.ts`。

**身份层的回归红线（2026-11-25 反查；身份层已按这些红线实施，在分支上，没有推送）。**

| 文件 | 以它为证据的场景 | 必须守住 |
|---|---|---|
| `lib/spec-diff.ts` | 165 | 劫持门禁、墓碑抑制、锚点级保真、折叠、坍缩检测的现有测试不改且通过 |
| `lib/spec-versions.ts` | 95 | 插入参数的现有按下标断言不改；变更记录的 JSON 不含身份字段 |
| `lib/spec-editor-service.ts` | 41 | 不改 |
| `lib/spec-drift.ts`、`lib/stable-links.ts`、`lib/feature-history.ts`、`lib/regression-tasks.ts` | 44 | 不改。稳定链接、历史、回归任务逐项一致 |

实施后的状态：`lib/spec-diff.ts` 既有的 68 个测试、`lib/spec-versions.ts` 既有的 61 个测试一个没改，原样通过。后两个文件没有动。身份键不放进规格对象，变化记录的 JSON 里没有身份字段。`lib/spec-diff.ts` 里加的是可选的按身份配对和两份对照函数，不给身份时走原来的代码。`lib/spec-editor-service.ts` 没有动。新增的文件是 `lib/spec-identity.ts`（分配身份的规则）、`lib/spec-identity-store.ts`（登记表的读写）、`scripts/backfill-spec-identities.ts`（回填）、`scripts/verify-spec-identity.ts`（离线验收）；`scripts/replay-spec-diff.ts` 加了对照模式。

真实 MySQL 演练之后另有一处改动：`lib/spec-diff.ts` 的 `preserveUncertainDisappearances` 多一个可选的墓碑参数，不给时行为和原来一样（§24.10）；`tests/spec-versions.test.ts` 末尾追加四条测试，原有的一条没改。新增的文件还有 `scripts/verify-spec-identity-mysql.ts`（真实 MySQL 演练）、`tests/spec-diff-tombstones.test.ts`、`tests/verify-spec-identity-mysql.test.ts`。之后还改了一处既有迁移：`migrations/049_personal_workspace_slug_randomize.sql` 用 `SHA2()` 代替 `MD5()`，`tests/migrations.test.ts` 多一条守卫（§24.11）。它是账本里「多租户工作区与成员邀请」一条场景的证据，行为没有变。

部署身份层时的顺序和要注意的事见 §20 的末尾。

部署这一部分时要提前知道两点：带迁移的提交在发布页仍列出迁移文件，只是不再标为行为变更；生产上如果有在途的 inventory 模式任务，上线后会因范围指纹变化而无法续跑，要并入现有的部署在途判据。

## 22. 验收门槛

### 22.1 进入实施的前置条件

2026-11-24 产品负责人决定修订部分不再送外部评审，按本文档开工。开始实质开发之前，三项必须全部满足；缺任何一项都不开始身份层和增量发布链的开发。三项的状态：

1. §19.4 的可用率试验已有结论并达到阈值。已满足：2026-11-24 试验通过，主数据集可增量窗口比例 73.3%，预估 token 节省率 72.6%。2026-11-25 把迁移脚本移出分析目标后重测为 85.9% 和 84.9%（§19.4），门槛结论不变。
2. §24.2 的产品取舍已经拍板。已满足：`trialing` 账户放行已由产品负责人确认，其余各项按正文写的默认执行。
3. 讨论稿《客户端形态与发布触发方式讨论整理》里的待拍板事项已有结论并并入本规格。已满足：产品负责人决定不再等令牌能否当模型凭证的结论，正文按只认 API key 执行。

身份层是独立的高风险迁移，不和增量协议同时首次上线（§20）。

### 22.2 完成门槛

实施后只有同时满足才可声明完成：

1. Delta Merge Contract 的全部集合、影响、退休、证据与原子性测试通过。
2. Golden Repository 全量与增量关键语义对比通过。
3. 服务端客户端模式主路径和后置路径均无 AI 调用、无 SAU 扣减。
4. 真实连续两个以上 commit 窗口完成 baseline → delta → release → 下一次 baseline 的端到端验证。
5. 重复、乱序、force push、manual 冲突和回归任务失败场景均验证不破坏既有当前版本。
6. 部署任务不依赖分析任务，且产品读侧能区分 serverVerified 与 clientDeclared。
7. `npm run typecheck`、`npm test`、`npm run build` 全部通过。
8. 生产部署、仓库模式切换和 webhook 变更仍需用户另行明确指令。
9. 身份层作为独立里程碑先于增量协议上线，托管模式下名称键消费方在迁移前后逐项一致。
10. 三个 P0 的 Golden 用例通过：快速路径的锚点覆盖结果、resync 的可比较性、工作单的路径归属（§19.2）。
11. §7 状态矩阵与上传前复查的 Golden 用例通过（§19.1）。

各条的状态（2026-11-26）：第 7 条在每个提交前都跑过，全绿。第 9 条的代码已经写完并在生产账本的真实数据上离线验收通过（§20 的末尾），迁移和全部新 SQL 也在本机 MySQL 9.6.0 的空库演练和生产数据的副本上执行并通过（§20 的末尾）；但没有推送，也没有上线，生产是 MySQL 8.0.30，还没有在 8.0 上执行过。上线推迟到行为咨询试点那条线提交并合并之后（§24.11 第 5 条）。第 8 条照旧等用户发话。其余各条属于客户端增量协议，还没有开始。

## 23. 已作决策

- 首期直接实现本地增量，不采用“先每次全量上传、以后再优化”的过渡方案。
- 不建设完整依赖图；只有 `expanded_closed` 允许扩大增量，`global_unbounded/unknown` 保守拒绝或 full resync。
- 完整幂等查询先于当前基线检查，网络重试始终优先返回第一次成功回执。
- feature/scenario identity 与展示名称/reference 分离，existing 改名不改变身份，operations 与分析集合双向闭合。
- serverRequired 同时包含 direct 与 expanded_closed 影响，客户端不能只通过 direct 校验。
- evidenceStatus 与 impactStatus 分离，弱影响检查不升级证据，规则版本变化不继承旧检查结论。
- full resync 只能经显式命令和独立端点执行，具有完整生命周期对账、独立 artifactHash 与原子事务；delta/resync 共用 publication 基线唯一约束，首次持续发布必须建立版本与水位。
- Git diff contract 独立版本化，patch 截断、路径冲突或未知内容失败关闭；二进制按内容判定，只有归属未知的二进制才按 `unknown` 处理（§8.3，待确认见 §24.2 第 4 条）。
- 可引用集由服务端根据变更和基线计算，并下沉到工作单级；上下文只读不可引用，且不得用来扩大分析范围（第二轮评审把原来的 `serverAllowedPaths` 拆成可读集与可引用集，第三轮把可引用集细化到工作单，§10.3）。
- 服务端验证确定性事实，客户端声明与 AI 语义判断分开披露。
- carry-forward 清单只由服务端计算；客户端只能声明 affected/analyzed/unresolved 和 operations。
- 功能与场景删除使用 retire，不物理删除历史。
- 单仓库首期只有一条指定分支的规格版本链，hosted/client 模式切换不得并发消费水位。
- 原子事务包含回归任务和水位，外部通知不在事务内；repository 行是首次及后续发布的统一串行化锁。
- 客户端模式关闭所有服务端后置 AI，而不仅是主分析。
- legacy 证据从 `unknown` 开始，不因持续 carry 自动变为 `valid`。
- 锚点级退休门禁：旧行锚点未被行为性 hunk 触及的基线场景不得退休；行号重映射由服务端计算。
- manual 条目不进入集合运算：命中后保留内容、打漂移标记、不阻塞激活。
- 身份键落新身份层，名称键列与其消费方语义不变。
- 客户端 delta 复用 W0-10 增量输出契约与证据允许集口径。
- 输出语言与基线不一致一律 full resync。
- Git diff 清单与补丁分两次调用生成；二进制按内容判定。
- PR 预演在 client 模式保留：确定性、零 AI。
- 首次发布用 `0` 哨兵表示无基线，唯一约束覆盖首发布。
- 每次发布生成一份窗口级影响检查回执；被保留的证据锚引用它，未被覆盖的锚点不推进检查 revision。
- 场景闭合等式：证据行被触及的场景必须有明确终态，未被触及的可由服务端确定性保留。
- full resync 中复现优先，锚点未变以清单外影响核对为前提。
- client 发布不扣 SAU，但受账户状态约束。
- 可用率试验前置为实施前的 go/no-go。
- 窗口的行为结论与锚点事实分开：`no_behavior` 不自动把锚点判成 `unaffected`，新增 `content_changed_nonbehavioral`。
- resync 分可比较与不可比较；不可比较时不产生确定性影响结论。
- 可引用集下沉到工作单级，变更路径归它的证据所属功能；共享路径的所有所属功能必须在同一个工作单里。
- 账户状态以授权检查时读到的为准，之后的变更不追溯。
- 发布由客户端发起：agent 在推送后和读账本发现落后时询问用户；自动发布的许可只记在本机；没有专门的确认机制。
- 模型调用只用 standalone，命令行用独立配置的 key 直连模型服务商；CI 延后支持。
- 仓库绑定不要求有远端，完全本地的仓库也能用客户端模式。
- 仓库行能复用就复用，没有才新建；没有托管平台的仓库用 `client` 行承载，证据只显示路径和行号。
- `publish` 的模型调用全部来自 standalone。Radar 里由宿主 agent 逐个执行工作单的通道不用于 delta。
- 目标提交由命令行在本地读取，发布不依赖代码托管平台的适配；没有远端时，跟踪分支在首次发布时登记。
- 模型 key 按环境变量、凭证环境文件、agent 工具本地凭证的顺序查找，用户填写的优先于自动找到的；都没有时进入接入步骤，选服务商、粘贴 API key，结果写进凭证环境文件。接入步骤借鉴 Cindy 的做法。
- 远端观察值机制移出首期范围，原文保留在附录 A。
- 可用率试验通过（主数据集可增量窗口比例 73.3%，token 节省率 72.6%），进入身份层实施。
- 数据库迁移脚本移出分析目标（2026-11-25）：不读、不能当证据、改动不触发重新分析；客户端分类器把它判为 `no_detected_behavior_change`。ORM 模型代码与 schema 定义仍然强制全量。现有引用迁移脚本的锚点留作历史，不批量清理（§8.3）。决定后主数据集可增量窗口比例 85.9%，token 节省率 84.9%。
- 身份登记表只追加，不在上面记某个身份在不在链上；在不在链上看最新版本的身份列，退休和恢复由关系表按版本记录。
- 比对拿到两边的身份时先按身份配对，没配上的退回名称键；托管模式下模型的改名仍然折叠回旧名。
- 人工下线的墓碑按身份加宽成名称键，检查墓碑的地方不变。
- 人工下线的条目不算“不确定的消失”：合并之后那一步同样带着墓碑，不把它保留回版本（2026-11-25，真实 MySQL 演练查出，§24.10）。
- 发布事务显式声明隔离级别，不依赖服务器的默认值（2026-11-26，§24.11）。
- 迁移 049 不再依赖 `MD5()`，空的数据库在 MySQL 8 和 9 上都能建起来（2026-11-26）。
- 不查生产历史：修正不改写历史版本，被放回的功能在下一次发布时自动去掉（2026-11-26）。
- 身份层上线：合并到 main、部署、给线上全部仓库回填（2026-11-26）；推迟到行为咨询试点那条线提交并合并之后一起做（§24.11 第 5 条）。

## 24. 评审修订记录（2026-11-24）

### 24.1 已并入正文的修订

以下修订属于代码事实更正或内部补全，不改变已认可的方向。

| 位置 | 修订 |
|---|---|
| §3 | 重写现状事实：身份键现状与名称键消费方、工作台唯一键、`upsertGeneratedSpec` 对 `ai_snapshot_import` 的现行行为、版本层 `source` 列宽、patch-scan 语义、PR 预演性质、浅克隆、仓库行前提、限流与组装器 |
| §6 | 三个版本字段各自的管辖范围；输出语言一致性；基线暴露 `source` 与 `parentKey`，`source` 以工作台现状为准；基线体积与缓存；直接命中以版本证据为准 |
| §7 | diff 清单与补丁拆成两次调用；`--raw -z` 的模式与 blob id 用于服务端核对；`--no-textconv`、rename 检测上限、二进制按内容判定；补丁与清单按序对应；detached HEAD、浅克隆、同 head resync 的处理 |
| §8 | `expanded_closed` 首期没有生产者、按空集处理；“扩大范围”的定义；分类优先级；规则必须落成路径模式；与 BM-8 的语义差异登记；证据覆盖召回边界与客户端义务 |
| §9 | manual 条目的终态（原文按集合闭合会死锁）；锚点级退休门禁与服务端行号重映射；`declared` 的论域是自动功能；父子关系随 upsert 携带；身份劫持的处理；场景操作枚举与功能级 `unchanged` 的省略规则 |
| §10 | `serverAllowedPaths` 改按 declared 计算（原按 serverRequired 会让“客户端声明额外功能”无证据可读）；证据引用范围按操作类型；diff 传输态与零持久化 |
| §11 | 覆盖计数的不变式；与源覆盖率回执、R1 完整性账本的关系 |
| §12 | 新增行号重映射、manual 命中两行状态迁移；与人工核实列的交互 |
| §14 | 事务步骤补锚点门禁、漂移标记、回执继承、`is_current`，manual 按工作台现状复核；无基线用 `0` 哨兵（NULL 会让首发布失去唯一约束）；冲突回执带已成功 publication 坐标 |
| §15–§17 | 错误码、限流分桶、`publish` 分步执行、resync 的 retained 两档依据、首次基线两条路径与确定性回填条件、仓库绑定、webhook 待发布 head、PR 预演事实更正 |
| §19–§22 | 补验收用例、增量可用率门槛与身份层里程碑 |
| §20–§21 | 迁移项与改动面按实际代码重列；红线补充当日 MCP 反查结果 |

### 24.2 待确认的取舍

以下修订放宽或收紧了原文的默认，需要拍板。正文按标注的默认写，改主意时只动对应段落。

终审把这些取舍定为进入实质开发的前置条件（§22.1），并点名第 7 条必须先定。2026-11-24 产品负责人决定不再送外部评审、按本文档开工：没有另行说明的，都按正文写的默认执行。

1. **lockfile 与全局规则的粒度（§8.3）。** 原文把 lockfile 变化定为 `global_unbounded`，而现网托管模式（BM-8）把锁文件当非行为变更，同一仓库两种模式结论相反。正文保留原文的收紧，代价是每次依赖变更都要全量重同步；可折中为“依赖清单未变、仅锁文件重解析时记 `no_detected_behavior_change`”。另外正文把“路由注册、middleware”解释为装配点而不是处理函数本身，否则任何一次接口改动都会触发全量重同步。
2. **`expanded_closed` 首期是否为空（§8.1）。** 原文没有说明 consumer index 由谁产生。正文按“首期无生产者、恒为空集”处理，共享文件一律全量重同步。若首期就要可用，需要补一节定义声明式 registry 的入口、校验与失效。这一条与上一条一起决定增量可用率（§19.4）。
3. **身份键的落库策略（§9.2、§20）。** 原文暗示 `stable_key` 直接成为身份键；正文改为新增身份层，名称键列与消费方不动。前者模型更干净，但要同步改一串按名称键连接的消费方，并留下新旧语义混存的历史版本。
4. **二进制文件（§7.1、§8.3）。** 原文一律 `unknown`。正文放宽为“已知非行为资产路径记 `no_detected_behavior_change`，否则仍 `unknown`”；不放宽的话，提交一张截图就要全量重同步。
5. **PR 预演（§17）。** 原文倾向于在严格零服务端分析配置下关闭；核实后它是确定性索引查询，正文改为保留。
6. **脏工作区口径（§7）。** 沿用现行 `git status --porcelain`，未跟踪文件也算 dirty。开发工作区常有未跟踪文件，而 publish 只读 Git 对象；可考虑只看已跟踪文件的改动。
7. **client 模式的账户门控（§17）。** 第二轮评审指出“不扣 SAU”推不出“不受订阅状态约束”，正文已改为受账户状态约束，口径与现有闸门一致。定价问题已由产品负责人确认（2026-11-24）：`trialing` 账户放行。
8. **首次基线的赠予（§16.3）。** 经全量重同步首次建产品是否同样赠 1 SAU，正文给出的是与现有规则对齐的默认。仓库绑定已定：不要求有远端，见 §24.7。
9. **delta 写入限流的初值（§16.1）。** 每 Key 每小时 60 次是按“每次推送一条”估的，未经压测。
10. **上下文读取（§10.3）。** 可读集比可引用集多出有界、须声明的上下文路径，沿用现有提取预算。若要严格回到“只读可引用的文件”，删掉这一条扩展即可，闭合等式不受影响。
11. **可用率试验的阈值（§19.4）。** 试验要在跑之前定好 go/no-go 阈值，数字由产品拍板。
12. **没有远端的仓库（§7、§16.3）。已确认。** 跟踪分支取首次发布时当前检出的分支，命令行在输出里说明，不要求显式指定。产品负责人在 2026-11-24 确认。同批并入的三个默认（状态表按固定顺序取先命中的一行；本地缺 base 而 fetch 补不齐时不自动转全量重同步；目标提交由命令行在本地读取）已向产品负责人汇报，没有异议。“有远端指有名为 `origin` 的远端”没有单独汇报，仍是正文里的默认。同日晚的自洽性复查又按现行表结构补了几项默认，未经评审：新增 `provider` 取值 `client`，它的 `owner`、`name` 取组织和产品的 slug；首次发布按“本地已有标识、产品下恰有一条、没有、多条”的顺序确定仓库行；复用之前只做能确定的核对。见 §16.3。
13. **模型 key 的查找（§17.1）。大部分已确认。** 产品负责人在 2026-11-24 确认：接入时填写的 key 写进凭证环境文件；用户填写的优先于 agent 工具的本地凭证，第一次找不到 agent 工具的凭证时才请用户接入，接入之后以用户填写的为准；接入步骤借鉴 Cindy 的做法。没有结论的一件：ZCode 的端点令牌、DSH 的登录令牌能不能用来调用模型，产品负责人表示不清楚。正文按只认 API key 写。要有结论，需要平台方答复，或由产品负责人授权做一次最小试调。

### 24.3 第二轮评审修订（2026-11-24）

按第二轮评审的 11 条意见做局部修订，没有扩大架构。

| 位置 | 修订 |
|---|---|
| §12.5、§13.2 | 新增窗口级影响检查回执：每次发布一份，被保留的自动锚点引用它并带覆盖结果与原因；快速路径里落在变更文件上的锚点分流为重映射或 stale；新增 `anchorRevision` 说明行号坐标系 |
| §9.1、§9.3 | 场景操作闭合等式；功能级 `unchanged` 省略形式的成立条件；四种 manual 情况表 |
| §16.3 | resync 的复现优先，锚点未变以清单外影响核对为前提；闭合等式同样适用于 resync，锚点未变的一档可以省略 |
| §19.4、§20、§22 | 可用率测量前置为实施前的 go/no-go 试验；实施顺序改为试验、身份层、增量协议；身份层迁移期兼容规则 |
| §7.1、§11.2 | 契约记录生成端边界（Git 版本、路径编码、补丁字节不保证跨版本一致）；关联校验失败的定位方式；`diffInternalConsistency` 与 `diffAuthenticity` 分开命名 |
| §10、§16.1 | 可读集与可引用集分离；零代码字节的工程边界（§10.4）；分块组装的单实例部署前提与临时数据生命周期 |
| §17 | client 发布不扣 SAU 但受账户状态约束，口径与现有闸门一致 |
| §18、§19.1、§23 | 对应的失败处理、验收用例与决策条目 |

与评审建议不完全一致的有四处：

1. **功能级 `unchanged` 的成立条件（§9.3）。** 评审建议“功能进入 `declaredAffectedFeatureKeys` 就逐项闭合”。正文改按“是否有场景的证据行被触及”划线：全部未被触及时允许省略，有被触及时逐项提交。理由是进入 declared 的功能里，很多只是所在文件被改、证据行没动；对这种功能强制逐项提交，客户端编译器只能替模型没提到的场景批量生成 `unchanged`，等于把“客户端重核对过”写成不成立的声明。按触及划线时，省略只表示“服务端确定性保留”，回执如实记为 `deterministic_rule`。评审要防的是模型漏抽被静默掩盖，这一点由 `touchedScenarioKeys ⊆ explicitScenarioOps` 保证：证据行动过的场景没有明确终态，整个 delta 被拒绝。
2. **上下文读取（§10.3）。** 评审要求区分可读与可引用，已采纳；可读集在可引用集之外增加了有界、须声明、只读不可引用的上下文路径。这是对原决策“客户端 context 不能任意扩大范围”的细化，需要确认（§24.2 第 10 条）。
3. **go/no-go 阈值（§19.4）。** 评审要求根据数据决定。正文把试验前移，并规定阈值须在跑之前拍板，但没有替产品定数字（§24.2 第 11 条）。
4. **分块上传（§16.1）。** 评审建议评估会话粘性、数据库或对象存储。核实后现行部署是单容器原地重建，正文把单实例写成部署前提，多实例与共享存储留作后续；共享存储会持久化源码字节，与 §10.4 冲突，需单独定义才可考虑。

### 24.4 第三轮评审修订（2026-11-24）

第三轮评审的裁决是架构认可、仍有三个 P0、实施暂缓，并建议下一版只修三个 P0、补对应的 Golden 用例。三个 P0 与 Golden 用例已修；五条 P1 核对后都是不引入新组件的工程约束，一并写进正文。

| 优先级 | 位置 | 修订 |
|---|---|---|
| P0 | §12.5、§12.2、§13.2 | 窗口的行为结论与锚点事实分开。覆盖结果从三种改为四种，新增 `content_changed_nonbehavioral`；删除“`no_behavior` 窗口里全部自动锚点都是 `unaffected`”这句错误结论 |
| P0 | §12.5、§16.3 | resync 分可比较与不可比较；不可比较时回执记 `no_comparable_base`，只承认复现与有依据的退休 |
| P0 | §10.2、§10.3 | 可引用集下沉到工作单级：变更路径归它的证据所属功能，共享证据靠把功能放进同一个工作单 |
| P1 | §10.2、§10.3 | 工作单回执的字段各管一件事；新增核对方式 `disposition`；被触及的锚点必须被声明读取才能支撑显式 `unchanged` |
| P1 | §14.1、§14.4、§17 | 并发边界：模式切换与发布共用 repository 行锁；远端观察值独立存放，webhook 不写 `repositories` 行；账户状态不加锁读。远端观察值部分已移至附录 A |
| P1 | §12.4、§20 | provenance 只存例外，其余按“版本、回执、默认覆盖”解析 |
| P1 | §19.4 | 可用率试验增加实际分析量、预估节省与 stale 累积指标 |

两处与评审建议的措辞不同，结论一致：

1. **`scopedFeatureKeys` 没有改名。** 评审建议拆成 `assignedFeatureKeys` 等四个字段。正文保留原字段名，把它的含义明确为“责任范围”，读取声明沿用 `inputFiles`，核对方式另加 `disposition`。字段数与评审建议相同，只是不引入一次全文档的改名。
2. **账户状态不加锁的理由。** 不是为了避免死锁：现网 webhook 第二阶段的加锁顺序本来就是投递行、`repositories` 行、account 行，与发布事务不形成相反顺序。理由是发布事务的主要耗时在版本写入，持有 account 锁会让一次大发布期间该账户的计费操作全部排队。

### 24.5 第四轮评审修订（2026-11-24）

第四轮评审确认前三个 P0 已解决，新提出一个 P0 和四条 P1，并建议只做这几处局部修订。

| 优先级 | 位置 | 修订 |
|---|---|---|
| P0 | §17、§14.1、§14.4、§20 | 远端观察值的清除改为数据库条件删除。原文写的是“快照读、比较、清除”，在 `REPEATABLE READ` 下会删掉发布事务开始之后 webhook 写入的新值。增加并发 Golden 测试，时序用两条真实连接控制。这一段已移至附录 A |
| P1 | §12.5 | 回执字段的固定蕴含：`uncomparable` 时 `defaultCoverage` 为 null、`checkedFiles` 为空、没有锚点引用；违反者拒绝落库 |
| P1 | §10.3 | 跨工作单的认领约束：认领某个路径的工作单必须包含它的全部所属功能；共享路径拆到两个工作单时整体拒绝 |
| P1 | §17 | 账户状态检查写成明确的授权时效取舍，删去“不构成风险”的说法 |
| P1 | §12.4 | 默认覆盖的读侧解析不变量：五条前提不全成立时解析为 `unknown` |
| — | §19.4、§22 | 写明可用率试验是进入实施的门槛，不是完成后的验收项 |

（本段讨论的规则已于 §24.7 移至附录 A，文字保留作记录。）有一处超出评审清单，请在针对性复审时一并看：**webhook 写入观察值也改成了带条件的更新。** 条件删除修好了“发布误删”，但同一条保证还有一个相邻的漏洞。投递乱序到达时，单行的“最后写入者胜”会把观察值从较新的 head 倒退回较旧的 head；之后客户端发布到较旧的那个 head，条件删除命中，较新的观察就丢了。正文按投递负载的 `before`、`after` 和推送时间写了只朝前更新的规则（§17），并加了 Golden 测试。如果认为乱序投递不值得处理，删掉 §17 里“观察值只朝前更新”那一段和对应的测试行即可，条件删除本身不受影响。

终审已认可这一处，并要求补上推送时间相同时的处理，见 §24.6。

### 24.6 终审修订（2026-11-24）

终审裁决：设计通过，书面规格冻结为实施规格基线；新发现 P0 零项、P1 一项；实施门槛尚未满足。

| 位置 | 修订 |
|---|---|
| §17、§14、§20 | 推送时间相同且无法建立链关系的投递不再被当成“当前值更新”：观察值标为 `ambiguous`，记下相持的 head，给出三条消除途径；条件删除不作用于带歧义的行。已移至附录 A |
| §19.1 | 增加同时戳、歧义消除、带歧义行不删除的 Golden 用例，现见附录 A.2 |
| §22 | 拆成进入实施的前置条件与完成门槛；前置条件即终审列出的三项 |
| §24.2、页眉 | 写明这些取舍是进入实质开发的前置条件；状态更新为终审通过、书面规格冻结、实施门槛未满足 |

终审的建议是冻结书面规格、进入实施准备，不再做大规模修改，也不继续扩张契约。

### 24.7 按产品形态讨论的修订（2026-11-24）

终审之后，围绕客户端以什么形态交付、由谁触发发布做了一轮讨论，结论记录在《客户端形态与发布触发方式讨论整理》。产品负责人对其中七项做了决定，本节把决定并入规格。这些修订没有再送外部评审：产品负责人在 2026-11-24 决定按本文档开工，同时确认仓库行采用本节的默认、§24.2 的取舍按正文执行。

| 位置 | 修订 |
|---|---|
| §7 | 状态判定补全：本地落后于账本是空操作，不再被归为需要全量重同步；本地缺 base 时不自动转全量，fetch 也补不齐时由用户确认后显式全量。补判定顺序、fetch 约束和上传前的复查；目标提交改由命令行在本地读取；支持没有远端的仓库 |
| §16.2、§16.3 | 仓库绑定不再要求有远端，也不要求远端是 GitHub；完全本地的仓库也能用客户端模式，跟踪分支在首次发布时登记。“密钥不落盘”改为允许仓库之外的凭证环境文件 |
| §17 | 新增 §17.1：发布由 agent 在推送后和读账本发现落后时询问用户；自动发布的许可只记在本机；没有专门的确认机制；模型调用只用 standalone，并写明 key 的查找顺序和接入步骤；CI 延后支持；新鲜度只比提交号；只导入没连账号的用户提示连接账号 |
| §14、§17、§20、§22、§23 | 远端观察值机制移出首期范围，原文保留在附录 A |
| §18、§19.1 | 失败处理与验收用例相应增删 |
| §16.2 | `publish` 的分步执行改为两步落盘、可以续跑；宿主 agent 执行工作单的通道不用于 delta |
| §16.3、§20 | 仓库绑定按现行表结构写细：新增 `provider` 取值 `client`，确定仓库行的顺序，首次发布先建行再进事务 |
| §17.1 | 新鲜度补上现状：现在不返回远端最新提交，没有检查时间和强制刷新，要拿变更数就得拉 diff |
| §3、§21 | 补 `repositories` 身份的现状；补新增的改动面，并按当日账本快照重新反查红线 |
| §24.2 | 新增第 12、13 条，记录并入时的默认、产品负责人随后的确认和复查补的默认 |

决定与理由：

- 多人协作走 PR，没有人直接推默认分支，所以检查与发布之间被别人改写的可能性很低。保留上传前的复查，服务端不加远端检查。
- 许可只记在本机，不依赖远端地址；纯本地的仓库也应该能用 CoDelphi。
- 不做专门的确认机制，由 agent 在对话里说明并等待回答。
- 模型 key 由命令行从运行环境里查找：先看环境变量，再看各 harness 的本地凭证，找不到再交互式询问，或请用户在凭证环境文件里填写。填写之后以用户填写的为优先（§24.2 第 13 条）。
- 平台支持的顺序：GitHub 首期，之后 GitLab、Gitee、Gitea，逐个验证后开放。只导入快照、没有连接账号的用户，提示连接账号。

并入时补严了四处。它们不在七项决定里，是这次修订自己的默认，分别列在 §24.2：

- 状态表里几行会同时成立，例如本地既落后于远端又落后于账本。补了固定的判定顺序，先命中的一行决定处理方式。
- 本地缺 base 时如果 fetch 也补不齐，例如远端被改写、本地是改写之后的新克隆，“提示更新本地”会让产品卡住。改为不自动转全量重同步，由用户确认后显式执行。
- 目标提交原来没说由谁取。改为命令行在本地读远端跟踪引用，内部 git 服务器不必等平台适配也能发布。
- 没有远端的仓库没有默认分支可取。改为首次发布时登记当前检出的分支。

产品负责人随后答复了其中几项（2026-11-24）：

- 接入时填写的 key 写进凭证环境文件。
- 用户填写的优先于 agent 工具的本地凭证。先找 agent 工具的凭证与此不矛盾：找不到才请用户接入，接入之后以用户填写的为准。
- 没有远端的仓库，首次发布时把当前检出的分支登记为跟踪分支，不要求显式指定。
- 登录令牌和端点令牌能不能用来调用模型，产品负责人不清楚。正文按只认 API key 写。
- 接入步骤借鉴 Cindy 接入模型服务商的做法：每家服务商是一条带服务地址、协议和模型清单的目录记录，鉴权方式是 API key；用户只需要选服务商、粘贴 key，保存前可以取模型清单和试连接。已写进 §17.1。

同日晚做了一次自洽性复查，把这次修订和规格其余部分、现行代码逐条对了一遍，又改了四处。它们不在七条决定和上面的答复里，是按代码事实补的默认，未经评审：

- §16.2 原来写 delta 沿用 Radar“宿主 agent 逐个执行工作单”的分步通道，与“模型调用只用 standalone”冲突。改为两步落盘、可以续跑，那条通道不用于 delta。
- §16.3、§20 原来写“远端地址可选，有就登记”，但 `repositories` 没有远端地址列，身份是三个非空列加唯一键。按现行表结构重写了绑定规则。
- §17.1 的新鲜度只写了目标态。补上现状，以及要改的三处。
- §21 的改动面和红线没有覆盖这次修订新增的文件。已补，并按当日的账本快照重新反查。

远端观察值机制为什么可以移出：它在这份规格里的作用是让网页端提示“远端已前进”，并处理推送通知乱序带来的歧义。发现账本落后现在由新鲜度承担，网页端可以复用同一个函数按需计算。`repository_remote_heads` 是本节之前规格提出的新表，代码里不存在；规格里引用它的只有 client 模式的 webhook 分支、发布事务收尾的条件删除、模式切换时的一句说明，以及对应的验收用例和决策，托管模式的触发路径不读它。原文保留在附录 A，将来如果要在没有代码托管连接的仓库上做网页端提示，可以从那里恢复。

### 24.8 实施期间的修订（2026-11-25）

开工后，产品负责人查了现网账本，决定把数据库迁移脚本移出分析目标。这条决定不在之前的评审里，正文按它改了下面几处。随后标的“默认”是并入时代替产品负责人定的实施细节，没有经过评审。

| 位置 | 修订 |
|---|---|
| §8.3 | 迁移脚本一行从 `global_unbounded` 改为 `no_detected_behavior_change`，原因码 `schema_artifact`；新增一段说明分析目标的含义和托管分析怎么处理；ORM 模型与 schema 定义单独一行，仍是 `global_unbounded` |
| §12.5 | 迁移脚本上的锚点归入路径级的非行为分类，被改的行触及时记 `stale` |
| §19.2 | Golden 情形 schema/migration 拆成迁移脚本、ORM 模型与 schema 定义两条 |
| §19.4 | 新增“决定后的重测”，记录三处事后改动的口径和新结果；原来的门槛结论保留 |
| §21 | 新增这一部分的改动面、有意不改的文件、身份层的回归红线和部署时要注意的两点 |
| §22.1、§23 | 记录重测结果和这条决定 |

并入时代定的默认：

1. “迁移脚本”的范围是 `migrations/`、`migration/` 目录下的文件和所有 `.sql` 文件。ORM 模型代码（`models.py`、`*.entity.ts`）、Prisma 与 GraphQL 的 schema 定义、`alembic/` 和 `drizzle/` 目录不在其中，仍然强制全量。
2. 规则版本号保持 `impact-v1`。它随客户端增量分析一起首次发布，此前没有线上数据依赖旧的取值集合。原因码的集合多了一个 `schema_artifact`。
3. 迁移脚本的纯重命名仍走通用分支，带上重锚信息。现有账本里有引用迁移脚本的锚点，文件改名时它们要能跟着走。
4. 路径同时落在别的全局规则里时取全局规则，“同时命中多行取最保守一档”的读法不变。
5. 增量模式回退全量的“diff 文件数”条件不变，仍按全部改动文件计。它是偏保守的条件，没有因为移出而放宽。
6. 现有账本里引用迁移脚本的锚点留作历史，不批量清理（产品负责人的决定）。
7. 试验口径的三处改动和 Golden 情形的拆分见 §19.4。

实施中发现、计划里没有列到的三处同类入口，用同一个判定一并处理了：`lib/extraction-contract.ts` 和 `lib/behavioral-enumeration.ts` 各自拼装的证据允许集，以及整条版本链都没有回执时写下的合成零回执。

知道而没有处理的两点：

- 代码托管平台返回的改动文件有补丁长度预算，迁移脚本的补丁在被过滤掉之前仍然占这份预算。它不影响账本，只是让同一窗口里其他文件的补丁可能更早被截断。要改就会动到发布页用的数据，另议。
- `scripts/measure-first-analysis.ts` 仍按历史口径把迁移脚本算进实现面。它是 2026-11-08 那次测量用的脚本，量的就是当时的口径。

### 24.9 身份层实施期间的修订（2026-11-25）

身份层按 §20 开工。细则写在 §20 的“身份层的实现与验收”里，这里只记相对原计划的改动和我替产品负责人定的默认。它们都没有经过评审。

| 位置 | 修订 |
|---|---|
| §20 | 登记表改成只追加，去掉“退休于哪个版本”一列；场景身份键定为两元的 JSON 数组；按身份配对写成比对的可选输入，没配上的退回名称键；墓碑改成按身份加宽，检查点不动；补上线顺序和没有验证到的部分 |
| §21 | 身份层的改动面和红线标注为已实施 |
| §22.2 | 各条的状态 |

相对原计划的改动，都有原因：

1. **登记表不记状态。** 原计划写的是身份登记表带退休状态。写到回填时推演“一个产品下有几个仓库”才发现这一列说不清：身份是产品级的，版本链是仓库级的。去掉它之后每次发布只做插入，不做状态翻转。
2. **批量更新用派生表，不用临时表。** 原计划写的是临时表关联。事务里建临时表在有些二进制日志配置下不允许，派生表的效果相同。
3. **墓碑不改检查点。** 原计划写的是检查点先查身份再查名称。改成加载墓碑之后做一次加宽：凡是名字能解析到被下线身份的名称键，都加进墓碑。检查点和它们的测试因此一个不用动。
4. **“验收用冻结夹具重放托管 run”换成两条证据。** 仓库里没有这样的夹具。换成“既有测试一个没改”加“在生产账本的真实数据上离线演练”。
5. **读取登记表和上一版身份提前到合并之前。** 加宽墓碑时就要知道每个名字对应哪个身份。这两份之后给这一版算身份时再用一次。

我替产品负责人定的默认：

- 新增的返回字段（这一版的身份计划）是可选的。这样别的测试文件里现有的替身返回值不必为了它去改。
- 登记表里已经有的身份，再遇到时把“首次出现的版本”往更早改。部署之后、回填之前发布的几个版本会先用较晚的版本登记身份，回填走到更早的版本时纠正它。
- 回填不碰工作台的两张表。工作台行在下一次发布时补上身份；行上已经有身份的保留，空的才补。
- 按身份配对时，排序位置相同的一对靠稳定排序分先后，比较器只比排序位置。先后规则写进比较器的话，有几条变异杀不掉。
- 开关 `SPEC_IDENTITY_LAYER` 默认开。

仍然受原来的限制：

- 身份层之前被人工下线的条目没有身份，只按名称键拦。
- 场景在配对好的功能里仍按编号配对。编号变了的情形由原有的重编号折叠处理。

### 24.10 真实 MySQL 演练和它查出的缺陷（2026-11-25）

这一节都是我写的，没有经过评审。起因是我在提交说明、§20 和 §24.9 里写过“这台机器上没有 MySQL，SQL 没在真实数据库上执行过”。那是没有核实的假设，机器上有。之后做了两件事，记下四条边界。

**一、演练脚本。** `scripts/verify-spec-identity-mysql.ts`，照 `scripts/execution-batch-migration-smoke.ts` 的先例：只认 `SPEC_IDENTITY_VERIFY_DATABASE_URL`，不读 `DATABASE_URL`，库名必须以 `codelphi_test_spec_identity` 开头。它做什么、结果如何，见 §20 末尾。

**二、演练查出一个缺陷，已修：人工下线的条目会回到版本里。**

- 现象。用户在工作台把一个功能关掉之后，下一次发布里它仍然出现在规格版本中。工作台里它还藏着，所以从工作台看不出来。
- 原因。墓碑只在“合并来源”那一步生效（`mergeSpecSources`）。后面还有一步把“上一版有、这一版没有、又拿不出移除证据”的条目当作不确定的消失保留回来（`preserveUncertainDisappearances`，提交 `8fe4f5e` 引入），这一步不看墓碑。被墓碑去掉的条目正好符合这个描述，于是以旧名字回来。
- 范围。原有的按名字记的墓碑和这次加的按身份加宽都受影响，功能和场景都是。原有的墓碑测试用的是没有上一版的夹具，所以从来没测到。这次加的按身份拦截，它的测试同样没有“上一版带着这个功能”的情形，离线验收也不经过这一步，到真实演练才暴露。
- 修法。`preserveUncertainDisappearances` 加一个可选的墓碑参数，调用处传入。不给参数时行为和原来完全一样，`lib/spec-diff.ts` 原有的 68 个测试一个没改。人工下线的功能不放回，放回的功能不带人工下线的场景。
- 不在已批准的计划内。修的是同一条路径，按名字的那个洞是主线里原有的。账本里相关的两条场景是 EC-24（没覆盖到而缺失的功能保留回规格）和 EC-39（没给变更文件时不确定的照常保留），说的都是因为覆盖不全而缺失的条目。推送之后它们对没有下线过的条目应当照常成立，是对账锚点。
- 没有做的。不改写历史版本。生产上过去有没有用户下线的功能已经被放回过，没有查。

**三、四条边界，留给后面。**

1. **回填不能在“身份和名称键不同”的行上重跑。** 回填从空登记表开始按名称键重算，并覆盖行上已有的身份。今天每一行上身份就是名称键：服务端只按名称键分配身份，模型给出的改名会被折叠回旧名；2026-11-25 只读核对了生产 10 个仓库 36,709 行功能，`stable_key` 和按 `name` 算出的名称键没有一行不一致。所以现在重复回填是安全的，演练里也验证了。等客户端增量协议带来真正的改名，就必须先让回填沿用它遇到的身份，或者明确作废回填。演练脚本把“改过名”的情形放在回填之后，就是为了不把这个边界算成通过。
2. **MySQL 9 没有 `MD5()`。** 迁移 049 用了它，在 MySQL 9 上从零建库会失败。生产是 MySQL 8，不受影响；运行时的 SQL 没有用到它。演练脚本的 `--md5-stand-in` 只在临时库里放一个同名的替身，让迁移链走完。要不要把 049 改成不依赖 `MD5()`，由产品负责人定。**2026-11-26 已改**：049 改用 `SHA2()`，替身开关去掉了，见 §24.11。
3. **迁移和回填还没有在 MySQL 8 上执行过。** 2026-11-26 在生产数据的副本上演练了一次（§20 末尾），副本跑在本机 MySQL 9.6.0 上。同时查清了生产的设置：MySQL 8.0.30（腾讯云 CynosDB），严格模式，二进制日志为 ROW，默认隔离级别 `READ COMMITTED`，库的默认字符集是 `utf8mb3`。后两条和本机不同，本机是 `REPEATABLE READ` 和 `utf8mb4`。084 里表和列的字符集、排序规则都是写明的，在 `utf8mb3` 的默认值下建出来的仍是 `utf8mb4`。要在 8.0 上真正执行一遍有两条路，都要产品负责人点头：在本机起一个 MySQL 8.0 的临时容器（仓库约定不引入本地数据库容器），或者在生产的实例上建一个只含那五张表的临时库（大约 140MB，要在生产实例上写入）。
4. **生产的默认隔离级别和规格的假设不一样。** §14 是按 `REPEATABLE READ` 写的。应用没有自己设置隔离级别，所以生产的事务实际跑在 `READ COMMITTED` 下；本机的 MySQL 默认是 `REPEATABLE READ`。按行加锁串行化、不依赖间隙锁、把删除写成条件操作，这些规则在两个级别下都成立。受影响的是任何依赖“事务里多次读到同一份快照”的推理，以及在本机默认设置下跑的并发测试。客户端增量协议开工前要定一件事：发布事务要不要显式声明隔离级别。这里只记事实，规则没有改。

### 24.11 上线前的决定（2026-11-26）

产品负责人在生产数据副本的演练之后定了四件事，记在这里。都没有经过评审。

1. **发布事务显式声明隔离级别。** 不再依赖服务器的默认值。声明哪一个级别是我的理解，产品负责人只说了“显式声明”：按 §14 的规则推导时所用的 `REPEATABLE READ`。如果本意是别的级别，§14 的加锁规则要按那个级别重新推一遍。这件事随客户端增量协议一起实现，身份层的写入路径这次没有动。
2. **人工下线的条目不回来，这个修正随身份层一起上线。** 它同时修了主线原有的按名字记的墓碑（§24.10）。
3. **迁移 049 不再依赖 `MD5()`。** 改用 `SHA2()`，结果的形态相同。生产早已执行过这条迁移，不受影响；从今往后空的数据库在 MySQL 8 和 9 上都能从零建起来。`tests/migrations.test.ts` 多了一条守卫，任何迁移都不得调用 `MD5()` 或 `SHA1()`。演练脚本不再需要替身函数，`--md5-stand-in` 去掉了；不用替身从空库跑一遍，86 个迁移文件全部通过。
4. **不查生产历史。** 修正只管以后的版本。被放回的功能在下一次发布时按新逻辑去掉，不需要清理。
5. **上线推迟。** 产品负责人原话是合并到 main、部署、给线上全部仓库回填。准备到切换之前发现，生产当时跑的是另一条线（行为咨询试点）从没有提交的状态构建出来的镜像，带着它还没提交的 MCP 工具，又缺 main 上后来的分析管线修复。部署 main 会把那个工具从线上拿掉。产品负责人决定等那条线提交并合并之后再一起部署，避免互相覆盖。届时重新合并、构建、部署，再回填、推送。为此做过的一次合并候选（`9b1cbd3`）和镜像已经丢弃，不留着免得被误部署。

## 附录 A：已移出首期范围的远端观察值规则

本节是 §24.7 之前正文里的规则，原文保留，首期不实施。恢复时需要一并恢复：发布事务收尾对远端观察值的条件删除（原在 §14.1 第 11 步）、锁范围里的对应说明（原在 §14.4）、`repository_remote_heads` 表（原在 §20）、模式切换时“已有观察值不作废”的说明（原在 §17 状态机第 3 条），以及 A.2、A.3 列出的验收用例和决策。

### A.1 原正文（原 §17）

**远端观察值只朝前更新。** 投递可能乱序到达，所以写入是带条件的，不能用“最后写入者胜”：新投递的 `after` 等于当前观察值时不操作；`before` 等于当前观察值时前进到 `after`，快进、force push 和分支切换都走这一条；`after` 等于当前观察值的前一个 head 时，说明这条投递是前一次推送、只是到得晚，忽略；其余情况靠投递本身建立不了先后，只能比推送时间（负载里的 `repository.pushed_at`）：时间不同取晚者；时间相同就相持不下。

相持时保留当前 head，但把观察值标成 `ambiguous`，并记下与之相持的另一个 head。`pushed_at` 是时间字段，不是事件序号，精度有限；时间相同证明不了当前 head 更新，产品页不得把它显示成“最新远端 head”，只能提示“远端 head 无法确定”。消除歧义有三条途径，都是据实改写并清除标记：

- 新投递能建立链关系，或者它的推送时间晚于相持的两条。前一种情况下，它的 `before` 等于当前 head，或者等于相持的另一个 head；等于另一个 head，说明另一个 head 才是当时的远端，观察值改从它接续。
- 仓库有代码托管连接时，服务端用代码托管 API 查一次分支 head。只取元数据，不读源码；现网的 `getBranchHead` 已在触发兜底里使用。在读取基线和每小时的触发兜底里尽力而为，失败不影响基线响应，观察值保持 `ambiguous`。
- 仓库没有代码托管连接时，只能等第一条途径。

发布事务的条件删除只作用于没有歧义的观察值。带 `ambiguous` 的行即使 head 等于本次发布的 head 也不删，因为与之相持的另一个 head 可能更新。远端观察值只是提示，不是发布授权，也不是水位依据。

原“并发边界”一节中与远端观察值有关的部分：

- 远端观察值存在独立的行里（§20）。client 模式下 webhook 只写这一行和投递行，不写 `repositories` 行。发布事务只在收尾时对它做一次条件删除，行锁从那一步持续到提交，webhook 最多等这一小段时间，不会等整个发布。
- 清除观察值必须是数据库里的条件删除，不能先读后删。本设计跑在 `REPEATABLE READ` 上，事务里的普通读是快照读，看不到事务开始之后 webhook 写入的新值：发布读到 B，webhook 随即把观察值改成 C，发布若按先前读到的 B 判断“等于本次 head”再无条件删除，C 就丢了。条件删除按行的最新已提交版本求值，webhook 已经改写时不会命中：

```sql
DELETE FROM repository_remote_heads
WHERE repository_id = ? AND head_sha = :published_head_sha AND ambiguous = 0;
```

条件删除与水位推进在同一事务里提交。快照读来的观察值只写进回执，不作为任何删除的依据。`ambiguous` 是观察值的歧义标记，含义见本节“远端观察值只朝前更新”一段。

### A.2 原验收用例（原 §19.1）

| 场景 | 必须验证 |
|---|---|
| webhook 与发布并发 | webhook 不等待整个发布事务，最多等收尾的条件删除；观察值按条件删除的规则清除或保留 |
| 发布读到观察值 B 后 webhook 写入 C，发布再完成 | 条件删除不命中，C 保留。时序用两条真实连接控制；mock 的 execute 测不出这个竞态 |
| 条件删除与 webhook 写入以任意顺序交错 | 观察值不丢：要么留下新值，要么在删除后被重新写入 |
| 乱序到达的两次推送 | 观察值停在推送时间靠后的 head，不倒退 |
| 推送时间相同、无法建立链关系的两次投递 | 观察值标为 ambiguous 并记下相持的 head；不声称当前 head 是最新 |
| ambiguous 观察值遇到能建立链关系的后续投递 | 据实改写并清除歧义；`before` 等于相持的 head 时从它接续 |
| 发布的 head 等于 ambiguous 观察值的 head | 不删除该行 |
| 读取基线时观察值为 ambiguous，且仓库有代码托管连接 | 尽力查询分支 head 消除歧义；查询失败不影响基线响应 |

### A.3 原决策（原 §23）

- 远端观察值的清除与更新都是数据库里的条件操作，不做先读后写。
- 推送时间相同且无法建立链关系时，观察值标为 ambiguous，不声称当前 head 最新；发布不删除带歧义的行。
