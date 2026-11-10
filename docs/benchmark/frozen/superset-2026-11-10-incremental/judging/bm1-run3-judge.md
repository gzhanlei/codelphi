
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
  + EC-1 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=响应不计算恢复影响计数，行为与之前一致。
  + EC-2 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=不返回恢复影响计数
  + EC-3 [edge] C=调用方未传 include_restore_impact 或传 false。 | A=GET 仪表盘版本详情。 | O=不计算恢复影响，响应不含移除数量。
  + EC-4 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=不计算恢复影响，响应不含该计数
  + ER-1 [error] C=调用方请求不存在的版本 UUID。 | A=GET 仪表盘版本详情。 | O=返回 404。
  + ER-2 [error] C=恢复影响计数响应中 removed_chart_count 缺失、为负数或非整数 | A=前端解析响应 | O=抛出 Invalid restore impact response 错误
  + HP-2 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应包含恢复将移除的当前成员图表数量。
  + HP-3 [happy] C=调用方请求仪表盘版本详情并附带 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应 result 中包含 _restore_impact.removed_chart_count 整数
  + HP-4 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应包含恢复将移除的图表数量

## [CHANGED/affected] SQL 编辑器 [sql 编辑器]
  逐字相同场景: ER-1, HP-1, HP-2
  + EC-1 [edge] C=查询引用未写 schema 的表，且该表名在禁用表黑名单中。 | A=执行查询。 | O=查询被拒绝。
  + EC-10 [edge] C=在 Postgres 上执行 WITH RECURSIVE 查询，CTE 体引用子句中后定义的 CTE。 | A=解析 SQL。 | O=前向引用被识别为 CTE 引用。
  + EC-2 [edge] C=PostgreSQL 中 CTE 名与物理表名仅大小写不同，且未加引号。 | A=解析 SQL 提取表引用。 | O=按引擎折叠规则将未加引号名称视为同一标识，正确区分 CTE 引用与物理表。
  + EC-3 [edge] C=Snowflake 查询使用两点名 db..table。 | A=解析表引用。 | O=该表解析为 PUBLIC schema 下的表。
  + EC-4 [edge] C=查询估算引用未限定 schema 的表。 | A=执行查询估算。 | O=同样按默认 schema 与搜索路径应用 RLS 与表黑名单。
  + EC-5 [edge] C=SQL Lab 查询引用未写 schema 的表，且该表在默认 schema 或搜索路径中被 RLS 或黑名单命中 | A=执行查询 | O=按解析出的实际 schema 应用 RLS 谓词与表黑名单
  + EC-6 [edge] C=SQL Lab 查询引用未写 schema 的非限定表，且该表在默认 schema 或 search path 中命中 RLS 或黑名单。 | A=执行查询或估算查询。 | O=RLS 谓词被注入或表被黑名单拒绝。
  + EC-7 [edge] C=SQL Lab 查询引用未限定 schema 的表名 | A=执行查询 | O=按数据库 search path 与默认 schema 解析表并应用 RLS 与表黑名单
  + EC-8 [edge] C=Postgres 表名包含非 ASCII 大写字母 | A=执行引用该未限定表的查询 | O=按 Postgres 编码折叠规则生成候选拼写，正确匹配实际表
  + EC-9 [edge] C=Postgres search_path 包含 $user 或 pg_temp | A=执行引用未限定表的查询 | O=$user 解析为当前用户 schema，pg_temp 被排除，按顺序解析 schema
  + ER-2 [error] C=未加引号的表名在 PostgreSQL、Oracle、Snowflake 上大小写折叠后与 CTE 同名。 | A=解析 SQL 并提取表。 | O=该引用被识别为 CTE 而非物理表，不误报为被禁用表。
  + ER-3 [error] C=成本估算引用了被拒绝的表或函数。 | A=触发成本估算。 | O=返回对应的表/函数拒绝错误，不执行估算。
  + ER-4 [error] C=引擎无法确定未限定表所在 schema | A=执行引用未限定表的查询 | O=该表被视为可能位于任一 schema，RLS 与拒绝名单在任一 schema 匹配时生效
  + HP-3 [happy] C=SQL Lab 查询引用未写 schema 的表，且该表在数据库 search path 中匹配到带 RLS 的数据集。 | A=执行查询。 | O=RLS 谓词被注入到该非限定表引用。
  + HP-4 [happy] C=SQL Lab 查询引用未限定 schema 的表，且该表在默认 schema 或搜索路径中命中 RLS 或表黑名单。 | A=执行查询。 | O=RLS 谓词被注入，被禁用表被拦截。
  + HP-5 [happy] C=用户在 SQL Lab 对查询做成本估算，查询引用无 schema 的非限定表。 | A=触发成本估算。 | O=按连接 search path 解析实际 schema 后应用 RLS 与表拒绝名单，估算结果与执行一致。
  + HP-6 [happy] C=Postgres 连接配置了 search_path 且存在 RLS 规则 | A=在 SQL Lab 中执行引用未限定 schema 表的查询 | O=RLS 规则按 search_path 解析到的实际 schema 正确应用
  + HP-7 [happy] C=Snowflake 连接中执行引用 db..table 两段式名称的查询 | A=运行查询 | O=该引用被解析为 PUBLIC schema 的表，RLS 与拒绝名单按 PUBLIC 匹配
  + HP-8 [happy] C=在 Postgres 上执行含大小写不一致 CTE 引用的查询。 | A=解析 SQL 并进行权限校验。 | O=CTE 引用按折叠名称匹配到 CTE，不被误判为表读取。

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
    C v49: 图表更新请求新增了调用方无编辑权限的仪表盘关联。
    A v48: 保存仪表盘布局
    A v49: 提交图表更新。
    O v48: 该图表保存为缺失图表占位，布局其余部分正常保存
    O v49: 返回仪表盘禁止错误，不泄露不可访问仪表盘信息。
  ~ EC-4(rewritten):
    C v48: 调用方没有宽松仪表盘访问权限。
    C v49: 恢复确认对话框打开后其他用户修改了仪表盘成员
    A v48: GET 仪表盘详情。
    A v49: 用户确认恢复
    O v48: 响应 charts 字段仅包含 can_access_chart 通过的成员图表。
    O v49: 实际移除数量以确认时为准，可能与会话中显示的数量不同
  + EC-5 [edge] C=当前用户不是该仪表盘的编辑者，且软删除功能关闭。 | A=在仪表盘卡片菜单中悬停删除项。 | O=Tooltip 显示「You must be a dashboard editor in order to delete. Please reach out to a dashboard editor to reques
  + EC-6 [edge] C=当前用户不是该仪表盘的编辑者。 | A=在仪表盘卡片菜单中悬停编辑项。 | O=Tooltip 显示「You must be a dashboard editor in order to edit. Please reach out to a dashboard editor to request 
  + EC-7 [edge] C=当前用户是该仪表盘的编辑者（allowEdit 为真）。 | A=在仪表盘卡片菜单中悬停编辑或删除项。 | O=编辑与删除项的 Tooltip 标题为空，不显示权限提示，按钮可正常点击。
  + ER-1 [error] C=访客令牌用户名无法解析为当前用户。 | A=计算仪表盘缩略图摘要。 | O=按访客自身键值计算摘要，不因用户名解析失败而报错。
  + ER-2 [error] C=访客令牌携带空用户名。 | A=以访客身份请求仪表盘截图或图表数据。 | O=访客仍被识别为嵌入访客，按访客 RLS 与缓存分区处理。
  + ER-3 [error] C=嵌入式访客令牌携带空用户名 | A=生成仪表盘缩略图摘要 | O=按访客身份而非用户名解析执行者，RLS 规则正确进入摘要
  + ER-4 [error] C=图表更新时预期基线已过期（图表被他人修改）。 | A=提交带 expected_basis 的图表更新。 | O=返回 ChartUpdateFailedError，提示重新加载后重试。
  + HP-3 [happy] C=嵌入式访客令牌携带空用户名。 | A=访客请求仪表盘及其图表数据。 | O=访客被正确识别为嵌入式访客，按访客令牌范围授权。
  + HP-4 [happy] C=用户恢复仪表盘历史版本 | A=在恢复确认对话框中确认 | O=对话框显示当前成员中不属于该版本、将被移除的图表数量并警告不会删除图表本身
  + HP-5 [happy] C=当前用户不是该仪表盘的编辑者（allowEdit 为假），且软删除功能开启。 | A=在仪表盘卡片菜单中悬停删除项。 | O=Tooltip 显示「You must be a dashboard editor in order to archive. Please reach out to a dashboard editor to reque

## [KEPT/unaffected] 仪表盘布局保存 [仪表盘布局保存]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7, HP-8, HP-9

## [KEPT/unaffected] 前端插件构建 [前端插件构建]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1, HP-2, HP-3, HP-4, HP-5, HP-6, HP-7

## [CHANGED/affected] 发布流程工具 [发布流程工具]
  逐字相同场景: EC-1, HP-1, HP-2
  ~ ER-1(rewritten):
    C v48: GitHub 凭据无效
    C v49: 下载 RAT jar 时网络短暂失败。
    A v48: 生成变更日志
    A v49: 运行 check_license.sh。
    O v48: 提示凭据错误并退出
    O v49: curl 按重试策略重试下载，失败时输出错误信息。
  ~ HP-3(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ar/** 下的文件。
    C v49: 提交的 PR 修改了 superset/translations/pl/** 下的文件。
    O v48: PR 被自动添加 i18n:arabic 标签。
    O v49: PR 被自动添加 i18n:polish 标签。
  ~ HP-4(rewritten):
    C v48: 提交的 PR 修改了 superset/translations/ca/** 下的文件。
    C v49: CI 运行 setup-backend 动作安装 Superset 依赖。
    A v48: 触发 labeler 工作流。
    A v49: 执行 Install uv 步骤。
    O v48: PR 被自动添加 i18n:catalan 标签。
    O v49: 使用固定到允许列表的 setup-uv v10.3.3。
  ~ HP-5(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ar/** 的 PR。
    C v49: 许可证检查首次下载 RAT jar 遇到网络抖动或 5xx。
    A v48: 触发 labeler 工作流。
    A v49: 运行 check_license.sh。
    O v48: PR 被自动打上 i18n:arabic 标签。
    O v49: curl 按 5 次重试与 3 秒间隔重新下载，成功后继续检查。
  ~ HP-6(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ca/** 的 PR。
    C v49: PR 修改 superset/translations/pl/ 下的翻译文件
    A v48: 触发 labeler 工作流。
    A v49: labeler 工作流运行
    O v48: PR 被自动打上 i18n:catalan 标签。
    O v49: 该 PR 被自动打上 i18n:polish 标签
  + EC-2 [edge] C=check_license.sh 下载 RAT jar 时遇到瞬时 HTTP 5xx 或连接错误 | A=curl 以 --retry 5 --retry-all-errors --retry-delay 3 重试下载 | O=在重试次数内恢复则下载成功，脚本继续执行
  + EC-3 [edge] C=CI 后端环境执行 setup-backend 复合动作 | A=Install uv 步骤使用固定提交 68559e99（v10.3.3） | O=uv 以 v10.3.3 安装并用于后续依赖安装
  + ER-2 [error] C=GitHub 凭据无效 | A=生成变更日志 | O=提示凭据错误并退出
  + ER-3 [error] C=RAT jar 重试后仍下载失败或文件损坏。 | A=运行 check_license.sh。 | O=删除残留文件并提示手动安装 rat，退出码 255。
  + ER-4 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败才报错
  + ER-5 [error] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --fail --retry 5 重试下载，失败后不再把错误页当作 jar 使用。
  + ER-6 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 以失败重试与错误输出方式重试下载，成功后继续许可证检查
  + ER-7 [error] C=check_license.sh 下载 RAT jar 时 HTTP 返回 404 或重试耗尽 | A=curl 因 --fail 返回非零退出码 | O=下载失败，jar 校验失败分支清理临时文件并以退出码 255 终止
  + HP-7 [happy] C=check_license.sh 首次运行且本地无 RAT jar，Maven 仓库可访问 | A=脚本通过 curl 下载 apache-rat jar | O=jar 下载成功并移动到目标路径，后续校验通过

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
  ~ EC-1(rewritten):
    C v48: 环境中已存在 pyarrow 26.0.0。
    C v49: 环境中已存在 fastmcp 4.1.2。
    O v48: 26.0.0 不满足 >=26.0.1 约束，需升级到 26.0.1 及以上。
    O v49: 4.1.2 不满足 >=4.1.4 约束，需升级。
  ~ ER-1(rewritten):
    C v48: 环境中已安装 pyarrow 26.0.0 并尝试满足 Superset 依赖约束。
    C v49: 环境中已安装 fastmcp 4.1.2 并尝试满足 Superset 依赖约束。
    O v48: 因低于新的下限 26.0.1 而无法满足约束，需升级 pyarrow。
    O v49: 因低于新的下限 4.1.4 而无法满足约束，需升级 fastmcp。
  ~ HP-1(rewritten):
    C v48: 安装 Superset 依赖
    C v49: 安装 Superset 的 fastmcp 可选依赖。
    A v48: 解析 pyarrow 版本
    A v49: 解析 fastmcp 版本约束。
    O v48: 安装 26.0.1 及以上版本，排除含 CVE-2026-111497 的版本
    O v49: 安装 fastmcp 4.1.4 及以上、5.0 以下版本。
  ~ HP-2(rewritten):
    C v48: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    C v49: 安装开发依赖。
    A v48: 执行依赖安装/解析。
    A v49: 解析 requirements/development.txt。
    O v48: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
    O v49: fastmcp-slim 及其依赖按锁定版本安装。
  ~ HP-3(rewritten):
    C v48: 安装 Superset 依赖。
    C v49: 安装 Superset 依赖
    A v48: 解析并安装 pyarrow。
    A v49: 解析 pyarrow 版本
    O v48: 安装的 pyarrow 版本不低于修复版本，不含 CVE-2026-111497。
    O v49: 安装 26.0.1 及以上版本，排除含 CVE-2026-111497 的版本
  ~ HP-4(rewritten):
    C v48: 在干净环境中安装 Superset 依赖。
    C v49: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    A v48: 解析 pyarrow 依赖约束。
    A v49: 执行依赖安装/解析。
    O v48: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
    O v49: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
  ~ HP-5(rewritten):
    C v48: 安装项目依赖
    C v49: 安装 MCP 相关可选依赖。
    A v48: 解析 pyarrow 版本
    A v49: 解析 fastmcp 版本。
    O v48: 不再解析到含 CVE-2026-111497 的 pyarrow 版本
    O v49: fastmcp 解析为 >=4.1.4,<5.0，开发环境锁定 4.1.6。
  + EC-2 [edge] C=环境中已存在 pyarrow 26.0.0。 | A=按更新后的约束安装或升级依赖。 | O=26.0.0 不满足 >=26.0.1 约束，需升级到 26.0.1 及以上。
  + ER-2 [error] C=环境中已安装 pyarrow 26.0.0 并尝试满足 Superset 依赖约束。 | A=执行依赖安装/校验。 | O=因低于新的下限 26.0.1 而无法满足约束，需升级 pyarrow。
  + ER-3 [error] C=环境中仅能获取 fastmcp 4.1.0–4.1.3 | A=安装 fastmcp extra | O=依赖解析失败，因不满足 >=4.1.4 下限
  + HP-6 [happy] C=安装 fastmcp 可选依赖 | A=解析 fastmcp 版本 | O=安装 fastmcp>=4.1.4,<5.0 范围内的版本
  + HP-7 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 4.1.4 及以上、5.0 以下版本。
  + HP-8 [happy] C=安装 fastmcp 可选依赖。 | A=解析 fastmcp 版本。 | O=安装 4.1.4 及以上、低于 5.0 的版本。
  + HP-9 [happy] C=用户安装 apache-superset[fastmcp] extra | A=依赖解析器解析 fastmcp 版本 | O=解析到 fastmcp>=4.1.4 且 <5.0 的版本

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
    C v49: 嵌入访客令牌的用户名为空字符串。
    A v48: GET /api/v1/dashboard/{id_or_slug}。
    A v49: 判定当前用户是否为访客。
    O v48: charts 仅包含调用方可访问的成员图表。
    O v49: 不读取用户名，仍返回访客身份。
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
    O v49: 依据访客令牌判定为访客，不依赖用户名。
  + EC-4 [edge] C=嵌入式访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=不读取用户名，按令牌判定为访客
  + EC-5 [edge] C=嵌入式访客令牌携带空用户名。 | A=调用 is_guest_user 判定当前用户。 | O=仍被识别为访客，不因用户名为空返回 False。
  + EC-6 [edge] C=启用 VIEWER_PROMISCUOUS_MODE | A=查看者访问仪表盘 | O=仅该仪表盘自身的图表与数据集请求被授权
  + EC-7 [edge] C=访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=依据访客令牌定义判定为访客，不依据用户名
  + EC-8 [edge] C=请求既无 JWT 也无 guest token，且发生在认证前路径（如错误清理）。 | A=调用 is_guest_user。 | O=捕获 NoAuthorizationError 并返回 False，不再向上抛出未处理异常。
  + HP-4 [happy] C=调用方对某仪表盘具有 promiscuous 仪表盘访问授权。 | A=GET /api/v1/dashboard/{id_or_slug}，响应包含 charts 字段。 | O=charts 返回该仪表盘全部成员图表，不再逐图表过滤。
  + HP-5 [happy] C=嵌入访客令牌携带空用户名。 | A=系统判断当前用户是否为访客。 | O=仍被识别为访客用户，不因用户名为空而误判。
  + HP-6 [happy] C=请求携带 guest token，其用户名为空或任意值。 | A=调用 is_guest_user 判定当前用户是否为访客。 | O=返回 True，正确识别为嵌入式访客。

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
  + ER-1 [error] C=凭据只有用户名或只有密码/私钥，或用户名为纯空白 | A=保存连接 | O=校验失败，凭据被拒绝
  + ER-2 [error] C=嵌入式访客私钥无法加载。 | A=嵌入式访客发起查询。 | O=拒绝该访客并提示检查嵌入式凭据中的私钥与口令。
  + HP-3 [happy] C=启用 EMBEDDED_SUPERSET 与 EMBEDDED_CREDENTIAL_FALLBACK，Snowflake 连接配置 OAuth2 客户端、开启模拟登录用户并保存嵌入式访客凭据 | A=嵌入式访客查询该连接上的图表 | O=查询以配置的专用数据库账号执行，结果使用独立缓存分区
  + HP-4 [happy] C=Snowflake 连接配置了嵌入式访客密钥对凭据。 | A=嵌入式访客发起查询。 | O=连接身份参数被清除，使用嵌入式私钥以密钥对方式登录。
  + HP-5 [happy] C=嵌入式仪表盘以访客身份加载，访客 username 为空或发生变化。 | A=加载嵌入式仪表盘。 | O=访客身份保持稳定，仪表盘正常渲染。
  + HP-6 [happy] C=嵌入式仪表盘以访客令牌访问 | A=访客用户名取任意值 | O=访客身份仍被正确识别，不依赖 username 值

## [KEPT/unaffected] 嵌入式访客回退凭据 [嵌入式访客回退凭据]
  逐字相同场景: EC-1, ER-1, HP-1

## [KEPT/unaffected] 数据导入导出 [数据导入导出]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2

## [CHANGED/affected] 数据库连接配置 [数据库连接配置]
  逐字相同场景: EC-1, ER-1, HP-1
  ~ EC-2(rewritten):
    C v48: 数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。
    C v49: Athena 连接既未提供 s3_staging_dir 也未提供 work_group。
    A v48: 构建该数据库引擎规范的 parameters_json_schema。
    A v49: 保存连接。
    O v48: 该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
    O v49: 连接参数校验提示需提供 s3_staging_dir 或 work_group。
  ~ HP-2(rewritten):
    C v48: 用户打开数据库连接配置表单。
    C v49: 管理员配置 Amazon Athena 连接。
    A v48: 查看表单字段。
    A v49: 在连接表单中填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、Schema、Work group。
    O v48: 表单按 FormFieldOrder 渲染，包含 embedded_credentials 嵌入式凭据字段。
    O v49: 表单按 Athena 动态参数 schema 渲染字段，AWS 密钥以密码输入框呈现并可保存。
  ~ HP-3(rewritten):
    C v48: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    C v49: 管理员更新一个已存在的数据库连接，请求体合法。
    A v48: 提交数据库连接配置。
    A v49: PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。
    O v48: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
    O v49: 返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
  ~ HP-4(rewritten):
    C v48: 管理员更新一个已存在的数据库连接，请求体合法。
    C v49: 用户打开数据库连接配置表单。
    A v48: PUT /api/v1/database/{pk}，请求体通过 DatabasePutSchema(database_id=pk) 校验。
    A v49: 查看表单字段。
    O v48: 返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回。
    O v49: 表单按 FormFieldOrder 渲染，包含 embedded_credentials 嵌入式凭据字段。
  ~ HP-5(rewritten):
    C v48: 用户在数据库连接弹窗中配置含私钥字段的连接
    C v49: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    A v48: 打开数据库连接配置弹窗并填写连接参数
    A v49: 提交数据库连接配置。
    O v48: 私钥类字段被正确识别与处理，连接配置可正常保存
    O v49: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
  ~ HP-6(rewritten):
    C v48: OAuth2 数据库连接需要携带客户端信息与嵌入式凭据
    C v49: 管理员配置 Athena 连接。
    A v48: 保存包含 oauth2_client_info 与 embedded_credentials 的连接参数
    A v49: 在连接表单填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、schema_name 与 work_group。
    O v48: 连接参数类型接受这两个可选字段，配置可正常提交
    O v49: 表单按动态 schema 渲染这些字段，AWS Secret Access Key 始终以密码输入呈现。
  + EC-3 [edge] C=数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。 | A=构建该数据库引擎规范的 parameters_json_schema。 | O=该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
  + EC-4 [edge] C=Athena 连接未填写 S3 query results location | A=查看该字段 | O=字段非必填，提示 Work Group 已设置结果位置时可留空
  + EC-5 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group。 | A=保存或校验连接参数。 | O=返回缺少 s3_staging_dir 与 work_group 的参数校验警告。
  + EC-6 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group | A=保存连接 | O=表单提示两者至少填一个
  + HP-10 [happy] C=管理员配置 Athena 连接 | A=在连接表单填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、schema_name、work_group | O=表单按动态参数 schema 渲染字段并提交连接参数
  + HP-7 [happy] C=管理员在 Athena 连接表单中填写 AWS Access Key ID、Secret、Region、S3 结果位置与 Work Group | A=提交连接配置 | O=参数按动态表单字段保存，AWS Secret 以密码框输入
  + HP-8 [happy] C=管理员配置 Athena 连接。 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 staging dir 与 work group。 | O=字段按 Athena 动态参数 schema 渲染并随连接参数提交。
  + HP-9 [happy] C=管理员配置 Amazon Athena 连接。 | A=在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录与 work group。 | O=表单按字段生成 SQLAlchemy URI 并保存连接。

## [CHANGED/affected] 数据源连接 [数据源连接]
  逐字相同场景: EC-1, EC-2, ER-1, ER-2, HP-1, HP-2
  ~ EC-3(rewritten):
    C v48: 用户导入图表包，包内包含与已有数据库 UUID 相同的数据库配置。
    C v49: Snowflake 会话 schema 与 PUBLIC 不同，查询使用 db..table 两段式名称。
    A v48: 执行图表导入。
    A v49: 解析该表引用。
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: 按 PUBLIC schema 解析，与引擎实际读取一致。
  ~ EC-4(rewritten):
    C v48: 用户导入仪表盘包，包内包含与已有数据库 UUID 相同的数据库配置，且未指定 overwrite_all。
    C v49: Athena 连接仅填写 Work Group 而未填写 S3 结果位置
    A v48: 执行仪表盘导入。
    A v49: 保存并测试连接
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: 连接可保存，查询结果位置由 Work Group 决定
  ~ EC-5(rewritten):
    C v48: 用户导入仪表盘包并同时指定覆盖与 overwrite_all。
    C v49: Athena 连接使用 VPC/PrivateLink 自定义主机名。
    A v48: 执行仪表盘导入。
    A v49: 从 URI 解析连接参数再重新生成 URI。
    O v48: 关联数据库按覆盖模式导入，schema 要求提供存储连接无法还原的密钥。
    O v49: 自定义主机与端口被原样保留，不被改写为标准区域主机。
  ~ HP-3(rewritten):
    C v48: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Amazon Athena 数据源。
    A v48: 提交创建数据库请求。
    A v49: 填写 AWS 凭据、Region、Schema 与 Work group 并保存。
    O v48: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
    O v49: 连接按 Athena 动态参数 schema 建立，可执行查询。
  ~ HP-4(rewritten):
    C v48: 用户创建 OAuth2 数据源连接，连接测试通过但权限同步时创建管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Athena 数据源。
    A v48: 提交创建数据库请求。
    A v49: 填写 work_group 而省略 s3_staging_dir。
    O v48: 数据库创建成功，不再因缺少 OAuth2 令牌返回 422；权限在首次设置访问时同步。
    O v49: 连接可保存，查询结果位置由工作组定义或使用托管结果。
  ~ HP-5(rewritten):
    C v48: 管理员更新一个已存在的数据库连接。
    C v49: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    A v48: 向数据库 PUT 接口提交请求体。
    A v49: 提交创建数据库请求。
    O v48: 请求体由 DatabasePutSchema(database_id=pk) 校验，合法时返回 200 与更新后的连接信息。
    O v49: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
  - 移除场景: ER-3, ER-4, ER-5, ER-6, ER-7, HP-6

## [CHANGED/unknown] 数据集列表管理 [数据集列表管理]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2
  ~ HP-3(rewritten):
    C v48: 用户需要复制虚拟数据集
    C v49: 用户删除被图表与仪表盘引用的数据集。
    A v48: 点击复制并输入新名称提交
    A v49: 打开删除确认弹窗。
    O v48: 虚拟数据集被复制且列表刷新
    O v49: 弹窗显示“is linked to N charts and M dashboards”的准确计数。
  ~ HP-4(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户需要复制虚拟数据集
    A v48: 打开导入弹窗并提交导入。
    A v49: 点击复制并输入新名称提交
    O v48: 导入弹窗识别加密文件额外字段并正常处理导入。
    O v49: 虚拟数据集被复制且列表刷新
  ~ HP-5(rewritten):
    A v48: 执行导入。
    A v49: 打开导入弹窗并提交导入。
    O v48: 导入流程识别加密文件额外字段并继续处理。
    O v49: 导入弹窗识别加密文件额外字段并正常处理导入。
  + EC-2 [edge] C=用户通过浏览器返回/前进切换数据集列表的排序、分页与搜索。 | A=使用浏览器历史导航。 | O=排序、分页与搜索作为同一 URL 状态恢复，表头与结果一致。
  + EC-3 [edge] C=用户通过浏览器后退回到之前的列表 URL，该 URL 无排序参数。 | A=触发历史导航。 | O=列表排序被清空，表头不再显示排序标记。
  + EC-4 [edge] C=批量选择中包含语义视图。 | A=打开批量归档确认。 | O=弹窗不承诺可恢复，保留输入 DELETE 的不可逆确认门槛。
  + EC-5 [edge] C=列表排序状态被外部恢复为空 | A=重新渲染列表 | O=表头排序指示被清除并与受控排序一致
  + HP-6 [happy] C=数据集被 2 个图表和 1 个仪表盘引用。 | A=查看删除确认弹窗。 | O=提示文案为“linked to 2 charts and 1 dashboard”。
  + HP-7 [happy] C=用户批量删除数据集前查看依赖影响。 | A=打开批量删除确认弹窗。 | O=弹窗列出受影响图表与仪表盘，并显示“linked to N charts and M dashboards”。
  + HP-8 [happy] C=用户删除被图表和仪表盘引用的数据集。 | A=打开删除确认弹窗。 | O=提示“is linked to N charts and M dashboards”，说明删除会破坏这些对象。
  + HP-9 [happy] C=用户删除被图表与仪表盘引用的数据集 | A=打开删除确认弹窗 | O=弹窗显示“linked to N charts and M dashboards”的关联数量

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
    C v49: 用户选择多个无依赖的语义视图
    A v48: 确认删除
    A v49: 确认批量删除
    O v48: 视图被删除
    O v49: 所选视图被删除
  - 移除场景: EC-3, EC-4, EC-5, EC-6, ER-3, HP-4, HP-5, HP-6, HP-7, HP-8

## [KEPT/unaffected] 语义视图批量添加 [语义视图批量添加]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1

## [KEPT/unaffected] 资产导入导出 [资产导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2

## [NEW 功能/not_in_gt] Amazon Athena 连接表单 [amazon athena 连接表单]
summary: 为 Amazon Athena 提供逐字段的动态连接表单，并在表单参数与 SQLAlchemy URI 之间双向转换。
  + [edge] EC-1: C=Athena 连接只填 work_group 不填 s3_staging_dir。 | A=校验连接参数。 | O=校验通过，不报告缺少结果位置。
  + [edge] EC-2: C=用户填写 Athena 连接参数并保存。 | A=提交连接配置。 | O=aws_access_key_id、aws_secret_access_key、region_name、s3_staging_dir、schema_name、work_group 
  + [edge] EC-3: C=用户创建 Amazon Athena 数据库连接 | A=不填写 region_name 直接提交表单 | O=表单校验失败，提示 region_name 为必填项
  + [edge] EC-4: C=用户编辑已有 Athena 连接且 URI 含 catalog_name、role_arn、endpoint_url 等额外查询参数 | A=在表单中修改 s3_staging_dir 后保存 | O=额外查询参数通过 query 字段往返保留，不被丢弃
  + [error] ER-1: C=Athena 连接未填 region_name。 | A=校验连接参数。 | O=返回缺少 region_name 的参数校验警告。
  + [happy] HP-1: C=管理员在连接表单中选择 Amazon Athena。 | A=填写 AWS Access Key ID、Secret、Region、默认 schema 与 S3 暂存目录。 | O=表单生成 awsathena+rest URI 并保存连接。
  + [happy] HP-2: C=管理员编辑已有 Athena 连接。 | A=打开连接表单。 | O=从 URI 解析出各字段，额外查询参数保留在 query 中不丢失。
  + [happy] HP-3: C=Athena 连接使用中国区区域代码。 | A=生成连接 URI。 | O=主机使用 .amazonaws.com.cn 后缀。
  + [happy] HP-4: C=用户在数据库连接弹窗中选择 Amazon Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单在 role 字段之后依次展示 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location
  + [happy] HP-5: C=用户在 Athena 连接表单中填写 S3 query results location。 | A=查看该字段的说明文案。 | O=显示提示「Optional if your workgroup sets a result location.」，说明 workgroup 已设置结果位置时该项可选。
  + [happy] HP-6: C=管理员在数据库连接页面选择 Amazon Athena 引擎。 | A=打开 Athena 连接配置表单。 | O=表单参数按动态 schema 渲染，可填写对应连接参数。
  + [happy] HP-7: C=用户创建 Amazon Athena 数据库连接 | A=在连接表单中填写 region_name 及可选的 aws_access_key_id、aws_secret_access_key、s3_staging_dir、schema_na | O=连接以结构化参数字段提交并成功创建，额外查询参数通过 query 字段保留

## [NEW 功能/not_in_gt] Athena 数据库连接表单 [athena 数据库连接表单]
summary: Athena 引擎提供动态连接表单参数，包括 AWS 凭证、区域、S3 查询结果位置、Schema 与 Work Group。
  + [edge] EC-1: C=Work Group 已配置查询结果位置 | A=不填写 S3 query results location | O=字段非必填，连接可保存
  + [error] ER-1: C=Athena 连接既未填写 S3 query results location 也未配置 Work Group 结果位置 | A=保存连接 | O=连接无法确定查询结果位置，保存或查询失败
  + [happy] HP-1: C=管理员新建 Athena 数据库连接 | A=打开动态表单 | O=按顺序渲染 AWS Access Key ID、AWS Secret Access Key、Region、S3 query results location、Schema、Work
  + [happy] HP-2: C=管理员填写 AWS Secret Access Key | A=在新增或编辑模式下输入密钥 | O=输入框为密码类型并带可见性切换
  + [happy] HP-3: C=管理员在数据库连接配置中选择 Amazon Athena 引擎。 | A=打开 Athena 连接表单。 | O=表单按动态参数 schema 展示 Athena 连接所需参数。
  + [happy] HP-4: C=管理员在 Superset 中新建或编辑 Athena 数据库连接。 | A=打开 Athena 连接表单并填写 AWS Access Key ID、AWS Secret Access Key、区域与 work group。 | O=表单展示并接受这些参数，连接配置可保存。

## [NEW 功能/not_in_gt] MCP 语义表字段重选 [mcp 语义表字段重选]
summary: MCP update_chart 对 table 与 interactive table 图表支持完整字段重选，要求提供目标视图全部成员列并显式给出过滤器，未验证的保留选择会被拒绝。
  + [edge] EC-1: C=语义提供方未声明选择身份版本。 | A=生成语义图表。 | O=不写入选择身份标记，避免伪造版本。
  + [edge] EC-2: C=更新请求只提供部分列或省略过滤器。 | A=调用 update_chart。 | O=请求被拒绝，提示需重选全部列并显式给出过滤器（[] 表示清空）。
  + [edge] EC-3: C=语义视图提供方未声明 selection_identity_version | A=新建语义视图图表 | O=不写入语义选择标记
  + [edge] EC-4: C=语义视图提供方未声明 selection identity 版本。 | A=生成图表。 | O=不写入虚构的身份标记。
  + [edge] EC-5: C=语义表需要重选但客户端只提供部分列。 | A=调用 update_chart。 | O=请求被拒绝，提示需重选全部列并显式给出过滤器。
  + [edge] EC-6: C=更新请求未提供 columns 字段 | A=调用 update_chart | O=返回不完整类别 columns，拒绝认证保留选择
  + [edge] EC-7: C=更新请求未提供 filters 字段 | A=调用 update_chart | O=返回不完整类别 filters，拒绝认证保留选择
  + [edge] EC-8: C=更新请求显式传入空过滤器列表 | A=调用 update_chart | O=视为清空过滤器，允许完成重选
  + [error] ER-1: C=图表保留的语义选择无法验证。 | A=调用 update_chart。 | O=拒绝更新并提示在 Explore 中恢复图表。
  + [error] ER-2: C=语义表图表保留未验证的旧字段选择 | A=调用 update_chart 未提供完整重选 | O=拒绝更新并提示通过 Explore 恢复
  + [error] ER-3: C=更新语义表图表时保留了未验证的旧选择。 | A=调用 update_chart。 | O=请求被拒绝，提示在 Explore 中恢复。
  + [error] ER-4: C=客户端保留未验证的语义选择。 | A=调用 update_chart。 | O=拒绝更新并提示在 Explore 中恢复。
  + [error] ER-5: C=保留的查询角色与重新映射的输入不一致 | A=调用 update_chart | O=返回对应类别（过滤器、排序、时间选择等）的不完整错误，提示在 Explore 中恢复
  + [error] ER-6: C=目标图表不是 table 或 ag-grid-table | A=调用 update_chart 进行重选 | O=返回 unsupported saved chart type，拒绝重选
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表字段选择被完整重建并保存。
  + [happy] HP-10: C=用户通过 MCP 生成语义视图图表 | A=调用 generate_chart 指定 view_id 与配置 | O=form_data 被写入当前语义选择版本标记
  + [happy] HP-2: C=新建语义图表。 | A=调用 generate_chart 或生成 Explore 链接。 | O=新选择的成员被打上当前选择身份标记，不沿用已保存图表的旧选择。
  + [happy] HP-3: C=语义表图表的语义选择标记缺失或过期 | A=调用 update_chart 并提供目标视图全部成员列与显式过滤器 | O=图表字段选择被完整重选并更新
  + [happy] HP-4: C=通过 generate_chart 或 generate_explore_link 新建语义视图图表 | A=提交请求 | O=新选择的成员被打上语义选择标记
  + [happy] HP-5: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并提供目标视图全部成员列与显式过滤器。 | O=图表更新成功，写入新的 selection identity 标记。
  + [happy] HP-6: C=MCP 生成图表时选择语义视图成员。 | A=调用 generate_chart。 | O=新选择被标记为当前 selection identity 版本。
  + [happy] HP-7: C=MCP 客户端更新一个语义选择标记缺失或过期的表图表。 | A=调用 update_chart 并提供目标视图全部成员列与显式过滤器。 | O=图表更新成功，语义选择标记被重新写入。
  + [happy] HP-8: C=MCP 客户端生成新的语义视图图表。 | A=调用 generate_chart。 | O=新选择的成员被打上语义选择标记，未版本化的提供方不写入标记。
  + [happy] HP-9: C=用户通过 MCP 更新一个语义表图表并重选全部列 | A=调用 update_chart 提供目标视图全部成员列与显式过滤器 | O=图表更新成功，新选择被标记为当前语义选择版本

## [NEW 功能/not_in_gt] MCP 语义表重选 [mcp 语义表重选]
summary: MCP 的 update_chart 支持对语义表图表进行完整字段重选，过时选择被拒绝并提示恢复路径。
  + [edge] EC-1: C=语义表图表存在无法验证的保留选择。 | A=调用 update_chart 但未提供完整列重选。 | O=请求被拒绝并提示通过 Explore 恢复。
  + [edge] EC-2: C=调用方希望清空语义表图表的过滤器。 | A=在 update_chart 中显式传入空过滤器列表。 | O=过滤器被清空，而非保留旧值。
  + [edge] EC-3: C=语义视图的 selection_identity_version 不是字符串（如为 None）。 | A=调用 stamp_new_semantic_selections。 | O=form_data 不写入 semantic_selection_version，后续校验按无版本标记处理。
  + [edge] EC-4: C=模型表单数据含 filters 等成员键但无 semantic_selection_sources，而作用域含来源记录。 | A=合并 extra_form_data。 | O=为该无来源输入追加 datasource 为空、version 为 None 的来源记录，避免被后续版本化输入认证。
  + [error] ER-1: C=语义视图不存在或调用方无权访问。 | A=调用 update_chart 重选字段。 | O=返回 view_not_found 错误，不暴露视图元数据。
  + [error] ER-2: C=用户更新图表时，语义表已过时且未重新选择全部列或未显式指定过滤器。 | A=调用 UpdateChartRequest 更新图表配置。 | O=请求被拒绝，返回 Explore 恢复指引，提示需重新选择所有列并用 [] 显式清空过滤器。
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过时。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表字段选择被完整重建并保存。
  + [happy] HP-2: C=调用 generate_chart 或 generate_explore_link 为语义视图新建图表。 | A=提交语义视图配置。 | O=新选择被打上语义选择标识，不沿用已保存图表的旧选择。
  + [happy] HP-3: C=用户在 MCP 中需要更换已选语义表。 | A=执行完整的语义表重选。 | O=语义表选择被完整替换并生效。
  + [happy] HP-4: C=用户在 MCP 语义层中重新选择语义表 | A=执行完整语义表重选 | O=语义表按新选择完整替换
  + [happy] HP-5: C=用户通过 MCP 为语义视图生成图表，语义视图的 selection_identity_version 为字符串。 | A=调用 generate_chart 并指定语义视图目标。 | O=form_data 被写入 semantic_selection_version，随后通过语义视图 form_data 校验并继续生成图表。
  + [happy] HP-6: C=图表生成请求同时带有缓存 extra_form_data 与请求级 extra_form_data，且包含语义选择来源。 | A=执行 merge_extra_form_data 合并两份 extra_form_data。 | O=合并结果包含合并后的 semantic_selection_sources 列表。
  + [happy] HP-7: C=通过 MCP 更新图表并重选语义表，仪表盘作用域与模型表单数据均含 semantic_selection_sources。 | A=调用 update_chart 并合并 extra_form_data。 | O=合并结果保留各输入的来源记录，semantic_selection_sources 写入 composed 表单数据。
  + [happy] HP-8: C=为语义视图生成 Explore 链接。 | A=调用 generate_explore_link 生成链接。 | O=form_data 在设置 datasource 后被标记新语义选择，并通过校验生成链接。
  + [happy] HP-9: C=用户在 MCP 中需要重新选择语义表。 | A=执行语义表重选。 | O=可完整重选语义表集合。

## [NEW 功能/not_in_gt] 仪表盘版本恢复 [仪表盘版本恢复]
summary: 在恢复仪表盘历史版本前统计并提示将被移除的当前成员图表，恢复本身不删除图表。
  + [edge] EC-1: C=当前成员包含已归档或未放置的图表。 | A=打开恢复确认弹窗。 | O=计数包含这些成员，因为它们仍属于仪表盘并可被移除。
  + [edge] EC-2: C=弹窗打开后其他用户修改了仪表盘成员。 | A=用户确认恢复。 | O=计数为建议值，实际恢复按确认时的成员执行。
  + [error] ER-1: C=获取恢复影响计数失败。 | A=打开恢复确认弹窗。 | O=弹窗仍可展示恢复操作，不因计数失败阻塞恢复。
  + [happy] HP-1: C=用户选择某个仪表盘历史版本并点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并说明恢复会将其从仪表盘移除但不删除图表。
  + [happy] HP-2: C=目标版本与当前成员完全一致。 | A=打开恢复确认弹窗。 | O=移除数量为 0，不显示移除警告。

## [NEW 功能/not_in_gt] 最近归档列表 [最近归档列表]
summary: 集中展示已软删除的图表、仪表盘与数据集，支持按类型切换、搜索、时间范围筛选、恢复与永久删除。
  + [edge] EC-1: C=用户只有读权限。 | A=查看归档行。 | O=不显示恢复与永久删除操作，悬停提示需先恢复才能打开。
  + [edge] EC-2: C=用户在图表类型下按名称排序后切换到仪表盘类型。 | A=切换 Type 选择器。 | O=排序与分页参数被清空，新类型使用自身默认排序。
  + [error] ER-1: C=恢复请求返回 404（对象已被他人恢复）。 | A=点击恢复。 | O=显示失败提示，页面不崩溃，行保留。
  + [error] ER-2: C=永久删除数据集时依赖影响已变化。 | A=提交 purge。 | O=返回 409 purge_impact_changed，弹窗展示新的影响并要求重新确认。
  + [happy] HP-1: C=用户打开最近归档页面。 | A=浏览已归档的图表、仪表盘或数据集。 | O=列表按归档时间倒序展示名称、类型、归档时间与归档人。
  + [happy] HP-2: C=用户对某归档项有写权限。 | A=点击恢复。 | O=调用对应类型 restore 接口，成功后刷新列表并显示带链接的成功提示。
  + [happy] HP-3: C=用户对归档数据集执行永久删除。 | A=打开永久删除弹窗并确认。 | O=先获取 purge-impact，再提交带 impact_token 的 purge 请求，成功后刷新列表。

## [NEW 功能/not_in_gt] 列表排序与历史状态 [列表排序与历史状态]
summary: 列表视图的排序、分页与筛选状态与 URL 历史保持同步，受控排序可被清空。
  + [edge] EC-1: C=卡片视图排序选择与当前排序不一致。 | A=排序状态变化。 | O=排序选择组件按新排序重建并显示正确选项。
  + [edge] EC-2: C=调用方未传入 sortBy | A=渲染 TableCollection | O=sortBy 为 undefined，列排序状态映射按无排序处理，组件正常渲染
  + [edge] EC-3: C=URL 中的排序与当前排序一致。 | A=query 恢复逻辑执行。 | O=不触发多余的排序更新，列表保持当前排序。
  + [error] ER-1: C=筛选配置引用了不存在的列。 | A=渲染列表视图。 | O=抛出 ListViewError 提示筛选配置无效。
  + [happy] HP-1: C=用户在列表第 3 页应用筛选后点击浏览器后退。 | A=触发历史导航。 | O=页码、筛选与请求参数一并恢复。
  + [happy] HP-2: C=列表使用受控排序，URL 恢复为空排序。 | A=重新渲染表格。 | O=表头排序标记被清除。
  + [happy] HP-3: C=调用方渲染 TableCollection 并传入 sortBy 排序规则数组 | A=组件通过 mapColumns 映射列 | O=列头按传入的 sortBy 显示对应排序状态
  + [happy] HP-4: C=用户通过带排序参数的 URL 打开列表视图，当前内存中的排序与 URL 不同。 | A=query 恢复逻辑执行，检测到 initialSortBy 与 sortBy 不等。 | O=列表按 URL 中的排序条件重新排序并加载数据。

## [NEW 功能/not_in_gt] 列表排序状态 [列表排序状态]
summary: 列表视图与表格集合支持受控排序，排序状态与 URL 历史同步。
  + [edge] EC-1: C=受控排序被外部重置为空排序。 | A=重新渲染表格。 | O=表头排序指示被清除。
  + [edge] EC-2: C=用户通过浏览器返回/前进恢复列表状态。 | A=使用历史导航。 | O=排序、分页与搜索作为同一 URL 状态恢复。
  + [edge] EC-3: C=用户切换类型后按浏览器返回。 | A=点击浏览器后退。 | O=回到切换前的类型与排序/分页状态。
  + [happy] HP-1: C=用户点击可排序列表的表头。 | A=切换排序方向。 | O=列表按所选列排序并重新请求数据。
  + [happy] HP-2: C=用户在列表视图表格中点击列头改变排序。 | A=排序状态 sortBy 更新并传入 TableCollection。 | O=对应列显示正确的升序/降序排序指示。
  + [happy] HP-3: C=用户在卡片视图切换排序选项。 | A=sortBy 变化导致 CardSortSelect 以新 key 重建。 | O=卡片排序选择器显示与当前排序一致的值。
  + [happy] HP-4: C=用户在最近归档列表中已按名称排序并翻到第 4 页。 | A=切换归档对象类型。 | O=URL 中 sortColumn、sortOrder、pageIndex 被清除，新类型列表从默认排序与第一页展示，且浏览器历史新增一条记录。

## [NEW 功能/not_in_gt] 列表视图排序状态 [列表视图排序状态]
summary: 列表视图的排序、分页与搜索状态与 URL 同步，受控排序可被外部重置。
  + [edge] EC-1: C=受控排序被外部重置为空。 | A=重新渲染 TableCollection。 | O=列头排序指示被清除。
  + [happy] HP-1: C=用户在列表视图点击可排序列头。 | A=点击列头。 | O=排序状态更新并重新请求数据。
  + [happy] HP-2: C=浏览器历史前进或后退。 | A=切换历史记录。 | O=排序、分页与搜索作为同一 URL 状态被恢复。

## [NEW 功能/not_in_gt] 归档恢复提示 [归档恢复提示]
summary: 归档成功提示中的恢复链接保持到用户关闭，并遵循部署 URL 前缀。
  + [edge] EC-1: C=提示文本包含 HTML 链接。 | A=等待提示时长结束。 | O=提示不自动关闭，直到用户点击关闭或操作。
  + [error] ER-1: C=用户在归档列表切换对象类型筛选。 | A=执行筛选。 | O=浏览器历史新增一条记录，后退可回到上一筛选。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=查看成功提示。 | O=提示包含指向归档列表的恢复链接，且不会自动消失。
  + [happy] HP-2: C=部署配置了 URL 前缀。 | A=点击提示中的恢复链接。 | O=链接包含部署前缀，正确跳转到归档列表。

## [NEW 功能/not_in_gt] 版本历史恢复 [版本历史恢复]
summary: 在版本历史中恢复图表或仪表盘版本，恢复前提示仪表盘将移除的图表数量，并支持从版本创建新对象。
  + [edge] EC-1: C=恢复影响计数请求失败。 | A=打开恢复确认弹窗。 | O=弹窗警告移除数量未知，仍可继续恢复。
  + [edge] EC-2: C=恢复确认弹窗打开期间其他用户修改了仪表盘成员。 | A=用户确认恢复。 | O=计数为检查时的快照，实际移除以恢复时状态为准。
  + [edge] EC-3: C=恢复影响计数请求尚未返回 | A=查看恢复确认弹窗 | O=显示“Checking which charts will be removed…”，恢复按钮禁用
  + [edge] EC-4: C=用户在计数返回前切换到另一个版本 | A=旧请求随后返回 | O=过期响应被忽略，不显示旧版本的移除数量
  + [edge] EC-5: C=目标版本包含当前全部成员图表。 | A=打开恢复确认弹窗。 | O=不显示移除警告。
  + [error] ER-1: C=版本历史功能未启用。 | A=请求版本列表或恢复接口。 | O=返回 404。
  + [error] ER-2: C=恢复影响计数请求失败或超时 | A=查看恢复确认弹窗 | O=提示无法检查将移除的图表，恢复按钮仍可用
  + [error] ER-3: C=恢复影响计数请求失败。 | A=打开恢复确认弹窗。 | O=弹窗仍可打开，不阻塞恢复流程。
  + [happy] HP-1: C=用户打开仪表盘版本历史并选择旧版本恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并警告恢复会移除这些图表但不删除图表本身。
  + [happy] HP-2: C=用户确认恢复仪表盘旧版本。 | A=点击 Restore。 | O=仪表盘回退到所选版本，被移除的图表仍保留在图表列表中。
  + [happy] HP-3: C=用户对仪表盘旧版本点击恢复 | A=打开恢复确认弹窗 | O=弹窗显示将移除的图表数量，并说明图表本身不会被删除
  + [happy] HP-4: C=当前仪表盘成员均存在于目标版本 | A=打开恢复确认弹窗 | O=不显示移除警告，恢复按钮可用
  + [happy] HP-5: C=用户对图表版本点击恢复 | A=打开恢复确认弹窗 | O=不请求仪表盘成员计数，不显示移除警告
  + [happy] HP-6: C=用户打开仪表盘版本历史并选择恢复某版本。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并警告恢复会将其从仪表盘移除但不删除图表。
  + [happy] HP-7: C=用户确认恢复仪表盘版本。 | A=点击恢复。 | O=仪表盘恢复到所选版本，被移除的图表本身仍保留。

## [NEW 功能/not_in_gt] 版本历史恢复提示 [版本历史恢复提示]
summary: 仪表盘恢复前统计并提示将因恢复而移除的当前成员图表数量。
  + [edge] EC-1: C=恢复影响计数请求失败。 | A=打开恢复确认弹窗。 | O=弹窗仍可打开，不因计数失败阻止恢复。
  + [error] EC-2: C=恢复影响接口返回的 removed_chart_count 缺失或不是非负整数。 | A=打开恢复确认弹窗触发影响数量查询。 | O=fetchDashboardRestoreRemovalCount 抛出 Invalid restore impact response 错误，不展示无效数量。
  + [edge] EC-3: C=恢复目标实体不是 dashboard，或缺少 entityUuid/versionUuid。 | A=打开恢复确认弹窗。 | O=不发起恢复影响查询，impact 状态被清空，弹窗不展示移除图表数量。
  + [happy] HP-1: C=用户选择某个仪表盘版本并点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并警告恢复将移除这些图表。
  + [happy] HP-2: C=目标版本包含当前全部成员图表。 | A=打开恢复确认弹窗。 | O=移除数量为 0，不显示移除警告。
  + [happy] HP-3: C=用户选择恢复仪表盘的某个历史版本，该版本与当前版本图表集合不同。 | A=确认恢复操作。 | O=恢复前显示警告，列出将被移除的图表。
  + [happy] HP-4: C=用户在仪表盘版本历史中选中一个历史版本并触发恢复。 | A=打开恢复确认弹窗。 | O=弹窗通过 GET /api/v1/dashboard/{uuid}/versions/{versionUuid}/?include_restore_impact=true 获取 r
  + [happy] HP-5: C=用户在版本历史中先选择版本 A 打开恢复确认，再改为版本 B。 | A=切换恢复目标版本。 | O=确认弹窗按新目标重新挂载，展示版本 B 的信息且不残留版本 A 的状态。
  + [happy] HP-6: C=用户恢复仪表盘历史版本且该版本会移除现有图表 | A=触发版本恢复 | O=恢复前显示移除图表的警告提示
  + [happy] HP-7: C=用户从版本历史恢复一个不含当前部分图表的仪表盘版本。 | A=触发恢复操作。 | O=在恢复前显示将移除图表的警告。

## [NEW 功能/not_in_gt] 访客身份与截图缓存 [访客身份与截图缓存]
summary: 嵌入访客的身份识别不依赖用户名，截图缓存按访客隔离。
  + [edge] EC-1: C=非访客用户请求截图。 | A=生成截图缓存键。 | O=不附加访客键，缓存键与原有行为一致。
  + [edge] EC-2: C=THUMBNAIL_EXECUTORS 不含 CURRENT_USER 且执行器无法解析。 | A=生成缩略图摘要。 | O=返回 None，不生成摘要。
  + [happy] HP-1: C=嵌入访客令牌携带空用户名。 | A=系统判断当前用户是否为访客。 | O=仍被识别为访客，其 RLS 规则进入缩略图摘要。
  + [happy] HP-2: C=两个不同访客请求同一仪表盘截图。 | A=生成截图缓存键。 | O=缓存键按访客键区分，不互相复用。
  + [happy] HP-3: C=嵌入式访客的 guest token 用户名为空，THUMBNAIL_EXECUTORS 含 CURRENT_USER。 | A=生成仪表盘或图表缩略图摘要。 | O=以 guest.username 作为执行器计算摘要，访客的行级安全规则进入摘要。

## [NEW 功能/not_in_gt] 软删除归档 [软删除归档]
summary: 启用软删除后，删除的图表、仪表盘与数据集进入 Recently Archived，可恢复或永久删除。
  + [edge] EC-1: C=用户查看图表或仪表盘卡片但无编辑权限。 | A=按 Tab 聚焦 More Options 按钮。 | O=在不打开菜单的情况下读出编辑或归档不可用的原因。
  + [error] ER-1: C=图表被告警或报告引用。 | A=尝试归档该图表。 | O=归档被拒绝并列出依赖的告警与报告。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=确认归档。 | O=成功提示包含指向 Recently Archived 的恢复链接，链接遵循部署 URL 前缀。
  + [happy] HP-2: C=归档成功提示包含 HTML 链接。 | A=用户悬停或通过键盘聚焦该通知。 | O=通知保持打开直到被显式关闭。
  + [happy] HP-3: C=用户在 Recently Archived 页面切换对象类型。 | A=选择 Chart、Dashboard 或 Dataset。 | O=URL 通过 push 更新，浏览器返回可回到上一类型与分页。

## [NEW 功能/not_in_gt] 软删除归档体验 [软删除归档体验]
summary: 归档与恢复提示、数据集删除影响文案、归档列表历史导航与键盘可达性。
  + [edge] EC-1: C=用户使用键盘操作图表或仪表盘卡片的更多操作菜单。 | A=按 Tab 键。 | O=焦点先到达权限提示再进入菜单，关闭菜单后焦点返回更多操作按钮。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=确认归档。 | O=成功提示包含指向 Recently Archived 的恢复链接，链接遵循部署 URL 前缀。
  + [happy] HP-2: C=归档成功提示包含 HTML 链接。 | A=等待提示自动消失。 | O=含链接的通知保持打开直到用户关闭，悬停或键盘聚焦时也不消失。
  + [happy] HP-3: C=用户在归档列表中切换对象类型。 | A=选择另一类型。 | O=浏览器历史新增一条记录，后退可回到上一类型。

## [NEW 功能/not_in_gt] 软删除归档提示 [软删除归档提示]
summary: 归档操作使用共享文案与可恢复提示，带链接的通知保持可见直至用户关闭。
  + [edge] EC-1: C=数据集删除确认弹窗展示依赖计数 | A=查看弹窗文案 | O=显示“is linked to N charts and M dashboards”
  + [edge] EC-2: C=软删除特性关闭，非图表编辑者打开图表卡片的更多操作菜单。 | A=悬停或聚焦到删除菜单项。 | O=提示文案使用 delete 语义而非 archive 语义。
  + [error] ER-1: C=非编辑者打开图表或仪表盘卡片菜单 | A=聚焦菜单按钮或悬停禁用项 | O=显示需编辑权限才能编辑/归档（或删除）的提示，操作不执行
  + [happy] HP-1: C=用户归档图表或仪表盘 | A=确认归档 | O=成功提示包含指向 Recently Archived 的链接，链接使用部署 URL 前缀
  + [happy] HP-2: C=归档成功提示包含 HTML 链接 | A=等待超过 toast 默认时长 | O=提示保持可见，直到用户显式关闭
  + [happy] HP-3: C=软删除特性开启，非图表编辑者打开图表卡片的更多操作菜单。 | A=悬停或聚焦到编辑/归档菜单项。 | O=菜单项处于禁用状态，并提示需要图表编辑者权限才能编辑或归档。
  + [happy] HP-4: C=图表编辑者打开图表卡片的更多操作菜单。 | A=点击编辑菜单项。 | O=打开图表编辑弹窗，且不显示权限提示。
  + [happy] HP-5: C=部署配置了应用根路径，用户恢复一个已归档对象。 | A=恢复成功。 | O=成功提示中的“查看”链接指向带应用根路径的正确地址。
  + [happy] HP-6: C=用户在数据集列表删除一个被图表和仪表盘引用的数据集（非软删除模式）。 | A=打开删除确认弹窗。 | O=弹窗显示“is linked to N charts and M dashboards”的依赖描述及计数。
  + [happy] HP-7: C=用户查看软删除归档列表 | A=使用键盘导航归档项 | O=归档提示与计数正确显示，键盘可聚焦并操作归档项
  + [happy] HP-8: C=用户对资产执行软删除归档操作。 | A=完成归档。 | O=显示归档提示，计数与历史记录正确更新，键盘用户可操作相关控件。

## [NEW 功能/not_in_gt] 通知与键盘可达性 [通知与键盘可达性]
summary: 带链接或操作的通知保持到用户关闭，卡片菜单的权限提示可通过键盘到达。
  + [edge] EC-1: C=用户从菜单按 Tab 返回。 | A=按 Tab 键。 | O=焦点回到 More Options 按钮。
  + [edge] EC-2: C=用户使用键盘聚焦到列表项的更多操作（Kebab）按钮。 | A=按钮获得焦点。 | O=显示 tooltip 提示，且可通过键盘打开下拉菜单。
  + [happy] HP-1: C=归档成功提示包含 HTML 链接。 | A=等待提示自动消失时间。 | O=提示保持显示直到用户关闭。
  + [happy] HP-2: C=用户使用键盘浏览图表或仪表盘卡片。 | A=按 Tab 键。 | O=焦点先到达权限提示，再到达更多操作菜单。
  + [happy] HP-3: C=系统展示一条 allowHtml 且文本包含 <a 链接的成功通知。 | A=用户阅读通知并准备激活链接。 | O=通知不会在 duration 到期后自动消失，用户可从容激活链接。
  + [happy] HP-4: C=系统展示一条无 action、无链接且 duration>0 的普通通知。 | A=用户不进行任何操作。 | O=通知在 duration 到期后自动关闭。
