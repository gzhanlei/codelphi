# 架构事实与语义覆盖诊断

`lib/architecture/` 是通用架构引擎的领域层，当前先用于 stack corpus 的影子诊断，不参与生产架构验收。

## 数据边界

- `facts.ts`：固定 revision 的节点、关系、合法入口和代码证据。节点/关系 ID 必须唯一，引用不能悬空。
- `signals.ts`：独立于最终图的入口、部署单元、异步任务、存储和外部依赖信号。信号是否被覆盖不能由最终图自身决定。
- `coverage.ts`：比较信号与事实，检查关键信号遗漏、无证据节点/关系，以及从用户、Webhook、Scheduler 等多个根节点出发的有向可达性。
- `shadow.ts`：旧架构文档的临时诊断适配器，不是新架构生成器。

## Corpus 影子报告

`scripts/stack-corpus.ts` 的每个仓库结果增加 `architectureShadow`：

- `status: completed`：旧文档已转换为临时事实并完成覆盖诊断。
- `status: unavailable`：规划或文档生成不可用，不能推断架构质量。
- `scope: source-slice`：信号仅来自当前 AI 切片，不代表全仓库覆盖，`publishable` 必须为 `false`。
- `unsupportedEdges`：旧 Archify 连接没有独立的关系级代码证据，因此不能被影子报告包装成已验证事实。

影子报告不会改变原有 `status`、`completed`、`profileMatches`、生产 `accepted` 状态或 Archify 产物。后续检测器必须直接产生带关系证据的 `ArchitectureFactSet`，并在固定 revision 的仓库范围内运行，才能使用 `scope: repository` 和 `publishable: true`。
