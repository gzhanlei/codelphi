# 行为账本 Golden Validation v1.1：纯重构运行时验收

日期：2026-11-23

## 范围

- 契约：`docs/superpowers/specs/2026-11-23-behavior-ledger-correctness-golden-validation-v1.md`
- 被验代码：`ac0f1a0 fix: verify no-change ledger and evidence`
- 案例：`214cd96571f10fe9bd1d708e80dab716a2b241ff` → `d96ae8e36f7b177f1659b2795be69e137de75d49`
- 提交意图：纯重构，`expectNoChange=true`
- Truth Card：`.worktrees/mcp-validation-refactor/.superpowers/mcp-validation-refactor/TRUTH-CARD.md`，在查看该提交的 CoDelphi 输出前冻结
- 既有独立验收：`.worktrees/mcp-validation-refactor/.superpowers/mcp-validation-refactor/REPORT.md`

本次只读验收使用保留的 scratch 数据库 `codelphi_bench_mcp_refactor`，不读取或写入生产账本，不重新运行模型分析，不修改 Truth Card。MCP 调用走当前工作树的 `handleMcpRpc`；afterSha 证据通过本地 Git 对象精确读取。

## 输入

| 字段 | 值 |
| --- | --- |
| Product | `refactor-bench` |
| Release | `2` |
| Spec version | `2` |
| Analysis run | `3` |
| afterSha | `d96ae8e36f7b177f1659b2795be69e137de75d49` |
| 功能 / 场景 / 证据 | 13 / 59 / 70 |
| 既有非 wording-only Delta | 0 |

调用：

```text
reconcile_release(slug="refactor-bench", releaseId=2, expectNoChange=true)
```

## 原始结果

```json
{
  "releaseId": 2,
  "slug": "refactor-bench",
  "sha": "d96ae8e36f7b177f1659b2795be69e137de75d49",
  "analysis": {
    "status": "complete",
    "runId": 3,
    "error": null
  },
  "evidenceComplete": true,
  "noChangeStatus": "verified_no_change",
  "noChangeVerification": {
    "verified": true,
    "identityPreserved": true,
    "semanticsUnchanged": true,
    "conflictFree": true,
    "evidenceComplete": true,
    "evidenceTotal": 70,
    "evidenceVerified": 70,
    "reasons": []
  },
  "intentResults": [],
  "missingExpected": [],
  "unexpected": [],
  "duplicateClusters": [],
  "sharedEvidenceWarnings": [],
  "verdict": "pass",
  "reasons": []
}
```

## 验收结论

该固定纯重构 fixture **通过**：

- 前后 Behavior / Scenario 身份集合保持，59 个场景未丢失或重建。
- 前后行为语义无 Delta；`missingExpected` 与 `unexpected` 均为空。
- 当前账本未检出显示/隐藏冲突。
- afterSha 的 70 条证据均具有有效行锚，70/70 完整行范围实际读取成功。
- `expectNoChange` 不再要求未变功能的 stableKey 出现在变化清单中，因此不再产生此前的错误 `identity_not_found`。

证据内容对场景语义的支持关系来自既有 Truth Card 与人工复核报告；本次新增门禁验证的是身份、规格语义、冲突和 afterSha 证据行范围的可读性，不把“行存在”单独宣称为人工语义审核。

## 边界

- 这是指定 fixture 的严格验收，不代表全仓行为覆盖率，也不代表其他新增、修改、删除案例已经通过。
- 生产账本没有该提交的 release：此前 run 425 被 run 427 supersede。本结果证明 scratch 中保留的真实分析结果可以通过新门禁，不证明生产 Release 完整性问题已修复。
- 未进行生产部署，未修改生产数据。
