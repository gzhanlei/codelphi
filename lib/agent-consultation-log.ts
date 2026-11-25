import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const consultationRecordSchema = z.object({
  project: z.string().trim().min(1).regex(/^[A-Za-z0-9._-]+$/, "project must be a safe artifact filename"),
  repository: z.string().trim().max(200).optional(),
  branch: z.string().trim().max(200).optional(),
  sha: z.string().trim().max(80).optional(),
  task: z.string().trim().min(1).max(500),
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).default([]),
  unknowns: z.array(z.string().trim().min(1)).default([]),
  decisionImpact: z.string().trim().max(2000).optional(),
  nextAction: z.enum(["verify", "escalate", "may_proceed", "none"]).default("none"),
  createdAt: z.string().datetime().optional(),
});

export type AgentConsultationRecord = z.output<typeof consultationRecordSchema> & { createdAt: string };

export function parseConsultationRecord(value: unknown) {
  return consultationRecordSchema.parse(value) as Omit<AgentConsultationRecord, "createdAt"> & Partial<Pick<AgentConsultationRecord, "createdAt">>;
}

export function formatConsultationRecord(record: AgentConsultationRecord) {
  const lines = [
    `## ${record.createdAt} · ${record.project}`,
    "",
    `- task: ${record.task}`,
    ...(record.repository ? [`- repository: ${record.repository}`] : []),
    ...(record.branch ? [`- branch: ${record.branch}`] : []),
    ...(record.sha ? [`- sha: ${record.sha}`] : []),
    `- question: ${record.question}`,
    `- answer: ${record.answer}`,
  ];
  if (record.evidence.length > 0) lines.push(`- evidence: ${record.evidence.join("；")}`);
  if (record.unknowns.length > 0) lines.push(`- unknowns: ${record.unknowns.join("；")}`);
  if (record.decisionImpact) lines.push(`- decisionImpact: ${record.decisionImpact}`);
  lines.push(`- nextAction: ${record.nextAction}`, "");
  return `${lines.join("\n")}\n`;
}

export async function appendConsultation(root: string, input: unknown) {
  const parsed = parseConsultationRecord(input);
  const record = { ...parsed, createdAt: parsed.createdAt ?? new Date().toISOString() } as AgentConsultationRecord;
  const directory = join(root, "artifacts", "agent-consultations");
  const markdownPath = join(directory, `${record.project}.md`);
  const jsonlPath = join(directory, `${record.project}.jsonl`);
  const text = formatConsultationRecord(record);
  await mkdir(directory, { recursive: true });
  await appendFile(markdownPath, text, "utf8");
  await appendFile(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
  return text;
}
