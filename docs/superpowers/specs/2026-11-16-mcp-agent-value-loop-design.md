# CoDelphi 修改前决策增强设计

## 1. 产品问题与价值假设

CoDelphi 当前已经能参与开发流程，但尚未证明能改变开发结果。下一阶段首先要回答：

> 能否让开发者发现原本不知道需要检查的行为、历史回归或验证证据，并因此做出更好的实现、测试或发布决定？

首个交付版本不以增加 MCP 工具数量或自动完成验收为目标，而以**修改前决策增强**为目标：

1. 将证据锚点重合与文件级关联分开，避免把共享文件当成精确影响面。
2. 将已观察行为、人工核实状态和历史回归记录分开，不把账本现状自动当成已确认契约。
3. 只返回可追溯的验证证据；没有测试映射时，不宣称发现了具体测试盲区。
4. 共享证据不再制造低价值 warning。
5. 用真实任务衡量独立发现、决策改善、净时间收益和无效打扰。

P0 的价值假设是：在陌生、跨功能或验证证据不足的真实任务中，上述信息至少能促成一项原本不会发生的正确决策，例如调整实现方案、增加必要回归验证或推迟发布。一次成功对账、一次工具调用或一份很长风险清单都不算价值证明。

## 2. 已确认问题与影响面

2026-11-16 对 `lib/mcp/server.ts`、`lib/mcp/reconcile.ts`、`lib/mcp/operations.ts`、`lib/mcp/projections.ts`、`docs/coding-agent-mcp.md` 和 `AGENTS.md` 执行了生产 `lookup_by_files?view=risk`：

- 快照 SHA 为 `12426288d195dd5adf1ef317a0f9956abc3890c9`。
- 返回 99 条 raw 风险、19 条 canonical 场景；前 10 条全部属于同一功能且只是文件级证据。
- 四个 MCP 实现文件有账本覆盖；`AGENTS.md` 与工作流文档没有覆盖，不能把空结果解释为无风险。

必须守住的行为红线：

- 默认 raw 响应、组织级防枚举和不存在资源返回空对象的语义不变。
- stableKey 只用于名称级匹配，不升级为行为身份；scenario reference 不作为跨版本稳定身份。
- run、release 与请求 SHA 必须一致；短 SHA 歧义返回 review。
- path-only intent 不能独立证明行为身份；没有意图不能默认 pass。
- 共享证据不是重复证明；canonical 仍只合并可证明的重复投影。
- 没有显式 feedback verification 关联时，feedback verification 继续为 unavailable。

## 3. 方案比较

### 方案 A：确定性修改前决策投影（P0 采纳）

扩展现有 `lookup_by_files?view=risk`，加入证据锚点评估、已观察行为、人工核实状态和名称级历史回归提示；同时降低共享证据的告警等级。

优点是直接改善开发者修改前的判断，复用现有规格、证据和验证事实，不需要新事实数据库或 AI 判官。限制是不能证明完整调用依赖，也不能从没有验证记录推断没有自动化测试。

### 方案 B：优先建设自动验收闭环

先实现本地意图文件和 `verify_push`，再提高影响面质量。它能减少操作步骤，但可能只是更高效地执行低价值流程，因此推迟到 P2。

### 方案 C：AI 阅读 diff 并生成行为契约与影响结论

覆盖看似更广，但会把推测升级为契约，且结论不可重复，本设计不采纳。Agent 可以提出待确认约束，但不能改变 CoDelphi 的确定性事实等级与 verdict。

## 4. 事实等级与验证语义

长期责任边界固定为三层：CoDelphi 负责可追溯事实，Agent 负责基于事实提出推理与验证建议，开发者负责确认约束、实现方案、测试范围与发布决定。Agent 接受建议不会把建议升级为事实，事后修改计划也不能消除已经发现的意图偏差。

所有新增输出严格区分以下概念：

| 概念 | 来源与含义 | 不得推断 |
|---|---|---|
| `observedBehavior` | 当前 active scenario 的 context/action/outcome 与代码证据 | 不等于团队确认的永久契约 |
| `proposedConstraint` | Agent 根据任务和已观察行为提出的本次修改约束 | 未经确认不得标成验收标准 |
| `confirmedConstraint` | 开发者或产品负责人在计划/评审中明确确认的约束 | CoDelphi 不从 generated/manual source 自动推导 |
| `specVerification` | live scenario 的 verified/stale 状态及 `spec_verifications` 历史记录 | 不等于自动化测试通过 |
| `regressionAlerts` | release 下 regression task 的状态、检查和失败记录 | 名称级关联不等于跨版本同一场景身份 |
| `testExecution` | Agent 在项目中实际运行的测试命令和结果 | MCP 未观察到时不得声明存在或通过 |

当前 schema 的事实边界已经核实：

- `scenarios.verified_at/verified_by/stale_since` 可推导 `unverified`、`verified`、`stale-verified`。
- `spec_verifications` 通过 `product_id + entity_type + entity_id` 关联 live scenario，并记录 specVersion、commit、验证人和时间。
- `regression_tasks` 关联 release、版本内 scenario、状态、检查人、时间和失败备注。
- `feedback_reports.regression_stable_key` 仅是名称级锚点，不能证明历史反馈属于当前场景。
- 当前没有 scenario 到测试文件/测试用例的完整映射，也没有 feedback 到 verification 的显式归属链。

因此“没有验证记录”只能表示**验证证据缺口**，不能表示“没有测试”或“测试未覆盖”。“名称相同的历史回归”只能作为复核提示，不能合并跨版本场景身份。

## 5. P0：证据锚点与决策投影

### 5.1 输入扩展与版本坐标

`lookup_by_files` 保留 `paths`，新增可选 diff 坐标：

```ts
{
  slug: string;
  paths?: string[];
  diffBaseSha?: string;
  diffTargetSha?: string | null;
  hunks?: Array<{
    path: string;
    oldStartLine: number | null;
    oldEndLine: number | null;
    newStartLine: number | null;
    newEndLine: number | null;
  }>;
  view?: "raw" | "canonical" | "risk";
}
```

约束：

- `paths` 与 `hunks` 至少一个非空；hunk 路径自动并入 paths，不要求重复提供。
- 路径规范化、去重后最多 20 个；禁止绝对路径与 `..`。
- hunks 中的路径执行锚点评估；只在 paths 中出现的路径执行文件级匹配。
- 行号与 Git unified diff 对齐：某侧行数为 0 时该侧范围为 null；非空范围从 1 开始并满足 `endLine = startLine + lineCount - 1`。新增文件通常为 old=null，删除文件通常为 new=null，每个 hunk 至少保留一侧非空范围。
- 同一路径的重叠区间分别按 old/new 侧合并用于匹配，原始输入仍逐项校验。
- `diffTargetSha=null` 表示当前工作区；不提供 hunks 时保持现有文件级行为。
- raw/canonical 视图不因 diff 参数改变；锚点投影只在 `view=risk` 启用。

证据锚点使用账本 `snapshotSha` 坐标，diff 同时具有 old/new 两套坐标，按以下优先级确定 `coordinateStatus`：

1. base 与 target 均非空且相等：`same_revision`，不存在提交变化，不做锚点影响判断。
2. `diffBaseSha === snapshotSha` 且 target 不同：`matched_base`，使用 old-side。target 可以是另一提交或工作区；old-side 坐标锚定 base，不假设工作区新行号与 base 相同。
3. target 非空、`diffTargetSha === snapshotSha` 且 base 不同：`matched_target`，使用 new-side。
4. target 为工作区且 base 未命中：`workspace_unresolved`，无法证明工作区与证据快照的坐标关系。
5. 其余情况或 snapshot 缺失：`unavailable`。

`same_revision`、`workspace_unresolved` 和 `unavailable` 均降级为文件级匹配。响应返回 `snapshotSha`、`diffBaseSha`、`diffTargetSha`、`coordinateStatus`；匹配时另返回 `coordinateSide="old"|"new"`，否则为 null。无法证明坐标一致时不得产生 line 命中。

### 5.2 证据锚点重合规则

每条场景证据保留 `path`、`startLine` 和来源场景：

- 证据自身含有效 `startLine`：`evidenceGranularity="line_anchor"`，否则为 `file_only`。该字段只描述证据粒度，与本次坐标是否可用无关。
- 坐标一致、证据路径等于 hunk 路径，且行锚点落在所选坐标侧的任一 hunk 闭区间内：`matchType="line"`。
- 只确认同文件、锚点未重合、没有行号或坐标不可用：`matchType="file"`。因此 `line_anchor + file` 可以表示有行锚点但未重合或无法比较。
- 同一场景有任一锚点重合时，该场景整体为 `line`，不因其他文件证据重复计算。
- 未提供 hunks 的路径全部为 `file`。

`line` 只表示**变更范围与证据锚点重合**，不表示命中完整实现范围或行为依赖。没有锚点重合也不能解释为没有影响。

计数均按 scenario ID 去重：`directScenarioCount` 为锚点重合场景数，`fileOnlyScenarioCount` 为仅文件级场景数，`totalCount` 为两者之和。证据条数不得作为场景数量。本阶段不实现符号、调用、接口、数据库状态或外部客户端依赖分析。

### 5.3 已观察行为与证据输出

现有 `risks` 字段保留并增加：

- `matchType`、`evidenceGranularity` 与 `consideredEvidence: Array<{ path: string; startLine: number | null }>`；
- `observedBehavior: { scenarioId: number; reference: string; context: string; action: string; outcome: string; source: string }`；
- `specVerification`。

`consideredEvidence` 包含本次请求路径下被评估的证据，包括重合与未重合项，不表示每条都匹配成功。不再使用未分级的 `contract` 字段。`manual` 只表示人工维护来源，不自动表示 confirmed constraint。

场景排序为：锚点重合优先、`stale-verified` 优先、manual 优先、stableKey、scenario ID、证据路径。`stale-verified` 与历史失败回归不混为同一风险等级。场景默认仍返回前 10 条并保留 `totalCount/hasMore`；历史回归提示独立返回，不会被场景分页挤掉。

### 5.4 当前人工核实证据

每条命中场景返回：

```ts
specVerification: {
  state: "unverified" | "verified" | "stale-verified";
  verifiedAt: string | null;
  verifiedBy: string | null;
  latestRecord: {
    specVersionId: number | null;
    commitSha: string | null;
    verifiedAt: string;
    verifiedBy: string;
  } | null;
}
```

`state` 复用 live scenario 的 `verified_at × stale_since` 规则；`latestRecord` 取该 live scenario 在产品内最新一条 `spec_verifications`。二者分别表示当前核实状态与历史核实依据，不相互替代。

已核实的生命周期规则：

- 人工规格变更会设置或刷新 `stale_since`；已核实内容之后失效为 `stale-verified`。
- 核实动作在同一事务中更新 `verified_at/verified_by`、清除 `stale_since/stale_change_id` 并追加 `spec_verifications`。
- 再次变更会重新设置 stale，再次核实会再次清除，因此不依赖“第一次过期时间”推断当前状态。
- generated 内容变化或人工编辑会清除当前 `verified_at/verified_by`，状态为 `unverified`；这不表示从未核实，历史记录仍可证明过去发生过核实。

状态真值表与现有 `verificationState` 完全一致：

| verified_at | stale_since | state | 含义 |
|---|---|---|---|
| null | null | `unverified` | 当前内容未核实，无失效标记 |
| 有值 | null | `verified` | 当前内容已核实，之后未标记失效 |
| 有值 | 有值 | `stale-verified` | 曾核实，之后内容被标记失效 |
| null | 有值 | `unverified` | 当前内容未核实，同时保留失效标记；可发生于核实后再次编辑或生成内容变化 |

`latestRecord` 按 `verified_at` 的数据库时间值和 `id` 依次倒序选择，DATETIME(3) 保留毫秒，ID 处理并列；响应序列化为 ISO 8601，不对序列化后的日期字符串做排序。live 与历史记录是不同证据链，legacy 数据或后续状态变化造成的差异不自动判为 inconsistent。`verified_at` 有无与 `stale_since` 有无形成的四种组合均有明确的现有语义，因此本阶段不新增 unknown/inconsistent 状态。

没有历史记录时 `latestRecord=null`，但 `state` 仍按 live 字段独立计算。`unverified` 只表示当前内容未核实，`latestRecord=null` 只表示没有历史核实记录；二者均不表示“没有测试”，历史记录存在也不表示当前内容已核实。

### 5.5 独立的名称级历史回归提示

历史提示使用顶层 `regressionAlerts`，不嵌入前 10 条场景，也不依赖场景是否进入当前页。先取得全部命中功能的 stableKey 集合，再用回归来源已有的 `COALESCE(spec_features.stable_key, spec_changes.feature_key)` 在产品内过滤，避免全产品扫描后遗漏目标功能：

```ts
regressionAlerts: Array<{
  taskId: number;
  releaseId: number;
  releaseCommittedAt: string;
  featureName: string;
  normalizedFeatureName: string;
  reference: string | null;
  status: "pending" | "failed" | "skipped";
  checkedAt: string | null;
  checkedBy: string | null;
  failureNote: string | null;
  matchBasis: "normalized_feature_name";
}>
```

关联只发生在产品内部，只查询候选 stableKey 集合和 `pending/failed/skipped` 任务。按 `releaseCommittedAt DESC, taskId DESC` 稳定排序，**每个 normalized feature name 最多返回 5 条**，不是整个请求共享 5 条。返回原始功能名与归一化名称，调用方可以判断名称关联是否合理；release 时间用于识别陈旧记录，skipped 不被当成失败。

`regressionAlertCount` 是这些候选功能在完整过滤查询中的非 passed 任务总数，不是已返回条数，也不是全产品扫描样本数。过滤集合完整时 `regressionHistoryComplete=true`；若未来增加时间窗口或扫描上限，必须返回 false 并披露范围。空数组只表示当前候选功能在完整查询范围内没有非 passed 任务，不表示没有历史缺陷。

该列表是名称级历史线索，不宣称任务中的 reference 与当前场景是同一跨版本身份。

### 5.6 候选分组，而非推荐意图或自动契约

风险投影新增：

```ts
candidateIntentGroups: Array<{
  stableKey: string;
  paths: string[];
  scenarios: Array<{
    id: number;
    reference: string;
    matchType: "line" | "file";
    consideredEvidence: Array<{ path: string; startLine: number | null }>;
  }>;
}>
```

它只把全部命中场景按 stableKey 确定性分组，并保留每个场景的命中依据；不表示 CoDelphi 已推荐本次完整开发意图。每组 `paths` 仅取该组命中场景的 `consideredEvidence` 中实际属于本次请求的证据路径，不扩展为该功能在账本中的全部路径。

Agent 必须根据任务删除无关项，不需要为组内所有场景逐一建立验收断言。需要保持的行为先写成 `proposedConstraint`；只有经过开发者或产品负责人确认后，才能在本地计划中标记为 `confirmedConstraint`。

P0 不新增服务端意图存储，不让 MCP 自动把候选分组当成开发者的真实意图。

### 5.7 批量读取与性能边界

- 只有 `view=risk` 加载新增验证和历史数据；raw/canonical 不增加查询或改变响应。
- live scenario 按 product 批量读取；`spec_verifications` 按 product、`entity_type="scenario"` 和命中 scenario IDs 一次批量读取，在内存中取每个场景最新记录。
- 回归任务按 product 与候选 stableKey 集合批量过滤，使用 MySQL 8 窗口查询或等价的单次查询按功能各取最新 5 条，并在限制返回前计算完整 `regressionAlertCount`；不得先取全产品固定条数再做目标功能过滤。
- 禁止按场景或功能逐条查询 verification 或 regression，禁止用无上限全产品历史读取支撑风险投影。返回量以候选功能数 × 5 为上限。
- 所有查询继续使用 organization 解析出的 productId，不能以 scenario ID、stableKey 或 release ID 跨产品取数。
- P0 不新增索引或缓存。实施时用生产数据规模和查询计划验证现有索引；出现实测问题再单独设计，而不是预先扩张 schema。

## 6. P0：低噪声验收结果

`reconcile_release` 继续返回 `sharedEvidenceWarnings` 以兼容旧调用方，同时新增 `informationalSignals`。共享证据只进入信息信号：

- 不再向 `reasons` 添加 `shared_evidence_requires_review`。
- 不再仅因共享证据把 verdict 从 pass 降为 warning。
- `warning` 保留给确定性重复簇、legacy 来源问题等需要复核的异常。
- `failed`、`review` 的既有优先级不变。
- `pass` 仍只表示所提供意图和可读取证据范围内通过，不表示所有行为正确或测试完整。

`sharedEvidenceWarnings` 仅为响应结构兼容而保留并标记 deprecated，不再具有 verdict 降级语义；新调用方使用 `informationalSignals`。MCP instructions 和工作流文档必须同步说明，避免旧客户端继续把该字段解释为待处理异常。后续版本再制定字段移除计划，本阶段不破坏旧响应结构。

这是对 verdict 噪声语义的有意修正，不改变原始变化、证据和共享证据数据。本阶段不引入另一套状态枚举；现有 pass/warning/failed/review 的含义保持不变。

## 7. 风险触发工作流

更新 MCP initialize instructions 与工作流文档。完整修改前决策投影用于至少满足一项的修改：

- 证据锚点重合、人工维护行为、待重新核实或失败回归；
- 多功能共享文件、身份/权限/版本/数据关联语义；
- 验证证据不足或历史回归区域；
- 跨模块、大范围或调用方难以枚举影响的修改。

轻量流程用于明确低风险修改。没有证据覆盖时必须明说影响面未知，不能跳过项目验证或宣称无风险。

修改前由 Agent 记录任务意图及 proposed constraints，并注明其来源；确认后的约束才能作为验收标准。Agent 负责选择验证方法和执行项目测试，CoDelphi 负责提供行为、历史和验证证据。计划外变化必须回查，不允许通过事后修改意图掩盖异常。

## 8. 后续阶段，不属于 P0 实施范围

### P1：意图交接与历史缺陷提示

- 本地意图文件关联 proposed/confirmed constraints、验证方法和回归测试。
- 使用 `feedback_reports.regression_stable_key` 提供名称级历史缺陷提示，明确不代表完整回归范围。
- 没有显式关联时仍不建立 feedback → verification 或 scenario → test 的推断关系。

### P2：自动验收与更完整的依赖分析

- `verify_push` 组合现有 `wait_for_release` 与 `reconcile_release`，复用修改前已记录的意图，不能事后从 diff 反向编造意图。
- 显式空意图可表示预期零行为变化；未提供意图仍为 review。
- 根据真实误判案例再决定是否建设调用、接口、数据和状态依赖分析。

这些后续项只有在 P0 试点证明决策改善后才进入各自的设计与实施计划，不与 P0 捆绑交付。

## 9. 价值试点与停止条件

建立无自动遥测的试点记录，连续记录至少 20 个真实任务，优先选择陌生模块、跨功能修改或验证证据不足的任务。查看 CoDelphi 输出前先记录开发者的初始影响判断、拟修改方案和验证计划，作为事后比较基线。

每次任务分别记录：

- 任务类型、熟悉程度、风险等级；
- 初始判断与初始验证计划；
- 反查与对账耗时、手工修正参数次数；
- 锚点重合/文件级命中数量；
- **独立发现**：CoDelphi 提供了此前未被开发者、代码审查、测试或其他工具发现的重要事实，并注明独立证据；
- **决策促成**：事实可能已知，但 CoDelphi 促使开发者采取了原本不会采取的行动；
- **重复确认**：只是再次确认已有结论，不计为独立发现或决策促成；
- 具体决策变化及其证据；
- 净时间收益：节省时间与额外使用成本之差；
- 无效打扰率：无需行动却需要解释的 warning/提示比例；
- 错误关联造成的额外工作量；
- 不用 CoDelphi 是否大概率得到相同结果及理由。

“增加了测试”本身不等于决策改善。只有具备具体 CoDelphi 证据、发生明确决策变化，并且变化后经代码、测试或人工核实为合理，才计为改善；核实前保持 pending。若关联错误导致无关测试、扩大回归或返工，应记录为负收益，不得计入改善。

按任务类型与风险分层报告，不用 20 个任务推断普遍有效，也不把不同发现类别混为一个比例。不采集代码正文、密钥或用户隐私。不能用调用次数或对账成功次数证明价值。若试点没有独立发现、没有经验证的决策改善且净时间收益为负，应降低强制程度或停止相应流程，而不是继续增加自动化。

P0 自身的开发与对账只证明功能可用，不作为价值假设已经成立的证据。没有合适的真实试点任务时，首条样本保持 pending，不虚构试点结果。

## 10. 测试与生产验收

单元与集成测试至少覆盖：

- matched_base/matched_target/same_revision/workspace_unresolved/unavailable、零长度 Git 范围、hunk 边界、区间合并和无行号证据；
- evidenceGranularity 与 matchType 独立、同场景多证据去重、direct/fileOnly/total 计数一致性和稳定排序；
- paths/hunks 混合输入、超过 20 个规范化去重路径、非法行号和非法路径；
- observed behavior、specVerification 四种真值组合、重复核实/再次失效，以及 latestRecord 的时间与 ID 排序和产品/场景隔离；
- regressionAlerts 独立于场景分页、候选 stableKey 预过滤、原始/归一化名称、非 passed 过滤、每功能最多 5 条、完整计数和时间排序；
- candidateIntentGroups 保留命中依据、paths 仅来自实际命中证据，且不自动升级为 confirmed constraint；
- 批量查询次数、按功能限制返回、raw/canonical 零新增查询和组织/product 隔离；
- deprecated sharedEvidenceWarnings 保留结构但不进入 reasons/verdict，informationalSignals 与缺失、计划外变化和重复簇的既有语义；
- 旧工具 raw 响应、组织防枚举与现有 reconcile 输入兼容。

生产验收：

1. 用本次真实提交的双侧 hunks 和 base/target SHA 调用风险投影，确认只有同坐标锚点重合才返回 line，其他情况正确降级。
2. 确认行为、核实和历史回归均可追溯，历史提示独立于场景分页；没有人工核实记录时不会被描述为测试缺失。
3. 若 reconcile 只有共享证据，确认不再产生 warning；若存在真实异常，如实报告，不调整意图追求 pass。
4. 建立带输出前初始判断的价值试点记录；本次只填功能验证与耗时，不虚构独立发现或决策改善。

交付前运行 `npm run typecheck`、`npm test`、`npm run build`，随后完成独立代码审查、生产部署和 CoDelphi 对账。
