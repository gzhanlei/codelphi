import { z } from "zod";
import { architectureEvidenceSchema, type ArchitectureEvidence } from "./facts";

export const architectureSignalKindSchema = z.enum(["entrypoint", "deployable", "worker", "store", "external"]);
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
  { kind: "worker", detector: "async-worker", path: /worker|job|cron|scheduler|analysis/i, markers: ["func main", "after(", "setInterval", "cron", "NewRunner", "Worker"] },
  { kind: "store", detector: "storage-usage", path: /./, markers: ["mysql2", "sql.Open", "database/sql", "new PDO", "RoomDatabase", "file_get_contents", "file_put_contents", "CREATE TABLE", "gorm.Open", "SQLAlchemy"] },
  { kind: "external", detector: "external-sdk", path: /./, markers: ["api.github.com", "chat/completions", "NewQCloudClient", "cos.tencentcloudapi.com", "requestVirtualPayment", "Code2Session", "CreateTask", "OpenAI", "imgSecCheck"] },
];

interface SourceContent {
  path: string;
  content: string;
}

function numberedLine(line: string, index: number) {
  const match = line.match(/^\s*(\d+):\s?/);
  return match ? Number(match[1]) : index + 1;
}

function matchingLine(source: SourceContent, rule: SignalRule): ArchitectureEvidence | undefined {
  if (!rule.path.test(source.path)) return undefined;
  const index = source.content.split("\n").findIndex((line) => rule.markers.length === 0 || rule.markers.some((marker) => line.toLowerCase().includes(marker.toLowerCase())));
  if (index < 0) return undefined;
  return { path: source.path, line: numberedLine(source.content.split("\n")[index], index), detector: rule.detector };
}

export function collectArchitectureSignals(input: Pick<ArchitectureSignalInventory, "revision" | "scope">, sources: SourceContent[]): ArchitectureSignalInventory {
  const signals = [...sources].sort((a, b) => a.path.localeCompare(b.path)).flatMap((source) => signalRules.flatMap((rule) => {
    const evidence = matchingLine(source, rule);
    if (!evidence) return [];
    return [{ id: `${rule.kind}:${source.path}:${evidence.line}:${rule.detector}`, kind: rule.kind, critical: true, evidence }];
  }));
  return architectureSignalInventorySchema.parse({ version: 1, ...input, signals: signals.sort((a, b) => a.id.localeCompare(b.id)) });
}
