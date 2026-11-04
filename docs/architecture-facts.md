# 架构事实与语义覆盖诊断

`lib/architecture/` 是通用架构引擎的领域层，当前先用于 stack corpus 的影子诊断，不参与生产架构验收。

## 数据边界

- `facts.ts`：固定 revision 的节点、关系、合法入口和代码证据。节点/关系 ID 必须唯一，引用不能悬空。
- `signals.ts`：独立于最终图的入口、部署单元、异步任务、存储和外部依赖信号。信号是否被覆盖不能由最终图自身决定。
- `coverage.ts`：比较信号与事实，检查关键信号遗漏、无证据节点/关系，以及从用户、Webhook、Scheduler 等多个根节点出发的有向可达性。
- `shadow.ts`：旧架构文档与直接事实提取结果的两类临时诊断适配器，不是生产验收路径。
- `extract.ts` / `detectors/`：按 Go、Next.js、PHP、小程序、存储和外部 SDK 能力直接提取事实；不包含仓库名分支。Go 和 TypeScript 关系只沿可解析的 import 闭包、注册路由或调用证据产生。
- `project.ts`：把已经校验的事实投影为 Archify 文档，不再从固定组件词表反推系统。

## Corpus 影子报告

`scripts/stack-corpus.ts` 的每个仓库结果增加 `architectureShadow` 和 `architectureFacts`：

- `architectureShadow` 是旧模板的临时对照结果；`architectureFacts` 是通用检测器的直接事实结果，两者互不改变对方的旧字段。
- `status: completed`：旧文档已转换为临时事实并完成覆盖诊断。
- `status: unavailable`：规划或文档生成不可用，不能推断架构质量。
- `scope: source-slice`：信号仅来自当前 AI 切片，不代表全仓库覆盖，`publishable` 必须为 `false`。
- `unsupportedEdges`：旧 Archify 连接没有独立的关系级代码证据，因此不能被影子报告包装成已验证事实。

影子报告不会改变原有 `status`、`completed`、`profileMatches`、生产 `accepted` 状态或 Archify 产物。当前直接提取器仍只在 corpus 的 `source-slice` 上运行，不能宣称全仓库覆盖。后续必须在固定 revision 的仓库范围内运行，并保存关系级事实证据，才能使用 `scope: repository` 和 `publishable: true`。
