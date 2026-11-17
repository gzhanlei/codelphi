import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceBundle = resolve(projectRoot, "dist/codelphi-snapshot-skill/scripts/snapshot.cjs");
const roots: string[] = [];
const servers: Server[] = [];

const content = JSON.stringify({
  product: { description: "Packaged product", evidence: [{ path: "index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [{ name: "Packaged feature", summary: "Feature", scenarios: [{ reference: "HP-1", context: "User", action: "Runs feature", outcome: "Succeeds", category: "happy", evidence: [{ path: "index.ts", startLine: 1 }] }] }],
});

beforeAll(async () => {
  await exec(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/build-snapshot-skill.ts"], { cwd: projectRoot, timeout: 120_000 });
}, 180_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-skill-dist-"));
  roots.push(root);
  await cp(resolve(projectRoot, "dist/codelphi-snapshot-skill"), join(root, "skill"), { recursive: true });
  return root;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-skill-repo-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "config", "user.email", "snapshot@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Snapshot Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "packaged-fixture" }));
  await writeFile(join(root, "index.ts"), "export const feature = true;\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

async function gateway() {
  const requests: Array<{ url: string; body: { model?: string } }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: JSON.parse(body || "{}") });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/host") response.end(JSON.stringify({ content }));
      else response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function cleanEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    NODE_ENV: "test" as const,
    ...extra,
  };
}

describe("distributable snapshot skill", () => {
  it("documents invocation-language behavior and runs help outside the source repository", async () => {
    const root = await workspace();
    const skill = await readFile(join(root, "skill", "SKILL.md"), "utf8");
    expect(skill).toContain("Chinese -> `--language zh-CN`");
    expect(skill).toContain("English -> `--language en`");
    expect(skill).toContain("host_ai_unavailable");
    expect(skill).not.toContain("DATABASE_URL");
    const result = await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), "--help"], { cwd: root, env: cleanEnv() });
    expect(result.stdout).toContain("--language");
    expect(result.stdout).toContain("--standalone");
  }, 60_000);

  it("uses explicit standalone configuration without MySQL or companion artifacts", async () => {
    const root = await workspace();
    const repo = await repository();
    const server = await gateway();
    const envFile = join(root, "standalone.env");
    const output = join(root, "standalone.html");
    await writeFile(envFile, `AI_BASE_URL=${server.url}\nAI_API_KEY=test-key\nAI_MODEL=standalone-model\n`);
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), repo, "--language", "en", "--standalone", "--env-file", envFile, "--output", output], {
      cwd: root,
      env: cleanEnv(),
      timeout: 60_000,
    });
    const html = await readFile(output, "utf8");
    expect(html).toContain('<html lang="en">');
    expect(server.requests[0].body.model).toBe("standalone-model");
    expect(await readdir(repo)).not.toContain(".codelphi");
    expect(await readdir(root)).not.toContain("spec.json");
  }, 90_000);

  it("uses the injected host model with no AI_* variables and produces Chinese HTML", async () => {
    const root = await workspace();
    const repo = await repository();
    const server = await gateway();
    const output = join(root, "host.html");
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), repo, "--language", "zh-CN", "--output", output], {
      cwd: root,
      env: cleanEnv({
        CODELPHI_SKILL_HOST: "TestHost",
        CODELPHI_HOST_AI_BRIDGE_URL: `${server.url}/host`,
        CODELPHI_HOST_MODEL: "TestHost current model",
      }),
      timeout: 60_000,
    });
    const html = await readFile(output, "utf8");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("TestHost current model");
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests[0].body.model).toBeUndefined();
  }, 90_000);

  it("does not silently use standalone variables when the host has no model interface", async () => {
    const root = await workspace();
    const repo = await repository();
    const output = join(root, "must-not-exist.html");
    await expect(exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), repo, "--language", "en", "--output", output], {
      cwd: root,
      env: cleanEnv({ CODELPHI_SKILL_HOST: "ClosedHost", AI_API_KEY: "must-not-use", AI_MODEL: "must-not-use" }),
      timeout: 60_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("current host") });
    await expect(readFile(output, "utf8")).rejects.toThrow();
  }, 60_000);
});
