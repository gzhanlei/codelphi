# 首分析覆盖率测量：窗口上限与选择质量的双重失效

> 2026-11-08。测量脚本：`scripts/measure-first-analysis.ts`（可复现：`npx tsx scripts/measure-first-analysis.ts`，需 `GITHUB_TOKEN` + `AI_API_KEY`；不建产品、不写库、不落计费）。
> 背景：「160KB 覆盖上限」在盲评中已知（→覆盖披露），生产 v95 坍缩事故（178→83 场景）后立项前量化。

## 方法

对 5 个公开仓库各执行一次**真实的首分析前半段**（切片规划器按生产预算选源 → AI 全量提取，`assertEvidence` 口径的越界引用计数为指标而非抛错），与 GitHub 全树（recursive）对比。实现面口径 = `evidenceKind` 分级的 implementation 文件；代码口径 = 其中的 `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`。引用覆盖 = 规格证据引用的实现文件 / 实现面。规划器供给率 = 窗口内代码文件 / 全仓代码文件（AI 看不到的文件不可能被引用）。

## 数据

| 仓库 | 实现面 | 代码量 | 窗口（实际装配） | 代码供给率 | 规格 | 引用覆盖（文件/字节） | 全量外推* |
|---|---|---|---|---|---|---|---|
| expressjs/express | 98 文件 / 137KB | 109KB | 19 文件 / 82KB | 26%（**lib/ 零供给**） | 8 功能 / 31 场景 | 1.0% / 2.0%（仅 package.json） | 11–27 |
| colinhacks/zod | 379 / 5.8MB | 1,686KB | 43 / 176KB | 14%（**src/ 零供给**） | 11 / 33 | 3.2% / 0.7%（bench/config） | 169–422 |
| pallets/flask | 74 / 736KB | 354KB | 39 / 188KB | 88% | 13 / 39 | 23% / 27.8%（src/flask/*.py） | 35–89 |
| honojs/hono | 379 / 1.4MB | 894KB | 55 / 180KB | 17%（**仅 adapters/**，src/ 零供给） | 8 / 29 | 1.3% / 2.7%（deno adapter） | 89–224 |
| calcom/cal.com | 6,808 / 195MB | 16,551KB | 44 / 195KB | 0.3%（**仅 configs/docs**） | 12 / 37 | 0.1% / 0.03%（config/workflow） | 1,655–4,138 |

\* 外推密度带 0.1–0.25 场景/KB 代码：flask 实测 0.11（354KB→39 场景），CoDelphi dogfood 0.23（~960KB→221 场景）。假设密度均匀——库类（zod/hono）API 面密度偏高、应用类偏低，数量级参考。

## 三个发现

**F1 供给率坍缩（窗口上限）**：代码量超过 ~350KB 后供给率跌入个位数百分比（zod 14%、hono 17%、cal.com 0.3%）。160KB 窗口对真实仓库最多覆盖六分之一（CoDelphi 自己 960KB），对 monorepo 是千分之一量级。这是已知的「160KB 覆盖上限」，本次量化。

**F2 供给质量失败（选择启发式，与窗口大小无关）**：四个 JS/TS 仓库的窗口被错误内容填满——
- express：19 个文件 = package.json + Readme + examples 视图 + 13 个测试文件，**框架核心 lib/ 一个没进**；`test/app.route.js` 这类文件名撞上 "route" 信号被误选；
- zod：43 个文件 = vitest 配置、play.ts、.claude 脚本、36 个 bench 文件，**src/ 一个没进**；
- hono：55 个文件全部来自 adapters/*（aws-lambda/bun/cloudflare/deno），**src/（router、middleware、核心）一个没进**——预算在一个子树里烧光；
- cal.com：configs、GitHub workflows、.opencode 技能文档，**apps/packages 应用代码零供给**。
- 反例 flask（Python）：供给 88%、引用真实 src/flask/*.py，覆盖 23–28%——管道在无噪声小仓库上能正常工作。

**F3 窗口软顶超限**：5 个仓库实际装配 82–200KB，其中 4 个超出 160KB 预算 10–22%（176–200KB）——预算在按文件/行区间粒度选择时不做装配后强制。

## 责任划分（探针 `--selection-only`，不调 AI）

AI「引用 discipline」本身基本成立：它引用的路径都在窗口内、且引用了窗口中行为最相关的内容（express 只能引 package.json 因为那是窗口里唯一的 implementation 级文件）。**失效在规划器**：文件名信号启发式（manifest/entrypoint/route/auth…）被 `app.route.js`、`bench/*.ts` 这类命名骗过，目录遍历顺序（adapters/ < src/）让预算在噪声子树里耗尽。规格功能数恒定在 8–13、场景 25–40（与仓库大小无关），是窗口边界而非仓库边界的直接证据。

## 结论与立项建议（修复排序）

1. **选择质量修复**（便宜、立即生效，先做）：窗口供给排除/降级 tests、examples、bench、docs、config 类内容；目录遍历按广度优先分散预算（禁止单子树烧尽）；常见源码根（src/packages/apps/lib）优先。此项不解决尺寸问题，但让 160KB 窗口真正装「行为源码」——flask 的 27% 字节覆盖证明同窗口下质量上限的差异。
2. **分片多趟提取**（尺寸问题的答案）：按区域多次规划+提取、合并进同一 spec 版本，配护栏（本次已落地：场景数骤降 >30% 告警）。这是把 1% 量级覆盖提到可用水平的唯一路径。
3. **覆盖披露**（已知项跟进）：首分析产物标注「本次窗口覆盖实现面 X%」，把静默不全变成显式披露。

## 局限

单次采样（temperature=0 但网关侧非确定性）；5 仓库非随机样本（知名度高、结构干净）；密度外推假设均匀；树截断时实现面为下界（本次 5 个仓库均无截断）。

---

## 修复后复测（2026-11-09，选择质量修复 F2/F3 + 信号缺口补齐）

修复内容（按计划第 ① 步）：切片选择策略（`lib/slice-planner/selection-policy.ts`，噪声文件/目录剔除 + BFS + 子树份额上限）、窗口装配硬顶（`sliceToSourceFiles` maxBytes + slice.files 对齐）、**信号缺口补齐**（`baseSignals` service 扩展名漏 `.js`、entrypoint 漏 index.js/server.js/app.js/main.js——纯 JS 仓库源码此前零信号，express 的真实根因）。

| 仓库 | 引用覆盖（字节）修复前 → 后 | 窗口修复前 → 后 | 备注 |
|---|---|---|---|
| express | 2.0% → **46.4%**（23×） | 19 文件/82KB → 8/64KB | lib/ 进窗，全部为真实源码 |
| zod | 0.7% → 1.4% | 43/176KB → 55/113KB | src/ 进窗；src 单文件大，字节覆盖仍受窗口约束 |
| flask | 27.8% → 25.1% | 39/188KB → 15/155KB | examples/tests 剔除后预算集中在 src 大文件，覆盖持平、内容质量更高 |
| hono | 2.7% → **7.1%** | 55/180KB → 28/150KB | src/ 替代 adapters/ 成为窗口主体 |
| cal.com | 0.03% → 0.1% | 44/195KB → 37/156KB | apps/packages 进窗 |

- **软顶超限消失**：5 个窗口全部 ≤160KB（此前 4/5 超限 10–22%）。
- flask 微降 2.7pp 属单次采样噪声与字节口径集中效应；其引用内容从「examples+src 混杂」变为「纯 src」。
- 剩余缺口回到 F1（窗口上限）：zod/hono/cal.com 的字节覆盖仍受 160KB 约束——这正是第 ② 步「分片多趟提取」的立项依据。
