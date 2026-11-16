import { parseArgs } from "node:util";
import { analyzeValidationImpact } from "../lib/validation-impact";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    target: { type: "string" },
    require: { type: "string", multiple: true, default: [] },
    adapter: { type: "string" },
  },
});

if (!values.repo || !values.target) {
  throw new Error("usage: npm run validation:impact -- --repo <path> --target <file> [--require <file>] [--adapter swiftc_readme|typescript_relative_imports]");
}
if (values.adapter && values.adapter !== "swiftc_readme" && values.adapter !== "typescript_relative_imports") {
  throw new Error(`unsupported adapter: ${values.adapter}`);
}

async function main() {
  const result = await analyzeValidationImpact(
    values.repo!,
    { path: values.target!, requires: values.require ?? [] },
    values.adapter as "swiftc_readme" | "typescript_relative_imports" | undefined,
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
