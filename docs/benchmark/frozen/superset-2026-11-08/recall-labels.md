# 召回率预标（冻结于第二次分析运行之前）

窗口：apache/superset `957eb449ef` → `2645396b7a`（19 commits，131 files，+12430/−640）
预标方法：逐 commit 读 GitHub patch，只标静态可观测的行为变化（新/变参数、新/变响应、新/变权限边界、新配置项、错误路径变化）。判定人：项目开发者（非第三方，独立性折扣在报告声明）。

## 15 条预标

| # | 行为变化 | 证据（commit · 文件） | 跨文件 |
| --- | --- | --- | --- |
| L1 | 语义视图批量删除被拒时，响应新增 `blocked_view_ids`/`blocked_views`，逐视图列出依赖明细（此前只有聚合计数） | 9ee13f85fa · commands/semantic_layer/delete.py + exceptions.py + semantic_layers/api.py | ✓ |
| L2 | 图表列表新增 `chart_datasource` 过滤参数，按 `<id>__<table\|semantic_view>` 精确匹配数据源，语义视图可作数据源筛出 | 5abdb20986 · charts/filters.py + charts/api.py | ✓ |
| L3 | `chart_datasource` 畸形值（非整数前缀/未知类型/越界 id）返回空结果而非放宽列表 | 5abdb20986 · charts/filters.py | |
| L4 | 语义层 transport 校验 Content-Length 与实读字节数（多值/非数字/不符 → UNREACHABLE），旧 urllib3 上响应不再静默截断 | d91d9836ea · semantic_layers/transport.py | |
| L5 | 保存仪表盘：调用方无权读取的布局图表不再拒绝保存（旧 DashboardLayoutInvalidError），改为修复为 missing-chart 占位 | bab549fad4 · commands/dashboard/update.py + daos/dashboard.py | ✓ |
| L6 | 新 feature flag `EMBEDDED_CREDENTIAL_FALLBACK`（默认 false，testing，security 类别，依赖 EMBEDDED_SUPERSET） | ec542a6d3b · config.py + docs/static/feature-flags.json | ✓ |
| L7 | OAuth2+模拟登录的连接可配置仅嵌入访客使用的回退凭据（username+password 或 PEM keypair；半填整体忽略；Snowflake 首发支持） | ec542a6d3b · databases/utils.py + db_engine_specs/base.py + snowflake.py + constants.py | ✓ |
| L8 | 嵌入访客请求跳过 OAuth2 自动重试（guest 无 per-user token，无法完成授权 dance） | ec542a6d3b · utils/oauth2.py | |
| L9 | 嵌入访客的连接身份参与缓存键：数据缓存、列值缓存、异步任务键不再与登录用户共享 | ec542a6d3b · utils/cache_keys.py + common/query_context_processor.py + datasource/api.py | ✓ |
| L10 | chart/dashboard/dataset/saved_query 四个 import 端点新增 `encrypted_extra_secrets` 表单字段，且 import 请求不再写入事件日志（表单含密钥） | ec542a6d3b · charts/api.py + dashboards/api.py + datasets/api.py + queries/saved_queries/api.py + importexport/api.py | ✓ |
| L11 | bundle 导入不再覆盖已存在的数据库连接（仅 overwrite_all 时覆盖）；覆盖时对旧值无法还原的掩码字段要求提交真实值 | ec542a6d3b · commands/{chart,dashboard,dataset,query}/importers/v1 + utils/json.py | ✓ |
| L12 | OAuth2 数据库创建：add_permissions 对 OAuth2 未授权错误不再报 422（权限同步推迟到首次使用） | ec542a6d3b · commands/database/create.py | |
| L13 | promiscuous viewer 授予从全局 bypass 收紧为绑定具体已发布仪表盘（成员图表/数据集仅在该仪表盘请求内可读） | 2645396b7a · security/manager.py + dashboards/api.py + config.py | ✓ |
| L14 | Databricks SEA 连接的 SQL Lab 查询支持取消 | 3f7412c18a · db_engine_specs/databricks.py | |
| L15 | 敏感字段脱敏跳过空值（None/空串不再显示为已存储掩码） | ec542a6d3b · utils/json.py | |

跨文件 ≥5：L1/L2/L5/L6/L7/L9/L10/L11/L13 = 9 条 ✓（模板要求 ≥5）

## 盲区披露样本（2 条，构造性）

| B1 | 翻转 `FEATURE_FLAGS["EMBEDDED_CREDENTIAL_FALLBACK"]=True`（纯配置，零代码 diff）→ 嵌入凭据 UI 与查询路径启用 | 预期 CoDelphi 报 0 条 |
| B2 | 翻转 `VIEWER_PROMISCUOUS_MODE=True`（纯配置，零代码 diff）→ viewer 权限模型行为大变 | 预期 CoDelphi 报 0 条 |

## 噪音基线（不应报为行为变化的提交）

8248f6bd35（build 脚本）、86634e8528（测试会话清理）、3807a4d743（格式化）、4c8ec9e65c（CI labeler）、b92fcb2061（SDK 测试+JSDoc）、51a71563e1/09c015eef5/9ad39c0bff/1a30d454b5/9e7fad6a9d（依赖 bump）、3782f325aa（pyarrow 版本下限）
