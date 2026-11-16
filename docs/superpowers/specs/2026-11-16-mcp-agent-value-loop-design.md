# CoDelphi Agent 价值闭环设计

## 1. 目标与评价标准

把 CoDelphi 从“改前返回大量文件级场景、改后手工拼接对账参数”改为一条可重复的开发闭环：

1. 改前按实际变更行区分直接命中与文件级间接风险，并给出可转为测试的行为约束。
2. 计划阶段形成本地意图清单，自动携带 stableKey、路径、场景约束和回归测试，不再从 release 标题手工猜测 stableKey。
3. push 后用一次 `verify_push` 完成等待与对账。
4. 只有需要行动的异常才产生 `warning`；共享证据只作为信息信号。
5. 按风险决定流程深度，并用真实任务记录独立发现、时间成本和误报，而不是以流程执行次数衡量价值。

首个交付版本的成功标准：

- 对同一组文件与 hunks，风险投影稳定地区分 `line` 与 `file` 命中，直接命中优先排序。
- `lookup_by_files?view=risk` 返回确定性 `recommendedIntents` 和原始场景约束；调用方可以直接形成意图清单。
- `verify_push(slug, sha, expectedIntents)` 复用现有等待和 reconcile 语义，不返回完整 before/after 文本。
- 仅存在共享证据时，reconcile 不再降为 `warning`，可以返回带信息信号的 `pass`。
- 低风险、明确零行为变化的提交可用空意图数组验收；缺少意图与明确零变化严格区分。
- 在 CoDelphi 仓库完成一次真实全流程，并记录第一条价值度量样本。

## 2. 已确认问题与影响面

2026-11-16 对 `lib/mcp/server.ts`、`lib/mcp/reconcile.ts`、`lib/mcp/operations.ts`、`lib/mcp/projections.ts`、`docs/coding-agent-mcp.md` 和 `AGENTS.md` 执行了生产 `lookup_by_files?view=risk`：

- 快照 SHA 为 `12426288d195dd5adf1ef317a0f9956abc3890c9`。
- 返回 99 条 raw 风险、19 条 canonical 场景；前 10 条全部属于同一功能且只是文件级证据。
- 四个 MCP 实现文件有账本覆盖；`AGENTS.md` 与工作流文档没有覆盖，不能把空结果解释为无风险。

必须守住的行为红线：

- 默认 raw 响应、组织级防枚举和不存在资源返回空对象的语义不变。
- stableKey 只用于名称级匹配，不升级为行为身份；scenario reference 不作为跨版本稳定身份。
- run、release 与请求 SHA 必须一致；短 SHA 歧义返回 review。
- path-only intent 不能独立证明行为身份；没有意图不能默认 pass。
- 共享证据不是重复证明；canonical 仍只合并可证明的重复投影。
- 没有显式 feedback verification 关联时，verification 继续为 unavailable。

## 3. 方案比较

### 方案 A：本地意图清单 + 确定性 MCP 组合工具（采纳）

新增行级影响面参数、风险候选意图和 `verify_push` 组合读取工具。意图清单保存在调用方工作区，由 Agent 在计划阶段生成并补充回归测试；MCP 不保存计划、不执行本地测试。

优点是没有第二套事实数据库，不改变 MCP 只读边界，能直接消除手工等待、查找 release 和拼接对账参数。限制是本地测试是否通过仍由 Agent 的测试命令证明，CoDelphi 不伪造测试执行事实。

### 方案 B：服务端持久化开发计划与断言

新增计划、意图、断言及执行记录表，由 MCP 写入并在 push 后读取。自动化程度较高，但引入组织权限、生命周期、并发修改、历史清理和第二套验收事实，且仍需解决本地测试执行问题。本阶段不采纳。

### 方案 C：AI 阅读 diff 并判断影响与验收

覆盖看似更广，但行为身份和验收结论会变得不可重复，也会把推测包装成事实。本阶段不采纳。AI 只能帮助 Agent 将已返回的场景约束映射为测试，不能改变确定性 verdict。

## 4. 总体架构与边界

闭环分为两个责任面：

- **CoDelphi MCP**：读取规格与证据，计算直接/间接影响，提供候选意图，等待 release，执行确定性对账。
- **Coding Agent**：提供实际 hunks，选择与本任务有关的候选意图，补充回归测试，运行项目测试，处理 failed/warning/review。

本地意图文件建议命名为 `.codelphi/change-intent.json`，属于调用方临时工作产物，不进入 CoDelphi 数据库，也不作为产品事实。其最小结构为：

```json
{
  "version": 1,
  "expectedIntents": [
    {
      "stableKey": "mcp 按 sha 等待发布",
      "paths": ["lib/mcp/operations.ts"],
      "note": "保留同 SHA 最新重试与 run/release 一致性",
      "regressionTests": ["tests/mcp-operations.test.ts"]
    }
  ]
}
```

`ExpectedIntent` 增加可选 `regressionTests: string[]`，并在对应 `intentResults` 中原样返回。它只是 Agent 的测试交接信息，不参与身份、路径或 verdict 计算，也不表示测试已经存在或通过。`verify_push` 的 release verdict 与项目测试结果必须分别报告。

本阶段不实现符号级调用图、不执行任意本地命令、不新增遥测数据库、不自动合并行为、不声称证明完整产品正确性。

## 5. 行级影响面与候选意图

### 5.1 输入扩展

`lookup_by_files` 保留 `paths`，新增可选 `hunks`：

```ts
{
  slug: string;
  paths?: string[];
  hunks?: Array<{
    path: string;
    startLine: number;
    endLine: number;
  }>;
  view?: "raw" | "canonical" | "risk";
}
```

约束：

- `paths` 与 `hunks` 至少一个非空；合并去重后最多 20 个路径。
- 行号为从 1 开始的闭区间，`1 <= startLine <= endLine`。
- 路径继续使用规范化的相对仓库路径，禁止绝对路径与 `..`。
- 不提供 hunks 时保持现有文件级行为。
- raw/canonical 视图不因 hunks 改变；行级投影只在 `view=risk` 启用。

### 5.2 确定性命中规则

每条场景证据保留 `path`、`startLine` 和来源场景：

- 证据路径等于 hunk 路径，且证据 `startLine` 落在任一 hunk 闭区间内：`matchType="line"`。
- 场景只共享路径、证据没有行号、或行号不在 hunks 内：`matchType="file"`。
- 同一场景有任一直接证据时，该场景整体为 `line`，不再因其他文件证据重复计算。
- 未提供 hunks 的路径全部为 `file`。
- 没有直接命中不能解释为没有影响，必须返回 `directScenarioCount` 与 `fileOnlyScenarioCount`。

### 5.3 风险与约束输出

现有 `risks` 字段保留，新增：

- `matchType`、`matchedEvidence`；
- `directScenarioCount`、`fileOnlyScenarioCount`；
- `recommendedIntents`；
- 每条风险的 `contract`，包含原始 `scenarioId`、`reference`、`context`、`action`、`outcome`。

排序为：直接命中优先、manual 优先、stableKey、scenario ID、证据路径。默认仍返回前 10 条，并保留 `totalCount/hasMore`。

`recommendedIntents` 按 stableKey 确定性分组，结构为 `Array<{ stableKey: string; paths: string[]; scenarios: Array<{ id: number; reference: string }> }>`。它是候选，不替 Agent 判断哪些场景与开发意图相关；Agent 必须删除无关项并补充 `note/regressionTests`。

## 6. 一键 `verify_push`

新增只读 MCP 工具：

```ts
{
  slug: string;
  sha: string;
  expectedIntents?: ExpectedIntent[];
  timeoutSeconds?: number;
  pollSeconds?: number;
}
```

执行顺序：

1. 复用 `wait_for_release` 的 SHA 匹配、最新重试、歧义与超时规则。
2. `completed` 且存在 releaseId 时，复用 `reconcile_release` 的数据加载与纯函数。
3. 返回 `{ wait, reconciliation, summary }`。

状态规则：

- 等待失败：`wait.status="failed"`，不继续对账，整体为 failed。
- 超时、SHA 歧义、run/release 不一致或 release 尚不可读：整体为 review，不能当成 failed 或 pass。
- completed 后，整体 verdict 完全来自 reconcile。
- 未提供 `expectedIntents` 继续为 review；显式空数组表示“预期零行为变化”，只在没有任何变化时可能 pass。

`summary` 只包含 verdict、各类异常数量、信息信号数量与稳定排序的 `nextActions`。详细 ID 仍在 reconciliation 中，不返回完整 before/after。

`verify_push` 不触发分析，不执行测试，不创建服务端计划，最长等待仍为 60 秒。

## 7. 低噪声 verdict 与信息信号

`reconcile_release` 继续返回 `sharedEvidenceWarnings` 以兼容旧调用方，同时新增 `informationalSignals`。共享证据只进入信息信号：

- 不再向 `reasons` 添加 `shared_evidence_requires_review`。
- 不再仅因共享证据把 verdict 从 pass 降为 warning。
- `warning` 保留给确定性重复簇、legacy 来源问题等需要复核的异常。
- `failed`、`review` 的既有优先级不变。
- `pass` 仍只表示所提供意图和可读取证据范围内通过，不表示所有行为正确或测试完整。

这是对 verdict 噪声语义的有意修正，不改变原始变化、证据和共享证据数据。

## 8. 风险触发工作流

更新 MCP initialize instructions、`docs/coding-agent-mcp.md` 与仓库工作流说明：

完整闭环用于至少满足一项的修改：

- 行级直接命中或 manual 行为证据；
- 多功能共享文件、身份/权限/版本/数据关联语义；
- 测试覆盖不足或历史回归区域；
- 跨模块、大范围或调用方难以枚举影响的修改。

轻量流程用于明确低风险修改：Agent 仍需声明零行为变化或提供意图，并在 push 后使用 `verify_push`；没有证据覆盖时必须明说影响面未知，不能跳过验证或宣称无风险。

计划阶段由 Agent 创建本地意图文件；编码前将约束转成测试；push 前运行项目标准测试；push 后读取同一文件调用 `verify_push`。计划外变化必须回查，不允许通过修改意图掩盖异常。

## 9. 价值度量

新增一份无自动遥测的试点记录规范，连续记录至少 20 个真实任务：

- 任务与风险等级；
- 反查耗时、对账耗时、手工修正参数次数；
- 直接/间接命中数量；
- 转化为回归测试的约束数量；
- CoDelphi 独立发现的问题数，即测试与代码审查尚未发现的问题；
- warning 是否需要行动；
- 不用 CoDelphi 是否大概率得到相同结果及理由。

不采集代码正文、密钥或用户隐私。试点结束后按独立发现、节省时间、误报率决定保留、调整或取消强制流程；不能用调用次数证明价值。

## 10. 测试与生产验收

单元与集成测试至少覆盖：

- hunk 边界、跨 hunk 命中、无行号证据、同场景多证据去重和稳定排序；
- 无直接命中、超过 20 个合并路径、非法行号和非法路径；
- `recommendedIntents` 分组与原始约束完整性；
- verify 的 completed/failed/timeout/review、短 SHA 歧义、releaseId 缺失与零变化意图；
- 共享证据只产生 informational signal，缺失、计划外变化和重复簇仍保持原 verdict；
- 旧工具 raw 响应、组织防枚举与现有 reconcile 输入兼容。

生产验收：

1. 用本次真实提交的 hunks 调用风险投影，确认直接命中优先且候选意图可用。
2. 从计划阶段的意图清单调用 `verify_push`，核对等待、release 和所有异常。
3. 若只有共享证据，确认不再产生 warning；若存在真实异常，如实报告，不调整意图追求 pass。
4. 记录第一条价值试点样本，包括 CoDelphi 是否独立发现了问题及实际时间成本。

交付前运行 `npm run typecheck`、`npm test`、`npm run build`，随后完成独立代码审查、生产部署和 CoDelphi 对账。
