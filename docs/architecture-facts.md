# 架构事实与语义覆盖诊断

`lib/architecture/` 是通用架构引擎的领域层。生产 GitHub 分析与 stack corpus 共用事实、信号和覆盖模型；corpus 的旧模板只用于影子回归，不参与新架构验收。

## 数据边界

- `facts.ts`：固定 revision 的节点、关系、合法入口和代码证据。节点/关系 ID 必须唯一，引用不能悬空。
- `signals.ts`：独立于最终图的入口、部署单元、异步任务、存储、外部依赖和内部关系信号。信号是否被覆盖不能由最终图自身决定；注释、测试源码和检测规则声明不作为运行时证据。
- `coverage.ts`：比较信号与事实，检查关键信号遗漏、无证据节点/关系，以及从用户、Webhook、Scheduler 等多个根节点出发的有向可达性。
- `remote.ts`：生产与 corpus 共用的固定 revision 仓库源码读取器。它遍历完整源码树、分页读取完整文件，并在树截断、目录/文件/字节预算耗尽时失败，不能把部分结果标记为 `repository`。
- `shadow.ts`：旧架构文档与直接事实提取结果的两类临时诊断适配器，包含节点/关系事实和覆盖报告，不是生产验收路径。
- `extract.ts` / `detectors/`：按 Go、Next.js、PHP、小程序、存储和外部 SDK 能力直接提取事实；不包含仓库名分支。Go 和 TypeScript 关系只沿可解析的 import 闭包、注册路由或调用证据产生，支持 `{id}` 动态路由和多行调用。Go CLI、HTTP 服务与 Worker 使用不同入口类型，Worker 数据库轮询使用 `poll`，COS 上传/下载分别使用 `upload`/`download`；构造器本身不证明数据传输方向。小程序等内部调用使用 `relationship` 信号参与覆盖门禁。
- `project.ts` / `layout.ts`：把已经校验的事实投影为 Archify 文档，不再从固定组件词表反推系统。事实 ID 只在投影边界映射为稳定合法 ID；入口、运行时和资源使用确定性分栏，正交路径从节点外部端口绕行，标签同时避开节点和已放置标签。通用图使用 `standard` 质量，不为满足 showcase 而删除节点或关系。
- `repository.ts`：校验完整源码回执并执行发布门禁。`generateRepositoryArchitectureVersion` 先写 `architecture.facts.json` 和 `architecture.analysis.json`，只有 `publishable: true` 才调用 Archify；`architecture_documents.analysis_receipt` 保存源码范围、覆盖结果和诊断文件哈希。

## 生产分析边界

`lib/analysis.ts` 先提交 Spec Version，再延迟读取独立 fixed-SHA 架构源码。架构读取使用独立远程索引，不消耗或扩大 AI 切片预算；默认上限为 1000 个目录、1000 个文件和 10 MB 总内容，单个 blob 上限 1 MB，超限仍失败关闭。Spec 不因架构失败回滚；源码加载阶段的异常也会保存为当前 revision 的 `failed` 架构记录并写入服务日志，不会让产品卡片无限等待。所有仓库使用同一事实提取和覆盖门禁，没有 owner/repository 名称分支。旧的 `generateArchitectureVersion` 仅保留给历史回归，不是生产分析入口；既有 accepted 版本不会因代码升级自动重建。

## Corpus 影子报告

`scripts/stack-corpus.ts` 的每个仓库结果增加 `architectureShadow`、`architectureFacts` 和 `architectureSource`：

- `architectureShadow` 是旧模板的临时对照结果；`architectureFacts` 是通用检测器的直接事实结果，两者互不改变对方的旧字段。
- `status: completed`：旧文档已转换为临时事实并完成覆盖诊断。
- `status: unavailable`：规划或文档生成不可用，不能推断架构质量。
- `scope: source-slice`：信号仅来自当前 AI 切片，不代表全仓库覆盖，`publishable` 必须为 `false`。
- `scope: repository`：仅用于清单中显式设置 `architectureScope: "repository"` 的仓库。架构读取使用独立 fixed-SHA index 和独立架构预算，不消耗或扩大 AI 切片额度；`architectureSource` 记录目录、文件和字节回执。
- `legacyTemplate`：只由 corpus 清单数据选择已有的 Radar/AIVlog 回归基线模板；新事实提取器不读取该字段，也没有仓库分支。
- `unsupportedEdges`：旧 Archify 连接没有独立的关系级代码证据，因此不能被影子报告包装成已验证事实。

影子报告不会改变原有 `status`、`completed`、`profileMatches`、生产 `accepted` 状态或 Archify 产物。Radar、AIVlog、NameDict 三个固定 revision 已加入清单作为语义回归基线；其他仓库默认仍使用 `source-slice`。
