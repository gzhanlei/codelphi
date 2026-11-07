# 交接说明：carry-forward 需要延伸到工作台层（M9 协调警示）

> 2026-11-07 晚，来自 demo 走查 + I1 根因调查（完整证据链见 `docs/demo-improvement-plan.md` 的 I1 小节）。给正在做「影子对比、增量决策、carry-forward 合并语义」工作区的同学：**你们的版本层合并是对的，不用推翻；但落库层有一个缺口，会让每次窄推送把工作台规格清到只剩本次触及的功能。**

## 一句话结论

`insertSpecVersion` 的 carried 合并只写 `spec_versions` 层；`upsertGeneratedSpec` 拿到的是 AI 原始输出而非合并结果，导致 `features`/`scenarios` 表（工作台 UI 唯一数据源）每次分析后收缩为「本次 AI 输出」，与版本层持续分叉。

## 生产实测（2026-11-07，只读查询）

| 层 | 状态 |
|---|---|
| `spec_versions` 版本层 | 最近 19 个版本功能数稳定 = 14 ✅ |
| `features` 表 `active=1` | **仅 1 个功能**（最新 push f2e138e 触及的「发布通知渠道」）❌ |
| 等价测试 | 最新版本 v55 的 14 个功能中 **13 个仅存在于版本层、工作台不可见** |
| 线上轨迹 | demo 工作台功能数一天内实测 1 → 2 → 14 → 1（13:08 的 run 75 窄推送触发最后一次坍缩） |

影响范围：生产库全部 8 个产品共用此机制，不止 demo。

## 根因（代码定位）

1. `lib/analysis.ts:132`：`upsertGeneratedSpec(connection, run, result)` 传入的是 **AI 原始输出 `result`**（增量模式下只含受影响功能）。
2. `lib/analysis.ts:79-95`：`upsertGeneratedSpec` 把不在 `result.features` 中的 generated 叶子功能 `active=0`，并把产品下全部 generated 场景 `active=0`。
3. 全库唯一的重新激活路径是 `upsertFeature` 的 ON DUPLICATE KEY（`lib/analysis.ts:58、73`），只对 AI 输出中的功能生效——**carried 功能没有任何恢复路径**。
4. 工作台 UI（功能树、概览计数、spec.json、Explainer）全部读 `features.active=1`（`lib/product-details.ts:91`），不读 `spec_versions`。

## 不需要动的部分（已验证正确）

- `resolveAnalysisMode`（`lib/incremental.ts`）：放行判定正常，run 75 窄推送被正确放行为增量。
- `mergeSpecSources` + carried 合并（`lib/spec-versions.ts:161-179`）：版本层 14 稳定即为其正确性的直接证据。
- 影子对比的对比对象语义本身（合并后规格 vs 全量提取）。

## 需要改的

1. **核心修复**：`upsertGeneratedSpec` 的下线基准从「AI 原始输出」改为「`insertSpecVersion` 返回的合并后完整规格」——把 `saveResult` 里 `insertSpecVersion` 的返回值（`lib/analysis.ts:129` 已有 `{ specVersionId, features: mergedFeatures }`）传给 `upsertGeneratedSpec`，carried 功能显式保持 `active=1`。
2. **一次性对账**：修复上线后，以各产品最新 `spec_versions` 的 `spec_features` 回填 `features`/`scenarios` 的 active 状态（当前生产上 13 个「隐身」功能靠它恢复；也可用一次宽触及的重建替代，但对账更可控）。
3. **回归测试**：连续多次小步 push（每次只触及同一模块）后，断言工作台功能数不低于基线；push 触及面由窄变宽后，断言不产生重复功能行。

## 一个容易踩的盲区

**影子对比会掩盖这个缺陷**：`compareIncrementalShadow` 的对比对象是合并后的版本层规格，工作台坍缩不在其观测范围内。当前生产上「影子对比 ≥98% 一致率」与「工作台只剩 1 个功能」**同时成立**——影子一致率不能作为本缺陷的回归信号，必须直接断言 features 表与最新版本层的集合等价。

## 复现 / 验证（只读 SQL，可直接跑）

```sql
-- 两层分叉检测：两侧计数不等即缺陷存在
SELECT
  (SELECT COUNT(*) FROM spec_features WHERE spec_version_id = (SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1)) AS version_features,
  (SELECT COUNT(*) FROM features WHERE product_id = ? AND active = 1) AS workbench_features;
```

按名字做集合等价（不只比数量）更稳妥，脚本见 `docs/demo-improvement-plan.md` I1 小节的验证记录。
