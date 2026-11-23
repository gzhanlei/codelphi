import ts from "typescript";

export type GuardAnchor = {
  kind: "GUARD";
  path: string;
  symbol: string;
  condition: string;
  outcome: string;
  extraction: "complete" | "partial";
  evidence: { path: string; startLine: number; endLine: number };
};

const MAX_SOURCE_BYTES = 1_000_000;

function scriptKind(path: string) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function enclosingSymbol(node: ts.Node): { symbol: string; known: boolean } {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
      if (current.name) return { symbol: current.name.getText(), known: true };
      return { symbol: "<anonymous>", known: false };
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return { symbol: current.parent.name.text, known: true };
      }
      if (ts.isPropertyAssignment(current.parent)) return { symbol: current.parent.name.getText(), known: true };
      return { symbol: "<anonymous>", known: false };
    }
    current = current.parent;
  }
  return { symbol: "<file>", known: true };
}

export function extractLegacyGuardAnchors(source: { path: string; content: string }): GuardAnchor[] {
  if (new TextEncoder().encode(source.content).byteLength > MAX_SOURCE_BYTES) {
    console.warn("[legacy-guard-anchors] file skipped", { path: source.path, reason: "file_too_large" });
    return [];
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (fileName) => fileName === source.path;
  host.readFile = (fileName) => fileName === source.path ? source.content : undefined;
  host.getSourceFile = (fileName, languageVersion) => fileName === source.path
    ? ts.createSourceFile(fileName, source.content, languageVersion, true, scriptKind(source.path))
    : undefined;
  const program = ts.createProgram([source.path], options, host);
  const sourceFile = program.getSourceFile(source.path);
  if (!sourceFile) return [];
  if (program.getSyntacticDiagnostics(sourceFile).length > 0) {
    console.warn("[legacy-guard-anchors] file skipped", { path: source.path, reason: "syntax_error" });
    return [];
  }

  const anchors: GuardAnchor[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && ts.isThrowStatement(node.thenStatement)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const enclosing = enclosingSymbol(node);
      anchors.push({
        kind: "GUARD",
        path: source.path,
        symbol: enclosing.symbol,
        condition: node.expression.getText(sourceFile),
        outcome: node.thenStatement.getText(sourceFile).replace(/;$/, ""),
        extraction: enclosing.known ? "complete" : "partial",
        evidence: { path: source.path, startLine: start.line + 1, endLine: end.line + 1 },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return anchors;
}
