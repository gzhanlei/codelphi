import { z } from "zod";

const changeSchema = z.object({
  html_url: z.string().optional(),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.string().optional() }).optional(),
  }).optional(),
  commits: z.array(z.object({
    sha: z.string(),
    commit: z.object({
      message: z.string(),
      committer: z.object({ date: z.string().optional() }).optional(),
    }),
  })).optional(),
  files: z.array(z.object({
    filename: z.string(),
    status: z.string(),
    patch: z.string().optional(),
  })).optional().default([]),
});

type ChangeData = z.infer<typeof changeSchema>;

function latestCommit(data: ChangeData) {
  if (!data.commits || data.commits.length === 0) return data.commit;
  return data.commits[data.commits.length - 1].commit;
}

function commitDetails(data: ChangeData, after: string) {
  const commit = latestCommit(data);
  return {
    message: commit?.message ?? `Release ${after.slice(0, 7)}`,
    committedAt: commit?.committer?.date ?? new Date().toISOString(),
  };
}

export function normalizeChangeContext(value: unknown, after: string, fallbackUrl = "") {
  const data = changeSchema.parse(value);
  const files = data.files.slice(0, 80).map((file) => ({
    path: file.filename,
    status: file.status,
    patch: (file.patch ?? "(binary or patch unavailable)").slice(0, 8_000),
  }));
  return {
    ...commitDetails(data, after),
    url: data.html_url ?? fallbackUrl,
    files,
  };
}

const treeSchema = z.object({
  tree: z.array(z.object({
    path: z.string(),
    type: z.string(),
    size: z.number().optional(),
  })).optional().default([]),
});

function pathScore(path: string) {
  if (/(?:^|\/)(?:README|AGENTS|package\.json|go\.mod|openapi)/i.test(path)) return 0;
  if (/(?:^|\/)(?:app|src|pages|cmd|internal|docs|migrations)\//.test(path)) return 1;
  return 2;
}

function isSourcePath(path: string) {
  return /\.(?:ts|tsx|js|jsx|go|py|json|md|sql|yaml|yml|css|html)$/.test(path)
    && !/(?:node_modules|dist|\.next|coverage|vendor|package-lock|pnpm-lock|yarn\.lock|\.test\.|\.spec\.)/.test(path);
}

type TreeEntry = z.infer<typeof treeSchema>["tree"][number];

function sourceGroup(path: string) {
  return path.includes("/") ? path.split("/")[0] : "";
}

function sourceGroupRank(path: string) {
  if (pathScore(path) === 0) return 0;
  const group = sourceGroup(path);
  if (["app", "src", "pages"].includes(group)) return 1;
  if (["components", "lib", "internal", "cmd"].includes(group)) return 2;
  if (["docs", "migrations", "scripts"].includes(group)) return 3;
  return 4;
}

function interleaveEdges(entries: TreeEntry[]) {
  return entries.map((_, index) => {
    const sourceIndex = index % 2 === 0 ? index / 2 : entries.length - Math.ceil(index / 2);
    return entries[sourceIndex];
  });
}

function eligibleSourceEntries(value: unknown) {
  return treeSchema.parse(value).tree
    .filter((entry) => entry.type === "blob" && (entry.size === undefined || entry.size <= 80_000) && isSourcePath(entry.path))
    .sort((a, b) => pathScore(a.path) - pathScore(b.path) || a.path.localeCompare(b.path));
}

function groupSourceEntries(entries: TreeEntry[]) {
  const grouped = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const group = sourceGroup(entry.path);
    const items = grouped.get(group);
    if (items) {
      items.push(entry);
    } else {
      grouped.set(group, [entry]);
    }
  }
  return [...grouped.values()];
}

function orderedSourceGroups(entries: TreeEntry[]) {
  return groupSourceEntries(entries).map(interleaveEdges).sort((a, b) => sourceGroupRank(a[0].path) - sourceGroupRank(b[0].path) || a[0].path.localeCompare(b[0].path));
}

function selectRoundRobin(groups: TreeEntry[][]) {
  const selected: TreeEntry[] = [];
  for (let index = 0; selected.length < 48; index += 1) {
    let added = false;
    for (const group of groups) {
      const entry = group[index];
      if (!entry) continue;
      selected.push(entry);
      added = true;
      if (selected.length === 48) break;
    }
    if (!added) break;
  }
  return selected;
}

export function selectSourceCandidates(value: unknown) {
  return selectRoundRobin(orderedSourceGroups(eligibleSourceEntries(value)));
}

const contentSchema = z.object({
  content: z.string().optional(),
  encoding: z.string().optional(),
});

export function numberedSourceContent(value: unknown, maxLength: number) {
  const data = contentSchema.parse(value);
  if (!data.content || data.encoding !== "base64") return null;
  const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  return content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n").slice(0, maxLength);
}
