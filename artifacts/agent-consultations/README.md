# Agent × CoDelphi 咨询日志

本目录记录本地生产试点中，各项目 coding agent 向 CoDelphi 提出的行为问题、回答和后续决策影响。日志只追加，不回改；纠错以新记录补充。

## 记录方式

每个项目对应两个文件：

- `<project>.md`：人工评审用追加式问答记录。
- `<project>.jsonl`：机器分析用结构化记录。

调用：

```bash
npx tsx scripts/log-agent-consultation.ts --file /tmp/consultation.json
```

`consultation.json` 必填：

```json
{
  "project": "project-slug",
  "task": "开发任务",
  "question": "Agent 的原始问题",
  "answer": "CoDelphi 的回答",
  "evidence": ["path/to/file.ts:12-34"],
  "unknowns": ["尚未覆盖或需要裁决的内容"],
  "decisionImpact": "回答改变了哪个开发决策",
  "nextAction": "verify"
}
```

可选：`repository`、`branch`、`sha`、`createdAt`。`nextAction` 只能是 `verify`、`escalate`、`may_proceed`、`none`。项目名只允许字母、数字、点、下划线和连字符，防止路径穿越。

## 记录边界

- 记录原始问题和实际回答，不把事后理想答案伪装成当时回答。
- 记录未知、覆盖限制和产品待裁决，不要求每次都有确定答案。
- 不记录 `.env`、token、用户隐私数据或完整敏感代码内容。
- 不记录普通代码搜索已能直接回答、且没有决策影响的问题。
- 不修改历史记录；发现错误时追加新的更正记录。

## 阶段评审

定期按项目评审：

1. 哪些问题得到满意回答，哪些仍是 unknown。
2. 回答是否改变首份计划、实现或验证。
3. 是否出现未授权默认、过度阻塞或盲信 CoDelphi。
4. 哪些问题反复出现，值得进入 CoDelphi 的知识模型。
5. 完整咨询与裁决成本是否低于避免的返工。

评审结论单独写入新的总结文档，不回写历史问答。
