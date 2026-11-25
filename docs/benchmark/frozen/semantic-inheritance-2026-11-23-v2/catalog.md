# 语义继承实验冻结预标 v2（2026-11-23）

本版本取代 `../semantic-inheritance-2026-11-23/cases.json`，沿用其标注范围、九个窗口、数据分工、隔离规则和判定口径。v1 保留不改。

## 唯一答案键修正

- 窗口：`SB-002`
- 原测试路径：`server/web/src/__tests__/AssistantChatDrawer.spec.ts`
- 正确路径：`server/web/src/components/__tests__/AssistantChatDrawer.spec.ts`
- 原因：首次真实 dry-run 时发现 v1 路径不存在；修正发生在任何 A/B/C 模型输出之前。

`cases.json` 的 `schemaVersion` 已改为 `semantic-inheritance-labels-v2`，并包含新的 `frozenAt`、`supersedes` 和 `corrections` 元数据。除上述证据路径外，行为断言、身份关系、核实继承规则与未知项均未改变。

## 运行器补充口径

v2 使用独立、限定证据范围的三臂运行器，不是全仓生产分析：

- A（full_rebuild）：分析目标版本中当前窗口及同项目前序窗口的全部有效证据源码。
- B（diff_only）：只分析当前窗口变更的非生成资源源码，不注入上一版规格。
- C（semantic_inheritance）：分析 A 的同一目标源码范围，并注入 baseSha 规格与相关功能范围。
- `server/static/` 构建产物和 `git-tree` 元数据不进入模型；测试文档可以进入，用于识别 TF-002 这类零产品行为窗口。
- 每个窗口的 base 规格在隔离输出目录重建并持久化，后续运行复用，不读取生产 active spec。

该口径用于定向身份与安全继承实验，不支持全产品召回率或全仓成本结论。领域专家复核仍为 `pending`。
