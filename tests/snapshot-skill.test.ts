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
const roots: string[] = [];
const servers: Server[] = [];

const content = JSON.stringify({
  product: { description: "Packaged product", evidence: [{ path: "index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [{
    name: "Packaged feature",
    summary: "Feature",
    scenarios: [{
      reference: "HP-1",
      context: "User",
      action: "Runs feature",
      outcome: "Succeeds",
      category: "happy",
      evidence: [{ path: "index.ts", startLine: 1 }],
    }],
  }],
});

beforeAll(async () => {
  await exec(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/build-snapshot-skill.ts"], { cwd: projectRoot, timeout: 120_000 });
}, 180_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-radar-dist-"));
  roots.push(root);
  await cp(resolve(projectRoot, "dist/codelphi-radar"), join(root, "skill"), { recursive: true });
  return root;
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-radar-repo-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "config", "user.email", "radar@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Radar Test"]);
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

describe("distributable codelphi radar skill", () => {
  it("documents host-native invocation and runs help outside the source repository", async () => {
    const root = await workspace();
    const skill = await readFile(join(root, "skill", "SKILL.md"), "utf8");
    expect(skill).toContain("prepare");
    expect(skill).toContain("finalize");
    // 完成通道三级探测（standalone → 宿主显式桥 → 宿主身份门控 CLI）已进入 skill 文档：
    // 宿主可注入 CODELPHI_HOST_AI_* 桥让 complete 子命令直调当前模型，无桥时回退 agent 执行。
    expect(skill).toContain("complete");
    expect(skill).toContain("CODELPHI_HOST_AI_COMMAND");
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

  it("runs host-native prepare and finalize with no AI variables or host bridge", async () => {
    const root = await workspace();
    const repo = await repository();
    const workdir = join(root, "work");
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), "prepare", repo, "--workdir", workdir, "--language", "zh-CN"], {
      cwd: root,
      env: cleanEnv({ CODELPHI_SKILL_HOST: "TestHost" }),
      timeout: 60_000,
    });
    const manifest = JSON.parse(await readFile(join(workdir, "manifest.json"), "utf8"));
    await writeFile(join(workdir, "results", `${manifest.workOrderIds[0]}.json`), content);
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), "finalize", "--workdir", workdir], {
      cwd: root,
      env: cleanEnv({ CODELPHI_SKILL_HOST: "TestHost" }),
      timeout: 60_000,
    });
    const html = await readFile(join(workdir, "radar.html"), "utf8");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("Packaged feature");
  }, 90_000);

  it("does not silently use standalone variables in host-native mode", async () => {
    const root = await workspace();
    const repo = await repository();
    const workdir = join(root, "work");
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), "prepare", repo, "--workdir", workdir], {
      cwd: root,
      env: cleanEnv({ CODELPHI_SKILL_HOST: "ClosedHost", AI_API_KEY: "must-not-use", AI_MODEL: "must-not-use" }),
      timeout: 60_000,
    });
    const manifest = JSON.parse(await readFile(join(workdir, "manifest.json"), "utf8"));
    await writeFile(join(workdir, "results", `${manifest.workOrderIds[0]}.json`), content);
    await exec(process.execPath, [join(root, "skill", "scripts", "snapshot.cjs"), "finalize", "--workdir", workdir], {
      cwd: root,
      env: cleanEnv({ CODELPHI_SKILL_HOST: "ClosedHost", AI_API_KEY: "must-not-use", AI_MODEL: "must-not-use" }),
      timeout: 60_000,
    });
    expect(await readFile(join(workdir, "radar.html"), "utf8")).toContain("Packaged feature");
  }, 90_000);
});
