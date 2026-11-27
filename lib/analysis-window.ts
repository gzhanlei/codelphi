import type { ChangeContext } from "./code-hosting";

export interface AnalysisWindow {
  /** 进提示词的变更文件。规划器排除的文件不在里面：模型没读过它们，也不该为它们写变化。 */
  change: ChangeContext;
  /** 行为枚举要逐个问的文件。 */
  behavioralPaths: string[];
  /** 增量提示词里「没归属到既有功能的行为变更文件」。 */
  unassignedBehavioralPaths: string[] | undefined;
}

/**
 * 把规划器的排除结果用到分析窗口上。
 *
 * 规划器不装配的文件有四类（lib/slice-planner）：拷进来的上游项目、开发工具目录里没被启动文件点到的、
 * 内容和已装配文件相同的、文件头写着生成的。它们不改产品行为，却可能就在这次推送的 diff 里。
 * 留在变更文件清单里，模型就会给一个它没读过的脚本写一条「变化」；留在证据允许集里，就是给它一张
 * 引用没读过的文件的许可证。所以提示词、允许集和行为枚举看到的都是去掉它们之后的窗口。
 * 覆盖率的分母另行处理（lib/analysis-coverage.ts）。
 */
export function analysisWindow(input: {
  change: ChangeContext;
  behavioralPaths: readonly string[];
  unassignedBehavioralPaths: readonly string[] | undefined;
  excludedPaths: ReadonlySet<string>;
}): AnalysisWindow {
  if (input.excludedPaths.size === 0) {
    return { change: input.change, behavioralPaths: [...input.behavioralPaths], unassignedBehavioralPaths: input.unassignedBehavioralPaths === undefined ? undefined : [...input.unassignedBehavioralPaths] };
  }
  const keep = (path: string) => !input.excludedPaths.has(path);
  return {
    change: { ...input.change, files: input.change.files.filter((file) => keep(file.path)) },
    behavioralPaths: input.behavioralPaths.filter(keep),
    unassignedBehavioralPaths: input.unassignedBehavioralPaths?.filter(keep),
  };
}
