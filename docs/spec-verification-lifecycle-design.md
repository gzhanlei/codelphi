# P1 规格核实生命周期 · 数据模型设计

> 2026-11-08。按 [产品能力基线](product-capability-maturity-roadmap.md) P1 的约定：本设计先于编码，冻结后实施。设计对象是「来源 / 时效 / 确认」三维度中的**确认**维度；`source` 与 `stale_since` 语义保持不变（唯一例外见规则 2）。

## 1. 状态模型：不存状态列，状态由两条记录推导

规格条目（features 与 scenarios 两者，机制相同）的核实状态是**推导值**，不落独立 status 列：

| 展示状态 | 推导条件 |
|---|---|
| 未核实 | `verified_at IS NULL` |
| 已核实 | `verified_at IS NOT NULL AND stale_since IS NULL` |
| 待重新核实 | `verified_at IS NOT NULL AND stale_since IS NOT NULL` |

推导的好处：非法状态（如「已核实但内容随后被改」）无法被写出来——任何让内容或代码事实变化的动作都自然改变推导结果。

## 2. 数据模型

### 2.1 工作表新增列（features / scenarios 各加一对）

```sql
ALTER TABLE features  ADD COLUMN verified_at DATETIME(3) NULL, ADD COLUMN verified_by VARCHAR(320) NULL;
ALTER TABLE scenarios ADD COLUMN verified_at DATETIME(3) NULL, ADD COLUMN verified_by VARCHAR(320) NULL;
```

### 2.2 历史核实表（append-only，审计链）

```sql
CREATE TABLE spec_verifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('feature', 'scenario') NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,          -- features/scenarios 的行 id（upsert 模式下跨分析稳定）
  spec_version_id BIGINT UNSIGNED NULL,        -- 核实对应的规格快照
  commit_sha VARCHAR(64) NULL,                 -- 核实对应的代码版本
  verified_by VARCHAR(320) NOT NULL,
  verified_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY spec_verifications_entity_idx (entity_type, entity_id),
  KEY spec_verifications_product_idx (product_id)
);
```

双版本绑定：每条历史记录同时固定 `spec_version_id`（核实的是哪版规格）与 `commit_sha`（对齐到哪版代码）。只记 `verified_at/verified_by` 无法回答这两个问题，也就无法在内容或代码变化后正确失效。

### 2.3 与 drift 机制的关系

`stale_since` 语义保持：**只有相关代码变化**（`spec-drift.ts` 按证据路径定位）打点，只有核实动作或重新分析合并清除。新增的唯一改动：人工编辑不再重置 `stale_since`（见下）。

## 3. 状态转换表

| # | 触发动作 | verified_at | stale_since | 历史表 |
|---|---|---|---|---|
| 1 | AI 生成新条目 / 重新分析更新了该条目内容 | 清空（→ 未核实） | 不动 | — |
| 2 | 重新分析合并，条目为 carry-forward（内容未触及） | 保持 | 不动 | — |
| 3 | 人工编辑条目 | 清空（→ 待重新核实/未核实） | **不动**（解耦：修订 ≠ 核实） | 原记录保留 |
| 4 | 人工核实（editor） | 写入 + verified_by | 清空 | INSERT 双版本记录 |
| 5 | 相关代码变化（spec-drift 命中） | 不动（→ 待重新核实） | 打点 | — |
| 6 | 无关代码变化 | 不动（保持已核实） | 不动 | — |

规则要点（对应基线文档的三条失效/保留规则）：

1. **编辑不清除、不覆盖、不删除核实记录**（转换 3）：历史表 append-only；工作表 `verified_at` 清空只表示「当前内容不再享有该核实」，历史记录仍然完整可查。
2. **stale 与 verification 不可互相推导**（转换 2/4/5）：重新分析清除 stale ≠ 已核实（AI 新内容是未核实）；核实通过也不阻止后续代码变化再次打 stale。转换 3 是对现有代码的唯一语义修正点（`spec-editor-service.ts` 目前编辑即重置 `stale_since = NULL`，实施时移除该重置）。
3. **只有相关变化才失效**（转换 5/6）：复用现有 drift 定位，代码任何变化不触发全量失效。

## 4. API 与 UI 草案

- `POST /api/products/[slug]/spec/verify`：`{ entityType, entityId }`，editor 权限；服务端解析产品当前 spec_version 与 HEAD sha 后写双版本记录。公开 demo 匿名只读，无核实动作。
- 规格页：条目徽章显示三态（未核实 / 已核实 @ 核实人 · commit / 待重新核实）；「标记已核实」按钮仅 editor 可见；可按核实状态筛选。
- 与证据强度分级（[测试]/[文档]）并列展示，互不替代。

## 5. 实施切分（建议 3 个提交）

1. migration（列 + 历史表）+ `spec-editor-service` 移除编辑清 stale + 转换 1/3 的服务端语义，含测试。
2. 核实动作 API + 状态推导查询 + 规格页徽章与筛选，含测试。
3. 基线文档对账更新。

## 6. 决策记录（2026-11-08 实施时落定）

- 条目内容变化检测粒度：采用 **SQL 内容比对**（`summary <> VALUES(summary)` / 场景四字段比对，带 `source = 'generated'` 守卫）——严格优于「AI 输出包含即视为更新」：carry-forward 条目内容相同时天然不清核实，转换 2 无需额外判断；无需内容哈希列。
- 核实不要求附证据核对记录，保持动作轻（按设计默认实施）。

**状态：已实现（2026-11-08）。** migration 028 + `lib/spec-verification.ts`（双版本历史 + 范围校验更新）+ `POST /api/products/[slug]/spec/verify` + 场景卡/功能头核实徽章与动作 + 场景工具栏核实状态筛选；编辑清 stale 语义已移除（`spec-editor-service.ts`）。
