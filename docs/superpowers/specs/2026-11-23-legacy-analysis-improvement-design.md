# Legacy 分析管线事实、依赖与增量准确性改进设计

日期：2026-11-23
状态：设计已确认，待实施计划评审

## 1. 目标与原则

保留生产 legacy 及其分区、diff 必选、行为面枚举、证据清洗和 carry-forward，不再建设 inventory/batch 或通用程序分析平台。每次只解决一个已登记失败类型，先证明质量收益，再允许扩大能力。

核心边界：

- 确定性工具提供可复核的代码事实，不直接生成产品行为结论。
- LLM 在原始源码和少量结构化事实之上归纳行为，不增加模型调用。
- 依赖索引只发现影响候选，不自动产生行为变化。
- 证据失效不等于行为删除。
- 没有独立 Ground Truth 和成本质量收益，不得扩展分析能力。

## 2. Code Facts 与 Behavior Claims

第一阶段只实现三类 `CodeFact`：

1. 常量声明及可解析实际值；
2. 比较表达式及数值边界；
3. 条件表达式及 true/false 代码区间。

每条事实必须保存：

```text
path / symbol / ranges / originalExpression
resolution / extractorVersion / evidence
```

`resolution`：

- `resolved`：值与位置可在支持范围内静态确认；
- `unresolved`：动态值、作用域不明、跨文件或支持范围外；
- `not_analyzed`：尚未分析，不能解释为不存在。

例如 `file.size > MAX_FILE_SIZE` 且 `MAX_FILE_SIZE = 500000000` 是事实；“超过 500 MB 一定上传失败”仍需结合异常与调用上下文，由 AI 归纳并附证据。不得将 AST 节点直接当成行为结论。

事实加入现有 AI 调用的输入，同时保留原始源码。不得新增 LLM 调用，不得让事实成为唯一信息源。

## 3. 依赖关系分级

依赖结果分为：

| 类型 | 含义 |
| --- | --- |
| `file_dependency` | A import B，只证明文件依赖 |
| `symbol_dependency` | A 的符号 X 静态引用 B 的符号 Y |
| `possible_behavior_impact` | 结合现有行为证据，建议复核的场景 |
| `unknown_dependency` | 动态、别名或解析不完整，不能断言无影响 |

每个 `possible_behavior_impact` 必须保留到具体符号的依赖链，例如 `permission.ts#checkPermission → upload.ts#uploadFile → 上传场景`。它只产生复核候选，不自动产生 Behavior Delta。

Unknown 分级处理：

- 普通工具函数：记录 Unknown，有限扩大检查；
- 公共业务服务：扩大依赖范围；
- 权限、支付、数据库写入等关键边界：保守回退全量。

首版仅支持 TypeScript 相对 import、导出符号和可静态解析的符号引用，不实现通用调用图或跨语言依赖分析。

## 4. 行为身份与证据有效性

本轮不实现完整 Behavior ID 智能匹配系统，先实现函数级证据锚定、同文件局部变化识别和失效判定。

行为状态首版只允许：

- `same`
- `changed`
- `unknown`

证据状态首版允许：

- `current`
- `re-anchored`
- `stale`

规则：

- 函数改名、语义不变：`same + re-anchored`；
- 函数内部逻辑变化：`changed 或 unknown + stale`；
- 函数拆分：身份 `unknown`，相关证据可部分 stale；
- 文件删除：证据 stale，不能直接判定行为删除；
- 共享函数变化：相关行为待复核，不直接判行为变化；
- split / merged 无法确认时保持 `unknown`，不得强行匹配。

`Evidence Delta` 与 `Behavior Delta` 分开输出。

## 5. 独立 Ground Truth Benchmark

每个案例先由独立评审确认：

```text
原始代码 / 变更代码 / 变更范围
原有行为 / 变更后行为
实际受影响场景 / 不应受影响场景
应当 Unknown 的部分
```

不得以“同一模型生成全量与增量结果，再判断它们一致”代替正确性验证。错误真值必须修正，不得为了匹配实现保留。

至少覆盖：

- 数值常量、别名和变量遮蔽；
- 共享权限函数只被部分函数调用；
- 函数改名但语义不变；
- 同名函数 `<` 改为 `<=`；
- 普通动态依赖 Unknown；
- 支付或权限等关键依赖 Unknown；
- 函数拆分、删除和共享逻辑变化。

分别测量行为事实、依赖影响、增量 Delta 和证据 stale，不把总体一致率当成正确率。

## 6. 成本与收益门禁

每种能力必须同时满足：

- 不增加 LLM 调用次数；
- 事实注入 token 增幅不超过 5%；
- 支持语法的静态事实无错误提取；
- 预登记目标漏报得到修复；
- 依赖候选只扩大必要范围，不产生虚假 Behavior Delta；
- 证据失效不造成错误行为删除；
- 质量收益不成立或成本超标即停止该阶段，不进入下一阶段。

额外记录：

- 每个被修复漏报消耗的 token；
- `FalseDeltaRate`；
- 静态事实注入量与实际利用率；
- 依赖候选命中率和误报率。

## 7. 实施顺序

1. 建立独立 Ground Truth 和 legacy 成本/质量基线。
2. 实现三类 Code Facts 并验证已知漏报消失。
3. 实现文件/符号依赖与风险分级。
4. 实现证据锚定和 stale 判定。
5. 仅按残余错误决定是否增加 ORM、事件、动态 import 等能力。

生产继续保留 legacy，新能力只做 shadow 验证，不默认启用，不执行生产部署。
