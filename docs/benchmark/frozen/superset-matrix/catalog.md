# BM-2 变更矩阵案例目录（Phase 1 裁剪版，2026-11-10 冻结）

> 规格依据：docs/benchmark-phase1.md §5。载体 superset；受控窗口 = queueAnalysis 显式 beforeSha/afterSha（单提交窗口），基线 = v48（@2645396b7a）。
> 时序声明：案例提交位于基线**之前**（线性历史位置：3807a4d743=16、2d2e557190=171，基线=12）——分析读取的代码树 @afterSha 早于规格基线 @2645396b7a。该时序不影响「案例文件零行为虚报」的判定（diff 仍是该单提交），但版本层 diff 会包含全量重建的无关噪音（full 模式不携带 carried），判读时与案例虚报分开计。
> 模式预测（预冻结）：两案例 diff 文件均不在 v48 索引面 → affected=0 → 保守回退 **full**（RC2 行为集无索引命中）。预测对账记入结果。

## 八类覆盖现状

| # | 类型 | 实现方式 | 状态 |
|---|---|---|---|
| 1 | 单文件局部修改 | BM-1 窗口内 L 系（transport.py 等） | ✅ BM-1 已覆盖 |
| 2 | 多文件同功能 | BM-1 窗口 #45644 guest identity（4 impl 文件） | ✅ BM-1 已覆盖 |
| 3 | 新增功能 | BM-1 窗口 athena/mcp/软删除 | ✅ BM-1 已覆盖 |
| 4 | 删除功能 | 近 300 提交无干净删除实例 | ⏸ 待真实删除 PR 触发 |
| 5 | 共享依赖修改 | BM-1 窗口 c55d723d93（sql/* 被 executor/models 多处消费）；预期=显式披露非全识别（调用图未实现） | ✅ BM-1 已覆盖（披露档） |
| 6 | 数据模型/配置 | BM-1 窗口 labeler.yml + fastmcp 依赖 bump；纯运行时翻转沿 2b 盲区披露 | ✅ BM-1 已覆盖 |
| 7 | 纯重构 | **本次案例 M7**：2d2e557190 `refactor(utils): adopt remove_duplicates() instead of inline dict.fromkeys dedup (#45767)`，7 个实现文件机械替换（dict.fromkeys → remove_duplicates，序保去重语义等价；调用点均为可哈希项） | 🏃 本次执行 ×2 |
| 8 | 纯注释/格式 | **本次案例 M8**：3807a4d743 `style(frontend): format FilterScopeSelector with oxfmt 0.75 (#46033)`，单文件 +4/−5 formatter 输出 | 🏃 本次执行 ×2 |

反面教材记录：5591d28e7b `refactor(i18n): derive dayjs locale names` **不是**纯重构——derive 改写使 `es_CO` 等未映射 locale 从「dayjs 静默失败」变「正常应用」（行为修复伪装成重构）。选型教训：refactor 前缀 ≠ 行为保持，必须逐 patch 语义核验。

## M7 预标（冻结于运行前）

- 窗口：`0fff43f9e9` → `2d2e557190`（单提交，7 文件：commands/deletion_retention/prune_audit.py、commands/tag/export.py、common/form_data_query_context.py、mcp_service/chart/{chart_utils,query_result}.py、sql/execution/executor.py、utils/slack.py）
- **预期 0 行为虚报**：任何 spec_change 引用上述 7 文件并声称新增/变更行为 = 虚报（去重替换不改变可观察行为；调用点输入均可哈希，dict.fromkeys 与 remove_duplicates 序保去重等价）
- 附带检验（证据版本）：若既有功能证据引用上述文件且行为未变，应逐字沿用
- 判读口径：full 模式重建的无关噪音（与 7 文件无关的 feature 级新增/改写）单独列示，不计入案例虚报，但如实报告

## M8 预标（冻结于运行前）

- 窗口：`1a30d454b5` → `3807a4d743`（单提交，单文件 FilterScopeSelector.tsx，formatter 重排）
- **预期 0 行为虚报**：任何 spec_change 引用 FilterScopeSelector.tsx 并声称行为变化 = 虚报（formatter 重排不改变可观察行为）
- 附带观察：patch-scan 对格式重排的判定（重排行是真实代码 token，预期计入行为集——保守方向「宁可算行为」；此时该文件走 diff 必选装配，最终判定交给提取层）
- 判读口径：同 M7（无关噪音单独列示）
