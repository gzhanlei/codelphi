# CoDelphi MCP 阶段 0：数据模型事实清单

> 核查日期：2026-11-16。阶段 0 仅执行只读查询，未修改接口或生产数据。
>
> 作用域：生产产品 `codelphi`，`product_id=9`，`organization_id=2`。未经过该产品过滤的计数不得用于其 releaseHealth。

## 1. 生产版本与迁移现状

- 最新规格版本：`spec_version_id=232`。
- 最新成功分析：`analysis_run_id=333`，`after_sha=5cb7c97851d6e832a3c2c7032c46ce86bdd0bcda`，状态 `succeeded`。
- 上一分析：`analysis_run_id=332`，`after_sha=291c5e10f47e7e2c2259dbc93d5db6652e49734e`，状态 `succeeded`。
- `schema_migrations` 最新成功记录：`075_release_change_projection_backups.sql`，应用时间 `2026-11-15T19:13:17.832Z`。
- migration 076 尚不存在，可使用，但实施前必须再次检查生产序列。
- `release_change_projection_backups` 当前有 167 份备份。

## 2. Feature / Scenario / Spec Change 身份与作用域

| 概念 | 实际 schema | 可证明的范围 | 不得推断 |
|---|---|---|---|
| `spec_features.id` | 自增主键 | 一行规格功能记录的身份 | 不是跨版本产品行为身份 |
| `stable_key` | `VARCHAR(191)`；`(spec_version_id, stable_key)` 唯一 | 名称归一化键，仅在单个规格版本内唯一 | 不是独立行为 UUID，不能跨版本证明同一行为 |
| `spec_scenarios.id` | 自增主键 | 一行规格场景记录的身份 | 不是跨版本场景身份 |
| `reference` | `(spec_feature_id, reference)` 唯一 | 仅在所属规格功能内标识引用；合并时可重编号 | 不能与 stableKey 拼成永久场景身份 |
| `spec_changes.id` | 自增主键 | 一条规格变化记录的身份 | 不表示投影文案或场景行为本身 |
| `spec_changes` 唯一键 | `(spec_version_id, entity_type, feature_key, scenario_reference)` | 版本内变化记录去重约束 | 不提供跨版本语义等价证明 |
| `feature_aliases` | `(product_id, alias_key)` 唯一；无 active 字段 | 明确维护的产品内名称映射 | 不是行为身份凭证，也不自动表示重复 |
| `changes.id` | 自增主键 | 一条用户展示变化记录 | 不代表底层 spec_change |
| `change_sources` | `(change_id, spec_change_id)` 主键；`spec_change_id` 唯一 | 一个 spec_change 最多进入一条展示投影 | 不是 scenario 关联，不支持多对多场景语义 |

补充：`specFeatureKey` 当前实现为功能名 trim/lowercase/空白归一。任何由该函数或 feature_aliases 得到的键只能是 `exact_name/name_only`，不能升级为 `identity_proven`。

## 3. Release / Change / Source / File 关联

- `releases`：`repository_id + sha` 唯一；`spec_version_id` 唯一；`analysis_run_id` 可空并指向 analysis_runs。
- `spec_versions`：`analysis_run_id` 唯一，因此一次 run 至多一个规格版本。
- `changes.release_id` 指向 releases；`change_sources.change_id` 指向 changes；`change_sources.spec_change_id` 指向 spec_changes。
- 有效来源关联必须同时满足：
  1. `change_sources.change_id = changes.id`；
  2. `change_sources.spec_change_id = spec_changes.id`；
  3. `changes.release_id = releases.id`；
  4. `releases.spec_version_id = spec_changes.spec_version_id`。
- `release_files`：`(release_id, path)` 唯一，含 `behavioral_change`。该路径只表示提交文件范围，不是产品行为身份，也不是场景回归覆盖。

生产关联核查：有效关联孤立数为 0。其他产品存在 20 个 legacy release，证明 releaseHealth 必须按产品过滤。

## 4. Evidence Path 三种真实结构

已用生产 `spec_changes.before_json/after_json` 验证：

1. feature：`after.scenarios[].evidence[].path`。样本：`spec_change_id=14852`，路径 `app/api/products/[slug]/releases/[id]/reviewed/route.ts`。
2. 独立 scenario：`after.evidence[].path`。样本：`spec_change_id=14860`，路径 `deploy.sh`；`spec_change_id=14857` 同时含 `deploy.sh`、`docker-compose.prod.yml`。
3. release_files：样本 release #229 包含 `lib/release-change-projection.ts`、`lib/spec-diff.ts` 等；文档/测试路径可带 `behavioral_change=0`。

实现约束：提取函数必须分别返回 `beforePaths`、`afterPaths` 和 `releaseFilePaths`，并保留来源类型。现有 `evidencePathsFromSubject` 只覆盖第 1 种，必须补齐第 2 种才能支持 intent path 匹配。

## 5. Feedback / Corrective Run / Verification

### 5.1 当前真实关系

- `feedback_reports.corrective_run_id` 可空，指向 analysis_runs，但没有独立 resolution/verified 字段。
- `spec_verifications` 含 `entity_type/entity_id/spec_version_id/commit_sha/verified_by/verified_at`。
- `spec_verifications` 不含 `feedback_id` 或 `corrective_run_id`，无法建立 feedback → verification 的归属链。
- `feedback_reports` 当前没有 `regression_stable_key`。

### 5.2 feedback #14 生产事实

- `kind=bug`，`status=new`，`verdict=needs_human`。
- `correctiveRunId=null`，`githubIssueUrl=null`。
- 裁决理由明确要求人工按功能粒度口径裁决。
- 因没有 corrective run，不能给 `correctiveAnalysis.sha/status` 编造值。
- 因没有 feedback → verification 关联，`verification.status` 必须为 `unavailable`。

### 5.3 冻结语义

- corrective analysis succeeded 只表示纠正性分析完成，不表示缺陷已修复。
- 不使用 `resolvedBySha` 暗示修复正确；使用 `correctiveAnalysis.sha/status`。
- 只有存在明确 feedback 到验证记录的关联时，才允许 `verification.status=verified`。
- `regression_stable_key` 只是名称级 primary regression anchor，不代表完整回归范围，也不触发自动验证。

## 6. Analysis Run / SHA / Release 持久化

- `after_sha` 是本次分析目标提交；`before_sha` 是上一个基准提交，可空。
- 同一 SHA 的 queued/running run 由 `(repository_id, after_sha, active_slot)` 保证至多一个活跃任务；历史终态 run 可重复。
- 同一 SHA 重试必须按 `created_at, id` 取最新尝试，不能用旧 run 的成功覆盖新 run 的失败或运行中状态。
- `spec_versions.analysis_run_id` 唯一；run 成功、规格版本和 release 的持久化处于同一事务，只有 run succeeded 且对应 release 已可读时，`wait_for_release` 才能返回 completed。
- 当前最新 run #333 证明：成功后 `after_sha=5cb7c97` 对应 release 可读，before_sha 为 291c5e1。

## 7. releaseHealth 可计算性与统计范围

### 7.1 冻结统计范围

- eligible release：产品内 `spec_version_id IS NOT NULL` 且至少存在一条 `spec_changes`。
- eligible change：属于 eligible release 的 `changes`；历史 `kind=reviewed` 排除。
- valid link：同时满足第 3 节四个 join 条件。
- linked release：eligible release 中至少有一条 valid link。
- legacy release：eligible release 中完全不存在 valid link。
- orphan link：缺少 change、release/spec_version 或 spec_change 的关联，单独计数，不能静默忽略。

### 7.2 当前 codelphi 生产计数

| 指标 | 当前值 | 说明 |
|---|---:|---|
| eligibleReleaseCount | 167 | 产品 9，含最新 release |
| linkedReleaseCount | 167 | 均有有效来源关联 |
| legacyReleaseCount | 0 | dry-run=0 与此口径一致 |
| eligibleChangeCount | 2239 | 只统计 eligible release，排除 reviewed |
| sourceLinkedChangeCount | 2239 | `sourceLinkedRatio=1` |
| sourceLinkCount | 13699 | 一个展示变化可合并多个 spec_changes |
| orphanLinkCount | 0 | 无失效关联 |
| backupCount | 167 | 可恢复备份 |

全库未按产品过滤时会出现 20 个其他产品 legacy release；禁止把该值用于 codelphi。

另一个口径陷阱：若把零事实旧 release 的 21 条旧 AI 文案计入分母，会得到 2239/2260 而不是 100%。因此 eligible change 必须限定 eligible release，不能让零事实遗留文案稀释健康比例。

### 7.3 不可计算指标

- `duplicateFeatureClusterCount`：当前没有可靠的跨版本功能身份和语义重复算法，应返回 `null`，不能返回 0。
- `duplicateScenarioClusterCount`：只能报告规格内可证明的重复记录；跨版本稳定场景身份不存在，应返回 `null` 或带作用域的有限结果。
- `lastAppliedMigration` 仅表示 runner 最后一条成功记录，不表示整个部署或迁移失败历史。

## 8. 当前不支持的判断能力清单

以下不得通过读取层补造：

- 跨版本稳定 feature 行为身份或 scenario 身份。
- 两个异名功能在业务语义上等价。
- 两个场景共享 evidence path 就属于重复。
- 文件路径覆盖等于场景回归覆盖。
- corrective run 成功等于代码缺陷已修复。
- 任意 spec_verifications 记录等于某条 feedback 的复验。
- `verifiedAt` 等于整个团队确认。
- 缺失来源关联的历史投影等于已经完成 persisted source linkage。
- 未命中搜索等于功能不存在，未发现问题等于已证明无问题。

## 9. 阶段 0 结论与冻结门禁

阶段 0 已完成：实际表/索引/外键、身份作用域、关联链、三种证据结构、feedback 真实状态、analysis run/SHA 语义、releaseHealth 可计算性和生产迁移现状均已核实。

进入实现前，设计必须保持以下硬约束：

- stableKey 永远标记为名称级匹配，不升级为行为身份。
- scenarioIdentity 无法证明时为 null/unresolved。
- feedback verification 无显式关联时为 unavailable。
- correctiveAnalysis 与 verification 完全分离。
- sourceCoverage 只披露，不作为一票否决；run status、persistence、SHA consistency、extraction/evidence/merge integrity 才构成执行与验收门禁。
- ratio 返回分子、分母、排除项和异常数；null 不默认成 0 或 false。
- `pass` 只覆盖本次提供的预期与可读取证据范围，不表示整个 release 的所有行为均正确。
- Canonical 只合并已证明身份相同的重复投影，原始 ID 与全部来源必须保留。
- 原始 MCP 响应保持兼容；分页响应沿用 `{ release, changes }` 字段名。
