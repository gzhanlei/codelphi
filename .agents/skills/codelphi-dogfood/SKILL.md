---
name: codelphi-dogfood
description: CoDelphi 自研 dogfood 循环：用 CoDelphi MCP（slug codelphi）改进本仓库自身的开发。凡涉及 push/部署 CoDelphi 之后的对账验收、发布稿素材整理、账本/规格异常排查（功能去哪了、变化清单对不对、证据 URL 指错 commit）、改文件前的影响面检查、MCP 工具面改动的生产验收——即使用户没提「账本」「MCP」「规格」也应使用。
---

# CoDelphi Dogfood 循环

本仓库的产品账本连接在 MCP 服务 `codelphi` 上（slug `codelphi`，即 dogfood）。账本对 agent 的价值有两个：**跨会话的行为记忆**（已核实、带证据锚）和**独立观察者**（从 diff 独立归纳「代码做了什么」，与本会话记忆无关）。会话已连接 codelphi MCP 时直接调用其工具；否则用 `scripts/mcp-call.py` 直连生产（见下）。

## 红线（每条都来自真实生产事故，不是风格建议）

- **账本是快照不是工作区**：先看 `get_project_summary` 的 `specSnapshot`（sha + specVersionId）。工作区领先账本的部分不在账本里；证据行号以快照 commit 为准，行号对不上先查快照差距再怀疑代码。
- **没搜到 ≠ 不存在**：证据覆盖率 ~13%（`evidenceCoverage.coverageRatio`）。search/lookup 空结果只说明账本未覆盖，不能反推「没有这个行为」。
- **账本只读**：唯一写是 `send_feedback`（人裁决）。agent = 巡检员，不是编辑者。发现账本与代码不符 → `send_feedback(kind:"bug")` 带上场景、证据、实际行为三要素。
- **release summary 只描述 head commit，changes 覆盖整个窗口**——两者常脱节（release #200 实锤：摘要说「仅改 .dockerignore」，清单却有 118 个功能移除）。引用变化清单前先核对这次 push 实际改了什么。
- **排查「功能去哪了」先查 removed 的 source**：`manual` 内容被自动分析动掉 = 红线事故，立即上报；`generated` 被洗牌是已知 bug 形态（v201：全量重建时 tests-only 门禁吞掉全部新增、旧名记为移除；修复 31c7cbc，**首次全量重建分析时要验证 added feature 行数与真实新功能数一致**）。

## 日常循环

### 1. 改文件前（Edit 之前）

反查爆炸半径——谁以这些文件为证据：

```
lookup_by_files(slug:"codelphi", paths:[...改动文件])
get_feature_connections(slug:"codelphi", path:"lib/xxx.ts")   # 共享该文件的功能邻域
```

- 每功能场景截前 10 条，`scenarioCount` 是真实总数。
- 空结果合法（文件不在账本证据面内），别当 bug 修。
- `connections(path:)` 空可能只是「该文件无共享对」——需要确认时拉一次无过滤图对总数。

### 2. 理解既有行为

```
search_scenarios(slug:"codelphi", query:"关键词")   # 命中带 stableKey + 证据 path:line
get_feature(slug:"codelphi", stableKey:<搜索结果里的>)   # 深入功能与全部场景
```

写新代码前对齐同域场景的既有约定；不一致要么是有意变化（进 changes 清单），要么是 bug。

### 3. push / 部署之后（对账——每次必做）

```
list_releases(slug:"codelphi", limit:5)   # 找本次 push 的 sha
get_release(slug:"codelphi", releaseId:<找到的>)
```

核对三件事：①变化清单 ⊆ 本次 push 的意图（有「计划外变化」→ 回查代码）；②全量重建的 release：added feature 行数 == 真实新功能数（0 条 + 大量 removed = 折叠门禁复发）；③summary 与 changes 是否脱节。异常走 `send_feedback` 上报，同时在回复里向用户点名。

### 4. MCP 工具面改动的生产验收

部署后必做：`tools-list` 确认工具数量与新增工具在列 → 新工具用真实参数 spot check（含一个账本外输入的诚实空态）→ 外网冒烟 `/login` 与匿名产品页 200。

## 直连生产 MCP（会话未连接 / 验收用）

```bash
.agents/skills/codelphi-dogfood/scripts/mcp-call.py tools-list
.agents/skills/codelphi-dogfood/scripts/mcp-call.py lookup_by_files '{"slug":"codelphi","paths":["lib/analysis.ts"]}'
```

凭据从 `~/.zcode/cli/config.json` 的 `mcp.servers.codelphi` 读取（不回显、不落盘）。**这是生产**：`send_feedback` 会真实落库进产品方后台，别当测试环境乱发。

## 生产 DB 只读核查（MCP 答不了的深查）

```bash
ssh 124.156.160.168 'docker exec -i codelphi-docker-app-1 node -' <<'EOF'
const mysql = require("mysql2/promise");
(async () => {
  const pool = mysql.createPool(process.env.DATABASE_URL);
  const rows = await pool.query("SELECT ...");   // 只读 SELECT
  console.log(JSON.stringify(rows[0]));
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
EOF
```

- 只 SELECT；先 `SHOW COLUMNS` 再写查询（迁移记账表列名没核对过，别猜）。
- 已知坑：`trigger` 是 MySQL 保留字；证据 URL 的 sha 以 correlated 子查询取最新 run（6735e4e 修复后形态）。

## 部署

生产部署走 docs/docker-migration-plan.md：本地 `docker build --platform linux/amd64 -t codelphi-server:sha-<short> .` → `docker save | gzip | ssh 'gunzip | docker load'` → `/data/www/codelphi-docker/deploy.sh`（pull 跳过 → migrate 幂等 → up → 冒烟）。部署完成后回到第 3、4 步做对账与验收。
