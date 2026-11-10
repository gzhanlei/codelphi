
## [KEPT/unaffected] Databricks SQL Lab [databricks sql lab]
  逐字相同场景: EC-1, HP-1

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
  + EC-1 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应不含移除数量。
  + EC-2 [edge] C=调用方未传 include_restore_impact 或传 false | A=GET 仪表盘版本详情 | O=不计算恢复影响计数，响应保持原有结构
  + EC-3 [edge] C=调用方未传 include_restore_impact 或为 false | A=GET 仪表盘版本详情 | O=响应不包含 _restore_impact 字段
  + EC-4 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=响应不包含恢复影响计数
  + EC-5 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算也不返回恢复影响计数。
  + EC-6 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算恢复影响，行为与之前一致。
  + HP-2 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的当前成员图表数量。
  + HP-3 [happy] C=调用方请求仪表盘版本详情并附带 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应 result 中额外返回 _restore_impact.removed_chart_count 整数
  + HP-4 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应额外包含恢复该版本将移除的当前成员图表数量。

## [CHANGED/affected] SQL 编辑器 [sql 编辑器]
  逐字相同场景: ER-1, HP-1, HP-2
  + EC-1 [edge] C=非限定表名在 PostgreSQL、Oracle 或 Snowflake 上大小写与 RLS 规则不一致。 | A=执行 SQL Lab 查询。 | O=解析器按引擎折叠规则匹配未加引号名称，保留引号名称原样。
  + EC-2 [edge] C=查询估算阶段遇到无 schema 的非限定表。 | A=估算查询成本。 | O=同样应用 RLS 与表黑名单后再估算。
  + EC-3 [edge] C=查询估算引用未限定 schema 的表名 | A=执行查询估算 | O=同样应用 RLS 与表黑名单解析
  + EC-4 [edge] C=SQL Lab 查询引用未写 schema 的表且该表在 RLS 或表黑名单中 | A=执行查询 | O=按引擎 search path 解析后注入 RLS 谓词或拒绝该表
  + EC-5 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表在表黑名单中 | A=执行查询 | O=查询被拦截
  + EC-6 [edge] C=查询引用无 schema 的非限定表，且表拒绝名单含 schema 限定条目。 | A=执行或估算该查询。 | O=按 search path 解析出的 schema 匹配拒绝名单并拒绝。
  + EC-7 [edge] C=SQL Lab 查询引用未限定 schema 的表，且该表在默认 schema 或搜索路径中命中 RLS 或表黑名单。 | A=执行查询。 | O=按解析出的 schema 应用 RLS 谓词与表黑名单限制。
  + EC-8 [edge] C=Postgres 表名包含非 ASCII 大写字母且未加引号引用。 | A=执行引用该表的查询。 | O=系统按 Postgres 编码规则生成候选拼写进行匹配，避免因大小写折叠差异漏匹配。
  + EC-9 [edge] C=引擎无法确定未限定 schema 的表实际所在 schema。 | A=执行引用该表的查询。 | O=该表被视为可能位于任一 schema，RLS 与表黑名单在任一 schema 匹配时均生效。
  + ER-2 [error] C=成本估算超过 SQLLAB_QUERY_COST_ESTIMATE_TIMEOUT。 | A=请求查询成本估算。 | O=返回 SQLLAB_TIMEOUT_ERROR 错误提示。
  + ER-3 [error] C=解析 search_path 或查询表所在 schema 时连接不可用。 | A=执行引用未限定 schema 表的查询。 | O=get_search_path 抛出异常，查询按连接错误路径处理。
  + HP-3 [happy] C=SQL Lab 查询引用无 schema 的非限定表，且该表在默认 schema 或搜索路径中命中 RLS 规则。 | A=执行查询。 | O=RLS 谓词被注入到该表查询中。
  + HP-4 [happy] C=SQL Lab 查询引用未带 schema 的表名且该表存在 RLS 规则 | A=执行查询 | O=按默认 schema 或搜索路径解析表名并注入 RLS 谓词
  + HP-5 [happy] C=SQL Lab 查询引用无 schema 的非限定表且该表有 RLS 过滤 | A=执行查询 | O=按引擎 search path 解析表并注入 RLS 谓词
  + HP-6 [happy] C=用户在 SQL Lab 对无 schema 的非限定表执行查询且启用 RLS_IN_SQLLAB。 | A=执行查询。 | O=按连接 search path 解析实际 schema 后注入 RLS 谓词。
  + HP-7 [happy] C=Postgres 连接配置了非默认 search_path，用户在 SQL Lab 查询未限定 schema 的表。 | A=执行引用该表的查询。 | O=系统按 search_path 顺序解析表实际所在 schema，RLS 与 DISALLOWED_SQL_TABLES 对该表生效。
  + HP-8 [happy] C=Snowflake 用户在 SQL Lab 使用 db..table 形式引用表。 | A=执行该查询。 | O=系统将两段式引用解析为对应数据库的 PUBLIC schema，RLS 与表黑名单按 PUBLIC schema 匹配。

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
    C v49: 嵌入式访客令牌携带空用户名。
    A v48: 保存仪表盘布局
    A v49: 访客访问仪表盘并生成缩略图。
    O v48: 该图表保存为缺失图表占位，布局其余部分正常保存
    O v49: 访客被正确识别，缩略图摘要按访客自身键区分，不与其他访客混用。
  + ER-1 [error] C=访客请求未授权的查询数据源 | A=访问 Explore 表单或永久链接端点 | O=返回 HTTP 403
  + ER-2 [error] C=调用方为访客并尝试仅更新图表 query_context | A=提交图表更新 | O=返回 ChartForbiddenError
  + ER-3 [error] C=调用方请求不存在的仪表盘 id 或 slug。 | A=GET 仪表盘详情。 | O=返回 404。
  + HP-3 [happy] C=嵌入式访客令牌携带空用户名。 | A=生成仪表盘截图或缩略图。 | O=按访客身份解析执行器，RLS 规则进入摘要，截图按访客权限生成。
  + HP-4 [happy] C=嵌入式访客令牌携带空用户名 | A=访客请求仪表盘缩略图 | O=按访客身份生成摘要缓存键，RLS 规则进入摘要
  + HP-5 [happy] C=图表被加入或移出仪表盘 | A=更新图表的 dashboards 关联 | O=受影响仪表盘的审计元数据被更新
  - 移除场景: EC-4

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
    C v49: 许可证检查脚本下载 RAT jar 时首次请求失败。
    A v48: 触发 labeler 工作流。
    A v49: 运行 check_license.sh。
    O v48: PR 被自动添加 i18n:catalan 标签。
    O v49: curl 以 --retry 5 --retry-all-errors 重试下载，成功后继续检查。
  ~ HP-5(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ar/** 的 PR。
    C v49: 提交的 PR 修改了 superset/translations/pl/ 下的翻译文件。
    A v48: 触发 labeler 工作流。
    A v49: labeler 工作流应用标签规则。
    O v48: PR 被自动打上 i18n:arabic 标签。
    O v49: 该 PR 被自动打上 i18n:polish 标签。
  ~ HP-6(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ca/** 的 PR。
    C v49: 运行 check_license.sh 且本地尚无 RAT jar，系统可用 curl。
    A v48: 触发 labeler 工作流。
    A v49: 脚本通过 curl 下载 apache-rat jar。
    O v48: PR 被自动打上 i18n:catalan 标签。
    O v49: curl 以 --fail 模式下载，遇到瞬时错误最多重试 5 次、每次间隔 3 秒，成功后移动为最终 jar 文件。
  + EC-2 [edge] C=运行 check_license.sh 且系统仅有 wget，Maven 仓库返回 503 或 429。 | A=脚本通过 wget 下载 apache-rat jar。 | O=wget 对 429/500/502/503/504 响应进行重试，最多 5 次、等待 3 秒，连接被拒时也重试。
  + EC-3 [edge] C=许可证检查时 RAT jar 下载出现临时网络失败。 | A=运行 check_license.sh。 | O=下载被重试，许可证检查不再因临时失败而中断。
  + ER-2 [error] C=下载 RAT jar 时网络请求失败 | A=运行 check_license.sh | O=curl/wget 按重试参数重试，仍失败则清理残留并提示手动安装
  + ER-3 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败时输出错误信息
  + ER-4 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 按重试策略重新下载，成功后继续校验
  + ER-5 [error] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以失败重试方式最多重试 5 次，仍失败则输出错误并退出。
  + ER-6 [error] C=运行 check_license.sh 且 curl 与 wget 均不可用。 | A=脚本尝试获取 RAT jar。 | O=输出提示要求手动安装 rat 并以退出码 255 结束。
  + ER-7 [error] C=CI 运行 check_license.sh 下载 RAT jar，或 setup-backend 安装后端环境。 | A=RAT jar 下载出现瞬时失败，或 setup-uv 需要安装。 | O=RAT jar 下载自动重试；setup-uv 固定到允许列表中的发布版本，流程不再因瞬时下载失败或版本漂移而中断。
  + HP-7 [happy] C=CI 执行 check_license.sh 下载 RAT jar。 | A=首次下载失败。 | O=脚本重试下载，减少因网络偶发失败导致的检查失败。
  + HP-8 [happy] C=CI 执行后端环境安装与许可证检查。 | A=运行 setup-backend 与 check_license.sh。 | O=setup-uv 使用允许列表版本，RAT jar 下载失败时自动重试，构建更稳定。

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

## [KEPT/unaffected] 图表构建与可视化 [图表构建与可视化]
  逐字相同场景: EC-1, HP-1

## [CHANGED/unaffected] 安全依赖管理 [安全依赖管理]
  逐字相同场景: EC-1, ER-1, HP-1
  ~ HP-2(rewritten):
    C v48: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    C v49: 安装 MCP 相关依赖。
    A v48: 执行依赖安装/解析。
    A v49: 解析 fastmcp 版本。
    O v48: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  ~ HP-3(rewritten):
    C v48: 安装 Superset 依赖。
    C v49: 安装 Superset 的 fastmcp 可选依赖
    A v48: 解析并安装 pyarrow。
    A v49: 解析 fastmcp 版本
    O v48: 安装的 pyarrow 版本不低于修复版本，不含 CVE-2026-111497。
    O v49: 安装 4.1.4 及以上、5.0 以下版本
  ~ HP-4(rewritten):
    C v48: 在干净环境中安装 Superset 依赖。
    C v49: 安装 MCP 服务依赖
    A v48: 解析 pyarrow 依赖约束。
    A v49: 解析 fastmcp 版本
    O v48: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
    O v49: 安装 4.1.4 及以上、5.0 以下版本
  ~ HP-5(rewritten):
    C v48: 安装项目依赖
    C v49: 安装 fastmcp 可选依赖。
    A v48: 解析 pyarrow 版本
    A v49: 解析 fastmcp 版本。
    O v48: 不再解析到含 CVE-2026-111497 的 pyarrow 版本
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  + EC-2 [edge] C=开发环境按 requirements/development.txt 安装依赖。 | A=安装 fastmcp 及其依赖。 | O=fastmcp 与 fastmcp-slim 锁定为 4.1.6，certifi 的 via 注释包含 fastmcp-slim。
  + HP-6 [happy] C=用户安装 fastmcp extra。 | A=依赖解析器解析 fastmcp 版本。 | O=解析到 fastmcp>=4.1.4,<5.0 范围内的版本，低于 4.1.4 的版本不再被接受。
  + HP-7 [happy] C=开发或测试环境安装依赖。 | A=安装开发依赖。 | O=安装 fastmcp 4.1.4，运行时对外行为不变。

## [CHANGED/affected] 安全角色与认证 [安全角色与认证]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 启用 VIEWER_PROMISCUOUS_MODE
    C v49: 调用方不具备 promiscuous 仪表盘授权。
    A v48: 查看者访问仪表盘
    A v49: GET /api/v1/dashboard/{id_or_slug}。
    O v48: 仅该仪表盘自身的图表与数据集请求被授权
    O v49: charts 仅包含调用方可访问的成员图表。
  ~ EC-3(rewritten):
    C v48: 调用方不具备 promiscuous 仪表盘授权。
    C v49: 访客令牌携带空用户名
    A v48: GET /api/v1/dashboard/{id_or_slug}。
    A v49: 判定当前用户是否为访客
    O v48: charts 仅包含调用方可访问的成员图表。
    O v49: 仍被识别为访客，不依赖用户名取值
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
    A v49: 调用 is_guest_user 判定当前用户。
    O v48: charts 返回该仪表盘全部成员图表，不再逐图表过滤。
    O v49: 仅评估当前用户对象，不读取用户名，正确返回访客身份。
  + EC-4 [edge] C=嵌入式访客令牌携带空用户名。 | A=调用 is_guest_user 判定当前用户。 | O=仍返回 True，不因用户名为空而误判为非访客。
  + EC-5 [edge] C=启用 VIEWER_PROMISCUOUS_MODE | A=查看者访问仪表盘 | O=仅该仪表盘自身的图表与数据集请求被授权
  + HP-4 [happy] C=嵌入式访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=仅依据当前用户求值结果判定为访客，不依赖用户名
  + HP-5 [happy] C=访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=仍被正确识别为访客，不依赖用户名

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
  summary REWRITTEN:
    v48: OAuth2 连接支持嵌入式专用回退凭据。
    v49: 允许 OAuth2 数据库连接携带仅用于嵌入式访客请求的用户名与密码或密钥对，登录用户仍按用户 OAuth2 认证。
  逐字相同场景: HP-1, HP-2
  + EC-1 [edge] C=连接开启模拟登录用户但无 OAuth2 客户端且无可用凭据 | A=嵌入式访客查询 | O=查询被拒绝，访客看到连接未为嵌入式仪表盘配置的提示，服务端日志记录连接与修复方法
  + EC-2 [edge] C=嵌入式仪表盘以访客身份访问，username 值为空或发生变化。 | A=访客加载嵌入式仪表盘。 | O=访客身份不再依赖 username 取值，仍能获得稳定的访客身份并正常加载。
  + EC-3 [edge] C=请求既无 JWT 也无访客令牌，且处于鉴权前路径（如错误清理）。 | A=调用 is_guest_user。 | O=捕获 NoAuthorizationError 并返回 False，不再向上抛出未处理异常。
  + ER-1 [error] C=凭据只有用户名或只有密码/私钥，或用户名为纯空白 | A=保存连接 | O=校验失败，凭据被拒绝
  + ER-2 [error] C=嵌入式访客私钥无法加载。 | A=嵌入式访客发起查询。 | O=拒绝该访客并提示检查嵌入式凭据中的私钥与口令。
  + HP-3 [happy] C=启用 EMBEDDED_SUPERSET 与 EMBEDDED_CREDENTIAL_FALLBACK，Snowflake 连接配置 OAuth2 客户端、开启模拟登录用户并保存嵌入式访客凭据 | A=嵌入式访客查询该连接上的图表 | O=查询以配置的专用数据库账号执行，结果使用独立缓存分区
  + HP-4 [happy] C=Snowflake 连接配置了密钥对形式的嵌入式访客凭据。 | A=嵌入式访客发起查询。 | O=连接清除连接自身身份参数，改用嵌入式私钥登录。
  + HP-5 [happy] C=嵌入式仪表盘以访客身份访问，且 username 取值为空或发生变化。 | A=访客加载嵌入式仪表盘。 | O=访客身份保持独立于 username 取值，不因用户名变化而改变。
  + HP-6 [happy] C=嵌入式仪表盘以访客身份访问，且 username 为空或取特殊值。 | A=加载嵌入式仪表盘。 | O=访客身份保持独立且正确，不受 username 值影响。
  + HP-7 [happy] C=嵌入式访客令牌携带空用户名。 | A=调用 is_guest_user 判定当前用户。 | O=通过 g.user 识别为访客，返回 True。

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
    O v49: 连接参数校验提示至少需要 s3_staging_dir 或 work_group 之一。
  ~ HP-3(rewritten):
    C v48: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    C v49: 管理员配置 Amazon Athena 连接。
    A v48: 提交数据库连接配置。
    A v49: 在连接表单中填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query result location、Schema name 与 Work group。
    O v48: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
    O v49: 表单按动态参数 schema 渲染这些字段并随连接参数提交。
  ~ HP-4(rewritten):
    C v48: 管理员更新一个已存在的数据库连接，请求体合法。
    C v49: 管理员编辑已保存的 Athena 连接。
    A v48: PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。
    A v49: 查看 AWS Secret Access Key 输入框。
    O v48: 返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
    O v49: 密钥以密码输入框掩码显示，不回退为明文。
  ~ HP-5(rewritten):
    C v48: 用户在数据库连接弹窗中配置含私钥字段的连接
    C v49: 管理员配置 Athena 数据库连接
    A v48: 打开数据库连接配置弹窗并填写连接参数
    A v49: 在连接表单中填写 AWS Access Key ID、Secret、Region、S3 staging dir、Schema name、Work group
    O v48: 私钥类字段被正确识别与处理，连接配置可正常保存
    O v49: 表单按 FormFieldOrder 渲染这些字段并可保存
  ~ HP-6(rewritten):
    C v48: OAuth2 数据库连接需要携带客户端信息与嵌入式凭据
    C v49: 管理员在编辑模式下查看 AWS Secret Access Key 字段
    A v48: 保存包含 oauth2_client_info 与 embedded_credentials 的连接参数
    A v49: 打开连接表单
    O v48: 连接参数类型接受这两个可选字段，配置可正常提交
    O v49: 该字段始终以密码输入框渲染，不回退为明文
  + EC-3 [edge] C=数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3 | A=构建该数据库引擎规范的 parameters_json_schema | O=该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra
  + EC-4 [edge] C=Athena 连接未填写 S3 query results location | A=查看该字段 | O=字段非必填，提示 Work Group 已设置结果位置时可省略
  + EC-5 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group。 | A=保存或校验连接参数。 | O=返回缺少 s3_staging_dir、work_group 的参数校验警告。
  + HP-10 [happy] C=管理员配置 Athena 数据库连接 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录与 work group | O=连接参数按动态 schema 渲染并保存
  + HP-11 [happy] C=管理员编辑已有 Athena 连接 | A=查看 AWS Secret Access Key 字段 | O=该字段始终以密码输入框渲染，不回退为明文
  + HP-12 [happy] C=管理员配置 Amazon Athena 连接。 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录或 work group。 | O=表单按 Athena 参数 schema 渲染并生成 SQLAlchemy URI。
  + HP-13 [happy] C=管理员更新一个已存在的数据库连接，请求体合法。 | A=PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。 | O=返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
  + HP-14 [happy] C=管理员配置 Athena 数据库连接。 | A=打开连接表单。 | O=表单按 Athena 动态 schema 渲染 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、schema_name、work_group 等字段。
  + HP-7 [happy] C=管理员更新一个已存在的数据库连接，请求体合法 | A=PUT /api/v1/database/{pk} | O=返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回
  + HP-8 [happy] C=管理员在 Athena 连接弹窗中填写 AWS Access Key ID、Secret、Region、S3 结果位置与 Work Group | A=保存连接 | O=这些参数作为连接参数提交并保存
  + HP-9 [happy] C=管理员在编辑模式下修改 Athena 的 AWS Secret Access Key | A=在连接弹窗中输入新密钥 | O=输入框保持密码类型并带可见性切换，不以明文展示

## [CHANGED/affected] 数据源连接 [数据源连接]
  逐字相同场景: EC-1, EC-2, ER-1, ER-2, HP-1, HP-2
  ~ EC-3(rewritten):
    C v48: 用户导入图表包，包内包含与已有数据库 UUID 相同的数据库配置。
    C v49: Athena 连接使用 VPC/PrivateLink 自定义主机名。
    A v48: 执行图表导入。
    A v49: 从 URI 解析连接参数。
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: region_name 保留完整主机名与端口，重新保存不丢失。
  ~ HP-3(rewritten):
    C v48: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    C v49: Athena 连接配置了 work_group 而未填 s3_staging_dir。
    A v48: 提交创建数据库请求。
    A v49: 保存并测试连接。
    O v48: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
    O v49: 连接可用，查询结果位置由工作组定义或使用托管查询结果。
  ~ HP-4(rewritten):
    C v48: 用户创建 OAuth2 数据源连接，连接测试通过但权限同步时创建管理员尚无 OAuth2 令牌。
    C v49: Athena 连接仅提供 work_group 而未提供 s3_staging_dir
    A v48: 提交创建数据库请求。
    A v49: 保存并测试连接
    O v48: 数据库创建成功，不再因缺少 OAuth2 令牌返回 422；权限在首次设置访问时同步。
    O v49: 连接可保存，由工作组定义查询结果位置
  ~ HP-5(rewritten):
    C v48: 管理员更新一个已存在的数据库连接。
    C v49: 管理员配置 Athena 连接且 work group 已定义查询结果位置
    A v48: 向数据库 PUT 接口提交请求体。
    A v49: 保存连接时不填 s3_staging_dir
    O v48: 请求体由 DatabasePutSchema(database_id=pk) 校验，合法时返回 200 与更新后的连接信息。
    O v49: 连接保存成功，查询结果位置由 work group 提供
  ~ HP-6(rewritten):
    C v48: 数据库引擎参数包含加密字段，前端获取参数 JSON Schema。
    C v49: 管理员配置 Amazon Athena 连接并填写 region_name 与 s3_staging_dir。
    A v48: 读取引擎参数的 OpenAPI 3 schema。
    A v49: 保存连接。
    O v48: 加密字段带 x-encrypted-extra: true 标记，连接对话框据此渲染并将值放入 masked_encrypted_extra。
    O v49: 生成 awsathena+rest URI，其他查询参数经 query 字段保留。
  + HP-7 [happy] C=管理员配置 Athena 连接且工作组已定义查询结果位置。 | A=保存连接。 | O=可省略 s3_staging_dir，连接按工作组配置生效。
  - 移除场景: EC-4, EC-5, ER-3, ER-4, ER-5, ER-6, ER-7

## [CHANGED/unknown] 数据集列表管理 [数据集列表管理]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2, HP-3
  ~ HP-4(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 数据集被多个图表与仪表盘引用。
    A v48: 打开导入弹窗并提交导入。
    A v49: 打开删除确认弹窗。
    O v48: 导入弹窗识别加密文件额外字段并正常处理导入。
    O v49: 提示文案显示“is linked to N charts and M dashboards”。
  ~ HP-5(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户查看数据集删除确认弹窗
    A v48: 执行导入。
    A v49: 查看依赖提示文案
    O v48: 导入流程识别加密文件额外字段并继续处理。
    O v49: 提示显示“is linked to N charts and M dashboards”
  + EC-2 [edge] C=用户使用浏览器后退返回上一页列表状态 | A=触发历史导航 | O=排序、页码与搜索条件一并恢复
  + EC-3 [edge] C=数据集被 2 个图表和 1 个仪表盘引用。 | A=打开删除确认弹窗。 | O=提示文案为“linked to 2 charts and 1 dashboard”。
  + HP-6 [happy] C=用户批量删除数据集并查看依赖警告 | A=打开批量删除确认弹窗 | O=弹窗显示“linked to N charts and M dashboards”及受限依赖数量

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
    C v49: 批量删除多个语义视图，其中部分视图存在依赖资产
    A v48: 确认删除
    A v49: 提交批量删除
    O v48: 视图被删除
    O v49: 删除被拒绝，错误响应仅列出有依赖的视图及其 total、dependents、inaccessible_count、archived_count
  - 移除场景: EC-3, EC-4, EC-5, EC-6, ER-3, HP-4, HP-5, HP-6, HP-7, HP-8

## [KEPT/unaffected] 语义视图批量添加 [语义视图批量添加]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1

## [KEPT/unaffected] 资产导入导出 [资产导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2

## [NEW 功能/not_in_gt] Athena 连接表单 [athena 连接表单]
summary: Athena 引擎提供动态连接参数 schema，连接弹窗按字段定义渲染 AWS 凭据、区域、S3 输出位置、schema 与工作组等输入项。
  + [edge] EC-1: C=管理员在编辑模式下查看 AWS Secret Access Key。 | A=打开连接表单。 | O=该字段以密码输入框渲染，不回退为明文。
  + [edge] EC-2: C=用户编辑 Athena 数据库连接 | A=查看 S3 query results location 字段的帮助文本 | O=显示「Optional if your workgroup sets a result location.」提示
  + [edge] EC-3: C=用户创建 Athena 连接时未填写 region_name。 | A=提交动态连接表单。 | O=region_name 为必填字段，表单校验不通过，连接不被保存。
  + [edge] EC-4: C=用户创建 Athena 连接时未填写 s3_staging_dir。 | A=提交动态连接表单。 | O=s3_staging_dir 允许为空，连接可保存，适用于工作组已定义查询结果位置或使用托管查询结果的场景。
  + [edge] EC-5: C=用户填写 Athena 连接表单并提交。 | A=提交包含 AWS 凭据、区域与工作组的连接配置。 | O=连接配置按所填参数保存，后续查询使用指定工作组执行。
  + [error] ER-1: C=Athena 连接既未提供 s3_staging_dir，工作组也未定义查询结果位置。 | A=保存连接。 | O=连接配置不完整，无法确定查询结果输出位置。
  + [happy] HP-1: C=管理员配置 Athena 数据库连接。 | A=打开连接表单。 | O=表单渲染 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、schema_name、
  + [happy] HP-2: C=Athena 工作组已定义查询结果位置或使用托管查询结果。 | A=保存连接时不填写 s3_staging_dir。 | O=连接可正常保存，无需 S3 输出位置。
  + [happy] HP-3: C=用户在数据库连接配置中选择 Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单按动态连接参数 schema 展示可配置参数项。
  + [happy] HP-4: C=用户在设置中新建或编辑 Athena 数据库连接。 | A=打开 Athena 连接表单。 | O=表单按动态参数 schema 展示可配置的连接参数。
  + [happy] HP-5: C=用户编辑 Athena 数据库连接 | A=在连接表单中查看并填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、Schem | O=表单按顺序展示这些字段，并显示对应标签与示例占位符，S3 查询结果位置字段显示可选说明
  + [happy] HP-6: C=用户创建 Athena 数据库连接并填写动态表单。 | A=填写 region_name 及可选的 aws_access_key_id、aws_secret_access_key、s3_staging_dir、schema_name、wor | O=连接按分项参数保存，未在表单中单列的查询参数通过 query 字段原样保留。
  + [happy] HP-7: C=数据库连接配置需要解析未限定 schema 的表引用。 | A=调用 Database.get_search_path 并传入 catalog 与表名集合。 | O=返回搜索路径列表与表到 schema 的映射，供连接表单与 RLS 判定使用。
  + [happy] HP-8: C=管理员在数据库连接页面选择 Athena 作为连接类型。 | A=打开 Athena 连接表单。 | O=表单展示 AWS Access Key ID、AWS Secret Access Key、AWS region 与 Athena work group 等动态参数字段。

## [NEW 功能/not_in_gt] CI 后端环境安装 [ci 后端环境安装]
summary: CI 后端环境安装使用固定版本的 uv 工具。
  + [error] ER-1: C=setup-uv 版本不在允许列表中 | A=运行 setup-backend 动作 | O=动作使用固定提交哈希，避免非允许版本
  + [happy] HP-1: C=CI 安装 Superset 后端依赖 | A=运行 setup-backend 动作 | O=使用固定版本 setup-uv v10.3.3 安装 uv 并启用缓存
  + [happy] HP-2: C=CI 工作流调用 setup-backend 复合动作且 install-superset 为 true。 | A=执行 Install uv 步骤。 | O=使用 astral-sh/setup-uv 提交 68559e99（v10.3.3）安装 uv，并按解析出的 Python 版本启用缓存。
  + [happy] HP-3: C=CI 执行后端环境安装流程。 | A=运行 setup-backend 步骤。 | O=setup-uv 使用允许列表中的固定版本安装，流程可复现。
  + [happy] HP-4: C=CI 运行后端环境安装与许可证检查。 | A=执行 setup-backend 与 check_license.sh。 | O=setup-uv 使用允许列表版本，RAT jar 下载失败时自动重试。

## [NEW 功能/not_in_gt] MCP 语义表字段重选 [mcp 语义表字段重选]
summary: update_chart 支持对语义表图表进行完整字段重选，需按目标视图成员 ID 提供全部列并显式指定过滤器。
  + [edge] EC-1: C=语义视图提供方未声明 selection_identity_version。 | A=生成语义视图图表。 | O=不写入选择身份标记，不虚构版本。
  + [edge] EC-2: C=重选时未显式提供过滤器。 | A=调用 update_chart 重选字段。 | O=请求被拒绝并提示需显式指定过滤器（空列表表示清除）。
  + [edge] EC-3: C=语义视图提供方未声明选择标识版本 | A=新建语义视图图表 | O=不写入语义选择标记
  + [edge] EC-4: C=语义层提供方未声明选择身份版本 | A=生成语义视图图表 | O=不写入虚构的选择身份标记
  + [error] ER-1: C=保留的语义选择无法验证。 | A=调用 update_chart。 | O=拒绝更新并提示通过 Explore 恢复。
  + [error] ER-2: C=更新请求保留未验证的语义选择 | A=调用 update_chart | O=请求被拒绝并提示在 Explore 中恢复
  + [error] ER-3: C=更新语义表图表时保留未验证的旧选择 | A=调用 update_chart | O=请求被拒绝并提示在 Explore 中恢复
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表字段选择被完整重建并保存。
  + [happy] HP-2: C=generate_chart 或 generate_explore_link 新建语义视图图表。 | A=提交语义视图配置。 | O=新选择的成员被打上选择身份标记，保留的旧选择不被标记。
  + [happy] HP-3: C=通过 generate_chart 或 generate_explore_link 新建语义视图图表 | A=提交语义视图配置 | O=新选择的成员被打上语义选择标记
  + [happy] HP-4: C=语义表图表的语义选择标记缺失或过期 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器 | O=图表更新成功，选择标记被重新写入
  + [happy] HP-5: C=通过 generate_chart 新建语义视图图表 | A=提交图表配置 | O=新选择的成员被打上选择身份标记

## [NEW 功能/not_in_gt] MCP 语义表完整重选 [mcp 语义表完整重选]
summary: 通过 MCP 更新语义表图表时，对缺失或过期的语义选择标记要求完整重选全部列并显式给出过滤器。
  + [edge] EC-1: C=语义选择标记过期但用户只提供部分列。 | A=调用 update_chart。 | O=拒绝更新并提示需重选全部列。
  + [edge] EC-2: C=用户希望清空可选时间粒度过滤器。 | A=传入空列表。 | O=过滤器被清空；必填过滤器不可清空。
  + [edge] EC-3: C=语义视图的 selection_identity_version 不是字符串。 | A=调用 stamp_new_semantic_selections。 | O=form_data 不写入 semantic_selection_version，后续校验按无版本处理。
  + [edge] EC-4: C=合并后没有任何语义选择来源。 | A=调用 merge_extra_form_data。 | O=结果中不出现 semantic_selection_sources 键。
  + [edge] EC-5: C=模型 extra_form_data 含 filters 等成员键但未提供 semantic_selection_sources，而作用域或其他输入已带来源记录。 | A=调用 update_chart 工具提交更新请求。 | O=该输入的成员被追加未版本化来源记录（datasource 为空、version 为 None），不会被后续版本化输入认证。
  + [error] ER-1: C=保留的语义选择无法验证。 | A=调用 update_chart。 | O=拒绝更新并提示在 Explore 中恢复。
  + [error] ER-2: C=更新过时语义表图表时保留了未经验证的旧选择。 | A=调用 UpdateChartRequest 更新图表配置。 | O=请求被拒绝并返回 Explore 恢复指引，要求重新选择所有列并显式指定过滤器。
  + [error] ER-3: C=MCP 客户端更新图表时提交的语义表重选无法被证明有效（存在休眠表粒度或重选不成立）。 | A=调用 update_chart 工具提交更新请求。 | O=更新被拒绝并返回语义重选校验错误，图表保持不变。
  + [happy] HP-1: C=用户通过 MCP 更新一个语义选择标记缺失的表类图表。 | A=提供目标视图全部成员列并显式给出过滤器后调用 update_chart。 | O=图表字段被完整重选并更新成功。
  + [happy] HP-10: C=用户在 MCP 语义层中重新选择语义表。 | A=执行完整重选操作。 | O=所选表集合被完整替换并保存。
  + [happy] HP-2: C=用户通过 MCP 生成新的语义视图图表。 | A=调用 generate_chart。 | O=新选择被打上语义选择身份标记。
  + [happy] HP-3: C=MCP 客户端对语义表发起重选请求。 | A=执行完整语义表重选。 | O=语义表按请求完成完整重选。
  + [happy] HP-4: C=用户在 MCP 语义表配置中需要更换已选表。 | A=执行完整重选操作。 | O=语义表选择被完整替换为新的选择结果。
  + [happy] HP-5: C=用户在 MCP 中配置语义表字段。 | A=用户执行语义表完整重选。 | O=系统支持重新选择完整的语义表集合，并据此更新配置。
  + [happy] HP-6: C=用户通过 MCP 基于语义视图生成图表，语义视图带有选择身份版本。 | A=调用 generate_chart 并指定语义视图目标。 | O=form_data 被写入 semantic_selection_version 后再进行语义视图校验，校验通过则正常生成图表。
  + [happy] HP-7: C=缓存与请求级 extra_form_data 均包含语义选择来源。 | A=调用 merge_extra_form_data 合并两者。 | O=合并结果保留合并后的 semantic_selection_sources 列表。
  + [happy] HP-8: C=MCP 客户端更新图表并提交带 semantic_selection_sources 的 extra_form_data，且仪表盘作用域生效。 | A=调用 update_chart 工具提交更新请求。 | O=仪表盘作用域与模型来源记录被合并保留，图表更新成功并返回包含来源信息的响应。
  + [happy] HP-9: C=MCP 客户端为语义视图生成 Explore 链接。 | A=调用 generate_explore_link 工具。 | O=form_data 在设置 datasource 后被标记语义选择来源，校验通过并返回 Explore 链接。

## [NEW 功能/not_in_gt] MCP 语义表重选 [mcp 语义表重选]
summary: MCP 图表更新工具支持对表类语义图表进行完整字段重选，要求显式提供全部列与过滤器，并拒绝未经验证的保留选择。
  + [edge] EC-1: C=语义提供方未声明选择身份版本 | A=生成图表 | O=不写入虚构的选择身份标记
  + [edge] EC-2: C=语义视图提供方未声明 selection_identity_version。 | A=通过 MCP 生成图表。 | O=不写入语义选择版本标记，不虚构身份标识。
  + [edge] EC-3: C=更新请求未提供 columns 或 filters。 | A=通过 MCP update_chart 更新语义表图表。 | O=返回不完整类别提示，要求完整重选。
  + [error] ER-1: C=更新图表时保留未验证的旧语义选择 | A=调用 update_chart | O=拒绝更新并提示需在 Explore 中恢复
  + [error] ER-2: C=保留的查询状态包含未经验证的过滤器、排序或时间选择。 | A=通过 MCP update_chart 更新语义表图表。 | O=拒绝更新并提示通过 Explore 恢复界面完成重选。
  + [happy] HP-1: C=表类图表的语义选择标记缺失或过期 | A=通过 update_chart 提供目标视图全部成员列与显式过滤器 | O=图表更新成功并写入新的语义选择标记
  + [happy] HP-2: C=生成新图表时选择语义视图成员 | A=调用 generate_chart | O=新选择被标记为当前选择身份，不继承已保存图表的旧选择
  + [happy] HP-3: C=用户通过 MCP update_chart 更新一个语义选择标记缺失或过期的表类图表。 | A=按目标视图成员 ID 提供全部列并显式给出过滤器（[] 表示清除）。 | O=图表完成完整字段重选并保存。
  + [happy] HP-4: C=用户通过 MCP generate_chart 在语义视图上创建图表。 | A=提交图表配置。 | O=新选择的成员被打上语义选择版本标记，不继承已保存图表的旧选择。

## [NEW 功能/not_in_gt] 最近归档列表 [最近归档列表]
summary: 集中展示已软删除的图表、仪表盘与数据集，支持按类型切换、搜索、恢复与永久删除。
  + [edge] EC-1: C=用户只有读权限 | A=查看已归档条目 | O=不显示恢复与永久删除操作，悬停提示需先恢复才能打开
  + [edge] EC-2: C=用户切换归档类型 | A=在 Type 选择器切换类型 | O=清除上一类型的排序与分页参数，按新类型重新请求
  + [error] ER-1: C=恢复请求返回 404（条目已被他人恢复） | A=点击 Recover | O=显示失败提示，页面不崩溃，条目保留
  + [happy] HP-1: C=用户打开最近归档页面 | A=浏览已归档条目 | O=列表显示名称、类型、归档时间与归档人
  + [happy] HP-2: C=用户对已归档图表点击恢复 | A=点击 Recover | O=调用对应类型 restore 接口，成功后刷新列表并显示带链接的成功提示
  + [happy] HP-3: C=用户对已归档数据集点击永久删除 | A=在确认弹窗输入 DELETE 并提交 | O=先获取 purge-impact，再携带 impact_token 调用 purge 接口
  + [happy] HP-4: C=用户在最近归档列表中查看某一类型的归档对象。 | A=用户通过类型选择器切换到另一归档对象类型。 | O=URL 以 push 方式更新为新类型并清除 sortColumn、sortOrder、pageIndex，列表按新类型默认排序与分页展示，浏览器后退可回到上一类型视图。

## [NEW 功能/not_in_gt] 列表排序与历史状态 [列表排序与历史状态]
summary: 列表视图的排序、分页与筛选状态与 URL 历史同步，受控排序可被清空。
  + [edge] EC-1: C=用户使用浏览器后退/前进在列表历史间切换 | A=触发历史导航 | O=排序、页码与搜索条件作为同一 URL 状态恢复
  + [error] ER-1: C=筛选配置引用了不存在的列 | A=渲染列表视图 | O=抛出 ListViewError 提示无效筛选配置
  + [happy] HP-1: C=用户在列表页点击列头排序 | A=切换排序方向 | O=表头排序标记与请求参数同步更新
  + [happy] HP-2: C=受控排序从有值恢复为空排序 | A=重新渲染表格 | O=表头不再显示排序标记

## [NEW 功能/not_in_gt] 列表排序状态 [列表排序状态]
summary: 列表视图支持受控排序，浏览器前进后退时排序、页码与搜索作为同一 URL 状态恢复。
  + [edge] EC-1: C=卡片排序选择器在排序状态变化后重新渲染。 | A=切换排序。 | O=选择器以当前排序为 key 重新挂载并显示正确选项。
  + [edge] EC-2: C=调用方未传入 sortBy 属性。 | A=组件渲染表格。 | O=sortBy 为 undefined，表格按无受控排序状态渲染，行为与新增属性前一致。
  + [edge] EC-3: C=表格视图渲染列且外部传入 sortBy 排序规则。 | A=mapColumns 接收 sortBy 参数并匹配列 id。 | O=匹配列显示对应的升序/降序排序指示。
  + [happy] HP-1: C=用户在列表页修改排序、页码与搜索。 | A=使用浏览器后退再前进。 | O=排序、页码与搜索一并恢复，控件与结果保持同步。
  + [happy] HP-2: C=受控排序被外部重置为空排序。 | A=重新渲染表格。 | O=表头排序指示被清除。
  + [happy] HP-3: C=调用方渲染 TableCollection 并传入 sortBy 排序规则数组。 | A=组件渲染表格列头。 | O=列头按传入的 sortBy 显示排序状态，sortBy 变化时列映射重新计算。
  + [happy] HP-4: C=用户在列表视图中通过 URL 或历史状态恢复页面，且保存的排序与当前排序不同。 | A=页面加载并恢复查询状态。 | O=列表排序被还原为初始排序状态。
  + [happy] HP-5: C=卡片视图下用户更改排序。 | A=排序状态 sortBy 发生变化。 | O=卡片排序选择器以新排序状态重新渲染并显示当前排序。

## [NEW 功能/not_in_gt] 图表与仪表盘卡片权限提示 [图表与仪表盘卡片权限提示]
summary: 仪表盘卡片菜单在无编辑权限时通过 Tooltip 提示需要仪表盘编辑者权限，归档/删除文案随 SoftDelete 开关变化。
  + [edge] EC-1: C=软删除功能关闭 | A=非编辑者查看图表卡片删除菜单项 | O=提示文案使用 delete 而非 archive
  + [edge] EC-2: C=用户对某图表无编辑权限。 | A=用户悬停或聚焦图表卡片的编辑菜单项。 | O=显示提示：需要成为图表编辑者才能编辑，并建议联系图表编辑者申请权限。
  + [edge] EC-3: C=用户拥有仪表盘编辑权限 | A=悬停编辑或删除菜单项 | O=不显示权限提示 Tooltip（提示变量为 null）
  + [happy] HP-1: C=非编辑者用户使用键盘聚焦图表卡片菜单按钮 | A=按 Tab 聚焦菜单按钮 | O=显示编辑与归档（或删除）权限提示，菜单不自动打开
  + [happy] HP-2: C=非编辑者用户打开仪表盘卡片菜单 | A=悬停编辑或删除菜单项 | O=菜单项禁用并显示“You must be a dashboard editor in order to edit/archive/delete.”
  + [happy] HP-3: C=用户对某图表无编辑权限，且软删除特性开启。 | A=用户悬停或聚焦图表卡片的删除/归档菜单项。 | O=显示提示：需要成为图表编辑者才能归档。
  + [happy] HP-4: C=无仪表盘编辑权限的用户打开仪表盘卡片菜单 | A=悬停编辑菜单项 | O=显示提示：需要成为仪表盘编辑者才能编辑，请联系仪表盘编辑者申请修改或编辑权限
  + [happy] HP-5: C=SoftDelete 特性开启且用户无仪表盘编辑权限 | A=悬停删除菜单项 | O=显示提示：需要成为仪表盘编辑者才能归档，请联系仪表盘编辑者申请修改或编辑权限

## [NEW 功能/not_in_gt] 图表与仪表盘卡片键盘可达性 [图表与仪表盘卡片键盘可达性]
summary: 图表与仪表盘卡片的 More Options 按钮通过 Tooltip 暴露编辑与归档权限提示，键盘用户可先读到提示再打开菜单。
  + [edge] EC-1: C=软删除功能开启或关闭。 | A=用键盘访问卡片 More Options。 | O=两种模式下权限提示均可通过键盘到达。
  + [happy] HP-1: C=无编辑权限的用户在图表列表使用键盘。 | A=Tab 到 More Options 按钮。 | O=先读到编辑权限提示，再可打开菜单。
  + [happy] HP-2: C=无编辑权限的用户在仪表盘列表使用键盘。 | A=Tab 到 More Options 按钮。 | O=先读到编辑或归档权限提示，操作本身保持禁用。
  + [happy] HP-3: C=调用方为 KebabMenuButton 传入 tooltipTitle。 | A=用户悬停或聚焦更多操作按钮。 | O=显示传入的提示文案。

## [NEW 功能/not_in_gt] 版本历史恢复 [版本历史恢复]
summary: 在恢复仪表盘版本前统计并提示将被移除的当前成员图表，恢复操作本身不删除图表。
  + [edge] EC-1: C=当前成员图表数量统计包含已归档与未放置的成员。 | A=打开恢复确认弹窗。 | O=计数包含这些成员，反映检查时的成员关系。
  + [edge] EC-2: C=恢复影响统计请求失败。 | A=打开恢复确认弹窗。 | O=弹窗提示移除数量未知，仍可继续恢复。
  + [edge] EC-3: C=仪表盘成员包含已归档或未放置的图表 | A=计算恢复移除数量 | O=计数包含这些成员，与恢复时的关联窗口一致
  + [edge] EC-4: C=当前没有将被移除的图表成员 | A=打开恢复确认弹窗 | O=不显示移除警告，恢复按钮可用
  + [edge] EC-5: C=成员计数请求尚未返回 | A=查看恢复确认弹窗 | O=显示“Checking which charts will be removed…”，恢复按钮禁用
  + [edge] EC-6: C=所选版本包含当前全部成员图表 | A=打开恢复确认对话框 | O=不显示移除警告
  + [error] ER-1: C=恢复过程中某图表被永久删除。 | A=确认恢复。 | O=恢复不改变任何内容并提示重试，重试时不再包含该图表。
  + [error] ER-2: C=获取恢复影响计数请求失败 | A=打开恢复确认对话框 | O=对话框仍可展示，不阻塞恢复操作
  + [error] ER-3: C=成员计数请求失败或超时 | A=查看恢复确认弹窗 | O=显示“Could not check which charts will be removed. Restoring may remove charts added after t
  + [error] ER-4: C=恢复影响计数请求失败 | A=打开恢复确认对话框 | O=对话框仍可打开，不阻塞恢复流程
  + [happy] HP-1: C=用户选择恢复某个仪表盘历史版本，当前仪表盘有不在该版本中的成员图表。 | A=打开恢复确认弹窗。 | O=弹窗显示将被移除的图表数量，并说明图表本身不会被删除。
  + [happy] HP-2: C=用户确认恢复仪表盘版本。 | A=点击恢复。 | O=仪表盘回到所选版本，不属于该版本的图表从仪表盘移除但保留图表实体。
  + [happy] HP-3: C=用户选择某个仪表盘历史版本并点击恢复 | A=打开恢复确认对话框 | O=对话框显示当前成员中不属于该版本的图表数量并警告恢复将移除这些图表
  + [happy] HP-4: C=恢复影响计数为 0 | A=打开恢复确认对话框 | O=不显示图表移除警告
  + [happy] HP-5: C=用户打开仪表盘版本的恢复确认弹窗，当前有 2 个图表不属于该版本 | A=查看弹窗 | O=显示“Restoring will remove 2 charts added after this version from this dashboard. The charts
  + [happy] HP-6: C=用户打开图表版本的恢复确认弹窗 | A=查看弹窗 | O=不请求仪表盘成员计数，也不显示移除警告
  + [happy] HP-7: C=用户选择恢复仪表盘的历史版本 | A=打开恢复确认对话框 | O=对话框显示当前成员中不属于该版本的图表数量，并警告恢复会移除这些图表但不删除图表本身
  + [happy] HP-8: C=用户在版本历史中打开某个版本的恢复确认弹窗。 | A=用户切换恢复目标版本或切换实体后再次打开恢复确认弹窗。 | O=弹窗以新的 key 重新挂载，展示当前目标版本与实体的确认内容，不残留旧目标状态。

## [NEW 功能/not_in_gt] 版本历史恢复确认 [版本历史恢复确认]
summary: 仪表盘版本恢复前统计并提示将被移除的当前成员图表数量，恢复本身不删除图表。
  + [edge] EC-1: C=恢复影响计数包含已归档或未放置的成员图表。 | A=打开恢复确认对话框。 | O=计数包含这些成员，与恢复实际会解除的关联一致。
  + [edge] EC-2: C=用户打开对话框后另一用户修改了仪表盘成员。 | A=确认恢复。 | O=计数为打开时的建议值，可能与最终恢复结果不同。
  + [error] ER-1: C=恢复影响计数请求失败。 | A=打开恢复确认对话框。 | O=对话框仍可打开，不阻塞恢复流程。
  + [happy] HP-1: C=用户选择恢复某个仪表盘历史版本，当前仪表盘有不在该版本中的成员图表。 | A=打开恢复确认对话框。 | O=对话框显示将被移除的图表数量并警告恢复会将其从仪表盘移除。
  + [happy] HP-2: C=当前仪表盘成员与目标版本一致。 | A=打开恢复确认对话框。 | O=不显示移除图表警告。

## [NEW 功能/not_in_gt] 版本历史恢复警告 [版本历史恢复警告]
summary: 仪表盘版本恢复前统计并警告将被移除的当前成员图表，不删除图表本身。
  + [edge] EC-1: C=当前成员图表全部属于所选版本。 | A=打开恢复确认弹窗。 | O=不显示移除警告。
  + [edge] EC-2: C=统计包含已归档或未放置的成员图表。 | A=打开恢复确认弹窗。 | O=计数包含这些成员，反映弹窗检查时的成员关系。
  + [edge] EC-3: C=恢复影响接口响应超过 10000 毫秒 | A=打开恢复确认弹窗触发计数查询 | O=请求因超时失败，计数不可用
  + [error] ER-1: C=恢复影响接口返回的 removed_chart_count 缺失或不是非负整数 | A=打开恢复确认弹窗触发计数查询 | O=查询抛出「Invalid restore impact response」错误，计数不可用
  + [happy] HP-1: C=用户选择恢复仪表盘的某个历史版本。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并警告恢复会将其从仪表盘移除。
  + [happy] HP-2: C=用户从版本历史恢复一个仪表盘版本，该恢复会移除当前仪表盘中的图表。 | A=触发版本历史恢复。 | O=恢复前向用户显示将移除仪表盘图表的警告。
  + [happy] HP-3: C=用户在版本历史恢复流程中，恢复操作将移除仪表盘中的图表。 | A=确认恢复前继续操作。 | O=系统在移除图表前显示警告提示。
  + [happy] HP-4: C=用户在版本历史中恢复仪表盘版本 | A=打开恢复确认弹窗 | O=弹窗先请求 include_restore_impact=true 的版本接口，并展示该恢复将移除的图表数量

## [NEW 功能/not_in_gt] 软删除归档提示 [软删除归档提示]
summary: 归档成功通知携带指向 Recently Archived 的恢复链接，链接遵循部署 URL 前缀，含链接的通知保持打开直至手动关闭。
  + [edge] EC-1: C=含 HTML 链接的通知被悬停或键盘聚焦。 | A=等待自动关闭计时。 | O=通知保持打开，直到用户手动关闭或激活链接。
  + [edge] EC-2: C=用户使用浏览器前进后退在 Recently Archived 页面切换类型。 | A=点击后退或前进。 | O=所选类型、页码、排序与搜索从 URL 恢复。
  + [edge] EC-3: C=提示文本包含 HTML 链接 | A=等待超过提示时长 | O=提示保持显示直到用户显式关闭
  + [edge] EC-4: C=数据集被 2 个图表和 1 个仪表盘引用。 | A=查看归档影响提示。 | O=提示为“linked to 2 charts and 1 dashboard”。
  + [edge] EC-5: C=用户恢复一个历史版本，该版本将移除当前仪表盘中的部分图表。 | A=确认恢复历史版本。 | O=恢复前提示将被移除的仪表盘图表。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=完成归档。 | O=成功通知包含指向对应对象类型的恢复链接。
  + [happy] HP-10: C=用户归档一个图表或仪表盘。 | A=执行归档操作。 | O=显示归档 toast 并更新归档计数。
  + [happy] HP-2: C=部署配置了 URL 前缀。 | A=点击归档通知中的恢复链接。 | O=链接带上部署前缀并正确跳转到 Recently Archived。
  + [happy] HP-3: C=用户归档图表或仪表盘成功 | A=查看成功提示 | O=提示包含指向 Recently Archived 的链接，且不会自动消失
  + [happy] HP-4: C=部署配置了 URL 前缀 | A=点击恢复提示中的链接 | O=链接使用带部署前缀的地址跳转
  + [happy] HP-5: C=用户归档一个图表或仪表盘。 | A=查看成功提示。 | O=提示包含指向 Recently Archived 的恢复链接，链接带部署 URL 前缀。
  + [happy] HP-6: C=用户收到含 HTML 链接的归档通知。 | A=悬停或键盘聚焦该通知。 | O=通知保持打开，直到用户显式关闭。
  + [happy] HP-7: C=用户对资产执行软删除归档操作。 | A=确认归档。 | O=显示归档提示 toast，归档计数与历史记录正确更新，键盘操作可完成归档流程。
  + [happy] HP-8: C=软删除功能关闭时，用户删除一个被图表和仪表盘引用的数据集。 | A=用户打开数据集删除确认弹窗。 | O=弹窗显示“is linked to %s charts and %s dashboards. Are you sure you want to continue? Deleting
  + [happy] HP-9: C=应用部署在非根路径下，用户成功恢复一个归档对象。 | A=用户查看恢复成功 toast 并点击“View <type> →”链接。 | O=链接 href 包含应用根路径，可正确跳转到恢复对象的详情页。

## [NEW 功能/not_in_gt] 软删除归档通知 [软删除归档通知]
summary: 归档与恢复操作的通知保持可交互，恢复链接遵循部署前缀。
  + [edge] EC-1: C=通知文本包含 HTML 链接 | A=等待通知自动关闭时长 | O=通知不自动关闭，直到用户主动关闭
  + [edge] EC-2: C=系统展示一条无操作按钮、无链接且 duration 大于 0 的普通提示消息。 | A=提示消息出现后等待 duration 时长。 | O=提示消息按原有时长自动关闭。
  + [happy] HP-1: C=用户归档一个图表或仪表盘 | A=查看成功通知 | O=通知包含指向最近归档页的恢复链接，并保持打开直到用户关闭
  + [happy] HP-2: C=部署配置了 URL 前缀 | A=点击归档通知中的恢复链接 | O=链接包含部署 URL 前缀
  + [happy] HP-3: C=系统展示一条 allowHtml 为真且文本包含 <a 链接的提示消息。 | A=提示消息出现后等待超过 duration 时长。 | O=提示消息不会自动关闭，保持可见直到用户手动关闭。
