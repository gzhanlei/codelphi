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
