import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { ArchifyCommandError, deliverArchify, visualCheckArchify } from "../lib/archify-cli";
import { deliverySummary, visualSummary } from "../lib/archify-receipt";

async function prototype() {
  const delivery = await deliverArchify({
    type: "architecture",
    input: resolve("artifacts/radar-architecture.json"),
    output: resolve("artifacts/radar-architecture.html"),
    repoRoot: process.cwd(),
  });
  const visual = await visualCheckArchify({ artifact: resolve("artifacts/radar-architecture.html") });
  const summary = { delivery: deliverySummary(delivery), visual: visualSummary(visual) };
  writeFileSync(resolve("artifacts/radar-architecture.acceptance.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

prototype().catch((error) => {
  console.error(error instanceof ArchifyCommandError ? JSON.stringify(error.receipt, null, 2) : error);
  process.exitCode = 1;
});
