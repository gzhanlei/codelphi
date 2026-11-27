/**
 * 切片选择策略：把「行为承载源码」与「噪声」（测试/文档/示例/基准/配置/CI/迁移脚本/构建和部署文件/
 * 生成的代码/第三方副本）区分开。
 *
 * 哪些路径是噪声，只有一处定义：lib/analysis-target.ts。推送窗口、变更文件清单、覆盖率的分母、
 * 影响分类问的也是它，所以这里不再自己列规则，只回答「这个目录要不要走进去」。
 *
 * 生产事故证据（docs/first-analysis-coverage-2026-11-08.md，2026-11-08 五仓库实测）：
 * 文件名信号启发式（manifest/entrypoint/route/auth）被噪声命名骗过——`test/app.route.js`
 * 撞上 route 信号、`bench/*.ts` 是代码扩展名兜底 service 信号——express 窗口无 lib/、
 * zod 无 src/、hono 仅 adapters/、cal.com 仅 configs。信号仍负责「想看什么」，
 * 本策略负责「不看什么」；两者正交，信号判定保持不变。
 */
import { analysisNoiseKind, isBuildManifest, type AnalysisNoiseKind } from "../analysis-target";

export type SelectionNoiseKind = AnalysisNoiseKind;

/** 构建清单：栈识别的依据。readme/agents.md 不在白名单（那是文档）。 */
export function isSelectionManifest(path: string) {
  return isBuildManifest(path);
}

/**
 * 目录级噪声：整目录跳过（遍历不再进入）。隐藏目录（`.github` 等）按 CI 噪声处理。
 * 判断的办法是看「这个目录里随便一个文件」会不会因为它所在的目录被判成噪声。
 */
export function isWalkNoiseDirectory(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment.startsWith("."))) return true;
  return analysisNoiseKind(`${path}/file.z`) !== null;
}

/**
 * 文件级噪声分类；返回 null = 可入选窗口。
 * 目录规则先于清单：测试目录里的 package.json 是测试夹具，不是这个产品的清单。
 */
export function selectionNoiseKind(path: string): SelectionNoiseKind | null {
  return analysisNoiseKind(path);
}
