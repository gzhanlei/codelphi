# BM-1 增量盲评预标（已冻结）

> 窗口：apache/superset `2645396b7a8ea1f5b1978f94b2ac0ec0c1b1397b` → `a131fcb623d88ed9eb7e7a414e226437423d645c`
> 冻结时间：2026-11-10（用户确认后、首次目标运行之前；冻结后不得改动，重评须另立文件并声明差异）
> 11 commits / 99 files（≤200 ✓）；基线规格 = v48（run 63，39 功能 / 222 场景）
> 冻结材料：本目录 6 个行为提交 patch + bm1-window-files.txt（窗口文件清单）+ bm1-feature-paths.tsv（v48 功能级索引快照）
> 判定人：项目开发者（solo 口径，缓解措施照 pilot-blind-eval-superset-rerun-2026-11-10.md §1）
> 预标方法：逐 commit 读 GitHub 真实 patch（冻结件），对照 v48 场景原文逐条判定；机械受影响面 = v48 spec_file_index ∩ 窗口 diff（独立于行为判断先行计算，防事后迎合）

## 1. 运行前预测（防事后迎合，运行前落盘）

**预测模式 = incremental**。机械受影响面（索引 ∩ diff，11 功能 = 28% ≤ 60% 闸门）：

发布流程工具（labeler.yml）、REST API（security.mdx）、SQL 编辑器（security.mdx）、安全角色与认证（security.mdx + dashboards/api.py）、数据源连接（security.mdx）、语义视图批量删除（recently-archived.mdx）、安全依赖管理（pyproject.toml）、嵌入式访客凭据回退（constants.ts）、数据库连接配置（constants.ts + types.ts）、数据集列表管理（DatasetList 页面）、仪表盘（dashboards/api.py）

**机械面盲区预测**：GT-affected 中的缓存层、嵌入式仪表盘不在机械受影响集——只能经 W0-10 ③（未归属行为文件：utils/screenshots.py、thumbnails/digest.py、security/manager.py）被补上。

## 2. GT-affected（应重提取，AFR 分母 = 8）

| # | 功能（stable key） | 依据（commit · 行为变化） | 置信 |
|---|---|---|---|
| A1 | 安全角色与认证 | 5a0e884b30 · `is_guest_user` 不再读取 username（guest token 可携带空用户名，改用 `get_current_guest_user_if_guest`）；c55d723d93 · 无 schema 限定表经 search path 解析后受 RLS/表拒绝列表约束 | 高 |
| A2 | 仪表盘 | 4d524b5632 · 版本详情端点新增 `include_restore_impact` 参数与 `_restore_impact.removed_chart_count` 响应字段（恢复预警）；5a0e884b30 · 截图缓存调度传入 guest_key | 高 |
| A3 | SQL 编辑器 | c55d723d93 · SQL Lab 执行：无 schema 表按连接 search path 解析，RLS 与表拒绝列表对其生效（executor `_check_security` 增加 table_schemas） | 高 |
| A4 | 数据库连接配置 | 5bf937da31 · FormFieldOrder 新增 6 个 Athena 字段（直接触及 v48 HP-2「表单按 FormFieldOrder 渲染」）；新增 aws_secret_access_key 始终掩码输入；Athena 参数 schema（region 必填） | 高 |
| A5 | 数据源连接 | 5bf937da31 · Athena 动态连接参数（s3_staging_dir/work_group 等经 query 透传，编辑连接不再丢失其他参数）；连接参数类型扩展 | 中高 |
| A6 | 发布流程工具 | 8527530ace · labeler 新增波兰语 i18n 规则（v48 HP-3..6 同族场景应扩展） | 中高 |
| A7 | 缓存层 | 5a0e884b30 · 截图 API 缓存请求键新增 guest 分量（缓存分区行为从数据/列值/异步键扩展到截图面）；缩略图 digest 在 username 不可解析时按 guest 本身 | 中 |
| A8 | 嵌入式仪表盘 | 5a0e884b30 · 嵌入访客截图调度与 digest 按 guest 身份独立（guest 渲染路径） | 中 |

## 3. GT-unaffected-confirmed（确定未受影响、应逐字沿用，UP 分母 = 29）

机械面命中但判定行为未变（4 条，锚定红线测试重点）：语义视图批量删除（recently-archived.mdx 引用系索引误挂，行为无关）、安全依赖管理（pyproject 变更 = fastmcp dev 依赖 bump，pyarrow 场景不受影响）、嵌入式访客凭据回退（constants.ts 加 Athena 字段，embedded_credentials 行为不变）、REST API 场景集本身不变——注意 REST API 整体归 unknown 区（§4），此处不重复计。

完整清单共 29 条（含上文标注的 3 条机械命中行为未变；39 = 8 affected + 2 unknown + 29 unaffected）：Databricks SQL Lab、Databricks SQL Lab 查询取消、Databricks 查询取消、Docker 部署、OAuth2 客户端配置、仪表盘布局保存、前端插件构建、图表列表与数据源过滤、图表列表数据源筛选、图表列表数据源过滤、图表创建数据源入口、图表创建数据源选择、图表数据查询、图表构建与可视化、安全依赖管理、导入导出、导入导出密钥处理、导入弹窗、嵌入 SDK、嵌入式 SDK、嵌入式访客凭据回退、嵌入式访客回退凭据、数据导入导出、语义层、语义层提供方传输、语义视图创建结果解析、语义视图批量删除、语义视图批量添加、资产导入导出

> 冻结前勘误（2026-11-10，run 未开始）：原稿「其余 25 条」与枚举计数矛盾，枚举 29 条为准；8+2+29=39 与 v48 功能总数对账一致。清单成员无变化。

（逐条依据：对应实现文件未被窗口触及，或触及方式不改变其场景断言；冻结件 patch 可复核。）

## 4. unknown 区（不计入分母，如实披露 = 2）

| 功能 | 原因 |
|---|---|
| REST API | 机械命中 security.mdx；chart update 命令新增 expected_basis 参数（a131fcb623）与 REST PUT 语义邻近但是否构成「REST API」功能面行为变化拿不准 |
| 数据集列表管理 | 机械命中 DatasetList 页面（+2/-2 小改）；软删除 UX 主战场在 ChartCard/DashboardCard/KebabMenu/Toast，对数据集列表自身的场景断言影响拿不准 |

## 5. GT-new（预期新功能或既有功能新场景，NFR 分母 = 7）

| # | 预期新行为 | 来源 commit | 可接受落点 |
|---|---|---|---|
| N1 | MCP 图表语义表完整重选（不认证继承查询状态的有界重选）+ 图表更新 expected_basis 并发防护（陈旧准备被拒绝） | a131fcb623 | 新功能或 mcp 相关功能 |
| N2 | 仪表盘版本恢复影响预警（恢复前显示将脱离的图表数） | 4d524b5632 | 仪表盘新场景或新功能 |
| N3 | 软删除归档 UX：带链接的归档通知常驻至手动关闭（含 hover/键盘）、恢复链接尊重部署 URL 前缀、图表与仪表盘受影响计数分开列出、归档列表 Back/Forward 恢复类型+分页+排序+搜索、卡片 More Options 按钮键盘可读禁用原因 | 8263159a91 | 新功能（软删除/归档交互）或相关列表功能新场景 |
| N4 | Athena 动态连接表单：标准 Athena 主机自动推导 region、s3_staging_dir/work_group 表单化、非表单参数经 query 透传不被丢弃、AWS 密钥掩码 | 5bf937da31 | 数据库连接配置新场景或新功能 |
| N5 | SQL Lab 无 schema 限定表的 RLS 与表拒绝列表生效（经连接 search path 解析） | c55d723d93 | SQL 编辑器新场景或新功能 |
| N6 | 嵌入访客截图缓存按访客身份分区（digest 按 guest 解析） | 5a0e884b30 | 缓存层/嵌入式仪表盘/仪表盘新场景或新功能 |
| N7 | labeler 支持波兰语 locale 标签 | 8527530ace | 发布流程工具新场景 |

## 6. 判定口径（本窗口操作化）

- **AFR** = A1–A8 中被 v49 有效更新的比例（更新 = 功能被重提取且场景集反映窗口行为；仅措辞重写不算有效更新）。
- **UP** = §3 清单 29 条中 v49 逐字沿用的比例（场景 C/A/O 全字段逐字一致；机械重提取的功能同样要求逐字沿用——锚定契约「行为未变必须逐字沿用」）。
- **FUR** = §2 中被判静默 unaffected 的比例；**静默 = 0 容忍**：A7/A8 未进机械受影响集，若 v49 无任何通道（②新发现 / ③未归属文件核对）触及且无显式 unknown 披露 → 计静默。
- **NFR** = N1–N7 被 v49 捕获的比例（按「可接受落点」任一粒度判定；场景级命中且语义正确即算）。
- 精确率附带口径：v49 changes 功能级新增条目逐条核验（真行为/噪音），噪音分类沿用原盲评口径（泛化重写计噪音）。
- 预测对账：实际模式 ≠ incremental、或机械受影响集 ≠ §1 预测 11 条 → 先查机制再判指标（管线事实与 GT 判定分开）。

## 7. 运行设置（预冻结）

- before = `2645396b7a8ea1f5b1978f94b2ac0ec0c1b1397b`（= v48.sha），after = `a131fcb623d88ed9eb7e7a414e226437423d645c`（master HEAD @ 2026-11-10）
- 触发 = `queueAnalysis(5, before, after, "manual")` 真实管线（与 webhook 同执行路径，仅触发源不同）；product analyze_mode = incremental ✓
- 管线 = 本地工作树 59a93e3（lib/ 无未提交改动）；LLM = ds-flash；运行次数 = 2（同窗口重跑一次，成本 ~$0.4）
- 判定基线 = v48（append-only，run 后不动）；判定脚本对比 v48/v49 功能与场景逐字差异
