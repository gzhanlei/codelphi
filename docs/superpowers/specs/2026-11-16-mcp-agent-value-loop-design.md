# CoDelphi 修改前决策增强设计

## 1. 产品问题与价值假设

CoDelphi 当前已经能参与开发流程，但尚未证明能改变开发结果。下一阶段首先要回答：

> 能否让开发者发现原本不知道需要检查的行为、历史回归或验证证据，并因此做出更好的实现、测试或发布决定？

首个交付版本不以增加 MCP 工具数量或自动完成验收为目标，而以**修改前决策增强**为目标：

1. 将行级直接证据与文件级间接证据分开，避免把共享文件当成精确影响面。
2. 将已观察行为、人工核实状态和历史回归记录分开，不把账本现状自动当成已确认契约。
3. 只返回可追溯的验证证据；没有测试映射时，不宣称发现了具体测试盲区。
4. 共享证据不再制造低价值 warning。
5. 用真实任务衡量独立发现、决策改善、净时间收益和无效打扰。

P0 的价值假设是：在陌生、跨功能或验证证据不足的真实任务中，上述信息至少能促成一项原本不会发生的正确决策，例如调整实现方案、增加必要回归验证或推迟发布。一次成功对账、一次工具调用或一份很长风险清单都不算价值证明。

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
- 没有显式 feedback verification 关联时，feedback verification 继续为 unavailable。

## 3. 方案比较

### 方案 A：确定性修改前决策投影（P0 采纳）

扩展现有 `lookup_by_files?view=risk`，加入行级证据、已观察行为、人工核实状态和名称级历史回归提示；同时降低共享证据的告警等级。

优点是直接改善开发者修改前的判断，复用现有规格、证据和验证事实，不需要新事实数据库或 AI 判官。限制是不能证明完整调用依赖，也不能从没有验证记录推断没有自动化测试。

### 方案 B：优先建设自动验收闭环

先实现本地意图文件和 `verify_push`，再提高影响面质量。它能减少操作步骤，但可能只是更高效地执行低价值流程，因此推迟到 P2。

### 方案 C：AI 阅读 diff 并生成行为契约与影响结论

覆盖看似更广，但会把推测升级为契约，且结论不可重复，本设计不采纳。Agent 可以提出待确认约束，但不能改变 CoDelphi 的确定性事实等级与 verdict。

## 4. 事实等级与验证语义

所有新增输出严格区分以下概念：

| 概念 | 来源与含义 | 不得推断 |
|---|---|---|
| `observedBehavior` | 当前 active scenario 的 context/action/outcome 与代码证据 | 不等于团队确认的永久契约 |
| `proposedConstraint` | Agent 根据任务和已观察行为提出的本次修改约束 | 未经确认不得标成验收标准 |
| `confirmedConstraint` | 开发者或产品负责人在计划/评审中明确确认的约束 | CoDelphi 不从 generated/manual source 自动推导 |
| `specVerification` | live scenario 的 verified/stale 状态及 `spec_verifications` 历史记录 | 不等于自动化测试通过 |
| `regressionHistory` | release 下 regression task 的状态、检查和失败记录 | 名称级关联不等于跨版本同一场景身份 |
| `testExecution` | Agent 在项目中实际运行的测试命令和结果 | MCP 未观察到时不得声明存在或通过 |

当前 schema 的事实边界已经核实：

- `scenarios.verified_at/verified_by/stale_since` 可推导 `unverified`、`verified`、`stale-verified`。
- `spec_verifications` 通过 `product_id + entity_type + entity_id` 关联 live scenario，并记录 specVersion、commit、验证人和时间。
- `regression_tasks` 关联 release、版本内 scenario、状态、检查人、时间和失败备注。
- `feedback_reports.regression_stable_key` 仅是名称级锚点，不能证明历史反馈属于当前场景。
- 当前没有 scenario 到测试文件/测试用例的完整映射，也没有 feedback 到 verification 的显式归属链。

因此“没有验证记录”只能表示**验证证据缺口**，不能表示“没有测试”或“测试未覆盖”。“名称相同的历史回归”只能作为复核提示，不能合并跨版本场景身份。

## 5. P0：行级影响与决策投影

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
- 路径使用规范化的相对仓库路径，禁止绝对路径与 `..`。
- 不提供 hunks 时保持现有文件级行为。
- raw/canonical 视图不因 hunks 改变；行级投影只在 `view=risk` 启用。

### 5.2 确定性命中规则

每条场景证据保留 `path`、`startLine` 和来源场景：

- 证据路径等于 hunk 路径，且证据 `startLine` 落在任一 hunk 闭区间内：`matchType="line"`。
- 场景只共享路径、证据没有行号、或行号不在 hunks 内：`matchType="file"`。
- 同一场景有任一直接证据时，该场景整体为 `line`，不因其他文件证据重复计算。
- 未提供 hunks 的路径全部为 `file`。
- 没有直接命中不能解释为没有影响，必须分别返回 `directScenarioCount` 与 `fileOnlyScenarioCount`。

行级命中只表示代码证据位置与变更范围重合，不表示完整依赖覆盖。本阶段不实现符号、调用、接口、数据库状态或外部客户端依赖分析。

### 5.3 已观察行为与证据输出

现有 `risks` 字段保留并增加：

- `matchType` 与 `matchedEvidence: Array<{ path: string; startLine: number | null }>`；
- `observedBehavior: { scenarioId: number; reference: string; context: string; action: string; outcome: string; source: string }`；
- `specVerification`；
- `regressionHistory`。

不再使用未分级的 `contract` 字段。`manual` 只表示人工维护来源，不自动表示 confirmed constraint。

排序为：直接命中优先、`stale-verified` 或失败回归优先、manual 优先、stableKey、scenario ID、证据路径。默认仍返回前 10 条，并保留 `totalCount/hasMore`。

### 5.4 当前人工核实证据

每条命中场景返回：

```ts
specVerification: {
  state: "unverified" | "verified" | "stale-verified";
  verifiedAt: string | null;
  verifiedBy: string | null;
  latestRecord: {
    specVersionId: number | null;
    commitSha: string | null;
    verifiedAt: string;
    verifiedBy: string;
  } | null;
}
```

`state` 复用 live scenario 的 `verified_at × stale_since` 规则；`latestRecord` 取该 live scenario 在产品内最新一条 `spec_verifications`。二者分别表示当前核实状态与历史核实依据，不相互替代。

没有历史记录时 `latestRecord=null`，但 `state` 仍按 live 字段独立计算；只有 live 状态为 `unverified` 且没有历史记录时，才表达“没有人工核实证据”。任何情况都不表达“没有测试”。

### 5.5 名称级历史回归提示

按命中功能的 stableKey 对 `loadRegressionTasks` 返回的 `featureName` 做同样的名称归一化，返回最近最多 5 条非 passed 任务：

```ts
regressionHistory: Array<{
  taskId: number;
  releaseId: number;
  reference: string | null;
  status: "pending" | "failed" | "skipped";
  checkedAt: string | null;
  checkedBy: string | null;
  failureNote: string | null;
  matchBasis: "exact_feature_name";
}>
```

关联只发生在产品内部，按 release 时间和 task ID 稳定倒序。该列表是功能名称级历史提示，不宣称任务中的 reference 与当前场景是同一跨版本身份，也不把 skipped 当成失败。

没有历史任务返回空数组，不推断没有历史缺陷。

### 5.6 候选意图，而非自动契约

风险投影新增：

```ts
recommendedIntents: Array<{
  stableKey: string;
  paths: string[];
  scenarios: Array<{ id: number; reference: string }>;
}>
```

它按 stableKey 确定性分组，只是后续计划候选。Agent 必须根据任务删除无关项，并将需要保持的行为写成 `proposedConstraint`；只有经过开发者或产品负责人确认后，才能在本地计划中标记为 `confirmedConstraint`。

P0 不新增服务端意图存储，不让 MCP 自动把候选意图当成开发者的真实意图。

## 6. P0：低噪声验收结果

`reconcile_release` 继续返回 `sharedEvidenceWarnings` 以兼容旧调用方，同时新增 `informationalSignals`。共享证据只进入信息信号：

- 不再向 `reasons` 添加 `shared_evidence_requires_review`。
- 不再仅因共享证据把 verdict 从 pass 降为 warning。
- `warning` 保留给确定性重复簇、legacy 来源问题等需要复核的异常。
- `failed`、`review` 的既有优先级不变。
- `pass` 仍只表示所提供意图和可读取证据范围内通过，不表示所有行为正确或测试完整。

这是对 verdict 噪声语义的有意修正，不改变原始变化、证据和共享证据数据。本阶段不引入另一套状态枚举；现有 pass/warning/failed/review 的含义保持不变。

## 7. 风险触发工作流

更新 MCP initialize instructions 与工作流文档。完整修改前决策投影用于至少满足一项的修改：

- 行级直接命中、人工维护行为、待重新核实或失败回归；
- 多功能共享文件、身份/权限/版本/数据关联语义；
- 验证证据不足或历史回归区域；
- 跨模块、大范围或调用方难以枚举影响的修改。

轻量流程用于明确低风险修改。没有证据覆盖时必须明说影响面未知，不能跳过项目验证或宣称无风险。

修改前由 Agent 记录任务意图及 proposed constraints，并注明其来源；确认后的约束才能作为验收标准。Agent 负责选择验证方法和执行项目测试，CoDelphi 负责提供行为、历史和验证证据。计划外变化必须回查，不允许通过事后修改意图掩盖异常。

## 8. 后续阶段，不属于 P0 实施范围

### P1：意图交接与历史缺陷提示

- 本地意图文件关联 proposed/confirmed constraints、验证方法和回归测试。
- 使用 `feedback_reports.regression_stable_key` 提供名称级历史缺陷提示，明确不代表完整回归范围。
- 没有显式关联时仍不建立 feedback → verification 或 scenario → test 的推断关系。

### P2：自动验收与更完整的依赖分析

- `verify_push` 组合现有 `wait_for_release` 与 `reconcile_release`，复用修改前已记录的意图，不能事后从 diff 反向编造意图。
- 显式空意图可表示预期零行为变化；未提供意图仍为 review。
- 根据真实误判案例再决定是否建设调用、接口、数据和状态依赖分析。

这些后续项只有在 P0 试点证明决策改善后才进入各自的设计与实施计划，不与 P0 捆绑交付。

## 9. 价值试点与停止条件

建立无自动遥测的试点记录，连续记录至少 20 个真实任务，优先选择陌生模块、跨功能修改或验证证据不足的任务：

- 任务、熟悉程度、风险等级；
- 反查与对账耗时、手工修正参数次数；
- 直接/间接命中数量；
- 独立发现率：CoDelphi 发现而原代码审查和测试尚未发现的问题比例；
- 决策改善率：因 CoDelphi 信息而改变实现、验证范围或发布决定的比例，并记录具体决定；
- 净时间收益：节省时间与额外使用成本之差；
- 无效打扰率：无需行动却需要解释的 warning/提示比例；
- 不用 CoDelphi 是否大概率得到相同结果及理由。

不采集代码正文、密钥或用户隐私。不能用调用次数或对账成功次数证明价值。若试点没有独立发现、没有决策改善且净时间收益为负，应降低强制程度或停止相应流程，而不是继续增加自动化。

P0 自身的开发与对账只证明功能可用，不作为价值假设已经成立的证据。没有合适的真实试点任务时，首条样本保持 pending，不虚构试点结果。

## 10. 测试与生产验收

单元与集成测试至少覆盖：

- hunk 边界、跨 hunk 命中、无行号证据、同场景多证据去重和稳定排序；
- 无直接命中、超过 20 个合并路径、非法行号和非法路径；
- observed behavior、三种 specVerification 状态和 latestRecord 的产品/场景隔离；
- regressionHistory 的名称级关联、非 passed 过滤、最多 5 条、稳定排序和跨版本身份免责声明；
- recommendedIntents 分组，且不自动升级为 confirmed constraint；
- 共享证据只产生 informational signal，缺失、计划外变化和重复簇仍保持原 verdict；
- 旧工具 raw 响应、组织防枚举与现有 reconcile 输入兼容。

生产验收：

1. 用本次真实提交的 hunks 调用风险投影，确认直接命中优先，行为、核实和历史回归均可追溯。
2. 检查没有人工核实记录时不会被描述为测试缺失，名称级历史回归不会被描述为跨版本同一场景。
3. 若 reconcile 只有共享证据，确认不再产生 warning；若存在真实异常，如实报告，不调整意图追求 pass。
4. 建立价值试点记录；本次只填功能验证与耗时，不虚构独立发现或决策改善。

交付前运行 `npm run typecheck`、`npm test`、`npm run build`，随后完成独立代码审查、生产部署和 CoDelphi 对账。
