/**
 * 语种感知工具（英文输出模式的地基）：等价判定/否定词/邻近否定按文本语种分流。
 * 中文专用通道（否定字「不无没未非莫勿」、「不再」邻近）在纯英文文本上静默失效——
 * 英文模式必须走对应的英文规则，否则变体折叠门禁与一致性核验对英文输出失明。
 * 跨语种判定用「单侧含 CJK」：语言切换 run 的旧语种条目与新语种条目一律判不等，
 * 杜绝跨语言折叠；混合文本（如「demo 访客」vs「演示访客」）两侧都含 CJK，不走
 * 跨语种分支，保持既有中文折叠行为。
 */

const CJK = /[\u4e00-\u9fa5]/;
const CJK_NEGATION = /[不无没未非莫勿]/g;
const LATIN_NEGATION = /\b(?:not|no|never|nothing|neither|nor|without|cannot|can't|won't|doesn't|don't|isn't|aren't|wasn't|weren't|didn't|shouldn't|couldn't|wouldn't|hasn't|haven't)\b/gi;
const CJK_NEGATION_NEAR = "不再";
const CJK_PUNCT = /[。；！？→，、]/;
const LATIN_PUNCT = /[.;!?]/;
/** 英文否定词邻近窗口（字符）：英文单词比中文长，中文沿用 16 字符口径。 */
const CJK_NEAR_WINDOW = 16;
const LATIN_NEAR_WINDOW = 24;

export function hasCjk(text: string) {
  return CJK.test(text);
}

export function crossLanguageText(left: string, right: string) {
  return hasCjk(left) !== hasCjk(right);
}

export function negationCountOf(text: string) {
  if (hasCjk(text)) return (text.match(CJK_NEGATION) ?? []).length;
  return (text.match(LATIN_NEGATION) ?? []).length;
}

/** 否定性陈述判定：否定词紧邻 token（中间无句读）——「不再返回 422」/「no longer returns 422」
 *  为否定，「重试失败，但不是返回 422」（否定的是别的动作）不算。 */
export function isNegatedNearToken(outcome: string, token: string): boolean {
  const index = outcome.indexOf(token);
  if (index === -1) return false;
  const windowSize = hasCjk(outcome) ? CJK_NEAR_WINDOW : LATIN_NEAR_WINDOW;
  const window = outcome.slice(Math.max(0, index - windowSize), index);
  if (hasCjk(window)) {
    const at = window.lastIndexOf(CJK_NEGATION_NEAR);
    if (at === -1) return false;
    return !CJK_PUNCT.test(window.slice(at + CJK_NEGATION_NEAR.length));
  }
  const match = window.match(/\b(?:no longer|not|never|no)\b[^.;!?]*$/i);
  return match !== null;
}
