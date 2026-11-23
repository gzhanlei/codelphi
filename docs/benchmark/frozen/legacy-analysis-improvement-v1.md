# Legacy 分析改进 Ground Truth 与成本质量协议（v1）

日期：2026-11-23。状态：执行前冻结；不授权生产启用或部署。

## 1. 真值独立性

- `legacy-analysis-cases-v1.json` 的预期只从源码语义、调用关系和预登记行为推导；不得读取或复制 legacy/candidate 输出来反写真值。
- 真值中的 `unknown` 表示现有支持边界无法确认；`not_analyzed` 表示尚未分析，二者不得混写。
- 代码事实不是产品行为结论；依赖候选不是 Behavior Delta；证据 stale 不是行为删除。
- 整分支独立复审必须再次核对真值；发现真值错误时先修正真值，不得修改预期去迁就实现。

## 2. 冻结案例

| 案例 | 能力 | 必须证明的结果 |
| --- | --- | --- |
| `archive_limit` | Code Facts | 解析 `MAX_ARCHIVE_BYTES = 500_000_000`，修复预登记漏报 |
| `alias_and_shadowing` | Code Facts | 同文件别名取 500,000,000，参数遮蔽取 100，不混淆 |
| `shared_permission` | 依赖影响 | 只有 `uploadFile` 是复核候选，`listFiles` 不受影响 |
| `strict_operator` | Code Facts | `>` 与 `>=` 在 500,000,000 边界上行为不同 |
| `dynamic_unknown` | 依赖影响 | 动态 import 保持 Unknown，只有限扩大，不断言无影响 |
| `critical_unknown` | 依赖影响 | 支付网关注入无法静态确认，关键边界允许回退全量 |
| `refactor_same` | 证据连续性 | 改名但实现相同：行为 same、证据 re-anchored；不要求 correctedMisses |
| `refactor_changed` | 证据连续性 | `<=` 改为 `<`：行为 changed、旧证据 stale |
| `split_unknown` | 证据连续性 | 拆分无法确认身份：行为 unknown、证据 stale、需要复核 |
| `delete_stale` | 证据连续性 | 文件删除只证明证据 stale，不产生行为删除 |

## 3. 冻结 L 基线

`legacy-analysis-baseline-v1.json` 直接复用已完成的 L：`codelphi_bench_l`、runId 82、specVersionId 65、outputHash `e23dc1bcef615ab4dd790f5a5483c62af427378e5e8ade3e65b338d24e0e12d6`。真实回执为 148 次 LLM 调用、1,268,333 tokens、USD 0.276366。不得重跑 L 替换不利结果；同数字的 I1 runId 82 位于另一 scratch 库，不得混用。

## 4. 门禁

- 输入、真值或测量字段缺失：inconclusive，停止对应阶段。
- candidate 的 LLM 调用数不得高于 baseline；`candidate.totalTokens <= baseline.totalTokens * 1.05`，含等号边界。
- 运行 `archive_limit` 时，candidate 的 correctedMisses 必须高于 baseline；`refactor_same` 子集不强制该指标。
- falseDeltaRate 不得上升；事实解释错误、依赖误报和 stale 漏检在所测能力范围内必须为零。
- 运行依赖或 stale 案例时必须有对应命中；Unknown 案例必须显式携带 `resolution = "unknown"`。
- failed 优先于 inconclusive；任何非 passed 结果都不得进入下一阶段。
