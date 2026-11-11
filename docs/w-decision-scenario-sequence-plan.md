# W-DECISION · 场景序列：让流程图成为真流程

> 日期：2026-11-12
> 来源：产品地图走查（docs/product-map-plan.md v1.2 登记）→ 用户裁决「立项，最小序列版先行」
> 用户原话锚点：「流程图应该针对每个功能才对。例如添加产品库，就是有个流程的。」
> 状态：已立项，批次未开工。

---

## 0. 一句话与裁决记录

**一句话**：提取端给场景新增一个可选整数 `step`——happy 场景的 `step` 1..N 构成该功能该情境下的主步骤链，edge/error 场景的 `step` 表示它挂在哪一步之后；流程图从「平行扇出」升级为「START → 步骤链 → 分支/错误终点」。**不新增 condition 文本字段**：分支条件就是分支场景自己的 action/outcome，不扩大判定文本面。

裁决记录（用户，2026-11-12）：

1. 立项范围 = 最小序列版先行；决策问句节点、边状态标注等完整形态后置。
2. **判定面裁决：`step` 不进入行为变更判定**（`scenarioBehaviorChanged` 不比较它）。理由：BM-9 教训（formatter 重排即虚报），模型回显顺序抖动会制造假变化；代价是真实的步骤重排不触发漂移提示，可接受并写入口径注脚。
3. 现状事实（走查确认）：流程图已是每功能一张（场景|流程图 tab）；缺的是顺序，不是层级。

## 1. 数据形状（唯一新字段 `step`）

- **AI schema**（`lib/ai.ts:14` scenarioSchema）：`step: z.number().int().min(1).max(40).optional()`。缺省合法——旧响应、旧锚定回显、未编号场景照常解析。
- **语义约定（写进提取 prompt）**：happy 场景按交付顺序编号 1..N（同 feature 同 context 组内）；edge/error 场景的 `step` = 它分支自的 happy 步骤号；不写则确定性回退（见 §3）。
- **确定性归一**（`normalizeScenarioAliases` 层）：`step` 缺失 → null；越界/非整数/null → null + 日志（与 `capScenariosPerFeature` 同风格），**不拒绝整个响应**。
- **合并**（`lib/extraction-merge.ts`）：step 随场景行透传；同稳定键去重保留任一方 step（行为等价去重不比较 step）；`nextReference` 重编号不影响 step（step 是步骤号不是引用号）。

## 2. 判定面（明确不动）

- `scenarioBehaviorChanged`（`lib/spec-diff.ts:138`）只比较 category/context/action/outcome——**不加 step**。测试锁定「仅 step 不同 → 非行为变化」。
- SpecScenario 类型加 `step?: number | null`，但 spec_changes 的 before/after 序列化包含 step（账本如实记录，只是不触发 kind=changed）。

## 3. 存储与继承

- migration 067：`spec_scenarios` ADD `step_order INT NULL`（工作台 scenarios 同列）。归一后 null 落 NULL。
- carry-forward / 增量锚定：step 随场景原文回显沿用（`featureContinuitySection` 透传），未受影响功能保持上一版 step——与「未受影响功能保持上一版措辞」同语义，测试锁定。
- 回填：存量数据 step 全 NULL，流程图对 NULL-step 场景保持现行扇出形态（**新旧形态共存，不强制回填**）。

## 4. 流程图渲染（`lib/feature-flow.ts`）

分组内（context 相同）：

- 存在合法 step 的 happy 场景：按 step 升序连成主链 `START → 1 → 2 → … → N`（连接为顺序边）。
- 无 step 的 happy / 全部 edge / error：保持现行扇出（从 START 独立展开），错误/边界样式不变（红/黄虚线已上线）。
- edge/error 的 step 指向存在的 happy 步骤：从该步骤节点连分支边；指向越界/缺失：回退扇出。
- **不添加 END 节点**（不制造结束条件；链尾自然终止）。
- 混合形态（部分有 step 部分没有）合法性优先：链只由有 step 的 happy 构成，其余扇出，图例注脚说明「步骤链来自分析标注的顺序」。
- 现有测试锚定的坐标/无终态断言按新规则更新（`tests/feature-flow.test.ts` 显式修订，不是迁就）。

## 5. 批次与放行闸门

| 批次 | 内容 | 闸门 |
|---|---|---|
| WD-1 | schema + 归一 + prompt（分析主提取与 behavioral describe 两步都加 step 语义）+ 合并透传 + 单测 | 单测：解析回退/合并保留/越界置空；`scenarioBehaviorChanged` 忽略 step 的锁定测试 |
| WD-2 | migration 067 + 读写 + carry-forward + spec-diff 类型扩展 | 「未受影响功能保持上一版 step」测试；migration 幂等 |
| WD-3 | 流程图渲染升级 + 测试更新 | 链/扇出混合形态快照测试；NULL-step 数据渲染与旧版一致 |
| WD-4 | 重放验证：superset 盲评窗口重跑（W0-2 同口径）+ 增量重放三跑 | **召回 ≥80% 不回退、精确率不回退、FUR=0 守住**；重放 M8/M9 无新增虚报；然后 dogfood（CoDelphi 自体「添加产品库」等流程）验收人读感 |

**WD-4 是放行产线的唯一闸门**；WD-1..3 可合并在本地完成后一次性进重放。

## 6. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 模型编号噪音：乱序/跳号/重复号 | 归一层容错（非法 → null 回退扇出），不拒绝响应；WD-4 重放观察噪音率 |
| R2 | 顺序抖动造成虚报 | 已裁决 step 不入判定面；账本 before/after 如实记录但不触发 changed |
| R3 | prompt 变长/成本上升 | step 语义一句话加进既有 prompt；`llm_call_receipts` 对账（SAU 仍每 run 一次） |
| R4 | 新旧形态共存混乱 | 注脚写明「步骤链来自分析标注的顺序」；NULL-step 与旧渲染逐像素一致由 WD-3 测试锁定 |
| R5 | 与并行会话冲突 | 提取管线文件（ai.ts/extraction-merge.ts/spec-diff.ts）此前有并行在途改动，开工前先 rebase 对账 |

## 7. 非目标（本立项不含）

决策问句节点独立文案、边上状态标注（accepted/rejected 类）、序列进入漂移/判定面、condition 自由文本字段、多情境跨组连线、回填存量。
