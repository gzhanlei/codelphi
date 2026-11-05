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

const MAX_COMMIT_SUBJECT_TOTAL = 2000;
const MAX_CHANGE_FILES = 120;
const MAX_CHANGE_PATCH_TOTAL = 56_000;

function latestCommit(data: ChangeData) {
  if (!data.commits || data.commits.length === 0) return data.commit;
  return data.commits[data.commits.length - 1].commit;
}

function multiCommitMessage(data: ChangeData) {
  if (!data.commits || data.commits.length <= 1) return null;
  const subjects = data.commits
    .map((entry) => entry.commit.message.split("\n", 1)[0].trim())
    .filter(Boolean);
  if (subjects.length === 0) return null;
  const joined = subjects.join("\n");
  if (joined.length <= MAX_COMMIT_SUBJECT_TOTAL) return joined;
  // Keep the newest subjects within budget so the head of the push is always represented.
  const kept = [subjects[subjects.length - 1].slice(0, MAX_COMMIT_SUBJECT_TOTAL)];
  let length = kept[0].length;
  for (let index = subjects.length - 2; index >= 0; index--) {
    const subject = subjects[index];
    if (length + subject.length + 1 > MAX_COMMIT_SUBJECT_TOTAL) break;
    kept.unshift(subject);
    length += subject.length + 1;
  }
  const omitted = subjects.length - kept.length;
  return `（共 ${subjects.length} 个提交，省略最早的 ${omitted} 条）\n${kept.join("\n")}`;
}

function commitDetails(data: ChangeData, after: string) {
  const commit = latestCommit(data);
  return {
    message: multiCommitMessage(data) ?? commit?.message ?? `Release ${after.slice(0, 7)}`,
    committedAt: commit?.committer?.date ?? new Date().toISOString(),
  };
}

function interleaveByTopDirectory<T extends { filename: string }>(files: T[]) {
  const groups = new Map<string, T[]>();
  for (const file of files) {
    const group = file.filename.includes("/") ? file.filename.split("/")[0] : "";
    const items = groups.get(group);
    if (items) items.push(file);
    else groups.set(group, [file]);
  }
  const balanced: T[] = [];
  let hasRemaining = true;
  while (hasRemaining) {
    hasRemaining = false;
    for (const items of groups.values()) {
      const file = items.shift();
      if (file) {
        balanced.push(file);
        hasRemaining = true;
      }
    }
  }
  return balanced;
}

function budgetedChangeFiles(files: ChangeData["files"]) {
  const selected = interleaveByTopDirectory(files).slice(0, MAX_CHANGE_FILES);
  const perFile = Math.floor(MAX_CHANGE_PATCH_TOTAL / Math.max(selected.length, 1));
  return selected.map((file) => ({
    path: file.filename,
    status: file.status,
    patch: (file.patch ?? "(binary or patch unavailable)").slice(0, perFile),
  }));
}

export function normalizeChangeContext(value: unknown, after: string, fallbackUrl = "") {
  const data = changeSchema.parse(value);
  return {
    ...commitDetails(data, after),
    url: data.html_url ?? fallbackUrl,
    files: budgetedChangeFiles(data.files),
  };
}

const treeSchema = z.object({
  tree: z.array(z.object({
    path: z.string(),
    type: z.string(),
    size: z.number().optional(),
  })).optional().default([]),
});

function isDocumentationPath(path: string) {
  return /(?:^|\/)(?:README|AGENTS|package\.json|go\.mod|openapi)/i.test(path);
}

function pathScore(path: string) {
  if (isDocumentationPath(path)) return "0";
  if (/(?:^|\/)(?:app|src|pages|cmd|internal|docs|migrations)\//.test(path)) return "1";
  return "2";
}

function isSourcePath(path: string) {
  return /\.(?:ts|tsx|js|jsx|go|py|json|md|sql|yaml|yml|css|html|java|c|h|cpp|hpp|xml|gradle|kts)$/.test(path)
    && !/(?:node_modules|dist|\.next|coverage|vendor|package-lock|pnpm-lock|yarn\.lock|\.test\.|\.spec\.)/.test(path)
    && !/(?:^|\/)(?:deps|third_party|\.github)\//.test(path);
}

type TreeEntry = z.infer<typeof treeSchema>["tree"][number];

function sourceGroup(path: string) {
  return path.includes("/") ? path.split("/")[0] : "";
}

function sourceGroupRank(path: string) {
  if (isDocumentationPath(path)) return "0";
  const group = sourceGroup(path);
  if (["app", "src", "pages"].includes(group)) return "1";
  if (["components", "lib", "internal", "cmd"].includes(group)) return "2";
  if (["docs", "migrations", "scripts"].includes(group)) return "3";
  return "4";
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
    .sort((a, b) => pathScore(a.path).localeCompare(pathScore(b.path)) || a.path.localeCompare(b.path));
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
  return groupSourceEntries(entries).map(interleaveEdges).sort((a, b) => {
    const key = (group: TreeEntry[]) => `${sourceGroupRank(group[0].path)}:${group[0].path}`;
    return key(a).localeCompare(key(b));
  });
}

function selectRoundRobin(groups: TreeEntry[][]) {
  const selected: TreeEntry[] = [];
  const queue = groups.map((group) => [...group]);
  while (queue.some((group) => group.length > 0)) {
    for (const group of queue) {
      const entry = group.shift();
      if (!entry) continue;
      selected.push(entry);
    }
  }
  return selected;
}

function isEntryPointPath(path: string) {
  return /^internal\/(?:oauth|db|token)\//.test(path) || /^web\/middleware\.ts$/.test(path) || /^(?:web\/)?app\/.*page\.tsx$/.test(path)
    || /^app\/src\/main\/AndroidManifest\.xml$/.test(path) || /^app\/src\/main\/(?:java|cpp)\//.test(path) || /^uxplay\/lib\/(?:raop|httpd)\.c$/.test(path);
}

function entryPointRank(path: string) {
  if (path === "web/app/page.tsx" || path === "app/src/main/AndroidManifest.xml") return "0";
  if (/^internal\/(?:oauth|db|token)\//.test(path)) return "1";
  if (/^app\/src\/main\/java\/.*(?:Activity|Service)\.java$/.test(path)) return "1";
  if (/^(?:web\/)?app\/.*page\.tsx$/.test(path)) return "2";
  if (/^app\/src\/main\/(?:java|cpp)\//.test(path)) return "2";
  if (/^uxplay\/lib\/(?:raop|httpd)\.c$/.test(path)) return "2";
  return "3";
}

export function selectSourceCandidates(value: unknown) {
  const entries = eligibleSourceEntries(value);
  const prioritized = entries.filter((entry) => isEntryPointPath(entry.path)).sort((a, b) => entryPointRank(a.path).localeCompare(entryPointRank(b.path)) || a.path.localeCompare(b.path));
  const documentation = entries.filter((entry) => !isEntryPointPath(entry.path) && pathScore(entry.path) === "0");
  const remaining = entries.filter((entry) => !isEntryPointPath(entry.path) && pathScore(entry.path) !== "0");
  return [...documentation, ...prioritized, ...selectRoundRobin(orderedSourceGroups(remaining))].slice(0, 48);
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
