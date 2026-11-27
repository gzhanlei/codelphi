import type { ExclusionGroup } from "../slice-planner/exclusions";

type Text = { zh: string; en: string };

/** 最多点名 5 个目录或工具，其余归进省略号。 */
const maxNamed = 5;

function named(subjects: readonly string[], language: "zh" | "en"): string {
  if (subjects.length === 0) return "";
  const shown = subjects.length <= maxNamed ? subjects.join(", ") : `${subjects.slice(0, maxNamed).join(", ")} ${language === "en" ? "..." : "…"}`;
  return language === "en" ? ` (${shown})` : `（${shown}）`;
}

/**
 * 规划器排除摘要（lib/slice-planner/exclusions.ts）给发布命令的输出用：
 * 发布的人要一眼看出这一轮没读什么、为什么，才知道账本里缺的那块是有意不读，而不是读漏了。
 */
export function exclusionsText(groups: readonly ExclusionGroup[]): Text | null {
  if (groups.length === 0) return null;
  const part = (group: ExclusionGroup, language: "zh" | "en"): string => {
    // 重复文件的「主体」是保留下来的那份，列出来没有意义：只报个数。
    const list = group.kind === "duplicate" ? "" : named(group.subjects, language);
    const text: Text = {
      vendored: { zh: `第三方代码的副本 ${group.count} 个目录`, en: `${group.count} directories holding a copy of someone else's project` },
      tooling: { zh: `开发工具目录里的文件 ${group.count} 个`, en: `${group.count} development tooling files` },
      generated: { zh: `生成的代码 ${group.count} 个`, en: `${group.count} generated files` },
      duplicate: { zh: `内容重复的文件 ${group.count} 个`, en: `${group.count} duplicate files` },
    }[group.kind];
    return language === "en" ? `${text.en}${list}` : `${text.zh}${list}`;
  };
  return {
    zh: `不进分析：${groups.map((group) => part(group, "zh")).join("；")}。`,
    en: `Left out of the analysis: ${groups.map((group) => part(group, "en")).join("; ")}.`,
  };
}
