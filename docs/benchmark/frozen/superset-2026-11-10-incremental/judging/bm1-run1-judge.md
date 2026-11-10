
## [CHANGED/unaffected] Databricks SQL Lab [databricks sql lab]
  summary REWRITTEN:
    v48: 在 Databricks SEA 连接上执行与取消 SQL Lab 查询。
    v49: SQL Lab 对无 schema 的非限定表应用 RLS 与表拒绝列表。
  ~ HP-1(rewritten):
    C v48: 用户在 SQL Lab 运行 Databricks 查询
    C v49: 用户查询未带 schema 的非限定表。
    A v48: 取消正在运行的查询
    A v49: 执行 SQL 查询。
    O v48: 查询被取消
    O v49: 查询结果按行级安全与表拒绝列表过滤。
  + ER-1 [error] C=用户对未带 schema 的未限定表发起查询估算，该表在拒绝名单中或受 RLS 约束。 | A=提交查询估算请求。 | O=查询估算对未限定表同样应用 RLS 与表拒绝名单，越权表被拒绝并返回相应错误。
  - 移除场景: EC-1

## [KEPT/unaffected] Databricks SQL Lab 查询取消 [databricks sql lab 查询取消]
  逐字相同场景: EC-1, HP-1, HP-2

## [KEPT/unaffected] Databricks 查询取消 [databricks 查询取消]
  逐字相同场景: EC-1, EC-2, HP-1, HP-2

## [KEPT/unaffected] Docker 部署 [docker 部署]
  逐字相同场景: EC-1, ER-1, HP-1

## [KEPT/unaffected] OAuth2 客户端配置 [oauth2 客户端配置]
  逐字相同场景: EC-1, EC-2, EC-3, EC-4, EC-5, HP-1, HP-2, HP-3, HP-4, HP-5

## [CHANGED/unknown] REST API [rest api]
  逐字相同场景: HP-1
  + EC-1 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算恢复影响，行为与之前一致。
  + EC-2 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=不返回恢复影响计数
  + EC-3 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算恢复影响计数。
  + EC-4 [edge] C=调用方未传 include_restore_impact 或传 false | A=GET 仪表盘版本详情 | O=不计算恢复影响计数，响应与原有版本详情一致
  + EC-5 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应不含移除数量。
  + ER-1 [error] C=恢复影响计数响应中 removed_chart_count 缺失、为负数或非整数 | A=前端解析响应 | O=抛出 Invalid restore impact response 错误
  + HP-2 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的当前成员图表数量。
  + HP-3 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的图表数量。
  + HP-4 [happy] C=调用方请求仪表盘版本详情并附带 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应 result 中包含 _restore_impact.removed_chart_count 计数

## [CHANGED/affected] SQL 编辑器 [sql 编辑器]
  逐字相同场景: ER-1, HP-1, HP-2
  + EC-1 [edge] C=SQL 引用未限定 schema 的表，且该表在数据库 search path 中解析到受 RLS 或禁用表约束的表。 | A=在 SQL Lab 执行该查询。 | O=RLS 谓词被注入或禁用表被拒绝，不再因缺少 schema 而绕过检查。
  + EC-10 [edge] C=表名包含非 ASCII 大写字母且未加引号，Postgres 按编码折叠标识符。 | A=执行引用该无 schema 表的查询。 | O=按多种拼写（含原样与 ASCII 小写折叠）查找表，匹配到查询实际读取的表。
  + EC-11 [edge] C=Snowflake 连接中查询使用 db..table 形式引用表。 | A=执行该查询。 | O=该引用按 PUBLIC schema 解析，RLS 与表黑名单按 PUBLIC 匹配。
  + EC-12 [edge] C=同一未保存查询被不同 RLS 权限的用户通过共享 Explore permalink 查看。 | A=分别以不同 RLS 权限用户加载该查询支持的图表。 | O=RLS 缓存键包含 schema 搜索路径解析结果，不同权限用户不再命中同一缓存条目。
  + EC-2 [edge] C=SQL 中未加引号的表名在 PostgreSQL、Oracle 或 Snowflake 上大小写不同。 | A=解析表引用并应用 RLS。 | O=未加引号的 ASCII 名称按引擎规则折叠后匹配，加引号名称保持原样。
  + EC-3 [edge] C=SQL Lab 查询引用无 schema 的非限定表，且该表在表黑名单中。 | A=执行查询。 | O=查询被拒绝，黑名单生效。
  + EC-4 [edge] C=SQL Lab 查询引用未限定 schema 的表，且该表在默认 schema 或 search path 中命中 RLS 或表黑名单 | A=执行查询 | O=RLS 谓词与表黑名单被应用，查询被限制或拒绝
  + EC-5 [edge] C=查询的数据库无对应 DB-API 驱动或 SQLAlchemy 方言 | A=执行查询 | O=无法连接该数据源
  + EC-6 [edge] C=非限定表名在 PostgreSQL/Oracle/Snowflake 上未加引号。 | A=解析 SQL 提取表引用。 | O=ASCII 字母被折叠后匹配，带引号名称保持原样。
  + EC-7 [edge] C=查询成本估算的 SQL 引用被表黑名单以 schema 限定条目禁止的非限定表 | A=请求查询成本估算 | O=返回被禁止表错误，与执行路径一致
  + EC-8 [edge] C=SQL Lab 查询引用未限定 schema 的表，且该表在默认 schema 或搜索路径中命中 RLS 或表黑名单。 | A=执行查询。 | O=按默认 schema 与搜索路径应用 RLS 谓词与表黑名单。
  + EC-9 [edge] C=PostgreSQL、Oracle 或 Snowflake 上未加引号的表名与 CTE 名称仅大小写不同。 | A=解析 SQL 并区分 CTE 引用与物理表。 | O=未加引号的 ASCII 名称被折叠后比较，加引号名称保持原样。
  + ER-2 [error] C=查询估算时数据库拒绝登录。 | A=执行查询估算。 | O=返回带数据库错误信息的失败结果。
  + ER-3 [error] C=连接无法被查询以获取默认 schema 或 search_path。 | A=执行引用无 schema 表的查询。 | O=解析失败向上抛出，查询返回错误而非静默放行。
  + HP-3 [happy] C=SQL Lab 查询引用无 schema 的非限定表，且该表存在 RLS 规则。 | A=执行查询。 | O=RLS 谓词被注入到该表查询中。
  + HP-4 [happy] C=SQL Lab 查询引用未写 schema 的非限定表，且该表存在 RLS 规则。 | A=执行查询。 | O=按数据库 search path 解析表所属 schema 并注入 RLS 谓词。
  + HP-5 [happy] C=用户在 SQL Lab 对无 schema 的非限定表执行查询且启用 RLS_IN_SQLLAB | A=执行查询 | O=按连接 search path 解析表所在 schema 并注入对应 RLS 谓词
  + HP-6 [happy] C=PostgreSQL 连接配置了包含多个 schema 的 search_path，查询引用不带 schema 的表。 | A=在 SQL Lab 执行该查询。 | O=按 search_path 顺序解析表所在 schema，RLS 与 DISALLOWED_SQL_TABLES 对该表正确生效。
  + HP-7 [happy] C=SQL Lab 中执行引用无 schema 表的查询，且当前用户受 RLS 或表拒绝列表约束。 | A=运行该 SQL Lab 查询。 | O=RLS 谓词与表拒绝列表按连接搜索路径解析后应用于未限定表，查询结果按用户权限过滤。

## [CHANGED/affected] 仪表盘 [仪表盘]
  逐字相同场景: EC-1, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 仪表盘布局引用了调用方无法读取的图表
    C v49: 调用方没有宽松仪表盘访问权限。
    A v48: 保存仪表盘
    A v49: GET 仪表盘详情。
    O v48: 该图表保存为缺失图表占位
    O v49: 响应 charts 字段仅包含 can_access_chart 通过的成员图表。
  ~ EC-3(rewritten):
    C v48: 仪表盘布局引用了调用者不可读的图表
    C v49: 恢复影响计数在弹窗打开后因其他用户编辑而变化
    A v48: 保存仪表盘布局
    A v49: 用户确认恢复
    O v48: 该图表保存为缺失图表占位，布局其余部分正常保存
    O v49: 计数为建议值，实际恢复按确认时的成员关系执行
  ~ EC-4(rewritten):
    C v48: 调用方没有宽松仪表盘访问权限。
    C v49: 仪表盘卡片菜单在软删除开启或关闭时渲染。
    A v48: GET 仪表盘详情。
    A v49: 用键盘聚焦卡片并打开更多操作菜单。
    O v48: 响应 charts 字段仅包含 can_access_chart 通过的成员图表。
    O v49: 键盘先到达编辑/删除权限提示，再进入菜单项。
  + ER-1 [error] C=嵌入式访客令牌携带空用户名或与用户名相同的值。 | A=渲染仪表盘缩略图并计算摘要。 | O=访客身份仍被正确识别，RLS 规则进入摘要，不因用户名取值而误判。
  + ER-2 [error] C=仪表盘卡片菜单中的编辑或归档项被禁用 | A=非编辑者点击禁用项 | O=不打开对话框，显示需为仪表盘编辑者的提示
  + ER-3 [error] C=viewer 角色用户尝试通过宽松访问读取非自身请求范围的仪表盘或图表 | A=发起访问请求 | O=请求被拒绝
  + HP-3 [happy] C=用户在仪表盘版本历史中选择一个历史版本 | A=打开恢复确认弹窗 | O=弹窗显示当前成员中不在该版本的图表数量，并警告恢复会移除这些图表但不删除图表本身

## [KEPT/unaffected] 仪表盘布局保存 [仪表盘布局保存]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7, HP-8, HP-9

## [KEPT/unaffected] 前端插件构建 [前端插件构建]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7

## [CHANGED/affected] 发布流程工具 [发布流程工具]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2
  ~ HP-3(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ar/** 下的文件。
    C v49: 提交的 PR 修改了 superset/translations/pl/** 下的文件。
    O v48: PR 被自动添加 i18n:arabic 标签。
    O v49: PR 被自动添加 i18n:polish 标签。
  ~ HP-4(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ca/** 下的文件。
    C v49: CI 安装后端依赖时下载 RAT jar 遇到临时网络错误。
    A v48: 触发 labeler 工作流。
    A v49: 运行 check_license.sh。
    O v48: PR 被自动添加 i18n:catalan 标签。
    O v49: curl 按重试策略重新下载，成功后继续许可证检查。
  ~ HP-5(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ar/** 的 PR。
    C v49: CI 后端环境安装 uv 时
    A v48: 触发 labeler 工作流。
    A v49: 执行 setup-backend 复合动作的 Install uv 步骤
    O v48: PR 被自动打上 i18n:arabic 标签。
    O v49: 使用 astral-sh/setup-uv v10.3.3（提交 68559e99）安装 uv，并启用缓存
  ~ HP-6(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ca/** 的 PR。
    C v49: 提交的 PR 修改了 superset/translations/pl/** 下的文件
    A v48: 触发 labeler 工作流。
    A v49: labeler 工作流运行标签规则
    O v48: PR 被自动打上 i18n:catalan 标签。
    O v49: 该 PR 被自动打上 i18n:polish 标签
  + EC-2 [edge] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，成功后继续许可证检查。
  + EC-3 [edge] C=RAT jar 下载过程中出现临时网络错误或 HTTP 5xx/429 | A=curl 下载失败 | O=curl 自动重试最多 5 次、间隔 3 秒；仍失败则脚本输出下载失败提示并以 255 退出
  + ER-2 [error] C=RAT jar 多次重试后仍下载失败或文件损坏。 | A=运行 check_license.sh。 | O=删除损坏文件并提示手动安装 rat，退出码 255。
  + ER-3 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败时输出错误
  + ER-4 [error] C=check_license.sh 下载 RAT jar 时网络短暂失败。 | A=执行许可证检查脚本。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败才退出。
  + ER-5 [error] C=运行 check_license.sh 但环境既无 curl 也无 wget | A=脚本尝试下载 RAT jar | O=输出需手动安装 rat 的提示并以 255 退出
  + HP-7 [happy] C=运行 check_license.sh 且本地尚无 RAT jar，系统有 curl | A=脚本通过 curl 下载 apache-rat jar | O=下载使用 --fail 与重试参数，成功后 jar 落盘并通过 unzip 校验，脚本继续执行

## [KEPT/unaffected] 图表列表与数据源过滤 [图表列表与数据源过滤]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2, HP-3

## [KEPT/unaffected] 图表列表数据源筛选 [图表列表数据源筛选]
  逐字相同场景: HP-1, HP-2

## [KEPT/unaffected] 图表列表数据源过滤 [图表列表数据源过滤]
  逐字相同场景: EC-1, EC-2, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6

## [KEPT/unaffected] 图表创建数据源入口 [图表创建数据源入口]
  逐字相同场景: EC-1, EC-2, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6

## [KEPT/unaffected] 图表创建数据源选择 [图表创建数据源选择]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2

## [KEPT/unaffected] 图表数据查询 [图表数据查询]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2

## [CHANGED/unaffected] 图表构建与可视化 [图表构建与可视化]
  summary REWRITTEN:
    v48: 提供无代码界面构建图表，并支持从简单柱状图到地理空间可视化的多种图表类型。
    v49: XY 图表配置映射与时序类型处理。
  ~ HP-1(rewritten):
    C v48: 分析师连接数据源后进入图表构建界面
    C v49: XY 图表插件应用权威时序列类型。
    A v48: 通过无代码界面选择维度与指标
    A v49: 调用 apply_temporal_columns 传入 config、form_data 与 temporal_columns。
    O v48: 生成并展示所选可视化图表
    O v49: form_data 被清空并按 map_xy_config 结果重建，时序判定基于传入的 temporal_columns。
  - 移除场景: EC-1

## [CHANGED/unaffected] 安全依赖管理 [安全依赖管理]
  逐字相同场景: EC-1, ER-1, HP-1
  ~ HP-2(rewritten):
    C v48: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    C v49: 安装 MCP 可选依赖。
    A v48: 执行依赖安装/解析。
    A v49: 解析 fastmcp 版本。
    O v48: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  ~ HP-3(rewritten):
    C v48: 安装 Superset 依赖。
    C v49: 在干净环境中安装 Superset 依赖。
    A v48: 解析并安装 pyarrow。
    A v49: 解析 pyarrow 依赖约束。
    O v48: 安装的 pyarrow 版本不低于修复版本，不含 CVE-2026-111497。
    O v49: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
  ~ HP-4(rewritten):
    C v48: 在干净环境中安装 Superset 依赖。
    C v49: 安装 MCP 相关依赖
    A v48: 解析 pyarrow 依赖约束。
    A v49: 解析 fastmcp 版本
    O v48: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本
  ~ HP-5(rewritten):
    C v48: 安装项目依赖
    C v49: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    A v48: 解析 pyarrow 版本
    A v49: 执行依赖安装/解析。
    O v48: 不再解析到含 CVE-2026-111497 的 pyarrow 版本
    O v49: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
  + EC-2 [edge] C=环境中已安装 fastmcp 4.1.0 至 4.1.3 | A=安装 fastmcp extra | O=因下限提升到 4.1.4，解析器升级 fastmcp 到 4.1.4 及以上
  + HP-6 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 fastmcp>=4.1.4,<5.0 范围内的版本。
  + HP-7 [happy] C=安装 Superset 的 fastmcp 可选依赖 | A=解析 fastmcp 版本 | O=安装 4.1.4 及以上、5.0 以下版本
  + HP-8 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 4.1.4 及以上、5.0 以下版本。
  + HP-9 [happy] C=安装 Superset 的 fastmcp 可选依赖 | A=pip 解析 fastmcp extra | O=fastmcp 解析为 >=4.1.4,<5.0 的版本，并同时安装 httpx、mcp、tiktoken、joserfc、python-multipart 等约束依赖

## [CHANGED/affected] 安全角色与认证 [安全角色与认证]
  逐字相同场景: ER-1, HP-1, HP-2
  ~ EC-1(rewritten):
    C v48: 启用 ENABLE_VIEWERS 与 VIEWER_PROMISCUOUS_MODE
    C v49: 嵌入式访客令牌的用户名为空。
    A v48: 查看者访问已发布仪表盘及其图表、数据集请求
    A v49: 调用 is_guest_user 判定当前用户。
    O v48: 仅已列出的查看者在查看该仪表盘时免数据集权限读取
    O v49: 仅依据当前用户求值结果判定为访客，不读取用户名。
  ~ EC-2(rewritten):
    C v48: 启用 VIEWER_PROMISCUOUS_MODE
    C v49: 调用方不具备 promiscuous 仪表盘授权。
    A v48: 查看者访问仪表盘
    A v49: GET /api/v1/dashboard/{id_or_slug}。
    O v48: 仅该仪表盘自身的图表与数据集请求被授权
    O v49: charts 仅包含调用方可访问的成员图表。
  ~ EC-3(rewritten):
    C v48: 调用方不具备 promiscuous 仪表盘授权。
    C v49: 启用 ENABLE_VIEWERS 与 VIEWER_PROMISCUOUS_MODE
    A v48: GET /api/v1/dashboard/{id_or_slug}。
    A v49: 查看者访问已发布仪表盘及其图表、数据集请求
    O v48: charts 仅包含调用方可访问的成员图表。
    O v49: 仅已列出的查看者在查看该仪表盘时免数据集权限读取
  ~ ER-2(rewritten):
    C v48: 复制仪表盘或保存带新目标数据集的原生过滤器，而用户对该图表或数据集无访问权限
    C v49: viewer 角色用户尝试通过宽松访问读取非自身请求范围的仪表盘或图表
    A v48: 执行复制或保存
    A v49: 发起访问请求
    O v48: 返回 HTTP 422 并指明图表或数据集
    O v49: 请求被拒绝
  ~ ER-3(rewritten):
    C v48: viewer 角色用户尝试通过宽松访问读取非自身请求范围的仪表盘或图表
    C v49: 复制仪表盘或保存带新目标数据集的原生过滤器，而用户对该图表或数据集无访问权限
    A v48: 发起访问请求
    A v49: 执行复制或保存
    O v48: 请求被拒绝
    O v49: 返回 HTTP 422 并指明图表或数据集
  ~ HP-3(rewritten):
    C v48: 调用方对某仪表盘具有 promiscuous 仪表盘访问授权。
    C v49: 嵌入式访客令牌携带空用户名。
    A v48: GET /api/v1/dashboard/{id_or_slug}，响应包含 charts 字段。
    A v49: 系统判定当前用户是否为访客。
    O v48: charts 返回该仪表盘全部成员图表，不再逐图表过滤。
    O v49: 依据访客令牌识别为访客，不依赖用户名。
  + EC-4 [edge] C=访客令牌携带空用户名 | A=调用 is_guest_user 判定当前用户 | O=仍按访客令牌定义识别为嵌入访客，不依赖用户名
  + EC-5 [edge] C=嵌入访客请求仪表盘缩略图 | A=计算缩略图摘要与截图缓存键 | O=按访客自身隔离缓存，访客的行级规则进入摘要
  + EC-6 [edge] C=启用 VIEWER_PROMISCUOUS_MODE | A=查看者访问仪表盘 | O=仅该仪表盘自身的图表与数据集请求被授权
  + EC-7 [edge] C=嵌入访客令牌携带空用户名 | A=调用 is_guest_user 判断当前用户 | O=仍识别为访客用户，不因用户名为空返回 False
  + EC-8 [edge] C=访客令牌携带空用户名。 | A=判定当前用户是否为嵌入式访客。 | O=不读取用户名，仍正确识别为访客。
  + HP-4 [happy] C=调用方对某仪表盘具有 promiscuous 仪表盘访问授权。 | A=GET /api/v1/dashboard/{id_or_slug}，响应包含 charts 字段。 | O=charts 返回该仪表盘全部成员图表，不再逐图表过滤。
  + HP-5 [happy] C=嵌入式访客令牌携带空用户名。 | A=判定当前用户是否为访客。 | O=依据用户对象与访客令牌判定为访客，不因用户名为空而返回否。

## [KEPT/unaffected] 导入导出 [导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, EC-4, ER-1, ER-2, HP-1, HP-2

## [KEPT/unaffected] 导入导出密钥处理 [导入导出密钥处理]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2

## [KEPT/unaffected] 导入弹窗 [导入弹窗]
  逐字相同场景: EC-1, HP-1, HP-2, HP-3

## [KEPT/unaffected] 嵌入 SDK [嵌入 sdk]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1

## [KEPT/unaffected] 嵌入式 SDK [嵌入式 sdk]
  逐字相同场景: HP-1, HP-2, HP-3

## [KEPT/affected] 嵌入式仪表盘 [嵌入式仪表盘]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2, HP-3

## [CHANGED/unaffected] 嵌入式访客凭据回退 [嵌入式访客凭据回退]
  逐字相同场景: HP-1, HP-2
  + EC-1 [edge] C=连接开启模拟登录用户但无 OAuth2 客户端且无可用凭据 | A=嵌入式访客查询 | O=查询被拒绝，访客看到连接未为嵌入式仪表盘配置的提示，服务端日志记录连接与修复方法
  + EC-2 [edge] C=Snowflake 嵌入式回退凭据使用密钥对且私钥无法加载 | A=嵌入式访客查询该连接 | O=拒绝访客并提示检查嵌入式凭据中的私钥与口令
  + ER-1 [error] C=凭据只有用户名或只有密码/私钥，或用户名为纯空白 | A=保存连接 | O=校验失败，凭据被拒绝

## [KEPT/unaffected] 嵌入式访客回退凭据 [嵌入式访客回退凭据]
  逐字相同场景: EC-1, ER-1, HP-1

## [KEPT/unaffected] 数据导入导出 [数据导入导出]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2

## [CHANGED/affected] 数据库连接配置 [数据库连接配置]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。
    C v49: Athena 连接既未填 s3_staging_dir 也未填 work_group。
    A v48: 构建该数据库引擎规范的 parameters_json_schema。
    A v49: 保存连接。
    O v48: 该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
    O v49: 连接参数校验提示需提供 s3_staging_dir 或 work_group。
  ~ HP-3(rewritten):
    C v48: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    C v49: 管理员配置 Amazon Athena 连接。
    A v48: 提交数据库连接配置。
    A v49: 在连接表单中填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、Schema、Work group。
    O v48: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
    O v49: 表单按 Athena 动态参数 schema 渲染字段，AWS Secret Access Key 以密码输入框呈现。
  ~ HP-4(rewritten):
    C v48: 管理员更新一个已存在的数据库连接，请求体合法。
    C v49: 管理员配置 Athena 连接。
    A v48: PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。
    A v49: 在连接表单中填写 AWS Access Key ID、Secret、Region、S3 staging dir 与 Work group。
    O v48: 返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
    O v49: 表单按 Athena 动态参数 schema 渲染这些字段，AWS Secret 以密码输入框呈现。
  ~ HP-5(rewritten):
    C v48: 用户在数据库连接弹窗中配置含私钥字段的连接
    C v49: 管理员更新一个已存在的数据库连接，请求体合法。
    A v48: 打开数据库连接配置弹窗并填写连接参数
    A v49: PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。
    O v48: 私钥类字段被正确识别与处理，连接配置可正常保存
    O v49: 返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
  ~ HP-6(rewritten):
    C v48: OAuth2 数据库连接需要携带客户端信息与嵌入式凭据
    C v49: 管理员为 Athena 连接填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、Schema 与 Work Group
    A v48: 保存包含 oauth2_client_info 与 embedded_credentials 的连接参数
    A v49: 提交数据库连接配置
    O v48: 连接参数类型接受这两个可选字段，配置可正常提交
    O v49: 这些参数随连接参数提交并保存
  + EC-3 [edge] C=Athena 连接的 Work Group 已配置查询结果位置 | A=查看 S3 query results location 字段 | O=该字段非必填，帮助文本说明 Work Group 设置结果位置时可选
  + EC-4 [edge] C=数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。 | A=构建该数据库引擎规范的 parameters_json_schema。 | O=该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
  + EC-5 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group | A=保存或校验连接参数 | O=返回缺少 s3_staging_dir、work_group 的参数校验警告
  + EC-6 [edge] C=Athena 连接使用 VPC/PrivateLink 自定义主机名 | A=保存连接后再打开表单 | O=region_name 字段保留完整主机名与端口，重建 URI 时原样使用
  + HP-10 [happy] C=管理员编辑已有 Athena 连接 | A=打开连接表单 | O=从已存 URI 解析出各字段值回填，额外 query 参数保留在 query 字段
  + HP-11 [happy] C=管理员配置 Athena 连接。 | A=在连接表单中填写 AWS Access Key ID、Secret、Region、S3 staging dir、schema_name、work_group。 | O=字段按动态参数 schema 渲染，AWS Secret 始终以密码输入框显示。
  + HP-7 [happy] C=用户在新增或编辑模式下查看 AWS Secret Access Key 字段 | A=查看输入框 | O=输入框为密码类型并带可见性切换图标
  + HP-8 [happy] C=管理员配置 Athena 连接。 | A=在连接表单填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query result location、Schema name、Work group。 | O=表单按动态参数 schema 渲染这些字段，AWS 密钥以密码输入框呈现。
  + HP-9 [happy] C=管理员配置 Amazon Athena 连接 | A=在动态连接表单中填写 AWS Access Key ID、Secret、Region、S3 暂存目录或 work group | O=表单参数被转换为 Athena SQLAlchemy URI 并保存

## [CHANGED/affected] 数据源连接 [数据源连接]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 校验数据源参数时配置了不完整的嵌入式凭据。
    C v49: 查询引用未限定 schema 的表，数据库 search path 将其解析到受 RLS 约束的表。
    A v48: 调用数据库参数校验。
    A v49: 执行查询并应用 RLS。
    O v48: 校验结果包含嵌入式凭据不完整的错误。
    O v49: 按 search path 与引擎名称折叠规则匹配表，注入对应 RLS 谓词。
  ~ EC-3(rewritten):
    C v48: 用户导入图表包，包内包含与已有数据库 UUID 相同的数据库配置。
    C v49: 校验数据源参数时配置了不完整的嵌入式凭据。
    A v48: 执行图表导入。
    A v49: 调用数据库参数校验。
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: 校验结果包含嵌入式凭据不完整的错误。
  ~ EC-4(rewritten):
    C v48: 用户导入仪表盘包，包内包含与已有数据库 UUID 相同的数据库配置，且未指定 overwrite_all。
    C v49: 查询引用未限定 schema 的表，且该表在默认 schema 或 search path 中命中 RLS 或表黑名单
    A v48: 执行仪表盘导入。
    A v49: 执行查询
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: 按默认 schema 与 search path 解析后应用 RLS 与表黑名单
  ~ EC-5(rewritten):
    C v48: 用户导入仪表盘包并同时指定覆盖与 overwrite_all。
    C v49: Snowflake 连接配置了嵌入式回退凭据
    A v48: 执行仪表盘导入。
    A v49: 嵌入式访客发起查询
    O v48: 关联数据库按覆盖模式导入，schema 要求提供存储连接无法还原的密钥。
    O v49: 连接自身的 user、password、role、token 与私钥参数被移除，仅使用回退账号登录
  ~ HP-3(rewritten):
    C v48: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Athena 数据源。
    A v48: 提交创建数据库请求。
    A v49: 提供 work_group 而不提供 s3_staging_dir。
    O v48: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
    O v49: 连接可保存，查询结果位置由工作组定义。
  ~ HP-4(rewritten):
    C v48: 用户创建 OAuth2 数据源连接，连接测试通过但权限同步时创建管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Athena 数据源
    A v48: 提交创建数据库请求。
    A v49: 在动态表单中填写 AWS 凭据、区域、S3 结果位置与 Work Group 并保存
    O v48: 数据库创建成功，不再因缺少 OAuth2 令牌返回 422；权限在首次设置访问时同步。
    O v49: Athena 连接创建成功并可查询
  ~ HP-5(rewritten):
    C v48: 管理员更新一个已存在的数据库连接。
    C v49: 管理员配置 Athena 数据源。
    A v48: 向数据库 PUT 接口提交请求体。
    A v49: 填写 s3_staging_dir 或 work_group 并保存连接。
    O v48: 请求体由 DatabasePutSchema(database_id=pk) 校验，合法时返回 200 与更新后的连接信息。
    O v49: 连接参数接受 AWS 凭据、区域、S3 暂存目录、schema 与 work group 字段。
  ~ HP-6(rewritten):
    C v48: 数据库引擎参数包含加密字段，前端获取参数 JSON Schema。
    C v49: 管理员配置 Athena 数据源。
    A v48: 读取引擎参数的 OpenAPI 3 schema。
    A v49: 仅填写 work_group 而不填 s3_staging_dir。
    O v48: 加密字段带 x-encrypted-extra: true 标记，连接对话框据此渲染并将值放入 masked_encrypted_extra。
    O v49: 连接可保存，查询结果位置由 work group 定义或使用托管查询结果。
  - 移除场景: ER-3, ER-4, ER-5, ER-6, ER-7

## [CHANGED/unknown] 数据集列表管理 [数据集列表管理]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2, HP-3
  ~ HP-4(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户查看数据集删除确认弹窗，数据集关联 3 个图表与 2 个仪表盘。
    A v48: 打开导入弹窗并提交导入。
    A v49: 打开删除弹窗。
    O v48: 导入弹窗识别加密文件额外字段并正常处理导入。
    O v49: 提示文案为“is linked to 3 charts and 2 dashboards.”。
  ~ HP-5(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户删除被图表与仪表盘引用的数据集
    A v48: 执行导入。
    A v49: 打开删除确认弹窗
    O v48: 导入流程识别加密文件额外字段并继续处理。
    O v49: 弹窗显示“is linked to N charts and M dashboards”
  + EC-2 [edge] C=用户使用浏览器前进后退切换列表历史。 | A=返回上一列表状态。 | O=排序、页码与搜索作为同一 URL 状态被恢复。
  + EC-3 [edge] C=列表排序状态被外部恢复为空。 | A=重新渲染 ListView。 | O=受控排序清空表头排序指示。
  + HP-6 [happy] C=用户删除被 3 个图表和 2 个仪表盘引用的数据集。 | A=打开删除确认弹窗。 | O=弹窗显示“is linked to 3 charts and 2 dashboards.”。

## [KEPT/affected] 缓存层 [缓存层]
  逐字相同场景: HP-1

## [KEPT/unaffected] 语义层 [语义层]
  逐字相同场景: EC-1, HP-1

## [KEPT/unaffected] 语义层提供方传输 [语义层提供方传输]
  逐字相同场景: HP-1

## [KEPT/unaffected] 语义视图创建结果解析 [语义视图创建结果解析]
  逐字相同场景: EC-1, ER-1, HP-1

## [CHANGED/unaffected] 语义视图批量删除 [语义视图批量删除]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1
  ~ EC-2(rewritten):
    C v48: 批量删除中有部分视图被依赖资产阻止
    C v49: 批量删除的所选视图中没有任何视图存在依赖。
    A v48: 确认删除
    A v49: 提交批量删除。
    O v48: 整批拒绝，对话框仅列出被阻止的视图及其可见依赖与不可见资产数量
    O v49: blocked_views 为空，blocked_view_ids 为空列表，删除流程按无依赖继续。
  ~ HP-2(rewritten):
    C v48: 用户选择多个无依赖的语义视图
    C v49: 批量选择数据集与多个语义视图并确认删除
    A v48: 确认批量删除
    A v49: 提交删除
    O v48: 所选视图被删除
    O v49: 数据集被删除，被依赖阻止的语义视图在“Cannot delete semantic views”对话框中按视图分别列出其依赖资产
  ~ HP-3(rewritten):
    C v48: 用户批量删除无依赖的语义视图
    C v49: 批量删除多个语义视图，其中部分视图存在依赖资产。
    A v48: 确认删除
    A v49: 提交批量删除。
    O v48: 视图被删除
    O v49: 删除被拒绝，错误响应仅列出有依赖的视图及其 total、dependents、inaccessible_count、archived_count。
  - 移除场景: EC-3, EC-4, EC-5, EC-6, ER-3, HP-4, HP-5, HP-6, HP-7, HP-8

## [KEPT/unaffected] 语义视图批量添加 [语义视图批量添加]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1

## [KEPT/unaffected] 资产导入导出 [资产导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2

## [NEW 功能/not_in_gt] Athena 数据库连接配置 [athena 数据库连接配置]
summary: Athena 引擎提供动态连接表单参数 schema，包含 AWS 凭据、区域、S3 暂存目录与工作组字段。
  + [edge] EC-1: C=管理员既未填写 s3_staging_dir 也未填写 work_group。 | A=保存 Athena 连接。 | O=表单提示两者至少需提供其一。
  + [edge] EC-2: C=管理员填写 work_group 但省略 s3_staging_dir。 | A=保存 Athena 连接。 | O=连接可保存，查询结果位置由工作组定义或使用托管查询结果。
  + [edge] EC-3: C=用户未填写 S3 query results location。 | A=查看该字段的帮助说明。 | O=帮助说明提示若 workgroup 已设置结果位置则该字段可选。
  + [happy] HP-1: C=管理员在数据库连接弹窗中选择 Athena 引擎。 | A=查看连接表单字段。 | O=表单渲染 AWS Access Key ID、AWS Secret Access Key、Region、S3 staging dir、Schema name 与 Work grou
  + [happy] HP-2: C=管理员在编辑模式下查看已保存的 Athena 连接。 | A=查看 AWS Secret Access Key 字段。 | O=该字段仍以密码输入框呈现，不回退为明文。
  + [happy] HP-3: C=用户新建或编辑 Athena 数据库连接。 | A=打开 Athena 连接表单。 | O=表单按动态参数 schema 展示连接参数项。
  + [happy] HP-4: C=用户在数据库连接弹窗中选择 Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单在 role 字段之后依次展示 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location
  + [happy] HP-5: C=用户填写 Athena 连接参数。 | A=在表单中填写 AWS Access Key ID、Region、S3 暂存目录、Schema 与 Work Group 并保存。 | O=这些参数作为连接参数被保存并在再次打开表单时回填。
  + [happy] HP-6: C=管理员在数据库连接配置中新增或编辑 Athena 连接。 | A=打开 Athena 连接表单。 | O=表单按动态参数 schema 渲染 Athena 连接参数项。
  + [happy] HP-7: C=数据库连接需要解析 SQL 中未限定 schema 的表引用。 | A=调用 Database.get_search_path(catalog, tables)。 | O=返回引擎规格解析出的搜索路径列表与表到 schema 的映射。

## [NEW 功能/not_in_gt] Athena 连接表单 [athena 连接表单]
summary: Athena 引擎提供动态连接参数 schema，连接表单渲染 AWS 凭据、区域、S3 暂存目录、schema 与 work group 字段。
  + [edge] EC-1: C=管理员只填写 work_group 而不填 s3_staging_dir。 | A=保存 Athena 连接。 | O=连接可保存，查询结果位置由 work group 定义或使用托管查询结果。
  + [edge] EC-2: C=用户编辑已有 Athena 连接，URI 中含 catalog_name、role_arn 等非表单参数。 | A=在表单中修改区域后保存。 | O=未单独成字段的查询参数通过 query 字段原样保留，不会因编辑被丢弃。
  + [error] ER-1: C=s3_staging_dir 与 work_group 均未填写。 | A=保存 Athena 连接。 | O=连接校验失败，提示至少需要其一。
  + [error] ER-2: C=用户提交 Athena 连接表单但未填写区域。 | A=点击保存连接。 | O=region_name 为必填字段，校验失败并提示需要填写 AWS 区域。
  + [happy] HP-1: C=管理员新建 Athena 数据库连接。 | A=打开连接表单。 | O=表单按 FormFieldOrder 渲染 aws_access_key_id、aws_secret_access_key、region_name、s3_staging_dir、s
  + [happy] HP-2: C=管理员编辑已有 Athena 连接。 | A=查看 AWS Secret Access Key 字段。 | O=该字段始终以密码输入框显示，不回退为明文。
  + [happy] HP-3: C=用户在数据库连接页面选择 Amazon Athena 引擎。 | A=填写 AWS 访问密钥、区域、S3 暂存目录、默认 schema 与 work group 并保存。 | O=连接以结构化参数表单创建，参数被 AthenaParametersSchema 校验并持久化。
  + [happy] HP-4: C=用户在数据库连接配置页选择 Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单展示 AWS Access Key ID、AWS Secret Access Key、AWS region 与 Athena work group 等字段，标签已本地化。

## [NEW 功能/not_in_gt] MCP 语义表图表更新 [mcp 语义表图表更新]
summary: MCP 的 update_chart 支持对语义表图表进行完整字段重选，并拒绝未验证的保留选择。
  + [edge] EC-1: C=语义提供方未声明 selection_identity_version。 | A=生成语义表图表。 | O=不写入语义选择身份标记，行为与之前一致。
  + [error] ER-1: C=语义表图表保留未验证的旧选择且未完整重选。 | A=调用 update_chart。 | O=请求被拒绝并提示通过 Explore 恢复。
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表配置被完整重选并更新。
  + [happy] HP-2: C=新建语义表图表。 | A=调用 generate_chart 或 generate_explore_link。 | O=新选择的成员被打上语义选择身份标记，保留的旧选择不被标记。

## [NEW 功能/not_in_gt] MCP 语义表字段重选 [mcp 语义表字段重选]
summary: 通过 MCP 更新表与交互式表图表时，对缺失或过期的语义选择标记执行完整字段重选。
  + [edge] EC-1: C=更新请求只提供部分列或未显式给出过滤器。 | A=调用 update_chart。 | O=请求被拒绝并提示需完整重选字段与显式过滤器。
  + [edge] EC-2: C=图表保留的语义选择无法验证。 | A=调用 update_chart。 | O=拒绝更新并提示在 Explore 中恢复。
  + [edge] EC-3: C=更新请求保留未验证的旧选择 | A=调用 update_chart | O=请求被拒绝并提示在 Explore 中恢复
  + [edge] EC-4: C=语义视图提供方未声明选择标识版本。 | A=生成语义视图图表。 | O=不写入语义选择标记。
  + [edge] EC-5: C=语义视图提供方未声明选择身份版本 | A=生成图表 | O=不写入语义选择身份标记
  + [error] ER-1: C=调用方对目标图表或数据集无访问权限。 | A=调用 update_chart。 | O=返回安全错误，更新不执行。
  + [error] ER-2: C=更新请求未提供全部列或未显式给出过滤器 | A=调用 update_chart | O=返回校验错误，图表不被更新
  + [error] ER-3: C=更新语义表图表时保留未验证的旧选择。 | A=调用 update_chart。 | O=请求被拒绝并提示在 Explore 中恢复。
  + [error] ER-4: C=更新图表时保留了未验证的语义选择 | A=调用 update_chart | O=拒绝更新并提示通过 Explore 恢复
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表更新成功，写入新的语义选择标记。
  + [happy] HP-2: C=通过 generate_chart 或 generate_explore_link 新建语义视图图表。 | A=提交语义视图配置。 | O=新选择被打上选择身份标记，未版本化的提供方不写入标记。
  + [happy] HP-3: C=通过 generate_chart 新建语义视图图表。 | A=提交图表配置。 | O=新选择的成员被打上语义选择标记，保留的旧选择不被标记。
  + [happy] HP-4: C=MCP 客户端更新一个语义选择标记缺失或过期的表图表 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器 | O=图表字段选择被完整重选并保存
  + [happy] HP-5: C=MCP 客户端生成新图表并选择语义视图成员 | A=调用 generate_chart | O=新选择的成员被打上当前选择身份标记，不沿用已保存图表的保留选择

## [NEW 功能/not_in_gt] MCP 语义表重选 [mcp 语义表重选]
summary: MCP update_chart 支持对 table 与 interactive table 图表进行完整字段重选，要求显式提供全部列与过滤器，未验证的保留选择被拒绝。
  + [edge] EC-1: C=调用方未提供 columns 或 filters。 | A=对过期语义表调用 update_chart。 | O=返回不完整类别（columns 或 filters），拒绝认证。
  + [edge] EC-2: C=保存的图表含未在请求中显式清除的 WHERE/HAVING 谓词或排序。 | A=提交重选。 | O=返回 saved WHERE/HAVING predicates 或 sorting 类别，拒绝认证。
  + [edge] EC-3: C=语义视图提供方未声明 selection_identity_version。 | A=生成图表。 | O=不写入语义选择版本标记。
  + [edge] EC-4: C=请求级与缓存级 extra_form_data 均包含语义选择来源。 | A=合并 extra_form_data。 | O=合并结果包含合并后的 semantic_selection_sources 列表。
  + [edge] EC-5: C=仪表盘作用域下合并 extra_form_data，模型输入含 semantic_selection_sources 且另一输入含 filters 等成员键但无来源记录。 | A=调用 compose_extra_form_data 合并作用域与模型 extra_form_data。 | O=合并结果包含 semantic_selection_sources，未溯源输入被追加 datasource 为空、version 为 None 的记录。
  + [edge] EC-6: C=仪表盘作用域下合并 extra_form_data，所有输入均不含 semantic_selection_sources。 | A=调用 compose_extra_form_data 合并作用域与模型 extra_form_data。 | O=合并结果不写入 semantic_selection_sources，保持原有合并行为。
  + [error] ER-1: C=重选配置使用非保存指标或视图外维度。 | A=提交 update_chart。 | O=返回语义视图不支持 ad-hoc 表达式或列不存在错误。
  + [error] ER-2: C=更新图表时语义表已过时，且保留的选择未经验证。 | A=调用 UpdateChartRequest 更新图表配置。 | O=请求被拒绝，并返回 Explore 恢复指引；需重新选择所有列并显式指定过滤器（[] 清空）。
  + [happy] HP-1: C=调用方更新一个语义选择标记缺失或过期的 table 图表。 | A=调用 update_chart 并提供目标视图全部成员 ID 的列与显式过滤器。 | O=重选被认证，图表更新成功并写入新的语义选择版本标记。
  + [happy] HP-2: C=调用方生成新图表或 Explore 链接并选择语义视图成员。 | A=调用 generate_chart 或 generate_explore_link。 | O=form_data 写入目标视图的 semantic_selection_version。
  + [happy] HP-3: C=用户在 MCP 中需要重新选择语义表。 | A=触发语义表重选。 | O=可完整重新选择语义表并应用。
  + [happy] HP-4: C=用户通过 MCP 更新语义表选择。 | A=执行完整的语义表重选。 | O=语义表选择被完整替换并生效。
  + [happy] HP-5: C=用户通过 MCP 为语义视图生成图表，且语义表选择身份版本为字符串。 | A=调用 generate_chart 并传入语义视图配置。 | O=form_data 被写入 semantic_selection_version，随后通过语义视图校验并继续生成图表。
  + [happy] HP-6: C=MCP 客户端通过 update_chart 更新语义表图表并触发语义表重选。 | A=调用 update_chart 工具提交新的语义表选择。 | O=工具使用 prove_table_reselection 与 has_dormant_table_grain 校验重选，成功时返回更新后的图表响应。
  + [happy] HP-7: C=MCP 客户端为语义视图生成 Explore 链接。 | A=调用 generate_explore_link 并传入语义视图配置。 | O=form_data 在设置 datasource 后被标记新语义选择，校验通过后返回带 permalink_key 或 form_data_key 的 Explore 链接。
  + [happy] HP-8: C=用户在 MCP 语义表配置中需要更换已选语义表。 | A=执行语义表重选。 | O=可完整重新选择语义表并保存结果。

## [NEW 功能/not_in_gt] SQL Lab [sql lab]
summary: SQL Lab 执行路径对未限定表同样应用 RLS 与表黑名单。
  + [error] ER-1: C=数据库配置了表黑名单，用户查询未带 schema 的未限定表。 | A=提交查询执行。 | O=查询被表黑名单拦截并返回安全异常，不再因缺少 schema 限定而绕过。
  + [happy] HP-1: C=用户拥有 RLS 规则，在 SQL Lab 中执行引用未带 schema 的未限定表的查询。 | A=提交查询执行。 | O=RLS 过滤条件被应用到该未限定表，查询结果按用户权限过滤。

## [NEW 功能/not_in_gt] 最近归档列表 [最近归档列表]
summary: 集中展示已软删除的图表、仪表盘与数据集，支持按类型切换、搜索、恢复与永久删除。
  + [edge] EC-1: C=用户只有读权限。 | A=查看归档行。 | O=不显示操作列，悬停提示需先恢复才能打开。
  + [edge] EC-2: C=用户切换归档类型。 | A=从图表切换到仪表盘。 | O=清除排序与分页参数，按新类型的 deleted_state 过滤重新请求。
  + [error] ER-1: C=恢复请求返回 404（对象已被他人恢复）。 | A=点击恢复。 | O=显示失败提示，列表不刷新且页面不崩溃。
  + [error] ER-2: C=数据集永久删除时依赖已变化。 | A=提交 purge。 | O=返回 409 purge_impact_changed，弹窗展示新的影响并等待再次确认。
  + [happy] HP-1: C=用户打开最近归档页面。 | A=浏览已归档图表列表。 | O=列表按归档时间倒序展示名称、类型、归档时间与归档人。
  + [happy] HP-2: C=用户对某归档项有写权限。 | A=点击恢复。 | O=调用对应类型的 restore 端点，成功后刷新列表并显示带链接的成功提示。
  + [happy] HP-3: C=用户对归档数据集点击永久删除。 | A=在确认弹窗输入 DELETE 并提交。 | O=先获取 purge-impact，再携带 impact_token 调用 purge 端点并刷新列表。

## [NEW 功能/not_in_gt] 列表排序与历史状态 [列表排序与历史状态]
summary: 列表视图组件支持受控排序状态。
  + [edge] EC-1: C=调用方未传入 sortBy | A=组件渲染列表 | O=sortBy 为 undefined，组件按原有默认行为渲染，不报错
  + [happy] HP-1: C=调用方渲染 TableCollection 并传入 sortBy 排序规则 | A=组件渲染列头与数据 | O=mapColumns 使用传入的 sortBy 生成列排序状态，列头排序展示与外部状态一致

## [NEW 功能/not_in_gt] 列表排序与历史状态恢复 [列表排序与历史状态恢复]
summary: 列表视图在浏览器历史恢复时同步排序、页码与搜索状态，并支持受控排序。
  + [edge] EC-1: C=初始排序与当前排序不一致 | A=列表状态 effect 运行 | O=sortBy 被同步为初始排序
  + [edge] EC-2: C=用户在卡片视图修改排序后切换视图或触发重新渲染。 | A=sortBy 发生变化。 | O=CardSortSelect 以新排序重新挂载并显示当前排序。
  + [happy] HP-1: C=用户在列表页修改排序后使用浏览器后退 | A=恢复上一页历史状态 | O=排序、页码与搜索作为同一 URL 状态一并恢复
  + [happy] HP-2: C=受控 TableCollection 的 sortBy 被外部恢复为空排序 | A=重新渲染表格 | O=列头排序指示被清除
  + [happy] HP-3: C=用户通过浏览器历史或 URL 返回带有排序参数的列表页。 | A=页面加载并解析查询参数。 | O=列表排序恢复为 URL 中的排序条件，卡片排序选择器同步显示该排序。

## [NEW 功能/not_in_gt] 列表排序与键盘可达性 [列表排序与键盘可达性]
summary: 列表视图支持受控排序与历史恢复，卡片权限提示可通过键盘在打开菜单前读到。
  + [edge] EC-1: C=受控排序被外部恢复为空排序。 | A=重新渲染表格。 | O=列头排序指示被清除。
  + [edge] EC-2: C=归档成功提示包含恢复链接。 | A=悬停或键盘聚焦该通知。 | O=通知保持打开直到用户关闭，链接遵循部署 URL 前缀。
  + [happy] HP-1: C=用户点击可排序列头。 | A=切换排序方向。 | O=列表按新排序重新请求数据。
  + [happy] HP-2: C=非编辑者用户使用键盘浏览图表或仪表盘卡片。 | A=按 Tab 聚焦 More Options 按钮。 | O=在打开菜单前读到 Edit 或 Archive 不可用的原因，操作本身仍禁用。

## [NEW 功能/not_in_gt] 列表视图排序与历史状态 [列表视图排序与历史状态]
summary: 列表视图的排序、页码与筛选与 URL 历史保持同步，受控排序可被清空。
  + [edge] EC-1: C=受控排序从有值恢复为空排序。 | A=重新渲染列表。 | O=表头不再显示排序标记。
  + [edge] EC-2: C=列配置未显式设置 id，仅以字符串 accessor 标识。 | A=点击其中一列排序。 | O=仅被点击的列显示排序标记，其他列不受影响。
  + [happy] HP-1: C=用户在列表视图点击可排序列头。 | A=点击列头。 | O=列表按该列排序并重新请求数据。
  + [happy] HP-2: C=用户先筛选并翻页，然后使用浏览器后退。 | A=点击后退。 | O=页码、排序与筛选一并恢复到上一状态。

## [NEW 功能/not_in_gt] 图表与仪表盘卡片菜单 [图表与仪表盘卡片菜单]
summary: 列表卡片上的收藏、编辑、导出、归档/删除菜单及权限提示。
  + [edge] EC-1: C=非编辑者通过键盘聚焦卡片菜单按钮 | A=按 Tab 聚焦菜单按钮 | O=显示编辑与归档（或删除）权限提示，菜单不打开
  + [edge] EC-2: C=软删除关闭时管理员删除图表 | A=在卡片菜单点击删除 | O=显示需输入 DELETE 的永久删除确认弹窗
  + [edge] EC-3: C=软删除特性开启且用户无编辑权限。 | A=查看删除/归档菜单项提示。 | O=提示文案使用归档措辞而非删除措辞。
  + [edge] EC-4: C=卡片菜单按钮配置了 tooltipTitle。 | A=悬停或聚焦菜单按钮。 | O=显示配置的提示文本。
  + [edge] EC-5: C=无 dashboard editor 权限的用户打开仪表盘卡片菜单，软删除已开启。 | A=悬停删除菜单项。 | O=提示文案为需成为 dashboard editor 才能归档。
  + [edge] EC-6: C=具备 dashboard editor 权限的用户打开仪表盘卡片菜单。 | A=悬停编辑或删除菜单项。 | O=不显示权限提示文案。
  + [error] ER-1: C=非编辑者点击禁用的编辑或归档项 | A=点击禁用项 | O=不打开对话框，显示需为图表编辑者的提示
  + [happy] HP-1: C=有编辑权限的用户打开图表卡片菜单 | A=点击编辑或归档 | O=打开编辑弹窗或归档确认弹窗
  + [happy] HP-2: C=启用软删除时管理员归档图表 | A=在卡片菜单点击归档并确认 | O=显示归档确认弹窗，无需输入 DELETE
  + [happy] HP-3: C=无图表编辑权限的用户打开图表卡片菜单。 | A=悬停编辑菜单项。 | O=显示需成为图表编辑者的提示。
  + [happy] HP-4: C=无 dashboard editor 权限的用户打开仪表盘卡片菜单，软删除未开启。 | A=悬停编辑或删除菜单项。 | O=编辑项提示需成为 dashboard editor 才能编辑，删除项提示需成为 dashboard editor 才能删除。

## [NEW 功能/not_in_gt] 嵌入式访客身份识别 [嵌入式访客身份识别]
summary: 访客用户判定与缩略图缓存按访客令牌而非用户名区分。
  + [edge] EC-1: C=请求未提供访客键。 | A=生成缩略图 API 请求缓存键。 | O=缓存键与之前一致，不附加访客区分。
  + [edge] EC-2: C=请求既无 JWT 也无访客令牌，且发生在鉴权前的错误处理路径。 | A=调用 is_guest_user。 | O=捕获 NoAuthorizationError 并返回 False，不再向上抛出未处理异常。
  + [happy] HP-1: C=嵌入式访客令牌携带空用户名。 | A=系统判定当前用户是否为访客。 | O=识别为访客，其 RLS 规则进入缩略图摘要。
  + [happy] HP-2: C=同一仪表盘分别以不同访客身份请求缩略图。 | A=生成缩略图 API 请求缓存键。 | O=缓存键按访客键区分，互不复用。
  + [happy] HP-3: C=嵌入式仪表盘以访客身份访问，用户名取值为空或特殊值。 | A=加载嵌入式仪表盘。 | O=访客身份仍被正确识别，不因用户名取值而改变。
  + [happy] HP-4: C=嵌入式仪表盘以访客身份访问，且 username 值发生变化。 | A=加载嵌入式仪表盘。 | O=访客身份保持独立于 username 取值，不因 username 变化而改变。
  + [happy] HP-5: C=嵌入式访客令牌携带空用户名。 | A=系统调用 is_guest_user 判定当前用户。 | O=通过 g.user 识别出访客用户并返回 True，不再因用户名为空而误判。

## [NEW 功能/not_in_gt] 归档通知与键盘可达性 [归档通知与键盘可达性]
summary: 归档与恢复通知保持可操作，卡片菜单与权限提示支持键盘访问。
  + [edge] EC-1: C=部署配置了 URL 前缀 | A=点击归档通知中的恢复链接 | O=链接遵循部署 URL 前缀
  + [happy] HP-1: C=用户归档一个图表或仪表盘 | A=查看成功通知 | O=通知包含指向 Recently Archived 的链接并保持显示直到用户关闭
  + [happy] HP-2: C=键盘用户聚焦图表或仪表盘卡片的 More Options 按钮 | A=按 Tab 进入菜单再按 Tab 返回 | O=焦点返回 More Options 按钮，权限提示可被聚焦

## [NEW 功能/not_in_gt] 版本历史恢复 [版本历史恢复]
summary: 查看图表与仪表盘的版本历史，预览、恢复版本或将版本另存为新对象。
  + [edge] EC-1: C=恢复影响计数请求失败。 | A=打开仪表盘恢复确认对话框。 | O=对话框警告移除数量未知，仍可继续恢复。
  + [edge] EC-2: C=恢复影响计数包含已归档或未放置的成员图表。 | A=打开恢复确认对话框。 | O=计数包含这些成员，反映对话框检查时的成员关系。
  + [edge] EC-3: C=目标版本没有需要移除的当前成员图表 | A=打开恢复确认弹窗 | O=不显示移除警告，恢复按钮可用
  + [edge] EC-4: C=恢复影响计数请求尚未返回 | A=打开恢复确认弹窗 | O=显示正在检查提示，恢复按钮禁用
  + [edge] EC-5: C=用户对图表版本打开恢复确认弹窗 | A=查看弹窗 | O=不请求仪表盘成员计数，不显示移除警告
  + [edge] EC-6: C=目标版本与当前成员图表完全一致。 | A=打开恢复确认弹窗。 | O=不显示移除图表警告。
  + [error] ER-1: C=恢复过程中某图表被永久删除。 | A=确认恢复。 | O=恢复不改变任何内容并提示重试，重试时恢复不含该图表的版本。
  + [error] ER-2: C=恢复影响计数请求失败或超时 | A=打开恢复确认弹窗 | O=提示无法检查将移除的图表，恢复按钮仍可用
  + [error] ER-3: C=页面存在未保存修改 | A=请求恢复版本 | O=提示先保存或放弃未保存修改，不打开恢复弹窗
  + [error] ER-4: C=恢复影响计数请求失败。 | A=打开恢复确认弹窗。 | O=弹窗仍可展示，计数不可用时不阻塞恢复。
  + [happy] HP-1: C=用户打开仪表盘版本历史并选择旧版本恢复。 | A=在恢复确认对话框中确认。 | O=对话框显示当前成员中不属于该版本的图表数量，并警告恢复会移除这些图表但不删除图表本身。
  + [happy] HP-2: C=用户恢复图表版本。 | A=在版本历史面板选择版本并点击 Restore。 | O=实体被重写回所选版本，并追加一条新版本记录。
  + [happy] HP-3: C=用户对仪表盘某历史版本点击恢复 | A=在确认弹窗中确认恢复 | O=仪表盘恢复到该版本并提示成功
  + [happy] HP-4: C=仪表盘当前成员图表中有不属于目标版本的图表 | A=打开恢复确认弹窗 | O=弹窗提示将移除 N 个图表且图表本身不会被删除
  + [happy] HP-5: C=用户将图表或仪表盘版本另存为新对象 | A=点击从该版本创建 | O=新对象在新标签页打开并提示创建成功
  + [happy] HP-6: C=用户选择某仪表盘历史版本并点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并提示恢复会移除这些图表但不删除图表本身。
  + [happy] HP-7: C=用户在版本历史中针对某实体打开恢复确认弹窗。 | A=触发恢复请求。 | O=恢复确认弹窗按实体类型、实体 UUID 与目标版本 UUID 重新挂载，并携带实体 UUID 展示对应确认内容。

## [NEW 功能/not_in_gt] 版本历史恢复提示 [版本历史恢复提示]
summary: 仪表盘恢复前统计并提示将被移除的当前成员图表，不删除图表本身。
  + [edge] EC-1: C=统计包含已归档或未放置的成员图表。 | A=打开恢复确认弹窗。 | O=计数包含这些成员，与恢复时的关联窗口一致。
  + [edge] EC-2: C=弹窗打开后其他用户修改了仪表盘成员。 | A=用户确认恢复。 | O=计数为建议值，实际移除以确认时的成员为准。
  + [error] ER-1: C=恢复影响计数接口请求失败。 | A=打开恢复确认弹窗。 | O=弹窗不阻塞恢复流程，按无计数处理。
  + [happy] HP-1: C=用户选择某个仪表盘版本并打开恢复确认弹窗，当前成员中有不属于该版本的图表。 | A=打开恢复确认弹窗。 | O=弹窗显示将被移除的图表数量并说明图表本身不会被删除。
  + [happy] HP-2: C=当前成员全部属于目标版本。 | A=打开恢复确认弹窗。 | O=不显示移除警告，可直接确认恢复。

## [NEW 功能/not_in_gt] 版本历史恢复警告 [版本历史恢复警告]
summary: 仪表盘恢复确认对话框统计当前成员中不属于目标版本的图表数量并警告将被移除，图表本身不被删除。
  + [edge] EC-1: C=当前成员包含已归档或未放置的图表。 | A=统计恢复影响。 | O=计数包含这些成员，与恢复时的附件窗口一致。
  + [edge] EC-2: C=对话框打开后其他用户修改了仪表盘成员。 | A=用户确认恢复。 | O=计数为建议值，可能已变化。
  + [error] EC-3: C=恢复影响接口返回的 removed_chart_count 缺失或不是非负整数。 | A=打开恢复确认弹窗。 | O=计数请求抛出 Invalid restore impact response 错误，弹窗无法获得移除图表数量。
  + [edge] EC-4: C=用户恢复的是图表版本而非仪表盘版本。 | A=打开恢复确认弹窗。 | O=不发起恢复影响计数请求，不展示移除图表数量。
  + [error] ER-1: C=恢复影响计数请求失败。 | A=打开恢复确认对话框。 | O=不阻塞恢复流程，按无计数处理。
  + [happy] HP-1: C=用户选择某个仪表盘版本并点击恢复。 | A=打开恢复确认对话框。 | O=对话框显示当前成员中不属于该版本、恢复后将被移除的图表数量。
  + [happy] HP-2: C=目标版本包含当前全部成员图表。 | A=打开恢复确认对话框。 | O=移除数量为 0，不显示移除警告。
  + [happy] HP-3: C=用户在版本历史中恢复一个将移除仪表盘图表的版本。 | A=确认恢复操作。 | O=在移除图表前显示警告提示。
  + [happy] HP-4: C=用户在版本历史中选择一个仪表盘版本并触发恢复。 | A=打开恢复确认弹窗。 | O=弹窗请求恢复影响计数并展示该版本恢复后将移除的图表数量。
  + [happy] HP-5: C=用户选择恢复一个会移除仪表盘图表的历史版本。 | A=确认恢复操作。 | O=恢复前展示将移除仪表盘图表的警告提示。

## [NEW 功能/not_in_gt] 访客缩略图缓存隔离 [访客缩略图缓存隔离]
summary: 缩略图摘要与 API 请求缓存键按访客身份隔离，访客令牌用户名为空时仍正确识别。
  + [edge] EC-1: C=非访客用户请求缩略图。 | A=生成 API 请求缓存键。 | O=缓存键不包含访客键，与访客缓存分离。
  + [edge] EC-2: C=访客令牌携带空用户名。 | A=判定当前用户是否为访客。 | O=不读取用户名，仍识别为访客。
  + [edge] EC-3: C=两个不同访客访问同一仪表盘，各自 RLS 规则不同。 | A=分别计算缩略图摘要。 | O=两人得到不同摘要，不共享同一缓存缩略图。
  + [error] ER-1: C=THUMBNAIL_EXECUTORS 未包含 CURRENT_USER 且执行器解析失败。 | A=计算仪表盘摘要。 | O=返回 None，不生成缩略图摘要。
  + [happy] HP-1: C=嵌入式访客请求仪表盘缩略图。 | A=生成缩略图摘要与 API 请求缓存键。 | O=缓存键包含访客身份，访客行级规则进入摘要。
  + [happy] HP-2: C=THUMBNAIL_EXECUTORS 配置为 CURRENT_USER，嵌入式访客用户名无法解析为本地用户。 | A=请求该访客可见仪表盘的缩略图摘要。 | O=以访客自身身份作为执行器键计算摘要，摘要包含该访客的 RLS 规则。

## [NEW 功能/not_in_gt] 软删除归档体验 [软删除归档体验]
summary: 归档与恢复提示、计数文案、归档列表历史与卡片菜单键盘可达性的改进。
  + [edge] EC-1: C=归档提示文本包含 HTML 链接但未设置 action。 | A=渲染提示。 | O=提示不自动关闭，等待用户关闭。
  + [edge] EC-2: C=多个卡片菜单按钮同时存在且各自带提示。 | A=聚焦不同按钮。 | O=每个按钮的提示 id 唯一，提示消失后描述属性被移除。
  + [edge] EC-3: C=用户删除数据集且未启用软删除，数据集被图表和仪表盘引用。 | A=打开删除确认弹窗。 | O=确认文案显示“is linked to %s charts and %s dashboards. Are you sure you want to continue? Deleti
  + [edge] EC-4: C=键盘用户操作归档相关菜单。 | A=使用键盘导航归档操作。 | O=焦点与操作可达，归档流程可完成。
  + [happy] HP-1: C=用户归档一个图表并收到带恢复链接的成功提示。 | A=等待提示自动消失时间过去。 | O=提示保持显示直到用户关闭，链接遵循部署 URL 前缀。
  + [happy] HP-2: C=用户使用键盘聚焦图表或仪表盘卡片的更多操作按钮。 | A=按 Tab 聚焦按钮。 | O=权限提示作为按钮的可访问描述被读出。
  + [happy] HP-3: C=用户在归档列表切换对象类型筛选。 | A=选择筛选条件。 | O=URL 以 push 方式更新，浏览器后退可回到上一筛选。
  + [happy] HP-4: C=用户从归档列表恢复一个带链接的资产。 | A=执行恢复操作。 | O=成功提示中的“View <type> →”链接指向应用根路径下的正确地址（经 ensureAppRoot 处理）。
  + [happy] HP-5: C=用户在归档列表切换对象类型（如从图表切到仪表盘）。 | A=在 Type 下拉框选择另一类型。 | O=URL 以 push 方式更新 type 并清除 sortColumn、sortOrder、pageIndex，浏览器历史新增一条记录，可后退回到上一类型视图。
  + [happy] HP-6: C=用户对图表或仪表盘执行归档操作。 | A=完成归档。 | O=显示归档提示 toast，归档计数与历史列表同步更新。

## [NEW 功能/not_in_gt] 软删除归档提示 [软删除归档提示]
summary: 归档成功提示中的恢复链接遵循部署 URL 前缀，含链接的通知保持到用户关闭，数据集删除计数文案区分图表与仪表盘。
  + [edge] EC-1: C=数据集关联 2 个图表和 1 个仪表盘。 | A=查看删除确认文案。 | O=文案显示“linked to 2 charts and 1 dashboard”。
  + [edge] EC-2: C=用户在 Recently Archived 页面切换对象类型。 | A=选择另一种对象类型。 | O=浏览器历史新增一条记录，可后退返回上一类型。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=执行归档。 | O=成功提示包含指向 Recently Archived 的恢复链接，链接带部署 URL 前缀。
  + [happy] HP-2: C=归档成功提示含 HTML 链接。 | A=等待提示自动消失时间。 | O=提示保持显示直到用户关闭或激活链接。

## [NEW 功能/not_in_gt] 软删除归档通知 [软删除归档通知]
summary: 归档与恢复操作的通知文案、链接与停留行为。
  + [edge] EC-1: C=通知包含 HTML 链接 | A=等待超过 toast 时长 | O=通知保持显示直到用户关闭
  + [edge] EC-2: C=系统展示一条无 action、无链接且 duration>0 的普通通知。 | A=通知渲染。 | O=通知在 duration 到期后自动关闭。
  + [error] ER-1: C=通知 HTML 中含脚本 URI 或事件处理器 | A=渲染通知 | O=脚本 URI 与事件处理器被剥离，不生成可点击链接
  + [happy] HP-1: C=用户归档图表或仪表盘 | A=确认归档 | O=提示对象将移入 Recently Archived，并带指向对应类型的链接
  + [happy] HP-2: C=用户恢复已归档对象 | A=查看恢复成功通知 | O=通知中的链接使用部署根路径前缀
  + [happy] HP-3: C=系统展示一条包含 HTML 链接的提示通知。 | A=通知渲染并启动显示。 | O=通知不设置自动关闭定时器，保持可见直到用户手动关闭。
