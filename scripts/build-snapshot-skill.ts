import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/codelphi-snapshot-skill");

export async function buildSnapshotSkill() {
  await rm(output, { recursive: true, force: true });
  await mkdir(resolve(output, "scripts"), { recursive: true });
  await copyFile(resolve(root, "skills/codelphi-snapshot/SKILL.md"), resolve(output, "SKILL.md"));
  await cp(resolve(root, "skills/codelphi-snapshot/adapters"), resolve(output, "adapters"), { recursive: true });
  await build({
    entryPoints: [resolve(root, "scripts/snapshot.ts")],
    outfile: resolve(output, "scripts/snapshot.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: false,
    minify: true,
    legalComments: "inline",
    logLevel: "silent",
  });
  return output;
}

if (process.argv[1]?.endsWith("build-snapshot-skill.ts")) {
  buildSnapshotSkill().then((path) => console.log(path)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
