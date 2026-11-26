/**
 * 隐私扫描在真实模型输出上的误拦率（修订稿 §4.2「在真实输出上会误拦多少」）。
 *
 * 读一份雷达快照，用快照自带的源码摘录建索引（原型也是这么做的，数字可以对照），扫它的全部文本字段，
 * 按规则报命中数，并列出每一条命中，好逐条归成「真泄漏」还是「误拦」。
 * 这个数偏小：正式发布时用的是全部源码，不只是摘录里的行。
 *
 * 用法（在仓库根目录）：
 *   npx tsx scripts/measure-privacy-scan.ts <snapshot.json> [--show 40]
 */
import { readFileSync } from "node:fs";
import { createSourceIndex, type PrivacyHit, type PrivacyRule, PRIVACY_RULES, type SourceText, scanValue } from "../lib/privacy-scan";

interface Snapshot {
  product?: { name?: string; description?: string };
  features?: Array<{ name: string; summary: string; scenarios?: Array<Record<string, unknown>> }>;
  evidenceSnippets?: Array<{ path: string; lines?: Array<{ text?: string }> }>;
  presentation?: unknown;
}

/** 载荷里每个字符串值和它的路径，按扫描时遍历的顺序。 */
function textFields(value: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return value.trim() ? [{ path, text: value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => textFields(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => textFields(item, path === "" ? key : `${path}.${key}`));
  return [];
}

function parseArgs(argv: readonly string[]): { file: string; show: number } {
  const options = { file: "", show: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--show") options.show = Number(argv[++index]);
    else if (!options.file) options.file = argv[index];
    else throw new Error(`用法：<snapshot.json> [--show <条数>]；不认识「${argv[index]}」`);
  }
  if (!options.file) throw new Error("用法：<snapshot.json> [--show <条数>]");
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(readFileSync(options.file, "utf8")) as Snapshot;
  const source: SourceText[] = (snapshot.evidenceSnippets ?? []).map((snippet) => ({ path: snippet.path, text: (snippet.lines ?? []).map((line) => line.text ?? "").join("\n") }));
  const index = createSourceIndex(source);
  const payload = {
    product: snapshot.product,
    features: (snapshot.features ?? []).map((feature) => ({ name: feature.name, summary: feature.summary, scenarios: feature.scenarios })),
    presentation: snapshot.presentation,
  };
  const fields = textFields(payload);
  const hits = scanValue(payload, index);
  const byRule = Object.fromEntries(PRIVACY_RULES.map((rule) => [rule, hits.filter((hit) => hit.rule === rule).length])) as Record<PrivacyRule, number>;
  const hitFields = new Set(hits.map((hit) => `${hit.path}`)).size;
  console.log(
    `样本：${(snapshot.features ?? []).length} 个功能、${(snapshot.features ?? []).reduce((total, feature) => total + (feature.scenarios?.length ?? 0), 0)} 条场景；` +
      `索引：${source.length} 段摘录、${source.reduce((total, file) => total + file.text.split("\n").length, 0)} 行、${index.lines.size ? [...index.lines.values()].reduce((total, entries) => total + entries.length, 0) : 0} 条够长的行、${index.fragments.size} 个片段窗口；` +
      `文本字段 ${fields.length} 个，命中的字段 ${hitFields} 个（${((100 * hitFields) / Math.max(fields.length, 1)).toFixed(3)}%）`,
  );
  for (const rule of PRIVACY_RULES) console.log(`  ${rule}: ${byRule[rule]}`);
  const textOf = (hit: PrivacyHit) => fields.find((field) => field.path === hit.path)?.text.split(/\r?\n/)[hit.line - 1] ?? "";
  for (const hit of hits.slice(0, options.show)) console.log(`  [${hit.rule}] ${hit.path}:${hit.line}${hit.sourcePath ? ` ← ${hit.sourcePath}` : ""}\n      ${textOf(hit).slice(0, 160)}`);
}

if (process.argv[1]?.endsWith("measure-privacy-scan.ts")) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
