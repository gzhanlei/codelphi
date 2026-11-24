# CoDelphi MCP `map_change` 变更导航设计（P0 契约修订版）

> 状态：方向评审通过，**实施评审待批准**。本版修订匹配身份、证据有效性、路径生命周期、创建动作、响应预算和分层验收；未获实施批准前不得开发。

## 1. 背景与目标

`lookup_by_files` 解决「文件 → 行为」：开发者已经知道要改哪些文件后，反查影响面。`map_change` 解决其前一步：从「添加 Turnstile 真人验证」「修改登录失败行为」等自然语言意图出发，返回**有证据的候选改动地图**。

```text
map_change(intent)
  → coding agent 阅读实际工作区并确定实施方案
  → lookup_by_files(实际计划修改的文件)
  → 编辑与测试
  → reconcile_release(发布对账)
```

三者分别回答：去哪里检查、改动会影响什么、最终实际改变了什么。

目标：

1. 减少陌生仓库和跨功能任务的首次探索成本。
2. 每条候选路径都有明确匹配依据、原始来源和证据有效性。
3. 对曾经实现后又移除的能力，复用真实历史变更中的组件、路由、配置、文档和测试入口。
4. 返回相关行为约束和历史决策，帮助 agent 发现方案冲突。
5. 明确披露快照、覆盖和未知区域，不把候选地图当成完整实施计划或完备文件清单。
6. 保持 CoDelphi 负责可追溯事实、agent 负责推理与实施、开发者负责确认决策。

非目标：

- 不生成完整实现方案、代码 patch、调用链或完备依赖清单。
- 不修改规格、代码、计划文件或任何远端资源。
- 不把历史行为自动恢复为当前契约，不把历史移除原因当成当前禁令。
- 不承诺找到所有需要修改的文件，不从空结果推断功能不存在或无需修改。
- 不替代 agent 阅读实际工作区，不声称了解未提交改动。
- P0 不新增通用 AI 规划器、自由文本模型调用、符号级依赖图或自动测试选择器。

## 2. 方案与责任边界

采用确定性证据聚合：工具负责检索、匹配降级、校验、去重、排序、来源解释和响应预算；agent 负责阅读代码、推理和实施；开发者负责确认。

P0 不追求通过关键词证明「相同能力」。无法使用强身份依据时，结果必须降级为 `Related` 或 `Lexical only`，不得生成修改或创建建议。P0 接受自然语言强身份召回有限，不承诺任意意图都能可靠解析到相同能力；此时提供确定性历史线索和 `inspect` 入口就是完整结果，不得为显得更有用而放宽身份标准。

## 3. 工具输入

```ts
{
  slug: string;
  intent: string;
  includeHistory?: boolean; // 默认 true
  limit?: number;           // 默认 20，范围 1–50
  offset?: number;          // 默认 0，非负整数
}
```

- `intent.trim()` 必填，最大 2000 字符。
- `includeHistory=false` 只使用当前场景与当前功能邻域，不产生 `no_history` 缺口。
- `limit + offset` 只用于候选路径分页，响应保留去重后的 `totalCount` 与 `hasMore`。
- 沿用组织级鉴权与防枚举语义；无权访问的产品按现有 MCP 约定返回空结果。
- P0 不新增 `paths`、`stableKey` 或 `targetSha` 必填输入；精确反查继续使用 `lookup_by_files`。

## 4. 工具输出

```ts
{
  intent: string;
  snapshot: {
    sha: string | null;
    specVersionId: number | null;
    freshness: LedgerFreshness;
    evidenceCoverage: CoverageReceiptRow | null;
    inputCoverageStatus: "complete" | "partial" | "capped" | "unknown";
    notice: "results_are_bound_to_analysis_snapshot_not_caller_workspace";
  };
  candidates: Array<{
    path: string;
    suggestedAction: "modify_candidate" | "create_candidate" | "inspect";
    role: "ui" | "route" | "domain" | "config" | "test" | "docs" | "other";
    matchTier: "direct" | "historical_direct" | "related" | "lexical_only";
    reasons: Array<{
      summary: string;
      matchTier: "direct" | "historical_direct" | "related" | "lexical_only";
      matchBasis: MatchBasis;
      source: EvidenceSource;
    }>;
    reasonCounts: SecondaryCount;
    validity: "current_observed" | "stale" | "historical_only" | "unknown";
    existsAtSnapshot: boolean | null;
  }>;
  constraints: Array<{
    summary: string;
    kind: "current_observed" | "manual_observed" | "historical_decision";
    source: EvidenceSource;
  }>;
  historicalChanges: Array<{
    releaseId: number;
    repositoryIdentity: string;
    commitSha: string;
    parentShas: string[] | null;
    branch: string | null;
    committedAt: string;
    summary: string;
    relation: "same_capability_added" | "same_capability_removed" | "related_change";
  }>;
  gaps: Array<{
    kind: "no_current_match" | "no_history" | "stale_evidence" |
      "existence_unavailable" | "history_unavailable" | "version_relation_unavailable" |
      "snapshot_unavailable" | "coverage_incomplete" | "source_unavailable";
    summary: string;
  }>;
  returnedCount: number;
  totalCount: number;
  offset: number;
  hasMore: boolean;
  secondaryCounts: {
    constraints: SecondaryCount;
    historicalChanges: SecondaryCount;
    gaps: SecondaryCount;
  };
  responseBytes: number;
  truncated: boolean;
}
```

`LedgerFreshness` 直接复用 `lib/mcp/freshness.ts` 的现有判别联合，`CoverageReceiptRow` 直接复用 `lib/analysis-coverage.ts` 的现有覆盖回执类型；不得在 MCP 边界重新序列化成无 schema 的对象。

```ts
type SecondaryCount = {
  returned: number;
  total: number;
  truncated: boolean;
};

type MatchBasis =
  | { kind: "scenario_id"; stableKey: string; reference: string }
  | { kind: "exact_behavior_text"; stableKey: string; reference: string; textHash: string }
  | { kind: "manual_alias"; aliasId: string }
  | { kind: "shared_evidence"; paths: string[] }
  | { kind: "feature_connection"; stableKeys: string[]; paths: string[] }
  | { kind: "lexical"; terms: string[] };
```

每条 reason 是一个独立的证据判断单元，必须同时携带自己的 `matchTier + matchBasis + source`。候选级 `matchTier` 只是所有未过滤 reason 中的最高等级，用于聚合与排序，不得再单独设置一个可能丢失结构的候选级 `matchBasis`。预算截断时必须首先保留最高等级 reason，并通过 `reasonCounts` 披露实际返回数、总数和是否截断。

`matchBasis` 必须能解释该条 reason 为什么属于其等级。`reasons.summary` 只能摘录或压缩已有场景、发布变化和提交说明，不得生成新的产品事实。

## 5. 匹配契约（P0 核心）

### 5.1 两阶段：意图召回与行为身份解析

匹配必须分成两个独立阶段，不得把「检索到了相关场景」当成「证明了同一能力」。

**第一阶段：Intent Retrieval（意图召回）**

从自然语言 `intent` 分别召回当前场景、历史场景和功能邻域。允许使用分词、名称匹配、场景文本相关度、共享证据、功能邻域和已有人工别名。该阶段只产生候选行为集合及召回依据，不产生 `direct` 或 `historical_direct` 身份结论。

**第二阶段：Behavior Identity Resolution（行为身份解析）**

在召回集合内解析当前与历史行为记录的强身份关系，再计算每条证据关系的 `matchTier`。关键词、名称、相关度和功能邻域只能用于召回，或形成 `related` / `lexical_only`；不得单独产生 Direct。

`exact_behavior_text` 只用于连接两个行为记录，**不负责证明自然语言意图就是某个场景**。例如「添加 Turnstile 真人验证」可以召回登录、注册和 siteverify 历史场景，但仅凭这次召回不能获得强身份；没有 `scenario_id`、已有人工别名或当前—历史强身份链时，候选只能 `inspect`。

未来可以增加模型语义召回，但模型仍只能扩大第一阶段候选集合，不能参与第二阶段的强身份认定；该扩展不改变本设计的动作与证据契约。

### 5.2 匹配等级

| 等级 | 允许的确定性依据 | 允许动作 |
| --- | --- | --- |
| `direct` | 意图中的明确场景 ID 或已有人工别名解析到当前场景，且当前证据有效 | `modify_candidate` |
| `historical_direct` | 召回行为与历史行为可由相同场景 ID、逐字行为内容身份或人工确认别名连接，并有对应 release/diff | 按当前职责证据和 Git 生命周期矩阵决定动作 |
| `related` | 共享证据路径、功能邻域或其他可解释关联 | 只能 `inspect` |
| `lexical_only` | 只有分词、名称或关键词重合 | 只能 `inspect`，不得形成修改或创建建议 |

强身份不是功能名称、`stableKey`、HP/EC/ER reference 或检索相关度分数。它们均不得单独证明跨版本同能力。

P0 可接受的强身份仅限：

1. `scenario_id`：调用意图明确给出 `stableKey + reference`，可解析到具体行为记录；单独出现的 HP/EC/ER reference 不构成跨版本身份。
2. `exact_behavior_text`：当前与历史的 `context/action/outcome` 规范化后逐字一致，并有相同规范路径支撑；计算 SHA-256 `textHash` 供审计。仅描述变化即失去该身份并降级。
3. `manual_alias`：产品内已有明确、可寻址的人工能力映射，可以把意图或行为记录解析到具体场景。P0 不新建别名库，不存在时不得使用。

`shared_evidence` 与 `feature_connection` 只证明实现邻域，不能升级为 Direct。`lexical` 只用于召回与排序末位，不是能力判断。

### 5.3 `exact_behavior_text` 规范化与哈希

P0 冻结以下算法，所有实现与测试使用同一组规范向量：

1. 按 `context → action → outcome` 固定顺序取值，不纳入 feature 名、reference、category、step 或 evidence 内容。
2. 非 null 字符串依次执行 Unicode NFKC、CRLF/CR 转为 LF、去除首尾 Unicode 空白、把内部连续 Unicode 空白折叠为一个普通空格，再执行 JavaScript `toLowerCase()`。
3. null 始终保持 null；空字符串与只含空白字符串规范化为 `""`，二者不得改成 null。
4. 对 `[normalizedContext, normalizedAction, normalizedOutcome]` 使用 JavaScript `JSON.stringify` 生成无多余空白的 JSON 数组，不追加换行。
5. 对该 JSON 字符串的 UTF-8 字节计算 SHA-256，输出小写十六进制 `textHash`。

两个行为只有在 `textHash` 相同且至少一个规范化证据路径相同的情况下，才可使用 `exact_behavior_text` 强身份。哈希相同但路径不同只能是 `related`。

### 5.4 降级原则

- 强身份依据缺失、冲突或无法读取时，逐级降为 `related`；没有关联时保留 `lexical_only`。
- 同一行为拆分、合并或措辞变化，P0 不推断身份，标为 `related` 或 `unknown`，交由 agent 阅读。
- 历史提交说明可以补充意图，但不能替代行为身份或代码 diff。
- 相同名称和相同路径只是必要条件之一，不能单独把历史结果升级为 `historical_direct`。

## 6. 证据来源

`EvidenceSource` 使用可判别联合，所有候选与约束都必须能回到原始记录：

```ts
type EvidenceSource =
  | {
      type: "current_scenario";
      stableKey: string;
      reference: string;
      scenarioId: number;
      path: string;
      startLine: number | null;
      verificationState: "unverified" | "verified" | "stale-verified";
      evidenceFreshness: "fresh" | "stale" | "unknown";
    }
  | {
      type: "manual_observation";
      stableKey: string;
      reference: string;
      scenarioId: number;
      path: string;
      startLine: number | null;
      verificationState: "unverified" | "verified" | "stale-verified";
      evidenceFreshness: "fresh" | "stale" | "unknown";
    }
  | {
      type: "historical_change";
      releaseId: number;
      repositoryIdentity: string;
      commitSha: string;
      parentShas: string[] | null;
      branch: string | null;
      changeKind: "added" | "changed" | "removed";
      path: string;
      pathStatus: "added" | "modified" | "deleted" | "renamed";
      oldPath: string | null;
      newPath: string | null;
    }
  | {
      type: "historical_decision";
      releaseId: number;
      repositoryIdentity: string;
      commitSha: string;
      committedAt: string;
      summary: string;
    }
  | {
      type: "related_scenario";
      stableKey: string;
      reference: string;
      scenarioId: number;
      relation: "shared_evidence" | "feature_connection" | "lexical";
      paths: string[];
    };
```

- `historical_change` 表示代码 diff 事实。
- `historical_decision` 表示提交说明或发布中记录的当时决策与原因。
- 两者不得互相替代；移除原因必须引用真正记录该原因的提交。
- 重命名必须同时保留 `oldPath` 与 `newPath`；普通增删改另一侧可为 null。
- `source=manual` 只产生 `manual_observation`，不自动成为已确认约束或测试通过。

## 7. freshness 与 validity

### 7.1 current_observed 的三项必要条件

只有同时满足以下条件，才能使用 `current_observed`：

1. 场景在当前规格中为 active；
2. 证据路径存在于 `snapshot.sha` 对应仓库树；
3. 既有 freshness 机制明确判定该条证据有效。

现有类型与逐证据判定固定为：

- `snapshot.freshness` 使用 `LedgerFreshness`。`available=false` 时，所有当前证据的 `evidenceFreshness=unknown`。
- `available=true` 时，若场景任一证据路径位于 `changedBehavioralPaths`，该场景为 `evidenceFreshness=stale`；否则该场景为 `fresh`。`changedBehavioralFiles` 只是快照级汇总，不能代替逐路径判断。
- 快照新鲜不等于每条场景证据新鲜；快照有后续变化也不等于所有场景都过期。
- `evidenceCoverage=null` 或 `implFilesTotal=0` 时 `inputCoverageStatus=unknown`；`partitionsCapped=true` 时为 `capped`；`coverageRatio<1` 或 assembled 数小于 total 时为 `partial`；其余为 `complete`。该状态只描述已分析实现输入的覆盖，不证明产品行为完整。
- `unknown/partial/capped` 均增加 `coverage_incomplete`，但摘要必须区分未知、部分覆盖和分片封顶。

状态矩阵：

| active | 路径存在 | freshness | validity |
| --- | --- | --- | --- |
| 否 | 任意 | 任意 | `stale` |
| 是 | 否 | 任意 | `stale` |
| 是 | 是 | 过期 | `stale` |
| 是 | 是 | 未知 | `unknown` |
| 是 | 是 | 有效 | `current_observed` |
| 是 | null（树不可用） | 任意 | `unknown` |

路径级 `validity` 取最强有效来源，但不掩盖冲突来源。被过滤的过期证据通过 `gaps=stale_evidence` 披露。

`verificationState` 继续独立：路径存在且新鲜并不表示人工已核实，更不表示测试执行通过。

### 7.2 快照边界

存在性校验只针对分析快照，不是调用方 HEAD 或未提交工作区。快照树不可用时：

- `existsAtSnapshot=null`；
- 依赖存在性的等级降为 `unknown`；
- 增加 `existence_unavailable`；
- 所有动作降为 `inspect`。

空检索、覆盖不足与快照不可用是不同缺口，不得统一表现为「功能不存在」。

## 8. 路径生命周期与动作矩阵

### 8.1 可比较的 Git 生命周期

历史生命周期不能按 `committedAt` 或 release 先后顺序直接拼接。每条历史变化必须携带 `repositoryIdentity`、`commitSha`、`parentShas`（不可取得时为 null）和 `branch`（不可取得时为 null）；同一仓库、同一 SHA 的重复 release 先合并。

只有在相同 repository identity 内，并能通过 Git 祖先关系确认先后顺序的记录，才进入同一条路径生命周期：

1. 使用代码托管方 commit/compare 能力判断 A 是 B 的祖先、B 是 A 的祖先或二者相同；直接 parent 信息只作为关系证据之一，不能代替跨多个提交的祖先判断。
2. 生命周期还必须与 `snapshot.sha` 可比较；无法连接到分析快照的分支历史单独保留，不与当前路径状态拼接。
3. 无法确认祖先关系的不同分支、无共同祖先、祖先查询失败或 parent/版本信息不足时，不推断最终新增/删除状态，所有依赖该生命周期的动作降为 `inspect`，并增加 `version_relation_unavailable`。
4. `committedAt` 只用于展示，不参与生命周期排序；同一提交内的多个路径事件按规范化路径与状态排序。
5. revert 只是具有普通 diff 的新提交，不猜测其语义；按实际文件事件和祖先关系处理。
6. rename 是原子的 `oldPath → newPath` 生命周期事件。不得把 oldPath 的删除半边解释成可重新创建，也不得把 newPath 的新增半边解释成全新能力；只有后续可比较提交明确再次新增 oldPath 时，才允许重新评估 oldPath 的创建动作。

```text
可比较提交链中的新增 → 修改（0..N）→ 删除/重命名/重新引入（0..N）→ snapshot.sha
```

`create_candidate` 不得只读取首次新增。必须保留完整可比较生命周期及删除原因；历史 diff 或祖先关系不可用则降级。现有 release 的 `sha/before_sha/after_sha` 不足以独立证明该关系，P0 必须向代码托管方补充查询或诚实降级，不能用时间排序代替。现有 `ChangeFile` 也只有 `path/status/patch`，rename 所需 oldPath 必须在适配层补充真实来源；无法取得时按非 rename 信息不足降级，不得推测旧路径。

### 8.2 当前职责与动作判定

历史路径在快照中存在只证明文件存在，不证明它仍承担原来的行为职责。`modify_candidate` 必须有当前有效行为证据；Historical direct 与文件存在性的组合不能单独支持修改建议。

| 当前与历史情况 | validity | suggestedAction |
| --- | --- | --- |
| Direct 当前证据有效，路径存在 | `current_observed` | `modify_candidate` |
| Historical direct 支持，且同一路径还有与历史行为强身份连接的当前有效场景证据 | `current_observed` | `modify_candidate` |
| Historical direct 支持，路径存在，但没有当前有效行为关联 | `historical_only` | `inspect` |
| Direct 当前证据存在但 freshness 过期 | `stale` | `inspect` |
| Historical direct 支持，可比较生命周期末端为新增/重新引入，路径在快照不存在，且意图明确添加同一能力 | `historical_only` | `create_candidate` |
| Historical direct 支持，可比较生命周期末端为删除，路径在快照不存在，且意图明确添加或恢复同一能力 | `historical_only` | `create_candidate`，必须披露已记录的移除原因；意图不明确时 `inspect` |
| 只有 Related 或 Lexical 线索 | 按来源确定，不升级 | `inspect` |
| 只有历史删除 | `historical_only` | `inspect` |
| 快照树、历史 diff、祖先关系或来源不可用 | `unknown` | `inspect` |

`create_candidate` 只表示「可比较历史中存在过该入口，当前快照缺失，且本次意图明确允许创建」，不表示历史实现是当前最佳方案或推荐恢复。

若用户只提出「增加真人验证」而未明确采用 Turnstile，历史 Turnstile 文件只能 `inspect`。自然语言「添加 Turnstile」只表达技术选型意图，仍须先满足第 5 节的身份解析，不能绕过强身份要求直接创建。

P0 不返回 `delete_candidate`。

## 9. 检索、聚合与排序

### 9.1 当前与历史分别检索

1. 当前检索保留场景、证据和核实状态，供独立身份解析使用。
2. 历史独立检索，不回填为当前事实；记录 release、SHA、变化类型、提交说明与真实 diff。
3. 当前无命中不阻止历史；历史无命中不影响当前。
4. 历史不可用保留当前结果并增加 `history_unavailable`。
5. 快照不可用与覆盖不足分别披露。

### 9.2 历史 diff

对相同能力或相关发布读取真实文件状态：

- UI、路由和领域文件作为主要检查入口。
- 配置、文档和测试作为支持入口，不得因没有场景证据而丢弃。
- P0 不返回完整 patch 或文件内容。
- 历史 diff 不可用时保留发布级线索并增加 `history_unavailable`，不得编造文件。

### 9.3 按路径聚合

同一规范路径只出现一次：

- `validity` 由最强有效来源决定。
- `suggestedAction` 由动作矩阵独立决定。
- `reasons` 保留全部去重证据关系，每条各自携带等级与依据，不把其他来源合并进最高等级的 basis。
- 候选级 `matchTier` 取 reasons 的最高等级，其他等级仍用于解释与冲突披露，不重复抬高排序。
- canonical 重复投影不重复计数。

### 9.4 确定性排序

```text
matchTier（direct → historical_direct → related → lexical_only）
→ entryRoleGroup（ui/route/domain → config/test/docs → other）
→ normalizedPath
```

不使用缺乏明确单位的综合分数。候选必须先在全量集合内完成路径去重和上述稳定排序，再应用 `offset/limit` 与字节预算；不得只排序当前页。

相同 `snapshot.sha + specVersionId`、相同召回 release/场景数据版本和相同查询参数必须产生相同顺序。分页一致性不跨分析快照、规格版本或召回数据版本保证。

## 10. 响应预算与截断

### 10.1 字段与数组上限

P0 固定以下上限；上限用于约束单条记录，不替代最终字节预算：

- 候选分页：默认 20，最大 50；`totalCount` 为去重总数。
- 单候选 `reasons`：最多 5 条，并附 `reasonCounts`。
- `constraints`：最多 20 条；`historicalChanges`：最多 10 条；`gaps`：最多 10 条。
- 单条 `summary`：最多 500 个 Unicode code point，超出按确定性规则截断并保留来源。
- 单个 `MatchBasis.paths` 或 `EvidenceSource.paths`：最多 8 条；`feature_connection.stableKeys`：最多 8 条；`lexical.terms`：最多 12 条，每项最多 256 个 code point。
- 单个 `parentShas`：最多 8 项，每项最多 64 个 ASCII 字符；无法完整保留时置 null 并降级，不得留下看似完整的父提交集合。
- 单个路径最多 4096 UTF-8 字节；stableKey 最多 512 UTF-8 字节；reference、aliasId 各最多 128 UTF-8 字节；repositoryIdentity 最多 512 UTF-8 字节；branch 最多 256 UTF-8 字节。超过上限的来源字段不得静默截成另一个身份，应省略该辅助来源、记录截断并降级；候选主路径超限时只返回 `inspect` 和 `source_unavailable`。
- `textHash` 固定 64 个小写十六进制字符；`commitSha` 最多 64 个 ASCII 字符。

辅助计数字段统一：

```ts
{ returned: number; total: number; truncated: boolean }
```

### 10.2 全局排序、分页与硬预算算法

去重和全局稳定排序必须先于分页。`offset` 作用于完整排序集合；调用方下一页使用 `offset + returnedCount`，而不是 `offset + limit`。

48 KiB 是最终结果的硬上限，按以下顺序构造：

1. 建立包含 snapshot、计数和必要信任缺口的最小响应信封。`stale_evidence`、`existence_unavailable`、`version_relation_unavailable`、`snapshot_unavailable` 和 `coverage_incomplete` 属于必要信任缺口，不得为了多返回候选而删除。
2. 从全量排序集合的 `offset` 开始，按序加入候选；每个候选先只带最高等级的一条 reason 和 `reasonCounts`。最小 reason 的 summary 最多 256 个 code point；`paths/stableKeys/terms` 只保留证明该关系所需的最小非空子集，`EvidenceSource` 同理。省略任何元素都记录截断；parentShas 无法完整保留时必须置 null 并把生命周期动作降为 inspect。加入前计算最终字节数，不能容纳整个最小候选时停止，不得留下没有最强来源的候选。
3. 仍有预算时，按候选排序和 reason 等级补充其余 reasons，再依次补充 constraints、historicalChanges 和非必要 gaps。辅助数据不得挤掉已经能放入的主候选。
4. 因预算少返回候选时，`returnedCount` 等于实际数量，`totalCount` 保持全量去重数，`hasMore = offset + returnedCount < totalCount`，且 `truncated=true`。普通 `limit` 分页只设置 `hasMore`，不单独把 `truncated` 标为预算截断。
5. 任何 reason、辅助数组、summary 或受控字段被省略或截断，都将对应计数或 `truncated` 置真；不得通过丢弃来源后假装证据完整。

固定字段上限必须保证「必要信任信封 + 一个最小候选 + 一条最强 reason」不超过预算；P0-B 使用全部字段的最大合法向量验证这一不变量，因而不允许返回会让调用方无法推进 `offset` 的零长度候选页。

### 10.3 `responseBytes` 计算

最终结果采用 JavaScript `JSON.stringify` 的确定性属性构造顺序、无多余空白序列化，按 UTF-8 计算字节数；包含 `responseBytes`、`truncated` 和所有响应字段，不包含 MCP transport envelope。

`responseBytes` 采用不动点计算以包含自身十进制位数：从 0 开始，反复把当前值写入结果并重新序列化，直到「写入值 === 新计算字节数」。每次增删内容后都重新执行该计算；若最终结果超过 49,152 字节，则按第 10.2 节继续移除最低优先级可选项并复算。最大合法响应只有五位数，该迭代必然在有限轮内收敛。

## 11. 约束、缺口与错误

`constraints` 只收录原始证据明确表达的行为限制、兼容要求、安全要求或决策理由，并且必须与命中能力直接相关：

- 当前场景明确规定的错误处理、权限、安全与兼容行为可以收录；普通实现步骤、供应商选择和代码结构只进入 `reasons`。
- 历史发布或提交说明明确记录的移除原因、迁移约束和刻意保留行为可以收录；不得从历史代码采用了某种 Token 校验方式反推它是必须遵循的约束。
- 不使用模型或关键词分类器把普通实现事实提升为约束；归类有歧义时不收录。
- 历史决策只供复核，不自动成为当前约束。

`gaps` 至少区分：

- 检索无命中；
- 账本覆盖不足；
- 证据过期；
- 快照树不可用；
- Git 祖先关系不可用；
- 历史或来源读取失败。

空结果只表示未找到证据，不表示功能不存在。参数错误返回 `INVALID_PARAMS`；部分来源失败返回部分结果与机器可读缺口；只有鉴权、参数或整体运行时失败才使调用失败。

## 12. Turnstile 示例

输入「添加 Turnstile 真人验证」时，工具应：

- 先通过 Intent Retrieval 召回登录、注册和 siteverify 行为，再独立执行身份解析；召回本身不授予 Direct。
- 只在可比较且连接到分析快照的 Git 提交链中建立 Turnstile 组件与 siteverify 文件的新增、修改、删除和重命名序列，不能只读首次新增或按时间拼接。
- 对已删除组件同时存在过期当前场景与历史新增的情况，将当前证据标为 `stale`，不得声称组件当前存在。
- 只有在强身份连接成立、快照中不存在且意图明确允许恢复时，才返回 `create_candidate + historical_only`，并披露移除原因。
- 登录/注册表单、API、配置、文档和测试按各自证据与动作矩阵返回，不因历史组件存在而自动升级为当前事实。
- 将网络可用性原因和 trust-partner 决策标为 `historical_decision`，由开发者决定恢复、替换供应商或采用其他验证方式。

如果无法证明相同能力，所有结果降级为 `inspect`。历史移除原因不禁止重新采用 Turnstile，但也不替开发者选择方案。

## 13. 与现有 MCP 工作流的关系

- `search_scenarios` 用于理解某个既有行为。
- `map_change` 用于变更前导航。
- 实际计划文件确定后仍必须执行 `lookup_by_files`。
- `reconcile_release` 使用开发者确认的真实意图验收；未确认的 `map_change` 候选不得自动转成验收意图。

MCP 指南与仓库工作流改为「先导航、再反查、后对账」，不得宣称 `map_change` 是完整计划。

## 14. 安全与隐私

- 历史路径与发布元数据只能来自同一组织、同一产品，不跨产品补全。
- P0 不返回历史 patch、文件内容、环境变量值或凭证。
- 配置候选只包含路径，例如 `.env.example`；不得读取或返回 `.env` 等秘密文件内容。
- 工具保持只读，不新增任何规格写入能力。

## 15. 分层验证

### 15.1 P0-A：证据正确性

测试至少覆盖：

- Intent Retrieval 与 Behavior Identity Resolution 分离：自然语言关键词召回不能单独产生 Direct；
- `exact_behavior_text` 的字段顺序、NFKC、空白、大小写、null/空字符串、JSON 与 SHA-256 固定测试向量；
- active × 路径存在 × 逐证据 freshness 的完整状态矩阵，快照新鲜与场景过期不得混淆；
- Direct / Historical direct / Related / Lexical 的判定与降级；
- 历史新增、修改、删除、重新引入和原子重命名；
- 同 SHA 去重、跨分支、revert、无共同祖先、祖先查询失败和生命周期无法连接快照时降级；
- 历史 direct + 当前文件存在但无当前职责证据时只能 inspect；
- 快照树、历史 diff 和来源不可用；
- 所有 `EvidenceSource` 类型与原始记录可追溯；
- `verificationState` 不与 validity 合并。

### 15.2 P0-B：导航正确性

测试至少覆盖：

- 完整动作矩阵，尤其历史删除后的创建与 inspect；
- 单路径多来源聚合：每条 reason 独立携带 matchTier/matchBasis，候选最高等级计算正确；
- 最强 reason 保留、reasonCounts 与重复投影去重；
- UI/路由/领域与配置/测试/文档入口保留；
- 所有可变字段上限、最大合法向量、辅助结果和 48 KiB 硬预算；
- `responseBytes` 不动点包含自身字段，最终序列化结果不超过 49,152 UTF-8 字节；
- 全量去重排序后再分页，跨页无重复/遗漏，预算截断后按 `offset + returnedCount` 可继续推进；
- 相同快照与召回数据版本下顺序稳定，跨快照不承诺一致；
- `returned/total/truncated`、`hasMore`、MCP schema、鉴权、防枚举和只读约束。

P0-A 未通过不得进入 P0-B。

### 15.3 P0-C：真实任务价值

首轮试点聚焦两类最能体现增量价值的任务：**历史能力恢复**（曾经实现、后来删除的功能）与**跨功能变更**（相关行为入口散落在多个功能中）。不用大量普通 CRUD 任务证明召回率。

实验要求：

- 使用独立任务实例和独立上下文，对照组不得看到实验组的导航结果、历史信息或评审结论。
- 保持相同仓库快照、任务描述、模型与推理配置；不得让同一上下文的先前探索污染后续对照。
- 由独立评审者依据代码、测试或人工确认判断必要入口、关键约束和真正的增量发现。

分别记录：

- **有效增量发现**：基线遗漏但 `map_change` 发现的必要入口或关键约束；
- **错误增量发现**：错误身份、错误职责、错误生命周期或不适合的候选；
- **重复发现与漏报**：基线已经发现的信息，以及两组都遗漏的必要信息；
- **决策促成**：发现如何改变实现、验证或供应商选择；
- **额外探索成本**：错误候选造成的返工、源码搜索、计划时间和上下文开销；
- 候选采用率、当前/历史混淆次数（目标为零），以及空结果与低覆盖时是否正确回退源码探索。

只有净收益为正，且至少一项经独立评审确认的增量发现或决策改善，才支持扩大投入。单次成功不能替代证据与导航门禁。

## 16. 阶段范围与已确认决策

### P0

- 一个只读 `map_change` 工具。
- 意图召回与行为身份解析分离、强身份匹配与降级、当前/历史证据、真实 diff 元数据、快照存在性校验。
- 可比较 Git 祖先链上的路径生命周期、当前职责证据、动作矩阵、确定性聚合排序、逐来源匹配、约束、缺口和 48 KiB 硬预算。
- P0-A/B/C 分层验收。

### 后续仅在价值验证后考虑

- 更丰富的语义召回与跨版本稳定行为身份。
- 更细的实施角色和测试映射。
- 对已有证据的生成式压缩摘要。
- 符号、调用和依赖级实施导航。

### 已确认决策

- 结果只保证分析快照坐标；调用方工作区由 agent 自行核实。
- 不新建另一套产品事实数据库，复用现有场景、发布、证据与仓库元数据。
- `stableKey` 与 scenario reference 不是跨版本同能力身份。
- 无法证明相同能力时宁可返回 `inspect`，不得为了结果丰富而升级动作。
- 本设计仍待实施评审，不代表开发已获批准。
