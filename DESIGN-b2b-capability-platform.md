# B2B 多能力生成平台 · 设计文档

> 基于 DeepSeek Harness (DSH) 构建。面向机构客户，把自有多个能力平台编排成「一课一套」产物。
> 本文档是讨论结论的汇总，作为开工依据；待定项见文末「开放问题」。
>
> 2026-08-24 第一轮：团队评审，原文保留于 §11。
> 2026-08-24 第二轮：按评审与讨论修订正文，对照见 §12。
> 2026-08-24 第三轮：第二轮评审原文保留于 §13；决议合并见 §14。§11/§13 为历史记录。
> 2026-08-24 第四轮：多平台接入评审，原文保留于 §15。
> 2026-08-24 第五轮：课程套件 / 姐妹平台 / 数字人后期合成 / OpenMAIC 取舍，对照见 §16。§15 中与第五轮冲突的判断以 §16 为准。
> 2026-08-24 第六轮：DSH 部署形态（云端 DSH + Web 客户端，撤桌面）、合成器输入（成品 PPTX 经 LibreOffice，撤 HTML 中间态）、Artifact 留版本，已写入 §1–§3、§7、§9、§10、「附」；对照见 §17。
> 2026-08-24 第七轮：针对第六轮并入后的开工依据再审，意见见 §18。不改已拍板正文。§11–§17 为历史记录。
> 2026-08-24 第八轮：DSH 角色定调（对话运行时，不是产品壳、不是套件 SoR）；套件工作台由网关域另做。已写入 §2、§2.2、§7、§9、「附」；对照见 §19。
> 2026-08-24 第九轮：自然语言对话框的存在理由 = 对半成品提修改意见，不是「做课」入口。首轮做课是工作台按钮。已写入 §1、§2.2、§7、§9、「附」；对照见 §20。
> 2026-08-24：教师旅程（一本教材如何变成数字教材）写入 §1.1。
> 2026-08-24 第十轮：扣费粒度 = step（不整单预扣）、确认门入状态机、设计/大纲 provider 新做、Project 补 Material、PPTCreator 多文档输入（已核实不支持，列入 §8 第 10 条）、CSV 导入主体、agent_llm 进闸门、§19 措辞修正。对照见 §21。
> 2026-08-24 第十一轮：身份链撤「双 client + token exchange」，改单应用单 client（chandler 无 token-exchange grant；client_id 语义 = 应用）。补 chandler 对接事实（JWKS URL、iss、自助注册）。已写入 §5、§2、§2.2、§9；对照见 §22。

## 1. 背景与约束

- 客户是机构（B2B）。付费模式：**按年买断使用权（1/2/3 年），不按份计价**——合同要素只有年限、价格、能力范围、SLA、合规条款、禁止转租条款。配额是**内部成本护栏**，不出现在合同、不作为商品单位
- 收款以公对公转账为主（少数在线支付），在高售价内获取利润；盈亏靠内部成本计量（`vendor_cost` + 成本预警）保障，不靠向客户计份
- **首期买家定位：高校**（终端用户：高校教师；首要场景：制作数字教材）。未来可能扩展其他目标市场——组织/配额/Project 模型一律行业通用，不出现"学校/学院"字样
- **成交落在院系/教研室，不是全校。** Org = 成交落地单位（一单一个客户），学校可以只出现在发票抬头。额度耗尽不是主路径
- **教师要的是结果，不是过程。** 「根据某章做课」交付的是一套课。首轮生成是工作台：**传材料 → 做课**，不是在对话框里说「帮我做个课」（那比按钮慢）。**自然语言对话只在教师对半成品有修改意见时才出现**（§2.2）。过程由网关状态机执行，不把平台选择甩给教师
- **能力来自自有姐妹平台**，各自有独立托管、可自行做 2C；给 codelphi 只提供能力（partner）。不是外采「视频/图片供应商」拼盘。已知：PPTCreator（PPT+讲稿）、数字人（讲稿成片，非实时）、AI3D、OpenMAIC（尚未深研；若只做 PPT 则不用，见 §2.1）
- **数字人 = 后期合成，不是实时驱动。** 根据讲稿（通常即 PPTCreator 的备注/讲稿）生成人像成片，再叠到 PPT 播放视频侧面，**不遮挡 PPT 画面**
- **P0 验收口径：** 试点校教师能在一课/一章 Project 下交出套件中的「课程设计 + 大纲 + PPT + 讲稿」。练习、旁挂数字人的讲解视频为后续切片。不叫「数字教材平台」，不交付学生学习平台/班级/成绩
- 能力平台与 LLM 的 key 不允许出现在客户端，收敛在云端
- 不做基础注册/登录：身份依赖 chandler.work（`WorkMembership`，OAuth2/OIDC + 支付通道）。P0 接受「邀请 + chandler 注册」，销售材料**不承诺**对接学校统一身份认证
- chandler 只是**支付通道**：不知道换多少积分、能做多少事；积分账本在各业务系统（姐妹平台 2C 各记各的，codelphi 只记机构账，见 §6）
- **教师主界面是套件工作台。** DSH 是挂在半成品上的 **返工对话运行时**（无半成品则不打开）。不是门户、不是做课入口

### 1.1 教师怎么把一本教材做成数字教材

读者：学院里的课任教师。学生不用这个系统。本产品不交付班级、成绩、学习平台。

**一本教材 ≠ 一次按钮。** 教师的心智是整本书；系统的工作单位是 **一章（一课）**。把书做成「数字教材」，就是逐章做出一套可下载的课：课程设计、大纲、PPT、讲稿（后续再挂练习、旁挂讲解视频、3D 教具）。P0 不建「教材」树，教师用章名区分（如「高等数学 · 第 3 章 导数」）；一门课 = 工作台里的一组章。

#### 进得来（一次性）

1. 学院（或教研室）已签年约。教务/秘书把教师名单（CSV：工号/姓名/邮箱/教研室）交给运营，运营在运营后台批量导入、系统发邀请邮件（机构自助导入入口 P1）。教师 **没有** 学校统一认证可点（P0 不承诺校园 IdP）。
2. 邮件链接 → **chandler.work** 注册或登录（首次可能要建一个 Chandler 账号）→ 跳回 **套件工作台**。身份已经绑在这个学院上。若一人在两个学院都有席位，先选「我以哪个学院的身份进来」。
3. 首页是 **我的章/课** 列表，不是聊天。财务/审计若是 `viewer`，只能看用量，没有「做课」。

之后再来：浏览器打开工作台 → Chandler 若已登录则直接进。不装客户端。

#### 做一章（主路径，无对话框）

4. **新建一章**，写标题。上传这一章的材料（PDF/图片/摘录）。可选填 **补充说明**（2 学时、面向机械专业、少推导多图）——这是表单，不是聊天。
5. 点 **做课**。工作台出现这一章的套件进度，构件逐个亮起：课程设计 → 教学大纲 →（教师看过点「通过，继续」）→ PPT + 讲稿。教师 **不选** 用哪家引擎、不看见 PPTCreator / 数字人。
6. 等的时候可以离开；回来进度还在。失败是页面上的说明（联系本院管理员），不是弹一个助手出来。
7. 构件齐了：在线预览 + 下载（pptx、讲稿、设计/大纲文档）。这是这一章的 **第一版数字课**。

节奏：先出轻的（设计/大纲）给人看，贵的（PPT）要教师点头再烧。点头是按钮。只有「大纲第三节改成案例课」这种话，才进入下一步。

#### 改半成品（这时才出现对话）

8. 打开某一份（例如当前 PPT），点 **对这一份提意见**。侧栏对话 **绑死这一份**，空聊天不会出现在首页。
9. 教师写指代性的意见：「第 3 页那个案例换成食堂」「讲稿第二段太书面」。助手把意见收成一次重做，工作台多一个 **新版本**；旧版仍可下载。P0 是整份重出，不能只抠第 3 页。
10. 满意就停。不满意再对 **新的这一份** 提意见。对话可中断；文件以工作台为准。

#### 把整本书做完

11. 第 4 章、第 5 章重复 4–10。数字教材在教师手里 = **按章打包的一组套件**（文件夹/列表），拿到课堂去用（投影 PPT、照讲稿讲）。学生不登录本系统。
12. 后续能力挂在同一章上，不是另开一个产品：练习、讲解视频（人像在 PPT **旁边**，不遮幻灯片）、3D 教具。没有视频的章仍然是完整可交的课。
13. 合同期内随时下载。人离开学院，下载权没了，文件留在学院的项目里。约到期后还有一段只读下载期。

教师 **不会** 经历的：装软件；在对话框里说「帮我做个课」；挑选生成平台；去 PPTCreator 个人站交学院的活（可以去，但学院报表看不见，销售也不承诺「校本只能在这里做」）。

## 2. 总体架构

```
教师（Web 浏览器）
   │  首轮：传材料 →「做课」按钮（不经对话框）
   │  返工：对着半成品写修改意见（此时才开对话）
   │
   ├─► 套件工作台（网关域 Web，Codelphi 自建）——主界面
   │     材料、做课、构件、版本、下载、确认/重跑
   │
   └─► 云端 DSH（仅在有半成品且教师要改时出现）
         对话绑定当前构件版本；把修改意见变成 submit_lesson(rebuild=…)
         只挂网关 MCP，无 shell/fs/终端
              │  工作台 OIDC，token 直接作网关 Bearer（见 §5）
              ▼
Capability Gateway ── authorize/settle ──► 用户管理系统
   │  唯一 MCP；lesson 状态机（套件 SoR）；          Org / License / 护栏 / 台账
   │  adapters/* 调姐妹平台；本侧对象存储
   ▼
姐妹平台（各自托管、可 2C，partner 流量跳过自家积分）
   PPTCreator    数字人（成片）    AI3D    OpenMAIC?（待证伪）
   ppt+讲稿      人像成片          3D资产   若只做PPT则砍掉
        \            │
         \           ▼
          └──► 合成器（网关 worker）：PPT 播放画面 + 人像旁挂，不遮挡 PPT
                 → 讲解视频进套件
chandler.work: 身份 + 支付通道
```

职责：

- **chandler.work**：这人是谁 + 收单。不管业务授权，不管积分
- **用户管理系统**：这机构能用哪些能力、护栏还剩多少、成本多少
- **Capability Gateway**：执行裁决；**套件状态机（SoR）**；经 adapter 调姐妹平台；合成讲解视频。billing 与 execution 同进程分模块
- **套件工作台**：Codelphi 自建 Web（网关域）。**做课的主路径**（上传、按钮、文件、版本、确认）。不是 DSH `apps/web` 改皮肤
- **DSH**：挂在半成品上的 **返工对话运行时**。无半成品、无修改意见 → 不出现。不是 SoR、不是门户、不是「做课」入口。教师端 preset 只挂网关 MCP
- **姐妹平台**：各自 2C 产品。codelphi 只走 partner。渠道即账本（§6）对每个姐妹平台成立

网关与用户管理系统先做一个服务、两个模块。对外：**云端网关 + 套件工作台是 B2B 产品；DSH 是返工时嵌进去的官方 agent。** 契约不绑死 DSH——首轮做课可以完全不加载 DSH。

### 2.1 课程套件、编排与姐妹平台

**一套课（Project 上的 CoursePackage）是商品，能力平台是零件。**

目标产物（教师说「做课」之后应能打开的东西）：

| 构件 | 典型来源 | P0 是否交付 |
|---|---|---|
| 课程设计 | 网关 lesson step（LLM adapter），落本侧存储；教师点「通过」或对这份半成品提意见 | 是 |
| 教学大纲 | 同上 | 是 |
| PPT | PPTCreator partner | 是 |
| 讲稿 | PPTCreator 备注/讲稿管线（已有 script），必须随 partner 结果回报 | 是 |
| 练习 | 网关 step 先做；教师对题面提意见时才走返工对话。OpenMAIC 仅当贡献独特练习引擎时才接 | 否（P1） |
| 讲解视频 | 讲稿 → 数字人成片 → 与 PPT 播放视频左右合成 | 否（数字人 adapter + 合成器就绪后） |
| 3D 教具 | AI3D → 预览图 + 模型包，挂在课/页上 | 否 |

教师不挑「用 PPTCreator 还是 OpenMAIC」。内部默认：`ppt`+`讲稿` 只走 PPTCreator。

**设计/大纲的 provider 要新做。** 这两个构件没有姐妹平台可接：网关新做一个 LLM adapter（直连 LLM vendor，成本按 token 计 `vendor_cost`），capability 记 `design` / `outline`，与 partner step 一样过 authorize/settle（§4）。

**OpenMAIC：** 尚未深研。判决标准唯一——**它是否贡献套件里 PPT 以外的构件**（互动课、练习引擎、大纲结构等）。若实质上只是另一条出 PPT 的路，**不用**，避免两套课件引擎。Spike 两周内出结论进 §10，未证伪前不进 P0 架构。

**数字人管线（已定，非实时）：**

```
PPTCreator: 成品 pptx + 逐页讲稿
    ├─ 合成器: pptx → LibreOffice headless 逐页出图 → 按逐页讲稿时长 ffmpeg 播放条
    └─ 数字人平台: 讲稿 → 人像成片（绿幕/纯底均可）
         ▼
合成器: 画布 = PPT 主画面 + 侧面人像（不遮挡幻灯片）
         ▼
套件.讲解视频
```

- 合成器输入是**成品 PPTX**，不是 PPTCreator 的 HTML 中间态——HTML 有文本溢出等问题，成品 pptx 是其后处理结果，回放必须忠于成品
- 前提：渲染服务器装齐 CJK 字体（Noto Sans/Serif CJK；PPTCreator 生产事故的教训）；若开字体嵌入，LibreOffice 对 `.fntdata` 嵌入字体支持尚可
- 已知风险：LibreOffice ≠ PowerPoint 的渲染保真。spike 验收 = 拿 PPTCreator 真实产出的若干 deck 过一遍，人眼抽查可接受
- **合成器 spike 提前**：它是讲解视频链上唯一没有既有资产托底的环节，且反过来决定数字人 adapter 规格（绿幕/纯底、时长对齐）和 §8 第 9 条讲稿回报的字段（逐页讲稿是否需带每页时长）

数字人平台不负责排版、不负责实时驱动。合成器是 **codelphi 的 execution 职责**，不要塞进某一姐妹平台的 2C 产品里（它们没有「旁挂别人家 PPT」的动机）。

**编排：** 工作台点「做课」= 网关 `submit_lesson`（权威状态机），下面拆 step。教师看进度和文件。有修改意见才打开绑定该构件的对话；对话只把意见变成 `submit_lesson(rebuild=…)`，不决定拓扑。P0 不对教师暴露 `submit_ppt`。

**编排实现形态（约束）：lesson 拓扑硬编码在网关**（设计 → 大纲 → `awaiting_confirm` 确认门 → PPT+讲稿；缺件后补、单件重试）。确认门是状态机的正式状态，不是 UI 层把戏：教师在工作台点「通过，继续」才提交 PPT step，等待期间不持有任何预扣。每个 step 独立 authorize/settle（§4），不整单预扣。不做可视化 DAG、不做用户自定义工作流。CoursePackage 构件清单就是状态机。等出现第二种套件形态再抽象。

### 2.2 为什么要对话框，以及 DSH 何时出现

自然语言对话框比按钮贵、慢、易跑偏。它只在按钮表达不了的时候成立。

**「帮我做个课」不需要对话。** 意图已被 Project + 已上传材料 + 可选「补充说明」文本框完全确定。用嘴说同一句话，比点「做课」慢，还会诱使 agent 连问八个澄清问题。首轮路径必须是：

```
上传章材料 →（可选）补充说明：学时/专业/风格 → 做课 → 工作台出半成品
```

补充说明是表单字段，进 `submit_lesson` 的 spec，不是聊天线程。

**对话框只服务对半成品的修改意见。** 教师已经看见某一版设计/大纲/PPT/讲稿，意见是指代性的、开放的、要迭代的：「第 3 页那个案例换成食堂」「讲稿第二段太书面」。这填不成表单，也不该整份重填材料再按一次「做课」。

因此对话必须：

- **有半成品才出现**（绑定 `artifact_id` / 当前版本；空状态不是首页）
- **入口是「对这一份提意见」**，不是全局「问助手」
- 把意见变成 `submit_lesson(rebuild=ppt, critique=…)`；P0 整份重跑出新版本，不打单页重生

**确认不等于对话。** 大纲出来点「通过，继续生成 PPT」是按钮。只有「大纲里第三节要改成案例课」才开对话。不要用 DSH plan/approval 冒充确认框。

**失败不等于对话。** `quota_exhausted` 等工作台横幅 + §5 话术。不要为了用 agent 把错误弹进聊天。

三层仍然成立，主路径改了：

| 层 | 谁 | 主路径 | 返工路径 |
|---|---|---|---|
| 套件状态机 | 网关 | 按钮触发 `submit_lesson` | 同一接口 `rebuild` |
| 套件工作台 | 网关域 Web | 上传、做课、看文件、通过 | 「对这一份提意见」打开对话 |
| 返工对话 | DSH | **不出现** | 绑定当前构件，改意见 → 重建 |

**一句话：** DSH 是半成品上的返工 agent，不是做课入口。无半成品则不加载。CoursePackage 的 SoR 仍是网关。

用足 DSH 的地方：指代消解（「这一页」「那个例子」）、把散意见收成一条 rebuild spec、对比版本差。不用它做 CMS、不用它问「你想做什么课」。

**刻意不用的 DSH 能力：** shell/fs/终端、本地 workspace、默认 `web_fetch`、插件市场、trajectory 当主界面、用对话发起首轮生成。

**云端化：** 多租户的是返工时的 agent host（会话按 member × project × artifact 隔离）。工作台自建。P0 可以先只做按钮做课；返工对话后嵌。没有半成品的「空聊天」不准上线。

**身份：** 工作台是 OIDC RP（单应用单 client）；DSH 仅在打开返工面板时拉起，用同一张网关 token。

**姐妹平台 Partner 通则**（§8 是 PPTCreator 实例，其它平台各填一张表）：服务账号认证；上下文带 org/member/job；旁路自家 2C 积分与 dashboard；回报成本与产物到本侧对象存储；材料用本侧签名 URL 交换，不经 MCP 传大文件。

**渠道即账本推广：** 教师打开 PPTCreator.com 走个人积分；打开数字人 2C 站点走那边的账；只有经 **套件工作台 / 网关** 的流量记入机构 License。四条缝都存在，销售不承诺「校本只能在本平台生成」。

## 3. 商业模式与授权模型

核心实体是挂在机构上的 License（按年买断）。codelphi **没有个人积分**（见 §6）。

### 数据模型（用户管理系统）

**Org** — 机构客户（= 成交落地单位，不是「一所大学」）
`id, name, status(active/suspended), 联系人信息, 发票抬头/税号/银行信息/付款单位(可与 name 不同), created_at`
- 高校一单通常是某学院或某教研室。另一学院再买 = 另一个 Org、另一份合同，不挂到同一棵全校树下
- 全校统签是例外，不为其预埋角色系统

**OrgUnit** — 组织节点（自引用树，行业通用；本 Org 内部的分组）
`id, org_id, parent_id(可空), name, label(自由文本), allocation_mode(over|strict)`
- 高校实例化为学院客户下的"教研室/课程组"，媒体单位实例化为"栏目组"——label 是 preset 文案，不进 schema
- 用途首先是**挂人、摊销、报表**；帽是可选治理，不是稀缺分配器，未设帽 = 不限
- `allocation_mode` 默认 `over`（子帽总和可超父池）；P0 不做设帽 UI
- 深度上限建议 4

**Member** — 机构成员
`id, org_id, chandler_sub, role(owner/admin/member/viewer), status(invited/active/disabled), invited_at, invite_expires_at, disabled_at, disabled_by`
- `(org_id, chandler_sub)` **联合唯一**——一人可进多个机构（多个 Org 客户）
- Member ↔ OrgUnit：schema 保留 M:N，**P0 每人只挂一个 unit**（邀请/导入默认单归属），双聘场景出现再打开
- `viewer`：能看账单/用量但不能生成（财务/审计）
- 个人帽（如设置）语义：该 Org、该能力、该周期的上限，不按教研室分别设

**PackageTemplate** — 套餐模板（销售侧）
`id, name, items[](capability, quota, unit), 年限(1/2/3), 参考价`
- items 里的 quota 是内部护栏初值，不是合同数字

**License** — Org 的套餐实例
`id, org_id, contract_no, valid_from, valid_to, status(pending/active/expired/suspended), payment_channel(offline/chandler), 实收金额`
- 套餐内容**快照**在 License 上；**快照不可变，变更是新事件**：续费/增购 = 新 License 或 LicenseAmendment，禁止改历史快照
- **成本预警是按年卖模式下唯一的风控**：`sum(vendor_cost) / 实收金额` 超阈值（建议 60%）告警运营；告警应能按 **capability 拆开**看（数字人把毛利吃光时 PPT 还在正常用）
- 多 License 并存时消费顺序：**先到期者优先**（valid_to 升序），单 job 不跨 License 拼凑（估计值必须落在单一 License 的根池内）；增购是新池，旧的用尽才动新的

**QuotaPool** — 配额计数器。**计数器只存在于两类行：Org 根池（每单必有）+ 被显式设帽的节点（稀疏存在）**
`node_type(org/unit/member), node_id, license_id, capability, unit(count/second/minute), total, used, period_start, period_end`
- `total` 是**内部护栏值**（按目标教师规模 × 预期用量 × 3~5 倍余量估），防账号外借/脚本化滥用把 vendor 账单打穿；不出现在合同
- 报表不读计数器（见 §4 记账纪律）
- 配额周期按授权年分条，高校对齐**学年**（九月起算），不硬编码自然年；年未不结转
- 新周期/新 License 的 unit 帽**不静默复制**去年设置；可做「按去年比例复制」运营按钮

**Project** — 一课/一章的工作容器，上面挂 **CoursePackage（套件）**
`id, org_id, unit_id, owner_member_id, type_label, title, created_at`
- P0 强制绑定 submit；`create_project` 即「先建课再填套件」
- 教师的心智单位是「这一课」，不是「一次 chat」或「某一个平台」

**Material** — 章材料（`submit_lesson` 的输入）
`id, project_id, kind(pdf/docx/image/text), storage_ref, uploaded_by, created_at`
- 进本侧对象存储（org 前缀）；spec 只引用材料指针，不经对话/MCP 传原文

**CoursePackage** — 一套课的构件清单（挂在 Project 上）
`id, project_id, status(draft/building/ready/partial), lesson_job_id`
- Artifact：`kind(design|outline|ppt|script|exercise|lecture_video|asset_3d), status, step_job_id, storage_ref`
- **Artifact 留版本**：每次重建产生新版本行，当前指针指向最新；教师迭代十几次是常态，历史版本可回看可下载。UsageRecord 挂 step_job_id，成本侧不受影响
- 教师看见的是 artifacts 列表。P0 必齐：design / outline / ppt / script
- 与 PPTCreator Project：一次 partner 生成对应套件里的 PPT+讲稿；C 端 dashboard 永不可见

**UsageRecord** — 只增台账，**一切报表的数据源**
`id, job_id(唯一索引, 幂等键), org_id, license_id, member_id, unit_id, project_id, capability, amount, unit, vendor, vendor_cost, status(reserved/settled/refunded/expired), created_at, settled_at`
- **一次尝试一个 job_id**：重试 = 新 job、新预扣，不在 refunded 行上复活
- 两个数字：`amount` 内部计量（护栏分母），`vendor_cost` 己方成本（毛利依据）
- **云端 DSH 的 agent LLM token 成本也进本表**（capability 记 agent 侧，如 `agent_llm`；挂 member/org/project）——审计账从「课程设计」这第一个构件起就是全的
- 按成员/教研室/项目的用量报表全部从本表聚合（P0 至少能出「成员用量 Top」）；成员调岗历史记录不改

**AuditLog** — 只增审计
`id, actor, action, target, before/after, created_at`
- License 状态变更、改帽、停用成员、partner 调用、authorize 拒绝，全部落库

### 收款两条路径

- 公对公转账（主流，一等公民）：销售建 `License(pending)`（合同号、快照、应付金额）→ 财务确认到账（可填银行回单号）→ 确认后 `pending → active`（高额建议双人确认）→ 开错走 `active → suspended` + 审计，不删行。P0 运营后台含 **CSV 批量导入成员**（工号/姓名/邮箱/unit 名 → 发邀请，运营代导入；机构自助入口 P1）——200 名教师的学校不能靠邀请码
- 在线支付（少数）：走 chandler 支付通道，回调自动开通；webhook HMAC 验签 + 条件更新履约幂等，搬 PPTCreator `lib/chandler-pay.ts` 经验

## 4. 配额与计量

### 记账纪律（先于闸门语义）

**计数器服务闸门，台账服务报表，两者不交叉。**

- authorize/settle 只读写**实际存在**的计数器行：根池 + 被显式设帽的节点。未设帽的节点没有 QuotaPool 行，天然跳过
- 报表一律从 UsageRecord 按 `org_id`/`unit_id`/`member_id`/`project_id` 聚合，**禁止** `SUM(children.used)`，也禁止对帽行 `used` 做跨行合计
- 日对账口径唯一：根池 `used` == `sum(UsageRecord.amount where settled)` + 在途 reserved 预扣（按 license+period+capability；实现里 drift = used − settled − reserved，允许在途延迟，不允许长期漂移）；帽行 `used` 只服务自身闸门，不进对账

### 闸门：authorize / settle

**authorize**（提交 job 前）
```
入: orgId, unitId, memberId, projectId, capability, estimatedAmount
出: { allow, reservationId }
  | { deny, reason }
```
顺序：License 有效期与状态（多 License 取先到期者）→ 能力在套餐内 → 成员个人帽（若存在）→ unit 帽（若存在）→ 根池。每层 `used + estimated <= total` 条件更新，一个事务内完成。
估计值：PPT 整份生成 `estimated = actual = 1`（内部计量单位）；讲解视频/数字人按讲稿时长（秒）。
**耗尽是运营事件，不是销售漏斗**：撞护栏 = 滥用或用量超预期，运营人工介入（联系机构或直接提护栏）。agent 话术统一「联系本机构管理员/客服」，不按层导流。

**扣费粒度 = step，不是 lesson。** lesson 状态机在每个 step 提交前各自 authorize、结束后各自 settle；确认门（§2.1）等待期间不持有预扣——教师停在大纲三天，根池不为未提交的 PPT 占额度。

**agent_llm 也过闸门。** 返工对话的每次模型调用前按 token 上限 authorize、按实际 usage settle；帽可以很宽，目的是防脚本化刷对话，不是向机构卖 token。billing 不可用 fail-closed，同 §5 `billing_unavailable`。首轮做课的设计/大纲走 `design`/`outline` capability，不混进 `agent_llm`。

**settle**（job 结束后，按 jobId 幂等）
```
入: reservationId, jobId, actualAmount, vendorCost, outcome(success/failure)
```
成功：各命中行预扣调整为实际值，写 vendor_cost → settled；失败：链上各层全额退回 → refunded。
状态迁移：`reserved → settled | refunded | expired`，重复回调无害。
**超支策略 P0 不适用**（PPT 1:1），数字人/讲解视频开门前再拍。

### 生产语义

- **Reservation TTL**：大于最长能力 SLA 加余量（建议 24h），到期 `reserved → expired` 自动退回；扫尾与 settle 抢同一行靠条件更新，谁先谁算
- **日对账**：根池/台账/vendor 账单三角对齐（允许延迟，不允许长期漂移）。对账跑不通不接第二个能力
- **宽限期**：有效期只在 authorize 时检查；已 reserved 的 job 跑到结算。`org_suspended` 不杀 in-flight，但运营后台可见"暂停后仍在跑的 job"
- **成本数据源在哪侧**：能力服务内部再调付费 vendor 的，由能力服务回报成本；网关直连 vendor 的，网关自己记账；云端 DSH 的 agent LLM 由云端 provider 记账
- **账号共享**：不做验证（技术上做不到可靠判定）。合同禁转租条款 + 护栏值 + 用量异常告警（运营信号，非自动执法）三层兜底

## 5. 身份与令牌链路

```
教师浏览器 → chandler OIDC（单应用单 client：codelphi，RP = 套件工作台）
    → 签发的 token 直接可用作网关 Bearer（aud = codelphi 的 client_id）
    → 网关验签(iss/aud/exp), 以 sub 问用户管理系统解析 (memberId, orgId), 短缓存
    → authorize → 放行
返工时：工作台拉起 DSH host（同一登录），DSH 只持有同一张网关 token
```

- **单应用单 client**（2026-08-24 第十一轮改口，撤 §18 的「双 client + token exchange」）：chandler 不支持 token exchange（`/v1/oauth/token` 仅 `authorization_code`/`refresh_token`），且其语义中 client_id = 应用，一个产品不应拆两个应用。工作台登录与网关验签共用同一 client_id。备选（拆双 client）待 WorkMembership 支持 RFC 8693 后再议
- **JWT 校验**：JWKS 缓存 5 分钟、拉失败留旧缓存；`iss` 按字符串比对（值为 `workmembership`）；**`aud` 必须等于本网关的 client_id**；校 `exp`。参考实现：WorkMembership `tools/mcp-spike/`（纯标准库 JWKS 拉取 + RS256 验签）。DSH 侧 refresh 轮换用 `dsh-credentials` 的 `modifyRecord`
- **chandler 对接事实**：JWKS URL = `https://api.chandler.work/.well-known/jwks.json`；发现文档 `/.well-known/oauth-authorization-server`；client 自助注册 `POST /v1/me/oauth/clients`（secret 仅注册时返回一次）
- **一人多机构**：客户端显式带 `X-Org-Id`，必须是该 sub 的 active membership，否则 `org_mismatch`（租户隔离，记安全日志）；未带且唯一归属可默认但**回显实际 org**；未带且多机构 → `org_unspecified`
- **OrgUnit 归属**：`X-Unit-Id` 同款；P0 单归属可默认并回显；带了但不属于该成员或不属于该 org → `unit_mismatch`（与 `org_mismatch` 同级）
- **`X-Org-Id`/`X-Unit-Id` 以登录态/会话绑定为准，绝不接受模型填写**
- **成员 disable 主动失效缓存**（删 `member:{sub}:{org}` 键），不靠 TTL
- token 走 `dsh-credentials` grant 记录（服务端），不进 `.env`

### 模型可见错误面

| reason | 语义 | agent 引导方向 |
|---|---|---|
| `license_expired` | 授权到期 | 联系销售续期 |
| `quota_exhausted` | 内部护栏被触达（罕见） | 联系本机构管理员/客服；运营事件，非升档话术 |
| `member_cap_exhausted` | 被显式设置的个人帽到了 | 找本机构 admin 调帽（内部治理） |
| `capability_not_entitled` | 套餐不含此能力 | 说明套餐范围 |
| `org_suspended` | 机构被暂停 | 联系客服 |
| `identity_unbound` | 未绑定机构 | 邀请码/联系管理员 |
| `member_disabled` | 账号被停用 | 联系机构 admin |
| `org_mismatch` / `unit_mismatch` | 组织头不属于此 sub/成员 | 检查客户端配置（疑似 IDOR，记安全日志） |
| `org_unspecified` / `unit_unspecified` | 多归属未指明 | 引导用户选择 |
| `project_unspecified` | 未绑定 Project | 工作台先建课；agent 返工时若无绑定则拒绝，不在聊天里建课 |
| `reservation_expired` / `job_canceled` | 预扣过期 / job 已取消 | 重新提交 |
| `billing_unavailable` | 计费服务不可用 | fail-closed，稍后重试 |

结构化字段进工具返回值（含 `remaining`、`reset_at`、`admin_hint`）——网关错误面即 agent 引导脚本。

## 6. 双身份问题：渠道即账本（最终决议）

同一人可以既是某姐妹平台的 2C 用户，又是 codelphi 机构成员。

**决议：扣哪本账由入口决定，系统内不存在路由问题。** 对每个姐妹平台都成立，不单是 PPTCreator。

- **codelphi / DSH / 网关**：只走机构闸门，fail-closed。没有个人积分账本
- **姐妹平台自己的站点**：永远扣它们自己的 2C 账，对机构一无所知，C 端逻辑零改动（它们还要自己发展 2C）
- 机构成员用机构额度干私活：不防、不问，属机构内部治理
- **产品缝（结构如此）**：教师可以在 PPTCreator / 数字人 2C 上做校本，学校在机构报表里看不见。销售不承诺「校本只能在本平台生成」

## 7. 长任务与 lesson 编排

PPT 几分钟；数字人成片 + PPT 渲染 + 合成是分钟到小时级。**不建模为同步工具调用。** 实时数字人驱动不在范围内。

- **两层 job**：`lesson` 下面挂 `step`。权威在网关。缺视频仍可先交 PPT+讲稿。lesson 状态含 `awaiting_confirm`（大纲就绪、等教师「通过，继续」）；确认后才提交 PPT step；每 step 独立 authorize/settle（§4）
- 进度以工作台为准（`get_package`）。DSH `dsh-jobs` 只在返工对话打开时作通知
- **教师面（工作台）**：上传、做课、通过/继续、下载。不要把平台名暴露成选项
- **返工对话（DSH，有半成品才挂）**：`get_package` / `submit_lesson(rebuild, critique)`。会话绑定 `project_id` + `artifact_id`。不暴露 `submit_ppt`，不 `create_project`（建课在工作台）
- query 带构件列表 + 签名 URL。文件经本侧对象存储
- 并发公平按 **(org, platform)**
- 合成器是网关 worker：成品 pptx 经 LibreOffice 逐页出图 + 人像成片 → 旁挂讲解视频

## 8. PPTCreator 改造清单（partner 模式，adapter 第一实例）

原则同 §2.1 Partner 通则：partner 流量 = 纯机构流量，PPTCreator 退化为执行引擎；C 端站点逻辑零改动（它们还要自己做 2C）。partner 认证后请求上下文带 `billingMode=partner` 与 `jobId`，worker 只认这个上下文——不用「userId 白名单」。其它姐妹平台各填一张同结构的表，缺一格就不能标「已接入」。

| # | 改造点 | 位置 | 不改的后果 |
|---|---|---|---|
| 1 | 可信伙伴认证（partner API key 或 mTLS），上下文传 `X-Org-Id`/`X-Member-Id`/`X-Job-Id` | `/mcp` 路由层 | 终端用户走不通 OAuth 授权码流程 |
| 2 | 旁路 MCP 入口 credits 预检 | `lib/mcp/server.ts` `checkUserCredits` | 入口 402，B2B 跑不起来 |
| 3 | **旁路 worker 实扣与下载锁** | `worker/jobs/html-export.ts` `deductCreditsGuarded` / `downloadLocked` | 双扣；或生成成功但下载被锁 |
| 4 | 用量/成本回报（实际页数 + LLM token 用量，状态查询或 webhook 捎带） | worker 完成路径 | PPT 毛利是盲的 |
| 5 | 限流权属移交：partner 不按人限流；保留 `partner:{orgId}` 全局护栏 | `lib/mcp/` 限流 | 机构第 21 个成员当天用不了 |
| 6 | job 隔离：`Project` 加 `source=partner` + `orgId`，C 端列表默认 `source IS NULL` | `app/dashboard/*` | 机构稿件出现在员工个人 dashboard |
| 7 | 下载鉴权：`getPresignedDownloadUrl` 校验调用方仍是该机构成员，TTL 对齐网关轮询 | 下载路径 | 离职成员仍可下载 / URL 过期 |
| 8 | partner 流量拒绝/忽略单页重生 API | `/slides/[n]/regenerate` 路径 | agent 把一页抠 20 次，LLM token 成本失控（成本护栏，非计费口径） |
| 9 | **讲稿必须回报**：完成响应带逐页备注/讲稿（管线已有 script），与页数对齐；是否需带每页时长由合成器 spike 定 | worker 完成路径 / MCP status | 数字人没有合法输入，会去猜 PPT 正文 |
| 10 | partner 生成需支持多文档输入（课文、教学设计等多份材料，来自套件 materials[]） | 生成 API / worker 入参 / 数据模型 | **已确认不支持**：MCP 只收单 `document_id` 或单段文本，worker 对 `project.document` 单一文档硬依赖（`worker/jobs/generate-slides-simplified.ts`） |

第 10 条的两个方向（PPTCreator 路线图本就有多文档计划，方向一为归宿）：

- **方向一（正解）：PPTCreator 侧 Document 改 1:N**（或引入「材料包」），课文与教学设计等保持各自身份进生成。改动落在数据模型 + worker 主链，随其既有路线图做
- **方向二（P0 过渡）：网关/adapter 侧预合成单文档**再提交，PPTCreator 零改动；代价是课文与教学设计的主次关系在拼接处丢失，只用于方向一落地前解 P0 的急

**验收测试（partner 模式完工定义）**：打一条 partner 生成，断言 `UserProfile.freeCreditsRemaining` 不变、`downloadLocked=false`、网关 UsageRecord settled、C 端 dashboard 不可见、**讲稿非空且页数对齐**。

不动的：解析/渲染管线、字体体系、Web 应用本身、C 端积分与 OAuth 体系。不要在网关 execution 核心写死 PPTCreator 的 MCP 工具名；网关以 partner 身份调 create/status/download。

## 9. DSH 侧改动清单（返工对话运行时）

角色见 §2.2。无半成品不启动。不把 `apps/web` 当门户。

1. **按构件拉起**：入口是工作台「对这一份提意见」。会话键 = member × project × artifact 版本。禁止无上下文的全局 `/chat`
2. **受限 preset**：只挂网关 MCP（`get_package` / `submit_lesson` rebuild）。不挂 shell/fs、不挂 `web_fetch`、不 `create_project`
3. **LLM 计量**：仅返工对话的 token 记 `agent_llm`（宽帽，每次调用过 authorize/settle，见 §4）。首轮做课的设计/大纲 LLM 记在网关 step 上（`design`/`outline`）
4. credentials：工作台已登录；DSH 用同一张网关 token（单 client，见 §5）
5. 系统提示注入当前构件（页数、讲稿摘要、教师选中的页）。指代「这一页」必须能落地
6. 产出只有 rebuild spec，不在聊天里当文件柜
7. **不用** plan/approval 做「确认生成 PPT」——那是工作台按钮
8. 工作台进度条读网关；DSH jobs 可有可无
9. OpenMAIC 未证伪前无 `classroom`

P0：工作台「做课」必须先通。返工对话可紧随其后，但不得阻塞首轮交付。空聊天不准上线。

## 10. 开放问题

### 已定默认（工程按此建，商务可特批）

| 项 | 默认 |
|---|---|
| 商业模式 | 按年买断，不按份；合同 = 年限/价格/能力范围/SLA/合规/禁转租；配额为内部护栏 |
| 配额周期 | 按授权年分条；高校对齐学年（9 月）；年未不结转（特批 ≤ 20% 且限次年用完） |
| 续费/增购 | 新 License / LicenseAmendment，旧的 expire，不改快照 |
| 多 License 消费 | 先到期者优先，单 job 不跨池 |
| allocation_mode | `over` |
| 超支策略 | P0 不适用（PPT 1:1）；数字人/讲解视频开门前拍板 |
| 首期范围 | **商业 P0** = 工作台传材料 → 做课 → 交出设计/大纲/PPT/讲稿。**返工** = 对某一构件提意见出新版本（DSH，有半成品才出现）。架构 = 网关 + 工作台 + Adapter/PPTCreator + 对象存储；DSH host 只服务返工，可后嵌但空聊天不准上线。练习/讲解视频后续 |
| 技术栈 | Go + MySQL + sqlc，独立仓库；Redis 只做限流与成员解析短缓存 |
| 部署 | 现阶段业务域名 `app.codelphi.com`，生产机 124.156.160.168（VM-32-3，本机持有密钥可直接部署；Go 静态二进制 + systemd，监听 127.0.0.1:18080，nginx 反代，certbot 证书自动续期；不用 Docker）。原 101.32.49.240（VM-16-7）2026-08-24 资源耗尽挂掉后迁移至此。生产库 = 腾讯云 MySQL 集群；本地有 MySQL 环境（凭据放本地环境/密钥管理，不入库） |
| OrgUnit UI | P0 分组/挂人/报表；不做划拨界面 |
| 生成物归属 | 合同期内机构可下载；到期后保留 90 天只读下载，之后按 org 前缀删除；离职成员失去下载权，产物留在 Project/机构 |
| 单页重生 | P0 不暴露（成本护栏） |
| 账号共享 | 不验证；合同禁转租 + 护栏 + 用量异常告警 |
| vendor 配置 | P0 最低：vendor 在配置里显式、可换（默认国内模型）；org 级 vendor 白名单 P1 |
| 编排形态 | 首轮做课 = 工作台按钮 → 网关固定状态机。对话 = 半成品返工，不是入口 |
| 扣费粒度 | 按 step authorize/settle，不整单预扣；确认门（`awaiting_confirm`）等待期间无预扣 |
| 设计/大纲 provider | 无姐妹平台可接，网关新做 LLM adapter，capability 记 `design`/`outline` |

### 仍开放（影响合同或合规，销售开口前要书面）

1. 教材正文送哪些 LLM、是否允许境外、是否书面承诺「不用于训练」——招标要书面答案。须扩成 **按姐妹平台的数据处理清单**（各自是否自托管、是否出境、是否用于训练）；云端 DSH 后此条覆盖 agent LLM 本身
2. 第一所试点校的组织细节：学院数、是否双聘（决定 P0 是否冻结 Member↔OrgUnit 的 M:N）
3. 内部报价模型：目标教师规模 × 预期用量 × vendor 成本 + 目标毛利——内部文档，第一份合同的数字从这里出
4. **OpenMAIC spike（两周时间盒，唯一判决）**：它是否贡献套件里 PPT **以外**的构件。若只做 PPT → 不用。未证伪前不进 P0、不出现 `submit_classroom`
5. 数字人平台、AI3D 的**正式产品名**与是否自托管（文档里暂用类别名）
6. 数字人/讲解视频开门前的超支策略（护栏 unit = second/minute，估计值 = 讲稿时长）
7. 云端 DSH 会话隔离：默认共享进程 + `member_id` 分区持久化（§2.2）；实现选型（MySQL vs 对象存储 session backend）P0 内定，但不要再评估「一教师一进程」

## 附：讨论中否决/降级的方案

- DSH 直接对接各 vendor（key 下客户端）——否决，key 必须留云端
- 每能力建 DSH 原生 capability seam——暂缓，MCP 统一工具面先行
- chandler Wallet 实时扣费——否决，chandler 只是支付通道，不知道积分；积分账本在业务系统
- codelphi 个人积分账本 / billing context 选择器 / 同意式回落 / `resolveConsumption` 路由查询——全部否决，渠道即账本（§6）
- **按份计费、迭代系数报价、「份」的合同定义——否决**，按年卖（§1）；单页重生 P0 不暴露仅为成本护栏，非计费口径
- **账号共享检测——否决**（做不到可靠验证）；合同禁转租 + 护栏 + 告警兜底
- 全校配额树 / unit 级 RBAC / 分层耗尽导流（`unit_cap_exhausted`）——否决，成交粒度是院系（§13 G）
- PPTCreator 内部 credits 与网关配额并存于 partner 路径——否决，单闸门
- 视频/数字人首期写进买断包——暂缓，单位经济未验证前不把 GPU 账单写进长约；P0 套件切片不含讲解视频
- **实时数字人 / `realtime_stream` 作为主路径——否决**。数字人 = 讲稿成片 + 旁挂合成（§2.1）
- **把四个平台做成教师可选工具——否决**。首轮做课是一个按钮
- **用对话框作为「做课」入口（「帮我做个课」）——否决**。比按钮慢；对话只服务对半成品的修改意见（§2.2）
- **用 DSH plan/approval 冒充「确认生成 PPT」——否决**。确认为工作台按钮；有修改意见才开对话
- **无半成品的全局聊天首页——否决**
- **OpenMAIC 默认当 classroom、与 PPTCreator 抢 `ppt`——否决，除非 spike 证明它贡献 PPT 以外构件**。若只做 PPT → 不用 OpenMAIC
- **P4 才做跨能力编排——否决**。P0 即 lesson 状态机，构件分期交付
- 合成器塞进某一姐妹平台的 2C 产品——否决，旁挂别人家 PPT 不是它们的 2C 动机；合成是网关 execution
- **桌面 DSH 作为首期形态——撤回**。教师端是浏览器；DSH 只在返工时拉起。官方 `apps/web` **不当门户**
- **PPT 播放条复用 PPTCreator HTML 中间态——否决**
- **DSH 当套件 SoR / 自己跑 lesson 拓扑——否决**
- **把套件工作台做进 DSH chat——否决**
- **「无 shell 即无需租户隔离」——否决**

---

## 11. 评审意见（2026-08-24，原文保留）

对照物：本设计原文；PPTCreator（`lib/credits.ts`、`lib/mcp/server.ts`、`worker/jobs/html-export.ts`、`docs/mcp-server-design.md`）；WorkMembership / Chandler（JWKS、`aud`、支付回调、MCP spike）；DSH（`dsh-mcp-client` 默认 60s 超时、`dsh-jobs` 进程内、`dsh-credentials` grant 记录）。

**总评：** 职责切分（chandler 管人、本系统管授权、网关管执行、PPTCreator 退化为引擎）是对的，authorize/settle + 合同快照 + 错误码即 agent 脚本这三件事也是对的。文档目前是一张「怎么收费、怎么拦」的图，还不是一张「卖给谁、为什么买、第一期交什么、怎样不亏钱」的图。最大的业务风险是买断制扛不住视频/数字人的成本方差；最大的技术风险是 PPTCreator worker 主链漏旁路，以及 B2B 失败时扣个人积分。

下面意见按「先业务、后技术」写。每条有结论、理由、建议。

### A. 业务

#### A.1 先写清楚卖的是什么

原文从架构起笔，没写购买理由。机构不会因为「我们有一个 Gateway」掏钱，他们已经能分别买 PPTCreator、可灵、剪映、HeyGen。

这个产品只在下面这句话成立时成立：

> 一份合同、一个身份、一本审计账，加一个能把材料串成「PPT → 配图 → 讲解视频 → 数字人口播」的 agent。

若交付物只是四个互不相干的 `submit_*` 工具，机构会拆单采购，你变成四家 vendor 的转售商，毛利被夹死。**编排才是商品，能力是零件。** 原文把能力当一等公民、把跨能力工作流留白，顺序反了。

建议在开工依据里补三句话，写不出来就不要同时上四项能力：

1. 第一类买家是谁（培训公司 / 咨询 / 政企宣教 / 高校？四者采购周期、数据驻留、终端用户完全不同）
2. 他们今天怎么做同一件事，痛在哪（多工具、多账号、无法审计、不会写提示词）
3. 买了之后一周内谁、在哪、完成哪件具体工作

没有第一名真实客户的作业流程，配额单位和套餐包都会拍错。

#### A.2 买断 + 限量是不稳定的商业结构

一次性买 1/2/3 年使用权，再配有限配额，看起来好签、好开票，但对卖方极不友好：

- **成本在你侧浮动。** 视频、数字人按秒/按 GPU 向 vendor 付现；PPT 的 LLM token 也在涨。合同锁死客户单价，vendor 一调价，长约变亏损合同。
- **用量时间分布极不均匀。** 三年总池会被「验收前突击」或「第三年年底清空」打穿。这不是技术问题，是销售话术问题。
- **能力之间的成本数量级不同。** 一份 PPT 的 LLM 成本与一分钟数字人不是同一个数量级。`PackageTemplate.items[]` 把「50 份 PPT + 30 分钟视频 + 100 张图」捆在一起，销售讲不清，财务算不清，客户用的时候会把便宜的配额当贵的花。

建议：

- 对外报价按能力拆行，可以捆成套餐，但每项有独立单价与独立余量，禁止「一笔配额万能兑换」。
- 合同写清：过期作废、超额停用（或超额按价目表另结算，需另签）。不要靠「先做了再补钱」——公对公补款周期以周计，期间你在垫付 GPU。
- 每份 License 设**成本预警**：`sum(vendor_cost) / 实收金额` 超过阈值（建议 60%）告警运营，而不是等三年后才发现这份合同在亏。
- 视频/数字人首期不要进买断包，改「预充次数/分钟、用完再买」。PPT 相对可预测，适合买断。

单位经济不进设计文档，authorize/settle 写得再严谨也只是把亏损计量得很精确。

#### A.3 配额周期与续费：这是合同条款，不是技术细节

原文把「三年总池还是按年重置」「续费改 `valid_to` 还是新 License」放在开放问题。这两条决定毛利和审计，应在销售见客户前写成标准合同条款。

建议条款（可被商务特批覆盖，但默认必须有）：

| 条款 | 默认 | 为什么 |
|---|---|---|
| 多年合同的配额 | 按自然授权年重置 | 避免用量堆积到成本更高的未来 |
| 年未用完 | 不结转；特批最多结转 20% 且限下一年用完 | 结转 = 把今年的负债延到明年 |
| 续费 | 新 License，旧的 expire | 合同号、快照、实收必须一对一 |
| 增购 | LicenseAmendment 或新 License，禁止改历史快照 | 销售会改配额，改快照会毁掉审计 |
| 暂停 | `org.suspended` 立即拦新任务；已 reserved 的跑完 | 与原文宽限期一致，合理 |

「快照在 License 上」这条原文是对的，补一句：**快照不可变，变更是新事件。**

#### A.4 付钱的人和干活的人不是同一个人

B2B 里采购/IT/财务买，业务人员用。原文的数据模型围着「使用者 + 配额」转，围着「买家」的几乎没有：

- 合同、发票、到账凭证、开通 SLA（公对公到账后几小时内开通？）
- 按部门/项目出用量，而不仅是按人（很多机构要这个才能内部摊销）
- 续约前 60/30/7 天的余量与用量报告（运营不主动塞到采购桌上，到期就是流失）

`role(owner/admin/member)` 偏薄。至少要能表达：能开通成员的人、能看账单但不能生成的人（财务/审计）、能生成但不能邀人的人。财务角色没有，第一份对公合同的客户就会问「谁来对账」。

个人限额（MemberCap）不默认建行是对的——但上线 30 天后几乎一定会被要。典型事故：一个熟手把机构池烧光，其他人停工。建议在 admin 后台提供「按均分 × 1.5 一键设帽」模板，不必首期自动创建行。

#### A.5 双身份回落：不要把 C 端钱包当 B2B 的保险丝

原文 §6 把「机构优先、同意后扣个人积分、系统挂了也扣个人」写成规则。这是本设计里最危险的产品决策。

会实际发生的事：

1. 员工用 DSH 给公司做 PPT，机构配额用尽，agent 问「扣你个人积分吗」，员工为了交差点是 → 公司活、私人付，事后报销扯皮。
2. 用户管理系统抖动 2 分钟，全员被切到个人积分 → 机构月报是 0，PPTCreator 积分账户出现一堆公司 job，对账无法自动完成。
3. 「可退可补」在公对公世界里不是按钮，是一封邮件加一周。

法律与财务上，个人积分是 C 端用户与 PPTCreator 的预付资产，不是机构 License 的备用金。未经机构授权把公司作业记到个人预付上，续约时采购会认为你们账是乱的。

建议改成三条硬规则：

1. partner / DSH / 任何带 `X-Org-Id` 的流量：**只走机构池**。尽或挂，返回 `quota_exhausted` / `billing_unavailable`，结束。
2. PPTCreator **网页 C 端**可以做同意式回落，且仅当 `resolveConsumption` 明确返回「有机构身份但该能力池为 0」。系统不可用时 C 端也 fail-closed（宁可这次做不了，不要悄悄扣错钱包）。
3. 同意记录若要给机构审计看，等于承认公司作业用了私人资产——多数机构合规会直接禁止。与其做审计，不如不做这条路。

「单闸门」与「系统挂了走另一扇门」是矛盾的。单闸门意味着失败即停。

#### A.6 DSH 是渠道，不是产品本身

原文把 DSH 当用户使用的桥，清单里却几乎只改 DSH。机构客户常见诉求是：网页、飞书/企微机器人、自己的业务系统 API。MCP 网关一旦做成，WorkBuddy、其他 MCP 客户端、HTTP API 都该能打进来——Chandler 侧 WorkBuddy 引流已经验证过这条路（见 `WorkMembership/docs/memos/workbuddy-integration-plan.md`）。

若把 DSH 做成唯一客户端：

- 销售必须先教会客户用 agent，转化路径变长
- 桌面分发、版本、OIDC loopback，全是你的支持成本
- 客户 IT 会问软件白名单、自动更新、数据是否出域

建议对外定位：**云端能力网关是产品，DSH 是官方客户端。** 首期可以只做官方客户端，但网关契约（MCP + 将来的 HTTP）不要绑死 DSH 私有头。`X-Org-Id` 这类头要写进网关文档，当稳定 API。

云端多租户 DSH（per-tenant e2b）首期明确不做。理由不单是工期：`dsh-jobs` 非持久化、沙箱逃逸、密钥注入、会话隔离，每一项都够单独立项。部分政企客户会**要求**本地运行。桌面 DSH + 云端网关，正好同时满足「模型在本地、能力在云端、key 不落地」。

#### A.7 合规、资产、驻留：B2B 不写就会在投标死

原文零涉及。机构采购会问，答不上就丢标：

- 生成物归谁？合同期内能否下载历史？到期后 30 天 / 90 天 / 立即删除？
- 源文件（客户文档）和产物存在哪、哪些 vendor 会看到明文（PPT 管线的 LLM、视频厂商、TTS）？
- 员工离职后，其 job 产物归机构还是随账号走？
- 日志里是否有提示词、文件名、可识别个人信息？
- 是否可签数据处理条款、能否选国内节点？

这些会反过来约束存储设计：网关旁必须有带机构前缀的对象存储，删除是按 `org_id` 的生命周期策略，不是「文件放 PPTCreator 个人桶里再说」。

#### A.8 公对公是一等公民，就要按一等公民运营

「运营收款后手工开通」写对了。没写的是谁、凭什么、多快、做错了怎么回滚。

最小运营闭环：

1. 销售创建 `License(status=pending)`，带合同号、套餐快照、应付金额
2. 财务看到账（银行回单号可填）
3. 两人中至少一人确认后 `pending → active`（高额建议双人）
4. 开通失败/开错机构：`active → suspended`，并留审计，而不是删行
5. 到期前自动邮件/企微打给销售和客户 admin

没有第 3 步，会出现「款到了但没人点开通」这种最丢人的事故。运营后台是 P0，不是「有空再做的 admin」。

在线支付保持少数派即可。Chandler 支付是 C 端扫码心智，机构大额会被单笔限额和报销科目卡住。不要把在线支付做成首期主路径，也不要因为它「能自动开通」就怠慢手工路径。

#### A.9 首期范围：先把 PPT 的账做对

四项能力并行，等于并行四套：估计函数、失败退款、vendor 对账、产物存储、内容审核。其中 PPT 你已经有执行引擎和 MCP；视频/数字人你还没有自己的引擎，是纯转售。

建议分期：

| 期 | 交付 | 目的 |
|---|---|---|
| P0 | 运营开通 + Org/Member/License/Quota + authorize/settle + PPT partner + 桌面 DSH | 验证买断配额能对上账 |
| P1 | 机构 admin（成员、用量、CSV）+ MemberCap + 到期预警 | 让买家看懂自己买了什么 |
| P2 | 图片（成本低、同步或短任务，当第二个能力练网关） | 验证「接入新能力先问钱在哪侧」 |
| P3 | 视频（分钟级、超支策略必须先拍板） | 这时才需要 TTL、并发公平、成本预警 |
| P4 | 数字人、跨能力工作流编排、云端 DSH | 真正的产品差异化 |

P0 不做视频不是保守，是避免在单位经济没验证时把 GPU 账单写进买断合同。

### B. 技术

#### B.1 「一个服务、两个模块」同意；「网关无业务规则」不同意

先合后拆是对的。第三方接入方出现前，拆微服务只会让 authorize 变成一次跨服务写。

但要在代码里把边界浇死，否则合在一起等于没模块：

```
cmd/gateway/          HTTP/MCP 入口、鉴权、路由
internal/billing/     Org/Member/License/Quota/UsageRecord；Authorize/Settle 唯一实现
internal/execution/   job 状态机、vendor adapter、产物 URL
internal/identity/    Chandler JWKS、sub→member 解析、X-Org-Id 校验
```

`billing` 不 import vendor SDK；`execution` 不直接 UPDATE 配额表，只调 `billing.Authorize/Settle`。这是为了第三年能把 billing 单独给第三方，而不是为了现在好看。

Chandler / WorkMembership 是身份与收单，**不要**把本产品的 Org/License 建进 WorkMembership。那是别的界限上下文，塞进去会把「这人是谁」和「这机构买了你们家什么」焊死，Chandler 多一个产品就要改一次核心表。

技术栈选 Go：与 WorkMembership 同语言、JWKS spike 可抄、sqlc 习惯可复用。不要用 Next.js 做闸门——PPTCreator 已经证明 MCP + 计费 + worker 挤在同一应用里，partner 旁路会非常痛。

#### B.2 authorize/settle：骨架对，生产语义不齐

条件更新预扣、`job_id` 幂等、`reserved → settled|refunded` 单向迁移，都对。按现在的写法上线，会在这些地方破账：

**Reservation 泄漏。** submit 成功、worker 进程被杀、query 再也不来，预扣永远占着。必须有 TTL + 扫尾。TTL 建议大于最长能力 SLA（数字人可能数小时）再加余量，到期 `expired` 并退回。扫尾任务与 settle 回调抢同一行时，靠 `job_id` 唯一和条件更新，谁先谁算。

**actual ≫ estimated。** 视频「申请 10 秒、厂商按 10 秒计但重试打了 3 次」或数字人超时重跑，实扣可以是估计的数倍。原文「多退少补」在 `used + (actual-estimated) > total` 时没有定义。必须三选一，写进 settle：

1. 允许有限透支（如 10%），超出部分记 `overage` 供运营补收
2. 实扣截断到剩余配额，job 仍标成功（客户占便宜，你垫钱）
3. settle 失败、job 标 `settlement_failed`，产物扣留直到人工处理

视频场景建议 1；PPT 场景估计较准，2 也可。不能不选。

**幂等键冲突。** 同一 `job_id` 先失败退款、再重试成功，按「唯一索引」会打到已 `refunded` 的行。重试必须新 `job_id`，或允许 `refunded` 行上开子记录。建议：**一次尝试一个 job_id**，重试是新 job，新预扣。

**宽限期。** 「只在 authorize 查有效期、已 reserved 的跑完」对。补一条：暂停（`org_suspended`）同样不杀 in-flight，但运营后台要能看到「暂停后仍在跑的 job」。否则法务以为一暂停就停了。

**估计值来源。** PPT 的 `slideCount*5` 最少 50 是 C 端积分（见 `lib/mcp/server.ts` 与 `docs/mcp-server-design.md` §3）。B2B 配额若按「份」计，authorize 的 `estimatedAmount` 就是 1，settle 的 `actualAmount` 还是 1，页数只进成本侧。不要把积分公式带进机构合同。

#### B.3 身份链路：验签、听众、组织头、缓存

原文画了 `OIDC → Bearer → 验签 → sub 换 member`，缺的是生产里会出事的部分。

Chandler access token 是 JWT，网关必须：

- 从 `/.well-known/jwks.json` 取钥，缓存 5 分钟，拉失败保留旧缓存（WorkMembership 文档原话）
- 校验 `iss == workmembership`（这是字符串不是 URL，不要当 URL 解析）
- 校验 `aud == <本网关的 client_id>`。Chandler 专门为 MCP 加过 `aud`，不校等于接受任意合作伙伴的 token
- 校验 `exp`；DSH 侧用 `dsh-credentials` 的 `modifyRecord` 做 refresh 轮换（该 API 就是为防双进程同时刷新设计的）

`X-Org-Id`：

- 未带且 sub 只属一个 active org：可以默认，但要在响应里回显实际 org，避免静默
- 未带且多机构：`org_unspecified`，让客户端选。原文「系统不猜」对
- 带了：必须是该 sub 的 active membership，否则 `org_mismatch`。这是租户隔离，不是礼貌校验

成员解析短缓存：disable 必须主动失效（admin 停用接口删缓存键 `member:{sub}:{org}`）。只靠 60s TTL，被辞退的人仍能生成一分钟——视频 job 一提交就是真金白银。

DSH 桌面 OIDC：loopback + PKCE 抄 PPTCreator `lib/oauth/redirect.ts` 是对的。token 不要进 `.env`，走 `dsh-credentials` grant 记录；文件权限与钥匙串是实现细节，但设计要写「refresh token 落何处、吊销如何传播」。

一人多机构与 Member 模型：原文 Member 写 `chandler_sub` 全局唯一，必须改成 `(org_id, chandler_sub)` 联合唯一，否则 §5 无法实现。

#### B.4 PPTCreator partner：漏改点在 worker，不在 MCP 预检

原文改造清单方向对，粒度不够。按当前代码，partner 流量要改的是一整条链：

| 点 | 文件 | 不改的后果 |
|---|---|---|
| MCP 预检 | `lib/mcp/server.ts` `checkUserCredits` | 入口 402，B2B 根本跑不起来（这是原文已写的） |
| 日限额/QPS | `mcp:{userId}` 30/min、20 次/日 | 若 partner 共用一个系统 userId，全机构共享 20 次/日；若共用真实 userId，C 端限额打到 B2B 头上 |
| worker 实扣 | `worker/jobs/html-export.ts` `deductCreditsGuarded` | 网关配额和 C 端积分**双扣**，单闸门破产 |
| 欠费锁下载 | 同文件 `downloadLocked` | 积分够不够与 B2B 无关，客户生成成功下不了 |
| dashboard 列表 | `app/dashboard/*` | 机构 PPT 出现在员工个人项目里 |
| 下载鉴权 | `getPresignedDownloadUrl` | 拿到 URL 的人是否仍是该机构成员，TTL 300s 是否够 DSH 轮询 |

建议的切入方式，比「加 env 开关」更硬：

- partner 认证后，请求上下文带 `billingMode=partner` 与 `jobId`
- worker 只认这个上下文跳过积分与锁；不要用「userId 在某张白名单」这种易漏的侧面
- 用量回报：worker 已有 `tokenUsage` 进 `consumeCredits` metadata 的结构（`lib/credits.ts`）。partner 不走 consume，但要把同一份 token 用量从状态查询或 webhook 吐给网关。**没有这条，PPT 毛利是盲的**——原文写对了，执行时不要只回报页数
- 隔离：`Project` 加 `source=partner` + `orgId`，C 端 list 默认 `source IS NULL`。不要指望「他们不会打开网页」

限流移交网关之后，PPTCreator 对 partner 仍应保留**保护自身**的全局限流（抗网关 bug 把生成队列打满），只是维度改成 `partner:{orgId}` 而不是按人。这不是双闸门，是护栏。

验收必须有一个自动化测试：打一条 partner 生成，断言积分不变、downloadLocked=false、UsageRecord 在网关 settled、C 端 dashboard 不可见。没有这个测试，就当 partner 模式不存在。

#### B.5 `resolveConsumption` 不要做成分布式事务

若坚持 C 端网页要查询「这次扣谁的池」，PPTCreator 会在每次生成前同步调用用户管理系统。用户管理系统一慢，C 端 PPT 变慢；一挂，原文要求扣个人——已否决。

即便 C 端要查：

- 超时要短（≤300ms），失败当 `billing_unavailable`，不降级
- 可缓存「此 sub 是否属于任何 org」的布尔值（正负缓存都要，负缓存 TTL 更短），避免每个请求都打过去
- **不要**让 PPTCreator 自己 settle 机构配额。机构账只在网关/billing 写。C 端若走机构，应改打网关（或 PPTCreator 变相成为网关客户端），而不是在 Next.js 里再实现一套 authorize

更干净的切法：PPTCreator 网页对已绑定机构的用户，生成按钮直接走和 DSH 同一条网关。C 端积分路径只服务「从未绑定机构」的用户。这样 `resolveConsumption` 退化成「有没有 active membership」，而不是运行时路由。双身份的复杂度会掉一大截。

#### B.6 长任务：权威在网关，DSH jobs 只做通知

MCP 60s 超时（`dsh-mcp-client` 默认 `toolCallTimeoutMs=60000`）决定了不能同步等视频。submit/query 对。

但 DSH `packages/jobs/jobs/README.zh.md` 写得很清楚：注册表是进程内的，owner 是 Agent，进程没了 job 就没了。所以：

```
DSH submit_ppt ──► 网关：写 Job(queued)、authorize、调 PPTCreator
DSH 本地 jobs.start 只是轮询 query_ppt，完成时 onJobDone 通知会话
桌面退出后再打开：向网关 list_jobs 恢复，不向本地注册表恢复
```

网关 Job 状态机建议：

```
queued → running → succeeded
                 → failed
                 → canceled   (用户/admin，settle refunded)
queued/running → expired    (超时，refunded)
```

缺 `canceled` 就会出现「点了停止仍扣配额」。缺 `expired` 就会出现「vendor 挂了，预扣不退」。

query 响应应带：状态、进度、错误码、用量（成功时）、签名下载 URL。不要让模型「再调一个 get_download_url」才能拿结果——模型会忘。

agent 轮询不可靠（打太勤或忘了）。工具描述里写「提交后不要忙等，用 query；本地 runtime 会通知」，真正的跟踪靠 DSH jobs 插件而不是靠模型自觉。

并发公平：按 org 限制 in-flight（尤其是视频）。否则一个机构能把 vendor 队列塞满，别的机构的 PPT 也排队。这是网关的事，不是 PPTCreator 的事。

#### B.7 MCP 工具面：生成工具不够，agent 还要能看见账

「能力零代码、全走网关 MCP」对。模型若看不见套餐和余量，只会用失败来探索，既烧配额（authorize 预扣再退也有竞态）又糟蹋对话。

P0 工具建议：

- `get_entitlements` — 本 org 能用的能力、有效期
- `get_quota` — 每能力 used/total/remaining、个人 cap（若有）
- `submit_*` / `query_*` / `cancel_*`
- `list_jobs` — 当前用户最近任务

deny 的结构化错误原文写得好，补字段：`remaining`、`reset_at`（若按年重置）、`admin_hint`（给人看的一句话）。`quota_exhausted` 和 `member_cap_exhausted` 务必拆开。

工具命名不要全部塞进 `mcp__media__*`。PPT 不是 media。按能力前缀（`ppt` / `image` / `video` / `avatar`）便于授权与计量打点。

#### B.8 安全

- vendor key、PPTCreator partner key、Chandler client_secret：进程环境或 KMS，不出仓库、不进日志。partner key 可轮换，双 key 窗口。
- 产物 URL：网关签发、短 TTL、绑定 org；转发 PPTCreator 预签名 URL 时要考虑 DSH 轮询超过 300s 的情况（PPTCreator 默认 TTL 就是 300s）。
- 提示词注入：MCP 参数来自模型。模型被用户文档劫持后，可能改 `X-Org-Id` 或把产物发到外部 URL。`X-Org-Id` 以客户端配置 / 登录态为准，**不要接受模型填的组织头**。回调 URL 白名单。
- 审计：authorize 拒绝、admin 改 cap、License 状态变更、partner 调用，全部落只增日志。B2B 出了问题，这是唯一能自证的东西。

#### B.9 可观测性与对账，否则买断制是盲开飞机

原文有 `vendor_cost` 字段，没有人看它的设计。最低限度：

- 指标：authorize 通过/拒绝（按 reason）、reservation 超时数、settle 延迟、job 时长分位、按能力的 `vendor_cost` 合计、按 License 的成本/实收比
- 日志：`job_id` 贯穿网关、PPTCreator、vendor
- 日对账：`QuotaPool.used` == `sum(UsageRecord.amount where settled)`；`sum(vendor_cost)` vs vendor 账单（允许延迟，不允许长期漂移）
- 告警：某 License 成本比超阈、某 org 拒绝率突增、reserved 堆积、Chandler JWKS 拉取失败

对账跑不通，就不要接第二个能力。第二个能力会让「对不上」变成「不知道是哪边对不上」。

#### B.10 测试：状态机和双账是必须先红的

与本仓库 TDD 规则一致，下列测试应在实现前存在：

- authorize 并发：两个请求抢最后一个配额，只有一个 `allow`
- settle 重复：同一 job_id 两次 success，`used` 只变一次
- 失败退款：reserved → refunded，两层配额都回滚
- reservation TTL：过期自动退，随后迟到的 settle 无害拒绝
- actual > 剩余：按已拍板的超支策略断言
- PPTCreator partner：积分不变、不锁下载、C 端不可见
- `X-Org-Id` 不属于该 sub：deny `org_mismatch`，无 job
- 成员 disable 后缓存失效：下一请求即 deny

没有并发预扣测试，条件更新等于没写。

### C. 原文决策里建议改口的

| 原文 | 建议 |
|---|---|
| 网关不问业务规则 | 网关执行 billing 裁决，自身不发明规则 |
| `chandler_sub` 全局唯一 | `(org_id, chandler_sub)` 联合唯一 |
| 系统不可用降级到个人积分 | B2B fail-closed |
| DSH jobs 作为长任务方案 | 网关为权威；DSH jobs 仅通知 |
| 首期能力含视频/数字人 | P0 只做 PPT |
| 旁路 `checkUserCredits` 即可 | 必须旁路 worker `deductCreditsGuarded` + `downloadLocked` + dashboard 隔离 |
| 一个 admin 后台 | 运营后台与机构后台分开，运营 P0 |

### D. 建议的 P0 完工定义

同时满足才叫「能签第一份合同」：

1. 运营能把一笔公对公收款变成一份 active License（有合同号、有快照、有审计）
2. 机构 admin 能邀请一名成员，该成员用桌面 DSH 登录后只看到已购能力
3. 生成一份 PPT：机构池减一，C 端积分不动，下载成功，dashboard 个人侧不可见
4. 配额为 0 时 deny `quota_exhausted`，agent 话术正确
5. 人为杀死 worker 后，TTL 内预扣退回
6. 日对账脚本：池子、台账、PPTCreator partner 调用次数对得上

达不到第 3 和第 6 条，不要接视频。

### E. 评审结论

架构切分和闸门模型可以作为开工骨架。不要把原文当成已关闭的产品设计：单位经济、合同语义、双身份降级、PPTCreator worker 旁路、job 权威归属，这五处不补，系统能跑通演示、跑不通第一份对公合同。

优先拍板顺序：① 配额年重置与续费新开 License；② B2B 永不回落个人积分；③ P0 只做 PPT + 运营后台 + 桌面 DSH；④ settle 超支与 reservation TTL；⑤ partner 改造含 worker 与隔离验收。这五条拍完，其余实现细节不会把生意带偏。

---

## 12. 修订记录（2026-08-24 第二轮）

本轮根据评审与后续讨论修订 §1–§10 及「附」，§11 评审原文保留。对照：

**采纳评审：**

- §2：网关职责改口为「执行裁决，不发明业务规则」，补 billing/execution 同进程分模块的依赖方向（B.1）
- §3：Member 改 `(org_id, chandler_sub)` 联合唯一，补邀请/停用字段与 `viewer` 角色（评审注、A.4、B.3）
- §3：License 快照不可变、变更是新事件；补成本预警（A.2、A.3）
- §4：补 reservation TTL、超支策略三选一（转 §10 待拍板）、一次尝试一个 job_id、日对账（B.2）
- §4：B2B 计量不沿用 C 端积分公式（评审注）
- §5：补 `aud` 校验、`X-Org-Id` 成员资格校验、disable 主动失效缓存（B.3）；错误表补 `member_cap_exhausted`、`org_mismatch`、`org_unspecified` 等（评审注）
- §7：job 权威状态在网关、DSH jobs 仅通知层；补 `canceled`/`expired` 状态、`get_entitlements`/`get_quota` 工具、按 org 并发公平（B.6、B.7）
- §8：partner 改造从 MCP 预检扩到 worker 主链（`deductCreditsGuarded`/`downloadLocked`）、dashboard 隔离、下载鉴权，补验收测试（B.4）
- §9：首期只做桌面 DSH + 云端网关；定位「网关是产品，DSH 是官方客户端」（A.6）
- 「附」：P0 只做 PPT（A.9）

**评审意见被后续决议取代：**

- A.5 / B.5（双身份回落之争）：由 §6「渠道即账本」消解——codelphi 无个人积分、PPTCreator 站内无机构概念，两边账本物理隔离，比「fail-closed + C 端有限回落」更彻底；`resolveConsumption`、上下文选择器、同意式回落全部作废
- B.5「PPTCreator 网页机构用户走网关」：随之作废，PPTCreator C 端零改动

**新增决议：**

- §1：首期买家定为高校（数字教材场景），未来市场可扩展——组织/配额/Project 模型一律行业通用
- §3：新增 OrgUnit 自引用树（label preset 化、`allocation_mode` over/strict）与 Project 实体；配额链式挂任意节点，MemberCap 并入节点帽
- §4：authorize/settle 改链式逐层扣减，用量报表读节点 `used` 即子树合计
- §6：机构成员用机构池干私活不防不问，属机构内部治理（MemberCap + 用量报表）
- §10：开放问题重排，补超支策略、allocation_mode 默认值、高校数据出域与 vendor 路由

---

## 13. 第二轮评审（2026-08-24，针对修订后的 §1–§10）

对照物：修订后的开工依据（§1–§10、「附」、§12），以及 §11 第一轮意见是否被真正消化（不是只改了措辞）。

**总评：** 第一轮里会让系统「能演示、对不了账、签不了合同」的五处，修订后关了四处半。网关职责、联合唯一、partner worker 旁路、job 权威归属、P0 只做 PPT，都已经写进正文，可以当实现约束。「渠道即账本」（§6）比第一轮建议的「fail-closed + C 端有限回落」更干净，应保持，不要再加路由。

本轮的重心变了。新风险不再是双钱包，而是：**OrgUnit 链式配额的账本语义还没写完**，以及 **「高校数字教材」这个买家定位还没有落到「一份是什么、老师一周内做什么」**。这两处不补，P0 schema 会按猜的去建，试点校一进学院分摊就会打回。

### A. 第一轮消化情况

| 第一轮主张 | 修订后状态 | 本轮态度 |
|---|---|---|
| 网关执行裁决、billing/execution 分模块 | 已写入 §2 | 关闭 |
| `(org_id, chandler_sub)` 联合唯一、邀请/停用字段 | 已写入 §3 | 关闭 |
| License 快照不可变、成本预警 | 已写入 §3 | 关闭 |
| reservation TTL、一次尝试一个 job_id、日对账 | 已写入 §4 | 关闭 |
| JWT `aud`、X-Org-Id 校验、disable 主动失效 | 已写入 §5 | 关闭 |
| job 权威在网关、DSH jobs 仅通知 | 已写入 §7 | 关闭 |
| partner 旁路 worker 实扣 + dashboard 隔离 + 验收测试 | 已写入 §8 | 关闭 |
| 桌面 DSH + 云端网关，网关是产品 | 已写入 §9 | 关闭 |
| P0 只做 PPT | 已写入「附」 | 关闭 |
| B2B 不回落个人积分 | **被 §6 取代**：两边账本物理隔离 | 关闭，且同意取代 |
| 超支策略、年重置、续费形态 | 仍在 §10，有建议未勾选 | 见下面 C：P0 能关掉的应关掉 |

§12 写「用量报表读节点 `used` 即子树合计」，§4 正文没有这句话。这不是措辞问题：链式预扣的记账方式一旦理解错，报表会重复计算。必须在 §4 写死语义，见 B.1。

### B. 本轮新风险（OrgUnit / Project / 高校买家带来的）

#### B.1 链式配额：`used` 的含义必须写死

authorize 写的是「祖先链每一层都 `used + estimated <= total`，一层一层条件更新」。这意味着一次成功消费会在 **路径上每一个 QuotaPool 行** 都加 `used`：Member、指定 OrgUnit、所有祖先、Org 根。

由此可推出，不能再靠 `SUM(子节点.used)` 当报表：

- 学院.used 已经是「走过这条链的消费合计」，再对教研室.used 求和会重复计算（子节点 used 是子集，不是分区——成员还可以直接挂在学院上）。
- Org.used 才是全机构合计。学院.used 是「unit_id 落在该学院子树内的消费」。
- **正确报表：读该节点自己的 `used`，不要对子节点再 SUM。** §12 那句「读节点 used 即子树合计」只有在「每笔消费都从叶子走到根、且 used 记在路径每一层」时成立。把这句话搬进 §4，并加反例：禁止 `SUM(children.used)`。

日对账也要改口径。原文 `QuotaPool.used == sum(UsageRecord.amount where settled)` 在链式模型下 **只对根池成立**。学院那一行的 used 等于 `sum(UsageRecord.amount where unit_id IN 该子树 AND settled)`，不是全表合计。对账脚本必须按 `node_type` 分支，否则第一天就会报「对不上」。

锁顺序：所有消费事务沿 **叶子 → 根** 加锁（Member 帽 → 指定 unit → parent → … → Org）。两条不同教研室的并发请求在父节点汇合，这个方向无环。危险的是 **改帽事务与消费事务反向加锁**（运营从根往下改 `total`）。规定：改帽也只锁将要 UPDATE 的那一行，或同样叶子→根；禁止根→叶遍历加锁。此项要有并发测试，见 E。

`allocation_mode` 只在 **设帽时** 生效，不在 authorize 时生效。高校成交落在院系、做成了合同会很大（§1）：**额度耗尽不是要设计的产品路径。** 分层错误码（学院帽 → 找教务处调拨，根池 → 找销售升档）是按「全校一盘棋抢额度」想出来的，与 GTM 不符，**撤回 `unit_cap_exhausted`。** 链上哪一层不够，都回同一个 `quota_exhausted`，话术联系本机构管理员。`member_cap_exhausted` 只服务「给吵闹的人设了个人帽」这一种内部治理，不做升档漏斗。

个人帽的范围仍要写死（这与耗尽导流无关）：**Member 帽是该 Org、该能力、该周期的上限，不是「在本教研室的上限」。** 一人两室共用一个 Member 帽。P0 可以根本不设个人帽。

#### B.2 一人多 OrgUnit：`X-Unit-Id` 是账本外键，不是 UI 糖

Member ↔ OrgUnit 多对多之后，`unit_id` 决定报表记在哪个教研室。选错室，摊销会记错，reserved 之后很难改（只增台账）。这是记账问题，不是「额度算在哪个学院、找谁调拨」——额度在 Org（这份合同）上，通常够用。

补规则：

1. 成员只属一个 unit：可默认，响应回显 `unit_id`（与 org 默认规则对称）。
2. 多属未带 `X-Unit-Id`：`unit_unspecified`，已有。
3. 带了但不属于该成员、或 unit 不属于该 org：`unit_mismatch`，记安全日志（与 `org_mismatch` 同级，防跨学院甩锅）。
4. **P0 每人只挂一个 unit。** M:N schema 可留，邀请/导入默认单归属。双聘再打开。
5. 成员调岗：历史 UsageRecord.unit_id **不改**。used 是「作业发生时记在哪」。

#### B.3 多 License 并存时扣哪一池

续费建议新开 License，增购也是新事件——于是同一 org、同一 capability 会同时存在两行 QuotaPool（未过期的旧约 + 新年/增购）。authorize 入参没有 `licenseId`。不规定消费顺序，根池检查会有歧义。

建议写进 §4 作为已定（不要再进开放问题）：

> 同一能力有多个 active License 时，消费 **先到期者优先**（valid_to 升序）。一池不够，**不跨 License 拼凑同一 job**（估计值必须落在单一 License 的根池里）。增购是新池，用完旧的才动新的。

跨池拼凑会让 settle 超支、成本预警、合同毛利全部拆不干净。

新年 QuotaPool 行出现时，学院帽怎么办：默认 **不自动复制去年的 unit 帽**。新周期根池在 Org，unit 帽由教务处/运营按新年额度重配。可做「复制去年比例」作为运营按钮，不要静默复制——去年 120% 超发的 `over` 帽抄到新年会直接把新年根池锁死。

#### B.4 高校场景下，不要按「一所大学 20 个学院」做 RBAC

第一轮按全校树想，会得出「学院教务员必须能管本树」。按 §1 的成交粒度，**每个学院客户就是一个 Org**，学院管理员就是这个 Org 的 admin，P0 的 `owner/admin/member/viewer` 够用。下一所学院是下一份合同、下一个 Org，不是同一棵树上的兄弟节点。

unit-scoped RBAC、学院自助调拨帽，都是全校统签才需要的东西。全校统签既难做、做成了额度也不紧，P0/P1 都不必为它预埋角色系统。`MemberUnit` 关系表有（人挂在哪个教研室，为了报表），上面不要过早加 `role` 列。

#### B.5 Project 现在是表，还不是老师的工作台

数字教材的组织单位是「一本教材」，不是「一次 chat」。§3 有 Project，§9 DSH 清单没有「打开 Project」。结果是：老师用 DSH 随手生成若干 PPT，project_id 为空或每次新建，按项目摊销的 UsageRecord 永远是空的。

P0 最小闭环应是：

1. 老师（或 admin）创建 Project（type_label 用 preset「教材」）
2. DSH 会话绑定 `project_id`（选教材 / 从教材打开）
3. 该会话内所有 submit 带这个 project_id、unit_id
4. 产物（PPT 下载）挂在 Project 下可回看

没有第 2 步，Project 是死表。这比 OrgUnit 分配 UI 更靠近「一周内完成的工作」。

还要定义与 PPTCreator Project 的关系，避免两套「项目」混谈：

> 一本教材（codelphi Project）对应多次 partner 生成；每一次生成在 PPTCreator 里是一条 `source=partner` 的记录。老师只在 DSH / 机构后台看到教材；PPTCreator dashboard 永远不出现这些记录（§8 已要求）。

P0 不需要教材内的章节树，但需要「这一份 PPT 属于哪本教材」。

#### B.6 「份」是定价单位，不是技术单位——现在是最大的业务空洞

高校买的是数字教材产能，不是「MCP 调用次数」。§4 说 PPT 按份计量，没说：

- 一次失败的生成算不算份？（settle refunded 意味着不算，应写进对客合同）
- 同一章改提示词重跑 8 次算 8 份吗？
- PPTCreator 的单页重生（`/slides/[n]/regenerate`）算不算？partner 路径暴露吗？

教师做教材的真实行为是 **同一章迭代十几次**。若每次成功 submit 都算 1 份，试点两周就会：额度烧光、老师改用个人 PPTCreator、学校觉得买亏了。若迭代免费，成本在你侧无上限。

P0 建议（写进合同默认条款，允许特批）：

1. **1 份 = 1 次 settle=success 的整份 PPT 生成**（失败 / 取消 / 过期不扣）。
2. **P0 网关不暴露单页重生工具。** PPTCreator 网页上的重生与 B2B 无关；partner worker 对 partner 流量拒绝或忽略单页重生 API。避免 agent 把一页抠 20 次。
3. 整份重跑按新 job 计新的 1 份。产品上在 query 成功后提示余量。
4. 销售按「教师数 × 每学期教材章数 × 迭代系数（建议 3）」估套餐，不要按「学校有多少门课」按 1:1 卖。迭代系数写进内部报价表，不必写进用户文档，但运营要有。

这比超支策略更急：P0 只有 PPT，`estimatedAmount=actualAmount=1`，§10 的超支三选一对 P0 **无影响**，见 C。

#### B.7 数字教材 P0 必须对销售说清楚「不是完整教材产品」

§1 定位高校教师做数字教材，P0 只做 PPT。这两句同时为真时，对外必须叫 **「数字教材的课件层」**，不能叫「数字教材平台」。否则验收按「能否出带讲解视频的整本教材」来，P0 必失败。

建议补进 §1 或 §10 已定口径：

> 首期交付：教师用桌面 DSH，在一本教材 Project 下，上传/粘贴一章材料，生成并下载 PPT，用量记在学院链上。不交付：插图流水线、讲解视频、数字人、章节编排工作流、学习平台播放器。

P2 图片对该买家是对的（教材插图）。P3 视频不要假设一定是下一期——高校数字教材的下一步更可能是「按页配音」而不是「营销短视频」。job 接口预留「属于 Project 的一批页」可以，但不要按媒体单位的视频包去卖给学校。

#### B.8 高校交付还有三件「看起来像运营、其实是成交条件」的事

1. **批量导入成员。** 邀请码适合 10 人试点，不适合 200 名教师。P0 运营后台要有 CSV 导入（工号/姓名/邮箱/unit 名 → 发邀请或待绑定）。工作量很小，不写进 P0 就会在进校第一周用人肉表格。
2. **发票信息在 Org 上。** `联系人信息` 不够。高校付款主体常与学院名称不同（学校 / 基金会 / 课题经费）。Org 需要：发票抬头、税号、银行信息、付款单位备注。没有这些，公对公「一等公民」在财务那里不是公民。
3. **校园统一身份。** 教师再注册一个 Chandler 账号，试点能忍，招标常不能忍。P0 接受「邀请 + Chandler 注册」；P1 再评估校园 IdP。不要把联邦登录塞进 P0，但销售材料不要承诺「对接学校统一认证」。

数据出域（§10 最后一条）对该买家不是开放研究项。PPT 管线会把教材正文送给 LLM。试点校口头能过，招标要书面：默认国内模型、不用于训练、可按 org 配 vendor 白名单。P0 至少做到 **vendor 在配置里是显式的、能换，不是写死在 PPTCreator 环境变量里让学校看不见**。完整按机构路由可 P1。

#### B.9 「渠道即账本」保持，但要承认一条产品缝

§6 决议正确：codelphi 不管个人积分，PPTCreator 不管机构。缝是：同一教师可以用个人 PPTCreator 做校本教材，学校无法审计。P0 不防（对）。销售不要承诺「校本教材只能在本平台生成」。若第一所学校把它当验收项，那是合同范围变更，不是漏做的功能。

机构池被拿去干私活：MemberCap + 报表，对。P0 报表至少能按成员排出「用量 Top」，否则教务处无法治理。这比 MemberCap 编辑 UI 更先（先看见再设帽）。

### C. 开放问题应收缩：P0 只留真开放项

§10 现在 9 条，其中若干已经有明确建议，且卡住 schema / 合同。建议改成「已定默认 / 仍开放」两栏，避免实现的人把建议当未决议。

**建议本轮标为已定默认（商务可特批，工程按默认建）：**

| 项 | 默认 | 理由 |
|---|---|---|
| 配额周期 | 按授权年分条；高校试点对齐学年（9 月）；年未不结转 | 模型已有 period_*，再漂着会写出无周期代码 |
| 续费 | 新 License，旧的 expire；增购新事件 | 与快照不可变一致 |
| 多 License 消费 | 先到期者优先，单 job 不跨池 | 见 B.3 |
| allocation_mode | 默认 `over` | 高校常态，§10 建议可升级为已定 |
| 超支策略（P0） | **P0 不适用。** PPT 份数 1:1，无 actual≫estimated。该条挪到 P3 视频开门条件 | 现在不定不挡 PPT |
| 首期范围 | P0 = 试点校 + PPT + 运营后台 + 桌面 DSH + Project 绑定 + CSV 导入 | 见 B.5、B.7、B.8 |
| 技术栈 | Go + Postgres + sqlc，独立仓库 | 没有对立方案 |
| OrgUnit UI | P0 只要分组/挂人/报表；不做「学校池划拨给学院」 | 额度在合同上，不稀缺 |
| 生成物归属 P0 | 合同期内机构可下载；到期后保留 90 天只读下载，之后按 org 前缀删除；离职成员失去下载权，产物留在 Project/机构 | 投标可先用这一条，不必继续空着 |
| 单页重生 | P0 不暴露 | 见 B.6 |

**仍应保持开放（影响合同或合规，销售开口前要书面）：**

1. 迭代系数与套餐份数怎么卖（内部报价，但第一所学校的合同数字要从这里出）
2. 教材正文送哪些 LLM、是否允许境外、是否书面「不训练」（P0 最低：显式国内、可换）
3. 第一所试点校的学院数、是否双聘（决定 P0 是否冻结 M:N）

### D. 修订后仍偏薄、但本轮不必展开的

- 编排仍是长期商品（§11 A.1）。P0 做课件层是对的；P4 再做「为本章所有页批量生成讲解」时，Project 才变成工作流，而不是文件夹。不要在 P0 预埋工作流引擎。
- 可观测性 §11 B.9 仍未写入 §1–§10。P0 最低：authorize 拒绝计数、reserved 堆积、License 成本比。可在实现计划里写，不挡模型。
- 审计表未进数据模型。License 状态变更、改帽、停用成员必须只增落库。补一行 `AuditLog` 即可，不要另开项目。
- DSH 分发（签名、自动更新、学校软件白名单）是桌面客户端的真实成本，首期用内部分发 + 手工安装可以过试点。

### E. 测试清单增量（相对 §11 B.10）

原有并发预扣、settle 幂等、partner 双账测试仍然是门禁。链式模型追加：

- 同一父池下两个 unit 并发，父池只够一笔：一 allow 一 deny（高校主路径几乎撞不到；测试仍要有，错误码都是 `quota_exhausted`）
- 改帽与消费并发：无死锁（超时失败也算失败）
- 多 License：旧池未尽时新池 used 不变
- `X-Unit-Id` 不属于该成员：`unit_mismatch`，无预扣
- 调岗后历史 UsageRecord.unit_id 不变，旧 unit.used 不回滚
- 根池对账用全表 settled；unit 池对账用子树 UsageRecord，**禁止**用 SUM(children.used) 对 unit 池
- Project 未绑定的 submit：P0 是 deny 还是记空 project_id——**建议 deny `project_unspecified`**，否则摊销报表必空（与 org 默认规则不同：教材场景下「没选教材」不应静默成功）

最后这一条是产品选择：若 P0 想降低摩擦允许无 Project 生成，报表就要接受「未归类」桶。高校试点更建议强制绑定，培养「先建教材再生成」的习惯。

### F. 本轮结论

修订后的文档已经是一份可以写 P0 代码的授权/闸门设计。「渠道即账本」和 partner 改造清单达到开工强度。

还不能直接按现在的 §3–§4 建表开工的原因只有两个：

1. **链式 `used`、多 License、失败层错误码、对账口径** 仍可能被实现成三种不同账本。把 B.1–B.3 写进 §4 正文（不是开放问题）。
2. **「份」与教材 Project 工作台** 仍可能让第一所学校买到的东西和老师做的事情对不上。把 B.5–B.7 写进 §1/§9 和合同默认条款。

拍完这两块，超支策略、云端 DSH、数字人都可以继续留在后面。第一所试点校的工程风险在账本和「一份 PPT 属于哪本教材」，不在能力矩阵。

### G. 讨论回改（成交粒度与耗尽导流）

评审 B.1 曾要求 `unit_cap_exhausted`（找教务处）与根池 `quota_exhausted`（找销售）分开。讨论结论：**想复杂了。**

购买名义可以是学校，生意落在院系甚至教研室；全校统签很难，做成了合同会很大，额度不够不会成为日常。分层耗尽话术是按大学 ERP 抢额度设计的，不是按这个 GTM 设计的。

已改入口：

- §1：Org = 成交落地单位；耗尽不是主路径
- §3：另一学院再买 = 另一个 Org，不挂进全校配额树；OrgUnit 用于分组/报表，帽可选
- §4 / §5：不设 `unit_cap_exhausted`；`quota_exhausted` 统一联系本机构管理员
- 本节 B.4：撤回「20 个学院必须 unit-scoped RBAC」——学院客户自己就是 Org

链式 `used` 口径、多 License 扣哪一池、报表禁止 SUM(children) 仍然要写进 §4：那是记账正确性，与「会不会用完」无关。

---

## 14. 修订记录（2026-08-24 第三轮）

本轮合并：§13 第二轮评审的 B/C/D/E、G 讨论回改，以及「按年卖不按份」「账号共享不验证」两条新决议。§13 原文保留。

**并入正文的评审项：**

- §1：首期交付口径「数字教材的课件层」+ 不交付清单（B.7）；不承诺校园统一身份（B.8）
- §3：Org 补发票抬头/税号/银行信息/付款单位（B.8）；Member P0 单归属默认（B.2）；新增 AuditLog（D）；运营后台含 CSV 导入（B.8）；Project 强制绑定 + `create_project`（B.5 + 本轮补充）
- §4：记账纪律写死——**计数器服务闸门，台账服务报表，两者不交叉**；计数器只留根池 + 显式帽行，替代 B.1 的链式全路径计数（见下）；多 License 先到期者优先、单 job 不跨池（B.3）；unit 帽不跨年静默复制（B.3）
- §5：错误表补 `unit_mismatch`、`project_unspecified`（B.2、E）
- §6：承认产品缝，销售不承诺「校本教材只能在本平台生成」（B.9）
- §8：partner 改造补第 8 条「拒绝单页重生 API」（B.6）
- §9：DSH 补 Project 工作流（B.5）
- §10：收缩为「已定默认 / 仍开放」两栏（C）

**对 B.1 的处理（结构消解替代规则约束）：** 评审正确地指出了链式 `used` 的重复计算与锁序风险，但接受「每笔消费更新路径每层」的前提。本轮按 G 回改后的现实（帽是可选治理、非稀缺分配器）改为：计数器仅存于根池与被显式设帽的节点，报表一律从 UsageRecord 聚合。SUM(children) 口径问题、对账分支、叶子→根锁序由结构消失，而非靠纪律维持。

**被「按年卖」决议取代的评审项：**

- B.6 的「份」定义与迭代系数报价：不按份卖，合同不出现份数；教师任意迭代。单页重生 P0 不暴露保留，理由改为**成本护栏**（防 agent 单页反复烧 LLM token），非计费口径
- 成本预警（License 成本/实收 60% 告警）从建议升级为按年卖模式下**唯一的风控**
- C 栏「迭代系数与套餐份数怎么卖」从开放问题移除，替换为「内部报价模型：教师规模 × 预期用量 × vendor 成本 + 目标毛利」（内部文档）

**新决议：**

- 账号共享不验证：技术上做不到可靠判定；合同禁转租条款 + 护栏值 + 用量异常告警（运营信号，非自动执法）三层兜底（§4）
- 配额 `total` 定性为内部护栏值：按目标教师规模 × 预期用量 × 3~5 倍余量估；`quota_exhausted` 是运营事件，不是销售漏斗（§3、§4）

**仍开放（销售开口前书面）：** 教材正文 vendor 合规口径；试点校组织细节（决定 M:N 是否冻结）；内部报价模型。见 §10。

---

## 15. 第四轮评审（2026-08-24）：多平台能力接入

对照物：修订后的 §1–§10；将接入的能力来自**不同平台**——至少 PPTCreator（PPT）、数字人平台、AI3D、OpenMAIC（清华开源多智能体课堂，文档→互动课/PPTX/HTML）。本轮不重开已关闭的账本/身份问题。

**总评：** 现在的正文是一张合格的 **B2B 授权与闸门** 设计，加一份 **PPTCreator 特例改造清单**。它还不是一张 **多平台能力平台** 设计。架构图里「视频 / 图片 / 数字人供应商」是占位符；OpenMAIC、AI3D 根本没出现。若按现在的 §8 去实现网关，PPTCreator 的 partner 细节会写进 execution 核心，接第二个平台就要分叉。

P0 商业上仍可以只开通 PPT（按年卖、试点校课件层）。**架构 P0 必须先有能力适配合同**——否则「集成多个平台」会变成四份复制粘贴的 §8。

### A. 先把三个词拆开

正文把 capability、平台、vendor 混在一处（License.items 的 `capability`、架构图的「供应商」、§4「钱的消耗发生在哪一侧」）。三套东西：

| 词 | 是什么 | 例子 |
|---|---|---|
| **Capability** | 合同与工具面上的能力，用户/agent 要的事 | `ppt` / `avatar` / `asset_3d` / `classroom` |
| **Platform** | 执行引擎，有自己的账号、任务、产物形态 | PPTCreator / 某数字人 SaaS / AI3D / OpenMAIC |
| **Vendor** | 真正收钱的下游（平台内部再调的 LLM/GPU/TTS） | DeepSeek、混元、星云 GPU… |

一对多是常态：OpenMAIC 一个平台能吐课堂、PPTX、TTS、配图；PPT 这种 capability 至少 PPTCreator 和 OpenMAIC 的导出都能做。License 快照里应是 **capability 列表**（合同能力范围），不是平台商品名。平台是网关路由，可以按 org 换（§10 已有 vendor 白名单的苗头，但写的是 LLM，不是执行引擎）。

建议正文补一张能力目录（名字可改，结构不要省）：

```
CapabilityCatalog     id, key(ppt|avatar|asset_3d|classroom), job_kind, 展示名
Platform              id, key, adapter, base_url, auth_kind(partner_key|mtls|oauth_cc)
CapabilityRoute       capability, platform, 默认优先级
LicenseSnapshot       capabilities[]     // 合同买了哪些能力
OrgPlatformPolicy     org_id, platform, allow/deny   // 某校只许国内引擎
```

没有这张表，`capability_not_entitled` 和「默认国内模型」都无法落到第二个平台。

### B. 业务：高校数字教材下，这四件事不是同类零件

按年卖之后，客户买的是「能用哪些能力」，不是份数。销售和 agent 仍要知道四件事分别干什么，以及 **谁和谁打架**。

**PPTCreator（PPT）**  
章材料 → 可下载课件。P0 课件层，路径清楚。产物是文件。

**OpenMAIC（互动课堂）**  
主题或 PDF → 多 agent 课堂（教师/同学、测验、白板），可导出 PPTX 或独立 HTML。对「数字教材」比「再做一份 PPT」更近：它是 **可进入的课**，不是 **可下载的文件**。和 PPTCreator 在「从文档出 PPT」上重叠。教师说「根据这章做课」，agent 会同时看到 `submit_ppt` 和 `submit_classroom`，没有路由规则就会乱调、双烧 LLM。

**数字人**  
形象 + 脚本 → 视频，或实时驱动。和 OpenMAIC 的 TTS/口播、以及「老师出镜讲 PPT」重叠。成本方差最大（GPU/时长），按年卖时内部护栏必须按 **秒/分钟** 单独设，不能和 PPT 共用一个 `amount` 量纲（模型已有 unit 字段，路由层要真用）。

**AI3D**  
文/图 → 3D 资产（网格/材质/绑定）。教材里用于实验器具、分子、场景，不是数字人形象（除非你们的 AI3D 就是形象生成——**产品名必须写进开放问题**，现在文档里这个词不存在，评审只能当「3D 资产生成」）。产物是 glb/fbx 一类，预览链路与 PPTX 完全不同。

产品后果：

1. **合同「能力范围」按 capability 勾选**，不要写「含 AI 生成」。学院可能只买 PPT+课堂，不买数字人（贵、合规重）。
2. **重叠要有默认路由。** 建议已定：`ppt` 默认 PPTCreator；`classroom` 默认 OpenMAIC；OpenMAIC 导出的 PPTX 不当作 `ppt` 能力另计一次护栏（同一 job 的副产物），避免一堂课扣两次。需要「只要文件、不要互动课」时才走 `ppt`。
3. **OpenMAIC 会逼问 P0 口径。** §1 写「不交付学习平台播放器」。OpenMAIC 的交付物恰恰是可播放的课堂 URL/HTML。若战略上一定要接 OpenMAIC，对外口径应改成「课件层 = PPT **或** 一节可打开的互动课（生成后的回放/导出）」，并把「学生长期在课堂里互动、成绩、班级」明确剔除——那是 OpenMAIC 自己的产品，不要假装网关能代运营。
4. **按年卖 + 多平台 GPU/LLM**：成本预警按 License 总值不够，要能按 **capability 拆开** 看（数字人把毛利吃光时，PPT 还在正常用）。`vendor_cost` 已有，缺的是按 capability 聚合的告警，不是新账本。

### C. 技术：网关后面是适配器，不是「再挂几个 MCP」

§9「能力零代码，全部是网关后面的 MCP server」会把人带歪。对 DSH **只暴露一个 MCP**（网关）。平台侧各不相同：

| 平台 | 对网关的真实接口（当前认知） | 不适合 |
|---|---|---|
| PPTCreator | 已有 Streamable HTTP MCP + 即将加的 partner 认证 | 终端用户 OAuth |
| OpenMAIC | Next.js HTTP（生成大纲/场景/TTS/课堂；偏站点，不是 MCP） | 把 DSH 直接指到 OpenMAIC |
| 数字人 | 各家 REST：提交成片 / 或实时 SDK 推流 | 一上来当同步 tool |
| AI3D | 各家 REST：提交任务 + 查 job + 下模型包 | 把 mesh 塞进 MCP JSON |

DSH 不持有任何平台 key（已否决，保持）。网关 adapter **调平台**，平台 **禁止** 再向 DSH 要用户 token。

#### C.1 Partner 适配合同（所有平台同一份，§8 只是第一份实例）

每个 adapter 必须实现同一组语义，禁止按平台发明第二套闸门：

```
Auth        服务账号（partner key / mTLS / client credentials）。轮换、分环境。
Identity    请求上下文只认网关传入的 org/member/job；平台自有用户体系只用于旁路其 C 端计费
Submit      入: gateway_job_id, capability, spec, 材料指针(对象存储 URL, 不传原文无限次)
            出: platform_job_id
Query       状态/进度/错误码/成本/产物指针
Cancel      尽最大努力；失败也要让网关能 expired 退预扣
Cost        CostReport{ currency, vendor_cost, usage{tokens?, seconds?, bytes?} }
            「钱发生在哪一侧」写进 adapter 元数据，不要每次口头问
SkipBilling 与 PPTCreator 的 checkUserCredits / worker 实扣同类：平台内部 credits 必须旁路
Isolate     平台若有用户 dashboard，B2B 产物不可见（§8 第 6 条推广为通则）
```

PPTCreator §8 八条，是这份合同的第一份检查表。OpenMAIC / AI3D / 数字人各自复制一张表，缺一格就不能标「已接入」。不要把 partner 认证写成「PPTCreator `/mcp` 特有」。

#### C.2 产物有三种，submit/query 只覆盖第一种

正文长任务模型默认「生成完给下载 URL」。四种能力对不上：

| job_kind | 谁 | 完成时给用户什么 | 网关必须做的 |
|---|---|---|---|
| `batch_file` | PPT、AI3D、数字人成片 | 文件（pptx/glb/mp4） | 拉到 **本侧** org 前缀对象存储，签发短 TTL；禁止把四家预签名 URL 原样转手（TTL/鉴权各不相同，PPTCreator 已是 300s） |
| `hosted_session` | OpenMAIC 课堂 | 可打开的课（URL 或导出的 HTML 包） | 生成物在哪台机器上跑、会话多久、谁能打开，必须过网关鉴权；不能把 OpenMAIC 裸链接发给模型 |
| `realtime_stream` | 部分数字人/星云类端渲染 | 推流/SDK 会话 | **不适合 P0 的 submit/query。** 合同若含「实时数字人」，单独立项；年买断的护栏按会话分钟计 |

OpenMAIC 若只当「帮我生成一课然后导出 PPTX/HTML 下载」，可以降级为 `batch_file`，接入成本接近 PPT。若教师/学生要 **进课堂互动**，就是 `hosted_session`：身份、租户隔离、内容会不会进 OpenMAIC 公共库、下课是否销毁，全部是新面。**接 OpenMAIC 之前先拍 job_kind**，不要假设它和 PPTCreator 一样。

#### C.3 Job 行要记下平台，不只记下能力

网关 Job 建议字段：

`id, org_id, project_id, capability, platform, platform_job_id, job_kind, spec_ref, status, cost_report, artifact_refs[]`

`artifact_refs` 指向本侧存储或本侧托管入口，不指向平台临时 URL。重试已规定新 job_id；换平台重试也是新 job（换路由），不要在原行改 `platform`。

并发公平：§7 按 org 限 in-flight 不够。应对 **(org, platform)** 限流——数字人队列堵住时，PPT 还应能提交。平台自己的护栏（PPTCreator `partner:{orgId}`）保留。

失败隔离：adapter 超时/5xx → 该 job failed，**不要**把网关整体标 billing_unavailable。billing 挂了才 fail-closed。

#### C.4 材料与产物都走本侧存储

四平台不要各收一套 multipart。统一：

1. DSH/用户把材料传到网关对象存储（org 前缀）
2. adapter 把 **短 TTL 的 GET URL** 交给平台（平台拉文件）
3. 平台完成回调或 query 给出产物 URL
4. 网关 **拷贝** 到本侧，再给 DSH 签名 URL

3D 包和视频很大，禁止经 MCP 工具返回值传二进制。OpenMAIC 的 HTML 课若含一堆资源，按目录打包进对象存储，或网关反代其托管域名并注入机构 cookie/token。

教材正文会进 **每一个** 被调用的平台。合规开放问题（§10.1）要从「PPT 管线进哪个 LLM」扩成 **按平台的数据处理清单**（OpenMAIC 是否自托管、数字人是否出境、AI3D 是否用于训练）。按年卖的合同附件就是这张表。

#### C.5 工具面：按 capability 前缀，不要按平台前缀

模型不应看见 `mcp__pptcreator__*` / `mcp__openmaic__*`。它看见：

- `get_entitlements`（本合同开通的 capability + 一句话何时用哪个）
- `create_project` / `list_jobs` / `cancel_*`
- `submit_ppt` / `query_ppt`
- 开通后才出现：`submit_classroom` / `submit_avatar` / `submit_3d` …

平台故障或切换路由，工具名不变。`get_entitlements` 必须写清重叠规则（B.2），否则模型会两个都调。

### D. 各平台接入时特有的坑（避免到联调才发现）

**PPTCreator**  
§8 仍然成立，当作 adapter 第一实例。不要在网关里写死它的 MCP 工具名；网关以 partner 身份调它的 create/status/download。

**OpenMAIC**  
- 开源可自托管：P0 若接它，**默认自托管**（高校数据），不要指向公共 openmaic.chat。运维（LLM key、生成流水线、课堂播放进程）是第二套生产系统，写进范围，不要藏在「一个 adapter」。  
- HTTP 生成是多步（大纲 → 场景 → 内容 → action），对网关应收敛成一个 `submit_classroom`，内部编排属 adapter，不要把五步暴露给 DSH。  
- 课堂是长生命周期对象：License 到期后 URL 必须失效（与 §10 生成物 90 天规则对齐）。  
- 它自己也会调 LLM/TTS/图像：CostReport 必做，否则按年卖的数字人还没上，OpenMAIC 已经把毛利烧了。

**数字人**  
- 先确认是 **成片** 还是 **实时**。成片走 `batch_file`；实时不进 P0 网关主链。  
- 形象资产（形象 ID、音色 ID）挂在 Org 或 Project 上，不要挂在某个教师的平台个人账号。  
- 护栏 unit 用 second/minute，估计值 = 脚本时长；超支策略在这类能力开门前必须拍板（§10 已把超支留给「视频」，数字人同类，不要再漏）。

**AI3D**  
- 写明产品：混元生3D / Meshy / 自研 / 其他。接口、格式、商用条款差很远。  
- 产物多文件（mesh + 贴图 + 绑定），`artifact_refs` 要能表示 **一组** 文件 + 推荐预览格式（glb）。  
- 教材场景要规定「能进 PPT 的预览图」：只给 glb，教师在 DSH 里看不见。adapter 应附一张预览 png（平台给或网关打一张）。

### E. 分期：商业开通 vs 架构骨架

§10 的 P0 只做 PPT，作为 **合同开通范围** 仍然合理（数字人/3D 成本未验证）。但实现上：

| 期 | 架构 | 合同可卖 |
|---|---|---|
| P0 | 网关 MCP + billing + **Adapter 接口** + PPTCreator 第一实例 + 本侧对象存储 | PPT |
| P0.5 / P1 | 同一 Adapter 的第二实例（建议 OpenMAIC 自托管，`job_kind` 先定为导出文件或单课托管二选一） | PPT + classroom（若战略需要） |
| P2 | AI3D `batch_file` | + asset_3d |
| P3 | 数字人成片；超支策略拍板 | + avatar |
| 以后 | 实时数字人、跨能力编排（PPT 页 → 数字人讲稿 → 课堂） | 编排是商品，仍不要 P0 预埋工作流引擎 |

「对账跑不通不接第二个能力」仍然成立：第二个 adapter 接上之前，CostReport 和日对账要先在 PPT 上跑通。否则 OpenMAIC 的 token 账单会变成第二本糊涂账。

### F. 本轮建议补进正文的最小集合（未拍板，供下一轮修订）

1. §1 能力清单写成「PPTCreator / 数字人平台（待命名）/ AI3D（待命名）/ OpenMAIC」，不要「视频/图片/数字人供应商」。  
2. §2 架构图：DSH → 唯一网关 MCP → `internal/execution/adapters/*` → 各平台；billing 不 import adapter。  
3. 新节「能力适配合同」：C.1 的接口 + job_kind 三分类；§8 改为「PPTCreator 实例」。  
4. Capability 目录与 License 快照（A）。  
5. 重叠路由默认（B.2）+ OpenMAIC 的 job_kind 选择（C.2）列入 §10 仍开放。  
6. 对象存储作为材料/产物的唯一交换格式（C.4）。

### G. 本轮结论

账本和身份可以按现在的 §3–§6 建表。**execution 不要按 §8 硬编码 PPTCreator。** 多平台是这个产品的定义，不是 P4 点缀。缺适配合同的后果很具体：第二个平台复制一套 partner 认证和一套临时 URL，第三本账对不上，教师的一句「做课」同时打响 PPT 和 OpenMAIC。

先拍三件事就能写 adapter 而不返工：① 四平台的正式名称与是否自托管；② OpenMAIC 是导出文件还是托管课堂；③ `ppt` vs `classroom` 默认路由。其余（实时数字人、跨能力编排）可以留在后面。

---

## 16. 修订记录（2026-08-24 第五轮）

对照物：§15 第四轮评审；本轮产品澄清（课程套件 / 姐妹平台 / 数字人后期合成 / OpenMAIC 取舍）。§11–§15 为历史记录，与本轮冲突处以正文 §1–§10、「附」及本节为准。

### 本轮写入正文的决议

1. **卖的是一套课，不是四个生成按钮。** 教师说「根据某章做课」，要的是结果（课程设计、大纲、PPT、讲稿、后续还有练习/视频/3D）。过程由我们编排 agent + 网关 `lesson` job 完成。
2. **能力来自自有姐妹平台**，各自托管、可自行做 2C；给 codelphi 只提供 partner 能力。渠道即账本对每个姐妹平台成立（§6）。
3. **数字人不是实时的。** 讲稿（通常即 PPTCreator 备注页）→ 人像成片 → 叠到 PPT 播放视频**侧面、不遮挡画面**。合成器是网关 worker，不塞进某一 2C 产品。
4. **PPT + 讲稿只走 PPTCreator。** OpenMAIC 尚未深研：若只做 PPT → **不用**；仅当它贡献套件里 PPT 以外的构件才接。未证伪前不进 P0、无 `classroom` 工具。
5. **P0 商业切片** = 课程设计 + 大纲 + PPT + 讲稿。架构 P0 仍要 Adapter 接口 + 对象存储 + `submit_lesson`（缺件后补）。讲解视频、练习、3D 分期挂上同一套件，不是另做四个产品。
6. PPTCreator partner 增加第 9 条：讲稿必须随 pptx 回报（数字人合法输入）。

### §15 仍成立（不撤回）

- capability / platform / vendor 三词拆开；License 快照是 capability 列表，不是平台商品名
- 对 DSH 只暴露一个 MCP；网关后面是 adapter，禁止按平台发明第二套闸门
- Partner 适配合同（Auth / Identity / Submit / Query / Cancel / Cost / SkipBilling / Isolate）；§8 是第一份检查表
- 材料与产物走本侧对象存储，不转手各平台临时链
- Job 记下 platform；并发公平按 **(org, platform)**；CostReport + 对账跑通再接第二个能力
- 不要在网关核心写死 PPTCreator；数字人/AI3D 正式产品名仍待填
- 合规清单按平台列数据处理（自托管 / 出境 / 训练）

### §15 撤回或改判

| §15 原判断 | 本轮 |
|---|---|
| 数字人可能是实时驱动 / `realtime_stream` 要单独立项才能讲 | **已定成片 + 旁挂合成**，实时不在范围内 |
| 产品 = 四个独立 `submit_*`，教师/agent 选平台；`ppt` vs `classroom` 默认路由是开工前必拍项 | **教师不选平台。** 内部 `ppt`+讲稿锁定 PPTCreator。OpenMAIC 先 spike，不是默认第二条课件引擎 |
| OpenMAIC 默认当互动课堂、比「再做一份 PPT」更近，P0.5 建议接 | **未研究清楚前不假设。** 只做 PPT 则砍掉；贡献独特构件再接 |
| 编排（PPT → 讲稿 → 数字人 → 课堂）是 P4 商品，P0 不要预埋工作流引擎 | **编排就是产品形态**，P0 就要 `submit_lesson` / CoursePackage；只是部分构件后补，不是「先做单能力按钮再编排」 |
| job_kind 三种并列（`batch_file` / `hosted_session` / `realtime_stream`）作为数字人主模型 | 当前范围内：姐妹平台产出 + 合成器都是 **`batch_file`（或本侧合成文件）**。`hosted_session` 仅当 OpenMAIC spike 证明必须托管课堂才启用。`realtime_stream` 否决 |

### 分期对照（相对 §15.E）

| 期 | 教师拿到的套件 | 架构 |
|---|---|---|
| P0 | 课程设计、大纲、PPT、讲稿 | Adapter 接口 + PPTCreator 实例 + 对象存储 + lesson 编排（后三件标缺件） |
| P1 | + 练习 | DSH 自产，或 OpenMAIC（仅当 spike 通过） |
| 随后 | + 讲解视频 | 数字人 adapter + PPT 渲染 + 旁挂合成器 |
| 另开 | + 3D 教具 | AI3D adapter |

「对账跑不通不接第二个能力」仍成立。


---

## 17. 修订记录（2026-08-24 第六轮）

本轮三条决议：DSH 撤桌面改云端、合成器输入改成品 PPTX、Artifact 留版本。§11–§16 为历史记录。

**决议与改动对照：**

1. **DSH 只在云端，撤桌面形态**（§1、§2、§5、§9、§10、附）
   - 论据一：关闭「桌面 agent 的 LLM key 与 token 成本无归属」的洞——agent loop 在云端，LLM key 不出云，token 成本进 UsageRecord（§3 补 `agent_llm` 计量，§9 第 3 条）
   - 论据二：§11 A.6 推迟云端 DSH 的核心理由是 per-tenant 沙箱，但那是本地型 agent（shell/fs/终端）的问题；教师端 agent 只挂网关 MCP，无本地执行面，沙箱问题不成立（§9 第 2 条）
   - 论据三：桌面分发成本（签名/自动更新/学校白名单/OIDC loopback）清零，试用门槛降为「开链接」
   - 代价进 P0 范围：会话隔离（`dsh-session` SQLite 单机持久化 → 按 member 分实例或改造存储，列为 §10 仍开放第 7 条）；「数据不出桌面」理由作废，合规重心移到云端数据处理清单
2. **PPT 播放条从成品 PPTX 渲染，撤 HTML 中间态**（§2.1、§7、附）
   - 理由：HTML 有文本溢出等问题，成品 pptx 是 PPTCreator 后处理结果，回放必须忠于成品
   - 路径：pptx → LibreOffice headless 逐页出图 → 按逐页讲稿时长 ffmpeg 播放条 → 与人像成片旁挂合成
   - 前提与风险写入 §2.1：服务器 CJK 字体（PPTCreator 生产事故教训）；LibreOffice ≠ PowerPoint 保真，spike 验收为人眼抽查真实 deck
   - **合成器 spike 提前**：它是讲解视频链上唯一无既有资产的环节，且决定数字人 adapter 规格与 §8 第 9 条讲稿回报字段（是否带每页时长）
3. **Artifact 留版本**（§3）：每 kind 留版本行、当前指针指最新；教师迭代是常态，历史可回看可下载；成本侧不受影响（UsageRecord 挂 step_job_id）

**附带加固：**

- §2.1 补「编排实现形态」约束：lesson 编排 = 固定管线硬编码，不做通用 DAG 引擎——调和 §16「P0 即编排」与 §13 D「P0 不预埋工作流引擎」（§10 已定默认加行）
- §2.1 OpenMAIC spike 补两周时间盒（§10 仍开放第 4 条）
- §3 License 成本预警补「按 capability 拆开看」（§15 B 遗留，本轮并入）
- §5 身份链路图改为浏览器 → OIDC → 云端 DSH 会话 → 网关

---

## 18. 第七轮评审（2026-08-24，针对 §1–§10 + §17）

对照物：现行开工依据（§1–§10、「附」）；§16/§17 决议是否落地为可实现约束；DSH（`apps/web` 是本地 host 上的 SPA，`packages/host` + `apps/cli` 启 `dsh-base`；`dsh-session-persistence-sqlite` 是可选单库、产品组合默认不挂；host「一实例服务所有 session」是单用户信任模型）；PPTCreator（生产渲染是 Playwright HTML→pptxgenjs，LibreOffice 只在 visual-diff / 校验；MCP `get_generation_status` 不回报讲稿；worker 讲稿 docx 失败被吞掉仍标导出成功）。

本轮不重开：按年买断、渠道即账本、Org=成交院系、数字人非实时、OpenMAIC 先 spike、教师不选平台。

**总评：** 商品定义（一套课）和零件关系（姐妹平台 + 固定管线）已经够开工画图。第六轮三条决议方向对，但把「云端 DSH」写进 P0 时，用了一句不成立的论据——「不挂 shell 就不需要租户隔离」。现在最大的风险不再是账本，而是 **把单用户本地 harness 当成多租户 SaaS 来部署**，以及 **网关管线和 DSH agent 两套编排抢权**。这两处不拍，试点校会先卡在登录和「课在哪」，而不是 PPT 质量。

### A. 第六轮消化

| 第六轮决议 | 正文状态 | 本轮态度 |
|---|---|---|
| 卖一套课，不卖四个按钮 | §1、§2.1、CoursePackage | 关闭 |
| 数字人成片 + 旁挂合成 | §2.1 | 关闭；合成器 spike 不要挡商业 P0 |
| PPT+讲稿只走 PPTCreator；OpenMAIC 先证伪 | §2.1、§10.4 | 关闭 |
| 固定管线，非 DAG 引擎 | §2.1、§10 | 关闭；与 agent 职责仍打架，见 C |
| Artifact 留版本 | §3 | 关闭；缺「重建」动词，见 F |
| 撤桌面、改云端 DSH | §1、§2、§9 | **方向同意，实现约束不够**，见 B |
| 播放条从成品 PPTX / LibreOffice | §2.1 | 方向同意；路径已有现成资产，见 E |
| agent_llm 进 UsageRecord | §3 | 记账对，闸门缺，见 D |

### B. 「云端 DSH」不是把 `apps/web` 挂上网

§9 写「基于 `apps/web`」。仓库里的事实是：`apps/web` 是浏览器壳，agent 跑在本机 host（`packages/host` + `dsh-base`）。工作区是本地目录（`directory-picker`），会话日志默认不是多租户库。这是 **单用户开发工具的 GUI**，不是机构 SaaS。

§9 第 2 条用「教师端不挂 shell/fs/终端 → 不需要 per-tenant 沙箱」回应 §11 A.6。这句话只排除了一种隔离（OS 命令执行）。云端化之后仍然必须隔离的包括：

- **会话日志**：教材正文会进 `SessionEvent`。SQLite 单库或「按 member 起进程」都不能当默认。host 文档写明一实例服务所有 session——那是单用户信任；多租户要对 **每一条 host API** 做 member 鉴权
- **材料**：教师没有本地 cwd。`directory-picker` 在浏览器里无意义。章 PDF/图片必须进本侧对象存储（与产物同一套），再给 agent/adapter 签名 URL
- **工具面**：DSH 现成还有 `web_search` / `web_fetch`。不挂 shell 不等于没有出网面。preset 必须白名单：只挂网关 MCP。`web_fetch` 默认关（SSRF + 教材外泄）
- **Prompt 注入**：上传的章材料是不可信输入。MCP-only 不消灭这个面

§10 仍开放第 7 条（按 member 分实例 vs 改造存储）不应再漂。**建议已定默认：共享进程 + 会话按 `member_id` 分区的持久化（Postgres 或对象存储上的 session backend），禁止「一教师一进程 / 一教师一块 SQLite」。** 分实例在 200 名教师时运维不可接受。

P0 客户端的诚实表述：

> Codelphi 运行时 = **裁剪过的多租户 DSH host**（受限 preset + 会话隔离 + chandler 登录），不是官方 `apps/web` 原样上云。

不要在销售/工期上假设「DSH 已经有 Web，改配置即可」。这是一条产品分叉，工作量与网关相当，可能 **长于** PPTCreator partner。

**身份链（§5 与云端化冲突）：** 浏览器 OIDC 的 RP 是 DSH 站点，网关 `aud` 却要求等于网关 `client_id`。用户 token 的 aud 不会自动变成网关。需要写死：Chandler 上两个 client（`codelphi-web`、`codelphi-gateway`），DSH 用 token exchange（或同等）换网关 Bearer；`X-Org-Id` 来自 DSH 登录会话，不来自模型。缺这一段，云端第一天登录能进 DSH、调不了网关。

### C. 两套编排：定一个主人

§2.1：lesson 管线硬编码在网关（设计→大纲→PPT→讲稿）。§7/§9：DSH agent 负责填缺件、调用 `submit_ppt` 等底层工具。

两个主人会同时发生：agent 自己写了一份大纲贴进 chat，网关 `submit_lesson` 又生成一份；agent 调了 `submit_ppt`，lesson 状态机不知道。CoursePackage 变成 chat 附件桶。

**建议已定：** 网关是编排唯一权威。教师对话只做三件事——收集材料与约束、调用 `submit_lesson`、展示/对比 `get_package` 版本。Agent **禁止** 在 P0 直接调 `submit_ppt` / 各 step（可对内部运维保留，不对教师会话暴露）。课程设计/大纲是 lesson 的 step（网关侧 LLM adapter，产出有 schema 的 artifact），不是 chat 里的自由 Markdown。Chat 是草稿，**提交进套件才算数**。

这与「教师要结果、过程由我们编排」一致，也避免再做一个工作流引擎——固定管线在网关里就够了。

### D. `agent_llm` 有账无闸

§3 把云端 DSH 的 token 写入 UsageRecord，正确。authorize 仍按 **submit job** 入场。教师说「根据某章做课」之前，可能先聊 20 轮。这 20 轮没有 reservation，按年卖的成本洞从桌面挪到了云端，只是现在能看见账单。

P0 最低：`agent_llm` 作为每份 License 的隐含能力（或显式 item），**按 member 的周期帽**在每次模型调用前 authorize（估计值可用 token 上限；settle 用实际 usage）。帽可以很宽，目的与 PPT 护栏相同：防脚本化刷对话，不是向学校卖 token。没有这一层，§4「对账跑不通不接第二个能力」在第一个构件（课程设计）上就不成立。

### E. 合成器：复用 PPTCreator 已有的 soffice 路径，且不要挡 P0

成品 PPTX 作为播放条输入——同意。PPTCreator **已经**用 LibreOffice headless 做 PPTX→PDF→PNG（`scripts/visual-diff.ts`、`validatePptxWithLibreOffice`），并记录过：默认 profile 污染导致字体全被替换、LibreOffice ≠ PowerPoint、嵌入字体 tdf#106771。生产渲染仍是 Playwright，不是 soffice。

建议：

1. 合成器 spike **复用**这条 visual-diff 管线（隔离 user profile、CJK 字体、逐页 PNG），不要在网关 Go 里从零包一层 soffice
2. 人眼验收对比物是 **同一份 pptx 在 PowerPoint/WPS 里的观感**，不是 HTML
3. **商业 P0 不依赖该 spike。** 它只服务讲解视频；写进架构 P0 会把「交出 PPT+讲稿」绑在一条无客户的链上

§8 第 9 条比合成器更急：现行 MCP status **没有讲稿字段**，download 只有 pptx；worker 里讲稿 docx 失败是 `console.warn` 后继续成功。partner 必须：逐页 notes（JSON，与页数对齐）+ 可选 script docx；notes 为空 = job failed，不能当成功。数字人还没接，套件里的「讲稿」构件已经需要这份 JSON。

### F. 版本没有「重建」就只是磁盘

Artifact 留版本正确。教师迭代的动词还没有：P0 仍禁止单页重生，所以「改第 3 页」= 整份 PPT 重跑 = 新版本。写进教师面和 agent 面，避免模型去打 `/slides/n/regenerate`。`get_package` 回当前指针 + 最近 N 版；UsageRecord 继续挂 `step_job_id`。

缺一层 **教材/课程**：Project 是一章。P0 可以扁平（每章一个 Project），但文案不要「先建课」又「一章」。建议 Project.title 就是章名；一门课用多个 Project，用 tag/`type_label` 先凑合，不建树。

### G. 材料入口仍是空白

「根据某章做课」的输入没落模型。云端之后更不能假设粘贴得下整章。P0 要有：Project 上的 `materials[]`（对象存储、短 TTL、种类 pdf/docx/image/text），`submit_lesson` 只引用这些指针。这是对象存储作为交换格式的第一笔，比第二个 adapter 更早。

### H. P0 范围被云端 DSH 撑满

现行架构 P0 并列：网关 + billing + Adapter + PPTCreator partner + 对象存储 + lesson 管线 + 运营后台 + **多租户 DSH**。其中 DSH 云端化是新的最长杆。

建议工期上承认两条并行关键路径，验收仍只认套件切片：

| 路径 | 试点校当天必须通 |
|---|---|
| 网关 | 登录后的 `submit_lesson` → PPT+讲稿进套件、可下载、记账 |
| 客户端 | 浏览器能进、能传章材料、能看到套件与版本 |

客户端做不到「原样 apps/web」时，允许 P0 用 **薄工作台**（Chandler 登录 + 套件页 + 一个对话入口）接网关，DSH 完整 UI 随后替换——前提是网关契约不绑 DSH 私有头（§2 已有，保持）。不要为了「必须用 DSH」把第一所学校拖过学期。

可观测性（authorize 拒绝计数、reserved 堆积、License 成本比、agent_llm 日耗）仍未进 §1–§10，实现计划里写即可，本轮不挡模型。

### I. 建议本轮拍板、仍不必改商业模式的

1. 云端 DSH = 裁剪后的多租户 host，不是 `apps/web` 原样部署；会话隔离默认共享进程 + member 分区；preset 仅网关 MCP
2. OIDC：双 client + token exchange；网关 aud 保持
3. 编排权威在网关；agent 只 intake / `submit_lesson` / 展示套件
4. `agent_llm` 进闸门（宽帽）
5. PPTCreator partner：MCP/status 必须带逐页 notes，空 notes 失败
6. 合成器 spike 复用 visual-diff，不进商业 P0 门禁
7. Project 材料进对象存储；P0 不建教材树

拍完这七条，§1–§10 才是一份能分给两个仓库开工而不返工身份/会话/编排的说明书。未拍之前不要同时开工「改 DSH 上云」和「写网关 adapter」——会在令牌和套件状态上对不上。

---

## 19. 修订记录（2026-08-24 第八轮）

问：DSH 是不是只负责编排、网关 Web 另做、角色怎么定、如何用足 DSH。答写入 §2、§2.2、§7、§9、「附」。

**决议：** 「编排」拆三层，不要并进 `apps/web`。

| 层 | 归属 |
|---|---|
| 套件状态机（SoR） | 网关 `submit_lesson` |
| 对话编排（intake / 确认 / 返工） | DSH host + 受限 preset |
| 文件柜（材料/版本/下载） | 网关域自建 **套件工作台** |

DSH **不是**只做编排——它不做 lesson 拓扑。DSH **也不是**产品壳。它是对话运行时；用足的是 agent loop、失败话术、会话（「plan/approval」一条已由 §20 撤回），不是 shell/workspace/trajectory 当 CMS。

P0：工作台可薄、DSH 可后嵌；不要为嵌 DSH 挡「交出 PPT+讲稿」。

---

## 20. 修订记录（2026-08-24 第九轮）

问：为什么需要自然语言对话框。若用户只说「帮我做个课」，不如按钮；只有对半成品有修改意见才需要与 agent 对话。

**决议：** 对话的存在理由收紧为 **半成品返工**。

- 首轮：工作台上传 + 可选补充说明 +「做课」→ 网关 `submit_lesson`。不经 DSH
- 确认（通过、继续生成 PPT）：工作台按钮，不用 DSH plan
- 失败：工作台横幅，不弹进聊天
- 对话：绑定当前构件版本；「对这一份提意见」才打开。空聊天不准上线
- DSH 用足处：指代消解与把散意见收成 rebuild spec，不是做课入口

第八轮里「intake / 确认也走对话」撤回。

---

## 21. 修订记录（2026-08-24 第十轮）

对照物：第九轮并入后的正文再审意见（确认门不在状态机、Project 缺 materials、设计/大纲 capability 悬空、agent_llm 有账无闸、§19 残留 plan/approval、CSV 导入主体模糊）。§11–§20 为历史记录。

**本轮决议与改动：**

- **扣费粒度 = step。** lesson 不整单预扣；每个 step 提交前各自 authorize、结束后各自 settle（§4）。确认门等待期间根池不被占用
- **确认门入状态机。** §2.1 管线改为「设计 → 大纲 → `awaiting_confirm` → PPT+讲稿」；「通过，继续」是状态迁移，不是 UI 层把戏（§2.1、§7）
- **设计/大纲 provider 新做。** 无姐妹平台可接，网关新做 LLM adapter，capability 记 `design`/`outline`，成本按 token 计 `vendor_cost`，同样过闸门（§2.1、§10）
- **Project 补 Material 实体**（§3）：章材料进本侧对象存储，`submit_lesson` 只引用指针——补上 §18 G 的欠账
- **PPTCreator 需支持多文档输入**（课文 + 教学设计等多份材料）：已核实不支持——MCP 只收单 `document_id`/单段文本，worker 对 `project.document` 单一文档硬依赖。列入 §8 第 10 条，是 partner 改造里除第 9 条（讲稿回报）外第二个挡 P0 的项。方向一（Document 1:N，随 PPTCreator 既有多文档路线图）为归宿；方向二（网关侧预合成单文档）仅作 P0 过渡
- **agent_llm 进闸门**（§4、§9）：返工对话每次模型调用前按 token 上限 authorize、按实际 usage settle；宽帽防脚本化，billing 不可用 fail-closed
- **CSV 导入主体明确**（§1.1、§3）：P0 为运营代导入（机构提供名单），机构自助入口 P1
- **§19 措辞修正**：「用足 plan/approval」删除（§20 已撤回）

**补充事实（同日）：**

- 技术栈由 Postgres 改 **MySQL**：生产为腾讯云 MySQL 集群，本地有 MySQL 环境；凭据一律放本地环境/密钥管理，不进仓库（§10）
- 现阶段业务域名 **`app.codelphi.com`**，已指向 101.32.49.240；本机持有该服务器密钥，可直接登录部署（§10）

---

## 22. 修订记录（2026-08-24 第十一轮）

**决议：身份链撤「双 client + token exchange」，改单应用单 client。** §11–§21 为历史记录。

- 依据（查证 WorkMembership 源码仓）：chandler `/v1/oauth/token` 仅支持 `authorization_code` / `refresh_token` 两种 grant，无 RFC 8693 token exchange；且 chandler 语义中 client_id = 应用，同一产品不应拆两个应用
- §5 链路改为：工作台以 `codelphi` 应用（单 client）发起 OIDC，token `aud` 天然等于网关校验值，直接作网关 Bearer；DSH 返工时复用同一张 token。拆双 client 留作 WorkMembership 支持 token exchange 后的备选
- §5 补 chandler 对接事实：JWKS URL `https://api.chandler.work/.well-known/jwks.json`、发现文档 `/.well-known/oauth-authorization-server`、`iss = workmembership`（字符串）、client 自助注册 `POST /v1/me/oauth/clients`（secret 仅注册时返回一次）、参考实现 `tools/mcp-spike/`
- 同步改：§2 架构图、§2.2、§9 第 4 条。§18 评审原文（双 client 出处）为历史记录，不改

**同日更正：** §21 补充事实中「app.codelphi.com 已指向 101.32.49.240」作废——该机（VM-16-7）当日资源耗尽挂掉，生产迁移至 124.156.160.168（VM-32-3），以 §10 部署行为准。
