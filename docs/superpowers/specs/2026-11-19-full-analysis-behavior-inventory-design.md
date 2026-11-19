# 全量分析行为清单与定向补漏设计

日期：2026-11-19
状态：设计冻结，进入实施计划

## 1. 背景与问题

首次分析和全量重建当前通过 `getPartitionedAnalysisSources` 装配实现面，再让每个分区自由提取功能与场景。该路径已经不是固定 6 分区，但分区仍受文件数、行区间和内容字节预算约束，单次提取还包含「每个功能保留最关键的 1-5 个场景」的选择性契约。

生产 run 397 的全量重建从积累账本 1131 条场景降到 584 条，坍缩护栏拒绝了激活。这证明：文件进入上下文不等于文件中的行为进入规格。

2026-11-19 增加的收敛轮仍对同一批分区重复自由提取，以边际新增场景数小于 ε 停止。它能够增加发现机会，但存在三个根本问题：

1. 重复阅读没有独立的遗漏分母，无法回答哪些代码从未被逐项提问。
2. 边际新增为零只表示本轮没有新增，不表示既有结果已经覆盖全部行为。
3. 场景总数会受重复、拆分、合并和错误候选影响，不能直接充当召回率。

W0-8/W0-9 已提供「确定性清单 + 逐项回答 + 复述/判定分离」的雏形，但其清单来自窗口 diff，只覆盖变更文件，且有组数上限；首分析无 diff 时不能承担全量主路径。

本设计把目标限定为：对于给定 revision 和 scope，证明所有纳入分析范围的实现代码都得到处理，每一个已识别的行为锚点和每一个未识别代码区域都有可追溯结论；无法判断的部分明确保留为未决，而不是静默遗漏。语义正确性继续由独立人工预标验证。

## 2. 目标

- 首分析与全量重建以确定性的行为单元清单为主路径，不再以重复全库阅读作为完整性依据。
- 清单同时覆盖可识别语义入口和全部未认领实现文件/区间；未知框架与解析失败不得静默消失。
- 代码主覆盖与行为锚点核销是两个独立门禁；代码被大单元认领不代表内部行为已核销。
- 每个单元和单元内锚点都有可审计的提取、内部实现或未决结论。
- 失败、遗漏和证据异常只触发定向补跑，不重翻整个仓库。
- 断点恢复使用不可变清单快照和执行租约，不混用检测器版本，不把数据库唯一键误认为 exactly-once 调用。
- 处理完整性、行为正确性和分析运行状态分别表达，不用单一场景数或百分比互相替代。
- 全量候选结果在单元未完成时不得激活为新的完整基线，既有可用规格不受影响。
- 保留证据清洗、行为等价合并、坍缩护栏、`source = 'manual'` 保护和真实 LLM 调用回执。

## 3. 非目标

- 不改变定向增量与 RC2-carry 的现有主路径；W0-8 继续服务 diff 行为枚举。
- 不在本期根据单元清单重写增量影响分析。
- 不实现跨 revision 的可靠行为身份关联；第一期只保证同 revision、同 scope、同检测器版本的完全确定性。
- 不引入 AST 指纹、语义哈希或复杂跨版本匹配算法。
- 不承诺静态分析能够发现运行时配置、外部数据或部署期开关产生的行为。
- 不把「全部单元已处理」声明为「检测器发现了所有真实行为」或「AI 的语义解释全部正确」。
- 不改变用户侧 1 SAU/run 的计费契约，不把内部 token 成本估算变成固定报价。
- 不新增产品页内部装配指标，不修改历史 run、历史规格或历史覆盖率回执。
- 不在本期引入新的语言解析器依赖；优先使用现有源码索引、信号扫描和可测试的确定性检测器。
- 不执行生产部署、数据库数据修复或历史全量重跑。

## 4. 核心决策

### D1：采用「语义单元 + 剩余实现面」双层清单

语义单元用于让提取任务具有产品行为意义，剩余实现面用于保证分母不依赖框架识别能力。两者缺一不可。

只枚举页面、API、任务和 CLI 会漏掉库函数、共享业务规则、事件订阅、权限逻辑和未识别框架；只做文件清单又会把大型入口文件内部的分支重新变成注意力问题。因此单元由两层组成：

1. **语义单元**：框架入口、公开接口和可识别行为锚点。
2. **剩余单元**：没有被语义单元主覆盖的实现文件或文件区间。

数据表、配置和迁移默认作为关联证据，不独立凑单元数；只有其约束直接形成外部行为时，才作为对应语义单元的锚点或证据。

### D2：主覆盖与锚点核销解耦，未识别区域必须进入审查

实现面沿用当前产品的 scope roots、索引 prune 规则和 `evidenceKind(path) === "implementation"` 口径。测试、文档、二进制、构建产物及其他既有排除项保留既有语义；排除事实和不可读事实分别记录，不能混入「无行为」。

清单生成后必须满足：

```text
eligibleImplementationRanges
  = semanticPrimaryRanges ∪ residualPrimaryRanges

unitPrimaryRanges
  = union(unit.behaviorAnchorRanges, unit.implicitReviewAnchorRanges)
```

锚点分三种角色：

- `entry`：route 注册、命令注册、任务注册等入口定位，只用于身份与导航，不能单独证明 handler 内部已核销。
- `behavior`：可识别的权限、校验、状态转换、错误分支、外部调用、公开符号等行为点。
- `implicit_review`：单元主范围内未被 behavior 锚点覆盖的剩余代码区域，必须继续交给 AI 审查。

约束如下：

- entry 锚点不计入 `anchorAccountingComplete` 的已完成分子；其关联 handler 必须由 behavior 或 implicit_review 锚点覆盖。
- 每个主覆盖区间必须至少属于一个 behavior 或 implicit_review 锚点，不允许出现「函数归 route 单元后，内部未识别代码退出审查」。
- 检测器只识别 route + handler 时，handler 整体形成一个 coarse implicit_review 锚点；识别出更多控制流时，剩余区域继续生成 implicit_review 锚点。
- coarse implicit_review 表示检测粒度较粗，必须计入账本；它要求 AI 审查整个区域，但不能被对外解释为检测器已找到该区域的所有真实行为。
- 主覆盖区间互不重叠；锚点区间可以因行为组合而重叠，重叠不改变主覆盖计数。
- 跨单元依赖只作为上下文，不重复计入主覆盖。
- 无法解析的文件生成 whole-file 剩余单元和 whole-file implicit_review 锚点。
- 单 blob、单次读取等安全限制导致内容不可读时保留 whole-file 占位单元并生成失败状态；占位单元的 `primaryRanges=null`，成功读取并生成确定区间前，主覆盖门禁不得通过。

因此必须分别通过：

```text
primaryCoverageComplete = 所有实现区间都有单元主覆盖
anchorCoverageComplete  = 所有单元主区间都有 behavior/implicit_review 锚点
anchorAccountingComplete = 所有上述锚点都有有效终态结论
```

三者不能互相替代。

区间计算统一遵守：

- 所有区间按规范化 path 分组，使用整数闭区间 `[startLine, endLine]`，且 `1 <= startLine <= endLine`。
- 覆盖计算先做 interval union；重叠区间和整数行上相邻的区间（如 `[1,10]` 与 `[11,20]`）合并后计数，禁止把各锚点长度直接求和。
- 每个 behavior/implicit_review 锚点区间必须是所属单元 primaryRanges 的子集；越界时 manifest 校验失败。
- `anchorRangesCovered` 与 `anchorRangesOmitted` 分别由唯一代码区间并集和差集计算，同时保留规范化后的区间清单与唯一行数，不能只保存聚合计数。
- 主覆盖与锚点覆盖分别验证；区域被分配给锚点不代表锚点已经正确识别真实行为。

### D3：unitKey 只承诺同 revision 确定性，并定义冲突规则

稳定性分为两个等级：

| 等级 | 本期承诺 |
|---|---|
| 同 revision 稳定 | 同一源码、scope、检测器 registry 和 inventory schema 重复生成，key、顺序、区间完全一致 |
| 跨 revision 可关联 | 本期不承诺，不以行号 key 冒充逻辑身份 |

定位规则：

- HTTP：规范化 route + method + 注册文件 + handler 身份。
- CLI：命令路径 + 注册文件 + handler 身份。
- Job/Event：注册标识 + 注册文件 + handler 身份。
- public API：规范化导出路径 + qualified symbol；重载增加签名或稳定重载序号。
- symbol range：文件路径 + qualified symbol；匿名符号使用 `anonymous@path:startLine:startColumn`。
- 无法识别符号的确定性行块：文件路径 + `chunk:startLine-endLine`，仅保证同 revision 稳定。
- whole file：文件路径，不包含行号或内容 hash。

重复注册与冲突处理：

1. handler 优先使用 qualified symbol；匿名 handler 使用注册位置。
2. 同 route + method 多次注册时加入注册文件与 handler；仍相同则按 path、line、column 排序加入 occurrence ordinal。
3. 动态注册无法确定规范化入口时，不伪造语义 key，生成剩余文件/符号单元并记录 `dynamicRegistrationFallback`。
4. 所有 key 在 manifest 完成前做唯一性校验；冲突未按上述规则消解时清单生成失败，不能静默覆盖另一单元。

文件内容 hash 和 AI 生成名称不进入 unitKey。行号只允许作为同 revision 的匿名符号或兜底块定位符，不作为跨 revision 关联依据。

### D4：单元提取取消显著性数量帽，内部实现必须分类

每个单元作为独立提取任务：

1. **复述步**：只描述各 behavior/implicit_review 锚点对应的代码事实、输入、控制流和外部结果，不判断是否值得写入。
2. **判定步**：逐锚点分类为外部行为、内部实现或未决；拿不准时按现有 W0-9 原则偏向计入。
3. **校验步**：沿用 zod、证据允许集和 `sanitizeEvidence`，清洗后重新计算单元与锚点状态。

单元提取不得使用「每个功能只保留 1-5 个场景」或等价的重要性数量限制。提取阶段尽可能完整，合并阶段消除重复，展示阶段控制信息密度。

`reviewed_internal` 的理由必须归类为：

- `pure_technical`：纯技术辅助，无独立外部效果；
- `covered_elsewhere`：被其他行为调用，已由关联单元或场景表达；
- `data_transform`：内部数据转换，不产生独立外部效果；
- `other_evidence_backed`：其他有明确证据的内部实现。

内部实现不等于没有产品行为，没有独立用户入口也不等于无行为。共享业务、权限、状态转换、数据库写入、外部 API 和事件发布函数不能仅因「被调用」就判为内部实现。

`covered_elsewhere` 必须提供 `relatedUnitKeys` 或 `relatedScenarioRefs`；最终合并后验证关联仍存在，关联缺失则该锚点回到 unresolved。其他内部实现理由必须解释为何不存在独立外部效果并附证据。

单元任务不依赖其他单元当轮生成的功能名，避免并发和重试改变提取结果。全量重建读取既有功能名作为稳定命名锚；首分析由各单元独立命名，最终沿用确定性合并与既有变体折叠处理跨单元别名。

### D5：「无行为」是受控终态，不是空结果别名

单元状态定义如下：

| 状态 | 判定条件 |
|---|---|
| `pending` | 尚未执行或等待定向补跑 |
| `running` | 已被有效租约领取，正在读取、调用或提交 |
| `extracted` | 至少一个场景通过证据校验，且不存在未解决锚点 |
| `no_behavior` | 无保留场景，但全部 behavior/implicit_review 锚点均有带证据的内部实现结论 |
| `unresolved` | 存在未解决锚点、模型空答、判断不确定或候选全部被清洗 |
| `failed` | 读取、调用、解析等硬失败在定向重试后仍存在 |

以下情况不得标记为 `no_behavior`：

- AI 返回空 features 但没有逐锚点内部实现结论；
- JSON 解析失败或调用超时；
- 证据路径越界或候选全部被清洗；
- 文件不可读、内容被截断或检测器失败导致没有 fallback；
- 含明确入口/行为信号，却只有一句无证据的「无行为」。

`no_behavior` 的锚点结论保留在单元回执中，供后续审计；它表示本轮形成完整判定，不表示该判定永远正确。

### D6：主内容与辅助上下文分别有硬预算，超限确定性拆分

首版每个单元的源码输入预算为：

- 主内容最多 96KB；
- 辅助上下文最多 32KB；
- 主内容与辅助上下文合计最多 128KB，给 prompt 指令和输出保留空间；
- 每次调用仍受现有 `analysisSliceBudgets.maxAiContextSourceBytes` 和模型网关限制约束。

超预算不修改原始 unitKey 或 anchorKey，而是在 manifest 内生成确定性执行任务 `taskKey = unitKey + taskOrdinal`。单元负责代码与行为身份，执行任务负责输入分片、并发、租约和调用预算；单元状态由其执行任务与锚点结论聚合。

执行任务按以下顺序确定性生成：

1. 按 behavior/implicit_review 锚点分组；
2. 按 qualified symbol、导出或子命令分组；
3. 在不破坏控制流和证据区间的前提下按稳定行区间分片。

锚点优先完整分配给一个执行任务。单个锚点仍超预算时，生成 `anchorFragmentKey = anchorKey + fragmentRange + fragmentOrdinal`；每个分片有独立输入和结论，只有全部分片完成后才能聚合出该锚点终态。任何 worker 都不得仅凭一个分片核销完整锚点，也不得让两个任务独立核销同一个完整锚点。

所有执行任务与分片关系在 manifest 首次持久化前确定，运行中不得为绕过预算临时增加任务。无法安全拆到预算内的单元标记 unresolved，不允许截断内容后获得成功状态。

上下文分三类：

- **主内容**：本单元负责核销的代码，完整进入 prompt；
- **辅助上下文**：理解主内容所需的最小依赖符号区间，使用独立预算；
- **关联证据**：只提供路径、符号和引用关系，不重复读取完整内容。

共享业务服务由自己的语义或剩余单元完整分析。引用它的 route 只读取相关签名、调用点或最小实现区间，不在每个 route 中重复附整份服务文件。

### D7：定向补跑使用执行租约，恢复使用不可变 manifest

全量主路径只补跑 `pending / failed / unresolved` 单元；已成功 `extracted / no_behavior` 单元不在同一 run 中重复提取。硬失败重试一次，语义未决用缺失锚点定向复核一次；复核后仍未决则停止激活。边际场景新增量只作诊断，不再作为完成条件。

每个执行任务使用租约：

- 领取时通过条件 UPDATE 原子写入 `running`、`lease_owner`、`lease_expires_at`、`attempt_id` 并增加 attempts；
- 只有 pending、允许重试的 failed/unresolved，或租约已过期的 running 任务可以被领取；
- 执行期间按现有 run 心跳节奏续租，租约时长覆盖 `AI_TIMEOUT_MS` 与提交余量；
- 提交结果时校验 run_id、task_key、attempt_id、lease_owner 和 running 状态，只有匹配当前尝试才允许写入终态；
- 过期尝试的迟到结果不得覆盖新尝试结果，但其 LLM 回执必须保留；
- 已完成失败的重试次数受补跑契约限制；崩溃造成的过期租约可以重新领取，但仍受运行预算约束。

外部 LLM 调用与数据库提交不能组成原子事务，因此本设计提供的是 **at-least-once 执行 + 条件提交幂等**，不是 exactly-once。重复调用通过 unit_key、attempt_id 和调用回执可审计。

每个 run 在首次派发前写入不可变 manifest，固定：

- afterSha 与 canonical scope fingerprint；
- detector registry version 与 inventory schema version；
- 完整 canonical manifest JSON 与 manifest hash；
- 单元、锚点、区间和稳定排序；
- 生成时间。

manifest 采用应用层 insert-only 契约：只允许首次 INSERT，已存在时禁止覆盖，恢复时重新计算 hash 并验证 manifest_json。恢复不得重新扫描后覆盖原清单，也不得通过 UPDATE/REPLACE 修复版本冲突。

恢复时读取已存 manifest，不重新扫描并混合新清单。若请求恢复时的 revision、scope fingerprint、detector registry version 或 inventory schema version 与 manifest 不一致，返回 `inventory_version_conflict` 并拒绝在原 run 继续；第一期不自动迁移，必须创建新 run。

现有 `analysis-recovery.ts` 的「孤儿 run 没写最终规格，所以重跑即幂等」假设只适用于旧路径。新路径恢复必须复用 manifest、已成功 result_json 和单元租约，不能重新生成清单或重跑全部单元。

### D8：激活门禁由多个独立条件组成

最终落库前必须满足：

```text
runEligibleForActivation =
    inventoryManifestValid
    AND primaryCoverageComplete
    AND anchorCoverageComplete
    AND anchorAccountingComplete
    AND allUnitsInAllowedTerminalStates
    AND existingEvidenceChecksPassed
    AND existingMergeChecksPassed
```

其中：

- allowed terminal states 仅指 `extracted / no_behavior`；
- `existingEvidenceChecksPassed` 表示现有证据门禁已经执行且没有遗留未决引用，不要求历史或当前账本从未出现清洗告警；
- `existingMergeChecksPassed` 包括现有坍缩、身份和合并激活约束；
- 产品简介属于派生元数据，不属于该公式，按 D10 独立降级。

存在 pending/running/failed/unresolved 时不激活新规格版本，既有激活规格保持不变；已持久化的单元回执用于断点续跑。首分析没有既有规格时，失败 run 只保留诊断和可续跑状态，不生成自称完整的规格。

### D9：事前估算与运行预算分离，预算维度不能混用

清单生成后、AI 提取前记录：

- 语义单元、剩余单元、behavior/implicit_review 锚点数量；
- 每单元主内容与上下文 bytes；
- 按语言和源码类型历史样本估计的输入 token 区间；
- 复述输出、判定输出和最终摘要的输出 token 区间；
- 基础调用、一次硬失败重试、一次语义复核和摘要调用的最大调用数。

bytes 不直接等同于 tokens。事前区间来自历史调用样本；运行中根据实际回执更新已完成成本与预计剩余成本。

可配置预算是三个独立维度：

- `maxLlmCalls`；
- `maxTotalTokens`；
- `maxCostAmount` 及其 currency。

每个 run 使用共享预算账本和原子预留，不允许 worker 根据各自读取的旧余额独立派发：

- 领取执行任务前，通过条件 UPDATE 原子预留该任务可能发生的最大调用数，覆盖复述、判定及允许的补跑；预算不足则不得领取。
- 最终摘要的调用、token 和费用估算独立预留，不与单元抢占。
- 每次调用后根据 llm_call_receipts 结算实际消耗；任务终态时释放未发生的预留。
- 租约过期时，旧尝试的预留在其调用结算或租约回收前保持占用；重新领取必须重新检查并预留预算，不能假定旧预留足够。
- `maxLlmCalls` 通过原子预留严格执行；输入 token 按区间上限预留，输出 token 和费用按预计上限预留并以实际回执结算。
- 配置 token 或费用硬上限时，对应 usage/费用未知即停止新的派发，不得按零成本放行。

任一硬预算达到后停止派发新任务并标记 run 未完成，不通过减少剩余单元、跳过摘要或丢弃重试记录伪装完成。并发在途调用和估算误差可能造成实际 token/费用 overshoot，必须如实披露；maxLlmCalls 不允许通过并发竞态超额。

实际费用仍以 `llm_call_receipts` 为准，用户侧 1 SAU/run 定价不变。

### D10：产品简介是派生产物，失败不阻断行为规格

单元提取只返回功能、场景和内部实现审计候选，不让每个单元重复生成全库产品简介。

全部单元合并后，使用一次独立摘要调用生成产品简介；摘要只能引用合并结果中的功能与证据，不得增加新的产品事实。发布变化继续由最终规格的 `spec_changes` 和现有发布链路生成，不由单元自由撰写 changelog。

摘要调用失败时：

- 全量重建保留既有产品简介；语言切换时不得保留旧语种简介；
- 首分析或语言切换没有可用简介时，保存空简介与空证据，记录 `product_description_unavailable`；
- 记录 `productDescriptionStatus = generated / preserved / unavailable`；
- 行为规格仍可激活，摘要失败不计作单元失败，也不构成行为完整性的证明。

摘要调用次数在 D9 中提前预留，不能因单元超支而静默跳过。

## 5. 清单与数据模型

### 5.1 Manifest

新增 run 级 `analysis_behavior_manifests`：

- `run_id` 唯一；
- `after_sha`、`scope_fingerprint`；
- `inventory_schema_version`、`detector_registry_version`；
- `manifest_json`、`manifest_hash`；
- `inventory_generated_at`。

`manifest_json` 是恢复时唯一有效的单元清单来源。hash 用于检测持久化内容被改写，canonical JSON 的序列化规则纳入 inventory schema version：对象 key 按码点排序，单元/任务/锚点按各自确定性 key 排序，区间先规范化再排序，缺省可选字段使用统一空值规则，禁止依赖语言默认对象序列化。

### 5.2 单元与锚点

```ts
interface BehaviorUnit {
  unitKey: string;
  kind: "http" | "page" | "cli" | "job" | "event" | "public_api" | "file" | "symbol_range";
  primaryPath: string;
  primaryRanges: Array<{ startLine: number; endLine: number }> | null;
  contextRanges: Array<{ path: string; startLine: number; endLine: number }>;
  anchors: BehaviorAnchor[];
  detector: string;
  detectorVersion: string;
}

interface BehaviorAnchor {
  anchorKey: string;
  role: "entry" | "behavior" | "implicit_review";
  ranges: Array<{ startLine: number; endLine: number }>;
  evidence: Array<{ path: string; startLine?: number }>;
  coarse: boolean;
}

interface BehaviorExecutionTask {
  taskKey: string;
  unitKey: string;
  anchorFragments: Array<{ anchorKey: string; anchorFragmentKey: string; ranges: Array<{ startLine: number; endLine: number }> }>;
}
```

- `anchorKey` 由 manifest 中的规范化代码定位信息生成，包括 path、qualified symbol/区域角色、规范化区间和必要 occurrence ordinal，不依赖 AI 输出，也不因执行任务拆分而改变。
- `primaryRanges=null` 只表示不可读 whole-file 占位，不表示已覆盖；其他单元必须给出闭区间行范围。
- entry 锚点只用于定位，不参与完成分子；behavior/implicit_review 锚点必须覆盖全部主区间。
- `coarse=true` 表示检测器只能提供粗粒度审查区域，单独进入诊断指标。
- taskKey 只标识执行分片，不替代 unitKey/anchorKey 的分析身份。

### 5.3 锚点结论与场景多对多映射

```ts
interface BehaviorAnchorReceipt {
  anchorKey: string;
  evidence: Array<{ path: string; startLine?: number }>;
  disposition: "extracted" | "reviewed_internal" | "unresolved";
  internalKind?: "pure_technical" | "covered_elsewhere" | "data_transform" | "other_evidence_backed";
  reason?: string;
  scenarioRefs: string[];
  relatedUnitKeys?: string[];
  relatedScenarioRefs?: string[];
}
```

- `extracted` 至少有一个有效场景引用；
- `reviewed_internal` 的 `scenarioRefs` 必须为空，关联表达只能使用 related 字段；
- `unresolved` 不得被最终核销逻辑当作已完成；
- 没有证据的内部实现结论按 unresolved 处理。

一个锚点可对应多个场景，一个场景也可由多个锚点或单元共同支撑。身份责任分四层：unitKey 标识确定性分析单元，anchorKey 标识确定性审查区域，localScenarioKey 标识已持久化单元结果内的提取记录，finalScenarioId 标识最终规格场景。

`localScenarioKey = unitKey + anchorKey + deterministicOrdinal`，不包含 AI 生成的 feature 名称或场景名称。锚点跨任务分片时，先汇总该锚点全部清洗后的分片结果，再按证据 path/startLine、category、规范化 context/action/outcome 稳定排序并分配补零序号。AI 的 HP-n/EC-n/ER-n 仅是内容字段，不承担局部身份。

localScenarioKey 的稳定性只承诺在同一已持久化单元结果内；不同 LLM 调用产生相同语义结果时不要求获得相同 key，不引入语义哈希。重试产生新结果时，必须整体替换该锚点的局部场景集合与映射，不能追加不同 ordinal 的旧结果。

新增 `analysis_behavior_anchor_scenarios` 关联记录：

- run_id、unit_key、anchor_key、local_scenario_key；
- final_scenario_id 可空，最终合并后回填；
- 唯一约束防止同一锚点重复关联同一局部场景。

最终合并建立 localScenarioKey 到 final scenario 的独立映射。重新编号、跨单元合并或引用重分配不得改写锚点原始结论；无法建立有效映射时锚点回到 unresolved。跨单元同场景必须允许多个锚点指向同一 final_scenario_id。

### 5.4 执行任务回执表

新增 run 级执行任务回执表，概念字段包括：

- 单调 `BIGINT UNSIGNED` 主键；
- `run_id`、`task_key`、`unit_key`、`kind`、`primary_path`；
- `primary_ranges`、`context_ranges`、`anchor_fragments`、`anchor_receipts`、`result_json` JSON；
- `status`、`attempts`、`scenario_count`、`reviewed_count`、`unresolved_anchor_count`；
- `lease_owner`、`lease_expires_at`、`attempt_id`；
- `detector`、`detector_version`、`last_error`；
- `created_at / updated_at`。

约束与索引：

- `UNIQUE(run_id, task_key)` 保证执行任务记录与结果提交幂等；
- `INDEX(run_id, unit_key, status)` 支持聚合单元状态；
- `INDEX(run_id, status)` 支持只查询待补跑任务；
- `INDEX(lease_expires_at, status)` 支持过期租约恢复；
- 使用 InnoDB、`utf8mb4` 和项目现有时间/外键约定；
- `result_json` 保存清洗后的任务结果，进程恢复时按 manifest 聚合单元，无需重新调用已成功任务；
- 完整性账本 `details` 只保存汇总和缺失单元清单，不复制全部单元结果。

`llm_call_receipts` 增加可空的 `task_key`、`unit_key`、`attempt_id`、`call_stage`，用于区分复述、判定、语义复核和摘要；历史回执保持 NULL。重复执行不得删除任何调用回执。

新增 `analysis_run_budgets` 共享预算账本，记录三类上限、预留量、实际结算量、currency、summary reservation 和版本号。所有预留与结算使用条件 UPDATE 或等效原子数据库操作，禁止先 SELECT 余额再由应用无条件写入。

AI 调用和源码 I/O 保持在数据库事务外；每个执行任务完成后单独条件提交，再聚合单元状态。最终规格写入继续沿用现有事务，避免长事务和外部 I/O 持锁。

## 6. 模块与流程设计

### 6.1 新模块边界

新增：

- `lib/behavior-inventory/`：单元类型、框架检测器、剩余区间与 implicit_review 计算、manifest 生成。
- `lib/full-analysis.ts`：全量单元编排、manifest 校验、租约、断点恢复、定向补跑和激活门禁。
- `lib/behavior-unit-extraction.ts`：单元复述/判定、锚点核销、内部实现分类和状态推导。
- `lib/behavior-unit-receipts.ts`：manifest、单元回执、场景关联和租约持久化。

既有模块的复用方式：

- `lib/remote-source-index` 提供固定 revision 的目录、元数据和行区间读取。
- `lib/analysis-coverage.ts` 提供实现面枚举口径；新区间覆盖回执必须与其使用同一实现面，不另造 scope 规则。
- `lib/architecture/signals.ts` 与 `lib/architecture/detectors/` 提供入口信号和依赖遍历经验，但行为清单使用更细粒度单元，不直接复用应用级架构节点。
- `lib/ai.ts` 增加全量单元 prompt；W0-8 diff prompt 保持独立。
- `lib/extraction-merge.ts` 继续负责确定性合并与审计计数，并输出局部场景到最终场景的映射。
- `lib/completeness-ledger.ts` 继续使用 `behavioralEnumeration` 维度，扩展其 details，不新增单一质量百分比。
- `lib/analysis.ts` 只选择全量编排路径，不把检测器、状态机和补跑细节继续堆入该文件。
- `lib/analysis-recovery.ts` 区分旧路径重跑与新路径 manifest/租约恢复，不再假定所有孤儿 run 都没有可恢复中间产物。

### 6.2 主流程

```text
固定 afterSha 与 scope
  → 枚举 eligible implementation surface
  → 确定性扫描语义单元、entry 与 behavior 锚点
  → 为未识别主区间生成 implicit_review 锚点
  → 计算剩余文件/区间并生成剩余单元
  → 校验 key、主覆盖、锚点覆盖、预算与稳定排序
  → 持久化不可变 manifest 与待处理单元，记录事前预算
  → 原子预留预算，有界并发领取带租约的待处理任务
  → 每任务复述 → 判定 → 证据清洗 → 分片提交 → 聚合锚点与单元状态
  → 仅补跑失败或未决单元
  → 预检 manifest、主覆盖、锚点覆盖和单元终态
  → 确定性合并全部清洗后单元结果，回填并验证场景映射
  → 生成或降级产品简介，派生既有发布事实
  → 再次校验完整激活门禁（含映射、证据与合并检查）
  → 在最终事务中保存并激活规格，写完整性账本
```

单元并发只改善耗时，不改变清单、prompt 输入或最终稳定排序。恢复时按 manifest 和 unitKey 读取已成功结果，不依赖执行顺序。

三个阶段严格分离：

1. 单元结果逐条持久化，不写最终规格；
2. 合并结果与派生元数据在事务外生成，失败不破坏旧规格；
3. 全部门禁通过后，最终规格在一个事务中保存和激活。

### 6.3 覆盖与账本口径

`behavioralEnumeration` 至少记录：

- `unitsTotal / unitsRunning / unitsExtracted / unitsNoBehavior / unitsFailed / unitsUnresolved / unitsPending`；
- `anchorsTotal / anchorsExtracted / anchorsReviewedInternal / anchorsUnresolved`；
- `entryAnchors / behaviorAnchors / implicitReviewAnchors / coarseReviewAnchors`；
- `semanticUnits / residualUnits`；
- `implementationRangesTotal / primaryRangesCovered / primaryRangesOmitted`；
- `anchorRangesCovered / anchorRangesOmitted`；
- `inventoryDetectorFailures / dynamicRegistrationFallbacks / unreadablePaths / truncatedRanges`；
- `repairAttempts / resumedUnits / expiredLeases / duplicateAttempts`；
- `productDescriptionStatus`。

检测与读取失败分开记录：

- `detectorUnsupported`：没有对应框架检测器；
- `detectorParseFailure`：检测器存在但解析失败；
- `fallbackInventorySuccess`：剩余清单已成功认领，仍可执行行为分析；
- `sourceReadFailure`：源码本身不可读，主覆盖不能完成。

前两种在 fallback 成功时不导致 run 失败，但必须披露检测能力缺口；sourceReadFailure 会阻断激活。检测器没有认出入口 ≠ 没有发现行为 ≠ AI 无法分析代码 ≠ 源码无法读取。检测器失败是能力缺口，不是代码分析失败；只要剩余区间和 implicit_review 已生成，文件仍必须接受 AI 审查。

新路径的 `sourceCoverage` complete 必须要求主覆盖区间遗漏为零，文件数和字节数只作辅助诊断，不能仅凭「装配数大于零且未触分区帽」推导。旧回执保持历史语义。

单元处理比例只作为该维度诊断计数，整体状态仍由现有最差维度规则推导，不生成新的综合质量分。

## 7. 错误处理与恢复

| 故障 | 处理 |
|---|---|
| 检测器不支持或解析失败 | 生成剩余单元与 implicit_review，记录失败分类，不丢弃文件 |
| 动态注册无法确定入口 | 使用剩余文件/符号单元，记录 dynamicRegistrationFallback |
| 单文件不可读 | 对应单元失败并定向重试，主覆盖门禁保持不通过 |
| 单元超过上下文预算 | 按锚点/符号/安全区间拆分；无法安全拆分则 unresolved |
| 单元调用超时/网关失败 | 记录 attempts 与 LLM 回执，重试该单元一次 |
| 租约过期或进程中断 | 只重新领取过期任务并重新预留预算；已成功结果不重复调用 |
| 迟到结果提交 | attempt_id 或租约不匹配则拒绝覆盖，保留调用回执 |
| manifest 版本不一致 | 拒绝在原 run 混跑，要求创建新 run |
| AI 空答或缺少锚点结论 | 标记 unresolved，使用缺失锚点定向复核一次 |
| 部分证据被清洗 | 对应场景删除并计入 evidenceIntegrity；受影响锚点未解决时补跑 |
| covered_elsewhere 关联丢失 | 锚点回到 unresolved，不允许以关联表达为名静默漏掉 |
| 候选全部被清洗 | 单元 unresolved，不得标记 no_behavior |
| 最终合并或坍缩护栏失败 | 不激活候选规格，单元回执保留，既有版本不变 |
| 最终摘要失败 | 按 D10 保留旧简介或置空，不阻断已完整的行为规格 |
| 达到显式预算上限 | 停止派发新单元并标记未完成，不以 partial 结果激活完整基线 |

错误文本只保存截断后的诊断摘要，不写入凭证或完整敏感响应。

## 8. 正确性与回归红线

- AI 生成的产品事实必须继续带可追溯代码证据，单元编排不得绕过 `sanitizeEvidence`。
- `source = 'manual'` 的功能和场景不得被全量候选覆盖或删除。
- 全量重建的未变行为保真、行为等价去重、功能变体折叠和引用重编号保持现有语义。
- 任一单元未完成时，既有激活规格保持不变。
- 发布变化继续来自最终规格事实，单元提取不得直接制造发布变化。
- 增量/RC2-carry、W0-8 diff 枚举和 M9 影子诊断不被本次改造意外改变。
- 新路径恢复不得重复预留或重复结算 SAU；重复 LLM 调用只按实际回执记录，不重复扣用户额度。
- 本地快照若复用全量分析入口，必须复用同一单元覆盖契约；在接入前保留其旧路径，不能声称快照已经获得该能力。
- 实现计划开始前，按计划修改文件执行 CoDelphi `lookup_by_files` 反查，并把命中场景纳入回归红线；未命中不代表没有风险。

## 9. 测试与验收

### 9.1 清单、区间与 key

- 同一 revision、scope 和检测器版本重复生成，manifest hash、单元与锚点 key、顺序和区间完全一致。
- 构造 Next 路由多 method、页面、CLI、任务、事件、公开库导出和未知框架文件，分别得到正确语义或剩余单元。
- 主覆盖区间并集等于实现面，主覆盖区间互不重叠，未认领区间为零。
- behavior/implicit_review 锚点区间并集等于每个单元主区间，entry-only handler 不能通过锚点覆盖门禁。
- 多个 behavior 锚点重叠、implicit_review 覆盖剩余部分时，区间并集恰好等于主覆盖且唯一行数不重复计算；锚点越界、空区间和相邻区间规范化均有测试。
- route 中只识别入口但未识别权限、校验和异常区域时，剩余区域生成 implicit_review；一个入口场景不能核销全部隐式区域。
- 大文件拆分只新增 taskKey/anchorFragmentKey，不改变 unitKey/anchorKey；跨分片锚点必须全部分片完成才能核销，不能由任一 worker 独立核销完整锚点。
- manifest 对 JSON key 顺序、数组排序、区间规范化、空字段和 insert-only 冲突有 canonical 测试；改写 manifest_json 后 hash 校验必须失败。
- 大文件符号拆分与无符号行区间拆分均无尾部遗漏，超预算且无法安全拆分的单元不能成功。
- 重复 route、匿名 handler、符号重载和动态注册按 D3 生成唯一确定性 key，无静默覆盖。
- 文件前部插入行后 key 是否变化不作跨 revision 稳定承诺，但 manifest 内绝不混用两个 revision。

### 9.2 状态机、内部实现与场景映射

- 每个 behavior/implicit_review 锚点分别覆盖 extracted、reviewed_internal、unresolved。
- 空 features、无证据 no_behavior、候选全被清洗、部分证据无效和入口文件空答均不能错误进入终态。
- 合法 no_behavior 必须所有锚点都有证据和分类理由。
- 数据库写入、外部 API、权限与状态转换、事件发布不能仅因位于共享函数而判为 pure_technical。
- covered_elsewhere 必须验证关联单元或场景；关联丢失时回到 unresolved。
- 单元提取 prompt 不含场景数量帽，复述步不进行显著性过滤。
- 覆盖一锚点多场景、多锚点共同支撑一个场景、跨单元同场景合并和最终引用重编号；local 到 final 映射均可追溯。
- localScenarioKey 不含 AI feature 名称；同一持久化结果内排序与序号确定，重试时锚点局部场景集合整体替换而非追加，不做跨调用语义哈希。
- reviewed_internal 不得占用 scenarioRefs，unresolved 不得计入已核销锚点。

### 9.3 租约、恢复与定向补跑

- 人为失败一个单元，只重试该单元，其他单元调用次数不增加。
- 两个 worker 同时领取同一任务，只有一个条件 UPDATE 成功。
- 多个 worker 共享有限 maxLlmCalls 时，原子预留总数不得超过预算；任务结束释放未发生预留，摘要预留不可被单元任务抢占。
- token/费用按预计上限预留、实际回执结算；硬上限下 usage 或费用未知不得继续派发，估算 overshoot 单独披露。
- 租约未过期时其他 worker 不得领取；过期后可以领取并生成新 attempt_id，且必须重新通过预算预留。
- 旧 attempt 的迟到提交不能覆盖新 attempt 结果，旧 LLM 回执仍保留。
- 单元成功后进程重启，恢复时直接读取 result_json，不重复调用 AI。
- manifest 的版本、scope 或 revision 任一不一致时拒绝原 run 恢复，不混合清单。
- 存在 pending/running/failed/unresolved 时不激活规格；既有激活版本保持原样。
- 重试和补跑全部生成带 task_key/unit_key/attempt_id 的 LLM 回执，不重复扣 SAU。

### 9.4 合并、摘要与既有契约

- 多单元同功能、异名同行为、引用冲突和重复场景由现有合并规则处理。
- manual 功能/场景、未变行为保真、规格坍缩、发布变化和回归任务测试全部保留。
- 摘要失败分别验证 generated、preserved、unavailable；行为规格激活不受影响，旧语种简介不得跨语言保留。
- 最终规格事务失败时不存在半激活状态，单元回执仍可恢复。
- 增量定向范围、W0-8 组指标和影子对比测试保持原行为。

### 9.5 独立人工行为 benchmark

shadow 阶段先运行新全量路径，旧路径仍是唯一激活来源。验收对象：

- CoDelphi 自身：大型 Next/TypeScript 多入口仓库；
- `expressjs/express`：公开导出与共享逻辑；
- `pallets/flask`：非 Next 检测器与剩余兜底；
- `apache/superset` 的既有冻结 benchmark fixture：动态注册和插件场景。

每个仓库在查看新旧输出前冻结至少 30 条人工行为预标，每条包含：

```text
behaviorId
源码定位
行为描述
外部可观察结果
必要证据
```

测量规则：

- 基本单位是人工行为，不是新系统或旧系统生成的场景数。
- 一个场景可以命中多个行为，多个场景也可以共同命中一个行为；拆分/合并单独记录。
- 行为命中必须同时具备对应触发/操作、外部可观察结果和必要证据；只提到函数名不算命中。
- 行为召回率 = 命中人工行为数 / 冻结人工行为总数，逐仓库报告并计算宏平均；每条路径自身的单仓比例使用 95% Wilson 区间描述不确定性。
- 输出先按行为等价归并，再由不知道新旧来源的评审判定证据支持性；每个仓库全部评估或分层随机评估至少 100 条输出行为，误报率 = 无充分代码证据的行为数 / 该路径已评估输出行为数。
- 新旧输出中可归并为同一行为的判定可以配对比较；仅出现在一条路径的行为单独列出，不人为构造配对。误报率差值只作辅助指标，不能用召回的配对检验替代。
- 证据有效率、行为拆分/合并率和未决率分别报告，不合并进召回率。
- 每个仓库独立报告，不能只给所有仓库混合后的总平均。

非劣效门槛：

- 新旧路径在同一批冻结人工行为上逐条配对评估。每个仓库计算 `Delta = Recall_new - Recall_old`，使用适用于配对二元比例的 Newcombe 配对差值 95% 置信区间，不得用两个独立 Wilson 区间代替差值检验。
- 每个仓库均要求 `LowerCI(Delta) > -0.03`；宏平均差值点估计也不得低于 -0.03，宏平均只作描述，不伪造独立比例区间。
- 宏平均误报率上升不超过 3 个百分点，证据有效率下降不超过 2 个百分点；误报与证据指标不替代上述配对召回门禁。
- 30 条只是每个仓库的初始最低样本数，不代表统计功效充分。根据配对差值区间宽度判断样本充分性；区间越过 -0.03 无法判定非劣效时继续增加人工预标，仍不足则该仓库为 inconclusive，整体不得当作通过；
- 单元清单、区间、锚点和激活门禁必须先全部通过，benchmark 不能抵消过程缺陷。

同一 revision 两次 run 的场景级稳定性、实际 token、耗时和调用数另作对照。run 397 的 584/1131 规模差只作为回归信号，不作为真值或单独通过条件。shadow 未达标时不替换现役全量路径。

### 9.6 交付验证

实施后运行 `npm run typecheck`、`npm test` 和 `npm run build`。不以生产重跑替代自动化验收，不在未获明确要求时部署生产或改写历史规格。

## 10. 分阶段交付

1. **清单-only**：生成 manifest、单元、锚点、区间覆盖回执和预算，不调用 AI；验证确定性、key 冲突和两个覆盖门禁。
2. **单元 shadow 提取**：完成复述/判定、状态机、场景映射、manifest/租约恢复、运行预算和定向补跑，不激活结果。
3. **对照验收**：冻结人工行为预标，跑召回、误报、证据、稳定性与成本对照；不足样本只给 inconclusive。
4. **主路径切换**：验收通过后，首分析/全量重建改用单元路径，移除全量盲收敛轮；增量保持现状。

每个阶段均可独立停止，未进入主路径切换前不影响现役分析结果。

## 11. 实施假设

- 本期范围是首分析与所有 `affectedKeys === null` 的全量重建，增量路径暂不改变。
- 单元全部处理代表过程按照既定枚举机制完成，不代表静态检测器完备或 AI 语义解释绝对正确。
- 同 revision 的确定性是第一期身份目标；跨 revision 关联另行设计，不在实施中暗中加入语义哈希。
- 用户接受为可靠首分析增加按单元调用所产生的实际时间与 token 成本，但需要事前预算、运行预算和真实回执。
- 首版不追求覆盖所有框架的精细检测器；任何检测器缺口都由剩余实现面与 implicit_review 兜底并显式披露。
- 并发和租约只改善执行与恢复，不得改变单元输入、状态推导和最终确定性合并结果。
- 本设计已冻结；实施计划批准后才开始修改产品代码，实施中不再重新讨论已确定的架构原则。
