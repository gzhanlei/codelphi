import { z } from "zod";
import { architectureEvidenceSchema } from "./facts";
import { findArchitectureEvidence, isArchitectureSourcePath, type ArchitectureSource } from "./source";

export const architectureSignalKindSchema = z.enum(["entrypoint", "deployable", "worker", "store", "external", "relationship"]);
export const architectureSignalSchema = z.object({
  id: z.string().min(1),
  kind: architectureSignalKindSchema,
  critical: z.boolean(),
  evidence: architectureEvidenceSchema,
}).strict();

const baseInventorySchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  scope: z.enum(["repository", "source-slice"]),
  signals: z.array(architectureSignalSchema),
}).strict();

export const architectureSignalInventorySchema = baseInventorySchema.superRefine((value, context) => {
  const ids = value.signals.map((signal) => signal.id);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    context.addIssue({ code: "custom", message: `Duplicate architecture signal: ${id}` });
  }
});

export type ArchitectureSignal = z.infer<typeof architectureSignalSchema>;
export type ArchitectureSignalInventory = z.infer<typeof baseInventorySchema>;
export type ArchitectureSignalKind = ArchitectureSignal["kind"];

interface SignalRule {
  kind: ArchitectureSignalKind;
  detector: string;
  path: RegExp;
  markers: string[];
}

const signalRules: SignalRule[] = [
  { kind: "entrypoint", detector: "source-entrypoint", path: /(?:^|\/)app\/.*(?:page|route)\.tsx?$|(?:^|\/)pages\/index\.tsx$|(?:^|\/)cmd\/.*\/main\.go$|(?:^|\/)main\.go$|(?:^|\/)index\.php$|(?:^|\/)app\.json$|(?:Activity)\.(?:java|kt)$/, markers: [] },
  { kind: "deployable", detector: "process-entrypoint", path: /(?:^|\/)main\.go$|(?:^|\/)package\.json$/, markers: ["func main", "\"next\"", "\"start\""] },
  { kind: "worker", detector: "next-after-worker", path: /(?:^|\/)app\/api\/.*route\.ts$/, markers: ["after("] },
  { kind: "worker", detector: "async-worker", path: /worker|job|cron|scheduler|analysis/i, markers: ["func main", "cron", "NewRunner"] },
  { kind: "worker", detector: "async-worker", path: /(?:^|\/)(?:workers?|jobs?|cron|scheduler)(?:\/|\.)/i, markers: ["setInterval"] },
  { kind: "store", detector: "storage-usage", path: /./, markers: ["mysql2", "sql.Open", "database/sql", "new PDO", "RoomDatabase", "file_get_contents", "file_put_contents", "CREATE TABLE", "gorm.Open", "SQLAlchemy"] },
  { kind: "external", detector: "external-sdk", path: /./, markers: ["api.github.com", "chat/completions", "NewQCloudClient", "cos.tencentcloudapi.com", "requestVirtualPayment", "Code2Session", ".CreateTask(", "OpenAI", "ImgSecCheck(", "deliverArchify", "visualCheckArchify"] },
  { kind: "relationship", detector: "miniprogram-api-call", path: /\.js$/i, markers: ["wx.cloud.callContainer"] },
];

function matchingLine(source: ArchitectureSource, rule: SignalRule) {
  if (!rule.path.test(source.path)) return undefined;
  return findArchitectureEvidence(source, rule.markers, rule.detector);
}

export function collectArchitectureSignals(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: ArchitectureSource[]): ArchitectureSignalInventory {
  const signals = [...sources].filter((source) => isArchitectureSourcePath(source.path)).sort((a, b) => a.path.localeCompare(b.path)).flatMap((source) => signalRules.flatMap((rule) => {
    const evidence = matchingLine(source, rule);
    if (!evidence) return [];
    return [{ id: `${rule.kind}:${source.path}:${evidence.line}:${rule.detector}`, kind: rule.kind, critical: true, evidence }];
  }));
  return architectureSignalInventorySchema.parse({ version: 1, ...input, signals: signals.sort((a, b) => a.id.localeCompare(b.id)) });
}
