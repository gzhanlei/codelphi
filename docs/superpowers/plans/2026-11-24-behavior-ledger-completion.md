# 行为账本剩余项目完成计划

Spec: `docs/superpowers/specs/2026-11-23-behavior-ledger-correctness-golden-validation-v1.md`

## Global Constraints

- 不引入新的全量提取架构，不用模糊字符串匹配代替行为身份。
- 证据不足必须保持 Uncertain；不得把未观察到判为 Removed。
- 不覆盖 `source=manual` 的功能或场景。
- 先写失败测试，再做最小修复；每项完成前运行 `npm run typecheck`、`npm test`、`npm run build`。
- 用户已明确要求完成剩余项目，包括后续部署和生产验证。

## Task 1: Removed 正向证据

**Interfaces:** 输出确定性删除证明回执，区分 `removed`、`not_observed`、`evidence_stale`、`uncertain`，保留人工条目。

Steps:

1. 为原实现未检查、替代路径未检查、行为边界未验证和完整删除证明分别写失败测试。
2. 实现最小删除证明判定并接入现有差异计算，禁止仅凭未提取或证据失效判 Removed。
3. 用删除入口但保留其他入口的 fixture 验证场景级 Removed 与行为级 Unchanged 可并存。
4. 运行相关测试和完整验证。

Expected: 缺少任一必要条件时不得输出确定 Removed；完整证明时才允许场景退出激活。

## Task 2: 受控 Golden 验收

**Interfaces:** 复用 Task 1 的删除证明回执和现有纯重构零变化验证。

Steps:

1. 为 Added、Modified、Removed、Unchanged、重复 Run 和 superseding 建立受控 fixture。
2. 检查最终账本身份、语义、冲突、证据和生命周期，而不只检查 AI 输出。
3. 对真实纯重构 fixture 重跑 `expectNoChange`，确保 59 个场景和 70 条证据保持通过。
4. 运行完整验证并提交。

Expected: 所有必需 fixture 通过；不明确的项目保持 Uncertain，不以其他指标抵消失败。

## Task 3: 部署身份与删除修复

**Interfaces:** 包含 `47d2993`、`0be9aa5` 和 Task 1/2 的新提交。

Steps:

1. 从干净提交构建 linux/amd64 镜像。
2. 运行现有部署脚本，执行幂等迁移、切换与冒烟。
3. 验证容器健康、OAuth、MCP 基础调用与回滚状态。
4. 推送当前分支并检查对应分析 run。

Expected: 部署成功，生产不混入无关未提交文件；无回滚。

## Task 4: MCP 开发指导验收

**Interfaces:** 使用生产 release 和 Task 1 的生命周期证据。

Steps:

1. 用受控影响 fixture 验证预期受影响场景全部命中，非预期场景不扩大。
2. 验证 Removed 不被遗漏，Uncertain 不被表述为确定事实，响应保留原始证据。
3. 检查生产重复投影是否按精确规则收口，人工功能保持未决。
4. 记录可用能力边界；若不满足，继续修复而不宣称达到开发决策指导。

Expected: 知识检索可用；只有影响召回、精确率和生命周期全部通过时才允许宣称开发决策指导可靠。
