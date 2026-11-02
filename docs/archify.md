# Archify 阶段 1：固定运行时与原型验收

Radar 只使用 **Archify v3.2.0（MIT）**。官方 ZIP 保存在 `vendor/archify/archify-v3.2.0.zip`，版本、来源与 SHA-256 记录在 `vendor/archify/release.json`。

- Release：`https://github.com/tt-a1i/archify/releases/download/v3.2.0/archify.zip`
- SHA-256：`70e210265c59f24dcbdf2a502ff671104b5454e7ee7d3554aecd86bad32384f5`
- License：`https://github.com/tt-a1i/archify/blob/v3.2.0/LICENSE`
- 不使用 `main` 或后续 Apache-2.0 版本。

## 命令

```bash
npm run archify:prepare
npm run archify:prototype
```

`archify:prepare` 验证 release 元数据和 ZIP 字节，并幂等解压到 `vendor/archify/runtime/`。该运行目录不进入 Git。

`archify:prototype` 使用 `lib/archify-cli.ts` 的参数数组调用固定 CLI，完成：

1. `deliver architecture`：校验源码证据和 9 项 showcase 检查，原子生成 HTML。
2. `visual-check`：检查 1440×900、1600×1000、1920×1080、2048×1320 的桌面视口并生成浅色/深色截图。
3. 将精简验收结果写入 `artifacts/radar-architecture.acceptance.json`。

## 原型文件

- 输入：`artifacts/radar-architecture.json`
- 输出：`artifacts/radar-architecture.html`（本地生成，不提交）
- 完整视觉回执：`artifacts/radar-architecture.visual-check.json`
- 截图与 contact sheet：本地生成，不提交

`visualReview: "pending"` 是 Archify 回执的固定含义：自动检查完成，但仍需人工查看截图。只有结构校验、桌面 containment 和人工截图审查都通过，才能把原型视为阶段 1 验收完成。

后续阶段复用同一 CLI adapter，不直接调用 shell 字符串，也不把 Archify Viewer 注入 React 页面。

## 阶段 2：架构版本与分析流水线

`migrations/005_architecture_documents.sql` 以 `spec_version_id` 唯一关联一份架构文档。每次分析先提交 Spec Version，再独立生成架构产物：

- `accepted`：delivery 与 visual-check 均通过，可通过 artifact 路由访问。
- `rendered`：HTML 已生成，但 visual-check 未通过，不开放 accepted 访问。
- `failed`：delivery 未成功，没有可发布的 artifact。

每次尝试都回写同一版本，保留 `spec_json`、规格/产物 SHA-256、delivery/visual 回执和错误信息。架构异常不会回滚已提交的产品规格。

生成文件位于 `artifacts/products/<slug>/<specVersionId>/`，该目录不进入 Git。访问路径为 `/api/architecture/<id>`，需要有效 Radar 会话；响应使用无 `allow-same-origin` 的 sandbox CSP，并验证产品与 Spec Version 对应的受管路径。

Archify 的源码证据验证需要匹配本地 Git checkout。当前仓库通过 `GITHUB_REPOSITORY` 自动识别；其他工作目录需在环境变量中显式配置 JSON 映射，未配置时仅记录架构生成失败，不伪造验证：

```bash
RADAR_REPOSITORY_ROOTS='{"owner/repo":"/absolute/local/checkout"}'
```

Radar 使用专用模板，其他仓库使用基于源码内容和行号的通用架构生成器，均要求实现标记匹配；不会仅凭同名文件虚构组件。WorkMembership（Chandler）已通过真实分析和 accepted 验收。架构查看使用 `/products/<slug>/architecture/<id>` 原生页面并提供“返回产品概览”按钮，`prepare` 阶段的无组件、spec 写入失败等也会保存 `failed` 文档与错误信息。

## 阶段 3：原生产品概览

产品默认首页改为 Conclusion-first 概览，保留 `?view=spec` 与 `?view=changes` 深链。`ProductOverviewData` 由现有产品、功能、场景、release、行为 Diff、运行状态和最新架构文档确定，不增加 AI 调用。页面包含：

1. 产品结论与 Spec/分析状态。
2. 架构面板：仅 `accepted` 文档显示交互式 Viewer 链接，其他状态展示真实错误或待验收状态。
3. 核心能力：按场景数排序，链接到原规格工作台。
4. 最近行为 Diff 与规格可信度：版本、人工来源和证据文件统计。

桌面和 390px 手机视口均已验证无横向滚动，规格深链和架构 Viewer 链接可用。

## 阶段 4：Explainer HTML 导出

`ProductOverviewData` 同时驱动原生概览与 `buildExplainerMarkdown`，不生成第二份产品知识。Markdown 包含产品结论、架构、核心能力、最近行为 Diff 和规格可信度；行为变化行使用稳定的 `BehaviorChangeRow.id` 避免 `explainer/duplicate-id`。

- 输出目录：`artifacts/products/<slug>/<specVersionId>/`。
- 输入：`explainer.md`，可选复用 accepted 的 `architecture.json`。
- 输出：`explainer.html`，通过固定 MIT Archify `finalize explainer --browser-check` 生成。
- 路由：`GET /api/products/<slug>/explainer`，需要有效 Radar 会话，返回与架构 Viewer 相同的 sandbox 和 `private, no-store` 头。
- 只有 accepted 架构才嵌入源码证据并传入 `repoRoot`；其他状态仅显示真实状态。
- 版本不一致、缺少 Spec Version、重复 ID 和 finalize 错误均会返回明确错误，不伪造成果。

真实导出 `/api/products/radar/explainer` 已验证包含结论、架构图、核心能力、行为变化和规格可信度，未检测到密钥内容。

真实自分析验证：Analysis Run `15` 生成 Spec Version `8` 与 Architecture Document `1`，状态 `accepted`，并已在浏览器中通过 `/api/architecture/1` 打开 Viewer。Run `17` 进一步验证同一 SHA 重跑时，release 会更新到 Spec Version `10`，对应 Architecture Document `3`，不再停留在旧版本。Run `18` 验证了带行号的内容证据，Architecture Document `4` 为 `accepted`。
