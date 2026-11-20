# 行为清单全量分析 · 独立审查修复最终报告

日期：2026-11-20 · 分支：`behavior-inventory-full-analysis`（worktree） · 范围：1 Critical + 5 Important + 8 Minor + related-reference 风险，共 15 项。

审查发现来自 2026-11-19 的行为清单全量分析独立审查。本报告逐项记录：发现 → 修复 → 测试证据 → 遗留限制。修复按簇执行（预算层 → 清单构建 → 提取层 → 编排接线），每项遵循 TDD（先红后绿），全部改动限于 `lib/` 与 `tests/`，无 schema 变更、无新依赖。

## Critical

### N — BIGINT 无上限哨兵在 JS 侧被误读（钱/阻断）

- **发现**：`analysis_run_budgets.max_total_tokens` 是 BIGINT UNSIGNED，无上限哨兵 `18446744073709551615` 超出 JS 安全整数；mysql2 默认读回为舍入值 `18446744073709552000`，JS 侧字符串/数值比较把「无上限」误判为「已配置上限」→ 一切 usage unknown 的结算都抛 `behavior_budget_usage_unknown`，派发被永久阻断（含一切恢复）。
- **修复**（`lib/behavior-run-budget.ts`）：哨兵判等全部下沉到 SQL 侧——`loadBudgetConfig` 改发 `SELECT (max_llm_calls = ?) AS calls_uncapped, (max_total_tokens = CONVERT(?, UNSIGNED)) AS tokens_uncapped, (max_cost_amount = CONVERT(?, DECIMAL(12,6))) AS cost_uncapped ...`，`applyLedgerReservation` 的 UPDATE 谓词同样用 `CONVERT(?, UNSIGNED)` / `CONVERT(?, DECIMAL(12,6))` 做数据库侧判等；JS 侧旧读回比较整体删除。（用 `CONVERT(expr, type)` 逗号语法而非 `CAST(? AS type)`：`AS + UNSIGNED/DECIMAL` 会撞仓库的 SQL 保留字护栏 `tests/sql-alias-reserved-words.test.ts`，语义等价。）
- **测试**：`tests/behavior-run-budget.test.ts` 假驱动对旧裸 SELECT 路由返回舍入值（复现驱动行为），新探针 SQL 在库侧判等；无上限配置下 usage-unknown 结算按预留上界保守入账、不再误阻断。35/35 绿。

## Important

### A — 跨单元主区间重叠（完整性）

- **发现**：注册草稿与 public_api 草稿可同时认领同一 handler 区间，同一行被两个单元双计（结算与覆盖核销失真）。
- **修复**（`lib/behavior-inventory/detectors/generic.ts`、`lib/behavior-inventory/index.ts`）：注册草稿优先，与注册 handler 区间相交的 public_api 草稿丢弃；同 handler 重复注册收缩到注册语句行（`shrinkDraftToRegistrationLine`，只留 entry 锚点）；新增结构不变量 `assertPrimaryRangesDisjoint`——同 path 主区间两两不相交，违例显式 throw。
- **测试**：`tests/behavior-inventory.test.ts` 重叠夹具钉死丢弃/收缩/不变量 throw 三方向。60/60 绿（清单构建簇四文件合计）。

### B — 摘要预留已结算状态被吞（钱）

- **发现**：恢复路径 `reserveProductSummaryBudget` 幂等读可能返回已 settled 的预留，编排层不感知状态仍调 `resolveProductDescription` 重新生成——第二次摘要 LLM 调用的 usage 挂在已结算预留上，settle 为 no-op，费用永不入账。
- **修复**：
  - 预算层（`lib/behavior-run-budget.ts`）：`ProductSummaryReservation = BudgetReservation & { status: ReservationStatus }`；幂等读改 `ORDER BY id DESC LIMIT 1` 取唯一权威行并解析真实 status。
  - 编排（`lib/full-analysis.ts`）：`status !== "reserved"` 时跳过生成、不重复 settle、不 release；按 D10 降级（旧简介语言一致 → `preserved`，否则 → `unavailable`）。`settled_unknown` 额外等价 usage 未知硬阻断（停止派发 + 门禁 fail closed）。
- **测试**：`tests/full-analysis.test.ts` 三个恢复场景（settled→preserved / settled 无旧简介→unavailable / settled_unknown→门禁失败），断言摘要 LLM 零调用、零重复 settle、零 release。

### C — 恢复不校验范围指纹（正确性）

- **发现**：`loadVerifiedManifest` 只校验 hash 与版本；实现面在两次尝试之间漂移（新提交推送）时，恢复会用过期 manifest 继续派发。
- **修复**：`computeScopeFingerprint(paths, scopeRoots)`（`lib/behavior-inventory/index.ts`，首跑/恢复共用同一实现）；恢复分支按目录枚举（元数据级，不读文件内容）重算指纹，与持久化值不等即抛 `inventory_version_conflict`（绝不静默重扫自愈）。0 字节文件与扫描期 0 行排除口径对齐。
- **测试**：恢复前向假仓注入新文件 → 恢复拒跑（不派发、不提取、不对账）；指纹一致的正常恢复不受影响。

### D — 检测器诊断不落库（观测）

- **发现**：detector 失败面（unsupported/parse failure/dynamic fallback）只活在内存返回值，恢复与事后审计不可见。
- **修复**：`BehaviorInventoryDiagnostics`（9 字段：原 7 + `unreadablePaths` + `eligibleRanges`）随 manifest 持久化（`BehaviorManifest.diagnostics?`，schema v2，`normalizeManifest` 物化缺省、数组码点序、区间规范化，hash 覆盖）；`InventoryEnumerationSummary` 新增 `detectorUnsupportedPaths / detectorParseFailurePaths / dynamicRegistrationFallbackPaths / unreadablePaths` 四个披露字段，编排从 `manifest.diagnostics` 填（恢复同口径，无需重扫）。
- **测试**：manifest 规范化/hash 钉死（`tests/behavior-inventory-manifest.test.ts`）；首跑枚举摘要断言四字段；`tests/completeness-ledger.test.ts` 夹具同步。

### E — 崩溃孤儿预留永久泄漏预算（钱/恢复）

- **发现**：进程崩溃留下 `status='reserved'` 的任务预留，永不结算，聚合计数永久泄漏——恢复重跑后预算被影子占用耗尽。
- **修复**：
  - 预算层：`reconcileOrphanedTaskReservations({ runId, orphanBeforeMs })` 扫描 `kind='task' AND status='reserved' AND created_at <= 截止线`；有回执 → 正常结算（usage unknown 在配置硬上限下不中断对账，置 `usageUnknownBlocked`）；零回执 → 释放。摘要份额（kind=product_summary）不在此列（由 summary_reserved 标志位 + D10 路径管理）。
  - 编排：恢复入口在派发前对账（截止线=恢复启动时刻，排除本进程在途 attempt）；`usageUnknownBlocked` → stopDispatch + budgetBlocked，门禁 fail closed。首跑无孤儿，跳过。
- **测试**：对账顺序（先于一切新预留）、usageUnknownBlocked 时可领取任务走 abort 排水恢复 pending、绝不发起 LLM 调用。

## Minor

### F — 执行期间无租约续约（恢复）

- **发现**：长任务（复述+判定+复核可达数分钟）超过租约时长后被并发恢复重领，本 attempt 提交被拒且出现双写窗口。
- **修复**（`lib/full-analysis.ts`）：执行窗口内置心跳（周期 `leaseDurationMs/3`，`renewBehaviorTaskLease` 以 `{runId, taskKey, attemptId, leaseOwner}` 续约）；续约失败（租约丢失）视为硬失败——记 failed、settle、按预算重试，该 attempt 绝不提交。
- **测试**：短租约（30ms）+ 慢提取（80ms）下断言续约实际发生；注入一次续约失败 → 该 attempt 走硬失败路径（`last_error` 含 lease 错误）、commit 次数等于任务数（丢失 attempt 从未提交）、重试后激活成功。

### G — 合并检查门禁硬编码 true（正确性）

- **修复**：`existingMergeChecksPassed` 由 `merged.stats.changesTruncated === 0` 派生。截断（>150 条 reviewed 审计候选被裁）意味着合并面静默丢条目，必须 fail closed；`scenariosDeduped / featuresFolded` 是正常确定性合并（originKeys 求并集），不计异常。
- **遗留限制**：inventory 编排的 chunk 恒为 `changes: []`，该计数当前结构性为 0——接线是防御性的（旧分区路径复用同合并层时生效）。源码钉死测试防回退。

### H — 纯空行源文件冒充可读（正确性）

- **修复**：`assertSourcesReadable` 增加纯空行拒绝（`content.split("\n").every(line => line.trim() === "")` → unreadable 硬失败）。
- **测试**：三行纯空白文件 → 任务记 failed（错误含 unreadable）、门禁 fail closed。

### I — 未决 fragment 无复核通道（正确性/激活率）

- **发现**：一趟判定未决即终态 unresolved，只能等下一 run 全量重试（复述+判定双调用），代价高且恢复语义粗糙。
- **修复**（`lib/behavior-unit-extraction.ts` + 编排接线）：
  - 提取层：`ExtractBehaviorTaskInput.repair: { previous }`；`repairBehaviorTask` 筛未决 fragment 构造缩减任务 → 单次判定调用（descriptions 为空、callStage=`semantic_repair`）→ `renumberRepairRefs` 按前缀最小未占用号重排复核趟场景引用（同步改 receipts.scenarioRefs）→ `mergeRepairResult` 按 anchorFragmentKey 替换未决回执、合并 features、按与 `deriveTaskResult` 相同规则重推终态（D5 不削弱）。无未决 → 原样返回不发调用；截断 → 未决保持未决。
  - 编排：首趟 `unresolved` 且仍有未决回执（归因洞除外）且有重试预算且未 stopDispatch 时，同 attempt 内复核一次，最终（可能被升级的）结果一次提交。
- **偏差说明**：冻结方案字面为「提交后二次提交」，但条件提交谓词要求 `status='running'`——首次提交后状态已非 running，二次提交必然被拒。实现改为**同 attempt 内复核后单次提交**，语义等价（任务行承载复核后终态）且不破坏租约/提交不变量。
- **预算说明**：repair 是同一预留上的第 3 次 LLM 调用（预留 2 次覆盖首趟 describe+judge）；settle 按实际回执入账、超预留不截断、仅受 run 上限约束——语义合法，注释已写明。
- **测试**：复核把 unresolved 升级为 no_behavior（同 attempt：claim/commit/settle 各一次）；归因洞（无未决回执的 unresolved）不触发复核。

### J — 声明区间吞掉前置空行（表达）

- **修复**：generic.ts（`EXPORT_DECLARATION`、`resolveNamedHandler`）与 next.ts（`HTTP_METHOD`、`DEFAULT_EXPORT`）的行首 `^\s*` 全部改 `^[^\S\n]*`——`\s` 含 `\n`，多行模式下会吞掉声明前的空行，区间起点上漂。

### K — 主覆盖判定是恒真式（正确性）

- **发现**：`eligibleRanges` 从单元主区间并集反推——「单元认领即覆盖」恒真，覆盖门禁形同虚设。
- **修复**：构建期由实现面枚举独立计算 `eligibleRanges` 并随 manifest 持久化（见 D）；编排覆盖判定改读 `manifest.diagnostics.eligibleRanges`（恢复与首跑同口径的独立真源）。
- **测试**：把持久化 eligibleRanges 改大到超出任何单元主区间 → 恢复后门禁按 `primaryCoverageComplete` 失败（旧口径必然通过）。

### L — 整文件不可读占位不可达（正确性）

- **修复**：`InventorySource` 增加 `unreadable?: boolean`；构建期分区 readable/unreadable——unreadable 生成零区间占位单元（kind=file、primaryRanges=null、单个零区间 coarse implicit_review 锚点、detector=residual），不进残余清单与 eligibleRanges（但进指纹路径集），占位期间主覆盖门禁 fail closed 直到文件可读。

### M — contextRanges 恒空（披露）

- **处置**：影子阶段无调用图分析，`contextRanges` 恒为空数组。按方案只做披露 + 钉死：类型注释（types.ts）与加载侧注释（planner.ts）显式说明限制（绝不把整份共享依赖文件塞进上下文顶替）；不变量测试 pin 恒空。后续引入调用图时按最小依赖区间填充。

## related-reference 激活风险

- **发现**：`covered_elsewhere` 的 `relatedUnitKeys` 由模型自由填写，幽灵 key（幻觉/跨 run 漂移）可能让锚点关联挂到不存在或不相关的单元上。
- **修复**：
  - prompt 侧（`lib/behavior-unit-ai.ts`）：`judgeBehaviorTaskPrompt` 新增 `knownUnitKeys` 目录段（中英双语）——`relatedUnitKeys` 只能逐字取自有效单元清单，否则按 unresolved 处理；空目录时指示留空并用 `relatedScenarioRefs`。
  - 派发侧（`lib/full-analysis.ts`）：每次提取调用传 `knownUnitKeys`（manifest 单元 key 列表，截断 150）。
  - 门禁侧：`buildGateAnchors` 过滤幽灵 key（只保留 manifest 单元集合内的 key）。
- **说明**：门禁侧过滤是纵深防御——`survivingUnitKeys ⊆ manifest 单元集` 已使幽灵 key 无法通过门禁；过滤保证门禁锚点载荷本身不携带幻觉关联。行为测试钉死 prompt 目录下发；门禁过滤以源码 pin 钉住（与既有 Task 12 委托 pin 同模式）。

## 验证

- `npm run typecheck`：绿（tsc --noEmit 无输出）。
- 受影响测试文件（隔离运行全绿）：`tests/behavior-run-budget.test.ts` 35/35；清单构建簇（behavior-inventory{,.test,-manifest.test,-planner.test}）60/60；`tests/behavior-unit-extraction.test.ts` 25/25；`tests/full-analysis.test.ts` 44/44；`tests/completeness-ledger.test.ts` 22/22。
- `npm test`（scripts/test-all.mjs 分片全量）：283 文件 / 12 分片 / 24s；4 个文件分片内 mock 碰撞、隔离重跑全绿（behavior-run-budget、feedback-auto-record、billing-cost-receipt、explainer-cache——既有现象）；1 个 real failure：`tests/snapshot-skill.test.ts`，已定性为**环境性失败、与本轮修复无关**（详见下条）。
- `tests/snapshot-skill.test.ts` 定性：该测试子进程执行 `node node_modules/tsx/dist/cli.mjs scripts/build-snapshot-skill.ts`；`test-all.mjs` 把 TMPDIR 钉在项目内 `node_modules/.vitest-tmp`，而本 worktree 路径极深，tsx 启动时创建的 IPC unix socket 路径长达 127 字符，超过 macOS `sun_path` 104 字符上限 → tsx 在加载任何项目代码之前即 `listen EINVAL` 崩溃（用 `tsx -e "console.log(1)"` 空载复现，同样失败；默认 TMPDIR 下同命令正常）。因此它与代码内容无关——本修复波次的任何文件都不影响 tsx 的启动；主仓库路径下 socket 仅约 84 字符，`npm test` 不受影响。单独运行（默认 TMPDIR）该文件 4/4 绿。不修（属测试基建在深路径下的限制，且脚本注释说明 TMPDIR 内钉是为规避另一沙箱问题，不宜为本 worktree 改共享基建）。
- `npm run build`：绿（Next.js 构建完成，路由表正常输出，无错误）。
- 已知隔离事项：`full-analysis.test.ts` 与 `behavior-run-budget.test.ts` 在同一 vmThreads 分片内共享模块图时 mock 工厂碰撞（full-analysis mock 了 budget 模块）——既有现象，`test-all.mjs` 对分片内失败文件自动隔离重跑，隔离后全绿。

## 遗留限制（明示）

1. **M**：`contextRanges` 恒空只是披露；真正的最小依赖区间需要调用图分析，后续版本引入。
2. **I**：复核只覆盖「有未决回执」的 unresolved；归因洞（存活场景无 extracted 归属但回执全已决）不触发复核，仍按 unresolved 交下一 run。
3. **G**：`changesTruncated` 在 inventory 管道结构性为 0，门禁接线为防御性。
4. **C**：指纹校验先于孤儿对账——范围已漂移的 run 直接失败，其孤儿预留留待下一次有效恢复对了断（失败面优先于写路径）。
5. **related-ref**：门禁侧幽灵 key 过滤当前与 surviving 检查等价（纵深防御），prompt 目录是主要防线。
6. 遥测：repair 调用经 callStage=`semantic_repair` 入账于 LLM 回执；`InventoryEnumerationSummary` 无 callStage 分布字段，未新增。
