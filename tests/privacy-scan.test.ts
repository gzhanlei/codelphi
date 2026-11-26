import { describe, expect, it } from "vitest";
import { codePartsOf, createSourceIndex, type PrivacyHit, type SourceText, scanServer, scanValue } from "../lib/privacy-scan";

/**
 * 隐私扫描的能力边界（修订稿 §4.2）。每一类写明必须拦、必须放行，还是已知拦不住。
 * 「已知拦不住」的几类固定为放行并注明原因：规则改了要显式改这里。
 */

const source: SourceText[] = [
  {
    path: "lib/conn.ts",
    text: [
      'import { Connection } from "./types";',
      '// if (connection.status === "ready") return;',
      "/* 块注释里的代码不算：",
      '   if (connection.status === "ready") return;',
      "*/",
      "export function guard(connection: Connection) {",
      '  if (connection.status !== "ready") {',
      '    throw new Error("not ready");',
      "  }",
      "  const ok = items.filter((i) => i.enabled).length > 0;",
      "  saveResult(run, result, change, affectedKeys, coverage, behaviorLinks);",
      "  return alpha * tanh(dense1(x)) + beta * tanh(dense2(x));",
      "  const pending = order.status !== \"paid\"",
      "  if (check(a == b, c != d)) return;",
      "  log.info(msg, level, extra12);",
      "  log.info(msg, level);",
      '  return "550 we do not accept mail for this domain";',
      "}",
    ].join("\n"),
  },
  {
    path: "docs/guide.py",
    text: ['"""', "if (commented_out_in_docstring)", '"""', "def handler(len):", "    assert len >= 3", '    # if (conn.state !== "ready"):', "    return handler_value"].join("\n"),
  },
  { path: "lib/server.go", text: 'func main() { if (conn.State != "ready") { panic("x") } }' },
];

const index = createSourceIndex(source);
const scan = (text: unknown) => scanValue(text, index);
const rulesOf = (text: unknown) => scan(text).map((hit) => hit.rule);
const field = (outcome: string) => ({ proposal: { features: [{ name: "连接", summary: "连接相关", scenarios: [{ reference: "HP-1", context: "访客", action: "连接", outcome }] }] } });
const outcomeOf = (outcome: string) => rulesOf(field(outcome));

describe("privacy scan: what must be blocked", () => {
  it("blocks a whole source line, even when it is embedded in a sentence", () => {
    expect(outcomeOf('当连接未就绪时：if (connection.status !== "ready") {')).toContain("source_line");
    // 没有比较运算符的调用语句只有整行规则能拦。
    expect(outcomeOf("落库时调用 saveResult(run, result, change, affectedKeys, coverage, behaviorLinks);")).toEqual(["source_line"]);
  });

  it("blocks a single-line excerpt with a comparison", () => {
    expect(outcomeOf('连接状态不是 ready 时报错，即 connection.status !== "ready"')).toContain("code_fragment");
  });

  it("blocks source with its whitespace removed", () => {
    expect(outcomeOf('if(connection.status!=="ready"){throw new Error("not ready");}')).toContain("code_fragment");
  });

  it("blocks near-source whose variables were renamed", () => {
    expect(outcomeOf('if (conn.state !== "ready") { throw new Error("not ready"); }')).toContain("code_fragment");
  });

  it("blocks a renamed chained expression", () => {
    expect(outcomeOf("ok = rows.filter((r) => r.enabled).length > 0;")).toContain("code_fragment");
  });

  it("blocks a fragment that carries two comparisons and no bracket, keyword or quote", () => {
    expect(outcomeOf("验证 (x == 1, y != 2) 之后放行")).toContain("code_fragment");
  });

  it("blocks a whole code line of exactly the minimum length", () => {
    // 只用调用行：它没有比较、赋值或逻辑运算符，代码片段规则不会碰它，这里只验证整行规则的长度下限。
    const line = "log.info(msg, level, extra12);";
    expect(line.length).toBe(30);
    expect(outcomeOf(line)).toEqual(["source_line"]);
  });

  it("blocks a fenced code block without needing any source", () => {
    expect(scanServer({ a: "说明\n```\nconst a = 1;\n```" }).map((hit) => hit.rule)).toEqual(["code_block"]);
  });

  it("blocks three or more consecutive code-like lines without needing any source", () => {
    expect(scanServer("const a = 1;\nconst b = 2;\nconst c = 3;").map((hit) => hit.rule)).toEqual(["code_run"]);
    expect(scanServer("const a = 1;\nconst b = 2;")).toEqual([]);
  });

  it("blocks patch text without needing any source", () => {
    for (const patch of ["@@ -1,2 +1,3 @@", "diff --git a/lib/a.ts b/lib/a.ts", "+++ b/lib/a.ts", "--- a/lib/a.ts"]) {
      expect(scanServer(patch).map((hit) => hit.rule), patch).toEqual(["patch_marker"]);
    }
  });
});

describe("privacy scan: what must pass", () => {
  it("passes a source line that is too short to tell from an identifier", () => {
    const line = "log.info(msg, level);";
    expect(line.length).toBe(21);
    expect(outcomeOf(`照着 ${line} 处理`)).toEqual([]);
  });

  it("passes quoted messages, endpoint paths and identifiers", () => {
    expect(outcomeOf("返回 550 we do not accept mail for this domain，不做开放中继")).toEqual([]);
    expect(outcomeOf("POST /agent-mail/messages/{message_id}/attribution")).toEqual([]);
    expect(outcomeOf("系统读 agent_mail.attribution_suggest 审计记录")).toEqual([]);
  });

  it("passes a natural-language rewrite of the code", () => {
    expect(outcomeOf("连接状态不是 ready 时抛出 not ready 错误")).toEqual([]);
  });

  it("passes text that only repeats what a comment says", () => {
    expect(outcomeOf('if (connection.status === "ready") return;')).toEqual([]);
    expect(outcomeOf("if (commented_out_in_docstring)")).toEqual([]);
  });
});

describe("privacy scan: known gaps, fixed here on purpose", () => {
  it("does not catch a call signature: it cannot be told apart from an allowed identifier", () => {
    expect(outcomeOf("saveResult(run, result, change)")).toEqual([]);
    expect(outcomeOf("调用 alg_quant(dec, len, max_pitch)")).toEqual([]);
  });

  it("does not catch a single short condition: too few operators to tell it from prose", () => {
    expect(outcomeOf("触发 celt_assert(len>=3) 断言")).toEqual([]);
    expect(outcomeOf("schur64 输入相关序列首项 c[0] <= 0")).toEqual([]);
  });

  it("does not catch an arithmetic formula: no comparison, assignment or logical operator", () => {
    expect(outcomeOf("返回 alpha*tanh(dense1(x))+beta*tanh(dense2(x))")).toEqual([]);
  });

  it("matches code fragments only in the nine comment-aware extensions; other languages get the whole-line rule alone", () => {
    expect(outcomeOf('if (conn.State != "ready") { panic("x") }')).toEqual([]);
    expect(outcomeOf('func main() { if (conn.State != "ready") { panic("x") } }')).toEqual(["source_line"]);
  });

  it("does not see a fragment assembled across fields", () => {
    // 两半单独都不够格（都不足 4 个记号），拼起来才是源码里的表达式。
    const hits = scan({ left: "connection.status", right: '!== "ready"' });
    expect(hits).toEqual([]);
    // 反过来，单独够格的半句照样拦，哪怕它本来是拼出来的一半。
    expect(rulesOf({ right: '!== "ready") {' })).toEqual(["code_fragment"]);
  });

  it("does not count a code run until three code-like lines follow each other", () => {
    expect(scanServer("说明\nconst a = 1;\nconst b = 2;")).toEqual([]);
    expect(scanServer("const a = 1;\n\nconst b = 2;\nconst c = 3;")).toEqual([]);
    expect(scanServer("说明\nconst a = 1;\nconst b = 2;\nconst c = 3;").map((hit) => hit.line)).toEqual([2]);
  });
});

describe("privacy scan: where the hit is and what is scanned", () => {
  it("reports the field path and the line inside it, and the source file when it has one", () => {
    const hits: PrivacyHit[] = scan(field('前一行\nif (connection.status !== "ready") {\n后一行'));
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.path).toBe("proposal.features[0].scenarios[0].outcome");
      expect(hit.line).toBe(2);
      expect(hit.sourcePath).toBe("lib/conn.ts");
    }
    expect(scan({ top: ["a", { nested: "const a = 1;\nconst b = 2;\nconst c = 3;" }] })[0]).toMatchObject({ path: "top[1].nested", line: 1, rule: "code_run" });
  });

  it("scans every string in the payload, not only the proposal field", () => {
    expect(rulesOf({ flows: [{ graph: { label: 'if (connection.status !== "ready") {' } }], presentation: { text: "```" } })).toEqual(expect.arrayContaining(["code_fragment", "code_block"]));
  });

  it("ignores numbers, booleans and null", () => {
    expect(scan({ a: 1, b: true, c: null, d: "```" }).map((hit) => hit.path)).toEqual(["d"]);
  });

  it("lets the server apply the three rules that need no source", () => {
    expect(scanServer({ a: 'if (connection.status !== "ready") {' })).toEqual([]);
    expect(scanServer({ a: "x;\ny;\nz;" }).map((hit) => hit.rule)).toEqual(["code_run"]);
  });
});

describe("codePartsOf: what counts as code in a source line", () => {
  const py = (lines: string[]) => codePartsOf(lines.join("\n"), "x.py");
  const ts = (lines: string[]) => codePartsOf(lines.join("\n"), "x.ts");

  it("keeps code, blanks string contents, drops comments", () => {
    expect(ts(['const a = "secret"; // trailing', "const b = 2;"])).toEqual(['const a = "";', "const b = 2;"]);
    expect(py(['def f(s):', '    return "secret"  # note', "    x = 1"])).toEqual(["def f(s):", 'return ""', "x = 1"]);
  });

  it("tracks block comments and docstrings across lines", () => {
    expect(ts(["/* start", "const hidden = 1;", "end */ const shown = 2;"])).toEqual(["const shown = 2;"]);
    expect(py(['"""', "hidden = 1", '"""', "shown = 2"])).toEqual(["shown = 2"]);
  });

  it("does not treat a comment marker inside a string as a comment", () => {
    expect(ts(['const url = "https://example.com/a"; // real'])).toEqual(['const url = "";']);
  });

  it("blanks single-quoted and template strings as well, and leaves multiplication alone", () => {
    expect(ts(["const s = 'single';", "const t = `template ${x} end`;", "const area = width * height;"])).toEqual(['const s = "";', 'const t = "";', "const area = width * height;"]);
  });

  it("does not let an unclosed quote swallow the next line", () => {
    expect(ts(['const s = "abc', "const b = 2;"])).toEqual(['const s = ""', "const b = 2;"]);
    expect(py(["s = `odd", "y = 1"])).toEqual(['s = ""', "y = 1"]);
  });
});
