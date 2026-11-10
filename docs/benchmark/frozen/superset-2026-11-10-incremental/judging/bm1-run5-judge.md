
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
  + EC-2 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=不计算恢复影响，响应不含移除数量
  + EC-3 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=响应不包含恢复影响计数
  + EC-4 [edge] C=调用方未传 include_restore_impact | A=GET 仪表盘版本详情 | O=不计算恢复影响，响应保持原有结构
  + HP-2 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true。 | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/。 | O=响应附带恢复将移除的当前成员图表数量。
  + HP-3 [happy] C=调用方请求仪表盘版本详情并传入 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应附带恢复将移除的图表数量
  + HP-4 [happy] C=调用方请求仪表盘版本详情并附带 include_restore_impact=true | A=GET /api/v1/dashboard/{uuid}/versions/{version_uuid}/ | O=响应 result 中包含 _restore_impact.removed_chart_count 计数

## [CHANGED/affected] SQL 编辑器 [sql 编辑器]
  逐字相同场景: ER-1, HP-1, HP-2
  + EC-1 [edge] C=SQL Lab 查询引用无 schema 的非限定表，且该表在默认 schema 或搜索路径中被 RLS 或拒绝名单命中。 | A=执行查询或估算查询成本。 | O=按引擎大小写折叠规则解析表引用并应用 RLS 与拒绝名单。
  + EC-2 [edge] C=查询估算引用无 schema 的非限定表且该表在禁用列表中 | A=执行查询估算 | O=表被识别为禁用表并拒绝
  + EC-3 [edge] C=SQL Lab 查询引用无 schema 的非限定表，且该表在默认 schema 或 search path 中命中 RLS 或表黑名单 | A=执行查询或查询估算 | O=RLS 谓词被注入或表被拒绝
  + EC-4 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表在默认 schema 或搜索路径中命中 RLS 或表黑名单 | A=执行查询 | O=按默认 schema 与搜索路径匹配并应用 RLS 与表黑名单
  + EC-5 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表有 RLS 过滤器 | A=执行查询 | O=按引擎折叠规则匹配表并注入 RLS 谓词
  + EC-6 [edge] C=SQL Lab 查询引用无 schema 的非限定表且该表在表黑名单中 | A=执行查询 | O=查询被拒绝
  + ER-2 [error] C=成本估算引用了被拒绝的表或函数。 | A=请求成本估算。 | O=返回对应的拒绝错误，不执行估算。
  + ER-3 [error] C=用户执行引用未带 schema 且位于表黑名单中的表的 SQL 查询。 | A=在 SQL Lab 中运行该查询。 | O=安全检查识别该表并拒绝执行，返回安全异常。
  + HP-3 [happy] C=SQL Lab 查询引用无 schema 的非限定表且该表有 RLS 规则 | A=执行查询 | O=RLS 谓词被注入到该表
  + HP-4 [happy] C=用户在 SQL Lab 对查询执行成本估算，且 RLS_IN_SQLLAB 已启用。 | A=请求成本估算。 | O=估算前注入 RLS 谓词，估算结果反映受限查询。
  + HP-5 [happy] C=用户执行引用未带 schema 表的 SQL 查询，且该表在连接搜索路径下受 RLS 约束。 | A=在 SQL Lab 中运行该查询。 | O=RLS 谓词按解析出的表 schema 注入，查询结果仅包含用户有权访问的数据。

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
    A v49: 访客请求仪表盘或图表数据。
    O v48: 该图表保存为缺失图表占位，布局其余部分正常保存
    O v49: 访客身份仍被正确识别，不因用户名为空而误判为非访客。
  ~ EC-4(rewritten):
    C v48: 调用方没有宽松仪表盘访问权限。
    C v49: 仪表盘卡片用户无编辑权限
    A v48: GET 仪表盘详情。
    A v49: 用键盘聚焦卡片菜单
    O v48: 响应 charts 字段仅包含 can_access_chart 通过的成员图表。
    O v49: 先读到编辑权限提示，再打开菜单
  + EC-5 [edge] C=其中一个输入带有 semantic_selection_sources，另一个输入无 provenance 但包含 filters 等语义选择成员键。 | A=调用 compose_extra_form_data 组合两者。 | O=组合结果的 semantic_selection_sources 包含已有来源记录，并为无 provenance 的输入追加 {"datasource": "", "version": None} 记录。
  + EC-6 [edge] C=模型额外表单数据中显式携带 semantic_selection_sources 键。 | A=调用 compose_extra_form_data 组合作用域与模型数据。 | O=该键不参与普通值合并，而是经 merge_semantic_selection_sources 合并后写入组合结果。
  + ER-1 [error] C=访客请求未授权的仪表盘图表数据 | A=发起请求 | O=请求被拒绝
  + ER-2 [error] C=访客令牌携带空用户名 | A=访客访问仪表盘 | O=仍被识别为嵌入访客并按访客身份授权
  + HP-3 [happy] C=嵌入式访客令牌携带空用户名 | A=访客请求仪表盘缩略图 | O=访客被正确识别并按自身键生成摘要
  + HP-4 [happy] C=仪表盘作用域与模型额外表单数据均不含 semantic_selection_sources。 | A=调用 compose_extra_form_data 组合两者。 | O=组合结果不包含 semantic_selection_sources，载荷保持未版本化。

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
    C v49: CI 下载 RAT jar 时首次请求失败
    A v48: 触发 labeler 工作流。
    A v49: 运行 check_license.sh
    O v48: PR 被自动添加 i18n:catalan 标签。
    O v49: curl 按重试参数重试下载，成功后继续许可证检查
  ~ HP-5(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ar/** 的 PR。
    C v49: 运行 check_license.sh 且本地尚无 RAT jar，网络正常。
    A v48: 触发 labeler 工作流。
    A v49: 脚本通过 curl 下载 apache-rat jar。
    O v48: PR 被自动打上 i18n:arabic 标签。
    O v49: 下载成功后 jar 被移动到目标路径，许可证检查继续执行。
  ~ HP-6(rewritten):
    C v48: 贡献者提交仅修改 superset/translations/ca/** 的 PR。
    C v49: CI 执行后端环境搭建与许可证检查。
    A v48: 触发 labeler 工作流。
    A v49: 运行 CI 流水线。
    O v48: PR 被自动打上 i18n:catalan 标签。
    O v49: setup-uv 使用允许列表版本，RAT jar 下载失败时自动重试。
  + EC-2 [edge] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败时返回非零状态。
  + EC-3 [edge] C=下载 RAT jar 时出现瞬时网络错误或 HTTP 错误。 | A=curl 以 --retry 5 --retry-all-errors --retry-delay 3 重试下载。 | O=在重试次数内恢复则下载成功；持续失败则脚本报错并提示手动安装。
  + ER-2 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 以失败重试方式重新下载，成功后继续校验
  + ER-3 [error] C=下载 RAT jar 时网络短暂失败。 | A=运行 check_license.sh。 | O=curl 以 --retry 5 --retry-all-errors 重试下载，失败时输出错误信息。
  + ER-4 [error] C=下载 RAT jar 时网络短暂失败 | A=运行 check_license.sh | O=curl 按重试策略重新下载，成功后继续许可证检查
  + ER-5 [error] C=RAT jar 下载最终失败或文件损坏。 | A=脚本执行 unzip -tq 校验 jar。 | O=校验失败时删除 jar 与 .part 文件并以退出码 255 结束，提示手动安装。

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
    C v49: 安装 MCP 相关可选依赖
    A v48: 解析并安装 pyarrow。
    A v49: 解析 fastmcp 版本
    O v48: 安装的 pyarrow 版本不低于修复版本，不含 CVE-2026-111497。
    O v49: 安装 4.1.4 及以上、5.0 以下版本
  ~ HP-4(rewritten):
    C v48: 在干净环境中安装 Superset 依赖。
    C v49: 开发环境安装依赖
    A v48: 解析 pyarrow 依赖约束。
    A v49: 解析开发依赖锁定
    O v48: 安装的 pyarrow 版本不低于 26.0.1 且低于 27，锁定为 26.0.1。
    O v49: fastmcp 与 fastmcp-slim 锁定为 4.1.6
  ~ HP-5(rewritten):
    C v48: 安装项目依赖
    C v49: 用户按 pyproject.toml 或 requirements 安装 Superset 依赖。
    A v48: 解析 pyarrow 版本
    A v49: 执行依赖安装/解析。
    O v48: 不再解析到含 CVE-2026-111497 的 pyarrow 版本
    O v49: pyarrow 被解析并锁定为 26.0.1（>=26.0.1,<27），不再接受 26.0.0。
  + HP-6 [happy] C=安装 fastmcp 可选依赖 | A=解析 fastmcp 版本 | O=安装 4.1.4 及以上、低于 5.0 的版本
  + HP-7 [happy] C=安装 fastmcp 可选依赖 | A=解析 fastmcp 版本 | O=安装 4.1.4 及以上、5.0 以下版本
  + HP-8 [happy] C=开发或测试环境安装依赖。 | A=安装开发依赖。 | O=使用 fastmcp 4.1.4 版本。

## [CHANGED/affected] 安全角色与认证 [安全角色与认证]
  逐字相同场景: EC-2, ER-1, ER-2, HP-1, HP-2
  ~ EC-1(rewritten):
    C v48: 启用 ENABLE_VIEWERS 与 VIEWER_PROMISCUOUS_MODE
    C v49: 嵌入式访客令牌的用户名为空。
    A v48: 查看者访问已发布仪表盘及其图表、数据集请求
    A v49: 调用 is_guest_user 判定当前用户。
    O v48: 仅已列出的查看者在查看该仪表盘时免数据集权限读取
    O v49: 仍返回访客身份，不读取用户名。
  ~ EC-3(rewritten):
    C v48: 调用方不具备 promiscuous 仪表盘授权。
    C v49: 启用 ENABLE_VIEWERS 与 VIEWER_PROMISCUOUS_MODE
    A v48: GET /api/v1/dashboard/{id_or_slug}。
    A v49: 查看者访问已发布仪表盘及其图表、数据集请求
    O v48: charts 仅包含调用方可访问的成员图表。
    O v49: 仅已列出的查看者在查看该仪表盘时免数据集权限读取
  ~ HP-3(rewritten):
    C v48: 调用方对某仪表盘具有 promiscuous 仪表盘访问授权。
    C v49: 嵌入式访客令牌携带空用户名
    A v48: GET /api/v1/dashboard/{id_or_slug}，响应包含 charts 字段。
    A v49: 判定当前用户是否为访客
    O v48: charts 返回该仪表盘全部成员图表，不再逐图表过滤。
    O v49: 依据访客令牌判定为访客，不依赖用户名
  + EC-4 [edge] C=嵌入式访客令牌携带空用户名 | A=调用 is_guest_user 判定当前用户 | O=仍被识别为访客用户，不因用户名为空返回 False
  + EC-5 [edge] C=嵌入式访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=仍被识别为访客，不因用户名为空而返回否
  + EC-6 [edge] C=访客令牌的用户名为空 | A=判定当前用户是否为访客 | O=依据用户对象与令牌判定为访客，不因用户名为空返回否
  + HP-4 [happy] C=嵌入式访客令牌携带空用户名。 | A=系统判定当前用户是否为访客。 | O=仍被正确识别为访客，不依赖用户名。
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
  + EC-1 [edge] C=连接开启模拟登录用户但无 OAuth2 客户端且无可用凭据 | A=嵌入式访客查询 | O=查询被拒绝，访客看到连接未为嵌入式仪表盘配置的提示，服务端日志记录连接与修复方法
  + EC-2 [edge] C=连接开启模拟登录用户但无 OAuth2 客户端且无可用凭据 | A=嵌入式访客查询 | O=查询被拒绝，访客看到连接未为嵌入式仪表盘配置的提示
  + EC-3 [edge] C=嵌入式访客凭据回退场景中，访客用户名取值为空或发生变化。 | A=访客访问嵌入式仪表盘。 | O=访客身份判定不受用户名取值影响，仍按访客身份处理。
  + EC-4 [edge] C=未配置 CURRENT_USER 缩略图执行器且执行器无法解析。 | A=系统计算图表缩略图摘要。 | O=摘要返回空值，不生成缩略图，也不抛出执行器未找到错误。
  + ER-1 [error] C=凭据只有用户名或只有密码/私钥，或用户名为纯空白 | A=保存连接 | O=校验失败，凭据被拒绝
  + ER-2 [error] C=嵌入式访客凭据中的私钥无法加载。 | A=嵌入式访客查询该连接。 | O=拒绝访客并提示检查嵌入式凭据中的私钥与口令。
  + HP-3 [happy] C=嵌入式访客令牌用户名为空，访问带缩略图的仪表盘。 | A=系统计算仪表盘缩略图摘要。 | O=摘要以访客自身身份计算并纳入其 RLS 规则，缩略图正常生成且与其他访客隔离。

## [KEPT/unaffected] 嵌入式访客回退凭据 [嵌入式访客回退凭据]
  逐字相同场景: EC-1, ER-1, HP-1

## [KEPT/unaffected] 数据导入导出 [数据导入导出]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2

## [CHANGED/affected] 数据库连接配置 [数据库连接配置]
  逐字相同场景: EC-1, ER-1, HP-1, HP-2, HP-4
  ~ EC-2(rewritten):
    C v48: 数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。
    C v49: Athena 连接既未填 s3_staging_dir 也未填 work_group。
    A v48: 构建该数据库引擎规范的 parameters_json_schema。
    A v49: 保存连接。
    O v48: 该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
    O v49: 连接参数校验失败，提示二者至少填其一。
  ~ HP-3(rewritten):
    C v48: 用户在数据库连接配置中填写 OAuth2 客户端信息或嵌入式凭据。
    C v49: 管理员配置 Amazon Athena 连接。
    A v48: 提交数据库连接配置。
    A v49: 在连接表单中填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、Schema、Work Group。
    O v48: 连接参数可包含 oauth2_client_info 与 embedded_credentials 字段并被传递。
    O v49: 表单按 Athena 动态参数 schema 渲染字段并提交连接参数。
  ~ HP-5(rewritten):
    C v48: 用户在数据库连接弹窗中配置含私钥字段的连接
    C v49: 管理员配置 Athena 数据库连接
    A v48: 打开数据库连接配置弹窗并填写连接参数
    A v49: 在连接表单填写 AWS Access Key ID、Secret、Region、S3 暂存目录与 work group
    O v48: 私钥类字段被正确识别与处理，连接配置可正常保存
    O v49: 表单按 FormFieldOrder 渲染这些字段并可保存
  ~ HP-6(rewritten):
    C v48: OAuth2 数据库连接需要携带客户端信息与嵌入式凭据
    C v49: 管理员在编辑模式查看 AWS Secret Access Key
    A v48: 保存包含 oauth2_client_info 与 embedded_credentials 的连接参数
    A v49: 打开连接表单
    O v48: 连接参数类型接受这两个可选字段，配置可正常提交
    O v49: 密钥以密码输入框呈现，不显示明文
  + EC-3 [edge] C=数据库连接参数中包含 EncryptedField 类型字段，OpenAPI 版本为 3。 | A=构建该数据库引擎规范的 parameters_json_schema。 | O=该字段带 x-encrypted-extra: true 标记，连接对话框将其值放入 masked_encrypted_extra。
  + EC-4 [edge] C=Athena 连接既未填 s3_staging_dir 也未填 work_group。 | A=保存或校验连接参数。 | O=返回缺少 s3_staging_dir 与 work_group 的警告错误。
  + HP-10 [happy] C=管理员配置 Amazon Athena 连接。 | A=在连接表单中填写 AWS Access Key ID、Secret、Region、S3 staging dir 或 work group。 | O=表单按 AthenaParametersSchema 渲染字段并生成 SQLAlchemy URI。
  + HP-11 [happy] C=管理员配置 Athena 连接 | A=在连接表单填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir 或 work_group | O=字段按动态 schema 渲染，AWS Secret Access Key 始终以密码输入框显示
  + HP-7 [happy] C=管理员更新一个已存在的数据库连接，请求体合法 | A=PUT /api/v1/database/{pk} | O=返回 200 及更新后的连接信息，sqlalchemy_uri 与加密字段按掩码返回
  + HP-8 [happy] C=管理员为 Athena 连接填写 AWS Secret Access Key | A=在新增或编辑模式下查看该字段 | O=字段以密码输入框渲染并带可见性切换，密钥不明文显示
  + HP-9 [happy] C=管理员配置 Athena 连接 | A=在连接表单填写 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、schema_name 与 work_group | O=表单按 Athena 动态参数 schema 渲染这些字段并可保存

## [CHANGED/affected] 数据源连接 [数据源连接]
  逐字相同场景: EC-1, EC-2, ER-1, ER-2, HP-1, HP-2
  ~ EC-3(rewritten):
    C v48: 用户导入图表包，包内包含与已有数据库 UUID 相同的数据库配置。
    C v49: Athena 连接的 Work Group 已配置查询结果位置
    A v48: 执行图表导入。
    A v49: 在连接表单中留空 S3 query results location
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: 该字段为可选，连接仍可保存
  ~ EC-4(rewritten):
    C v48: 用户导入仪表盘包，包内包含与已有数据库 UUID 相同的数据库配置，且未指定 overwrite_all。
    C v49: Athena 连接使用 VPC/PrivateLink 自定义主机名。
    A v48: 执行仪表盘导入。
    A v49: 从 URI 解析连接参数。
    O v48: 关联数据库被复用，已有数据库连接不被覆盖。
    O v49: region_name 保留完整主机名与端口，重新生成 URI 时原样还原。
  ~ HP-3(rewritten):
    C v48: 用户创建 OAuth2 数据源，连接测试通过但权限同步时管理员尚无 OAuth2 令牌。
    C v49: 管理员配置 Amazon Athena 数据源。
    A v48: 提交创建数据库请求。
    A v49: 填写 AWS 凭据、Region、Schema 与 S3 staging dir 或 Work Group 并保存。
    O v48: 数据库创建成功并返回，权限同步错误被忽略，不再返回 422。
    O v49: 连接按 Athena 动态参数 schema 校验并保存。
  ~ HP-4(rewritten):
    C v48: 用户创建 OAuth2 数据源连接，连接测试通过但权限同步时创建管理员尚无 OAuth2 令牌。
    C v49: Athena 连接仅填写 work_group 而未填 s3_staging_dir
    A v48: 提交创建数据库请求。
    A v49: 保存并测试连接
    O v48: 数据库创建成功，不再因缺少 OAuth2 令牌返回 422；权限在首次设置访问时同步。
    O v49: 连接可用，查询结果位置由 work group 定义
  ~ HP-5(rewritten):
    C v48: 管理员更新一个已存在的数据库连接。
    C v49: 管理员配置 Athena 数据源
    A v48: 向数据库 PUT 接口提交请求体。
    A v49: 在动态表单中填写 AWS Access Key ID、Secret、Region、S3 结果位置与 Work Group 并保存
    O v48: 请求体由 DatabasePutSchema(database_id=pk) 校验，合法时返回 200 与更新后的连接信息。
    O v49: 连接参数按 Athena 引擎 schema 校验并保存
  ~ HP-6(rewritten):
    C v48: 数据库引擎参数包含加密字段，前端获取参数 JSON Schema。
    C v49: 管理员配置 Athena 连接且仅填写 work_group
    A v48: 读取引擎参数的 OpenAPI 3 schema。
    A v49: 保存连接
    O v48: 加密字段带 x-encrypted-extra: true 标记，连接对话框据此渲染并将值放入 masked_encrypted_extra。
    O v49: s3_staging_dir 可省略，连接按工作组查询结果位置运行
  + HP-7 [happy] C=管理员配置 Amazon Athena 连接并填写 region_name 与 s3_staging_dir。 | A=保存连接。 | O=生成 awsathena+rest URI，额外 query 参数原样保留。
  - 移除场景: EC-5, ER-3, ER-4, ER-5, ER-6, ER-7

## [CHANGED/unknown] 数据集列表管理 [数据集列表管理]
  逐字相同场景: EC-1, ER-1, ER-2, HP-1, HP-2, HP-3
  ~ HP-4(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户删除数据集前查看依赖提示。
    A v48: 打开导入弹窗并提交导入。
    A v49: 打开删除确认弹窗。
    O v48: 导入弹窗识别加密文件额外字段并正常处理导入。
    O v49: 提示文案显示关联的图表数与仪表盘数，如 linked to 3 charts and 2 dashboards。
  ~ HP-5(rewritten):
    C v48: 用户在数据集列表导入包含加密文件的导出包。
    C v49: 用户查看数据集删除确认弹窗
    A v48: 执行导入。
    A v49: 阅读影响提示
    O v48: 导入流程识别加密文件额外字段并继续处理。
    O v49: 提示显示“is linked to N charts and M dashboards”
  + EC-2 [edge] C=列表排序状态被外部恢复为空。 | A=ListView 重新渲染。 | O=表头排序指示被清除，与受控 sortBy 一致。
  + EC-3 [edge] C=批量归档选择中包含语义视图 | A=打开批量归档确认 | O=确认弹窗保留危险提示与输入 DELETE 门槛，不承诺可恢复
  + EC-4 [edge] C=列表排序状态被外部恢复为空排序 | A=重新渲染列表 | O=表头排序指示被清除，与受控排序状态一致
  + HP-6 [happy] C=用户删除数据集前查看影响 | A=打开删除确认弹窗 | O=弹窗显示“linked to N charts and M dashboards”并列出可见依赖与受限数量
  + HP-7 [happy] C=用户删除被图表与仪表盘引用的数据集 | A=打开删除确认弹窗 | O=弹窗显示“is linked to N charts and M dashboards”的影响说明
  + HP-8 [happy] C=用户在数据集列表中删除一个被图表和仪表盘引用的数据集（非软删除模式）。 | A=打开删除确认弹窗。 | O=弹窗文案同时显示关联的图表数量与仪表盘数量，并提示删除会破坏这些对象。

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
  - 移除场景: EC-3, EC-4, EC-5, EC-6, ER-3, HP-3, HP-4, HP-5, HP-6, HP-7, HP-8

## [KEPT/unaffected] 语义视图批量添加 [语义视图批量添加]
  逐字相同场景: EC-1, EC-2, ER-1, HP-1

## [KEPT/unaffected] 资产导入导出 [资产导入导出]
  逐字相同场景: EC-1, EC-2, EC-3, ER-1, HP-1, HP-2

## [NEW 功能/not_in_gt] Amazon Athena 连接表单 [amazon athena 连接表单]
summary: Athena 引擎提供动态连接表单参数 schema，包含 AWS 凭据、Region、S3 staging dir、Schema 与 Work Group 字段。
  + [edge] EC-1: C=管理员只填写 Work Group 而不填 S3 staging dir。 | A=保存 Athena 连接。 | O=连接被接受，由 Work Group 定义查询结果位置。
  + [edge] EC-2: C=用户创建 Amazon Athena 连接但未填写 region_name | A=提交连接表单 | O=校验失败，提示 region_name 为必填项，连接不被创建。
  + [edge] EC-3: C=Athena 连接 URI 含 catalog_name、role_arn、endpoint_url 等额外查询参数 | A=通过表单编辑该连接并保存 | O=额外查询参数经 query 字段原样保留，编辑不会丢弃它们。
  + [error] ER-1: C=管理员既未填 s3_staging_dir 也未填 work_group。 | A=保存 Athena 连接。 | O=校验失败，提示二者至少填其一。
  + [happy] HP-1: C=管理员在数据库连接弹窗中选择 Amazon Athena。 | A=查看连接表单。 | O=表单按动态 schema 渲染 AWS Access Key ID、Secret Access Key、Region、S3 staging dir、Schema、Work Grou
  + [happy] HP-10: C=管理员在 Superset 中新建或编辑 Amazon Athena 数据库连接。 | A=打开 Athena 连接表单。 | O=表单动态展示 AWS Access Key ID、AWS Secret Access Key、AWS region 与 Athena work group 等参数输入项，标签文案可
  + [happy] HP-2: C=管理员填写 Athena 连接参数。 | A=填写 AWS 凭据、Region、Schema 与 S3 staging dir 并保存。 | O=连接参数通过 Athena schema 校验并保存。
  + [happy] HP-3: C=用户在数据源连接页面选择 Amazon Athena 类型。 | A=打开 Athena 连接配置表单。 | O=表单按动态连接参数 schema 渲染对应字段，可填写并保存连接参数。
  + [happy] HP-4: C=用户在数据库连接弹窗选择 Amazon Athena 引擎。 | A=查看连接表单中的 AWS Access Key ID、Region、S3 query results location 字段。 | O=字段显示对应标签与占位符（如 e.g. us-east-1、e.g. s3://my-bucket/athena-results/）。
  + [happy] HP-5: C=用户在数据库连接弹窗中选择 Amazon Athena 引擎。 | A=打开连接表单并查看字段。 | O=表单按顺序展示 aws_access_key_id、aws_secret_access_key、region_name、s3_staging_dir、schema_name、wor
  + [happy] HP-6: C=用户填写 Athena 连接参数。 | A=填写 AWS 访问密钥、区域、S3 暂存目录、schema 与 work group 并保存连接。 | O=这些参数作为可选字符串字段随连接参数保存。
  + [happy] HP-7: C=用户在数据库连接配置中选择 Amazon Athena。 | A=打开 Athena 连接表单。 | O=表单参数按动态连接参数 schema 渲染。
  + [happy] HP-8: C=用户创建 Amazon Athena 数据库连接 | A=在连接表单中填写 region_name 及可选的 aws_access_key_id、aws_secret_access_key、s3_staging_dir、schema_na | O=表单以结构化参数呈现并接受提交，连接按这些参数构建 Athena URI。
  + [happy] HP-9: C=用户新建或编辑 Amazon Athena 数据库连接。 | A=打开 Athena 连接配置表单。 | O=表单参数按动态连接参数 schema 渲染，可填写对应连接参数。

## [NEW 功能/not_in_gt] Athena 连接表单 [athena 连接表单]
summary: Athena 引擎提供动态连接参数 schema，包含 AWS 凭据、区域、S3 结果位置、schema 与 work group 字段。
  + [edge] EC-1: C=Athena 连接既未填 s3_staging_dir 也未填 work_group | A=保存连接 | O=连接参数校验提示至少需要其中一项
  + [happy] HP-1: C=管理员打开 Athena 数据库连接表单 | A=查看连接参数字段 | O=表单按 FormFieldOrder 渲染 AWS Access Key ID、AWS Secret Access Key、Region、S3 staging dir、schema
  + [happy] HP-2: C=管理员在编辑模式查看已保存的 AWS Secret Access Key | A=打开连接表单 | O=密钥字段仍以密码输入框显示，不回退为明文

## [NEW 功能/not_in_gt] MCP 语义表字段重选 [mcp 语义表字段重选]
summary: update_chart 支持对语义表与交互式表图表进行完整字段重选，需按目标视图成员 ID 提供全部列并显式给出过滤器。
  + [edge] EC-1: C=语义提供方未声明 selection_identity_version。 | A=生成语义图表。 | O=不写入语义选择标记，不虚构身份版本。
  + [edge] EC-2: C=重选时未显式给出过滤器。 | A=调用 update_chart。 | O=请求被拒绝，提示需显式给出过滤器（可用 [] 清空）。
  + [edge] EC-3: C=语义视图提供方未声明选择身份版本 | A=生成图表 | O=不写入选择身份标记
  + [edge] EC-4: C=语义视图提供方未声明选择身份版本 | A=新建语义视图图表 | O=不写入虚构的选择身份标记
  + [edge] EC-5: C=语义视图提供方未声明 selection_identity_version。 | A=生成图表。 | O=不写入选择身份标记，不虚构版本。
  + [edge] EC-6: C=调用方未提供 temporal_columns | A=映射 XY 图表配置 | O=按原有数据集类型推断判定 x 轴列，行为与之前一致。
  + [edge] EC-7: C=语义视图实现的 selection_identity_version 不是字符串。 | A=调用 generate_chart 生成语义视图图表。 | O=不写入 semantic_selection_version，表单数据按原样进入语义视图校验。
  + [error] ER-1: C=保留的语义选择无法验证。 | A=调用 update_chart。 | O=拒绝更新并提示通过 Explore 恢复。
  + [error] ER-2: C=更新语义表图表时保留未验证的旧字段选择 | A=调用 update_chart | O=请求被拒绝并提示使用 Explore 恢复链接
  + [error] ER-3: C=更新语义表图表时保留未验证的旧选择 | A=调用 update_chart | O=请求被拒绝并提示在 Explore 中恢复
  + [error] ER-4: C=update_chart 收到未验证的保留选择。 | A=提交更新。 | O=拒绝更新并提示在 Explore 中恢复。
  + [error] ER-5: C=调用方更新一个绑定过时语义表的图表，但保留了未经验证的语义选择。 | A=调用 update_chart 提交 config。 | O=更新被拒绝，返回错误并附带 Explore 恢复指引；需重新选择所有列并显式指定过滤器（[] 表示清空）。
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器。 | O=图表完成完整字段重选并保存。
  + [happy] HP-10: C=调用方通过 MCP 为语义视图生成图表，语义视图实现提供字符串类型的 selection_identity_version。 | A=调用 generate_chart 生成语义视图图表。 | O=form_data 被写入 semantic_selection_version，随后通过语义视图表单数据校验并继续生成图表。
  + [happy] HP-2: C=新建语义图表。 | A=调用 generate_chart 或 generate_explore_link。 | O=新选择的成员被打上语义选择标记，保留的旧选择不被标记。
  + [happy] HP-3: C=语义表图表的字段选择标记缺失或过时 | A=调用 update_chart 提供目标视图全部成员 ID 与显式过滤器 | O=图表字段选择被完整重选并保存
  + [happy] HP-4: C=生成图表时选择语义视图成员 | A=调用 generate_chart | O=新选择的成员被打上选择身份标记
  + [happy] HP-5: C=语义表图表的语义选择标记缺失或过期 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器 | O=图表字段被完整重选并更新
  + [happy] HP-6: C=通过 generate_chart 或 generate_explore_link 新建语义视图图表 | A=提交语义视图配置 | O=新选择的成员被打上选择身份标记
  + [happy] HP-7: C=语义表图表的语义选择标记缺失或过期。 | A=调用 update_chart 并提供目标视图全部成员 ID 与显式过滤器。 | O=图表字段被完整重选并写入新的选择标记。
  + [happy] HP-8: C=生成图表或 Explore 链接时选择语义视图成员。 | A=调用 generate_chart 或 generate_explore_link。 | O=新选择的成员被打上选择身份标记，保留的旧选择不被标记。
  + [happy] HP-9: C=调用方为 XY 图表映射提供 temporal_columns 集合 | A=映射 XY 图表配置 | O=x 轴列按提供的时间列集合判定为时间型或非时间型，生成对应图表配置。

## [NEW 功能/not_in_gt] MCP 语义表重选 [mcp 语义表重选]
summary: MCP 的 update_chart 支持对语义表与交互式表图表进行完整字段重选，要求显式提供全部列与过滤器。
  + [edge] EC-1: C=语义表图表存在未验证的保留选择 | A=调用 update_chart 未提供完整重选 | O=请求被拒绝并提示通过 Explore 恢复
  + [edge] EC-2: C=提供方没有选择身份版本 | A=生成语义视图图表 | O=不写入虚构的选择身份标记
  + [edge] EC-3: C=更新语义表图表时未提供 columns 或 filters | A=调用 update_chart | O=返回不完整类别提示，要求在 Explore 中恢复
  + [edge] EC-4: C=保留的图表状态含未请求的排序或行数变化 | A=调用 update_chart | O=识别为未请求的控制变化并拒绝认证
  + [edge] EC-5: C=MCP 图表请求未携带语义选择来源 | A=合并 extra_form_data | O=结果中不写入 semantic_selection_sources 键。
  + [edge] EC-6: C=用户通过 MCP 生成语义视图 Explore 链接，但表单数据校验不通过。 | A=调用 generate explore link 工具。 | O=返回 success=false 与校验错误，不生成链接。
  + [error] ER-1: C=重选时缺少必需过滤器或列 | A=调用 update_chart | O=返回校验错误，不保存图表
  + [error] ER-2: C=保留的语义选择含 SQL 表达式或非保存指标 | A=调用 update_chart | O=返回语义视图不支持 ad-hoc 表达式的错误
  + [happy] HP-1: C=语义表图表的语义选择标记缺失或过时 | A=调用 update_chart 并按目标视图成员 ID 提供全部列与显式过滤器 | O=图表完成字段重选并保存
  + [happy] HP-2: C=新建语义视图图表 | A=调用 generate_chart | O=新选择的成员被打上选择身份标记，保留的旧选择不被标记
  + [happy] HP-3: C=语义表图表的语义选择标记缺失或过期 | A=通过 update_chart 提供目标视图全部成员列并显式给出过滤器 | O=图表更新成功，新选择被打上语义选择版本标记
  + [happy] HP-4: C=通过 generate_chart 或 generate_explore_link 新建语义视图图表 | A=提交图表配置 | O=表单数据被打上目标视图的语义选择版本标记
  + [happy] HP-5: C=用户在 MCP 语义表配置中重新选择表字段。 | A=提交完整的字段重选结果。 | O=语义表按新的字段选择更新，重选结果完整生效。
  + [happy] HP-6: C=MCP 图表请求同时带有缓存 extra_form_data 与请求级语义选择来源 | A=合并 extra_form_data | O=合并结果包含合并后的 semantic_selection_sources，语义表重选完整生效。
  + [happy] HP-7: C=用户通过 MCP 工具为语义视图生成 Explore 链接并重新选择了语义表。 | A=调用 generate explore link 工具生成链接。 | O=新的语义表选择被标记进表单数据，生成的链接与表单数据反映重选后的语义表。

## [NEW 功能/not_in_gt] SQL Lab [sql lab]
summary: SQL Lab 执行查询时对未限定 schema 的表引用同样应用 RLS 与表拒绝名单。
  + [error] ER-1: C=数据库配置了表拒绝名单，用户在 SQL Lab 中查询未限定 schema 的被拒表。 | A=提交查询。 | O=查询被拒绝并返回表被禁止访问的错误，而非执行成功。
  + [happy] HP-1: C=受限用户拥有某表的 RLS 规则，在 SQL Lab 中执行未写 schema 的表查询。 | A=提交查询。 | O=查询按该表的 RLS 规则过滤数据，未限定表名不再绕过行级安全。

## [NEW 功能/not_in_gt] 仪表盘版本恢复 [仪表盘版本恢复]
summary: 恢复仪表盘历史版本前，确认弹窗统计当前成员中不属于目标版本的图表数量并警告恢复将移除这些图表。
  + [edge] EC-1: C=恢复影响计数包含已归档或未放置的成员图表。 | A=打开恢复确认弹窗。 | O=计数包含这些成员，提示可能随其他用户编辑而变化。
  + [error] ER-1: C=获取恢复影响计数失败。 | A=打开恢复确认弹窗。 | O=弹窗仍可展示，不因计数失败阻止恢复流程。
  + [happy] HP-1: C=用户选择恢复某个仪表盘历史版本，当前仪表盘有若干不属于该版本的成员图表。 | A=打开恢复确认弹窗。 | O=弹窗显示将被移除的图表数量并警告恢复会将这些图表移出仪表盘，但不删除图表本身。
  + [happy] HP-2: C=当前仪表盘成员与目标版本完全一致。 | A=打开恢复确认弹窗。 | O=不显示移除警告，用户可直接确认恢复。
  + [happy] HP-3: C=用户选择恢复某个历史仪表盘版本，该版本不包含当前仪表盘中的部分图表。 | A=确认恢复该版本。 | O=恢复前提示将移除的图表，用户确认后完成恢复。
  + [happy] HP-4: C=用户选择恢复仪表盘的旧版本，该版本不包含当前部分图表。 | A=确认恢复该版本。 | O=恢复前展示将移除图表的警告，用户确认后完成恢复。

## [NEW 功能/not_in_gt] 最近归档列表 [最近归档列表]
summary: 集中展示已软删除的图表、仪表盘与数据集，支持按类型切换、搜索、恢复与永久删除。
  + [edge] EC-1: C=用户切换到另一种归档类型 | A=在 Type 选择器切换 | O=清除上一类型的排序与分页参数，按新类型的 deleted-state 过滤请求
  + [edge] EC-2: C=用户只有 can_read 权限 | A=查看归档行 | O=不显示恢复与永久删除操作，悬停提示需先恢复才能打开
  + [error] ER-1: C=恢复请求返回 404（对象已被他人恢复） | A=点击 Recover | O=显示恢复失败提示，页面不崩溃且行保留
  + [error] ER-2: C=数据集 purge-impact 返回 409 purge_impact_changed | A=确认永久删除 | O=弹窗切换为 changed 状态并展示新的影响信息，需再次确认
  + [happy] HP-1: C=用户打开最近归档页面 | A=浏览已归档图表列表 | O=列表按归档时间倒序展示名称、类型、归档时间与归档人
  + [happy] HP-2: C=用户对已归档图表点击恢复 | A=点击 Recover | O=调用对应类型 restore 接口，成功后刷新列表并显示带恢复链接的提示
  + [happy] HP-3: C=用户对已归档数据集点击永久删除 | A=在确认弹窗输入 DELETE 并提交 | O=先获取 purge-impact，再携带 impact token 调用 purge 接口并刷新列表

## [NEW 功能/not_in_gt] 列表排序与历史状态 [列表排序与历史状态]
summary: ListView 与 TableCollection 支持受控排序，并在浏览器历史恢复时同步排序、分页与搜索状态。
  + [edge] EC-1: C=列表初始排序与当前排序不一致。 | A=触发列表状态同步。 | O=排序被重置为初始排序。
  + [happy] HP-1: C=用户通过浏览器前进/后退恢复列表历史状态。 | A=返回上一页列表状态。 | O=排序、分页与搜索作为同一 URL 状态一并恢复。
  + [happy] HP-2: C=受控排序被外部重置为空排序。 | A=重新渲染 TableCollection。 | O=表头排序指示被清除。

## [NEW 功能/not_in_gt] 列表排序与键盘可达性 [列表排序与键盘可达性]
summary: 列表视图支持受控排序与历史状态恢复，卡片菜单在打开前可通过键盘到达权限提示。
  + [edge] EC-1: C=图表卡用户无编辑权限 | A=用 Tab 聚焦卡片菜单 | O=先读到编辑权限提示，再打开菜单
  + [edge] EC-2: C=Kebab 菜单带提示文案 | A=按 Tab 离开菜单 | O=焦点回到 More Options 按钮
  + [happy] HP-1: C=用户在列表页排序后使用浏览器后退再前进 | A=恢复历史记录 | O=排序、分页与搜索作为同一 URL 状态一起恢复
  + [happy] HP-2: C=受控排序被外部重置为空 | A=重新渲染 TableCollection | O=表头排序指示被清除

## [NEW 功能/not_in_gt] 列表视图排序与历史状态 [列表视图排序与历史状态]
summary: 列表视图在浏览器前进/后退时同步恢复排序、分页与筛选，并保持排序表头与卡片排序选择器一致。
  + [edge] EC-1: C=列配置未显式设置 id，仅有字符串 accessor | A=点击某一列排序 | O=仅被点击的列标记为已排序
  + [edge] EC-2: C=调用方未传入 sortBy。 | A=渲染 TableCollection 列表。 | O=不设置 sortOrder，列表按默认无排序状态展示，行为与之前一致。
  + [happy] HP-1: C=用户在列表第 3 页筛选后点击浏览器后退 | A=使用浏览器历史导航 | O=分页、筛选与排序一并恢复并重新请求数据
  + [happy] HP-2: C=受控排序从非空恢复为空排序 | A=重新渲染表格 | O=对应表头不再显示 aria-sort
  + [happy] HP-3: C=列表视图从历史状态恢复排序条件。 | A=以 sortBy 传入 TableCollection 渲染列表。 | O=对应列显示升序或降序排序指示，与历史排序一致。
  + [happy] HP-4: C=用户在列表视图切换排序后通过浏览器历史返回上一状态。 | A=触发 query 变化，initialSortBy 与当前 sortBy 不一致。 | O=列表按 initialSortBy 恢复排序，并同步恢复分页与筛选。
  + [happy] HP-5: C=卡片视图下用户修改排序。 | A=sortBy 变化导致 CardSortSelect 的 key 变化。 | O=排序控件以新排序值重新挂载并显示当前排序。

## [NEW 功能/not_in_gt] 卡片操作菜单可达性 [卡片操作菜单可达性]
summary: 图表与仪表盘卡片的更多操作菜单在聚焦时暴露权限提示，并支持 Tab 返回触发按钮。
  + [edge] EC-1: C=多个卡片菜单同时存在提示 | A=聚焦各按钮 | O=每个按钮的提示 id 唯一，提示消失后 aria-describedby 被移除
  + [edge] EC-2: C=卡片操作菜单按钮未配置 tooltipTitle。 | A=用户悬停或聚焦该按钮。 | O=不显示提示内容，菜单点击行为保持不变。
  + [edge] EC-3: C=用户是图表编辑者。 | A=打开图表卡片操作菜单。 | O=编辑项可用且不显示权限提示。
  + [happy] HP-1: C=无编辑权限的用户聚焦卡片更多操作按钮 | A=使用键盘 Tab 聚焦 | O=按钮通过 aria-describedby 暴露权限提示
  + [happy] HP-2: C=用户打开卡片操作菜单 | A=在菜单项上按 Tab | O=菜单关闭且焦点返回更多操作按钮
  + [happy] HP-3: C=卡片操作菜单按钮配置了 tooltipTitle。 | A=用户悬停或键盘聚焦该按钮。 | O=显示对应提示文本，按钮可通过键盘聚焦触发。
  + [happy] HP-4: C=软删除开启，非图表编辑者打开图表卡片操作菜单。 | A=悬停或聚焦被禁用的编辑项。 | O=显示“需要图表编辑者权限才能归档”的提示。
  + [happy] HP-5: C=软删除关闭，非仪表盘编辑者打开仪表盘卡片操作菜单。 | A=悬停或聚焦被禁用的删除项。 | O=显示“需要仪表盘编辑者权限才能删除”的提示。

## [NEW 功能/not_in_gt] 归档列表与恢复提示 [归档列表与恢复提示]
summary: 归档列表与归档成功提示支持带链接的通知常驻、恢复链接遵循部署 URL 前缀，并保留历史导航。
  + [edge] EC-1: C=用户在归档列表切换对象类型 | A=切换类型筛选 | O=历史记录新增一条，可后退回到上一类型
  + [edge] EC-2: C=用户此前按 Name 列排序并翻到较后页码。 | A=切换到另一归档类型。 | O=新类型列表从默认排序与第一页开始，不再因未知排序列返回 400 或显示空表。
  + [happy] HP-1: C=用户归档一个图表 | A=查看成功提示 | O=提示包含指向归档列表的链接且不自动消失，直到用户关闭
  + [happy] HP-2: C=部署配置了 URL 前缀 | A=点击归档恢复链接 | O=链接包含部署前缀并正确跳转
  + [happy] HP-3: C=用户在最近归档列表中选择另一种对象类型。 | A=通过类型下拉框切换类型。 | O=URL 中 type 更新，sortColumn、sortOrder、pageIndex 被删除，并以 push 方式新增浏览器历史记录。

## [NEW 功能/not_in_gt] 版本历史恢复 [版本历史恢复]
summary: 仪表盘版本恢复前统计并提示将被移除的当前成员图表，恢复确认弹窗按实体与版本重建。
  + [edge] EC-1: C=恢复影响计数请求失败 | A=打开恢复确认弹窗 | O=弹窗仍可展示，不阻塞恢复流程
  + [happy] HP-1: C=用户选择恢复仪表盘历史版本 | A=打开恢复确认弹窗 | O=弹窗显示当前成员中不属于该版本的图表数量并提示将被移除
  + [happy] HP-2: C=目标版本与当前成员完全一致 | A=打开恢复确认弹窗 | O=移除数量为 0，不显示移除警告

## [NEW 功能/not_in_gt] 版本历史恢复确认 [版本历史恢复确认]
summary: 仪表盘版本恢复前查询并提示将被移除的当前成员图表数量，图表本身不被删除。
  + [edge] EC-1: C=当前成员包含已归档或未放置的图表。 | A=打开恢复确认弹窗。 | O=计数包含已归档与未放置成员。
  + [edge] EC-2: C=恢复影响计数请求失败。 | A=打开恢复确认弹窗。 | O=弹窗警告移除数量未知，仍可继续恢复。
  + [edge] EC-3: C=当前成员中没有将被移除的图表 | A=打开恢复确认弹窗 | O=不显示移除提示，恢复按钮可用
  + [edge] EC-4: C=计数请求尚未返回 | A=查看恢复确认弹窗 | O=显示正在检查提示，恢复按钮禁用
  + [edge] EC-5: C=用户切换到另一个版本后旧计数请求才返回 | A=查看恢复确认弹窗 | O=旧响应被忽略，不显示旧版本的移除提示
  + [error] ER-1: C=用户无该仪表盘编辑权限。 | A=尝试打开版本历史或恢复。 | O=请求被拒绝，不展示恢复入口。
  + [error] ER-2: C=恢复影响计数请求失败或超时 | A=查看恢复确认弹窗 | O=提示无法检查将移除哪些图表，恢复按钮仍可用
  + [happy] HP-1: C=用户选择较早的仪表盘版本并点击恢复。 | A=打开恢复确认弹窗。 | O=弹窗显示当前成员中不属于该版本的图表数量，并警告恢复将移除这些图表。
  + [happy] HP-2: C=目标版本包含当前全部成员图表。 | A=打开恢复确认弹窗。 | O=移除数量为 0，不显示移除警告。
  + [happy] HP-3: C=用户对仪表盘旧版本点击恢复，当前有 2 个图表不属于该版本 | A=打开恢复确认弹窗 | O=弹窗提示恢复将移除 2 个图表且图表本身不会被删除
  + [happy] HP-4: C=用户对图表版本点击恢复 | A=打开恢复确认弹窗 | O=不请求仪表盘成员计数，不显示移除提示

## [NEW 功能/not_in_gt] 版本历史恢复警告 [版本历史恢复警告]
summary: 仪表盘版本恢复前统计并警告将被移除的当前成员图表，不删除图表本身。
  + [edge] EC-1: C=当前成员包含已归档或未放置的图表 | A=打开恢复确认弹窗 | O=计数包含这些成员，因为它们仍属于仪表盘并可被移除
  + [edge] EC-2: C=弹窗打开后其他用户修改了仪表盘成员 | A=确认恢复 | O=实际移除数量以确认时的成员为准，可能与弹窗显示不同
  + [edge] EC-3: C=用户在恢复确认弹窗打开时切换到另一个版本目标。 | A=选择不同版本再次发起恢复。 | O=弹窗以新的 entityType:uuid:versionUuid 作为 key 重新挂载，并按新目标重新加载影响计数。
  + [error] ER-1: C=恢复影响接口返回的 removed_chart_count 缺失或不是非负整数。 | A=打开仪表盘恢复确认弹窗。 | O=前端抛出 'Invalid restore impact response' 错误，影响计数不可用。
  + [happy] HP-1: C=用户选择恢复某个仪表盘版本 | A=打开恢复确认弹窗 | O=弹窗显示当前成员中不属于该版本的图表数量，并说明恢复会将其从仪表盘移除但不删除图表
  + [happy] HP-2: C=目标版本包含当前全部成员图表 | A=打开恢复确认弹窗 | O=不显示移除警告，直接确认恢复
  + [happy] HP-3: C=用户对仪表盘版本发起恢复操作。 | A=打开恢复确认弹窗。 | O=弹窗请求恢复影响计数并展示将被移除的图表数量。
  + [happy] HP-4: C=用户选择恢复一个旧版本仪表盘，该版本不包含当前部分图表。 | A=用户触发版本恢复。 | O=恢复前显示图表将被移除的警告，用户确认后才执行恢复。

## [NEW 功能/not_in_gt] 访客身份判定 [访客身份判定]
summary: 嵌入访客的识别不依赖用户名，缩略图摘要按访客自身键隔离缓存。
  + [edge] EC-1: C=非访客用户请求缩略图 | A=生成缩略图摘要 | O=摘要不附加访客键，与访客缓存隔离
  + [edge] EC-2: C=请求既无 JWT 也无访客令牌，且发生在鉴权前的错误处理路径。 | A=触发访客身份判定。 | O=判定返回 False，不再抛出未处理的 NoAuthorizationError。
  + [happy] HP-1: C=访客令牌携带空用户名 | A=判定当前用户是否为访客 | O=依据用户对象与令牌判定为访客
  + [happy] HP-2: C=嵌入访客请求仪表盘缩略图 | A=生成缩略图摘要 | O=摘要按访客自身键区分，访客的行级规则进入摘要
  + [happy] HP-3: C=嵌入式访客用户以任意用户名访问仪表盘。 | A=系统判定访客身份。 | O=访客身份判定不再依赖用户名取值，访客访问行为保持一致。
  + [happy] HP-4: C=嵌入式访客令牌携带空用户名或任意用户名。 | A=请求嵌入式资源触发访客身份判定。 | O=请求被正确识别为访客用户，按访客权限处理。
  + [happy] HP-5: C=两个嵌入式访客令牌 username 均为空但 RLS 规则不同。 | A=系统构建解析失败缓存身份。 | O=两个访客得到不同的缓存身份，RLS 作用域互不共享。

## [NEW 功能/not_in_gt] 软删除归档体验 [软删除归档体验]
summary: 归档成功提示中的恢复链接按部署前缀生成并保持到用户关闭，数据集影响文案与归档列表导航修复。
  + [edge] EC-1: C=数据集关联 2 个图表与 1 个仪表盘。 | A=查看删除/归档影响文案。 | O=文案显示 linked to 2 charts and 1 dashboard。
  + [edge] EC-2: C=用户在归档列表切换类型或排序。 | A=执行切换。 | O=URL 通过 history.push 更新，浏览器后退可回到上一状态。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=查看归档成功提示。 | O=提示包含指向 Recently Archived 的恢复链接，链接按部署 URL 前缀生成。
  + [happy] HP-2: C=归档提示包含 HTML 链接。 | A=用户未关闭提示。 | O=提示保持显示直到用户主动关闭，不自动消失。

## [NEW 功能/not_in_gt] 软删除归档提示 [软删除归档提示]
summary: 归档成功提示携带恢复链接，含链接的通知保持打开直到被关闭，数据集影响文案区分图表与仪表盘数量。
  + [edge] EC-1: C=数据集被 2 个图表和 1 个仪表盘引用 | A=查看归档影响文案 | O=文案显示“linked to 2 charts and 1 dashboard”
  + [edge] EC-2: C=系统展示一条无 action、无链接且 duration>0 的普通提示。 | A=等待超过 duration。 | O=提示消息按 duration 自动关闭。
  + [happy] HP-1: C=用户归档一个图表或仪表盘 | A=完成归档 | O=成功提示包含指向 Recently Archived 的恢复链接，链接使用部署 URL 前缀
  + [happy] HP-2: C=含链接的归档通知显示在页面上 | A=用户悬停或键盘聚焦该通知 | O=通知保持打开直到被显式关闭
  + [happy] HP-3: C=系统展示一条 allowHtml 为真且文本包含 <a 链接的提示消息。 | A=等待超过 toast.duration。 | O=提示消息保持可见，直到用户手动关闭。
  + [happy] HP-4: C=用户归档一个同时被图表和仪表盘引用的数据集。 | A=打开归档确认弹窗。 | O=弹窗说明该数据集关联 N 个图表和 M 个仪表盘，并提示归档会使依赖图表不可用直至恢复。
  + [happy] HP-5: C=部署在非根路径（配置了应用根路径）下，用户恢复一个已归档对象。 | A=查看恢复成功提示并点击“查看”链接。 | O=链接指向应用根路径下的对象地址，可正确跳转。

## [NEW 功能/not_in_gt] 软删除归档提示与键盘可达性 [软删除归档提示与键盘可达性]
summary: 图表与仪表盘卡片在无编辑权限时通过提示说明编辑/归档限制，带链接的归档提示保持可见直至关闭。
  + [edge] EC-1: C=软删除功能关闭 | A=非编辑者查看图表卡删除选项 | O=提示文案使用删除而非归档
  + [happy] HP-1: C=非编辑者用键盘聚焦图表卡菜单按钮 | A=按 Tab 到达菜单按钮 | O=显示编辑与归档权限提示，菜单不自动打开
  + [happy] HP-2: C=非编辑者打开仪表盘卡菜单 | A=悬停或聚焦归档选项 | O=选项禁用并提示需为仪表盘编辑者才能归档
  + [happy] HP-3: C=归档成功提示包含恢复链接 | A=等待超过提示时长 | O=提示保持可见直至用户关闭
  + [happy] HP-4: C=用户对卡片或仪表盘执行软删除归档操作。 | A=完成归档。 | O=显示归档提示，归档计数与历史记录同步更新，相关操作可通过键盘访问。
  + [happy] HP-5: C=用户归档或查看已归档的资产。 | A=执行归档操作并查看归档列表与历史。 | O=归档 toast、计数与历史信息正确展示，键盘用户可完成相关操作。
  + [happy] HP-6: C=用户通过键盘操作归档列表中的卡片操作菜单。 | A=使用键盘打开卡片操作菜单并选择归档操作。 | O=菜单可聚焦并触发归档，归档提示与计数正确显示。

## [NEW 功能/not_in_gt] 软删除归档通知 [软删除归档通知]
summary: 归档成功通知中的恢复链接遵循部署 URL 前缀，含链接的通知保持到用户关闭。
  + [edge] EC-1: C=部署配置了 APPLICATION_ROOT 前缀。 | A=点击归档通知中的恢复链接。 | O=链接指向带前缀的 Recently Archived 页面。
  + [happy] HP-1: C=用户归档一个图表或仪表盘。 | A=查看成功通知。 | O=通知包含指向 Recently Archived 的恢复链接，链接带部署 URL 前缀。
  + [happy] HP-2: C=归档通知包含 HTML 链接。 | A=用户悬停或通过键盘聚焦通知。 | O=通知不自动消失，直到用户关闭或激活链接。
