import { parseArgs } from "node:util";
import { runValidationWorkflow } from "../lib/validation-impact/workflow";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    change: { type: "string", multiple: true, default: [] },
    "expect-failures": { type: "boolean", default: false },
    "no-execute": { type: "boolean", default: false },
  },
});

async function main() {
  if (!values.repo || values.change.length === 0) {
    throw new Error("usage: npm run validation:run -- --repo <path> --change <target[:required1,required2]> [--expect-failures] [--no-execute]");
  }
  const changes = values.change.map((value) => {
    const [path, requires = ""] = value.split(":");
    if (!path) throw new Error(`invalid change: ${value}`);
    return { path, requires: requires ? requires.split(",").filter(Boolean) : [] };
  });
  const result = await runValidationWorkflow(values.repo, changes, {
    expectFailures: values["expect-failures"],
    execute: values["no-execute"] ? async () => ({ returnCode: 0, output: "not executed" }) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
