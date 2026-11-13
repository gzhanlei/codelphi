# Coding agent × CoDelphi MCP 工作流配方

CoDelphi 的 MCP 工具面（12 个只读 + 1 个反馈写）不只是给人手动调用的：coding agent 在软件开发的整个周期里都可以把它当**跨会话的行为记忆**和**独立观察者**用。本文是给 agent（以及维护 AGENTS.md 的人）的操作配方。

定位红线先说清楚：

- 账本记录的是**行为**，不是正确性判据。场景与代码冲突时，先怀疑一方需更新，由人裁决。
- **没搜到 ≠ 不存在**。覆盖率（`get_project_summary.evidenceCoverage`）如实披露账本覆盖比例，未覆盖区域的结论一律不成立。
- MCP 是只读面；唯一写是 `send_feedback`（人裁决）。不要试图通过 MCP 改规格。

## 1. 任务理解（上手时）

用 `search_scenarios` 做行为语义检索——命中是已过证据校验的 context/action/outcome 三元组，带 `path + startLine` 证据，可直接读文件；比 grep 强在有行为语义，比读 README 强在锚到代码。

```
search_scenarios(slug, query) → features[].stableKey → get_feature(slug, stableKey)
```

搜索结果自带 `stableKey`（功能名归一化），可直接寻址 `get_feature` / `get_scenario`。

## 2. 改动前影响面（Edit 之前）

改哪个文件，先反查谁以它为证据：

```
lookup_by_files(slug, paths: ["lib/xxx.ts"]) → files[].features[].scenarios
```

每功能返回前 10 条场景并附真实总数（`scenarioCount`）。想看一个文件的「功能邻域」：

```
get_feature_connections(slug, path: "lib/xxx.ts") → 共享该文件的功能对与双方场景引用
```

两者都是确定性计算，零 AI 成本。共同修改同一文件的连接是廉价的爆炸半径信号。

## 3. 契约对齐（编码中）

账本是**快照**：`get_project_summary.specSnapshot`（`sha` + `committedAt` + `specVersionId`）告诉你它对应哪个 commit。工作区领先于账本的部分不在账本里，证据行号以快照 commit 为准。

写新代码前对齐既有行为约定：同域场景（如 token 刷新）已有记录时，新路径应当行为一致，除非这是有意的变化。

## 4. push 后自证（每次 push 之后）

发布按 push 粒度生成，含 docs-only 的「零行为变化」条目：

```
push → list_releases(slug) 轮询到自己这次 push 的 sha
     → get_release(slug, releaseId) → 核对「行为变化清单 == 我打算做的变化」
```

出现计划外的行为变化 = 回去查代码。这是独立第三方观察者的对账，不是 agent 自评。

## 5. 发现账本与代码不符（任何时候）

```
send_feedback(slug, kind: "bug" | "question" | "suggestion", message)
```

写清楚哪个场景、哪份证据、代码实际行为是什么。反馈进产品方后台，由人核实后改规格——agent 不直接改账本。

## 6. 交接与巡检（低频）

- `get_knowledge_health`：漂移清单/核实覆盖——别把漂移区域的规格当可靠契约。
- `get_digest`：最近一期行为摘要，接手陌生产品时先读。
- `get_release_notes` / `get_release`：写 PR 描述与 changelog 时以真实行为 delta 为底稿，附证据路径。
