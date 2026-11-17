# CoDelphi Radar 通用 Skill 架构设计

日期：2026-11-17
状态：方向已确认，进入实施规格

## 1. 背景

当前 CoDelphi Snapshot 同时存在两种模型使用方式：

- 主产品与 standalone 通过程序化 completion API 执行分析；
- Skill 期望复用宿主当前模型，但仍要求宿主提供程序化 completion CLI 或桥接。

这导致普通 agent 宿主即使本身能够分析仓库，也可能因为没有额外模型接口而无法运行。临时为每个宿主编写协议适配器不能解决根本问题。

同时，主产品与 Skill 若各自维护 prompt、schema、清洗和合并逻辑，会在后续升级中产生语义漂移。若 Skill 单拆仓库，这种漂移会进一步加剧。

用户已决定：

- 对外名称使用 `codelphi-radar`，不再以 snapshot 作为产品名；
- 公共契约保留在 CoDelphi 主产品并发布为独立 Skill 包；
- 不另建 Skill 开源仓库；
- 主产品提供方便的 Skill 安装与下载方式；
- 主能力与 Skill 采用共享契约、两种模型执行驱动，而不是互相复制实现。

## 2. 目标

- 任意具备基本文件与命令执行能力的 agent 宿主，都能使用自身当前模型完成 Radar 分析，不需要额外 completion API、adapter 或 AI 凭据。
- 主产品、定时任务和 standalone 继续使用程序化 completion，不改成宿主驱动。
- prompt、schema、证据规则、分区规则、合并、回退和兼容性测试只有一份。
- 主仓库同时作为契约源码、主产品源码和 Skill 发布源，避免跨仓库同步问题。
- 生成的独立 Skill 包不依赖 CoDelphi 源码、Next.js、MySQL 或根 `node_modules`。
- 对外统一使用 `codelphi-radar`；内部已有的 snapshot 类型可以保留为技术概念，避免无关重写。

## 3. 非目标

- 不要求不同宿主模型产生逐字相同的功能和场景，只要求遵守同一契约并通过相同校验。
- 不把主产品的增量影响面、carry-forward、发布持久化、计费、通知、Webhook 或 MySQL 搬进 Skill。
- 不新建 Skill 仓库，不引入 Git submodule，不通过定期复制文件保持同步。
- 不改变当前“定向增量、相关代码完整读取、分区数量不设上限”的主分析决定。
- 不把临时调试适配器、完整克隆或失败分析产物纳入正式实现。

## 4. 总体架构：一份契约，两种驱动

### 4.1 共享提取契约

主产品新增版本化提取契约，至少包含：

- prompt 模板与输出要求；
- 工作单类型与 `contractVersion`；
- JSON/Zod schema 与结构化错误；
- 分区与证据允许集规则；
- 清洗、合并、去重和确定性回退；
- golden fixtures 与跨驱动兼容性测试。

契约定义“需要模型完成什么”，不定义“由哪个产品调用模型”。主产品服务端与 Skill 都从这里生成工作单。

### 4.2 服务端与 standalone 驱动

现有程序化路径继续执行：

1. 从共享契约生成工作单；
2. 调用 `StructuredCompletionClient`；
3. 使用共享 schema、清洗、合并和报告逻辑处理结果。

主产品的增量影响面、carry-forward、发布持久化、计费和通知保持独立，不强行通用化。只有可复用的无状态提取单元接入共享契约。

### 4.3 宿主原生驱动

宿主模式不再需要程序化 completion 接口，采用：

```text
radar prepare → 宿主 agent 执行工作单 → radar finalize
```

- `prepare`：固定 commit、读取相关源码、生成每个分区的工作单、prompt、schema 和清单。
- 宿主 agent：使用自己的当前模型和工具完成工作单，按约定写入结构化结果。
- `finalize`：验证结果，执行共享清洗、合并、回退和 HTML 生成。

宿主不再注入 `CODELPHI_HOST_AI_COMMAND`、桥接 URL 或 token。`SKILL.md` 只描述如何调用 prepare/finalize 和交付 HTML，不复制提取 prompt。

## 5. 工作单协议

每次运行使用独立工作目录，包含：

- `manifest.json`：目标、固定 revision、scope、语言、契约版本、分区清单和状态；
- `work-orders/<index>.json`：分区输入、prompt、输出 schema 与文件名；
- `results/<index>.json`：宿主返回的结构化结果；
- 最终 HTML 与验证摘要。

要求：

- 每个工作单有稳定 ID 和契约版本，结果只能写入对应文件；
- finalize 拒绝缺失、重复、版本不匹配或 schema 不合法的结果；
- 失败时不得生成标称成功的 HTML；
- 支持只重跑失败分区，不重复已成功分区的模型成本；
- 分区数量由实际范围决定，不重新引入上限；
- 工作目录不作为交付物，用户只接收一个 HTML。

服务端与 standalone 复用同一工作单构建和验证函数，但不依赖文件系统协议；宿主文件协议只是该契约的一种驱动适配。

## 6. 主产品契约接入边界

主产品不需要改成宿主架构，但应把可共享的提取步骤迁移到同一工作单构建器：

- 全量快照提取直接使用共享契约；
- 主产品增量分析复用共享 prompt、schema 和证据语义，保留自己的 affected scope 与 carry-forward；
- 发布变化投影、计费、通知和持久化仍由主产品负责；
- 若某段主产品逻辑与一次性快照语义不同，不强行合并成“万能 prompt”，而是单独命名契约并共享底层 schema 与工具。

这样升级 prompt 时只改共享定义；主产品与 Skill 在同一 PR 中完成兼容验证。

## 7. Skill 包与安装分发

对外 Skill 名称为 `codelphi-radar`，目录与安装文案统一使用该名称。

主产品提供安装入口：

- 使用说明页介绍本地 Git 仓库与公开 GitHub 仓库的用法、语言、scope、宿主模式与 standalone 模式；
- 提供独立 Skill bundle 下载；
- 提供复制即用的安装命令或安装步骤，具体命令以实际支持的安装器为准，不虚构安装器能力。

CI/构建脚本生成 `dist/codelphi-radar/`，至少包含：

- `SKILL.md`；
- prepare/finalize CLI 与共享核心；
- standalone 驱动；
- 契约版本与必要的 fixtures/元数据。

`dist/` 不提交 Git。最终 bundle 不需要目标目录存在 CoDelphi 源码、根 `node_modules`、Next.js 或 MySQL。

## 8. 错误与恢复

- 宿主缺少工作单结果时，finalize 明确指出缺失分区，不调用额外模型接口。
- 模型输出缺少 `release.title`、`release.summary` 等必填字段时，返回可定位到分区的结构化错误并允许仅重试该分区。
- Git 懒加载超时保留明确错误；优先提供完整浅克隆或本地仓库运行方式，避免把网络对象下载失败误报为模型问题。
- 不支持的目标、scope、输出冲突和旧契约版本使用稳定错误码与调用语言。
- 宿主模式不得静默回退 standalone；只有用户明确选择 standalone 才使用独立 AI 配置。

## 9. 版本与同步策略

主仓库是唯一天然同步源：

- prompt 或 schema 变更必须同时更新契约版本、fixtures 和双驱动测试；
-  additive 变更提升 minor，破坏性语义或 schema 变更提升 major；
- 主产品与 Skill bundle 在同一 PR 中验证，但可以独立发布；
- bundle 与工作单记录契约版本，finalize 拒绝不兼容结果；
- 不通过 `latest` 或运行时下载保持同步，最终 Skill 包自包含。

## 10. 测试与验收

### 10.1 契约与双驱动

- 同一工作单分别由模拟 API 驱动和模拟宿主驱动执行，最终都通过相同校验并生成可读 HTML。
- golden fixtures 覆盖必填 release 字段、功能、场景、证据、清洗、去重与回退。
- 不比较不同模型的自然语言逐字一致性。

### 10.2 宿主原生流程

- 在无 CoDelphi 源码、无根 `node_modules`、无 AI 环境变量的临时目录运行 bundle。
- prepare 生成工作单，模拟宿主写入结果，finalize 生成单一 HTML。
- 缺少结果、结果版本错误、字段缺失和仅重试失败分区均有测试。
- 全程不需要程序化模型 CLI、桥接或 AI key。

### 10.3 现有功能回归

- standalone 本地与公开 GitHub 流程继续工作；
- 主产品定向增量、全量回退、carry-forward、manual 条目不覆盖和发布持久化测试通过；
- 单文件 HTML 的离线阅读、搜索、筛选、证据链接和边界说明保持可用。

### 10.4 真实验收与交付检查

- 使用当前宿主原生流程分析一个公开仓库并生成真实 HTML，验证不是模拟产物。
- 运行 `npm run typecheck`、`npm test`、`npm run build` 和 Skill 构建。
- 检查安装包在独立目录中的可执行性，并保留主产品其他未提交工作，不混入提交。

## 11. 实施假设

- 主仓库继续保持开源，Skill 不需要独立仓库即可被安装和复用。
- 对外使用 `codelphi-radar`；内部 snapshot 类型与文件名仅在需要保持兼容时保留。
- 当前工作区存在其他会话的未提交实现，实施时保留并只暂存 Radar 相关改动。
