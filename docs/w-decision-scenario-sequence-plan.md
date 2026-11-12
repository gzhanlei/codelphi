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

## 8. 修订记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-11-12 | v1 | 初稿立项（用户裁决最小序列版先行；step 不入判定面） |
| 2026-11-12 | v1.1 | WD-1..3 落地并本地端到端验证（提交 8952ec9 / c3d1986 / d03608a）：schema `.nullish()` 与 DB null 同形、锚定行带 `步骤 N` 保回显链、流程图 step 链 + 分支归属渲染、NULL-step 数据逐像素一致由既有套件锁定；全套门禁过（typecheck / 197 测试文件 0 失败 / build）。**并行会话竞态事件**：同仓另一会话做生产事故回滚时 stash 了本工作在途文件（74cbcd3，已 pop 恢复）并以旧版本覆盖了 feature-flow/spec-diff 等（已重应用提交）；stash@{1} 是更早的 B1 半成品非本工作遗留，未动。WD-4 重放验证待部署后执行。 |
| 2026-11-12 | v1.2 | **呈现层升级（用户裁决）取代 v1.1 的「NULL-step 逐像素一致」不变量**：流程图改为单一「开始工作」入口 + 情境条件边（每个情境组的第一条入口边携带 context 标注）；无链组场景竖直堆叠（横排只保留给 step 主链，避免入口线穿越节点框）；新增 `structured` 判定（多情境组或任一 step 链），两者皆无时不再渲染图（不画没有控制结构支撑的假流程）。动机：6452 形态（29 场景 27 情境全 NULL-step）下 27 个独立「开始」节点不可读，且旧图不表达顺序/条件/循环任一基本结构。循环/condition 标注协议仍是非目标（§7 不变）。 |
| 2026-11-12 | v1.3 | **自动布局与交互垂直切片**：静态 SVG 迁移到 React Flow + ELK，步骤链采用纵向分层与正交边；8 个以上纯入口扇出采用四列多行布局及共享干线/行间支线，不虚构顺序。节点支持缩放、拖拽、fitView 与点击详情，完整 Context / Action / Outcome 和代码证据进入侧面板（窄屏置于画布下方）。真实 26 场景 / 26 情境 / NULL-step 案例的图尺寸由 7344×388 收敛到 1160×1232；桌面与 390px 窄屏均完成浏览器交互验收。判断节点、END、多场景聚合与边状态协议仍为后续语义批次，不在本切片虚构。 |
| 2026-11-12 | v1.4 | **证据约束的语义流程图（本地实现完成）**：新增 `spec_feature_flows` 派生表、AI 候选图 + 确定性校验、场景指纹失效、事务外版本同步、单工作台功能回填及 ELK edge sections / 标签布局。旧 START 扇出构建器已删除；无有效图只显示场景清单。真实 RepoMap 生成经一次校验反馈重试后通过：14 节点、15 边，documentary/duplicate 独立排除。全套 203 测试文件、typecheck、build 通过。空标签归一与一次校验反馈重试不改变证据门槛。生产镜像 `codelphi-server:sha-dce6973` 已部署并应用 migration 068，feature 9176 回填完成（14 节点、13 边、16 排除场景）；桌面与 390px 窄屏线上验收通过。**WD-4 重放仍未执行，不得视为已通过。** |
