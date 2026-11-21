# Execution Batch 设计 v1.0

日期：2026-11-21
状态：架构方向通过；§23 六类契约冻结稿 **v1.1 已冻结**（2026-11-21 评审：P0×2 + P1×5 + T7 门禁修订完成）；可进入 Task 2 实质开发

## 1. 背景

inventory 全量分析以 unit / anchor / fragment 建立完整实现面证明，以 task 承担独立执行、提交和恢复。当前执行层基本将一个 task 映射为一次 describe 和一次 judge 模型请求，导致证明粒度与模型请求粒度绑定过紧。

run 7 的已报告规模为 2,859 个行为单元、2,911 个分析任务、约 6,000 次模型调用，并发 4 时全程约 60–80 分钟。这些数字来自运行方汇报，尚未在本设计中重新审计（该 run 已终止、数据未保留，仅作动机背景）；`2 × 2,911 = 5,822` 只是双步基础调用的理论值，不代表真实请求构成。空白任务、失败、语义复核和重试都会改变实际数量。

本项目的定义不是笼统的「把全量分析做快」，而是：

> 在保持证明能力不变的前提下，解除证明粒度与模型请求粒度的绑定。

第一阶段通过 execution batch 将多个现有 task 组织到同一组 describe / judge 请求中。单元、锚点、分片、任务身份和最终激活条件均不改变。

## 2. 目标

- 保持实现面主覆盖与 anchor 覆盖完整。
- 保持 unit / anchor / fragment / task 的身份、证据和结果契约不变。
- 允许多个 task 共享 batch describe 与 batch judge 请求。
- 每个 task 独立解析、清洗、推导、提交和恢复，不共享不可分割的结果状态。
- batch 按真实模型回执聚合账务，不虚构无法证明的 task 级费用。
- 已完整持久化的 describe / judge 原始响应必须支持零模型调用恢复。
- 通过 feature flag 灰度，默认继续使用现有单 task 双步路径。
- 用同一 commit、manifest、模型与任务集合建立质量和性能对照。

## 3. 非目标

v1.0 不做以下事项：

- 不改变 inventory、manifest 或 task planner 的证明语义。
- 不合并 unit、anchor、fragment 或 task 身份。
- 不引入 `residual_group`，不重构 residual 的覆盖和身份模型。
- 不在第一阶段融合 describe 与 judge。
- 不引入独立语义复核队列、复杂度分层或自适应并发。
- 不通过减少实现面、扩大 residual 区间或跳过未识别代码提高速度。
- 不让检测器根据语法外观直接决定 `no_behavior`。
- 不承诺模型调用 exactly-once；继续使用 at-least-once 调用、真实回执和条件提交。
- 不用一个全局大模型调用替代现有确定性聚合与激活门禁。
- 不执行生产部署、历史 run 迁移或历史规格改写。

## 4. 核心不变量

> Execution batch 只优化模型请求的组织方式，不改变行为分析的证明单位、结果身份、证据边界、任务恢复和最终激活条件。

1. Batch 不参与覆盖核算，也不是激活门禁单位。
2. Batch plan 是确定性候选分组，不等于实际请求成员。
3. 实际请求只能包含本次成功 claim 的 task。
4. 每个 task 保留独立 attempt、租约、证据 allowSet、结果校验和条件提交。
5. Batch 可以聚合真实账务，但不能虚构 task 级费用。
6. `partially_committed` 是 task 行状态的派生事实，不是分析结论。
7. 已持久化且通过完整性校验的模型响应必须优先用于零模型调用恢复。
8. Judge 必须绑定对应 describe 响应、请求指纹及成员映射。
9. 请求结果不确定时，不得假设调用未发生或费用为零。
10. Batch plan 和已执行 attempt 不允许因 planner 升级而静默改变。
11. task 未提交、租约丢失或结果无效，不等于对应模型费用可以释放。
12. 同一 batch attempt 的 judge 使用与 describe 完全相同的实际成员、T/R 映射和源码输入，不在两次调用之间增删成员。
13. T/R 别名映射是不可变执行输入；R 映射必须随 attempt member 持久化，响应持久化后不得重新编号。
14. 每次实际发送的模型请求都有独立 request key 和 receipt；同一请求的重复回执幂等，不同实际请求不得去重或互相覆盖。
15. 一个 batch attempt 的实际成员一旦冻结就永不改变；任何成员变化、模型重试或响应重取都创建新的 batch attempt、请求指纹和 reservation。
16. Batch attempt 的成员和模型请求身份不随恢复 worker 改变；task 提交资格始终由当前有效 task attempt 和 lease fencing 决定。
17. 原始响应是不可变恢复资产；解析器升级不得静默覆盖已提交结果或已激活规格，也不得因 parser 不兼容重新调用模型。

## 5. 四层责任模型

| 对象 | 责任 | 真源内容 | 生命周期 |
| --- | --- | --- | --- |
| Batch plan | 规划真源 | 候选 task、顺序、别名、规划规则和版本 | run 内不可变 |
| Batch attempt | 执行记录 | 实际领取成员、请求指纹、双阶段响应、执行进度 | 每次实际提取尝试 |
| Task row | 结果真源 | task 状态、结果、租约、attempt 和条件提交 | run 生命周期 |
| Reservation / LLM receipt | 账务真源 | 预算预留、真实调用用量、费用和结算状态 | 每次预算/模型调用 |

四者关联但互不替代：

- plan 不决定 task 是否完成；
- attempt 不决定 task 是否提交成功；
- task 是否提交不决定模型费用是否发生；
- reservation 已结算不代表 batch 中所有 task 已完成。

Batch 是否部分提交，通过 plan 成员对应的 task rows 派生，不保存第二套任务状态机。

## 6. 总体执行架构

```text
现有 Manifest + Task Planner
  ↓（不变）
Execution Batch Planner
  ↓（确定性、insert-only plans）
Batch Attempt
  ├─ 独立 claim 每个 task
  ├─ Batch Describe → 原始响应持久化
  ├─ Batch Judge   → 原始响应持久化
  ├─ 按 task 切片
  ├─ 现有单 task 解析 / 证据清洗 / 状态推导
  ├─ 逐 task 条件提交
  └─ 按 batch reservation 的真实回执结算
  ↓
现有 Aggregation + Activation Gate（不变）
```

主提取使用 batch。语义复核在 v1.0 中仍按单 task 执行，详见第 15 节。

## 7. Batch plan 数据契约

建议新增 `analysis_behavior_batch_plans`，使用 MySQL 8 JSON 类型保存有序结构；不依赖 PostgreSQL JSONB。

逻辑字段：

| 字段 | 说明 |
| --- | --- |
| `run_id` | 所属 run |
| `plan_set_id` | 所属 plan set；关联两阶段发布记录 |
| `batch_key` | 规划内容的确定性身份 |
| — | `plan_set_fingerprint` 与 `fallback_assignments` 归属 `analysis_behavior_batch_plan_sets`（完整路由分配真源，见 §23.9）；本表不重复保存 |
| `manifest_hash` | 对应不可变 manifest |
| `planner_version` | 规划器版本，plan 身份的一部分 |
| `ordered_task_keys` | 有序候选 task keys |
| `task_alias_map` | task key ↔ T1/T2 等局部别名 |
| `grouping_rules_fingerprint` | 分组参数与规则指纹 |
| `input_budget_snapshot` | 规划时输入、region 和输出预算快照 |
| `created_at` | 数据库元数据，不进入身份 |

约束：

- `UNIQUE(run_id, batch_key)`；ready plans insert-only。
- 每个 manifest task 必须恰好属于一个 batch plan 或一个 `single_task_fallback`，不得遗漏或双重归属。
- fallback reason 为 `oversized / blank_fragment / unsupported_task_shape`，同样进入 plan set fingerprint；恢复不得因 planner 变化把 fallback 静默改路由为 batch。
- `batch_key` 由 manifest hash、planner version、有序 task keys 和分组规则指纹的规范序列化哈希派生；plan set fingerprint 额外覆盖全部 batch/fallback 分配及原因。
- `task_alias_map` 由程序生成，模型只使用别名，不决定身份。
- plan 缺失、额外成员、顺序变化或指纹不符时，抛 `execution_batch_version_conflict`，不得静默重组。
- 已存在 task-only run 不得在恢复时开启 batch；batch run 不得中途切换 planner 或执行模式。

Plan set 采用两阶段发布，避免用长事务一次性写入全部 plans：

1. 创建 `analysis_behavior_batch_plan_sets` 的 `building` 记录，保存 run、plan set id、fingerprint、planner version 和预期 plan/task 数量。
2. 分批写入关联 plans；building plans 不得执行。
3. 校验数量、task 唯一归属、成员顺序、别名和 plan set fingerprint。
4. 通过一次短条件更新将 plan set 从 `building` 转为 `ready`。
5. 只有 `ready` plan set 可以创建 batch attempt。

恢复遇到 building plan set 时，只能按原版本重新校验并完成发布；无法证明完整时明确失败。不得让另一个 planner 版本补写或接管该集合。

### 7.1 Planner 初始参数

| 参数 | 初始建议 |
| --- | --- |
| 小任务每批数量 | 最多 4 |
| batch 主内容软预算 | 约 32KB，按 UTF-8 字节计算 |
| review region 总数 | 最多 24 |
| 超出单 task 原安全预算 | 不组批，沿用现有安全拆分/未决规则 |
| 普通 task | 同目录优先 |
| residual task | 同文件优先 |
| 装箱算法 | 确定性排序后的贪心装箱 |

32KB 是首轮实验软预算，不是允许突破模型上下文或输出上限的依据。组批必须同时考虑：

1. 每个 task 自身的现有安全预算；
2. batch 总 UTF-8 输入字节；
3. 输入 token 估算；
4. region 数量；
5. 预期输出 token 与模型输出上限；
6. 模型上下文窗口和截断风险。

任何 task 不得因为同批其他 task 较小而突破自身约束。第一版不实现复杂最优装箱。

### 7.2 版本迁移

- `planner_version` 是 plan 身份的一部分。
- 已创建的 plan 不因代码升级自动重建。
- 新 planner 只用于新 run。
- 旧 run 恢复必须继续使用旧 plan 和对应 planner 实现。
- 旧版本无法恢复时明确失败并要求受控迁移，不得按新版本静默组批。

## 8. Batch attempt、member 与 request 数据契约

Batch attempt 是执行真源，其下包含实际成员和实际模型请求两类子记录。它们不新增证明实体，也不改变四层责任模型。

### 8.1 `analysis_behavior_batch_attempts`

| 字段 | 说明 |
| --- | --- |
| `run_id` | 所属 run |
| `batch_attempt_uuid` | 本次执行尝试身份，同时作为预算聚合 attempt id |
| `batch_key` | 对应不可变 plan |
| `reservation_uuid` | 对应本次 batch 预算预留 |
| `model_config_fingerprint` | 模型、温度、输出限制等配置指纹 |
| `prompt_version` | batch prompt 版本 |
| `schema_version` | batch 输出协议版本 |
| `parser_version` | 派生结果使用的解析器版本 |
| `execution_phase` | 请求执行阶段，不表达 task 或预算终态 |
| `members_frozen_at` | 实际成员及 T/R 映射冻结时间；冻结前处于可恢复 claiming |
| `accepted_describe_request_key` | 被本 attempt 接受的 describe 请求 |
| `accepted_judge_request_key` | 被本 attempt 接受的 judge 请求 |
| `terminal_request_key` | 导致失败或未知终态的实际请求，用于确定 stage/sequence |
| `processing_owner / processing_lease_expires_at` | 恢复和拆分处理权 fencing，不替代 task lease |
| `last_error` | 最近一次执行错误 |
| `version` | 条件状态迁移使用的乐观锁版本 |
| `created_at / updated_at` | 审计时间 |

约束：

- `UNIQUE(run_id, batch_attempt_uuid)`；`reservation_uuid` 唯一对应本次预算预留。
- 一个 batch attempt 最多接受一次 describe 和一次 judge 响应；模型重试必须创建新 attempt 和 reservation。
- accepted request 一经设置不可替换，原始响应一经接受不可覆盖。
- `processing_owner + version` 保证同一时刻只有一个 worker 能推进 attempt 状态或拆分响应。
- attempt 行不复制 task result，不作为覆盖或激活依据。

### 8.2 `analysis_behavior_batch_attempt_members`

每个实际 claim 成功的 task 对应一条 insert-only member：

```text
batch_attempt_uuid
task_key / task_key_hash
request_task_attempt_id       // 首次模型请求时的 task attempt，永久保留
request_lease_identity        // 首次请求时的租约审计信息
task_alias                    // T1；继承 plan，不重新编号
ordered_region_aliases        // [{ anchor_fragment_key, region_alias: R1 }, ...]
created_at
```

约束：

- `UNIQUE(batch_attempt_uuid, task_key_hash)`，并防止同一 task attempt 被关联到多个 batch attempt。
- task claim 与 member 插入必须在同一数据库事务中完成；任一步失败都不留下「task 已 running、attempt 却不知情」的窗口。
- member 在 `members_frozen_at` 前可以加入；claiming 崩溃后可在未冻结状态下继续 claim 剩余候选，或冻结当前非空子集。冻结成员和全部 T/R 映射后才允许创建 describe request，此后 members insert-only。
- 冻结后不得再向原 attempt 添加成员；需要处理剩余候选时创建新 attempt。零成员不得冻结，只能 aborted 并释放未使用预算。
- `ordered_region_aliases` 使用 manifest 中 task 的 `anchorFragments` 原顺序生成；每项保存真实 `anchorFragmentKey` 与 R 别名。
- Judge 复用相同 T/R 映射。原始响应持久化后不得重新编号或按恢复代码重新推导。
- 恢复时 T/R 映射、成员或顺序不一致属于 `execution_batch_version_conflict`，不得继续解释响应。
- member 的 request task attempt 只承担请求审计。恢复后的提交资格从当前 task row 重新取得，不改写此字段。

例如：

```json
{
  "task_key": "task|...",
  "request_task_attempt_id": "task-attempt-A",
  "task_alias": "T1",
  "ordered_region_aliases": [
    { "anchor_fragment_key": "fragment|A", "region_alias": "R1" },
    { "anchor_fragment_key": "fragment|B", "region_alias": "R2" }
  ]
}
```

### 8.3 `analysis_behavior_batch_requests`

每次实际发送的模型请求都有独立子记录：

| 字段 | 说明 |
| --- | --- |
| `request_key` | 全局唯一请求身份；可由 batch attempt、stage、sequence 派生 |
| `batch_attempt_uuid` | 所属 batch attempt 和预算聚合身份 |
| `request_stage` | `describe` 或 `judge` |
| `request_sequence` | 同一 attempt 内实际发送序号；v1.0 正常路径各阶段为 1 |
| `request_fingerprint` | 实际成员、T/R 映射、源码、协议和模型配置指纹 |
| `describe_response_hash` | judge 请求所绑定的 describe 响应；describe 为空 |
| `provider_request_id` | 供应商标识，可空，不承担本地唯一性 |
| `request_outcome` | `prepared / dispatch_started / response_received / response_persisted / confirmed_not_sent / failed / outcome_unknown / persistence_failed` |
| `dispatch_started_at` | 已进入实际 gateway/provider 派发过程的时间；prepared 不代表已发送 |
| `response_received_at` | 完整供应商响应已收到但尚未通过持久化校验的时间 |
| `confirmed_not_sent_at` | 有证据证明请求未发出的时间；不得由“无响应”反推 |
| `raw_response` | 原始 UTF-8 文本，不规范化重写 |
| `response_byte_length` | 模型返回 content 的原始 UTF-8 字节数 |
| `stored_byte_length` | 数据库存储并读回校验的字节数 |
| `response_hash` | 对精确响应字节计算的 SHA-256 |
| `provider_finish_reason` | 包含 length 等供应商结束状态 |
| `response_persisted_at` | 完整性校验通过时间 |
| `created_at / updated_at` | 审计时间 |

请求生命周期为：

```text
prepared → dispatch_started → response_received → response_persisted
prepared → confirmed_not_sent
dispatch_started → failed | outcome_unknown
response_received → persistence_failed
```

请求在发送前先持久化 `request_key + stage + sequence + fingerprint = prepared`，进入实际派发前再条件迁移为 `dispatch_started`。数据库中有 prepared 行不代表请求已发送；dispatch 后没有响应也不能证明未发送。只有本地尚未进入 dispatch 或供应商明确确认未接收时才能标记 `confirmed_not_sent`。网络调用前后无法消除的 crash window 继续使用 outcome unknown 和真实回执，不承诺 exactly-once。

`llm_call_receipts` 增加可空 `request_key`；batch 请求必须填写，并建立唯一约束。`provider_request_id` 不能替代本地 request key，因为它可能缺失、延迟获得或无法保证唯一。每个新的实际模型请求都产生新 request key 和独立 sequence；同一实际请求的 receipt 只能幂等补全，不得因 stage 相同而合并不同请求。

原始响应使用 `MEDIUMTEXT` 保存精确 UTF-8 内容，协议最大响应字节数必须小于列容量和实际数据库写入限制。响应 hash 按原始字节计算。只有满足以下条件才能进入 `response_persisted`：

1. 供应商返回状态已记录；
2. 响应未超过协议容量；
3. 原始字节和存储字节长度一致；
4. 数据库存储后读回的 hash 与原始 hash 一致；
5. 请求指纹和 accepted request 关联有效。

容量超限、数据库写入失败或读回校验失败时不得进入 persisted 状态，也不得解析或提交。进程仍持有响应时只允许重试数据库持久化，不得重新调用模型；响应已丢失时保留 `persistence_failed` 和真实账务，由后续新 attempt 决定是否重取。

原始响应可能包含代码事实，访问控制不得弱于 `result_json`，不得写入普通应用日志。保留期限至少覆盖对应 run、manifest 和结果的审计周期；这些资产仍存在时不得单独删除原始响应。

## 9. 三类状态轴

### 9.1 Batch attempt：单向执行状态与重试生命周期

正常路径：

```text
claiming
  → describe_requesting
  → describe_persisted
  → judge_requesting
  → judge_persisted
  → splitting
  → split_done
```

异常终态/分支：

```text
request_failed
request_outcome_unknown
response_invalid
response_persistence_failed
aborted
```

状态规则：

- 正常状态只能单向推进；模型重试不得让原 attempt 倒退或重新请求。
- `request_failed`、`request_outcome_unknown`、`response_invalid`、`response_persistence_failed` 和 `aborted` 均为原 attempt 的执行终态；是否创建新 attempt 由恢复协调器决定。
- `request_outcome_unknown` 的具体 stage/sequence 由 `terminal_request_key` 定位，不靠整个 attempt 猜测。
- `aborted` 只用于首次模型请求前放弃；请求已发出后不得用 aborted 抹除执行事实。
- `describe_persisted` 是 judge 的恢复起点；`judge_persisted` 和 `splitting` 都是确定性拆分的恢复起点。
- worker 在 `splitting` 崩溃后，可通过新的 processing owner/version 继续拆分，状态无需倒退。重复确定性计算可以接受，但 task 条件提交和 repair 防重必须生效。
- `split_done` 是 attempt 的永久执行终态，只表示所有成员的拆分和结果派生已处理，不表示所有 task 成功、repair 完成或预算已结算。

生命周期闭合：

| 情况 | 原 batch attempt | 新 batch attempt / reservation | Task 处理 |
| --- | --- | --- | --- |
| Describe 成功持久化 | 保留并恢复 | 不创建 | 继续 Judge |
| Judge 成功持久化 | 保留并恢复 | 不创建 | 继续确定性拆分和提交 |
| 首次请求尚未发出即放弃 | 进入 `aborted` | 需要时创建新 attempt/reservation | 释放未使用预留；task 走 `abortedBeforeExecution` 恢复 pending |
| 实际请求被供应商明确拒绝且确认未执行 | 进入 `request_failed` | 对账后创建新 attempt/reservation | 按真实 receipt 结算；未提交 task 走现有硬失败和剩余次数重试 |
| 请求结果未知 | 原 attempt 进入 `request_outcome_unknown`，永久保留 | 对账确认允许重试后创建；原记录不覆盖 | 不得提前假定未执行或零费用；usage unknown 时停止新派发，task 按现有租约恢复 |
| 整体响应 malformed | 保留原始响应并进入 `response_invalid` | 创建缩小批次或单 task attempt | 未提交成员按现有解析硬失败和剩余次数重试 |
| 响应无法完整持久化 | 保留 request 和 `response_persistence_failed` | 响应不可用且允许重取时创建 | 不解析、不提交；未提交 task 走基础设施硬失败，费用按真实回执结算 |
| 部分 task 提交 | 原 attempt 和成员保持不变 | 仅为未完成成员创建 | 已提交成员跳过 |
| 实际成员需要变化 | 原 attempt 不得修改 | 必须创建新 attempt、指纹和 reservation | 新 attempt 重新 claim |

一个 batch attempt 最多承担一次 describe 和一次 judge 实际请求。任何同阶段重试、响应重取或成员变化都创建新的 batch attempt 和 reservation，因此原 reservation 不需要覆盖未知次数的重试。

### 9.2 Task row：继续描述分析结果

沿用现有：

```text
pending / running / failed / extracted / no_behavior / unresolved
```

每个 task 独立满足结果完整、证据合法、anchor 状态可推导、attempt 有效和条件提交成功，才能写入对应终态。

### 9.3 Reservation：独立描述预算

沿用现有：

```text
reserved → settled
reserved → released
reserved → settled_unknown
```

禁止从 task 提交结果反推费用，也禁止从 reservation 状态反推 task 分析状态。

### 9.4 派生 batch 进度

```text
部分 plan 成员已有有效终态 + 部分成员尚未完成
= partially committed（派生展示状态）
```

该事实由 task rows 计算，不作为 batch 的分析结论，不新增一套覆盖状态。

## 10. 双阶段请求与响应关联

### 10.1 Describe

describe 请求指纹至少覆盖：

- manifest hash、batch key、batch attempt id；
- attempt member 中持久化的实际成员及固定 T/R 映射（含每个 `anchorFragmentKey`）；
- 各 task 实际源码内容 hash 和区间；
- prompt/schema 版本；
- 模型配置指纹。

模型返回后，先持久化完整原始响应和 hash，再进入解析。响应未完整持久化，不得标记 `describe_persisted`。

### 10.2 Judge

v1.0 采用最严格的成员规则：

> Judge 使用与 describe 完全相同的实际成员、T/R 映射和源码输入，不在两次调用之间增删成员。

即使某 task 在 describe 后租约丢失，也不从 judge 请求中移除；该 task 仅失去后续提交资格。需要改变成员时必须创建新的 batch attempt。

judge 请求指纹除自身输入外，还必须包含 `describe_response_hash`。持久化 judge 响应时同时保存该关联 hash。

如果某 task 缺少有效 describe 复述，沿用当前单 task 规则：judge 直接核对该 task 源码；不得因为复述缺失而自动放行。

### 10.3 响应重处理边界

原始响应是不可变资产。相同 parser 版本的恢复可以重复执行：

```text
raw response → parse → validate → evidence sanitize → derive result → conditional commit
```

同一 run 的正常恢复必须使用创建该 run 时冻结的 parser 版本；找不到兼容 parser 时明确失败，不得静默升级。parser 升级后的历史重处理只能用于离线评估或产生有明确新版本的新派生结果，不得在原 run 中静默覆盖已提交结果，也不得绕过激活流程改写已激活规格。

Parser 不兼容属于派生处理不兼容，不属于模型响应缺失。恢复必须保留原始响应和账务记录，不得因此重新发起 describe/judge。

## 11. Batch 输出协议与身份映射

采用两级 ID：

- batch 内 task：`T1`、`T2`、`T3`；
- task 内 region：`R1`、`R2`、`R3`。

映射由程序生成并持久化，不依赖 JSON 数组顺序，不由模型决定。T 映射保存在 plan/member 中，R 映射保存在 attempt member 的 `ordered_region_aliases` 中；Describe 前冻结，Judge 和恢复原样复用。

### 11.1 与现有单 task schema 的兼容契约

Batch 输出协议只负责包装和映射，不定义第二套业务结果协议：

- 每个 Describe task payload 必须能无损转换为现有 `parseDescribeContent` 接受的 `{ regions: BehaviorRegionDescription[] }`。
- `facts / inputs / controlFlow / externalEffects` 的类型、长度和必填语义完全复用现有 schema。
- 每个 Judge task payload 必须能无损转换为现有 `parseJudgeContent` 接受的 `BehaviorJudgeOutput`。
- `disposition / internalKind / reason / evidence / scenarioRefs / relatedUnitKeys / relatedScenarioRefs / features` 完全复用现有单 task schema。
- `HP-1` 等 scenario reference 仍由模型在各 task 内生成，由现有清洗、归属和局部身份逻辑校验；batch 不重新分配业务场景身份。
- feature 可以通过 `scenarioRefs` 关联同一 task 的多个 regions，不得跨 task 归属。
- Judge 必须逐 region 返回 disposition，不允许只给 task 汇总结论。
- 任何无法无损映射的字段或语义变化必须引入独立 schema version，不得静默改变 batch payload 含义。

T1 必须给出 Describe batch schema、Judge batch schema、T/R 映射定义、payload 转换规则和现有单 task 兼容测试。转换前后对各 task 的规范化 payload 应深度等价。

### 11.2 Describe 输出

```json
{
  "tasks": [
    {
      "id": "T1",
      "regions": [
        {
          "id": "R1",
          "facts": "...",
          "inputs": "...",
          "controlFlow": "...",
          "externalEffects": "..."
        }
      ]
    }
  ]
}
```

### 11.3 Judge 输出

```json
{
  "tasks": [
    {
      "id": "T1",
      "regions": [
        {
          "id": "R1",
          "disposition": "extracted",
          "evidence": [{ "path": "src/a.ts", "startLine": 20 }],
          "scenarioRefs": ["HP-1"]
        }
      ],
      "features": []
    }
  ]
}
```

程序按 T 别名切分后，将每个 task 的 payload 重新送入现有单 task 解析、证据清洗和终态推导逻辑。scenario reference 在 task 内作用域解析，不能跨 task 共享。

## 12. 校验和失败隔离

解析分两层：

1. 外层只解析 batch JSON 语法和 task 身份包装，避免单个 task 的 schema 错误使全部合法成员失败。
2. 每个 task 独立执行完整 schema 和业务校验。

每个 task 必须独立检查：

- task ID 是否唯一、是否属于本 batch；
- region ID 是否唯一、是否属于该 task；
- 是否有缺失或未知 region；
- 每个存活 feature/scenario 是否有有效 extracted 归属；
- 每个 evidence path 是否属于该 task 自己的 allowSet；
- `reviewed_internal` 是否具备 kind、理由和证据；
- `covered_elsewhere` 是否具备有效关联；
- 是否有输出截断或其他不得判成功的事实。

失败处理：

| 情况 | 处理 |
| --- | --- |
| 某 task 缺 region/结论 | 该 task 按现有规则 `unresolved`，其他 task 正常处理 |
| 某 task 证据引用同批其他 task 文件 | 该 task 证据清洗/未决，不得扩大 allowSet |
| 某 task 重复 task ID 或 payload 无法独立解析 | 该 task 走现有硬失败/重试语义，其他 task 不受影响 |
| 模型返回未知 task ID | 忽略并记录诊断，不映射到任何真实 task |
| 整体 JSON 语法无法解析 | 本批未提交成员走硬失败/受控重试 |
| 某 task 租约丢失 | 不提交该 task，其他有效 task 可继续提交 |
| 某 task 输出截断 | 该 task `unresolved`，不得转为 `no_behavior` |
| 多个 task 需要重试 | 后续 attempt 优先缩小批次或退化单 task |

输出完整性按以下规则区分：

| 情况 | 处理 |
| --- | --- |
| Describe 被 provider 明确标记 `finish_reason=length` | 整批不得进入 Judge；全部成员按现有截断规则未决，保留响应和 usage |
| Judge 被 provider 明确标记 `finish_reason=length` | v1.0 无法证明截断只影响某个 task，全部未提交成员按 `output_truncated` 未决，不接受部分成功 |
| 整体 JSON 语法不完整且非 length | 整批不能按正常结果拆分，保留响应并走硬失败/受控重试 |
| JSON 完整但缺整个 task | 缺失 task 的所有 regions 未决；其他 task 独立处理 |
| JSON 完整但单 task 缺 region | 仅该 task 按缺失结论规则未决 |
| JSON 完整但单 task 字段/schema 错误 | 仅该 task 按现有单 task 的硬失败或未决规则处理 |
| 语法完整但未覆盖全部成员 | 不得因外层 JSON 可解析就视为 batch 完整 |

模型把 T1 的场景写入 T2 时，不得因内容看似合理而接受。跨 task 证据和引用污染必须按各 task 的独立契约处理。

## 13. 正常执行流程

```text
1. 读取并校验 ready plan set 中的不可变 batch plan。
2. 创建 claiming batch attempt，并按其最大可能账务暴露创建 reservation。
3. 使用各自 attempt_id / leaseOwner 逐 task claim；task claim 与 attempt member 插入同事务完成。
4. 未领取成功的 task 不加入本次实际成员，保留其他成员的原 T 别名。
5. 没有任何 task 领取成功：aborted + 释放未使用 reservation，不调用模型。
6. 加载实际成员源码，分别建立 task allowSet 和请求输入。
7. 冻结成员及 T/R 映射，先持久化 describe request 身份和指纹，再发送请求。
8. describe 原始响应通过完整性校验并持久化后，执行相同成员和映射的 judge。
9. judge 原始响应通过完整性校验并持久化后，按 task 切片、解析、清洗和推导。
10. 对无需复核的有效结果，使用各 task 当前有效 attempt 独立条件提交。
11. 对需要语义复核的 task，按第 15 节继续单 task 复核后提交。
12. batch 的 describe/judge 调用结束后，按 batch attempt 下全部实际 request receipts 结算 reservation。
```

预算预留先于 claim，确保硬调用预算下不会先领取再发现无预算。部分 claim 成功后不得发送未领取 task 的内容。v1.0 不因实际成员减少而缩小原预留，未发生部分在实际结算时按 reservation 规则处理。

例如 plan 为 `T1/T2/T3/T4`，首次仅 T1/T2 claim 成功，则原 attempt 永远只执行 T1/T2。T3/T4 后续可领取时创建新的 attempt，继承 plan 中 T3/T4 别名，不得重新编号为 T1/T2。一个 plan 可以由多个 attempt 分批执行，但 task 的原子 claim、member 唯一约束和 task attempt fencing 必须防止同一 task 被两个有效 attempt 重复提交。

停止派发且尚未发生首次模型调用时，已 claim task 使用现有 `abortedBeforeExecution` 路径恢复 pending，并释放未使用 reservation。任一模型请求已经发生后，不得按「未执行」释放全部费用。

## 14. 租约、账务与超时

### 14.1 租约

- 不使用 batch processing lease 替代 task lease；前者只保证一个 worker 推进 attempt 或拆分响应。
- batch heartbeat 是协调操作，实际续租的是每个参与 task。
- 某 task 续租失败后不得提交该 task；其他租约有效的 task 可继续提交。
- 租约丢失不改变 describe/judge 请求成员，也不改变已发生费用。

恢复时将两个动作分开：

1. **恢复 batch 响应处理权**：通过 attempt 的 processing owner、过期时间和 version 条件迁移取得，防止两个 worker 同时 judge/split。
2. **恢复 task 提交资格**：原 task lease 过期后必须按现有 task 恢复协议重新 claim，获得新的 task attempt 和 lease fencing；不得拿旧 task attempt 配合新 owner 提交。

原始 member 中的 request task attempt 永久不变，当前 task row 保存新的提交 attempt。提交结果记录 `source_batch_attempt_uuid`，以关联原始响应和新提交 attempt。若 task 已被其他合法 attempt 完成，恢复 worker 跳过该 task，不覆盖其结果。

### 14.2 账务

- batch reservation 使用独立幂等身份 `batch_attempt_uuid`。
- 每次实际请求使用 `request_key = batch_attempt_uuid / request_stage / request_sequence` 作为本地唯一身份；receipt 同时保存 stage、sequence、request fingerprint 和可空 provider request id。
- `llm_call_receipts.request_key` 对 batch 请求必填且唯一。同一 request key 的重复回执，内容指纹相同则幂等 no-op，不同则报账务冲突；不同 sequence 的实际请求不得去重。唯一例外是受控对账：只允许 `provider_request_id` 和 usage 从缺失/unknown 单调补全为已验证值，不得覆盖已有已知值或改写实际请求身份。
- Batch reservation 汇总该 attempt 下全部实际 describe/judge receipts，包括失败和 outcome unknown 请求；不能仅汇总成功响应。
- batch describe/judge receipt 的 `task_key` 和 `unit_key` 为空，避免虚构单 task 归属。
- 单 task repair 使用自己的 task/reservation 身份，不混入 batch 主请求。
- run 级成本按真实 receipts 结算；task 层只保存所属 batch 和结果，不保存伪造的精确费用。
- reservation settle/release 必须幂等，恢复不得重复结算。
- 缺回执或 usage 未知不等于零成本，继续停止新派发并 fail closed。

Reservation 按本 attempt 的最大可能账务暴露预留，且 v1.0 不允许在原 attempt/reservation 下重试模型请求：

```text
reserved_llm_calls = 2
reserved_input_tokens
  = describe 最大渲染输入 + judge 最大渲染输入
reserved_output_tokens
  = describe 最大输出 + judge 最大输出
reserved_cost_amount
  = 按上述 token 上界和冻结价格配置计算的最大费用暴露
```

Judge 最大渲染输入必须包含 describe 最大输出、相同成员源码和协议开销。输入字节、token 估算和模型输出上限都保存在 plan/attempt 预算快照中。价格或用量无法确定时沿用现有保守预算规则，不得按零估算。

若 describe 后未发起 judge，或某阶段未发生调用，最终 settle 只按真实 receipts 入账，未发生部分按现有 reservation 规则释放。任何重试均由新 attempt/reservation 单独预留和结算。

### 14.3 请求结果不确定

以下情况进入 `request_outcome_unknown`，不能简单记为「未调用」：

- 请求已发送后客户端超时；
- 连接在供应商可能已接收请求后中断；
- 无法确定供应商是否执行或计费的其他传输故障。

处理规则：

1. 保存已有 provider request id 和诊断信息。
2. 查询可用的供应商记录或本地 LLM receipt。
3. 不得假定零费用或直接释放全部预留。
4. 仍无法确定时按现有 usage unknown 保守规则处理。
5. 配置硬预算时停止新派发。
6. 恢复重试不得覆盖原始不确定记录，必须创建可区分的新执行记录。

只有能够确认请求未发出或供应商明确未执行时，才可使用 `request_failed` 的未执行分支；HTTP 429/5xx 等响应仍须按实际 receipt 和 usage 状态结算。

## 15. v1.0 的语义复核

本轮不引入独立复核队列，也不将 repair 组批，避免同时改变请求粒度和复核调度。

主 batch 拆分后：

- `extracted` / `no_behavior` 的有效 task 直接独立提交。
- 符合现有 repair 条件的 `unresolved` task，在同一 task lease 和 task attempt 下继续现有单 task repair。
- batch describe/judge reservation 在主 batch 调用结束后先按真实回执结算。
- 每次单 task repair 使用独立、最多一次 judge 调用的 reservation；三个身份分别命名为 `task_attempt_id`（原 task 租约/提交身份）、`repair_budget_attempt_id`（预算聚合身份）和 `repair_request_key`（实际模型请求/receipt 身份），不得互相复用或误读。
- repair 继续使用主 batch 拆分得到的 `previous` 结果，只处理未决 fragments。
- repair 后按现有规则合并结果并条件提交；租约丢失则不得提交。
- batch attempt 的 `split_done` 不表示 repair 已完成；worker 和激活门禁必须等待所有已发起的 repair 处理完毕。

崩溃后主 batch 原始响应仍在时，先确定性重建 `previous`，再决定是否需要 repair，不重复 describe/judge 主调用。repair 自身的恢复保持现有单 task 语义，不在本项目中新增 repair 原始响应存储：若 repair 已调用但响应未提交，恢复可能需要重发 repair，不能保证 repair 零调用恢复；必须保留实际 repair receipt 和 unknown usage 处理，不得重复承诺 exactly-once 或把该费用记为零。

## 16. 恢复矩阵

| 中断位置 | 恢复行为 |
| --- | --- |
| plan 持久化不完整或指纹不符 | `execution_batch_version_conflict`，不静默重组 |
| reservation 后、claim 前 | 对账并释放未使用 reservation |
| 部分 claim 成功 | 新 attempt 只处理仍可领取的 task |
| describe 请求结果未知 | 按 `request_outcome_unknown` 和 usage 规则处理 |
| describe 响应已保存、judge 未开始 | 取得原 attempt 处理权，校验指纹后复用 describe，只执行 judge |
| judge 响应已保存、尚未拆分 | 取得原 attempt 处理权，直接拆分、清洗、推导和提交，零模型调用 |
| splitting 中崩溃或两个 worker 竞争恢复 | 仅 processing owner/version 当前者推进；其他 worker 不得拆分或提交 |
| 原 task lease 已过期 | 保留原请求成员，重新 claim 当前 task 取得提交资格，不重取模型响应 |
| 部分 task 已提交 | 跳过已有有效终态，只处理剩余 task |
| 某 task 租约丢失 | 不提交该 task，其他有效结果继续处理 |
| 主 batch 已保存、repair 中崩溃 | 重建 previous，按现有单 task repair/attempt 规则恢复 |
| 供应商已调用但响应未保存 | 不保证 exactly-once；按真实回执和 unknown 规则处理 |
| 某 task 输出非法 | 只让该 task 进入相应失败/未决路径 |
| 整体响应无法解析 | 保留原始响应，原 attempt 终态；后续新 attempt 缩小批次或退化单 task |
| T/R 映射或请求指纹不匹配 | `execution_batch_version_conflict`，不得解释响应或重新编号 |
| Parser 不兼容 | 保留响应和账务，使用冻结 parser 或明确失败；不得重新调用模型 |
| usage unknown | 停止新派发并 fail closed |

恢复时必须优先处理已持久化响应，再考虑新模型请求。已成功 task 不得因同批其他 task 失败而重新执行。

## 17. 配置、兼容与回滚

建议新增显式执行模式：

```text
ANALYSIS_BEHAVIOR_EXECUTION_MODE=task|batch
```

默认 `task`，垃圾值回退 `task`。

约束：

- batch 只对新 run 开启，不在已有 run 中途切换。
- batch run 持久化 planner/prompt/schema/parser/model 配置指纹。
- 恢复时配置不兼容则明确失败，不静默换协议。
- 生产回滚通过新 run 使用 `task` 模式完成；已开始 batch run 继续使用其冻结配置或受控终止。
- v1.0 不改变现有单 task 代码路径的默认行为。

## 18. 可观测性与产品进度

### 18.1 性能画像

画像聚合对任意已完成 run 执行（当前无可用历史全量 run，官方统计基线由 Task 11 配对基准的 task 模式臂实测产生）：

\[
C_{baseline}=C_{describe}+C_{judge}+C_{repair}+C_{retry}+C_{other}
\]

分别采集：

- manifest 扫描、读取和持久化耗时；
- task 大小、region 数和输出长度分布；
- 排队、源码读取、describe、judge、repair、commit 耗时；
- 各阶段输入/输出 token、费用和模型配置；
- P50/P90/P99 task 与请求耗时；
- 429、超时、截断、解析失败、证据清洗比例；
- reserve/claim/commit/settle 和数据库等待；
- worker 空闲、在途请求和在途 token；
- unresolved、重试和 repair 转终态比例。

理论请求节省只针对实际可组批的 describe/judge 调用，不用 `2N` 替代真实基线。

### 18.2 效率指标

\[
R_1=\frac{LLM调用数}{extracted+no\_behavior任务数}
\]

\[
R_2=\frac{总Token}{extracted+no\_behavior任务数}
\]

\[
R_3=\frac{extracted+no\_behavior任务数}{总耗时}
\]

`unresolved` 不计入成功完成，防止通过质量下降美化效率。

### 18.3 用户侧进度

分别展示：

- 扫描进度；
- 已建立 unit/task 数；
- task 执行进度；
- 正在执行的 batch 数；
- 证明完成和 unresolved 状态；
- activation gate 状态；
- 真实预算消耗。

只有统计数据足够时才展示预计剩余时间。不能用「95% task 完成」暗示「95% 产品行为已可靠理解」。未通过 activation gate 的结果必须明确标记为未激活。

## 19. 实施任务与依赖

| 顺序 | 交付物 | 冻结/完成条件 |
| --- | --- | --- |
| T0 | run 画像聚合与协议冻结 | 官方基线由配对基准 task 臂实测产生，调用与耗时构成明确 |
| T1 | 数据模型与状态契约 | 四种真源、双阶段响应、预算和恢复矩阵评审通过 |
| T2 | 确定性 batch planner | 相同输入产生相同 plan，版本冲突可检测 |
| T3 | 双步 batch 协议 | describe/judge 成员、映射和 hash 关联正确 |
| T4 | 独立拆分、校验和提交 | 复用 task 结果契约，失败隔离通过 |
| T5 | 预算、租约和响应恢复 | 双阶段零调用恢复、幂等结算和 unknown 处理通过 |
| T6 | 故障注入测试 | 第 20 节关键场景全部通过 |
| T7 | 双步 batch 对照实验 | 质量非劣且性能有实际收益 |
| T8 | 固定并发基准 | 4/8/12/16 档吞吐与稳定性数据充分 |
| T9 | 单步融合独立实验 | 单独评估，不预设上线 |

T1 必须交付六份可测试契约：

| 契约 | 必须回答的问题 |
| --- | --- |
| Identity contract | plan、batch attempt、task attempt、实际 request、T/R 映射如何唯一识别 |
| Membership contract | plan 成员、claim 成员、请求成员如何冻结，部分 claim 和重试如何继承 |
| Request/receipt contract | 每次真实请求如何关联 receipt、reservation、usage 和费用 |
| State transition contract | 正常、失败、未知、恢复和新 attempt 重试如何迁移 |
| Recovery contract | 每个崩溃点由谁恢复、从哪里恢复、是否允许重新请求 |
| Result compatibility contract | batch payload 如何无损复用现有单 task 解析、清洗和提交 |

T1 还必须冻结质量非劣实验契约：测试集规模与组成、普通/residual/大 task 分层、相同 commit/manifest/模型配置、盲评流程，以及召回率、假阳性率、证据支持率和 reviewed_internal 误判率的预设非劣界限。优先复用 `lib/behavior-benchmark.ts` 的配对样本和非劣口径，不得在实验结束后调整阈值以迎合结果。

T1 必须先于 T2～T5 的实质开发。T6 是完整 run benchmark 的前置条件。独立复核队列、复杂度分层、自适应并发、residual 身份重构和 DB 批量写入均不在本轮启动。

## 20. 测试与验收

### 20.1 正确性硬门禁

- manifest hash 不变。
- unit/anchor/fragment/task key 不变。
- primaryCoverage 与 anchorCoverage 完整。
- 每个 task 独立得到有效终态。
- 证据 allowSet 不扩大。
- 场景归属、局部身份和别名解析正确。
- activation gate 完全复用，repair 未完成不得激活。
- `unresolved` 不得被批处理错误转换为 `no_behavior`。
- 盲判召回非劣，假阳性、reviewed_internal 误判和证据支持率不突破预设非劣界限。

### 20.2 必须通过的故障注入

1. 6 个 task 中 5 个成功、1 个缺区域：5 个提交，1 个未决。
2. 某 task 使用同批其他 task 的文件作为证据：该 task 不得通过。
3. 部分 claim 成功：请求只包含已领取 task，T 别名不重排。
4. 无任何 claim 成功：释放预留，零模型请求。
5. describe 已保存后崩溃：恢复只执行 judge。
6. judge 已保存后崩溃：恢复零模型调用完成拆分提交。
7. 部分 task 提交后崩溃：已成功 task 不重新执行。
8. batch 中某 task 租约丢失：该 task 不提交，其他 task 可提交，费用仍结算。
9. 某 task payload 非法：不影响其他合法 task 提交。
10. 整体 JSON malformed：无伪造成功，重试缩小批次或单 task。
11. 请求超时且结果未知：不得按零费用释放。
12. usage unknown：停止新派发并 fail closed。
13. reservation 重复 settle/release：保持幂等。
14. planner 或协议版本变化：旧 run 不静默重组或换协议。
15. 主 batch 成功、repair 中崩溃：不重复主 batch 调用，按单 task repair 语义恢复。

另外必须覆盖以下四组契约测试。

**T/R 映射与协议兼容：**

- 每个 manifest task 恰好属于 batch 或 fallback 一次，fallback 原因进入 fingerprint，恢复不得改路由。
- T 或 R 映射变化后恢复必须失败，不得重新编号。
- task 内 R1/R2 重复、未知 region、合法 task 下的其他 task region 均被隔离处理。
- 同一原始响应在相同 parser 版本下重复解析，规范化结果指纹一致。
- Describe/Judge payload 与现有单 task schema 的转换前后深度等价。

**Receipt 幂等与账务对账：**

- Describe/Judge receipt 重复投递且内容一致时 no-op，冲突时明确失败。
- 同阶段新实际请求使用新 request key/receipt，不覆盖旧请求。
- Describe 和 Judge 不互相覆盖；provider request id 缺失仍可按本地 request key 对账。
- provider request id 已有但本地 receipt 未持久化时按 unknown 处理。
- request outcome unknown 后查到真实 usage，以及仍无法确定 usage 的两条路径均正确。
- reservation 已 settle 但 task 尚未提交时，两条状态轴不互相推进或回滚。

**恢复竞争与租约 fencing：**

- 两个 worker 同时恢复同一 attempt，仅一个 processing owner 能推进。
- 一个 worker splitting 时另一个不得重复提交或发起 repair。
- task lease 过期后重新 claim；旧 worker 的旧 task attempt 提交被拒绝。
- 部分 task 续租成功、部分失败时只提交当前有效 task。
- 原始响应已保存但 task 已由其他合法 attempt 完成时跳过，不覆盖。

**响应完整性与输出边界：**

- 响应容量超限、数据库写入失败、读回字节数或 hash 不符时不得进入 persisted。
- Describe length 不进入 Judge；Judge length 不接受部分 task 成功。
- 完整 JSON 缺整个 task、缺 region、schema 错误分别按独立规则处理。
- parser 不兼容只阻断派生处理，不触发新模型请求。

### 20.3 性能项目目标

以下是项目目标，不是已测得结果，也不是绕过质量门禁的理由：

| 指标 | 建议目标 |
| --- | --- |
| 可组批基础请求数 | 相比真实可组批基线下降至少 60% |
| 总墙钟时间 | 目标下降 30% 以上 |
| 单位有效完成成本 | 不恶化 |
| Token 消耗 | 不出现明显无效膨胀 |
| 429 / 超时 / 输出截断 | 不高于可接受基线波动 |
| 同规模全量分析时长（~2,900 task 规模） | 20 分钟挑战目标（墙钟北极星） |

如果请求数显著下降而墙钟时间几乎不变，应重新判断模型计算、输出 token、供应商排队或数据库是否才是瓶颈，不得单纯继续扩大 batch。

## 21. 建议代码落点

实施计划评审时再冻结具体文件；建议责任边界如下：

- 新增 batch 类型、planner、协议、执行与持久化模块，避免继续扩大 `lib/full-analysis.ts` 的职责。
- `lib/full-analysis.ts` 只负责模式选择、队列编排和现有激活流程集成。
- `lib/behavior-unit-ai.ts` / `lib/behavior-unit-extraction.ts` 提供可复用的单 task 解析、清洗和状态推导，不复制第二套判定规则。
- batch 请求适配层必须返回原始 content、usage、provider request id 和 finish reason；现有只返回 content 且在 length 时抛错的 `requestStructuredCompletion` 不能未经扩展直接承担原始响应持久化。
- `lib/behavior-unit-receipts.ts` 继续拥有 task claim、续租和条件提交。
- `lib/behavior-run-budget.ts` / `lib/billing/cost-receipt.ts` 扩展 batch attempt 的真实用量归集。
- 新 migration 使用现有腾讯云 MySQL 8，新增表和可空列，不修改历史结果。
- 测试覆盖 planner、协议、拆分、状态机、恢复、预算和完整 run 对照；项目已有测试体系，按现有 Vitest 约定添加。

## 22. 评审冻结点

进入实现前，接口与状态机评审必须明确确认：

1. 四种真源没有职责重叠。
2. plan、attempt、member、task、request 和 reservation 的键及关联可唯一追踪。
3. R 映射随 member 持久化，T/R 变化能够检测且不会重新编号。
4. 每次实际请求都有独立 request key，receipt 幂等粒度是实际请求而不是阶段。
5. describe/judge 双阶段响应能够独立校验和恢复。
6. judge 成员与 describe 完全一致，租约只影响提交。
7. 原 attempt 不倒退重试；成员变化或模型重试均创建新 attempt/reservation。
8. batch 处理权和 task 提交资格分离，恢复竞争受 fencing 保护。
9. task 独立提交不受同批其他 task 失败影响。
10. 预留覆盖本 attempt 最大账务暴露，重试不在原 reservation 下发生。
11. 已发生费用不因未提交而释放，未知用量不按零处理。
12. 部分提交是派生事实，不形成第二套任务状态机。
13. v1.0 的 repair 路径、预算身份和激活等待条件无歧义。
14. planner/parser 升级不会改变旧 run 的输入、触发额外模型请求或静默改写结果。
15. Batch payload 无损复用单 task schema，输出截断和部分有效 JSON 不伪装成功。
16. 所有性能目标均服从正确性、账务和恢复硬门禁。

## 23. 六类契约冻结稿（v1.1，已冻结）

> 本节由计划 Task 2 Step 1 产出：把 §4–§17 的决议收敛为六份可测试契约，逐条映射 §22 十六项冻结点。
> **冻结记录**：v1.0（2026-11-21）提交评审 → 裁决「架构方向通过、暂缓冻结」→ 修订 P0×2（C3.6 按请求生命周期分类 receipt 缺失；claim 与 member insert 同连接事务契约）+ P1×5（plan set/plan 字段归属 §23.9、`failed` 失败分类、receipt 已知账务字段冲突矩阵、repair 三身份持久化映射、`response_received` 崩溃窗口语义）+ T7 实验门禁（分层 inconclusive 规则）→ **v1.1 冻结**。评审同时约束：不再新增抽象层，不设计 batch 专属预算/结果/任务状态系统。

### 23.0 代码锚点核对（2026-11-21 只读探索核实）

以下事实已对当前 HEAD 核实，冻结决议直接锚定这些真实符号，不再依赖计划转述：

- **migration**：当前最高 `migrations/080_behavior_inventory.sql`（目录存在两个 `038_*` 并列文件，不影响顺延）→ 下一编号 `081_execution_batch.sql`，与计划假设一致。
- **`llm_call_receipts`**（032 创建、062/080 扩展）：已含 `call_kind`(062)、`task_key`/`unit_key`/`attempt_id`/`call_stage`(080)、`provider_request_id`(032)、`usage_status`、`llm_cost_amount`；**尚无** `request_key`/`request_fingerprint`/`duration_ms`——081 增这三个可空列 + `request_key` 全局唯一索引。token 列名为 `input_tokens`/`output_tokens`（`prompt_tokens`/`completion_tokens` 仅是 `usage_json` 原始键）。无 `finish_reason` 列（finish reason 只存入 batch_requests 表的 `provider_finish_reason`）。
- **`lib/ai.ts`**：`requestStructuredCompletion(messages, billing?) => Promise<string>`（:494）；`gatewayResponse`（:234-244）已捕获 `{ content, usage, requestId, finishReason }` 但只写入 receipt、不回传调用方；`AiOutputTruncatedError`（:215-223）在 `finish_reason=length` 时抛出且先记失败 receipt（:581-600）。`LlmBillingContext`（:384-395）= `runId/accountId/chargeComponent/callKind?/taskKey?/unitKey?/attemptId?/callStage?`。该路径未捕获 `duration_ms`。
- **预算**：`BudgetReservationInput`（lib/behavior-run-budget.ts:65-77）**现无 `kind` 字段**（私有 `ReservationKind = "task" | "product_summary"`）；`reconcileOrphanedTaskReservations`（:604）现仅处理 `kind='task'`。settle 已实现 `reserved → settled` 与未知维度按预留上界入账转 `settled_unknown`（:448-464，硬上限配置时抛 `behavior_budget_usage_unknown` fail closed）；`releaseUnusedBehaviorBudget`（:531）。
- **task 行与租约**：表 `analysis_behavior_tasks`（080:27-57，`task_key_hash` 与 run_id 联合唯一）；`claimBehaviorTask`（:298，原子条件 UPDATE，claimable = pending ∨ failed/unresolved 且 attempts<max ∨ running 且租约过期）、`renewBehaviorTaskLease`（:354，丢失抛 `behavior_task_lease_lost`）、`commitBehaviorTaskResult`（:389，门=run_id+task_key_hash+attempt_id+lease_owner+status='running'，stale 返回 false、永不覆盖 result_json）。`abortedBeforeExecution` 是 `markBehaviorTaskFailure` 的标志位（:237/:436-451，重置 pending、不耗重试预算），**不是独立状态值**。
- **解析与推导**：`parseDescribeContent`/`parseJudgeContent` 位于 **lib/behavior-unit-ai.ts:301/313**（签名含 task 参数）；`extractBehaviorTask`（lib/behavior-unit-extraction.ts:476，支持注入 `requestCompletion` 传输）。**`deriveBehaviorTaskResult`/`behaviorTaskTruncatedResult` 现不存在**——私有等价物 `deriveTaskResult`（:190）/`deriveTaskOutcome`（:158）/`truncatedResult`（:229）；Task 7 按计划以新名字最小导出（改名导出、行为不变）。截断语义：全 fragments → `unresolved(reason="output_truncated")`，永不 no_behavior；no_behavior 仅来自 reviewed-internal 合法合并或空白综合 `blankRegionsResult`（:287-299）。
- **编排与环境**：`runInventoryFullAnalysis`（lib/full-analysis.ts:366-919），`processTask`（:487-615）= reserve→claim→heartbeat→load sources→extract→repair→commit→settle，worker 池在 :631；env 白名单+垃圾值回退范式 `fullAnalysisMode()`（lib/env.ts:87-93）。
- **基准设施**：`evaluateBehaviorNonInferiority`（lib/behavior-benchmark.ts:245）已存在，`NON_INFERIORITY_MARGIN=-0.03`、`MIN_PAIRED_BEHAVIOR_SAMPLES=30` 与计划冻结门一致。
- **现状**：`lib/execution-batch/` 不存在；`ANALYSIS_BEHAVIOR_EXECUTION_MODE`/`ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE` 仅在文档出现；无 `analysis_behavior_batch_*` 表。

### 23.1 C1 Identity contract（身份契约）

回答：plan、batch attempt、task attempt、实际 request、T/R 映射如何唯一识别。

1. **实体与唯一键**：
   - plan set：`analysis_behavior_batch_plan_sets` 是**完整任务路由分配的真源**——身份 = `(run_id, plan_set_id)`，保存 `plan_set_fingerprint` = SHA-256(canonical{planner_version, 全部 batch plan 成员与顺序, 全部 fallback `{task_key, reason}`})、planner_version、预期 plan/task 数量、发布状态（building/ready）与 `fallback_assignments`（JSON）。
   - plan：`analysis_behavior_batch_plans` 只保存单 plan 自身数据——`UNIQUE(run_id, batch_key)`；`batch_key` = SHA-256(canonical{manifest_hash, planner_version, ordered_task_keys, grouping_rules_fingerprint})；另存 manifest_hash、ordered_task_keys、task_alias_map、grouping_rules_fingerprint、input_budget_snapshot；**不重复保存** plan_set_fingerprint 或 fallback_assignments（表职责划分见 §23.9）。canonical 化只对 object keys 排序，数组保持业务顺序。
   - attempt：`UNIQUE(run_id, batch_attempt_uuid)`；`batch_attempt_uuid` 同时充当预算聚合 attempt id（写入 reservation/attempt_id 链路）。
   - member：`UNIQUE(batch_attempt_uuid, task_key_hash)`，且 **`UNIQUE(request_task_attempt_id)`**——同一 task attempt 不得挂到多个 batch attempt。
   - request：`request_key` 为全局唯一的**明文复合键** `${batchAttemptUuid}|${stage}|${sequence}`（stage ∈ describe|judge，sequence 从 1 递增；可读可审计）；081 在 `llm_call_receipts` 增可空 `request_key` + 全局唯一索引。SHA-256 只用于 `batch_key`/`plan_set_fingerprint`/`request_fingerprint`，不用作 request_key 本体。
2. **T/R 映射**：T 别名由 plan 的 `task_alias_map` 生成；R 别名随 member 的 `ordered_region_aliases`（按 manifest `anchorFragments` 原序生成，每项含真实 `anchor_fragment_key` + `region_alias`）持久化。两者均不依赖数组位置身份；响应持久化后禁止重编号。
3. **版本身份**：`BATCH_PLANNER_VERSION` / `BATCH_PROMPT_VERSION` / `BATCH_SCHEMA_VERSION` / `BATCH_PARSER_VERSION` 均为 `"1"`；attempt 行持久化 prompt/schema/parser/model_config_fingerprint，恢复时不匹配即抛 `execution_batch_version_conflict`。
4. **task attempt 与 request 的关系**：member 的 `request_task_attempt_id` 只承担首次请求审计；提交资格永远来自当前 task 行（见 C5.2）。
5. 测试锚点：`tests/execution-batch-identity.test.ts` + `scripts/execution-batch-migration-smoke.ts`（唯一索引、MEDIUMTEXT 边界、事务 rollback 实测）。

### 23.2 C2 Membership contract（成员契约）

回答：plan 成员、claim 成员、请求成员如何冻结；部分 claim 和重试如何继承。

1. 三层成员恒等式：plan 成员（候选）⊇ claim 成员（实际）= request 成员（冻结后）。实际请求只能包含本次成功 claim 的 task。
2. **原子 claim 实现契约（同连接事务，v1.1 修订）**：代码锚点核实 `claimBehaviorTask` 签名首参即为 `execute: Execute`（lib/behavior-unit-receipts.ts:176-186，`ClaimTaskInput.execute`），其条件 UPDATE 与读回 SELECT 已走同一注入连接——现有接口已具备事务注入能力，无需重构。batch 路径必须在**同一个事务 connection** 上顺序完成：① `claimBehaviorTask`（传入事务 execute）；② batch attempt member INSERT；③ COMMIT（`withBatchTransaction` 沿用 mysql2 begin/commit/rollback/release）。**禁止 batch 路径调用任何内部自行从连接池取连接的 claim 封装**。必须有真实 MySQL 事务测试：claim 成功 + member insert 人为失败 → rollback 后 task 行 status/attempts/lease_owner/lease_expires_at/attempt_id 全部恢复原值、无残留 member 行。
3. 冻结：`members_frozen_at` 非空即冻结。冻结前提 ≥1 成员；零成员只能 `aborted` 并释放未使用预留。冻结是进入 describe 的独立原子步骤；冻结后 member insert-only，T/R 永不变化。
4. claiming 崩溃可恢复：`members_frozen_at` 为空时可继续 claim 剩余候选，或冻结当前非空子集。
5. 部分 claim 继承：已领取成员保留 plan 原 T 别名；未领取者由后续新 attempt 继承 plan 原别名，禁止重编号。
6. 任何成员变化、模型重试或响应重取 → 新 attempt + 新指纹 + 新 reservation；不提供修改原 attempt 成员的 API。
7. fallback 路由（`oversized | blank_fragment | unsupported_task_shape`）在 plan set 级持久化并进入 fingerprint；恢复不得把 fallback 静默改路由为 batch。
8. 测试锚点：`tests/execution-batch-planner.test.ts`、`tests/execution-batch-attempts.test.ts` + 真实 MySQL 事务回滚用例（claim 成功 + member insert 失败 → 全量回滚、零半持久化）。

### 23.3 C3 Request/Receipt contract（请求与账务契约）

回答：每次真实请求如何关联 receipt、reservation、usage 和费用。

1. 请求生命周期八态：`prepared → dispatch_started → response_received → response_persisted`；旁路 `confirmed_not_sent / failed / outcome_unknown / persistence_failed`。转移条件以 §8.3 为准（prepared 不证明已发送；dispatch 后无响应不得反推未发送；仅本地未派发或供应商明确未接收时可 `confirmed_not_sent`）。
2. **`failed` 必须携带失败分类**（v1.1 修订；batch_requests 增 `failure_class` 列）：`local_pre_dispatch | provider_rejected | provider_execution_failed | transport_failure`。语义与费用判定：`local_pre_dispatch` = 本地派发前失败，证明未发出，零费用；`provider_rejected` = 必须持有供应商未执行的证据才可零费用（**仅 HTTP 429/5xx 状态码不构成该证据**，§14.3）；`provider_execution_failed` = 可能已发生调用，按真实 receipt/usage 结算，receipt 缺失按 usage unknown；`transport_failure` = 默认按 `outcome_unknown` 语义处理，除非能证明未发送。
3. **持久化崩溃窗口语义**（v1.1 修订）：`response_received` 是「进程已收到响应」的事实标记，只在数据库可写时存在；`response_persisted` 才是可恢复的持久化事实。响应已收到但写入失败且进程存活 → 只允许重试持久化，不得重新调用模型；进程丢失响应且数据库停留在 `dispatch_started` → 恢复按 `outcome_unknown` 处理；`persistence_failed` 是可记录时的诊断状态，不保证数据库故障时写得进去，且不得把「无 persistence_failed 记录」解读为「未收到响应」。与「不承诺 exactly-once」一致。
4. 先持久化身份再派发；`response_persisted` 门槛不变：原始字节落库 + 读回校验（`response_byte_length = stored_byte_length` 且 SHA-256 一致，容量 < `MAX_BATCH_RESPONSE_BYTES = 4_000_000` < MEDIUMTEXT）后才进入解析。
5. receipt 幂等粒度 = **实际请求**（v1.1 补冲突矩阵）：同 `request_key` + `request_fingerprint` 的重复回执按**已知账务字段变更矩阵**处理——`provider_request_id` 仅 NULL→已验证值；`usage_status` 仅 unknown→known；input/output/cache tokens 与 cost 仅 unknown→已验证值；**已知值之间出现不同值 → 报账务冲突，不得 last-write-wins**；`request_fingerprint` 永不改变；`duration_ms` 属观测数据，取第一次成功记录、不因重复回执覆盖。配合 081 的 `request_key` 唯一索引，batch receipt 写入从盲插变为 reconcile-upsert（不存在则插入，存在则按本矩阵单调补全或冲突报错）。不同 stage/sequence 的实际请求不得去重或互相覆盖。
6. **settle 时 receipt 缺失按请求行状态分类**（v1.1 修正原 C3.6 范围过宽问题）：`analysis_behavior_batch_requests` 是请求身份与**派发状态**的权威记录，不是「存在 request 行 = 发生真实调用」的权威。settle 按行状态处理 receipt 缺失：

   | 行状态 | receipt 缺失时 |
   | --- | --- |
   | `prepared` | 未进入派发，不能推断发生调用；该阶段预留按未发生释放 |
   | `confirmed_not_sent` | 明确未发送，不计模型调用费用 |
   | `dispatch_started` | 可能已发送 → 按 usage unknown 保守入账并 fail closed（停止新派发） |
   | `response_received` / `response_persisted` | 已发生供应商交互 → 按 usage unknown 处理 |
   | `outcome_unknown` | 按 usage unknown 处理 |
   | `failed` | 按 `failure_class` 判定（见第 2 条），不能统一处理 |

   原则：**只有进入可能发生实际派发的阶段，receipt 缺失才构成 usage unknown**。派发前崩溃留下的 prepared 行走「未发生部分释放」，不得触发可重复出现的错误冻结。`recordLlmCallReceipt` 保持 best-effort（写失败不阻塞主流程），因此结算输入 = batch_requests 行状态 + receipt 双读，二者缺一按保守侧处理。
7. reservation：`kind` 枚举扩为 `task | product_summary | batch | task_repair`。batch 每 attempt 一次预留：`reserved_llm_calls = 2`；input = describe 最大渲染 + judge 最大渲染（judge 侧必须包含 describe 最大输出 + 相同成员源码 + 协议开销）；output = describe 最大输出 + judge 最大输出；cost = 冻结价目下按上界计算的最大暴露。`task_repair` 预留 `maxLlmCalls = 1`。settle 聚合本 attempt 全部真实 receipts（含 failed/timeout/unknown）并**按 stage 分别判定已发生/未发生**，未发生部分按现有 reservation 规则释放；settle/release 幂等。
8. gateway 扩展：新增 `requestStructuredCompletionDetailed` 返回 `{ content, usageRaw, providerRequestId, finishReason }`；现有 `requestStructuredCompletion` 返回/length 抛错行为不变。`LlmBillingContext` 增可选 `requestKey`/`requestFingerprint`（batch 必传，legacy 空）。`duration_ms` 由详细版实测记录（新增观测，不回填任何历史 run）。
9. 孤儿对账覆盖扩为 `kind ∈ {task, batch, task_repair}`（`product_summary` 维持现状排除）；usage unknown 处置沿用现有 `settled_unknown` 上界入账 + 硬上限配置时 `behavior_budget_usage_unknown` fail-closed 语义。
10. 测试锚点：`tests/execution-batch-requests.test.ts`、`tests/ai-gateway.test.ts`、`tests/behavior-run-budget.test.ts`。

### 23.4 C4 State transition contract（状态机契约）

回答：正常、失败、未知、恢复和新 attempt 重试如何迁移。

1. attempt 正常单向链：`claiming → describe_requesting → describe_persisted → judge_requesting → judge_persisted → splitting → split_done`；异常终态：`request_failed / request_outcome_unknown / response_invalid / response_persistence_failed / aborted`。`aborted` 仅限首次模型请求前；`splitting` 可在新 processing grant 下继续确定性拆分（重复确定性计算可接受）；`split_done` 是执行终态（≠ 全部 task 成功、≠ repair 完成、≠ 预算已结算）。
2. 推进权 fencing：`processing_owner + version` 条件更新（CAS）；仅当前 owner+version 可迁移状态或拆分响应。
3. 三条状态轴互不推进/回滚：attempt（执行）× task row（`pending/running/failed/extracted/no_behavior/unresolved`）× reservation（`reserved/settled/settled_unknown/released`）。`partially_committed` 是 task rows 的派生展示事实，不落库、不进覆盖核算、不构成第二套状态机。
4. `request_outcome_unknown` 的具体 stage/sequence 由 `terminal_request_key` 定位，不靠整个 attempt 猜测。
5. 测试锚点：`tests/execution-batch-attempts.test.ts`。

### 23.5 C5 Recovery contract（恢复契约）

回答：每个崩溃点由谁恢复、从哪里恢复、是否允许重新请求。

1. 恢复优先级：**先消费已持久化响应**（`describe_persisted` → 只执行 judge；`judge_persisted`/`splitting` → 零模型调用完成拆分提交），再考虑新模型请求。parser 不兼容属于派生处理不兼容，明确失败，不得因此重新调用模型。
2. 双 fencing 恢复：① batch 响应处理权 = attempt 的 `processing_owner`/过期时间/`version`；② task 提交资格 = 按**现有协议**重新 claim（获得新 attempt_id + lease_owner），提交走现有 `commitBehaviorTaskResult` 门（run_id+task_key_hash+attempt_id+lease_owner+status='running'，stale 返回 false、不覆盖 result_json）。旧 task attempt 配新 owner 提交必被拒。
3. member 的 `request_task_attempt_id` 永不改写；提交结果记录 `source_batch_attempt_uuid` 关联原始响应与新提交 attempt；task 已被其他合法 attempt 完成 → 恢复 worker 跳过、不覆盖。
4. 恢复矩阵 = §16 表逐行执行；T/R 映射、成员、顺序或指纹不符 → `execution_batch_version_conflict`（不解释响应、不重编号、不重组）。
5. repair 恢复与**三身份持久化映射**（v1.1 补充）：主 batch `split_done` 后按 §15 单 task 语义恢复。三身份分别进入明确链路，不得互相复用：

   | 身份 | 持久化链路 |
   | --- | --- |
   | `task_attempt_id` | `analysis_behavior_tasks.attempt_id`、lease fencing、`commitBehaviorTaskResult` 条件提交门 |
   | `repair_budget_attempt_id` | reservation 的 `attempt_id` + `llm_call_receipts.attempt_id`（预算聚合身份） |
   | `repair_request_key` | `llm_call_receipts.request_key`（实际请求/receipt 唯一身份；构造器与 batch 相同：`${repair_budget_attempt_id}|${stage}|${sequence}`） |

   **禁令**：不得沿用现有单 task repair 代码把 `task_attempt_id` 写进 repair 的 billing context / receipt `attempt_id`——repair 的 `LlmBillingContext.attemptId` 必须是 `repair_budget_attempt_id`，否则预算聚合与 task 身份混流。v1.0 不新增 repair 原始响应存储——已调用未提交的 repair 恢复可能重发，必须保留真实 receipt 与 unknown 处置，不得宣称 repair 零调用恢复。
6. 测试锚点：`tests/execution-batch-recovery.test.ts`、`tests/behavior-task-leases.test.ts`。

### 23.6 C6 Result compatibility contract（结果兼容契约）

回答：batch payload 如何无损复用现有单 task 解析、清洗和提交。

1. 外层协议只做 T 包装与映射；每 task payload 经 `JSON.stringify` 原样交给现有 `parseDescribeContent`/`parseJudgeContent`（lib/behavior-unit-ai.ts）。不复制 Zod schema、不定义第二套业务协议；转换前后规范化 payload **深度等价**（测试断言）。
2. 失败隔离 = §12 表逐条：单 task 缺 region/非法 payload/重复别名/跨 task 证据引用只影响该 task（allowSet 不扩大），其余 task 独立提交；模型返回未知 task ID 忽略并记录诊断。
3. 截断与部分成功：describe/judge `finish_reason=length` → 全部未提交成员按 `output_truncated` 未决（复用截断推导），绝不转 `no_behavior`；整体 JSON 语法错误抛 `BatchProtocolError`，整批硬失败/受控重试；JSON 完整但缺整个 task 或缺 region → 缺失者 unresolved，其余独立处理。
4. 独立推导导出：Task 7 从 lib/behavior-unit-extraction.ts 以 `deriveBehaviorTaskResult`（现私有 `deriveTaskResult`）与 `behaviorTaskTruncatedResult`（现私有 `truncatedResult`）最小导出（必要时连同 `deriveTaskOutcome`）；`extractBehaviorTask` 对外行为不变。
5. 场景/feature 归属 task 内作用域：HP-1 等 scenario reference 由模型在 task 内生成，走现有清洗、归属和局部身份校验；不得跨 task 归属。
6. 测试锚点：`tests/execution-batch-protocol.test.ts`、`tests/execution-batch-extraction.test.ts`、`tests/behavior-unit-extraction.test.ts`。

### 23.7 §22 十六项冻结点映射

| §22 冻结点 | 结论 | 依据 |
| --- | --- | --- |
| 1 四种真源无职责重叠 | 达成 | §5 责任表；C1 键清单各自独立写权 |
| 2 键及关联可唯一追踪 | 达成 | C1.1 五类实体唯一键 |
| 3 R 映射随 member 持久化、不重编号 | 达成 | C1.2、C2.3 |
| 4 独立 request key、幂等粒度=实际请求 | 达成 | C1.1、C3.5 |
| 5 双阶段响应独立校验和恢复 | 达成 | C3.4、C5.1 |
| 6 judge 成员与 describe 一致、租约只影响提交 | 达成 | C2.1/C2.6、§10.2 |
| 7 原 attempt 不倒退；重试建新 attempt | 达成 | C4.1、C2.6 |
| 8 双重 fencing 分离 | 达成 | C5.2 |
| 9 task 独立提交隔离 | 达成 | C6.2、C5.2 |
| 10 预留=最大账务暴露、重试不在原 reservation | 达成 | C3.7、C2.6 |
| 11 费用不因未提交释放、unknown≠零 | 达成 | C3.6、C3.7、C3.9 |
| 12 部分提交=派生事实 | 达成 | C4.3 |
| 13 repair 路径/预算身份/激活等待无歧义 | 达成 | C5.5、§15 |
| 14 planner/parser 升级无静默改变 | 达成 | C1.3、C5.4 |
| 15 payload 无损复用、截断/部分 JSON 不伪装成功 | 达成 | C6.1、C6.3 |
| 16 性能目标服从硬门禁 | 达成 | §20.3 目标全部以 §20.1/§20.2 为前置 |

### 23.8 冻结参数表

| 参数 | 冻结值 |
| --- | --- |
| 组批上限 | 4 tasks / 32,000 UTF-8 主内容字节 / 24 regions |
| fallback 原因 | `oversized \| blank_fragment \| unsupported_task_shape` |
| `MAX_BATCH_RESPONSE_BYTES` | 4,000,000（< MEDIUMTEXT 16MB 与数据库写入限制） |
| `failure_class` | `local_pre_dispatch \| provider_rejected \| provider_execution_failed \| transport_failure`（`failed` 行必填，费用判定见 C3.2/C3.6） |
| `request_key` 格式 | `${batchAttemptUuid}\|${stage}\|${sequence}`（明文复合键） |
| 版本常量 | planner/prompt/schema/parser 均为 `"1"` |
| 执行模式 | `ANALYSIS_BEHAVIOR_EXECUTION_MODE = task\|batch`，默认/垃圾值 task |
| 提取模式（Task 13） | `ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE = describe_judge\|fused`，默认 describe_judge |
| benchmark 门 | margin -0.03 / 宏误报升幅 0.03 / 宏证据支持降幅 0.02 / 最少配对样本 30（**样本下限≠统计功效证明**）；报告必须分层给出普通/residual/大 task/全体四组；结论三值 `pass / fail / inconclusive`，`inconclusive`（样本或统计证据不足）**不得视为通过**；墙钟北极星=同规模全量 20 分钟挑战目标（协议定稿于 `docs/benchmark/execution-batch-v1.md`，Task 11 执行） |

### 23.9 plan set / plan 表职责划分（v1.1 修订）

| 表 | 主要职责 |
| --- | --- |
| `analysis_behavior_batch_plan_sets` | run_id、plan_set_id、plan_set_fingerprint、planner_version、预期 plan/task 数量、发布状态（building/ready）、`fallback_assignments`（JSON） |
| `analysis_behavior_batch_plans` | batch_key、manifest_hash、ordered_task_keys、task_alias_map、grouping_rules_fingerprint、input_budget_snapshot |

- plan set 是完整任务路由分配（batch + fallback）的唯一真源；单个 plan 不重复保存整个 plan set 的指纹或 fallback 信息。
- `ready` 之后两张表均为 insert-only，已发布分配不可修改；恢复时以 plan_sets 的 fingerprint/fallback_assignments 加各 plan 成员重算比对，不符即 `execution_batch_version_conflict`。
