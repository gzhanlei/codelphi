import { z } from "zod";
import type { StructuredCompletionMessage } from "../lib/llm-client";

export interface BlindReviewPacket {
  scenario: {
    reference: string;
    context: string;
    action: string;
    outcome: string;
  };
  evidence: Array<{ path: string; startLine: number; content: string }>;
}

export function buildBlindReviewMessages(packet: BlindReviewPacket): StructuredCompletionMessage[] {
  return [
    {
      role: "system",
      content: "你是代码证据复核器。只能依据给定代码判断候选场景，不补充业务背景，不推测运行时已经验证。",
    },
    {
      role: "user",
      content: [
        "判断给定代码是否支持这条候选产品场景：",
        `- support：代码明确支持情境、操作和结果；`,
        `- contradict：代码与候选场景明确矛盾，或它把测试/文档变化误当成产品行为；`,
        `- insufficient：代码不足、只有间接线索，或无法区分具体业务含义。`,
        "只返回 JSON：{\"verdict\":\"support|contradict|insufficient\",\"reason\":\"简短代码依据\"}",
        `候选场景：${JSON.stringify({
          reference: packet.scenario.reference,
          context: packet.scenario.context,
          action: packet.scenario.action,
          outcome: packet.scenario.outcome,
        })}`,
        "证据代码：",
        ...packet.evidence.map((item) => `--- ${item.path}:${item.startLine} ---\n${item.content}`),
      ].join("\n"),
    },
  ];
}

const verdictSchema = z.object({
  verdict: z.enum(["support", "contradict", "insufficient"]),
  reason: z.string().min(1),
});

export function parseReviewVerdict(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Review response did not contain a JSON object");
  return verdictSchema.parse(JSON.parse(trimmed.slice(start, end + 1)));
}
