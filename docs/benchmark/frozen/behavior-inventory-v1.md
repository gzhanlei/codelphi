# 行为清单配对 benchmark 冻结协议（behavior-inventory-v1，2026-11-20）

本文是 inventory 编排（`FULL_ANALYSIS_MODE=inventory`）切换前人工验收的**冻结协议与测量口径**。
统计实现：`lib/behavior-benchmark.ts`；离线测量入口：`scripts/measure-inventory-analysis.ts`；
单仓对照文件格式：同目录 `behavior-inventory-v1.schema.json`。

**状态：人工 shadow 验收尚未执行。** 本协议只交付 shadow/离线对照能力；验收结果必须再次交用户审阅，
是否把任何环境切到 `inventory` 是独立决定，实现 agent 不得依据场景数或单次 shadow 结果自行批准。

## 1. 验收对象仓库

- CoDelphi 自身（大型 Next/TypeScript 多入口仓库）；
- `expressjs/express`（公开导出与共享逻辑）；
- `pallets/flask`（非 Next 检测器与剩余兜底）；
- `apache/superset` 的既有冻结 benchmark fixture（动态注册与插件场景）。

## 2. 冻结规则（先于看到任何路径输出）

1. 评审必须是**未查看新旧路径输出**的人；冻结时间（`frozenAt`）必须早于评审看到输出的时间。
2. 每仓冻结**至少 30 条**人工行为预标。30 条是初始下限，**不等于统计功效充分**（见 §5）。
3. 每条行为必须记录：`behaviorId`（仓内唯一）、源码定位（path + 行区间）、行为描述（触发/操作）、
   外部可观察结果、必要证据（代码定位）。
4. 冻结后不得因新旧输出内容而增删改行为清单；需要修订即重新冻结并记录新 `frozenAt`。

## 3. 盲评与配对规则

- 基本单位是**冻结人工行为**，不是任一系统生成的场景数。一个场景可命中多个行为，
  多个场景也可共同命中一个行为——拆分/合并计入 `splitMerge`，分别报告，不并入召回率。
- 新旧输出先按行为等价归并，再由**不知道新旧来源**的评审判定。
- 行为命中必须同时具备：对应触发/操作 + 外部可观察结果 + 必要证据；只提到函数名不算命中。
- 配对只发生在同一 `behaviorId` 的两路径判定之间（`hits.legacy` / `hits.inventory`）。
  **仅出现在一条路径的输出行为列入 `unmatchedOutputs`，绝不人为构造配对。**
- 误报分母 = **各路径实际评估的输出行为数**（`outputEvaluation.<path>.evaluatedOutputs`，
  全部评估或分层随机评估至少 100 条）；误报率 = 无充分代码证据的行为数 / 该路径已评估输出行为数。
  两路径分母互相独立，不匹配输出不摊薄对方分母。
- 证据有效率、拆分/合并率、未决率分别报告，不合并进召回率。每仓独立报告，不允许只给混合总平均。

## 4. 非劣效门槛（配对检验）

- 每仓 `Delta = Recall_inventory − Recall_legacy`，使用 **Newcombe 配对差值 95% 置信区间**
  （method 10：两条 Wilson 区间 square-and-add）。**禁止用两个独立 Wilson 区间代替差值检验**；
  各路径自身的召回/误报/证据比例保留各自 Wilson 区间，仅作不确定性描述。
- 每仓要求 `LowerCI(Delta) > -0.03`（严格大于）；宏平均差值点估计也不得低于 -0.03
  （宏平均只作描述，不伪造独立比例区间）。
- 辅助门禁（不替代配对召回门禁）：宏平均误报率上升 ≤ 3 个百分点；宏平均证据有效率下降 ≤ 2 个百分点。
- 过程门禁前置：单元清单、区间、锚点与激活门禁必须**先全部通过**（`processGates`），
  benchmark 结果不能抵消过程缺陷。
- 结论映射：区间整体高于 -0.03 → 该仓 non_inferior；整体低于 -0.03 → inferior（整体 failed）；
  跨过 -0.03 → inconclusive。

## 5. 样本充分性与 inconclusive 处置

- 30 条只是每仓初始最低样本数；样本充分性以**配对差值区间宽度**判断，不以条数判断。
- 区间跨过 -0.03 无法判定非劣效时：先增加人工预标（回到 §2 重新冻结），再重测；
  仍不足则该仓为 **inconclusive，整体不得当作通过**。
- 任一门禁失败、过程门禁未通过或证据/误报越界：停止，**不切换** `FULL_ANALYSIS_MODE=inventory`。

## 6. 测量执行（显式 shadow/离线）

```bash
tsx scripts/measure-inventory-analysis.ts \
  --input codelphi.comparison.json \
  --input express.comparison.json \
  --input flask.comparison.json \
  --input superset-fixture.comparison.json \
  --out report.json
```

- 脚本只读取冻结对照 JSON：不连接数据库、不调用 AI、不读写规格或激活状态、不部署资源，
  不读取也不修改 `FULL_ANALYSIS_MODE`。
- 退出码：0 = passed；1 = failed（含过程门禁未通过）；2 = inconclusive；3 = 输入校验错误。
- 误报、证据、拆分/合并、未决、成本、耗时在报告中**分别输出**（telemetry 段），不作合并打分。
- 报告的 `passed` 只代表统计门禁通过；启用 inventory 仍需用户单独批准。
