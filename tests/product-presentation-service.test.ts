import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Execute } from "../lib/db";
import { currentOrganizationModel } from "../lib/organization-model";
import { encryptSecret } from "../lib/secret-box";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "../lib/llm-client";
import {
  generateProductPresentation,
  loadPresentationLedger,
  mergePresentation,
  presentationLedgerFingerprint,
  runPresentationRefreshSweepOnce,
  schedulePresentationRefresh,
  type GeneratedPresentation,
  type PresentationLedger,
  type PresentationLedgerFeature,
  type PresentationLedgerScenario,
} from "../lib/product-presentation-service";
import { journeyMiningPrompt, parseJourneyCandidates } from "../lib/snapshot/presentation";

function feature(id: number, name: string, parentId: number | null = null, displayName = ""): PresentationLedgerFeature {
  return { id, name, displayName, summary: `${name} 的摘要`, parentId };
}

function scenario(featureId: number, reference: string, category: PresentationLedgerScenario["category"] = "happy"): PresentationLedgerScenario {
  return { featureId, reference, context: `情境 ${featureId}/${reference}`, action: `操作 ${featureId}/${reference}`, outcome: `结果 ${featureId}/${reference}`, category, step: null, evidence: [] };
}

/** 四个叶子功能 A–D，各有两条 happy 场景；A 另有一条 edge 场景。 */
function leafLedger(): PresentationLedger {
  const features = [feature(1, "A"), feature(2, "B"), feature(3, "C"), feature(4, "D")];
  return {
    productId: 1,
    name: "Demo",
    description: "一个演示产品",
    language: "zh-CN",
    specVersionId: 7,
    features,
    scenarios: [scenario(1, "HP-1"), scenario(1, "HP-2"), scenario(1, "EC-1", "edge"), scenario(2, "HP-1"), scenario(2, "HP-2"), scenario(3, "HP-1"), scenario(3, "HP-2"), scenario(4, "HP-1"), scenario(4, "HP-2")],
  };
}

/** 人工业务域：父节点「采集域」含子级 A、B；C、D 是未归组功能。 */
function domainLedger(): PresentationLedger {
  const ledger = leafLedger();
  ledger.features = [feature(10, "采集", null, "采集域"), feature(1, "A", 10), feature(2, "B", 10), feature(3, "C"), feature(4, "D")];
  return ledger;
}

const MINING_PROMPT = "为第一次接触产品的读者创建用户旅程";

type Answer = { name: string; steps: Array<{ featureName: string; reference: string }> };

function isMining(messages: StructuredCompletionMessage[]) {
  return messages[1]?.content.includes(MINING_PROMPT);
}

/** 从挖掘提示词里取回候选场景所属的功能（窗口成员）。 */
function windowMembers(messages: StructuredCompletionMessage[]): string[] {
  const candidates = JSON.parse(messages[1].content.split("候选场景：\n")[1]) as Array<{ featureName: string }>;
  return [...new Set(candidates.map((candidate) => candidate.featureName))];
}

function client(answer: (messages: StructuredCompletionMessage[]) => string | Promise<string>): StructuredCompletionClient & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (messages: StructuredCompletionMessage[]) => answer(messages));
  return { complete };
}

function miningAnswer(journeys: Answer[]) {
  return JSON.stringify({ journeys });
}

const grouping = JSON.stringify({
  tagline: "把采集的数据变成复盘",
  coreCapabilities: [
    { name: "采集与转写", summary: "把原始数据变成文字", featureNames: ["A", "B"], scenarioRefs: [] },
    { name: "复盘分析", summary: "从文字里提炼要点", featureNames: ["C", "D"], scenarioRefs: [] },
  ],
  journeys: [{ name: "从采集到复盘", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] }],
  concepts: [],
});

/** 归组成功但不带典型旅程的输出：用来构造「有能力分组、没有旅程」的形态。 */
const groupingWithoutJourneys = JSON.stringify({ ...JSON.parse(grouping), journeys: [] });

/** 归组失败/不涉及归组时使用的假模型：每次挖掘都返回同一条旅程。 */
const oneJourney = { name: "挖掘旅程", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] };

function silenceConsole() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => { warn.mockRestore(); log.mockRestore(); error.mockRestore(); };
}

describe("product presentation generation", () => {
  it("reuses the Radar grouping for ungrouped products and mines each capability bucket", async () => {
    const complete = client((messages) => {
      if (!isMining(messages)) return grouping;
      const members = windowMembers(messages);
      return miningAnswer([{ name: `${members[0]} 与 ${members[1]} 的流程`, steps: [{ featureName: members[0], reference: "HP-2" }, { featureName: members[1], reference: "HP-1" }] }]);
    });
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    expect(generated.status).toBe("generated");
    expect(generated.tagline).toBe("把采集的数据变成复盘");
    expect(generated.capabilities.map((capability) => [capability.name, capability.featureNames])).toEqual([["采集与转写", ["A", "B"]], ["复盘分析", ["C", "D"]]]);
    expect(generated.journeys.map((journey) => [journey.id, journey.name, journey.tier, journey.capabilityNames])).toEqual([
      // 标签 = 旅程实际触及的能力：全局典型场景横跨两个能力，所以两个都记
      ["journey-1", "从采集到复盘", "headline", ["采集与转写", "复盘分析"]],
      ["journey-2", "A 与 B 的流程", "capability", ["采集与转写"]],
      ["journey-3", "C 与 D 的流程", "capability", ["复盘分析"]],
    ]);
    expect(generated.passes).toBe(3);
    expect(complete.complete).toHaveBeenCalledTimes(3);
    expect(generated.coverage).toEqual({ featuresTotal: 4, featuresInJourneys: 4, scenariosInJourneys: 6 });
    const contents = complete.complete.mock.calls.map((call) => call[0][1].content);
    // 归组走 Radar 原提示词；深挖用同一「不新增事实」契约的窗口提示词
    expect(contents[0]).toContain("你在为第一次接触项目");
    expect(contents[1]).toContain("不得新增事实");
    expect(contents[1]).toContain("所属能力：采集与转写");
    // 全局典型旅程沿用 Radar 结果，不另发调用
    expect(contents.filter((content) => content.includes("所属能力："))).toHaveLength(2);
  });

  it("derives capabilities from human business domains without any model call and mines domains plus ungrouped features", async () => {
    const complete = client((messages) => {
      expect(isMining(messages), "business-domain products must not call the grouping prompt").toBe(true);
      const content = messages[1].content;
      const members = windowMembers(messages);
      if (content.includes("所属能力：采集域")) return miningAnswer([{ name: "采集域内部流程", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] }]);
      // 全局采样覆盖所有功能；未归组窗口只有 C、D
      if (members.includes("A")) return miningAnswer([{ name: "全局典型", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] }]);
      return miningAnswer([{ name: "未归组流程", steps: [{ featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }] }]);
    });
    const generated = await generateProductPresentation({ ledger: domainLedger(), client: complete });
    // 人工业务域优先于 AI 归组：名称用首页显示名，成员是子级功能
    expect(generated.capabilities).toEqual([{ id: "capability-1", name: "采集域", summary: "采集 的摘要", featureNames: ["A", "B"] }]);
    expect(generated.status).toBe("generated");
    expect(generated.journeys.map((journey) => [journey.name, journey.tier, journey.capabilityNames])).toEqual([
      ["全局典型", "headline", ["采集域"]],
      ["采集域内部流程", "capability", ["采集域"]],
      ["未归组流程", "capability", []],
    ]);
    // 一趟全局采样 + 采集域窗口 + 未归组功能窗口
    expect(generated.passes).toBe(3);
    expect(generated.coverage.featuresTotal).toBe(4);
  });

  it("drops invalid journeys one by one and folds duplicates, keeping acceptance order deterministic", async () => {
    let call = 0;
    const complete = client(async (messages) => {
      if (!isMining(messages)) return grouping;
      // 两个深挖窗口并发：第一个窗口延迟返回，接纳顺序仍按窗口顺序。
      // 序号必须在 await 之前定格——共享计数器在等待期间会被另一个窗口推进。
      const current = ++call;
      if (current === 1) await new Promise((resolve) => setTimeout(resolve, 15));
      return miningAnswer(current === 1
        ? [
            { name: "有效旅程甲", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "B", reference: "HP-1" }] },
            { name: "引用了不存在的场景", steps: [{ featureName: "A", reference: "HP-9" }, { featureName: "B", reference: "HP-1" }] },
            { name: "引用了非 happy 场景", steps: [{ featureName: "A", reference: "EC-1" }, { featureName: "B", reference: "HP-1" }] },
            { name: "只连接一个功能", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "A", reference: "HP-2" }] },
            { name: "只有一步", steps: [{ featureName: "A", reference: "HP-1" }] },
            { name: "重复同一步骤", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "A", reference: "HP-1" }] },
          ]
        : [
            { name: "有效旅程乙", steps: [{ featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }] },
            // 与「乙」是同一对功能（C、D），只多引用了 C 的另一条场景：读者眼里的同一个场景
            { name: "与乙高度相似", steps: [{ featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }, { featureName: "C", reference: "HP-2" }] },
          ]);
    });
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    // 「与乙高度相似」没有带来新的功能，按重复折叠
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["从采集到复盘", "有效旅程甲", "有效旅程乙"]);
    expect(generated.journeys.map((journey) => journey.capabilityNames)).toEqual([["采集与转写", "复盘分析"], ["采集与转写"], ["复盘分析"]]);
    // 所有落库步骤都是规范引用
    expect(generated.journeys[1].steps).toEqual([{ featureName: "A", reference: "HP-2" }, { featureName: "B", reference: "HP-1" }]);
  });

  it("folds journeys that only swap scenario references of the same features, in either order", async () => {
    // 生产实测（2026-11-24，11 个功能的产品）：同一对功能被换着场景编号写了 4 条，11 个功能挖出 20 条旅程只有 13 种走法。
    // 判重口径是「经过的功能组合」——场景编号只是同一个功能的不同细节。
    const complete = client((messages) => (isMining(messages)
      ? miningAnswer([
          { name: "访问时获得安全响应头", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] },
          { name: "限流内访问", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-2" }] },
          { name: "并发上限内访问", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "B", reference: "HP-2" }] },
          { name: "倒着走同一对功能", steps: [{ featureName: "B", reference: "HP-1" }, { featureName: "A", reference: "HP-2" }] },
          { name: "真正不同的一条", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "C", reference: "HP-1" }] },
        ])
      : groupingWithoutJourneys));
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["访问时获得安全响应头", "真正不同的一条"]);
    expect(generated.coverage.featuresInJourneys).toBe(3);
  });

  it("drops journeys that chain consecutive steps of the same feature", async () => {
    // 生产实测（2026-11-24）：首轮生成没有这条校验，60 条旅程里 22 条把同一功能的几条场景首尾相接
    // （如「知识健康统计 HP-1 → HP-2 → HP-3 → 知识健康面板」），读起来是在罗列变体。
    const complete = client((messages) => (isMining(messages)
      ? miningAnswer([
          { name: "罗列同一功能的变体", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "A", reference: "HP-2" }, { featureName: "B", reference: "HP-1" }] },
          { name: "正常的跨功能场景", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] },
        ])
      : groupingWithoutJourneys));
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["正常的跨功能场景"]);
  });

  it("lets the more complete journey win when it strictly contains an accepted one", async () => {
    const complete = client((messages) => (isMining(messages)
      ? miningAnswer([
          { name: "短版本", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] },
          { name: "完整版本", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }] },
        ])
      : groupingWithoutJourneys));
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    // 后到的「完整版本」原位替换「短版本」：不留两条，位置不变；同名重名仍只留一条
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["完整版本"]);
    expect(generated.coverage.featuresInJourneys).toBe(3);
  });

  it("packs tiny domains into shared windows when they would not fit the call cap, and labels journeys by what they touch", async () => {
    // 生产实测形态（codelphi 产品，2026-11-24）：10 个只有 2 个功能的人工业务域 + 10 个未分组功能。
    // 这种「一部分在域里、其余未分组」的形态只出现在人工业务域路径上（AI 归组必须覆盖每个功能恰好一次）。
    const names = Array.from({ length: 30 }, (_, index) => `F${index + 1}`);
    const tiny: PresentationLedger = {
      ...leafLedger(),
      features: [
        ...Array.from({ length: 10 }, (_, index) => feature(101 + index, `域${index + 1}`)),
        ...names.slice(0, 20).map((name, index) => feature(index + 1, name, 101 + Math.floor(index / 2))),
        ...names.slice(20).map((name, index) => feature(21 + index, name)),
      ],
    };
    tiny.scenarios = tiny.features.filter((item) => item.id <= 30).map((item) => scenario(item.id, "HP-1"));
    const seen: Array<{ members: string[]; packed: boolean }> = [];
    const complete = client((messages) => {
      expect(isMining(messages), "business-domain products must not call the grouping prompt").toBe(true);
      const content = messages[1].content;
      const members = windowMembers(messages);
      const packed = content.includes("分组与成员功能：");
      seen.push({ members, packed });
      // 只有打包窗口才造得出跨域的场景：故意横跨域一和域三；另有一条只碰未归组功能
      return miningAnswer([
        { name: "纯未归组", steps: [{ featureName: "F21", reference: "HP-1" }, { featureName: "F22", reference: "HP-1" }] },
        ...(packed ? [{ name: "跨域", steps: [{ featureName: "F1", reference: "HP-1" }, { featureName: "F5", reference: "HP-1" }] }] : []),
      ]);
    });
    // maxPasses=3：功能预算 120 个功能位、调用上限 6。10 个小域各自成窗会超调用上限，于是合并成一个打包窗口。
    // 第一轮：全局采样（30 个功能各一条场景，不分能力）、打包窗口 20 个功能（10 个域）、未分组窗口 10 个功能。
    // 第一轮新增了旅程，所以进入第二轮：只送仍未被覆盖的功能——10 个域共剩 18 个（仍超调用上限，再并成打包窗口）、
    // 未归组剩 8 个。
    const generated = await generateProductPresentation({ ledger: tiny, client: complete, maxPasses: 3 });
    expect(generated.passes).toBe(5);
    expect(seen.map(({ members, packed }) => [members.length, packed])).toEqual([[30, false], [20, true], [10, false], [18, true], [8, false]]);
    // 打包窗口的提示词列出「分组 → 成员功能」的归属，并要求每组都有出场机会
    // （只给分组名、不给成员归属时模型无从按分组构造场景；分组间顺序取决于排序规则，不在此断言）
    const packedPrompt = complete.complete.mock.calls[1][0][1].content;
    expect(packedPrompt).toContain("请为尽可能多的分组各写一条旅程");
    // 成员归属完整且正确：域 N 拥有 F(2N-1)、F(2N)（分组间、功能间的先后取决于排序规则，按集合比对）
    const membership = packedPrompt.slice(packedPrompt.indexOf("分组与成员功能：") + "分组与成员功能：".length, packedPrompt.indexOf("。", packedPrompt.indexOf("分组与成员功能：")));
    const sorted = (members: string[]) => [...members].sort();
    const byGroup = Object.fromEntries(membership.split("；").map((entry: string) => { const [name, members] = entry.split("："); return [name, sorted(members.split("、"))]; }));
    expect(byGroup).toEqual(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`域${index + 1}`, sorted([`F${index * 2 + 1}`, `F${index * 2 + 2}`])])));
    // 第二轮不再送已覆盖的功能：F1、F5（跨域场景）、F21、F22（纯未归组场景）都不再出现
    expect(seen.slice(3).flatMap((entry) => entry.members)).not.toContain("F1");
    expect(seen.slice(3).flatMap((entry) => entry.members)).not.toContain("F21");
    // 30 个功能全部被送到模型面前
    expect(new Set(seen.flatMap((entry) => entry.members)).size).toBe(30);
    const byName = Object.fromEntries(generated.journeys.map((journey) => [journey.name, journey.capabilityNames]));
    // F1 属于域1、F5 属于域3
    expect(byName).toEqual({ 纯未归组: [], 跨域: ["域1", "域3"] });
    expect(generated.capabilities).toHaveLength(10);
  });

  it("spends the feature budget before the call cap", async () => {
    // 90 个未分组功能：窗口是 40 / 40 / 10。maxPasses=1 即 40 个功能位——只够第一个窗口
    const wide: PresentationLedger = { ...leafLedger(), features: Array.from({ length: 90 }, (_, index) => feature(index + 1, `F${index + 1}`)) };
    wide.scenarios = wide.features.map((item) => scenario(item.id, "HP-1"));
    const seen: number[] = [];
    const complete = client((messages) => {
      if (!isMining(messages)) throw new Error("no grouping");
      const members = windowMembers(messages);
      seen.push(members.length);
      return miningAnswer([{ name: `旅程 ${seen.length}`, steps: [{ featureName: members[0], reference: "HP-1" }, { featureName: members[1], reference: "HP-1" }] }]);
    });
    const generated = await generateProductPresentation({ ledger: wide, client: complete, maxPasses: 1 });
    // 全局采样 40 个功能（每个功能一条场景）+ 第一个窗口 40 个；第二个窗口（再 40 个）超出功能预算，不发
    expect(seen).toEqual([40, 40]);
    expect(generated.passes).toBe(2);
    expect(generated.journeys).toHaveLength(2);
  });

  it("gives a capability that owns a single feature a destination", async () => {
    // 只有一个功能的业务域：单独成窗挖不出跨功能场景，并进别的窗口后才有机会作为某一步出现
    const single: PresentationLedger = {
      ...leafLedger(),
      features: [feature(10, "单功能域", null, "单功能域"), feature(1, "A", 10), feature(2, "X"), feature(3, "Y")],
    };
    single.scenarios = [scenario(1, "HP-1"), scenario(2, "HP-1"), scenario(3, "HP-1")];
    const seen: string[][] = [];
    const complete = client((messages) => {
      expect(isMining(messages), "business-domain products must not call the grouping prompt").toBe(true);
      const members = windowMembers(messages);
      seen.push(members);
      return miningAnswer([{ name: "经过单功能域", steps: [{ featureName: "X", reference: "HP-1" }, { featureName: "A", reference: "HP-1" }] }]);
    });
    const generated = await generateProductPresentation({ ledger: single, client: complete });
    // A 至少被送到过模型面前（不因为单功能而被丢掉），并且落在带标签的旅程里
    expect(seen.some((members) => members.includes("A"))).toBe(true);
    expect(generated.capabilities.map((capability) => capability.name)).toEqual(["单功能域"]);
    expect(generated.journeys.map((journey) => [journey.name, journey.capabilityNames])).toEqual([["经过单功能域", ["单功能域"]]]);
  });

  it("drops journeys that only walk part of an accepted journey's features, even with other scenario references", async () => {
    const longHeadline = JSON.stringify({ ...JSON.parse(grouping), journeys: [
      { name: "从采集到复盘", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }] },
    ] });
    const complete = client((messages) => {
      if (!isMining(messages)) return longHeadline;
      return miningAnswer([
        // 典型场景的前两步单独成条：功能组合被完全包含，对读者没有增量
        { name: "只是前两步", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] },
        // 同样只是 A、C 两个功能，换了 C 的场景编号：读者眼里仍是那段更长场景的一小段
        { name: "换了编号的同一段", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "C", reference: "HP-2" }] },
        // 带来了典型场景之外的功能：保留
        { name: "有自己的功能", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] },
      ]);
    });
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["从采集到复盘", "有自己的功能"]);
  });

  it("falls back to flat capability cards when the Radar grouping fails but still mines journeys", async () => {
    const complete = client((messages) => {
      if (!isMining(messages)) throw new Error("Presentation must cover every existing feature without adding new ones");
      return miningAnswer([{ name: "深挖旅程", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] }]);
    });
    const restore = silenceConsole();
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    restore();
    expect(generated.capabilities).toEqual([]);
    expect(generated.status).toBe("partial");
    // 没有分组时所有叶子功能进一个未归组桶：一趟全局采样 + 一个窗口（窗口返回的重复旅程被折叠）
    expect(generated.journeys.map((journey) => [journey.name, journey.tier])).toEqual([["深挖旅程", "headline"]]);
    expect(generated.passes).toBe(2);
  });

  it("honours the pass and journey budgets", async () => {
    const complete = client((messages) => (isMining(messages) ? miningAnswer([{ name: `旅程 ${complete.complete.mock.calls.length}`, steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] }]) : grouping));
    const ledger = leafLedger();
    // 挖掘预算为 0：不发任何挖掘请求，只留 Radar 归组带出的典型旅程
    const noMining = await generateProductPresentation({ ledger, client: complete, maxPasses: 0, maxJourneys: 60 });
    expect(complete.complete).toHaveBeenCalledTimes(1);
    expect(noMining.passes).toBe(1);
    expect(noMining.journeys.map((journey) => journey.name)).toEqual(["从采集到复盘"]);

    complete.complete.mockClear();
    // 预算按功能量计：maxPasses=1 即 40 个功能位、调用上限 2。归组不带典型旅程，所以先花一趟做全局采样；
    // 窗口只剩 1 趟额度，两个小桶各自成窗放不下，于是合并成一个打包窗口（4 个功能）一趟挖完
    const tightClient = client((messages) => (isMining(messages) ? miningAnswer([{ name: `旅程 ${tightClient.complete.mock.calls.length}`, steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "C", reference: "HP-1" }] }]) : groupingWithoutJourneys));
    const tight = await generateProductPresentation({ ledger, client: tightClient, maxPasses: 1, maxJourneys: 60 });
    const tightMining = tightClient.complete.mock.calls.filter((call) => isMining(call[0]));
    expect(tightMining).toHaveLength(2);
    expect(tightMining[1][0][1].content).toContain("分组与成员功能：采集与转写：A、B；复盘分析：C、D");
    expect(tight.passes).toBe(3);

    complete.complete.mockClear();
    const capped = await generateProductPresentation({ ledger, client: complete, maxPasses: 16, maxJourneys: 1 });
    // 典型旅程已占满旅程总数上限：不再发出任何挖掘调用（省下无用的模型请求）
    expect(complete.complete.mock.calls.filter((call) => isMining(call[0]))).toHaveLength(0);
    expect(capped.journeys).toHaveLength(1);
  });

  it("keeps the mining budget intact on large products, where grouping alone needs several calls", async () => {
    // 45 个功能走 Radar 大产品路径：领域计划 + 1 批归属 + 详情 = 3 次调用，多于这里给的挖掘预算
    const large: PresentationLedger = { ...leafLedger(), features: Array.from({ length: 45 }, (_, index) => feature(index + 1, `功能 ${index + 1}`)) };
    large.scenarios = large.features.map((item, index) => scenario(item.id, "HP-1"));
    const complete = client((messages) => {
      const content = messages[1].content;
      if (content.includes("领域计划")) return JSON.stringify({ tagline: "大产品", domains: [{ name: "全部能力", summary: "s" }] });
      if (content.includes("把本批每个功能")) return JSON.stringify({ assignments: large.features.map((item) => ({ featureName: item.name, domainName: "全部能力" })) });
      if (!isMining(messages)) return JSON.stringify({ journeys: [{ name: "跨模块流程", steps: [{ featureName: "功能 1", reference: "HP-1" }, { featureName: "功能 2", reference: "HP-1" }] }], concepts: [] });
      return miningAnswer([{ name: `深挖 ${windowMembers(messages)[0]}`, steps: [{ featureName: windowMembers(messages)[0], reference: "HP-1" }, { featureName: windowMembers(messages)[1], reference: "HP-1" }] }]);
    });
    const generated = await generateProductPresentation({ ledger: large, client: complete, maxPasses: 2 });
    // 若归组调用与挖掘共用预算，这里一趟深挖都发不出去；现在两趟挖掘预算完整保留
    expect(complete.complete.mock.calls.filter((call) => isMining(call[0]))).toHaveLength(2);
    expect(generated.passes).toBe(5);
    expect(generated.capabilities).toHaveLength(1);
    expect(generated.journeys.length).toBeGreaterThanOrEqual(2);
  });

  it("digs a second round only into the features the first round left uncovered", async () => {
    const miningCalls: string[][] = [];
    let cdSeen = 0;
    const complete = client((messages) => {
      if (!isMining(messages)) return groupingWithoutJourneys;
      const members = windowMembers(messages);
      miningCalls.push(members);
      // 归组不带典型旅程时，服务会先对跨桶采样（四个功能）补一趟全局典型场景：这里让它空手而归
      if (members.length > 2) return miningAnswer([]);
      // 第一轮的 CD 窗口空手而归；第二轮再问同一个桶时才带回旅程
      if (members.includes("C") && ++cdSeen === 1) return miningAnswer([]);
      return miningAnswer([{ name: `覆盖 ${members.join("")}`, steps: members.map((featureName) => ({ featureName, reference: "HP-1" })) }]);
    });
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    // 第二轮只为「仍有两个以上未覆盖功能」的桶（CD）发请求；已全覆盖的 AB 桶不再出现
    expect(miningCalls).toEqual([["A", "B", "C", "D"], ["A", "B"], ["C", "D"], ["C", "D"]]);
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["覆盖 AB", "覆盖 CD"]);
    expect(generated.passes).toBe(5);
    expect(generated.coverage.featuresInJourneys).toBe(4);
  });

  it("stops digging when a round adds nothing new", async () => {
    const complete = client((messages) => (isMining(messages) ? miningAnswer([]) : groupingWithoutJourneys));
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    // 一趟全局典型场景 + 第一轮两个窗口都空手而归：同样的输入再挖也不会有新东西，不再进入第二轮
    expect(complete.complete.mock.calls.filter((call) => isMining(call[0]))).toHaveLength(3);
    expect(generated.passes).toBe(4);
    expect(generated.journeys).toEqual([]);
  });

  it("treats an unparsable mining pass as empty instead of failing the whole generation", async () => {
    const complete = client((messages) => (isMining(messages) ? "not json" : grouping));
    const restore = silenceConsole();
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    restore();
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["从采集到复盘"]);
    expect(generated.status).toBe("generated");
    // 每趟先请求一次，输出不是 JSON 时纠正一次后放弃：两个窗口共 4 次挖掘调用，都如实计入趟数
    expect(complete.complete.mock.calls.filter((call) => isMining(call[0]))).toHaveLength(4);
    expect(generated.passes).toBe(5);
    // 纠正请求带着原输出与「只返回 JSON」的明确要求
    const correction = complete.complete.mock.calls.find((call) => call[0].length === 4)!;
    expect(correction[0][2]).toMatchObject({ role: "assistant", content: "not json" });
    expect(correction[0][3].content).toContain("上一次输出不是 JSON");
  });

  it("recovers a journey pass when the model answers in Markdown first and JSON after one correction", async () => {
    let miningCalls = 0;
    const complete = client((messages) => {
      if (!isMining(messages)) return grouping;
      miningCalls += 1;
      // 生产实测形态：首次给出 Markdown 叙事，被要求纠正后才给出 JSON
      return messages.length === 2 ? "**旅程一：从采集到复盘**\n1. 访问 … → …" : miningAnswer([{ name: "纠正后的旅程", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "D", reference: "HP-1" }] }]);
    });
    const restore = silenceConsole();
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    restore();
    expect(generated.journeys.map((journey) => journey.name)).toEqual(["从采集到复盘", "纠正后的旅程"]);
    expect(miningCalls).toBe(4);
  });

  it("reports partial when capabilities exist but no valid journey could be composed", async () => {
    const complete = client((messages) => (isMining(messages) ? miningAnswer([]) : JSON.stringify({ tagline: "t", coreCapabilities: [{ name: "一组", summary: "s", featureNames: ["A", "B", "C", "D"], scenarioRefs: [] }], journeys: [], concepts: [] })));
    const generated = await generateProductPresentation({ ledger: leafLedger(), client: complete });
    expect(generated.status).toBe("partial");
    expect(generated.journeys).toEqual([]);
    expect(generated.capabilities).toHaveLength(1);
  });
});

describe("merging with the previous presentation", () => {
  const step = (featureName: string, reference = "HP-1") => ({ featureName, reference });
  const previousOf = (journeys: Array<{ name: string; steps: Array<{ featureName: string; reference: string }> }>) => ({ capabilities: [{ id: "capability-1", name: "旧分组", summary: "s", featureNames: ["A", "B"] }], journeys: journeys.map((journey, index) => ({ id: `journey-${index + 1}`, name: journey.name, tier: "headline" as const, capabilityNames: [], steps: journey.steps })) });
  const nextOf = (journeys: Array<{ name: string; steps: Array<{ featureName: string; reference: string }> }>): GeneratedPresentation => ({ status: "generated", language: "zh-CN", capabilities: [{ id: "capability-1", name: "新分组", summary: "s", featureNames: ["A", "B", "C", "D"] }], journeys: journeys.map((journey, index) => ({ id: `journey-${index + 1}`, name: journey.name, tier: "headline" as const, capabilityNames: [], steps: journey.steps })), coverage: { featuresTotal: 4, featuresInJourneys: 0, scenariosInJourneys: 0 }, passes: 3 });

  it("unions both versions and only ever grows coverage", () => {
    const merged = mergePresentation({
      previous: previousOf([{ name: "上一版旅程一", steps: [step("A"), step("B")] }, { name: "上一版旅程二", steps: [step("A"), step("C")] }]),
      next: nextOf([
        { name: "和上一版一模一样", steps: [step("A"), step("B")] },
        { name: "这次的新旅程", steps: [step("C"), step("D")] },
        { name: "只是上一版的子片段", steps: [step("A")] },
      ]),
      ledger: leafLedger(),
    });
    // 重复的那条与不成旅程的单步被去重；两条旧旅程保留，新旅程并入
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["上一版旅程一", "上一版旅程二", "这次的新旅程"]);
    expect(merged.coverage.featuresInJourneys).toBe(4);
    // 分组用本次的新归组
    expect(merged.capabilities[0].name).toBe("新分组");
    expect(merged.status).toBe("generated");
    // 上一版旅程的标签按当前归组重算（它们入参里没有标签，也不该带着旧分组的名字）
    expect(merged.journeys.find((journey) => journey.name === "上一版旅程二")!.capabilityNames).toEqual(["新分组"]);
  });

  it("drops previous journeys whose scenarios no longer exist in the current spec", () => {
    const merged = mergePresentation({
      previous: previousOf([{ name: "引用已失效", steps: [step("A"), step("已被删除的功能")] }]),
      next: nextOf([{ name: "新旅程", steps: [step("A"), step("B")] }]),
      ledger: leafLedger(),
    });
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["新旅程"]);
  });

  it("reserves a third of the journey budget for newly generated journeys", () => {
    const pairs = [["A", "B"], ["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"], ["C", "D"]];
    const journeys = (prefix: string, indexes: number[]) => indexes.map((index) => ({ name: `${prefix}${index}`, steps: [step(pairs[index][0]), step(pairs[index][1])] }));
    const merged = mergePresentation({ previous: previousOf(journeys("旧", [0, 1, 2, 3, 4])), next: nextOf(journeys("新", [4, 5, 0])), ledger: leafLedger(), maxJourneys: 6 });
    // 上一版最多占 4 个名额；本次产出的前两条（4、5）是新的、第三条（0）与上一版重复：名额留给新场景，重复被去重
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["旧0", "旧1", "旧2", "旧3", "新4", "新5"]);
    expect(merged.journeys).toHaveLength(6);
  });

  it("keeps the previous capability groups when this run produced none", () => {
    const merged = mergePresentation({ previous: previousOf([{ name: "上一版旅程", steps: [step("A"), step("B")] }]), next: { ...nextOf([]), capabilities: [] }, ledger: leafLedger() });
    expect(merged.capabilities[0].name).toBe("旧分组");
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["上一版旅程"]);
  });

  it("keeps the headline version when both versions hold the same feature combination", () => {
    // 典型场景先于能力场景接纳：同一走法若上一版是能力场景、这次成了典型场景，留下的是典型场景（它才会出现在「全局典型」里）
    const previous = { ...previousOf([]), journeys: [{ id: "journey-1", name: "旧的能力场景", tier: "capability" as const, capabilityNames: [], steps: [step("A"), step("B")] }] };
    const merged = mergePresentation({ previous, next: nextOf([{ name: "新的典型场景", steps: [step("A", "HP-2"), step("B")] }]), ledger: leafLedger() });
    expect(merged.journeys.map((journey) => [journey.name, journey.tier])).toEqual([["新的典型场景", "headline"]]);
  });

  it("drops previous journeys that only chain scenarios of one feature when they are re-validated", () => {
    // 首轮生成（还没有「相邻两步不同功能」校验时）留下的旧格式条目：合并时按当前规则重新校验，自动清掉，不需要单独的数据清理
    const previous = previousOf([{ name: "旧格式：罗列同一功能的变体", steps: [step("A"), step("A", "HP-2"), step("B")] }]);
    const merged = mergePresentation({ previous, next: nextOf([{ name: "这次的新旅程", steps: [step("C"), step("D")] }]), ledger: leafLedger() });
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["这次的新旅程"]);
  });

  it("keeps a journey that chains scenarios of one feature when the product has only that one feature", () => {
    // 单功能产品的旅程只能在同一个功能里串场景，不算罗列
    const single: PresentationLedger = { ...leafLedger(), features: [feature(1, "A")], scenarios: [scenario(1, "HP-1"), scenario(1, "HP-2")] };
    const merged = mergePresentation({ previous: { capabilities: [], journeys: [] }, next: { ...nextOf([{ name: "单功能里的两步", steps: [step("A", "HP-1"), step("A", "HP-2")] }]), capabilities: [] }, ledger: single });
    expect(merged.journeys.map((journey) => journey.name)).toEqual(["单功能里的两步"]);
  });
});

describe("journey mining prompt", () => {
  it("carries the no-new-facts contract and only candidate scenarios", () => {
    const prompt = journeyMiningPrompt({
      productDescription: "产品简介",
      capabilityName: "采集与转写",
      maxJourneys: 6,
      candidates: [{ featureName: "A", reference: "HP-1", context: "c", action: "a", outcome: "o" }],
    }, "zh-CN");
    expect(prompt).toContain("不得新增事实");
    expect(prompt).toContain("逐字取自候选列表");
    expect(prompt).toContain("最多返回 6 条旅程");
    expect(prompt).toContain("所属能力：采集与转写");
    // 判重口径写进提示词：从源头少产重复，别拿同一组功能换着场景编号凑数
    expect(prompt).toContain("同一组功能只写一条旅程");
    const english = journeyMiningPrompt({ productDescription: "d", capabilityName: null, maxJourneys: 5, candidates: [] }, "en");
    expect(english).not.toContain("Capability:");
    expect(english).toContain("one journey per combination of features");
    expect(parseJourneyCandidates('```json\n{"journeys":[{"name":"x","steps":[{"featureName":"A","reference":"HP-1"}]}]}\n```')).toEqual([{ name: "x", steps: [{ featureName: "A", reference: "HP-1" }] }]);
  });
});

// ── 调度 ──

interface FakeDb {
  /** 产品由谁来分析。client：理解层随客户端的提案一起交上来，服务端不重生成。 */
  analysisExecutor?: "server" | "client";
  /** 产品所属的工作区，和它有没有自己的模型配置。没有模型，服务端不替它调模型。 */
  organizationId?: number;
  modelConfigured?: boolean;
  /** never_generated=1 表示从未成功过；缺省字段按「已有内容」补齐。 */
  state: { fingerprint: string; pending: number; interval_elapsed: number; never_generated?: number; failure_count?: number; retry_due?: number } | null;
  leaseAffected: number;
  due: number[];
  /** 上一版落库的理解层（JSON 列原文；null = 尚未生成过）。 */
  previous: { capabilities: string; journeys: string } | null;
  saved: Array<string | number | null> | null;
  failures: Array<Array<string | number | null>>;
  deferrals: Array<Array<string | number | null>>;
  cleared: number;
}

const WORKSPACE_MODEL = { baseUrl: "https://api.example/v1", apiKey: "sk-workspace", model: "k3-256k" };

beforeAll(() => vi.stubEnv("SESSION_SECRET", "presentation-test-secret"));

/** 按语句片段路由的假执行器：覆盖调度器会发出的每一条 SQL。 */
function fakeDb(db: Partial<FakeDb> = {}): FakeDb & { execute: Execute & ReturnType<typeof vi.fn> } {
  const ledger = leafLedger();
  const state: FakeDb = {
    state: { fingerprint: "", pending: 0, interval_elapsed: 1, never_generated: 1 },
    analysisExecutor: "server",
    organizationId: 7,
    modelConfigured: true,
    leaseAffected: 1,
    due: [],
    previous: null,
    saved: null,
    failures: [],
    deferrals: [],
    cleared: 0,
    ...db,
  };
  // 带类型的 mock 直接当 Execute 用会被 TS 拒（mock 实例带构造签名），显式标注为二者交集。
  const execute = vi.fn(async (sql: string, params: Array<string | number | null> = []) => {
    // 读账本的那一条（扫描的候选查询里也提到 products p，按 SELECT 的开头区分）。
    if (sql.includes("SELECT p.name, p.description")) {
      return [[{ name: ledger.name, description: ledger.description, output_language: "zh-CN", analysis_executor: state.analysisExecutor, organization_id: state.organizationId, modelConfigured: state.modelConfigured ? 1 : 0 }]];
    }
    // 工作区自己的模型配置（库里是密文）。没配就是没有这一行。
    if (sql.includes("FROM organization_models WHERE organization_id")) {
      return [state.modelConfigured ? [{ base_url: WORKSPACE_MODEL.baseUrl, api_key_encrypted: encryptSecret(WORKSPACE_MODEL.apiKey, "presentation-test-secret"), model: WORKSPACE_MODEL.model }] : []];
    }
    if (sql.includes("FROM features WHERE product_id")) return [ledger.features];
    if (sql.includes("FROM scenarios WHERE active")) return [ledger.scenarios];
    if (sql.includes("FROM releases WHERE product_id")) return [[{ spec_version_id: 7 }]];
    if (sql.includes("SELECT capabilities_json, journeys_json, tagline")) return [state.previous ? [{ capabilities_json: state.previous.capabilities, journeys_json: state.previous.journeys, tagline: null }] : []];
    if (sql.includes("SELECT fingerprint, pending")) return [state.state ? [{ never_generated: 0, failure_count: 0, retry_due: 1, ...state.state }] : []];
    // UPDATE 的返回形态与 mysql2 一致：[ResultSetHeader, undefined]
    if (sql.includes("SET lease_until")) return [{ affectedRows: state.leaseAffected }];
    if (sql.includes("INSERT INTO product_presentations (product_id, spec_version_id")) { state.saved = params; return [{ affectedRows: 1 }]; }
    if (sql.includes("failure_count = failure_count + 1")) { state.failures.push(params); return [{ affectedRows: 1 }]; }
    if (sql.includes("SET pending = 1, pending_fingerprint")) { state.deferrals.push(params); return [{ affectedRows: 1 }]; }
    if (sql.includes("SET pending = 0, pending_fingerprint = NULL")) { state.cleared += 1; return [{ affectedRows: 1 }]; }
    if (sql.includes("SELECT product_id FROM product_presentations")) return [state.due.map((id) => ({ product_id: id }))];
    return [[]];
  });
  return Object.assign(state, { execute: execute as unknown as Execute & typeof execute });
}

describe("presentation refresh scheduling", () => {
  it("loads the ledger and derives the spec version from the latest release", async () => {
    const db = fakeDb();
    const ledger = await loadPresentationLedger(db.execute, 1);
    expect(ledger).not.toBeNull();
    expect(ledger).toMatchObject({ productId: 1, language: "zh-CN", specVersionId: 7, organizationId: 7, modelConfigured: true });
    expect(ledger!.features.map((feature) => feature.name)).toEqual(["A", "B", "C", "D"]);
    expect(ledger!.scenarios).toHaveLength(9);
    expect(presentationLedgerFingerprint(ledger!)).toMatch(/^[0-9a-f]{64}$/);
    db.execute.mockResolvedValue([[]]);
    expect(await loadPresentationLedger(db.execute, 1)).toBeNull();
    // 读不到「有没有模型」这一列时按没有算：宁可不让生成，也不替工作区用 CoDelphi 的模型。
    db.execute.mockResolvedValueOnce([[{ name: "x", description: "", output_language: "zh-CN", analysis_executor: "server", organization_id: 7 }]]);
    expect(await loadPresentationLedger(db.execute, 1)).toMatchObject({ modelConfigured: false });
    // SQL 里就带着「工作区有没有自己的模型」。
    expect(String(db.execute.mock.calls.find(([sql]) => String(sql).includes("SELECT p.name, p.description"))?.[0])).toContain("FROM organization_models m WHERE m.organization_id = p.organization_id");
  });

  it("generates on first sight and persists fingerprint, payload and metadata", async () => {
    const db = fakeDb();
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, billing: { runId: 5, accountId: 1, chargeComponent: "main" }, background: false, execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(result.outcome).toBe("generated");
    // 归组提示词拿不到合法输出 → 回退平铺卡片；旅程照常挖出
    expect(result.detail).toMatchObject({ status: "partial", journeys: 1, passes: 2 });
    expect(db.saved).not.toBeNull();
    const [productId, specVersionId, language, status, source, , capabilitiesJson, journeysJson, coverageJson, fingerprint] = db.saved!;
    expect([productId, specVersionId, language, status, source]).toEqual([1, 7, "zh-CN", "partial", "generated"]);
    expect(JSON.parse(String(capabilitiesJson))).toEqual([]);
    expect(JSON.parse(String(journeysJson))[0]).toMatchObject({ name: "挖掘旅程", tier: "headline" });
    expect(fingerprint).toBe(presentationLedgerFingerprint(leafLedger()));
    expect(JSON.parse(String(coverageJson))).toEqual({ featuresTotal: 4, featuresInJourneys: 2, scenariosInJourneys: 2 });
    // 同步路径下调度器自己领取了租约
    expect(db.execute.mock.calls.some(([sql]) => sql.includes("SET lease_until") && sql.includes("INTERVAL ? MINUTE"))).toBe(true);
  });

  it("makes no model call when the spec fingerprint is unchanged and clears a leftover pending flag", async () => {
    const db = fakeDb();
    db.state = { fingerprint: presentationLedgerFingerprint(leafLedger()), pending: 1, interval_elapsed: 0 };
    const model = client(() => miningAnswer([oneJourney]));
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: model });
    expect(result).toEqual({ outcome: "unchanged" });
    expect(model.complete).not.toHaveBeenCalled();
    expect(db.cleared).toBe(1);
  });

  it("only marks the presentation pending when the refresh interval has not elapsed", async () => {
    const db = fakeDb({ state: { fingerprint: "old", pending: 0, interval_elapsed: 0 } });
    const model = client(() => miningAnswer([oneJourney]));
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: model });
    expect(result).toEqual({ outcome: "deferred", reason: "within_refresh_interval" });
    expect(model.complete).not.toHaveBeenCalled();
    expect(db.deferrals).toEqual([[presentationLedgerFingerprint(leafLedger()), 24, 1]]);
    expect(db.saved).toBeNull();
  });

  it("regenerates immediately when forced even inside the interval", async () => {
    const db = fakeDb({ state: { fingerprint: "old", pending: 0, interval_elapsed: 0 } });
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(db.deferrals).toEqual([]);
  });

  /** 一条 A→B 的典型旅程：作为「上一版」落库内容。 */
  const storedOneJourney = { capabilities: "[]", journeys: JSON.stringify([{ name: "上一版的甲", tier: "headline", capabilityNames: [], steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] }]) };

  it("replaces the previous journeys on a forced regeneration when the fresh result covers at least the still-valid part", async () => {
    // 手动「重新生成」要的是按当前规则重来一遍，不是往旧内容上叠加。
    // 上一版里罗列同一功能多条场景的旧格式条目按当前规则已不成立，不算进「不输」的基准——
    // 否则合并出来的并集几乎总是更宽，全新的结果永远替换不了，旧格式的条目会一直留着。
    const db = fakeDb({ previous: { capabilities: "[]", journeys: JSON.stringify([
      { name: "上一版的甲", tier: "headline", capabilityNames: [], steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] },
      { name: "旧格式：罗列同一功能的场景", tier: "capability", capabilityNames: [], steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "A", reference: "HP-2" }, { featureName: "C", reference: "HP-1" }] },
    ]) } });
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(result.detail).toMatchObject({ journeys: 1, replaced: true, coveredFeatures: 2 });
    expect(JSON.parse(String(db.saved![7])).map((journey: { name: string }) => journey.name)).toEqual(["挖掘旅程"]);
  });

  it("falls back to merging on a forced regeneration when the fresh result covers less than before", async () => {
    // 模型输出有波动：这次挖得更少时不能让「重新生成」把使用场景变少
    const db = fakeDb({ previous: { capabilities: "[]", journeys: JSON.stringify([
      { name: "上一版的甲", tier: "headline", capabilityNames: [], steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] },
      { name: "上一版的乙", tier: "capability", capabilityNames: [], steps: [{ featureName: "C", reference: "HP-1" }, { featureName: "D", reference: "HP-1" }] },
    ]) } });
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(result.detail).toMatchObject({ journeys: 3, replaced: false, coveredFeatures: 4 });
    // 合并时两版的全局典型场景排在能力场景之前
    expect(JSON.parse(String(db.saved![7])).map((journey: { name: string }) => journey.name)).toEqual(["上一版的甲", "挖掘旅程", "上一版的乙"]);
  });

  it("merges with the previous journeys on an automatic refresh even when the fresh result covers as much", async () => {
    // 自动刷新（分析钩子 / sweep）只增不减：模型输出有波动，合并保证覆盖率不下降
    const db = fakeDb({ previous: storedOneJourney, state: { fingerprint: "old", pending: 1, interval_elapsed: 1, never_generated: 0 } });
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: client(() => miningAnswer([
      oneJourney,
      { name: "换个编号的同一走法", steps: [{ featureName: "A", reference: "HP-2" }, { featureName: "B", reference: "HP-1" }] },
    ])) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(result.detail).toMatchObject({ journeys: 2, replaced: false });
    // 上一版的旅程留在前面；本次的「换个编号」与它经过同一组功能，按重复折叠
    expect(JSON.parse(String(db.saved![7])).map((journey: { name: string }) => journey.name)).toEqual(["上一版的甲", "挖掘旅程"]);
  });

  it("defers without touching state when another generation holds the lease", async () => {
    const db = fakeDb({ state: { fingerprint: "old", pending: 1, interval_elapsed: 1 }, leaseAffected: 0 });
    const model = client(() => miningAnswer([oneJourney]));
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: model });
    expect(result).toEqual({ outcome: "deferred", reason: "generation_in_progress" });
    expect(model.complete).not.toHaveBeenCalled();
    expect(db.saved).toBeNull();
    expect(db.deferrals).toEqual([]);
  });

  it("returns while a background refresh is still running", async () => {
    const db = fakeDb();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = () => resolve(); });
    const model = client(async (messages) => {
      if (isMining(messages)) await gate;
      return miningAnswer([oneJourney]);
    });
    const result = await schedulePresentationRefresh({ productId: 1, execute: db.execute, client: model });
    expect(result.outcome).toBe("generating");
    expect(db.saved).toBeNull();
    open();
    await vi.waitFor(() => expect(db.saved).not.toBeNull());
  });

  it("keeps the previous content and schedules a retry when generation fails", async () => {
    const db = fakeDb();
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: client(async () => { throw new Error("AI gateway returned HTTP 500"); }) });
    restore();
    expect(result).toEqual({ outcome: "failed", reason: "AI gateway returned HTTP 500" });
    expect(db.saved).toBeNull();
    // 从未成功过的产品前 3 次 1 小时后重试（之后每天）；SQL 按行自身是否已有内容与失败次数决定（已有内容 → 24h）
    expect(db.failures).toEqual([[3, 60, 24, "AI gateway returned HTTP 500", 1]]);
    // 退避档位由 SQL 按行自身状态决定：有内容 → 每天；从未成功且含本次失败未到上限 → 1 小时
    expect(db.execute.mock.calls.find(([sql]) => String(sql).includes("failure_count = failure_count + 1"))![0]).toContain("INTERVAL IF(generated_at IS NULL AND failure_count + 1 <= ?, ?, ? * 60) MINUTE");
  });

  /** 上一版落库内容：两条旅程，其中一条的引用在当前规格里已不存在。 */
  const storedPresentation = {
    capabilities: JSON.stringify([{ name: "旧分组", summary: "s", featureNames: ["A", "B"] }]),
    journeys: JSON.stringify([
      { name: "上一版保留的旅程", tier: "headline", capabilityNames: [], steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-1" }] },
      { name: "引用已失效的旧旅程", tier: "capability", capabilityName: "旧分组", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "已被删除的功能", reference: "HP-1" }] },
    ]),
  };

  it("backs off a product that has never generated successfully after repeated failures", async () => {
    // 连续失败已到上限、排定的重试时间未到：只保留排期，不花模型调用，也不把重试时间往后推
    const db = fakeDb({ state: { fingerprint: "", pending: 1, interval_elapsed: 1, never_generated: 1, failure_count: 3, retry_due: 0 } });
    const model = client(() => miningAnswer([oneJourney]));
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: model });
    expect(result).toEqual({ outcome: "deferred", reason: "failure_backoff" });
    expect(model.complete).not.toHaveBeenCalled();
    expect(db.execute.mock.calls.find(([sql]) => String(sql).includes("SET pending = 1, pending_fingerprint"))![0]).toContain("COALESCE(next_attempt_at,");
    // 上限之内（第 1、2 次失败后）或排期已到：照常尝试
    for (const stillFast of [{ failure_count: 2, retry_due: 0 }, { failure_count: 3, retry_due: 1 }, { failure_count: 9, retry_due: 1 }]) {
      const fresh = fakeDb({ state: { fingerprint: "", pending: 1, interval_elapsed: 1, never_generated: 1, ...stillFast } });
      const restore = silenceConsole();
      const outcome = await schedulePresentationRefresh({ productId: 1, background: false, execute: fresh.execute, client: client(() => miningAnswer([oneJourney])) });
      restore();
      expect(outcome.outcome).toBe("generated");
    }
    // 手动强制不受退避限制
    const forcedDb = fakeDb({ state: { fingerprint: "", pending: 1, interval_elapsed: 1, never_generated: 1, failure_count: 3, retry_due: 0 } });
    const restore = silenceConsole();
    expect((await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: forcedDb.execute, client: client(() => miningAnswer([oneJourney])) })).outcome).toBe("generated");
    restore();
  });

  it("treats a run that produced nothing valid as a failure instead of saving an empty presentation", async () => {
    const db = fakeDb({ previous: storedPresentation });
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: client((messages) => (isMining(messages) ? miningAnswer([]) : "not json")) });
    restore();
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("NO_VALID_OUTPUT");
    // 已有的能力分组与旅程原样保留，没有被空结果冲掉
    expect(db.saved).toBeNull();
    expect(db.failures).toHaveLength(1);
  });

  it("keeps the previous journeys when a regeneration comes back with none of its own", async () => {
    const db = fakeDb({ previous: storedPresentation });
    const restore = silenceConsole();
    // 归组成功但没有任何旅程（归组不带典型旅程、每一趟挖掘都空手而归——模型输出波动的常见形态）
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: client((messages) => (isMining(messages) ? miningAnswer([]) : groupingWithoutJourneys)) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(result.detail).toMatchObject({ journeys: 1, keptFromPrevious: 2, freshlyGenerated: 0 });
    // 上一版里引用仍然成立的那条留下；引用已失效的那条被合并时的校验剔除
    expect(JSON.parse(String(db.saved![7])).map((journey: { name: string }) => journey.name)).toEqual(["上一版保留的旅程"]);
  });

  it("accepts a first-time partial result when nothing existed before", async () => {
    const db = fakeDb();
    const restore = silenceConsole();
    const result = await schedulePresentationRefresh({ productId: 1, background: false, execute: db.execute, client: client((messages) => (isMining(messages) ? miningAnswer([]) : groupingWithoutJourneys)) });
    restore();
    expect(result.outcome).toBe("generated");
    expect(result.detail).toMatchObject({ status: "partial", capabilities: 2, journeys: 0 });
  });

  it("skips products without features or that do not exist", async () => {
    const db = fakeDb();
    db.execute.mockImplementation(async (sql: string) => (sql.includes("FROM features WHERE product_id") ? [[]] : [[{ name: "x", description: "", output_language: "zh-CN" }]]));
    expect(await schedulePresentationRefresh({ productId: 1, execute: db.execute })).toEqual({ outcome: "skipped", reason: "no_features" });
    db.execute.mockResolvedValue([[]]);
    expect(await schedulePresentationRefresh({ productId: 2, execute: db.execute })).toEqual({ outcome: "skipped", reason: "product_not_found" });
  });

  it("sweep picks due pending products and refreshes them one by one", async () => {
    const db = fakeDb({ due: [3, 4], state: { fingerprint: "old", pending: 1, interval_elapsed: 1 } });
    const restore = silenceConsole();
    const summary = await runPresentationRefreshSweepOnce({ execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(summary).toEqual({ due: 2, generated: 2, failed: 0, deferred: 0 });
    const sweepQuery = db.execute.mock.calls.find(([sql]) => sql.includes("SELECT product_id FROM product_presentations"))!;
    expect(sweepQuery[0]).toContain("next_attempt_at <= CURRENT_TIMESTAMP(3)");
    expect(sweepQuery[0]).toContain("lease_until <= CURRENT_TIMESTAMP(3)");
    expect(sweepQuery[1]).toEqual([2]);
    expect(db.execute.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO product_presentations (product_id, spec_version_id"))).toHaveLength(2);
  });

  it("never generates for a workspace that has no model of its own: the sweep leaves the product out and a forced refresh is skipped", async () => {
    const db = fakeDb({ modelConfigured: false, state: { fingerprint: "old", pending: 1, interval_elapsed: 1 }, due: [1] });
    const model = client(() => miningAnswer([oneJourney]));
    const forced = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: model });
    const summary = await runPresentationRefreshSweepOnce({ execute: db.execute, client: model });
    expect(forced).toEqual({ outcome: "skipped", reason: "model_not_configured" });
    // 扫描的候选查询就把它排除了；即使别的路径把它送进来，上面那一关也会拦住，模型一次都不调。
    expect(db.execute.mock.calls.find(([sql]) => sql.includes("SELECT product_id FROM product_presentations"))![0]).toContain("FROM organization_models");
    expect(summary.generated).toBe(0);
    expect(model.complete).not.toHaveBeenCalled();
    expect(db.execute.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO product_presentations"))).toHaveLength(0);
  });

  it("generates inside the workspace's own model and records that model with the result", async () => {
    const db = fakeDb();
    const restore = silenceConsole();
    const seen: unknown[] = [];
    const model = client(() => {
      seen.push(currentOrganizationModel());
      return miningAnswer([oneJourney]);
    });
    const result = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: model });
    restore();
    expect(result.outcome).toBe("generated");
    // 每一次模型调用的时候，范围内绑着的都是这个工作区自己的地址、key 和模型。
    expect(seen.length).toBeGreaterThan(0);
    for (const bound of seen) expect(bound).toMatchObject({ organizationId: 7, ...WORKSPACE_MODEL });
    // 落库记的是实际用的模型，不是服务器自己的 AI_MODEL。
    expect(db.saved![10]).toBe(WORKSPACE_MODEL.model);
    // 出了生成的范围，绑定也就没有了。
    expect(currentOrganizationModel()).toBeNull();
  });

  it("never regenerates the presentation of a client-analysed product: the client supplies it with each proposal", async () => {
    const db = fakeDb({ analysisExecutor: "client", state: { fingerprint: "old", pending: 1, interval_elapsed: 1 }, due: [1] });
    const restore = silenceConsole();
    const forced = await schedulePresentationRefresh({ productId: 1, force: true, background: false, execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    const summary = await runPresentationRefreshSweepOnce({ execute: db.execute, client: client(() => miningAnswer([oneJourney])) });
    restore();
    expect(forced).toEqual({ outcome: "skipped", reason: "client_analysed" });
    // 扫描的候选查询就把这种产品排除了；即使别的路径把它送进来，上面那一关也会拦住，模型一次都不调。
    expect(db.execute.mock.calls.find(([sql]) => sql.includes("SELECT product_id FROM product_presentations"))![0]).toContain("analysis_executor = 'client'");
    expect(summary.generated).toBe(0);
    expect(db.execute.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO product_presentations"))).toHaveLength(0);
  });
});
