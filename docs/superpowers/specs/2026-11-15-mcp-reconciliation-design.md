# CoDelphi MCP 验收门禁与规范读取投影设计

## 目标与成功标准

把 CoDelphi MCP 从“返回大量规格文本”升级为可回答以下问题的开发验收面：

1. 本次 release 是否覆盖提交意图，是否存在计划外变化？
2. 哪些功能/场景可能是同一行为的异名重复，需要复核？
3. 历史发布是否都已转为来源关联投影，是否存在 legacy 数据？
4. 某条反馈是否已裁决、由哪个 SHA 修复、是否完成复验？
5. 调用方能否得到小而确定的风险清单，并在异步发布完成时可靠等待？

成功标准：

- `reconcile_release` 能直接返回 `missingExpected`、`unexpected`、`duplicateClusters` 和可解释的 verdict，不需要 agent 阅读全量变化文本。
- 所有匹配、健康统计和重复簇均使用稳定身份、数据库关联和证据路径，不新增 LLM 语义判定。
- 原始 MCP 响应保持向后兼容；新投影通过可选参数启用，长结果可分页。
- 使用真实 release #229/#230/#231 做生产验收，反馈 #14 可读取完整处置状态。

## 约束与非目标

- MCP 继续保持只读，唯一写操作仍是 `send_feedback`；健康检查、重建和裁决执行不通过 MCP 写数据库。
- 不用 Jaccard、编辑距离或新增模型调用来决定两条行为是否等价。
- 重复簇是复核信号，不自动删除、合并或改判功能身份。
- 默认原始响应不改变既有调用方；`get_release` 默认保持全量，只有显式传 `limit` 时分页。
- 保持组织级防枚举：不存在或越权的产品、发布、反馈均返回空对象。
- 不把部署、迁移和历史数据修复操作搬到 MCP 写接口。

## 方案比较

### 方案 A：确定性身份与验收投影（采纳）

以 `spec_changes`、`change_sources`、`release_files`、`feature_aliases` 和 evidence path 为身份与关联依据，在读取层生成验收结果。优点是确定、可测试、零模型成本，与 BM-12 架构一致。缺点是只能发现“可证明的异常”，不能把每个异名功能都自动判为重复，因此重复簇只降级为复核 warning。

### 方案 B：新增 AI 对账判官

让模型阅读提交意图和 release 后判断完整性与重复性。覆盖更宽，但会重现“先产生自由文本再猜等价”的不稳定性，且需要成本、超时与额外证据校验。此方案不采纳；AI 仍只负责文案，不负责行为身份。

### 方案 C：另建一套验收数据库

把每次 release 归一化为独立验收记录。查询简单，但会与 `spec_changes` 形成第二个事实源，引入回填和一致性问题。此方案不采纳。

## 组件设计

### 1. `reconcile_release`

输入：

```ts
{
  slug: string;
  releaseId: number;
  expectedIntents?: Array<{
    stableKey?: string;
    paths?: string[];
    note?: string;
  }>;
}
```

规则：

- intent 提供 `stableKey` 时，匹配变化的 `featureName` 归一化键。
- intent 提供 `paths` 时，匹配变化 before/after JSON 中的 evidence path，或该 release 的 `release_files.path`。
- 未匹配 intent 进入 `missingExpected`；未被任何 intent 匹配的变化进入 `unexpected`。
- `duplicateClusters` 只包含可证明的异常：同一 stableKey 的重复场景、同一 evidence path 下多个异名功能且存在共享证据或别名关系、以及同一 `spec_change_id` 被多条投影消费。
- `verdict`：有 missing/unexpected → `failed`；仅重复簇或 legacy 健康问题 → `warning`；全部匹配且无异常 → `pass`；未提供 expectedIntents → `review`。
- 每项返回 `stableKey`、证据路径、原因和变化 ID，避免返回整段 before/after。

### 2. Canonical 与风险读取投影

`get_release`、`get_feature`、`lookup_by_files` 新增可选 `view`：

- `raw`（默认）：保持现状。
- `canonical`：按 stableKey + reference 合并完全相同的场景行，保留别名与真实 `rawCount/canonicalCount`；`feature_aliases` 只用于明确别名归并，不推断异名功能。
- `lookup_by_files?view=risk`：返回前 10 条红线、共享邻域、覆盖/未覆盖路径、snapshot SHA、raw/canonical 场景数和风险原因；完整结果仍可分页获取。

`get_release` 新增 `offset/limit/hasMore/total`，默认保持全量；显式 `limit` 最大 100，防止无意拉取超大响应。

### 3. `get_feedback`

按组织与 feedback id 返回：

- kind、verdict、verdictReason、adjudicatedAt、status、githubIssueUrl；
- correctiveRunId、correctiveRunStatus、resolvedBySha（修复 run 成功时的 after_sha）；
- regressionStableKey（migration 076，可选）与 verifiedAt（复验 release 时间）。

`send_feedback` 接受可选 `regressionStableKey`，用于后续验收检索，不改变既有消息格式与裁决流程。

### 4. 健康指标

扩展 `get_project_summary` 的 `releaseHealth`：

- `sourceLinkedRatio`：带至少一条 `change_sources` 的 changes 行占比；
- `canonicalProjectionRatio`：带至少一条来源关联的 release 占比；
- `legacyReleaseCount`：有 spec_changes 事实但完全无来源关联的 release 数；
- `duplicateFeatureCount`、`duplicateScenarioCount`：确定性重复键与重复簇计数；
- `lastMigrationStatus`：`schema_migrations` 最新名称与时间；
- `lastAnalysisStatus`：最新 analysis_run 的 id/status/after_sha/error_message。

无历史数据时返回 null 或 0，不虚构健康分。

### 5. `wait_for_release`

输入 `slug`、`sha`、可选 `timeoutSeconds <= 60`、`pollSeconds <= 5`。

- 查询 releases 与最新 analysis run；完成即返回 releaseId、status 和 sha。
- 分析 run 失败立即返回 `failed` 与错误摘要。
- 超时返回 `timeout`，不是 `failed`。
- 保持 MCP JSON-RPC 单请求模型，不引入 WebSocket/SSE。

### 6. 客户端与运维验证

- `tools/list`、JSON schema、组织防枚举、分页和原始响应兼容均有单元测试。
- `reconcile_release` 使用 release #229 的三条用户影响变体、release #230 的后续事项、release #231 的迁移失败场景构造 fixture。
- 生产部署后，以 `reconcile_release` 验收最新 SHA，以 `get_feedback(14)` 验证反馈闭环，以 `get_project_summary.releaseHealth` 验证 166 个历史 release 的来源关联状态。

## 数据迁移

`076_feedback_regression_keys.sql`：

- `feedback_reports ADD COLUMN regression_stable_key VARCHAR(191) NULL`；
- 增加 `(organization_id, regression_stable_key)` 索引，支持按组织与回归锚检索。

只新增可空列与索引，不回填、不改旧数据。

## 错误处理与性能

- 参数错误继续映射 `INVALID_PARAMS`；未知工具保持 `METHOD_NOT_FOUND`。
- 健康统计采用聚合 SQL 和有界查询；重复簇仅检查当前 release 或当前产品必要集合，不读取 before/after 全文到 MCP 响应。
- `wait_for_release` 总等待时间硬上限 60 秒，数据库查询间隔硬上限 5 秒。
- 大型响应必须显式分页，默认行为不变，避免破坏旧客户端。

## 实施顺序

1. 确定性 reconcile 与 canonical/risk 纯函数及 MCP 接线。
2. 反馈读取、健康指标、等待接口与 migration 076。
3. 全量测试、独立审查、生产部署。
4. 真实 release/feedback/health 对账，并记录任何剩余“只能提示、不能证明”的边界。

---

## 修订：v2 + 10 项冻结条件与阶段 0 结论

采纳 v2 的详细契约，并增加以下不可放宽的实施约束：

1. stableKey 只表示名称级匹配；direct identity 仅限真实数据库实体及其明确作用域。
2. Scenario 没有跨版本稳定身份；无法证明时保留原始记录并返回 null/unresolved。
3. 没有 feedback 到 verification 的显式关联时，验证状态只能为 unavailable。
4. correctiveAnalysis 与 verification 完全分离，不使用 resolvedBySha 暗示代码已修复。
5. Run status、persistence、SHA consistency、extraction/evidence/merge integrity 与 sourceCoverage 分开；sourceCoverage 仅披露。
6. Evidence path 必须覆盖 feature 嵌套、独立 scenario、release_files 三种结构，并保留 before/after/release_file 来源。
7. releaseHealth 必须限定 eligible release/change、返回分子分母与异常数；不可计算指标为 null。
8. 分页继续使用 `{ release, changes }`，不得改成 items。
9. 所有身份结论必须声明组织、产品、规格版本或 release 作用域。
10. `pass` 仅表示当前预期与可读取证据范围内未发现契约异常，不表示整个 release 的全部行为均正确。

阶段 0 已完成，实际 schema、生产数据、证据样本和可计算性记录见 `2026-11-16-mcp-phase0-data-model.md`。后续实现不得以本设计中的抽象名称替代该事实清单。

### 阶段 0 对接口结构的最终修订

- Intent 的 stableKey 只允许 `exact_name/name_only`；path-only intent 不能单独支持 pass。
- `get_feedback` 使用 `correctiveAnalysis: { sha, status }`，不使用 `resolvedBySha`。
- `verification.status` 没有显式反馈关联时固定为 `unavailable`。
- `analysis.status` 由 run、persistence、SHA 和 extraction/evidence/merge integrity 决定；overall/sourceCoverage 仅披露。
- `sourceLinkedRatio` 的分母只含 eligible release 中的 eligible change，孤立关联单独计数。
- `duplicateFeatureClusterCount` 与跨版本 `duplicateScenarioClusterCount` 没有可靠算法时为 null。
- `wait_for_release` 精确匹配 after_sha，按 created_at,id 选择最新尝试；只有 run succeeded 且同 SHA release 已持久化才 completed。

### 审查修复补充

- `duplicateClusters` 只覆盖数据库约束之外的异常记录（重复 change id 或版本内重复 scenario identity），不是常规语义重复检测；生产正常数据可以为空。
- `unexpected` 同时返回 `beforePaths`、`afterPaths` 和 `releaseFilePaths`，保留证据来源。
- stableKey + paths 的匹配必须同时落在同一变化记录上；release_files 只作为 path-only intent 的范围证据，不能替其他功能补足证据。
- `analysis.status` 还要求 `run.after_sha === release.sha`，`legacySourceIssueCount` 使用 release 内失效关联计数。
- `lookup_by_files?view=risk` 不使用 raw 的每功能 10 条截断，跨 path 同场景去重后计算总数和 canonical 数。
