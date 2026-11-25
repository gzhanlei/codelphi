import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { appendConsultation } from "../lib/agent-consultation-log";

function usage() {
  console.error("Usage: npx tsx scripts/log-agent-consultation.ts --file <consultation.json>");
  process.exitCode = 2;
}

async function main() {
  const fileIndex = process.argv.indexOf("--file");
  const file = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
  if (!file) return usage();
  const root = fileURLToPath(new URL("..", import.meta.url));
  const input = JSON.parse(await readFile(file, "utf8"));
  const text = await appendConsultation(root, input);
  process.stdout.write(text);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
