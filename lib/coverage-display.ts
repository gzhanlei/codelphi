/**
 * 覆盖率展示口径（设计 §9）：唯一入口，概览信任行与规格工作台共用，
 * 避免两处文案与算法漂移。覆盖率 = implBytesAssembled / implBytesTotal（按文件字节），
 * 文件数量是独立事实，不得从文件数推算百分比，不得改名为「规格正确率」类结论性指标。
 */
import { pick, type UiLocale } from "./ui-locale";
import { COVERAGE } from "./ui-strings/product";

interface CoverageReceiptShape {
  coverageRatio: number;
  implFilesAssembled: number;
  implFilesTotal: number;
}

/** 字节口径百分比，固定一位小数（0.121 → "12.1%"）。 */
export function coveragePercent(receipt: CoverageReceiptShape) {
  return `${(receipt.coverageRatio * 100).toFixed(1)}%`;
}

/** 显式声明字节口径，防止读者把比例误读成文件数占比或结论正确率。 */
export function coverageByteLabel(receipt: CoverageReceiptShape, locale: UiLocale = "zh-CN") {
  return `${pick(locale, COVERAGE.byteLabel)}${coveragePercent(receipt)}`;
}

/** 已装配实现文件数：独立于字节比例的第二个事实，并排展示但不合成百分比。 */
export function coverageFilesLabel(receipt: CoverageReceiptShape, locale: UiLocale = "zh-CN") {
  return pick(locale, COVERAGE.filesLabel).replace("{assembled}", String(receipt.implFilesAssembled)).replace("{total}", String(receipt.implFilesTotal));
}

/**
 * 覆盖率口径解释：主动回答读者看到低百分比时的两个疑问——为什么不足 100%（按预算分趟读取，
 * 设计内行为）与单条结论可信度看什么（随附源码证据链接，不看这个比例）。概览信任行与规格
 * 工作台披露行共用，避免解释漂移。
 */
export function coverageExplainer(locale: UiLocale = "zh-CN") {
  return pick(locale, COVERAGE.explainer);
}
