
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
  + EC-1 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应与原有版本详情一致。
  + EC-2 [edge] C=调用方未传 include_restore_impact 或传 false | A=GET 仪表盘版本详情 | O=不计算恢复影响，响应保持原有结构
  + EC-3 [edge] C=调用方未传 include_restore_impact 或为 false。 | A=GET 仪表盘版本详情。 | O=响应不包含 _restore_impact 字段。
  + EC-4 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算恢复影响，行为与之前一致。
  + EC-5 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应不含移除数量。
  + ER-1 [error] C=调用方请求不存在的版本 UUID。 | A=GET 仪表盘版本详情。 | O=返回 404。
  + HP-2 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的当前成员图表数量。
  + HP-3 [happy] C=调用方请求仪表盘版本详情并需要恢复影响 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/?include_restore_impact=true | O=响应附带恢复将移除的当前成员图表数量
  + HP-4 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应 result 中 _restore_impact.removed_chart_count 返回当前成员中不属于该版本的图表数量。
  + HP-5 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的图表数量。

## [CHANGED/affected] SQL 编辑器 [sql 编辑器]
  逐字相同场景: ER-1, HP-1, HP-2
  + EC-1 [edge] C=SQL 中未加引号的名称与 CTE 同名，引擎为 PostgreSQL、Oracle 或 Snowflake。 | A=解析 SQL 提取表。 | O=按引擎折叠规则识别为 CTE 引用，不误报为物理表。
  + EC-2 [edge] C=Snowflake 查询使用两段式名称 db..table。 | A=解析表引用。 | O=解析为 PUBLIC schema 下的表。
  + EC-3 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表在默认 schema 或搜索路径中被 RLS 或黑名单覆盖 | A=执行查询 | O=按引擎标识符折叠规则匹配并应用 RLS 谓词或拒绝禁用表
  + EC-4 [edge] C=查询的数据库无对应 DB-API 驱动或 SQLAlchemy 方言 | A=执行查询 | O=无法连接该数据源
  + EC-5 [edge] C=未限定 schema 的表名在 PostgreSQL、Oracle、Snowflake 上大小写与 CTE 名称冲突。 | A=解析 SQL 提取表。 | O=未加引号名称按 ASCII 大小写折叠后识别为 CTE 引用，不误报为物理表。
  + EC-6 [edge] C=SQL Lab 查询引用未写 schema 的非限定表，且该表在数据库 search path 中命中 RLS 或表黑名单。 | A=执行查询或估算查询。 | O=RLS 谓词被注入或表被黑名单拦截，不再因缺少 schema 而绕过。
  + EC-7 [edge] C=SQL 中 CTE 名称与物理表名仅大小写不同，引擎为 PostgreSQL、Oracle 或 Snowflake。 | A=解析 SQL 提取表引用。 | O=未加引号的 ASCII 名称按引擎规则折叠，CTE 引用不被误报为物理表。
  + EC-8 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表在拒绝列表中 | A=执行查询 | O=查询被拒绝列表拦截
  + ER-2 [error] C=成本估算的 SQL 引用被禁用表或禁用函数。 | A=触发成本估算。 | O=返回禁用表或禁用函数错误，不执行估算。
  + HP-3 [happy] C=SQL Lab 查询引用未写 schema 的非限定表，且该表存在 RLS 规则。 | A=执行查询。 | O=RLS 谓词被注入到该表读取上。
  + HP-4 [happy] C=SQL Lab 查询引用未限定 schema 的表，且该表在默认 schema 或搜索路径中命中 RLS 或表黑名单。 | A=执行查询。 | O=RLS 谓词被注入或表被黑名单拦截。
  + HP-5 [happy] C=用户在 SQL Lab 对查询做成本估算，查询引用无 schema 的非限定表。 | A=触发成本估算。 | O=按连接搜索路径解析表所属 schema，应用 RLS 与表拒绝名单后返回估算。

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
    C v49: 恢复影响计数请求失败或返回 0。
    A v48: 保存仪表盘布局
    A v49: 打开恢复确认弹窗。
    O v48: 该图表保存为缺失图表占位，布局其余部分正常保存
    O v49: 计数为 0 时不显示移除警告；请求失败时弹窗仍可继续恢复流程。
  + ER-1 [error] C=访客令牌用户名与普通用户名相同。 | A=判定当前用户是否为访客。 | O=不依据用户名判定，按令牌定义识别为访客。
  + ER-2 [error] C=嵌入式访客令牌携带空用户名 | A=访客请求仪表盘或缩略图 | O=仍被识别为访客并按访客身份应用行级规则，不因用户名为空而误判
  + HP-3 [happy] C=嵌入访客令牌携带空用户名。 | A=访客请求仪表盘缩略图。 | O=访客被识别为嵌入访客，缩略图摘要按访客自身键隔离。
  + HP-4 [happy] C=非编辑者用户在仪表盘卡片上使用键盘导航。 | A=Tab 到卡片菜单按钮。 | O=先显示编辑与归档/删除权限提示，菜单不自动打开。
  + HP-5 [happy] C=用户打开仪表盘版本恢复确认弹窗。 | A=选择某个历史版本并查看确认文案。 | O=弹窗显示当前成员中不属于该版本、恢复后将被移除的图表数量，并说明图表本身不会被删除。
  + HP-6 [happy] C=用户在版本历史中恢复仪表盘旧版本。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中将被移除的图表数量并提示图表本身不被删除。
  - 移除场景: EC-4

## [KEPT/unaffected] 仪表盘布局保存 [仪表盘布局保存]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7, HP-8, HP-9

## [KEPT/unaffected] 前端插件构建 [前端插件构建]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7

## [CHANGED/affected] 发布流程工具 [发布流程工具]
  逐字相同场景: EC-1, HP-1, HP-2
  ~ ER-1(rewritten):
    C v48: GitHub 凭据无效
    C v49: RAT jar 下载在重试后仍失败。
    A v48: 生成变更日志
    A v49: 运行 check_license.sh。
    O v48: 提示凭据错误并退出
    O v49: curl 以非零状态退出，脚本不把不完整文件当作 jar。
  ~ HP-3(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ar/** 下的文件。
    C v49: 提交的 PR 修改了 superset/translations/pl/** 下的文件。
    O v48: PR 被自动添加 i18n:arabic 标签。
    O v49: PR 被自动添加 i18n:polish 标签。
  ~ HP-4(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ca/** 下的文件。
    C v49: CI 运行 check_license.sh 下载 RAT jar。
    A v48: 触发 labeler 工作流。
    A v49: 执行许可证检查脚本。
    O v48: PR 被自动添加 i18n:catalan 标签。
    O v49: curl 以失败重试方式下载 jar，下载成功后继续检查。
  ~ HP-5(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ar/** 的 PR。
    C v49: 许可证检查脚本首次下载 RAT jar 失败。
    A v48: 触发 labeler 工作流。
    A v49: 重新执行 check_license.sh。
    O v48: PR 被自动打上 i18n:arabic 标签。
    O v49: curl 以 --retry 5 --retry-all-errors 重试下载，成功后继续检查。
  ~ HP-6(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ca/** 的 PR。
    C v49: 贡献者提交涉及波兰语翻译的 PR。
    A v48: 触发 labeler 工作流。
    A v49: 触发自动标签流程。
    O v48: PR 被自动打上 i18n:catalan 标签。
    O v49: PR 被正确打上波兰语相关标签。
  + EC-2 [edge] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --fail --retry 5 重试下载，失败时输出错误信息而非静默写入空文件。
  + ER-2 [error] C=下载 RAT jar 时网络请求失败 | A=运行 check_license.sh | O=curl/wget 按重试参数重试，仍失败则清理临时文件并提示手动安装
  + ER-3 [error] C=GitHub 凭据无效 | A=生成变更日志 | O=提示凭据错误并退出
  + ER-4 [error] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，成功后继续许可证检查。

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
    v49: XY 图表时间列判定与 form_data 重建逻辑。
  ~ EC-1(rewritten):
    C v48: 需要展示地理空间数据
    C v49: XY 图表插件在获得权威时间列类型后需要重建 form_data。
    A v48: 选择地理空间可视化类型
    A v49: 调用 apply_temporal_columns。
    O v48: 渲染地理空间图表
    O v49: form_data 被清空并由 map_xy_config(config, temporal_columns=temporal_columns) 的结果整体更新。
  ~ HP-1(rewritten):
    C v48: 分析师连接数据源后进入图表构建界面
    C v49: MCP 生成 XY 图表且已知数据集时间列集合。
    A v48: 通过无代码界面选择维度与指标
    A v49: 调用 map_xy_config 并传入 temporal_columns。
    O v48: 生成并展示所选可视化图表
    O v49: x 轴列是否真正为时间列依据权威时间列集合判定，进而决定时间轴配置与排序/警告。

## [CHANGED/unaffected] 安全依赖管理 [安全依赖管理]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2
  ~ HP-3(rewritten):
    C v48: 安装 Superset 依赖。
    C v49: 安装 MCP 相关依赖。
    A v48: 解析并安装 pyarrow。
    A v49: 解析 fastmcp 版本。
    O v48: 安装的 pyarrow 版本不低于修复版本，不含 CVE-2026-111497。
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  ~ HP-4(rewritten):
    C v48: 在干净环境中安装 Superset 依赖。
    C v49: 安装 Superset 的 fastmcp 可选依赖
    A v48: 解析 pyarrow 依赖约束。
    A v49: 解析 fastmcp 版本
    O v48: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
    O v49: 解析到 4.1.4 及以上、5.0 以下版本
  ~ HP-5(rewritten):
    C v48: 安装项目依赖
    C v49: 安装 Superset 的 fastmcp 可选依赖。
    A v48: 解析 pyarrow 版本
    A v49: 解析 fastmcp 版本。
    O v48: 不再解析到含 CVE-2026-111497 的 pyarrow 版本
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  + EC-2 [edge] C=环境中已存在低于 4.1.4 的 fastmcp。 | A=安装 fastmcp 扩展依赖。 | O=依赖解析要求升级到 4.1.4 及以上版本。
  + HP-6 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 4.1.4 及以上、5.0 以下版本。
  + HP-7 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 fastmcp>=4.1.4,<5.0 范围内的版本。
  + HP-8 [happy] C=用户安装 Superset 的 fastmcp 可选依赖组。 | A=执行依赖安装。 | O=解析并安装 fastmcp 4.1.4 及以上、5.0 以下的版本。
  + HP-9 [happy] C=开发者安装开发依赖。 | A=执行依赖安装。 | O=安装 fastmcp 4.1.4。

## [CHANGED/affected] 安全角色与认证 [安全角色与认证]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 启用 VIEWER_PROMISCUOUS_MODE
    C v49: SQL Lab 查询引用未写 schema 的非限定表，且该表在禁用表名单中。
    A v48: 查看者访问仪表盘
    A v49: 执行查询。
    O v48: 仅该仪表盘自身的图表与数据集请求被授权
    O v49: 查询被拒绝，非限定表名不再绕过黑名单。
  ~ EC-3(rewritten):
    C v48: 调用方不具备 promiscuous 仪表盘授权。
    C v49: 嵌入式访客令牌的用户名为空
    A v48: GET /api/v1/dashboard/{id_or_slug}。
    A v49: 判定当前用户是否为访客
    O v48: charts 仅包含调用方可访问的成员图表。
    O v49: 仅依据当前用户求值判定为访客，不读取用户名
  ~ HP-3(rewritten):
    C v48: 调用方对某仪表盘具有 promiscuous 仪表盘访问授权。
    C v49: 嵌入访客令牌携带空用户名。
    A v48: GET /api/v1/dashboard/{id_or_slug}，响应包含 charts 字段。
    A v49: 判定当前用户是否为访客。
    O v48: charts 返回该仪表盘全部成员图表，不再逐图表过滤。
    O v49: 按令牌定义识别为访客，不因用户名为空而误判。
  + EC-4 [edge] C=访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=仍按访客处理，不依赖用户名
  + HP-4 [happy] C=嵌入式访客令牌携带空用户名。 | A=调用 is_guest_user 判定当前用户。 | O=仍被识别为访客用户，不因用户名为空返回 False。
  + HP-5 [happy] C=嵌入式访客令牌携带空用户名。 | A=调用 is_guest_user 判断当前用户。 | O=仍被识别为访客用户，不依赖用户名取值。
  + HP-6 [happy] C=嵌入访客令牌携带空用户名。 | A=调用 is_guest_user 判定当前用户。 | O=仍被识别为访客用户，不因用户名为空而误判为普通用户。
  - 移除场景: ER-3

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
  + EC-1 [edge] C=嵌入访客令牌携带空用户名。 | A=访客请求图表缩略图。 | O=访客身份被正确识别，缩略图摘要按访客键隔离。
  + EC-2 [edge] C=连接开启模拟登录用户但无 OAuth2 客户端且无可用凭据 | A=嵌入式访客查询 | O=查询被拒绝，访客看到连接未为嵌入式仪表盘配置的提示，服务端日志记录连接与修复方法
  + EC-3 [edge] C=请求未携带 JWT 与 guest token，且处于鉴权前的错误处理路径。 | A=调用 is_guest_user。 | O=捕获 NoAuthorizationError 并返回 False，不再抛出未处理异常。
  + EC-4 [edge] C=THUMBNAIL_EXECUTORS 配置不含 CURRENT_USER，且执行器无法解析。 | A=生成缩略图摘要。 | O=返回 None，不生成摘要。
  + ER-1 [error] C=凭据只有用户名或只有密码/私钥，或用户名为纯空白 | A=保存连接 | O=校验失败，凭据被拒绝
  + HP-3 [happy] C=启用 EMBEDDED_SUPERSET 与 EMBEDDED_CREDENTIAL_FALLBACK，Snowflake 连接配置 OAuth2 客户端、开启模拟登录用户并保存嵌入式访客凭据 | A=嵌入式访客查询该连接上的图表 | O=查询以配置的专用数据库账号执行，结果使用独立缓存分区
  + HP-4 [happy] C=嵌入式仪表盘以访客身份访问，访客用户名取值为空或特殊值。 | A=加载嵌入式仪表盘。 | O=访客身份保持独立且稳定，不随 username 取值变化而改变或失效。
  + HP-5 [happy] C=嵌入式仪表盘以访客身份访问，用户名取值为任意值。 | A=加载嵌入式仪表盘。 | O=访客身份保持独立，不因用户名取值改变。
  + HP-6 [happy] C=嵌入式仪表盘请求携带 guest token，token 中用户名为空。 | A=调用 is_guest_user 判断当前用户是否为访客。 | O=返回 True，请求被识别为嵌入式访客。
  + HP-7 [happy] C=THUMBNAIL_EXECUTORS 配置包含 CURRENT_USER，当前用户为用户名无法解析的嵌入式访客。 | A=生成仪表盘或图表缩略图摘要。 | O=回退为以访客自身为执行器，访客的 RLS 规则计入摘要。

## [KEPT/unaffected] 嵌入式访客回退凭据 [嵌入式访客回退凭据]
  逐字相同场景: EC-1, ER-1, HP-1

## [KEPT/unaffected] 数据导入导出 [数据导入导出]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2

## [CHANGED/affected] 数据库连接配置 [数据库连接配置]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2, HP-4
  ~ EC-2(rewritten):
    C v48: 数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。
    C v49: Athena 连接既未填写 s3_staging_dir 也未填写 work_group。
    A v48: 构建该数据库引擎规范的 parameters_json_schema。
    A v49: 保存连接。
    O v48: 该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
    O v49: 连接参数不满足至少提供其一的要求。
  ~ HP-3(rewritten):
    C v48: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    C v49: 管理员配置 Athena 连接。
    A v48: 提交数据库连接配置。
    A v49: 在连接表单中填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query result location、Schema name 与 Work group。
    O v48: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
    O v49: 字段按 Athena 动态参数 schema 渲染，AWS 密钥以密码输入框呈现。
  ~ HP-5(rewritten):
    C v48: 用户在数据库连接弹窗中配置含私钥字段的连接
    C v49: 管理员配置 Athena 数据库连接
    A v48: 打开数据库连接配置弹窗并填写连接参数
    A v49: 在连接表单中填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query result location 与 Work group
    O v48: 私钥类字段被正确识别与处理，连接配置可正常保存
    O v49: 表单按 FormFieldOrder 渲染这些字段，AWS 密钥以密码输入框呈现并可保存
  ~ HP-6(rewritten):
    C v48: OAuth2 数据库连接需要携带客户端信息与嵌入式凭据
    C v49: 管理员为 Athena 连接填写 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、Schema 与 Work Group。
    A v48: 保存包含 oauth2_client_info 与 embedded_credentials 的连接参数
    A v49: 提交数据库连接配置。
    O v48: 连接参数类型接受这两个可选字段，配置可正常提交
    O v49: 这些参数随连接参数提交，AWS Secret Access Key 以密码输入框呈现。
  + EC-3 [edge] C=数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。 | A=构建该数据库引擎规范的 parameters_json_schema。 | O=该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
  + EC-4 [edge] C=Athena 连接未填写 S3 query results location。 | A=查看该字段。 | O=字段标注为可选（Work Group 已设置结果位置时），不强制必填。
  + EC-5 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group。 | A=保存或校验连接参数。 | O=返回缺少 s3_staging_dir、work_group 的警告。
  + EC-6 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group | A=保存连接 | O=校验提示至少需要其中一项
  + HP-7 [happy] C=管理员为 Amazon Athena 配置连接。 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录或 Work Group 并保存。 | O=表单字段被转换为 Athena SQLAlchemy URI 并保存。
  + HP-8 [happy] C=管理员编辑已有 Athena 连接。 | A=打开连接表单。 | O=URI 被解析回各表单字段，额外查询参数保留在 query 字段中。
  + HP-9 [happy] C=用户配置 Athena 连接 | A=在连接表单填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir 与 work group | O=表单按 Athena 动态参数 schema 渲染并保存这些字段

## [CHANGED/affected] 数据源连接 [数据源连接]
  逐字相同场景: EC-1, EC-2, ER-1, ER-2, HP-1, HP-2
  ~ HP-3(rewritten):
    C v48: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Athena 数据源。
    A v48: 提交创建数据库请求。
    A v49: 填写 AWS 凭据、区域与 work group 并保存。
    O v48: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
    O v49: 连接参数按 Athena 动态 schema 校验并保存。
  ~ HP-4(rewritten):
    C v48: 用户创建 OAuth2 数据源连接，连接测试通过但权限同步时创建管理员尚无 OAuth2 令牌。
    C v49: Athena 连接仅配置 work_group 而未配置 s3_staging_dir
    A v48: 提交创建数据库请求。
    A v49: 保存并测试连接
    O v48: 数据库创建成功，不再因缺少 OAuth2 令牌返回 422；权限在首次设置访问时同步。
    O v49: 连接可保存，查询结果位置由 work group 定义或使用托管查询结果
  ~ HP-5(rewritten):
    C v48: 管理员更新一个已存在的数据库连接。
    C v49: Athena 连接配置了 AWS 凭据、区域与 Work Group。
    A v48: 向数据库 PUT 接口提交请求体。
    A v49: 保存并测试连接。
    O v48: 请求体由 DatabasePutSchema(database_id=pk) 校验，合法时返回 200 与更新后的连接信息。
    O v49: 连接参数按动态表单 schema 提交，连接可正常建立。
  ~ HP-6(rewritten):
    C v48: 数据库引擎参数包含加密字段，前端获取参数 JSON Schema。
    C v49: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    A v48: 读取引擎参数的 OpenAPI 3 schema。
    A v49: 提交创建数据库请求。
    O v48: 加密字段带 x-encrypted-extra: true 标记，连接对话框据此渲染并将值放入 masked_encrypted_extra。
    O v49: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
  - 移除场景: EC-3, EC-4, EC-5, ER-3, ER-4, ER-5, ER-6, ER-7

## [CHANGED/unknown] 数据集列表管理 [数据集列表管理]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2, HP-3
  ~ HP-4(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 数据集被图表与仪表盘依赖。
    A v48: 打开导入弹窗并提交导入。
    A v49: 打开删除确认弹窗。
    O v48: 导入弹窗识别加密文件额外字段并正常处理导入。
    O v49: 文案分别列出关联的图表数与仪表盘数。
  ~ HP-5(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 数据集被 3 个图表和 2 个仪表盘引用。
    A v48: 执行导入。
    A v49: 打开数据集删除确认弹窗。
    O v48: 导入流程识别加密文件额外字段并继续处理。
    O v49: 提示文案为“is linked to 3 charts and 2 dashboards.”。
  + EC-2 [edge] C=用户使用浏览器前进/后退切换列表历史 | A=返回上一列表状态 | O=排序、页码与搜索过滤一并恢复，表头排序指示同步
  + HP-6 [happy] C=用户查看数据集删除确认弹窗，该数据集关联 3 个图表与 2 个仪表盘。 | A=打开删除确认。 | O=弹窗显示“is linked to 3 charts and 2 dashboards.”。
  + HP-7 [happy] C=用户删除被图表和仪表盘引用的数据集。 | A=打开删除确认弹窗。 | O=弹窗显示“is linked to N charts and M dashboards”的影响提示。

## [KEPT/affected] 缓存层 [缓存层]
  逐字相同场景: HP-1

## [KEPT/unaffected] 语义层 [语义层]
  逐字相同场景: EC-1, HP-1

## [KEPT/unaffected] 语义层提供方传输 [语义层提供方传输]
  逐字相同场景: HP-1

## [KEPT/unaffected] 语义视图创建结果解析 [语义视图创建结果解析]
  逐字相同场景: EC-1, ER-1, HP-1

## [CHANGED/unaffected] 语义视图批量删除 [语义视图批量删除]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2
  ~ EC-2(rewritten):
    C v48: 批量删除中有部分视图被依赖资产阻止
    C v49: 批量删除的所选视图中没有任何视图存在依赖。
    A v48: 确认删除
    A v49: 提交批量删除。
    O v48: 整批拒绝，对话框仅列出被阻止的视图及其可见依赖与不可见资产数量
    O v49: blocked_views 为空，blocked_view_ids 为空列表，删除流程按无依赖继续。
  ~ HP-3(rewritten):
    C v48: 用户批量删除无依赖的语义视图
    C v49: 批量删除多个语义视图，其中部分视图存在依赖资产。
    A v48: 确认删除
    A v49: 提交批量删除。
    O v48: 视图被删除
    O v49: 删除被拒绝，错误响应仅列出有依赖的视图及其 total、dependents、inaccessible_count、archived_count。
  ~ HP-4(rewritten):
    C v48: 用户批量删除若干语义视图且均无依赖
    C v49: 批量选择数据集与多个语义视图并确认删除
    A v48: 确认删除
    A v49: 提交删除
    O v48: 所有选中视图被删除
    O v49: 数据集被删除，被依赖阻止的语义视图在“Cannot delete semantic views”对话框中按视图分别列出其依赖资产
  - 移除场景: EC-3, EC-4, EC-5, EC-6, ER-3, HP-5, HP-6, HP-7, HP-8

## [KEPT/unaffected] 语义视图批量添加 [语义视图批量添加]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1

## [KEPT/unaffected] 资产导入导出 [资产导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2

## [NEW 功能/not_in_gt] Amazon Athena 连接表单 [amazon athena 连接表单]
summary: Athena 引擎提供动态连接表单参数 schema，逐字段配置 AWS 凭据、区域、S3 暂存目录、Schema 与 Work Group，并与 SQLAlchemy URI 双向转换。
  + [edge] EC-1: C=Athena 连接既未填 s3_staging_dir 也未填 work_group。 | A=保存或校验连接参数。 | O=返回缺少 s3_staging_dir、work_group 的警告。
  + [edge] EC-2: C=Athena 连接未填 region_name。 | A=保存或校验连接参数。 | O=返回缺少 region_name 的警告。
  + [edge] EC-3: C=用户编辑已有 Athena 连接，其 URI 含 catalog_name、role_arn、endpoint_url 等额外查询参数。 | A=通过动态表单保存连接。 | O=额外查询参数经 query 字段原样保留，编辑不会丢弃。
  + [edge] EC-4: C=调用 get_search_path 时未传入表名集合。 | A=以默认空表集合调用 get_search_path。 | O=返回该 catalog 的搜索路径列表与空映射。
  + [edge] EC-5: C=管理员在 Athena 连接表单中仅填写部分 AWS 参数。 | A=提交连接表单。 | O=表单按动态 schema 校验必填项，缺失参数时提示对应字段。
  + [error] ER-1: C=用户提交 Athena 连接表单但未填写 region_name。 | A=保存连接。 | O=校验失败，region_name 为必填字段。
  + [happy] HP-1: C=管理员为 Amazon Athena 新建连接。 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录或 Work Group 并保存。 | O=表单字段被转换为 Athena SQLAlchemy URI 并保存。
  + [happy] HP-10: C=数据库连接配置了搜索路径，查询引用未限定 schema 的表。 | A=调用 Database.get_search_path 并传入 catalog 与表名集合。 | O=返回搜索路径列表与表到 schema 的映射，供连接表单与权限判定使用。
  + [happy] HP-11: C=管理员在数据源连接页面新建 Amazon Athena 数据库连接。 | A=打开 Athena 连接表单并填写 AWS Access Key ID、AWS Secret Access Key、AWS region 与 Athena work group。 | O=表单展示对应字段并接受填写值，连接配置可保存。
  + [happy] HP-2: C=管理员编辑已有 Athena 连接。 | A=打开连接表单。 | O=URI 被解析回各表单字段，额外查询参数保留在 query 字段中。
  + [happy] HP-3: C=Athena 连接使用 VPC/PrivateLink 自定义主机。 | A=保存连接。 | O=region_name 字段保留完整主机与端口，URI 按原样重建。
  + [happy] HP-4: C=管理员在 Superset 中新建或编辑 Amazon Athena 数据库连接。 | A=打开 Athena 连接配置表单。 | O=表单按动态连接参数 schema 渲染 Athena 专属连接字段，可填写并保存连接参数。
  + [happy] HP-5: C=用户新建或编辑 Amazon Athena 数据库连接。 | A=打开连接配置表单。 | O=表单按动态参数 schema 渲染连接参数字段。
  + [happy] HP-6: C=用户在数据库连接弹窗中选择 Amazon Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单在 Role 之后依次展示 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、S
  + [happy] HP-7: C=用户填写 Athena 连接参数。 | A=在 S3 query results location 字段上查看帮助提示。 | O=显示提示「Optional if your workgroup sets a result location.」。
  + [happy] HP-8: C=用户填写并保存 Athena 连接参数。 | A=保存数据库连接后重新打开连接配置。 | O=aws_access_key_id、aws_secret_access_key、region_name、s3_staging_dir、schema_name、work_group 
  + [happy] HP-9: C=用户创建 Amazon Athena 数据库连接。 | A=在连接表单中填写 region_name 及可选的访问密钥、s3_staging_dir、schema_name、work_group。 | O=连接以结构化参数保存，表单按 AthenaParametersSchema 渲染各独立字段。

## [NEW 功能/not_in_gt] CI 与许可证检查 [ci 与许可证检查]
summary: CI 后端环境固定 setup-uv 版本，许可证检查脚本下载 RAT jar 时启用失败重试。
  + [error] ER-1: C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，成功后继续许可证检查。
  + [error] ER-2: C=RAT jar 下载在重试后仍失败或返回 HTTP 错误。 | A=脚本执行 curl 下载。 | O=curl 以失败退出并输出错误信息，脚本随后报告下载失败并以非零状态退出。
  + [happy] HP-1: C=CI 运行后端环境安装。 | A=执行 setup-backend action。 | O=setup-uv 使用允许列表中的固定版本 v10.3.3。
  + [happy] HP-2: C=运行许可证检查。 | A=执行 check_license.sh。 | O=下载 RAT jar 时启用失败重试，成功后继续检查。
  + [happy] HP-3: C=CI 运行 setup-backend 复合动作安装后端依赖。 | A=执行 Install uv 步骤。 | O=使用固定提交 68559e99（v10.3.3）的 astral-sh/setup-uv 安装 uv。
  + [happy] HP-4: C=运行 check_license.sh 且本地尚无 RAT jar，Maven 仓库首次请求出现瞬时失败。 | A=脚本通过 curl 下载 RAT jar。 | O=curl 自动重试最多 5 次、间隔 3 秒，成功后继续许可证检查。
  + [happy] HP-5: C=CI 流水线执行后端环境安装与许可证检查。 | A=运行 setup-backend 与 check_license.sh。 | O=setup-uv 使用允许列表版本，RAT jar 下载失败时自动重试。

## [NEW 功能/not_in_gt] KebabMenuButton [kebabmenubutton]
summary: 更多操作按钮支持浮层样式与悬浮提示。
  + [edge] EC-1: C=调用方未传 tooltipTitle。 | A=悬停更多操作按钮。 | O=不显示提示内容，按钮与下拉行为不变。
  + [happy] HP-1: C=调用方传入 tooltipTitle 与 overlayStyle。 | A=悬停或聚焦更多操作按钮并打开下拉。 | O=显示配置的悬浮提示，下拉浮层应用指定样式。

## [NEW 功能/not_in_gt] MCP 语义表字段重选 [mcp 语义表字段重选]
summary: 通过 MCP 更新表与交互表图表时，对缺失或过期语义选择标记的图表要求完整字段重选。
  + [edge] EC-1: C=语义层提供方未声明选择身份版本 | A=生成图表 | O=不写入语义选择标记，不虚构身份
  + [edge] EC-2: C=语义视图提供方未声明 selection_identity_version。 | A=生成图表。 | O=不写入虚构的选择标记。
  + [edge] EC-3: C=语义表图表的选择标记过期且未提供全部成员列。 | A=调用 update_chart。 | O=拒绝更新并提示在 Explore 中恢复。
  + [error] ER-1: C=更新语义表图表时未提供全部列或未显式给出过滤器 | A=调用 update_chart | O=拒绝更新并提示需完整重选字段与显式过滤器
  + [error] ER-2: C=保留的语义选择无法验证。 | A=调用 update_chart。 | O=请求被拒绝并提示在 Explore 中恢复。
  + [error] ER-3: C=语义表图表保留未验证的旧选择。 | A=调用 update_chart。 | O=拒绝更新并返回恢复提示。
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器 | O=图表更新成功并写入新的语义选择标记
  + [happy] HP-2: C=生成图表或 Explore 链接时选择语义视图成员 | A=调用 generate_chart 或 generate_explore_link | O=新选择的成员被打上语义选择标记，保留的旧选择不被标记
  + [happy] HP-3: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表字段被完整重选并写入新的选择标记。
  + [happy] HP-4: C=通过 generate_chart 或 generate_explore_link 新建语义选择。 | A=提交生成请求。 | O=新选择被打上目标视图的 selection_identity_version 标记。
  + [happy] HP-5: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并提供目标视图全部成员列与显式过滤器。 | O=图表字段被完整重选并保存。
  + [happy] HP-6: C=通过 generate_chart 新建语义表图表。 | A=提交生成请求。 | O=新选择的成员被打上语义选择标记。

## [NEW 功能/not_in_gt] MCP 语义表完整重选 [mcp 语义表完整重选]
summary: update_chart 支持对语义选择标记缺失或过期的 table 与 interactive table 图表进行完整字段重选，要求提供全部列并显式给出过滤器。
  + [edge] EC-1: C=语义提供方未声明 selection_identity_version。 | A=生成语义图表。 | O=不写入语义选择身份标记。
  + [edge] EC-2: C=语义表图表保留的选择无法验证。 | A=调用 update_chart 仅更新图表名称。 | O=拒绝更新并提示通过 Explore 恢复。
  + [edge] EC-3: C=MCP 图表生成请求的 extra_form_data 与缓存 extra_form_data 均包含语义选择来源。 | A=merge_extra_form_data 合并两者。 | O=合并后的 extra_form_data 包含合并去重后的 semantic_selection_sources 列表。
  + [edge] EC-4: C=仪表盘作用域与模型 extra_form_data 均包含 semantic_selection_sources。 | A=compose_extra_form_data 合并两者。 | O=合并结果中的 semantic_selection_sources 汇总双方来源记录，成员键不再被重复合并。
  + [edge] EC-5: C=模型 extra_form_data 含 filters 等成员键但无 semantic_selection_sources，而作用域含来源记录。 | A=compose_extra_form_data 合并两者。 | O=为无来源的模型输入追加 {"datasource": "", "version": null} 记录，避免其成员被后续版本化输入认证。
  + [error] ER-1: C=重选时未提供全部列或未显式给出过滤器。 | A=调用 update_chart。 | O=请求被拒绝，要求完整重选。
  + [error] ER-2: C=MCP 客户端更新一个语义表已过时的图表，且未重新选择所有列或未显式指定过滤器。 | A=调用 UpdateChartRequest 更新图表配置。 | O=请求被拒绝，返回带 Explore 恢复指引的错误，提示需完整重选列并以 [] 清空过滤器。
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表字段选择被完整重选并保存。
  + [happy] HP-2: C=新建语义图表。 | A=调用 generate_chart 或 generate_explore_link 选择语义视图成员。 | O=新选择的成员被打上语义选择身份标记。
  + [happy] HP-3: C=用户在 MCP 语义表配置中需要重新选择全部语义表。 | A=执行完整语义表重选操作。 | O=语义表选择被整体替换为新的选择结果，配置按重选后的表集合生效。
  + [happy] HP-4: C=用户在 MCP 语义表配置中需要重新选择全部表。 | A=执行完整重选。 | O=语义表选择被完整替换为新的选择结果。
  + [happy] HP-5: C=MCP 客户端对语义视图生成图表，且语义视图选择身份版本为字符串。 | A=调用 generate_chart 并传入语义视图配置。 | O=form_data 被写入 semantic_selection_version，随后通过语义视图 form_data 校验并继续生成图表。
  + [happy] HP-6: C=MCP 客户端通过 update_chart 对语义视图图表执行完整语义表重选。 | A=调用 update_chart 提交新的语义表选择。 | O=工具使用 prove_table_reselection 与 has_dormant_table_grain 校验重选，成功时返回更新后的图表响应。
  + [happy] HP-7: C=MCP 客户端为语义视图生成 Explore 链接。 | A=调用 generate_explore_link 并传入语义视图配置。 | O=form_data 在设置 datasource 后被打上新语义选择标记，校验通过后返回带来源标记的 Explore 链接。
  + [happy] HP-8: C=用户在 MCP 中编辑语义表选择。 | A=执行完整重选语义表。 | O=语义表集合按新选择完整替换。

## [NEW 功能/not_in_gt] MCP 语义表重选 [mcp 语义表重选]
summary: update_chart 对 table 与 interactive table 图表支持完整字段重选，要求提供目标视图全部成员列并显式给出过滤器。
  + [edge] EC-1: C=更新请求只提供部分成员列。 | A=调用 update_chart。 | O=请求被拒绝，提示需重选全部列。
  + [edge] EC-2: C=调用方未提供 columns 或 filters | A=调用 update_chart 重选语义表字段 | O=返回不完整类别提示，拒绝重选
  + [edge] EC-3: C=保存的图表含未验证的保留选择 | A=调用 update_chart | O=拒绝并提示在 Explore 中恢复
  + [error] ER-1: C=更新请求保留未验证的旧选择。 | A=调用 update_chart。 | O=请求被拒绝并提示通过 Explore 恢复。
  + [error] ER-2: C=调用方在语义视图上使用 ad-hoc 聚合或 SQL 表达式 | A=调用 generate_chart 或 update_chart | O=返回 semantic_view_adhoc_not_supported 错误
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并提供目标视图全部成员列与显式过滤器。 | O=图表更新成功，新选择被标记为当前版本。
  + [happy] HP-2: C=调用方更新语义表图表且提供目标视图全部成员列与显式过滤器 | A=调用 update_chart | O=图表字段被完整重选并保存
  + [happy] HP-3: C=调用方生成新语义视图图表 | A=调用 generate_chart 并传入 view_id | O=form_data 被打上语义选择版本标记

## [NEW 功能/not_in_gt] SQL Lab [sql lab]
summary: SQL Lab 的 RLS 与表禁用清单对未限定 schema 的表引用进行解析匹配。
  + [edge] EC-1: C=Snowflake 查询使用 db..table 双点引用，未指定 schema。 | A=执行查询并做 RLS/禁用表校验。 | O=该引用按 PUBLIC schema 解析并参与匹配。
  + [edge] EC-2: C=Postgres 表名含非 ASCII 大写字母且未加引号。 | A=执行查询并做 RLS/禁用表校验。 | O=按 Postgres 编码折叠规则生成候选拼写进行匹配，避免误判为不同表。
  + [error] ER-1: C=用户查询的非限定表命中表拒绝名单。 | A=在 SQL Lab 中执行该查询。 | O=查询被拒绝并返回相应错误，而不是返回表数据。
  + [error] ER-2: C=引擎无法确定未限定 schema 的表所在 schema。 | A=执行查询并做 RLS/禁用表校验。 | O=该表被视为可能位于任一 schema，按任意 schema 匹配规则处理。
  + [happy] HP-1: C=数据源配置了 RLS 规则或表拒绝名单，用户在 SQL Lab 中查询未带 schema 的非限定表名。 | A=在 SQL Lab 中执行引用该非限定表的查询。 | O=查询按 RLS 规则与表拒绝名单进行校验，受限表不再因缺少 schema 限定而绕过限制。
  + [happy] HP-2: C=Postgres 连接配置了 search_path，查询引用未带 schema 的表名。 | A=执行查询，RLS 与 DISALLOWED_SQL_TABLES 校验该表引用。 | O=按 search_path 顺序解析表所在 schema，命中对应 RLS 规则或禁用清单。

## [NEW 功能/not_in_gt] SQL Lab 查询取消 [sql lab 查询取消]
summary: SQL Lab 查询的 RLS 缓存键解析支持 schema 搜索路径，并扩展 RLS 与表黑名单工具导入以覆盖无 schema 表。
  + [edge] EC-1: C=查询 SQL 为空。 | A=调用 get_inner_rls_cache_key。 | O=返回空列表，不进行 RLS 解析。
  + [happy] HP-1: C=SQL Lab 查询引用未限定表名（无 schema）。 | A=执行查询。 | O=查询结果按 RLS 与表黑名单过滤/拦截。
  + [happy] HP-2: C=SQL Lab 查询引用未限定 schema 的表，且用户对相关表存在 RLS 规则。 | A=计算查询的 RLS 缓存键。 | O=缓存键包含按搜索路径解析后的 RLS 谓词，不同 RLS 用户不会命中同一缓存条目。

## [NEW 功能/not_in_gt] SQL Lab 查询成本估算 [sql lab 查询成本估算]
summary: 在 SQL Lab 中估算查询成本，并在估算前应用与执行路径一致的禁用函数、禁用表、文件传输、DML 与 RLS 控制。
  + [edge] EC-1: C=成本估算的 SQL 引用被禁用表或禁用函数。 | A=触发成本估算。 | O=返回禁用表或禁用函数错误，不执行估算。
  + [edge] EC-2: C=用户在 PostgreSQL 引擎上执行引用大小写不一致的未加引号表名的查询。 | A=解析并校验该表引用。 | O=按方言归一化策略折叠对象名后匹配，引用解析为同一物理表。
  + [edge] EC-3: C=引擎属于 CASE_SENSITIVE_OBJECT_NAMES 或没有专属方言。 | A=调用 folds_unquoted_object_names 判断是否折叠对象名。 | O=返回 False，按大小写敏感精确匹配。
  + [error] ER-1: C=成本估算超过配置的超时时间。 | A=触发成本估算。 | O=返回估算超时错误。
  + [error] ER-2: C=用户对引用无 schema 非限定表的 SQL 发起成本估算，而该表在表拒绝列表中。 | A=请求估算查询成本。 | O=估算被拒绝并返回表被禁止访问的错误，而非返回成本结果。
  + [happy] HP-1: C=用户在 SQL Lab 对查询做成本估算。 | A=触发成本估算。 | O=返回数据库给出的查询成本。
  + [happy] HP-2: C=用户在 SQL Lab 对引用无 schema 非限定表的查询做成本估算。 | A=触发成本估算。 | O=按连接搜索路径解析表所属 schema，应用 RLS 与表拒绝名单后返回估算。
  + [happy] HP-3: C=用户对引用无 schema 非限定表的 SQL 发起成本估算，且该表未被拒绝。 | A=请求估算查询成本。 | O=估算正常返回成本结果，RLS 与表拒绝列表校验通过。
  + [happy] HP-4: C=用户在 SQL Lab 中执行引用未限定 schema 表的查询。 | A=提交查询执行。 | O=RLS 与表黑名单对未限定表生效，越权表访问被拦截。

## [NEW 功能/not_in_gt] 仪表盘版本恢复影响提示 [仪表盘版本恢复影响提示]
summary: 仪表盘版本恢复前统计当前成员中不属于目标版本的图表数量，并在确认弹窗中提示这些图表将被移除。
  + [edge] EC-1: C=目标版本包含当前全部成员图表。 | A=打开恢复确认弹窗。 | O=移除数量为 0，弹窗不显示移除警告。
  + [edge] EC-2: C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应不含移除数量。
  + [edge] EC-3: C=用户看到移除图表警告后取消恢复。 | A=在警告提示中选择取消。 | O=仪表盘保持当前版本不变，图表不被移除。
  + [edge] EC-4: C=用户切换到另一个版本或另一个仪表盘。 | A=打开恢复确认弹窗。 | O=按新的 entityUuid/versionUuid 重新请求并展示对应的移除图表数量。
  + [error] ER-1: C=版本接口返回的 _restore_impact.removed_chart_count 缺失、非数字、非整数或为负数。 | A=打开恢复确认弹窗触发影响计数请求。 | O=请求抛出 Invalid restore impact response 错误，影响计数不可用。
  + [error] ER-2: C=影响计数请求超过 10000 毫秒未返回。 | A=打开恢复确认弹窗触发影响计数请求。 | O=请求超时失败，影响计数不可用。
  + [happy] HP-1: C=用户在版本历史中恢复仪表盘旧版本。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中将被移除的图表数量并提示图表本身不被删除。
  + [happy] HP-2: C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的图表数量。
  + [happy] HP-3: C=用户选择恢复仪表盘的历史版本，该版本与当前版本图表集合不同。 | A=触发版本恢复。 | O=恢复前显示警告，列出将被移除的图表，用户确认后才执行恢复。
  + [happy] HP-4: C=恢复某仪表盘历史版本会移除当前图表。 | A=确认恢复该版本。 | O=恢复前显示将移除图表的警告。
  + [happy] HP-5: C=用户在仪表盘版本历史中选择一个历史版本并点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗请求版本接口并展示将被移除的图表数量提示。
  + [happy] HP-6: C=用户在版本历史中选择一个会移除部分图表的仪表盘历史版本。 | A=触发恢复操作。 | O=恢复前显示警告，列出将被移除的图表。

## [NEW 功能/not_in_gt] 列表排序状态恢复 [列表排序状态恢复]
summary: 列表视图在浏览器前进后退时恢复排序、页码与搜索，并保持排序控件与结果一致。
  + [edge] EC-1: C=初始排序与当前排序不同。 | A=列表状态 effect 运行。 | O=受控排序被重置为初始排序。
  + [edge] EC-2: C=受控排序被恢复为空排序。 | A=重新渲染表格。 | O=表头排序指示被清除。
  + [edge] EC-3: C=当前 sortBy 已等于 initialSortBy。 | A=query 同步 effect 执行。 | O=不触发 setSortBy，排序控件不重新挂载。
  + [happy] HP-1: C=用户在图表或数据集列表中修改排序、页码与搜索。 | A=使用浏览器 Back 与 Forward。 | O=排序、页码与搜索一并从 URL 恢复，控件与结果同步。
  + [happy] HP-2: C=受控排序从非空恢复为空排序。 | A=重新渲染 TableCollection。 | O=表头排序指示被清除。
  + [happy] HP-3: C=用户在列表页排序、翻页并搜索后离开再返回。 | A=使用浏览器后退/前进。 | O=排序、分页与搜索作为同一 URL 状态被恢复。
  + [happy] HP-4: C=列表视图以 URL 中的初始排序加载，当前 sortBy 与 initialSortBy 不一致。 | A=页面加载并同步 query。 | O=sortBy 被重置为 initialSortBy，CardSortSelect 因 key 变化重新挂载并显示正确排序。

## [NEW 功能/not_in_gt] 列表视图排序与历史状态 [列表视图排序与历史状态]
summary: 列表视图的排序、分页与过滤状态与 URL 同步，并支持浏览器前进后退恢复。
  + [edge] EC-1: C=受控排序被恢复为空排序 | A=列表重新渲染 | O=表头不再显示排序指示
  + [edge] EC-2: C=列配置未显式设置 id，仅有字符串 accessor | A=点击其中一个列头排序 | O=仅被点击的列头标记为已排序，其他列头不受影响
  + [edge] EC-3: C=调用方未传入 sortBy。 | A=渲染列表视图表格。 | O=组件按无外部排序状态正常渲染，不报错。
  + [happy] HP-1: C=用户在列表视图点击列头排序 | A=点击可排序列头 | O=列表按该列排序并重新请求数据，URL 记录 sortColumn 与 sortOrder
  + [happy] HP-2: C=用户使用浏览器后退回到之前的列表状态 | A=点击后退 | O=排序、页码与搜索过滤一并恢复，表头排序指示同步更新
  + [happy] HP-3: C=列表视图恢复了此前保存的排序状态。 | A=渲染列表视图表格。 | O=传入的 sortBy 被用于列映射，排序指示与恢复的排序状态一致。

## [NEW 功能/not_in_gt] 图表更新并发保护 [图表更新并发保护]
summary: 图表更新在写入前校验保存输入未被并发修改，过期更新被拒绝。
  + [error] ER-1: C=图表在准备更新后被他人修改。 | A=提交带 expected_basis 的图表更新。 | O=返回 ChartUpdateFailedError，提示重新加载后重试。
  + [happy] HP-1: C=图表自准备更新后未被他人修改。 | A=提交带 expected_basis 的图表更新。 | O=更新成功并提交。

## [NEW 功能/not_in_gt] 归档列表与恢复 [归档列表与恢复]
summary: 提供 Recently Archived 列表，按类型浏览已归档的图表、仪表盘与数据集，并支持恢复与永久删除。
  + [edge] EC-1: C=用户只有读权限。 | A=查看归档行。 | O=不显示操作列，悬停提示需先恢复才能打开。
  + [edge] EC-2: C=用户切换归档类型。 | A=从 Chart 切换到 Dashboard。 | O=排序与分页参数被清除，新类型使用自身默认排序。
  + [edge] EC-3: C=用户切换归档类型后希望返回之前的类型视图。 | A=点击浏览器后退。 | O=由于使用 history.push，浏览器返回到切换前的类型视图。
  + [error] ER-1: C=恢复请求返回 404（对象已被他人恢复）。 | A=点击 Recover。 | O=显示恢复失败提示，列表不崩溃且行保留。
  + [happy] HP-1: C=用户打开 Recently Archived 列表。 | A=浏览已归档图表。 | O=列表显示名称、类型、归档时间与归档人，默认按归档时间倒序。
  + [happy] HP-2: C=用户对已归档图表点击恢复。 | A=点击 Recover。 | O=调用该类型恢复接口，成功后显示带链接的恢复提示并刷新列表。
  + [happy] HP-3: C=键盘用户聚焦归档行操作。 | A=按 Tab 聚焦恢复按钮并按 Enter。 | O=操作按钮可见且恢复请求被触发。
  + [happy] HP-4: C=用户在最近归档列表中切换归档对象类型。 | A=在 Type 下拉框选择另一类型。 | O=URL 中 type 更新，sortColumn、sortOrder、pageIndex 被清除，并通过 history.push 新增历史记录，列表按新类型默认排序与分页展示。

## [NEW 功能/not_in_gt] 版本历史恢复 [版本历史恢复]
summary: 在图表与仪表盘的版本历史中预览、恢复版本或从版本创建新对象，恢复前提示将移除的仪表盘图表。
  + [edge] EC-1: C=恢复影响计数请求失败 | A=打开恢复确认弹窗 | O=弹窗仍可展示，不因计数失败阻塞恢复流程
  + [edge] EC-2: C=移除计数请求尚未返回。 | A=查看恢复确认弹窗。 | O=显示“Checking which charts will be removed…”，恢复按钮禁用。
  + [edge] EC-3: C=用户切换到另一个版本后旧计数请求才返回。 | A=查看恢复确认弹窗。 | O=过期响应被忽略，不显示旧版本的移除数量。
  + [edge] EC-4: C=用户先打开某版本的恢复确认弹窗，随后切换到另一版本或另一实体。 | A=再次请求恢复。 | O=确认弹窗因 key 变化重新挂载，不保留上一目标的确认状态。
  + [error] ER-1: C=用户确认恢复前另一用户修改了仪表盘成员 | A=确认恢复 | O=实际移除的图表可能与弹窗计数不同，恢复按确认时的成员执行
  + [error] ER-2: C=移除计数请求失败或超时。 | A=查看恢复确认弹窗。 | O=提示无法检查将移除的图表，恢复按钮仍可用。
  + [happy] HP-1: C=用户打开仪表盘版本历史并选择某版本恢复 | A=打开恢复确认弹窗 | O=弹窗显示当前成员中不属于该版本的图表数量，并提示恢复会移除这些图表但不删除图表本身
  + [happy] HP-2: C=目标版本包含当前全部成员图表 | A=打开恢复确认弹窗 | O=不显示移除警告，可直接确认恢复
  + [happy] HP-3: C=用户对仪表盘某历史版本点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并说明图表本身不会被删除。
  + [happy] HP-4: C=目标版本包含当前全部成员图表。 | A=打开恢复确认弹窗。 | O=不显示移除警告，恢复按钮可用。
  + [happy] HP-5: C=用户对图表版本点击恢复。 | A=打开恢复确认弹窗。 | O=不请求仪表盘成员计数，不显示移除警告。
  + [happy] HP-6: C=用户在版本历史中选择某个版本并请求恢复。 | A=打开恢复确认弹窗。 | O=弹窗以 entityType、uuid、目标版本 versionUuid 作为 key 重新挂载，并携带 entityUuid，展示对应版本的恢复确认内容。

## [NEW 功能/not_in_gt] 版本历史恢复影响提示 [版本历史恢复影响提示]
summary: 仪表盘恢复确认对话框在恢复前统计并提示将被移除的当前成员图表数量。
  + [edge] EC-1: C=当前成员包含已归档或未放置的图表。 | A=打开恢复确认对话框。 | O=计数包含这些成员，因为它们仍属于仪表盘并可被解除关联。
  + [error] ER-1: C=恢复影响计数请求失败。 | A=打开恢复确认对话框。 | O=对话框提示移除数量未知。
  + [happy] HP-1: C=用户选择较早的仪表盘版本并点击恢复。 | A=打开恢复确认对话框。 | O=对话框显示当前成员中不属于该版本的图表数量，并说明恢复会将其从仪表盘移除但不删除图表。
  + [happy] HP-2: C=所选版本包含当前全部成员图表。 | A=打开恢复确认对话框。 | O=移除数量为 0，不显示移除警告。

## [NEW 功能/not_in_gt] 版本历史恢复警告 [版本历史恢复警告]
summary: 仪表盘恢复确认弹窗统计当前成员中不属于目标版本的图表数量，并警告恢复将移除这些图表。
  + [edge] EC-1: C=目标版本包含当前全部成员图表 | A=打开恢复确认弹窗 | O=不显示移除警告
  + [error] ER-1: C=恢复影响计数请求失败 | A=打开恢复确认弹窗 | O=弹窗仍可确认恢复，不阻塞操作
  + [happy] HP-1: C=用户选择恢复仪表盘历史版本 | A=打开恢复确认弹窗 | O=弹窗显示将被移除的图表数量并警告

## [NEW 功能/not_in_gt] 软删除归档体验 [软删除归档体验]
summary: 软删除归档提示、依赖计数、恢复链接与键盘可达性的修复。
  + [edge] EC-1: C=用户在归档列表中切换对象类型。 | A=切换 Type 选择器。 | O=浏览器历史新增一条记录，Back 可返回上一类型。
  + [edge] EC-2: C=软删除特性关闭，用户非图表编辑者。 | A=在图表卡片上悬停删除菜单项。 | O=提示文案为「You must be a chart editor in order to delete...」。
  + [error] ER-1: C=归档通知中的恢复链接在子路径部署下生成。 | A=点击恢复链接。 | O=链接包含应用根路径，正确跳转到归档列表。
  + [happy] HP-1: C=用户归档图表或仪表盘成功。 | A=查看成功提示。 | O=提示包含指向 Recently Archived 的恢复链接，链接遵循部署 URL 前缀。
  + [happy] HP-2: C=含链接的归档成功通知显示在页面上。 | A=悬停或通过键盘聚焦该通知。 | O=通知保持打开直至用户关闭。
  + [happy] HP-3: C=非编辑者查看图表或仪表盘卡片。 | A=按 Tab 聚焦 More Options 按钮。 | O=在打开菜单前读到编辑或归档不可用的原因。
  + [happy] HP-4: C=用户对列表项执行软删除归档操作。 | A=完成归档。 | O=显示归档提示，归档计数与版本历史正确更新，键盘操作可正常完成归档流程。
  + [happy] HP-5: C=软删除特性开启，用户对图表有写权限但非图表编辑者。 | A=在图表卡片上悬停删除/归档菜单项。 | O=提示文案为「You must be a chart editor in order to archive...」，菜单项禁用。

## [NEW 功能/not_in_gt] 软删除归档提示 [软删除归档提示]
summary: 归档成功提示中的恢复链接保持到用户关闭，链接遵循部署 URL 前缀，归档列表分页与排序保留浏览历史。
  + [edge] EC-1: C=数据集归档影响提示中图表与仪表盘数量均非零。 | A=查看归档确认文案。 | O=文案为“linked to N charts and M dashboards”。
  + [edge] EC-2: C=用户使用键盘聚焦归档提示中的链接。 | A=按 Tab 键导航。 | O=链接可被聚焦且提示不自动消失。
  + [edge] EC-3: C=用户在归档列表中切换分页或排序。 | A=操作分页或排序控件。 | O=URL 以 push 方式更新，浏览器后退可回到上一状态。
  + [edge] EC-4: C=部署配置了 URL 前缀 | A=点击恢复链接 | O=链接指向带前缀的归档页
  + [edge] EC-5: C=通知文本包含 HTML 链接 | A=等待通知超时 | O=通知保持显示直到用户关闭
  + [edge] EC-6: C=当前用户是仪表盘编辑者或管理员。 | A=悬停仪表盘卡片菜单中的编辑或删除项。 | O=不显示权限提示，菜单项可正常操作。
  + [edge] EC-7: C=数据集被图表和仪表盘引用，软删除功能开启。 | A=打开归档确认弹窗。 | O=弹窗显示归档影响说明，列出依赖的图表与仪表盘数量，文案与改前一致。
  + [happy] HP-1: C=用户归档图表或仪表盘成功。 | A=查看成功提示。 | O=提示包含指向 Recently Archived 的恢复链接，链接使用部署根路径。
  + [happy] HP-10: C=用户对列表项执行软删除归档操作。 | A=确认归档。 | O=显示归档提示，计数与历史记录同步更新，键盘操作行为正确。
  + [happy] HP-2: C=含链接的归档成功提示出现。 | A=用户悬停或键盘聚焦该提示。 | O=提示保持打开直到被显式关闭。
  + [happy] HP-3: C=用户归档一个图表或仪表盘。 | A=查看归档成功提示。 | O=提示包含指向 Recently Archived 的恢复链接，并保持到用户关闭。
  + [happy] HP-4: C=部署配置了 URL 前缀。 | A=点击归档提示中的恢复链接。 | O=链接包含部署 URL 前缀并正确跳转。
  + [happy] HP-5: C=用户归档图表或仪表盘 | A=执行归档 | O=成功提示包含指向归档页的恢复链接
  + [happy] HP-6: C=当前用户不是仪表盘编辑者且软删除特性开启。 | A=悬停仪表盘卡片菜单中的删除/归档项。 | O=显示提示「You must be a dashboard editor in order to archive...」。
  + [happy] HP-7: C=当前用户不是仪表盘编辑者且软删除特性关闭。 | A=悬停仪表盘卡片菜单中的删除项。 | O=显示提示「You must be a dashboard editor in order to delete...」。
  + [happy] HP-8: C=当前用户不是仪表盘编辑者。 | A=悬停仪表盘卡片菜单中的编辑项。 | O=显示提示「You must be a dashboard editor in order to edit...」，编辑项处于禁用状态。
  + [happy] HP-9: C=软删除功能关闭时，用户删除一个被图表和仪表盘引用的数据集。 | A=打开删除确认弹窗。 | O=弹窗显示“The <dataset> <table_name> is linked to N charts and M dashboards. Are you sure you w

## [NEW 功能/not_in_gt] 软删除归档通知 [软删除归档通知]
summary: 归档与恢复操作的通知文案、恢复链接与通知停留行为。
  + [edge] EC-1: C=数据集删除确认弹窗展示依赖数量 | A=查看弹窗文案 | O=文案为“linked to N charts and M dashboards”
  + [edge] EC-2: C=普通通知无 action、无链接且 duration > 0。 | A=通知展示。 | O=按 duration 自动关闭。
  + [edge] EC-3: C=恢复的对象没有可用链接。 | A=完成恢复。 | O=提示为纯文本“<name> restored successfully”，不包含链接。
  + [error] ER-1: C=用户无编辑权限 | A=键盘聚焦图表或仪表盘卡片的更多操作按钮 | O=先读到权限提示，再打开菜单
  + [happy] HP-1: C=用户归档图表或仪表盘 | A=确认归档 | O=成功提示包含指向 Recently Archived 的恢复链接，链接按部署 URL 前缀生成
  + [happy] HP-2: C=含链接的归档成功通知出现 | A=用户悬停或键盘聚焦该通知 | O=通知保持打开直到用户手动关闭
  + [happy] HP-3: C=通知 allowHtml 为真且文本包含 <a 链接，无 action，duration > 0。 | A=通知展示。 | O=不设置自动关闭定时器，通知保持可见直到用户关闭。
  + [happy] HP-4: C=应用部署在非根路径下，用户恢复一个带链接的已归档对象。 | A=完成恢复。 | O=恢复成功提示中的“View <type>”链接 href 为应用根路径加对象 URL，点击可正确跳转。
