import { evidenceKind } from "./evidence";
import { crossLanguageText, hasCjk, negationCountOf } from "./text-script";
import type { Evidence } from "./types";

export interface SpecScenario {
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  /** W-DECISION 最小序列版：主步骤链序号（happy）/分支归属步骤（edge/error）。
   *  判定面裁决：不参与 scenarioBehaviorChanged / scenarioBehaviorEqual——顺序抖动不虚报
   *  （docs/w-decision-scenario-sequence-plan.md §2），但 before/after 序列化如实记录。 */
  step?: number | null;
  evidence: Evidence[];
  source?: "generated" | "manual";
}

export interface SpecFeature {
  name: string;
  summary: string;
  parentKey?: string | null;
  scenarios: SpecScenario[];
  source?: "generated" | "manual";
}

export interface SpecChange {
  kind: "added" | "changed" | "removed";
  entityType: "feature" | "scenario";
  featureName: string;
  scenarioReference: string | null;
  summary: string;
  before: SpecFeature | SpecScenario | null;
  after: SpecFeature | SpecScenario | null;
}

/** 被等价判定折叠的差异：wording=行为等价但原文不同；renumber=同功能内场景换编号；tests-only=新增功能的证据全部来自测试/文档（行为性证据不足）。仅供审计展示，不落库。 */
export interface FoldedSpecChange {
  reason: "wording" | "renumber" | "tests-only" | "variant";
  entityType: "feature" | "scenario";
  featureName: string;
  scenarioReference: string | null;
  before: SpecFeature | SpecScenario | null;
  after: SpecFeature | SpecScenario | null;
}

export function specFeatureKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 规格文本归一化：NFKC（全半角/标点宽度）+ 空白折叠。仅用于变化判定，不改写落库文本。 */
export function normalizeSpecText(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 比较用内容串：去掉空白与标点、英文折叠大小写，只留承载语义的字符（比较用途，不影响落库）。 */
function specContent(text: string) {
  return normalizeSpecText(text).toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function tokenSignature(text: string) {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => match[0]).sort().join(",");
}

function negationCount(text: string) {
  return negationCountOf(text);
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftChar] of [...left].entries()) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;
    for (const [rightIndex, rightChar] of [...right].entries()) {
      const above = previous[rightIndex + 1];
      previous[rightIndex + 1] = Math.min(above + 1, previous[rightIndex] + 1, diagonal + (leftChar === rightChar ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * 规格文本等价判定：全量重建时 LLM 的措辞漂移（同义改写、标点/空白/全半角差异）不应被计为行为变化。
 * 保守设计（同 spec-rename 的 C-lite 哲学），三重守护，任一不过即视为行为变化：
 * 1. 数字与英文词 token 必须完全一致——「返回 404」≠「返回 400」、「邀请 A」≠「邀请 B」；
 * 2. 否定词（不/无/没/未/非…）计数必须一致——「可以重试」≠「不可以重试」；
 * 3. 长度归一化编辑距离：短文本（<10 字）阈值 0.85、其余 0.8——「返回列表」→「返回空列表」
 *    （0.8 < 0.85）不被折叠，而「…当前产品」→「…该产品」（0.83，12 字）被折叠。
 * 真实中文行为变化通常替换关键字符（成功→失败 0.5、允许→禁止 0.33），远低于阈值。
 */

/**
 * BM-5 内容词 Jaccard 近似通道（编辑距离的补充）：同义替换（检测场景→检测内容→检测
 * 情形→检查）改变大量字符使编辑距离失效，但**内容词**几乎不变。去停用词后按 2-gram
 * 计 Jaccard，≥ 阈值视为近似。确定性、零模型调用。
 */
const CONTENT_STOP_GRAMS = new Set(["一项", "用户", "该功", "功能", "对应", "查看", "新增", "更新", "使用", "可以", "进行", "相关", "情况", "结果", "随之", "变化", "不再", "包含", "原先", "涉及", "部分", "同时", "相应"]);

function contentGrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const chunk of normalizeSpecText(text).split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
    // 纯英文段按词取 token（字符 2-gram 对英文近似文本区分度不足）；中文与混合段保持 2-gram。
    if (/^[A-Za-z]+$/.test(chunk)) {
      grams.add(chunk.toLowerCase());
      continue;
    }
    for (let index = 0; index + 2 <= chunk.length; index += 1) {
      const gram = chunk.slice(index, index + 2);
      if (CONTENT_STOP_GRAMS.has(gram)) continue;
      grams.add(gram);
    }
  }
  return grams;
}

export function contentJaccard(left: string, right: string): number {
  const a = contentGrams(left);
  const b = contentGrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/** 包含率：交集占较小一方 gram 集的比例（短变体 ⊂ 长变体的改写形态检测用）。 */
export function contentContainment(left: string, right: string): number {
  const a = contentGrams(left);
  const b = contentGrams(right);
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return 0;
  const [smallerSet, largerSet] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const gram of smallerSet) if (largerSet.has(gram)) intersection += 1;
  return intersection / smaller;
}

export function specTextEquivalent(before: string, after: string) {
  // 跨语种（单侧含 CJK）一律判不等：语言切换 run 的旧语种文本不得被英文新文本折叠。
  if (crossLanguageText(before, after)) return false;
  const left = specContent(before);
  const right = specContent(after);
  if (left === right) return true;
  if (left === "" || right === "") return false;
  // token 签名在保留空格的归一文本上取词：英文去空格后整段成 blob，词级比较失效。
  if (tokenSignature(normalizeSpecText(before).toLowerCase()) !== tokenSignature(normalizeSpecText(after).toLowerCase())) return false;
  if (negationCountOf(before) !== negationCountOf(after)) return false;
  const distance = editDistance(left, right);
  const longest = Math.max(left.length, right.length);
  const similarity = 1 - distance / longest;
  return similarity >= (longest < 10 ? 0.85 : 0.8);
}

function featureBehaviorChanged(before: SpecFeature, after: SpecFeature) {
  // parentKey 必须 ?? null 归一化：AI 输出的树上字段缺失是 undefined，落库/回放树上是 null，
  // 严格 !== 会把 null !== undefined 判成身份变化——superset 盲评 12/13 误报即此一处比较。
  return before.name !== after.name
    || (before.parentKey ?? null) !== (after.parentKey ?? null)
    || !specTextEquivalent(before.summary, after.summary);
}

function scenarioBehaviorChanged(before: SpecScenario, after: SpecScenario) {
  return before.category !== after.category
    || !specTextEquivalent(before.context, after.context)
    || !specTextEquivalent(before.action, after.action)
    || !specTextEquivalent(before.outcome, after.outcome);
}

function scenarioMap(feature: SpecFeature) {
  return new Map(feature.scenarios.map((scenario) => [scenario.reference, scenario]));
}

function mergedSortedKeys(left: Map<string, unknown>, right: Map<string, unknown>) {
  return [...new Set([...left.keys(), ...right.keys()])].sort();
}

function changeSummary(kind: SpecChange["kind"], entityType: SpecChange["entityType"], featureName: string, reference: string | null, language: "zh-CN" | "en" = "zh-CN") {
  if (language === "en") {
    const action = { added: "Added", changed: "Updated", removed: "Removed" }[kind];
    return entityType === "feature" ? `${action} feature "${featureName}"` : `"${featureName}" ${action.toLowerCase()} scenario ${reference}`;
  }
  const action = { added: "新增", changed: "更新", removed: "移除" }[kind];
  return entityType === "feature" ? `${action}功能「${featureName}」` : `「${featureName}」${action}场景 ${reference}`;
}

function featureChange(kind: "added" | "removed" | "changed", feature: SpecFeature, before: SpecFeature | null, after: SpecFeature | null, language?: "zh-CN" | "en"): SpecChange {
  return { kind, entityType: "feature", featureName: feature.name, scenarioReference: null, summary: changeSummary(kind, "feature", feature.name, null, language), before, after };
}


export function scenarioSkeletonEquivalent(left: string, right: string, featureName: string): boolean {
  const stripFeature = (text: string) => normalizeSpecText(text).replace(normalizeSpecText(featureName), "");
  const a = contentGrams(stripFeature(left));
  const b = contentGrams(stripFeature(right));
  if (a.size === 0 || b.size === 0) return false;
  for (const gram of a) if (b.has(gram)) return true;
  return false;
}

export function scenarioBehaviorEqual(previous: SpecScenario, current: SpecScenario) {
  // BM-5（benchmark bm1-incremental-blind-eval §3 F3）：同一触发/操作/结果即同一行为，
  // category（happy/edge/error）是呈现标签——同文重复被标成不同 category（run 64：
  // SQL 编辑器 ER-1=error 与 EC-5=edge 逐字同文并存）不构成新场景，等价时保留先到者。
  return specTextEquivalent(previous.context, current.context)
    && specTextEquivalent(previous.action, current.action)
    && specTextEquivalent(previous.outcome, current.outcome);
}

/**
 * BM-6 变体通道（确定性、零模型调用）：同功能内措辞改写但语义相同的场景对。
 * 与 specTextEquivalent（编辑距离，抓字符级漂移）互补——同义替换（检测→检查、
 * 演示访客→demo 访客）编辑距离失效但内容词 2-gram 几乎不变。判定（宁漏勿错合）：
 * 1. category 一致（happy/error 语义冲突直接拒绝）；
 * 2. 操作/结果：数字 token 一致（404≠400）、双方英文词有交集、否定词计数一致、
 *    长字段（≥8 内容字符）单字段 Jaccard ≥ 0.34——结果被大段改写即拒绝；
 * 3. 情境：只过第 2 条的前三项轻守护，不做 Jaccard 下限——真变体的情境常被同义
 *    改写（「编辑者打开产品总览页」→「工作区编辑者在总览页且存在可发布功能」
 *    实测 0.190），下限会把它们全部误拒；
 * 4. 操作与结果都行为等价（specTextEquivalent）→ 直接判同：同一触发语义+同一操作
 *    +同一结果即同一行为（BM-5 口径的变体延伸），情境措辞漂移不构成新行为；
 * 5. 其余对走合并文本（情境+操作+结果）contentJaccard ≥ 0.5 兜底（骨架词教训：
 *    any-overlap 实证误合真差异；真差异对实测 ≈0.33，余量一倍以上）。
 * 已知残余风险：同操作同结果、仅情境主体语义互换的对（只读↔编辑）会被折——此类
 * 折叠进审计面（folded 可见）不删数据，宁漏勿错合口径下可接受。
 */
const VARIANT_JACCARD_THRESHOLD = 0.5;
const VARIANT_FIELD_JACCARD_FLOOR = 0.34;
const VARIANT_FIELD_MIN_CHARS = 8;

function latinTokens(text: string): Set<string> {
  // 显式 spread：迭代器 helpers（iterator.map）要 Node 22+，生产容器更旧
  return new Set([...text.toLowerCase().matchAll(/[a-z]+/g)].map((match) => match[0]));
}

function digitSignature(text: string): string {
  return [...text.matchAll(/[0-9]+/g)].map((match) => match[0]).sort().join(",");
}

function variantFieldGate(left: string, right: string, strictJaccard: boolean): boolean {
  // 跨语种直接拒绝：不同语种的字段不可能描述同一变体（语言切换 run 的旧↔新对）。
  if (crossLanguageText(left, right)) return false;
  const l = specContent(left);
  const r = specContent(right);
  if (l === r) return true;
  if (digitSignature(l) !== digitSignature(r)) return false;
  // 英文词交集在保留空格的归一文本上取词（去空格 blob 会吞掉词边界）。
  const lLatin = latinTokens(normalizeSpecText(left));
  const rLatin = latinTokens(normalizeSpecText(right));
  if (lLatin.size > 0 && rLatin.size > 0 && ![...lLatin].some((token) => rLatin.has(token))) return false;
  if (negationCountOf(left) !== negationCountOf(right)) return false;
  if (strictJaccard && l.length >= VARIANT_FIELD_MIN_CHARS && r.length >= VARIANT_FIELD_MIN_CHARS && contentJaccard(left, right) < VARIANT_FIELD_JACCARD_FLOOR) return false;
  return true;
}

/** 变体判定（合并去重与跨版本折叠共用）：情境轻守护、操作/结果严守护、操作+结果等价即同行为、其余合并文本兜底。 */
export function scenarioVariantSimilar(previous: SpecScenario, current: SpecScenario): boolean {
  if (previous.category !== current.category) return false;
  if (!variantFieldGate(previous.context, current.context, false)) return false;
  if (!variantFieldGate(previous.action, current.action, true)) return false;
  if (!variantFieldGate(previous.outcome, current.outcome, true)) return false;
  if (specTextEquivalent(previous.action, current.action) && specTextEquivalent(previous.outcome, current.outcome)) return true;
  // 合并兜底串：纯英文对用空格拼接（无分隔会把 "Editor"+"Publishes" 粘成跨词 blob）；
  // 中文与混合文本保持原拼接（字节路径不变，跨字段 2-gram 既有口径不动）。
  const separator = hasCjk(`${previous.context}${previous.action}${previous.outcome}`) ? "" : " ";
  const previousCombined = `${previous.context}${separator}${previous.action}${separator}${previous.outcome}`;
  const currentCombined = `${current.context}${separator}${current.action}${separator}${current.outcome}`;
  return contentJaccard(previousCombined, currentCombined) >= VARIANT_JACCARD_THRESHOLD;
}

/**
 * 历史 changes 行 dry-run 诊断用：旧管线的 changes 清单按分区各自产出，
 * 同一行为变化的描述被逐分区措辞改写（release 225 实证：「分析完整性账本」partial 披露
 * 被写成 7 个变体全量落 changes 表）。新管线的用户变化从 spec_changes 统一投影，不调用此判定。
 * 判定在守护（跨语种
 * 拒绝、数字签名一致 0.01≠0.02、否定计数一致）之外走 **term 词集**（latin run ≥5 字符
 * 按标识符词、CJK 按 2-gram；短 latin 词忽略——技术描述的区分度在标识符与中文关键词，
 * 字符 2-gram 被子句重排稀释，真变体对实测仅 0.20-0.39）：
 * - termJaccard ≥ 0.3（长度对称的改写）；
 * - 或共享标识符词 ≥2 且包含率 ≥ 0.4（长短不对称：长版多一从句，Jaccard 被并集稀释）。
 * 实测分界干净：真变体对 0.231-0.417 全折；真差异对（onStats 独立条目 anchors=1、
 * 跨功能条目 anchors≤1、数字/跨语种陷阱）全拒。
 */
const CHANGE_TERM_JACCARD_THRESHOLD = 0.3;
const CHANGE_ANCHOR_MIN = 2;
const CHANGE_CONTAINMENT_THRESHOLD = 0.4;

export function changeTermGrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const chunk of normalizeSpecText(text).split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)) {
    const runs = chunk.match(/[A-Za-z0-9]+|[\u4e00-\u9fa5]+/g) ?? [];
    for (const run of runs) {
      if (/^[A-Za-z0-9]+$/.test(run)) {
        if (run.length >= 5) grams.add(run.toLowerCase());
        continue;
      }
      for (let index = 0; index + 2 <= run.length; index += 1) grams.add(run.slice(index, index + 2));
    }
  }
  return grams;
}

export function changeDescriptionVariantSimilar(left: string, right: string): boolean {
  if (crossLanguageText(left, right)) return false;
  const l = specContent(left);
  const r = specContent(right);
  if (l === r) return true;
  if (l === "" || r === "") return false;
  // 数字守护：单位数 token（「大于 0」「≥1 对」「5 个」）是措辞噪声，直接剔除；多位 token
  // （404/400/0.34/226）在**双侧都有且集合完全不相交**时才否决——release 228 实证：描述
  // 正文引用「404≠400」作例子会让对侧（无此例子）被签名差误杀；一侧单方提及多位数只是
  // 示例引用，交给词集相似度裁决。已知残余：删 3 条↔删 7 条这类计数差异失去守护（单位数
  // 被剔除），此类行通常伴随其他措辞差异，接受。
  const multiDigitTokens = (text: string) => new Set([...text.matchAll(/[0-9]+/g)].filter((match) => match[0].length >= 2).map((match) => match[0]));
  const leftDigits = multiDigitTokens(l);
  const rightDigits = multiDigitTokens(r);
  if (leftDigits.size > 0 && rightDigits.size > 0 && ![...leftDigits].some((token) => rightDigits.has(token))) return false;
  if (negationCountOf(left) !== negationCountOf(right)) return false;
  if (specTextEquivalent(left, right)) return true;
  // 短串（<12 内容字符）不做变体近似：2-gram 证据太薄，「变更0」⊂「独立变更0」这类编号
  // 短标题互含即误折——短串只走上面的精确/等价通道。
  if (Math.min(l.length, r.length) < 12) return false;
  const leftGrams = changeTermGrams(left);
  const rightGrams = changeTermGrams(right);
  let intersection = 0;
  const anchors: string[] = [];
  for (const gram of leftGrams) {
    if (!rightGrams.has(gram)) continue;
    intersection += 1;
    if (/^[a-z0-9]{5,}$/.test(gram)) anchors.push(gram);
  }
  const union = leftGrams.size + rightGrams.size - intersection;
  if (union > 0 && intersection / union >= CHANGE_TERM_JACCARD_THRESHOLD) return true;
  const smaller = Math.min(leftGrams.size, rightGrams.size);
  return anchors.length >= CHANGE_ANCHOR_MIN && smaller > 0 && intersection / smaller >= CHANGE_CONTAINMENT_THRESHOLD;
}

function isScenarioShape(value: unknown): value is SpecScenario {
  return typeof value === "object" && value !== null
    && typeof (value as SpecScenario).context === "string"
    && typeof (value as SpecScenario).action === "string"
    && typeof (value as SpecScenario).outcome === "string";
}

/**
 * BM-11 功能级变体判定（确定性、零模型调用）：同一组件/行为被 LLM 换字命名析成两个功能
 * （「无壳页面语言切换」↔「无外壳页面语言切换」，f7b2d60/38d3c7e 两 run 各立；release 220
 * 同一面板单 run 内 ×4）的根治判定器。scenarioVariantSimilar 只折叠同功能内场景对，功能
 * identity = specFeatureKey(name) 使任何一字之差都成为新功能——此判定器供两处接线：
 * mergeChunkResults 跨 group 折叠（run 内）与 insertSpecVersion 装配折叠（跨 run）。
 * 判定 = **身份信号 + 场景门禁**（宁漏勿错合由场景多数决承担，对齐 feature_aliases
 * 的 C-lite 哲学）：
 * 1. 身份信号：名字通道（specTextEquivalent——无壳↔无外壳编辑距离 0.889 命中，或名称
 *    contentJaccard ≥ 0.5——管理端支付台账↔管理端支付订单台账 0.556 命中；跨语种直接
 *    拒绝）**或双信号（证据路径交集 ≥1 AND summary contentJaccard ≥ 0.34）**。后者是
 *    release 226 实证的补位：同一清理脚本被析成 5 个异名变体，名字差太远过不了名门禁，
 *    但共享 scripts/dedupe-release-changes.ts + summary 高度重合。证据信号必须与 summary
 *    叠加——同文件真不同功能的场景常共享情境/操作措辞，单证据信号旧回归集立即过合。
 * 2. 场景门禁：featureScenarioPairMatch 贪心配对（category+数字签名+outcome 否定计数
 *    守护 + 合并文本 Jaccard ≥ 0.34，比 scenarioVariantSimilar 的逐字段地板宽——见该
 *    函数注释），命中数 ≥ max(2, ⌈0.6×min(nA,nB)⌉)（min=1 时 ≥1）——防「泛化名巧合」
 *    误合的关键护栏，也是真差异功能对（同文件不同行为）的主要隔离层。
 * 已知误拒（可接受）：功能名含否定字时一字之差会触发否定计数冲突（外壳↔无壳 0↔1），
 * 名门禁与场景门禁同时过不了即不折——宁漏勿错合口径下留待人工/别名通道。
 */
const FEATURE_NAME_JACCARD_THRESHOLD = 0.5;
/** 与场景字段地板 VARIANT_FIELD_JACCARD_THRESHOLD 同口径：summary 只是身份信号之一，取宽不取严。 */
const FEATURE_SUMMARY_JACCARD_THRESHOLD = VARIANT_FIELD_JACCARD_FLOOR;
const FEATURE_SCENARIO_MATCH_MIN = 2;
const FEATURE_SCENARIO_MATCH_RATIO = 0.6;

function featureEvidencePaths(feature: SpecFeature): Set<string> {
  return new Set(feature.scenarios.flatMap((scenario) => scenario.evidence.map((item) => item.path)));
}

/**
 * 功能级场景配对：scenarioVariantSimilar 的逐字段严守护在这里太紧——跨 run 重提取
 * 对「同一行为」的结果字段常被大段改写（实测：「创建测试单并展示二维码/H5/支付宝
 * 支付入口」↔「展示微信支付二维码、H5 收银台与支付宝跳转链接」被 outcome 字段地板
 * 拒光，合并文本 0.55；空态对合并文本 0.348）。功能级判定已有名字+身份双重门禁在
 * 前面、且要求较小一方**多数场景**配对成功，配对阈值取字段地板同口径 0.34——
 * 即 scenarioVariantSimilar 的规则 1+5，跳过逐字段地板；真差异功能对靠「多数决 +
 * 名字/身份门禁」三重护栏隔离。
 */
/** 导出给合并层/装配层的功能级场景配对（BM-11 折叠通道内的场景去重口径），判定规则见上。 */
export function featureScenarioPairMatch(previous: SpecScenario, current: SpecScenario): boolean {
  if (previous.category !== current.category) return false;
  if (scenarioBehaviorEqual(previous, current) || scenarioVariantSimilar(previous, current)) return true;
  const separator = hasCjk(`${previous.context}${previous.action}${previous.outcome}`) ? "" : " ";
  const previousCombined = `${previous.context}${separator}${previous.action}${separator}${previous.outcome}`;
  const currentCombined = `${current.context}${separator}${current.action}${separator}${current.outcome}`;
  if (crossLanguageText(previousCombined, currentCombined)) return false;
  if (digitSignature(specContent(previousCombined)) !== digitSignature(specContent(currentCombined))) return false;
  // 否定守护只看 outcome：合并串上会误杀中文空态措辞的等价变体（「未退款」↔「可退款」、
  // 「表格显示空态」↔「显示无任何订单提示」——无/未是空态句式的常用字，不是语义翻转）；
  // 真正的语义翻转（可以重试↔不可以重试）发生在结果字段。
  if (negationCountOf(previous.outcome) !== negationCountOf(current.outcome)) return false;
  // 宽松合并通道只对中文开放：中文 2-gram 按字、实测等价变体 0.346-0.512（字段地板口径
  // 0.34）；纯英文合并串是词 token、粒度粗，同情境同操作的英文对仅结果一词之差也能到
  // 0.6（"Signs in → Dashboard" ↔ "Signs in → Onboarding" 实测），宽松通道会吞掉真差异
  // ——英文只走 scenarioVariantSimilar 严通道（已在上面尝试过），宁漏勿错合。
  if (!hasCjk(previousCombined)) return false;
  return contentJaccard(previousCombined, currentCombined) >= VARIANT_FIELD_JACCARD_FLOOR;
}

export function featureVariantSimilar(previous: SpecFeature, current: SpecFeature): boolean {
  if (crossLanguageText(previous.name, current.name)) return false;
  // 身份信号：名字等价/Jaccard 过线，或（证据交集 AND summary 近似）双信号——release 226
  // 实证同一清理脚本被析成 5 个异名变体，名字差太远过不了名门禁，但共享证据文件 + 场景
  // 高度重合；单靠证据信号不够（同文件真不同功能的场景常共享情境/操作措辞，旧回归集
  // 立即过合），须叠加 summary 近似才是「同一组件的两种描述」的强信号。
  const nameEquivalent = specTextEquivalent(previous.name, current.name);
  const nameGate = nameEquivalent || contentJaccard(previous.name, current.name) >= FEATURE_NAME_JACCARD_THRESHOLD;
  const sharedPaths = [...featureEvidencePaths(previous)].filter((path) => featureEvidencePaths(current).has(path));
  const summaryGate = previous.summary !== "" && current.summary !== "" && contentJaccard(previous.summary, current.summary) >= FEATURE_SUMMARY_JACCARD_THRESHOLD;
  const identitySignal = nameGate || (sharedPaths.length >= 1 && summaryGate);
  if (!identitySignal) return false;
  // 场景门禁：贪心配对。名字通道（弱身份信号靠名字锚定）要求较小一方多数场景配上
  // （≥max(2, ⌈0.6×min⌉)，min=1 时 ≥1）；证据+摘要双信号路径（release 226 实证）只要求
  // ≥1——跨分区对同一脚本的场景分解与措辞完全不同（实测 3 场景仅 1 对能配上），多数决
  // 会把真变体拒光，双身份信号已足够锚定组件身份。零场景功能直接拒绝。
  const smaller = previous.scenarios.length <= current.scenarios.length ? previous : current;
  const larger = smaller === previous ? current : previous;
  if (smaller.scenarios.length === 0) return false;
  let matched = 0;
  for (const candidate of smaller.scenarios) {
    if (larger.scenarios.some((other) => featureScenarioPairMatch(candidate, other))) matched += 1;
  }
  const required = nameGate
    ? (smaller.scenarios.length === 1 ? 1 : Math.max(FEATURE_SCENARIO_MATCH_MIN, Math.ceil(FEATURE_SCENARIO_MATCH_RATIO * smaller.scenarios.length)))
    : 1;
  return matched >= required;
}

function isFeatureShape(value: unknown): value is SpecFeature {
  return typeof value === "object" && value !== null
    && typeof (value as SpecFeature).name === "string"
    && typeof (value as SpecFeature).summary === "string";
}

/**
 * 落库行级的仅措辞判定（历史回填用，与 diffSpec 的分析时判定同口径）：
 * 对 spec_changes 的 before_json/after_json 主体按行为字段做等价判定。
 * added/removed 行没有对侧主体，恒为 false——换编号抖动的配对由回填脚本另行处理。
 */
export function specChangeWordingOnly(before: unknown, after: unknown) {
  if (!before || !after) return false;
  if (isScenarioShape(before) && isScenarioShape(after)) return scenarioBehaviorEqual(before, after);
  if (isFeatureShape(before) && isFeatureShape(after)) {
    if (before.name !== after.name || (before.parentKey ?? null) !== (after.parentKey ?? null)) return false;
    if (specTextEquivalent(before.summary, after.summary)) return true;
    // 身份未变且场景集（行为单元）等价时，整段摘要重写同样仅措辞——与运行时 diffFeature 折叠同口径。
    return featureScenarioSetChanges(before, after).length === 0;
  }
  return false;
}

interface DiffOutcome {
  changes: SpecChange[];
  folded: FoldedSpecChange[];
}

/** 折叠判定的可选上下文：本发布中确有行为性行变更的文件路径集（lib/patch-scan 产出）；
 *  language 决定确定性变化摘要（changeSummary）的语种，取新版本的分析输出语言。 */
export interface DiffSpecOptions {
  behavioralChangePaths?: ReadonlySet<string>;
  language?: "zh-CN" | "en";
}

function scenarioChanges(before: SpecFeature, after: SpecFeature, outcome: DiffOutcome, language?: "zh-CN" | "en") {
  const beforeScenarios = scenarioMap(before);
  const afterScenarios = scenarioMap(after);
  const changes: SpecChange[] = [];

  for (const reference of mergedSortedKeys(beforeScenarios, afterScenarios)) {
    const previous = beforeScenarios.get(reference);
    const current = afterScenarios.get(reference);
    const kind = previous ? current ? "changed" : "removed" : "added";
    if (previous && current && !scenarioBehaviorChanged(previous, current)) {
      // 行为等价不落变化行；若原文确有差异，记入折叠明细供审计（完全相同的文本没有审计价值）。
      if (previous.context !== current.context || previous.action !== current.action || previous.outcome !== current.outcome) {
        outcome.folded.push({ reason: "wording", entityType: "scenario", featureName: after.name, scenarioReference: reference, before: previous, after: current });
      }
      continue;
    }
    changes.push({
      kind,
      entityType: "scenario",
      featureName: after.name,
      scenarioReference: reference,
      summary: changeSummary(kind, "scenario", after.name, reference, language),
      before: previous === undefined ? null : previous,
      after: current === undefined ? null : current,
    });
  }

  // 边界抖动折叠：同功能内 removed↔added 且行为字段逐项等价 → 同一行为换了编号，不产生变化行。
  // BM-6 变体通道：措辞近似（同义替换）的 removed↔added 对同样折叠，reason=variant 供审计。
  const droppedIndexes = new Set<number>();
  for (const [removedIndex, removed] of changes.entries()) {
    if (removed.kind !== "removed") continue;
    for (const [addedIndex, added] of changes.entries()) {
      if (added.kind !== "added" || droppedIndexes.has(addedIndex)) continue;
      const previous = removed.before as SpecScenario;
      const current = added.after as SpecScenario;
      if (scenarioBehaviorEqual(previous, current)) {
        droppedIndexes.add(removedIndex);
        droppedIndexes.add(addedIndex);
        outcome.folded.push({ reason: "renumber", entityType: "scenario", featureName: after.name, scenarioReference: current.reference, before: previous, after: current });
        break;
      }
      if (scenarioVariantSimilar(previous, current)) {
        droppedIndexes.add(removedIndex);
        droppedIndexes.add(addedIndex);
        outcome.folded.push({ reason: "variant", entityType: "scenario", featureName: after.name, scenarioReference: current.reference, before: previous, after: current });
        break;
      }
    }
  }
  for (const [index, change] of changes.entries()) if (!droppedIndexes.has(index)) outcome.changes.push(change);
}

/** 场景集（行为单元）差异：运行时折叠判定与历史回填共用同一口径。旧行 JSON 缺 scenarios 时按空集处理。 */
/**
 * 新增功能的证伪门禁：仅当功能**主张了实现证据、且每条主张都被证伪**时折叠——
 * 实现证据文件本次无行为性行变更（仅注释/空白）或不在本发布行为变更集内
 * （superset 盲评 #1009：实现文件仅 JSDoc 变动的覆盖补录型新增）。折叠供审计，
 * 不落行为变化。
 *
 * 无行为集、或功能未主张任何实现证据（全部场景只引测试/文档）时**不折叠**：
 * 随代码一起交付文档的真功能（盲评「查看者宽松模式」，证据全为文档但实现真实存在）
 * 会被误杀——无法证伪的主张保留可见，交人工核实，而不是静默吞掉。
 */
function featureEvidenceNonBehavioral(feature: SpecFeature, behavioral?: ReadonlySet<string>) {
  if (!behavioral) return false;
  if (feature.scenarios.length === 0) return false;
  const implementationPaths = feature.scenarios
    .flatMap((scenario) => scenario.evidence.filter((item) => evidenceKind(item.path) === "implementation").map((item) => item.path));
  if (implementationPaths.length === 0) return false;
  return implementationPaths.every((path) => !behavioral.has(path));
}

function featureScenarioSetChanges(before: SpecFeature, after: SpecFeature): SpecChange[] {
  const outcome: DiffOutcome = { changes: [], folded: [] };
  scenarioChanges(
    { ...before, scenarios: before.scenarios ?? [] },
    { ...after, scenarios: after.scenarios ?? [] },
    outcome,
  );
  return outcome.changes;
}

function diffFeature(previous: SpecFeature | undefined, current: SpecFeature | undefined, outcome: DiffOutcome, options?: DiffSpecOptions) {
  const language = options?.language;
  if (!previous && current) {
    if (featureEvidenceNonBehavioral(current, options?.behavioralChangePaths)) {
      outcome.folded.push({ reason: "tests-only", entityType: "feature", featureName: current.name, scenarioReference: null, before: null, after: current });
    } else {
      outcome.changes.push(featureChange("added", current, null, current, language));
    }
    return;
  }
  if (previous && !current) {
    outcome.changes.push(featureChange("removed", previous, previous, null, language));
    return;
  }
  if (!previous || !current) return;

  const scenarioOutcome: DiffOutcome = { changes: [], folded: [] };
  scenarioChanges(previous, current, scenarioOutcome, language);

  if (featureBehaviorChanged(previous, current)) {
    const identityChanged = previous.name !== current.name || (previous.parentKey ?? null) !== (current.parentKey ?? null);
    if (!identityChanged && scenarioOutcome.changes.length === 0) {
      // 行为单元（场景集）与身份均未变：摘要被整段重写只是同一行为面的表述漂移，不构成行为变化
      // （superset 第三方盲评 12/13 误报即此模式——token 签名完全不同的重写过不了 specTextEquivalent，
      // 但场景一个没动）。折叠供审计，落库文本仍采用新版。
      outcome.folded.push({ reason: "wording", entityType: "feature", featureName: current.name, scenarioReference: null, before: previous, after: current });
    } else {
      outcome.changes.push({ kind: "changed", entityType: "feature", featureName: current.name, scenarioReference: null, summary: changeSummary("changed", "feature", current.name, null, language), before: previous, after: current });
    }
  } else if (previous.summary !== current.summary) {
    outcome.folded.push({ reason: "wording", entityType: "feature", featureName: current.name, scenarioReference: null, before: previous, after: current });
  }
  outcome.changes.push(...scenarioOutcome.changes);
  outcome.folded.push(...scenarioOutcome.folded);
}

export function diffSpec(before: SpecFeature[] | null, after: SpecFeature[], options?: DiffSpecOptions): SpecChange[] {
  return diffSpecWithFolded(before, after, options).changes;
}

/** 与 diffSpec 同判定的折叠报告版：changes 之外同时返回被等价判定吞掉的差异明细。 */
export function diffSpecWithFolded(before: SpecFeature[] | null, after: SpecFeature[], options?: DiffSpecOptions): DiffOutcome {
  const outcome: DiffOutcome = { changes: [], folded: [] };
  if (!before) return outcome;
  const beforeFeatures = new Map(before.map((feature) => [specFeatureKey(feature.name), feature]));
  const afterFeatures = new Map(after.map((feature) => [specFeatureKey(feature.name), feature]));

  for (const key of mergedSortedKeys(beforeFeatures, afterFeatures)) diffFeature(beforeFeatures.get(key), afterFeatures.get(key), outcome, options);
  return outcome;
}

export interface SpecTombstones {
  featureKeys: ReadonlySet<string>;
  scenarioKeys: ReadonlySet<string>;
}

export function specScenarioKey(featureName: string, reference: string) {
  return `${specFeatureKey(featureName)}:${reference}`;
}

export function mergeSpecSources(generated: SpecFeature[], manual: SpecFeature[], tombstones: SpecTombstones = { featureKeys: new Set<string>(), scenarioKeys: new Set<string>() }, carried: SpecFeature[] = []) {
  const merged = new Map<string, SpecFeature>();
  for (const feature of carried) {
    const key = specFeatureKey(feature.name);
    if (tombstones.featureKeys.has(key)) continue;
    const scenarios = feature.scenarios.filter((scenario) => !tombstones.scenarioKeys.has(specScenarioKey(feature.name, scenario.reference)));
    merged.set(key, { ...feature, scenarios });
  }
  for (const feature of generated) {
    const key = specFeatureKey(feature.name);
    if (tombstones.featureKeys.has(key)) continue;
    const scenarios = feature.scenarios.filter((scenario) => !tombstones.scenarioKeys.has(specScenarioKey(feature.name, scenario.reference)));
    merged.set(key, { ...feature, scenarios });
  }
  for (const feature of manual) {
    const key = specFeatureKey(feature.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, feature);
      continue;
    }
    const scenarios = scenarioMap(existing);
    for (const scenario of feature.scenarios) scenarios.set(scenario.reference, scenario);
    const mergedFeature = feature.source === "generated" ? { ...feature, summary: existing.summary } : feature;
    merged.set(key, { ...mergedFeature, scenarios: [...scenarios.values()] });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 增量提取未覆盖的旧证据不等于行为已移除：只有证据进入本次行为变更集，才允许旧场景退出。 */
export function preserveUnchangedEvidence(previousFeatures: SpecFeature[], generated: SpecFeature[], behavioralChangePaths: ReadonlySet<string>): SpecFeature[] {
  const result = generated.map((feature) => ({ ...feature, scenarios: [...feature.scenarios] }));
  const byKey = new Map(result.map((feature) => [specFeatureKey(feature.name), feature] as const));
  for (const previousFeature of previousFeatures) {
    if (previousFeature.source === "manual") continue;
    const unchanged = previousFeature.scenarios.filter((scenario) => scenario.source !== "manual"
      && scenario.evidence.every((item) => !behavioralChangePaths.has(item.path)));
    if (unchanged.length === 0) continue;
    const current = byKey.get(specFeatureKey(previousFeature.name));
    if (!current) {
      const restored = { ...previousFeature, scenarios: unchanged };
      result.push(restored);
      byKey.set(specFeatureKey(restored.name), restored);
      continue;
    }
    const references = new Set(current.scenarios.map((scenario) => scenario.reference));
    current.scenarios.push(...unchanged.filter((scenario) => !references.has(scenario.reference)));
  }
  return result;
}
