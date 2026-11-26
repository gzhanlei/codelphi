import type { OutputLanguage } from "./analysis-language";

/**
 * 客户端分析的提示词策略（修订稿 §4.2、§5.4）。
 *
 * 客户端交上来的提案不能带源码，所以客户端发给模型的每个提示词都加一条硬约束：不输出源码行、代码块、代码摘录，
 * 标识符只在指明行为位置时出现。托管分析不传这个开关，提示词一个字节都不变。
 * 约束的措辞改了就升版本号；版本号随提案上报（client.promptVersion），账本上能查到某一版是哪个提示词产出的。
 */
export const CLIENT_PROMPT_VERSION = "2026-11-27.1";

export function noSourceOutputRule(language: OutputLanguage): string {
  return language === "en"
    ? "Never reproduce source code in your answer: no source lines, no code blocks, no excerpts, and no pseudo-code that keeps the operators and identifiers of the original. Describe behaviour in plain words. Identifiers such as function names, environment variable names and file paths may appear only to point at where the behaviour lives."
    : "回答里不得出现源码：不要写源码行、代码块或代码摘录，也不要把源码改写成保留原运算符和标识符的伪代码。用平实的文字描述行为。函数名、环境变量名、文件路径这类标识符只在指明行为位置时出现。";
}

/** 给一个提示词加上这条约束。没要求加就原样返回。 */
export function withNoSourceOutput(prompt: string, language: OutputLanguage, enabled: boolean | undefined): string {
  return enabled ? `${prompt}\n${noSourceOutputRule(language)}` : prompt;
}
