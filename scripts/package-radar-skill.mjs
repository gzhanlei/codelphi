import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await exec("npm", ["run", "radar:skill"], { cwd: root });
const archive = resolve(root, "dist/codelphi-radar.zip");
await rm(archive, { force: true });
await exec("zip", ["-qr", "codelphi-radar.zip", "codelphi-radar"], { cwd: resolve(root, "dist") });
console.log(archive);
