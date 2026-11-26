import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_KEYS,
  credentialsPath,
  describeConfig,
  DEFAULT_SERVER_URL,
  readCredentials,
  resolveConfig,
  writeCredentials,
} from "../lib/client-publish/credentials";
import { parseEnvFile, serializeEnvFile } from "../lib/env-file";
import { ServerRequestError, fetchContext, uploadProposal } from "../lib/client-publish/server";

afterEach(() => vi.unstubAllEnvs());

describe("credentialsPath", () => {
  it("lives under the user's config directory and can be redirected for tests", () => {
    expect(credentialsPath({ platform: "darwin", env: {}, home: "/home/alice" })).toBe("/home/alice/.config/codelphi/credentials.env");
    expect(credentialsPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/alice" })).toBe("/xdg/codelphi/credentials.env");
    expect(credentialsPath({ platform: "win32", env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, home: "C:\\Users\\alice" })).toBe(join("C:\\Users\\alice\\AppData\\Roaming", "codelphi", "credentials.env"));
    expect(credentialsPath({ platform: "darwin", env: { CODELPHI_CREDENTIALS_FILE: "/tmp/other.env" }, home: "/home/alice" })).toBe("/tmp/other.env");
  });
});

describe("env file round trip", () => {
  it("reads comments, quotes and inline comments, and writes a file it can read back", () => {
    const parsed = parseEnvFile(["# comment", "AI_MODEL=model-x   # trailing", 'AI_API_KEY="sk with spaces"', "export AI_BASE_URL='https://x/y'", "", "BROKEN LINE", "EMPTY=", "QUOTED_EMPTY=''", "UNCLOSED='no end"].join("\n"));
    // 单引号的空串是合法的空值；少了结束引号才是错的。
    expect(parsed.values.QUOTED_EMPTY).toBe("");
    expect(parsed.invalid).toEqual(["UNCLOSED"]);
    expect(parsed.values).toEqual({ AI_MODEL: "model-x", AI_API_KEY: "sk with spaces", AI_BASE_URL: "https://x/y", EMPTY: "", QUOTED_EMPTY: "" });
    expect(parsed.invalid).toEqual(["UNCLOSED"]);
    const text = serializeEnvFile({ AI_MODEL: "a b", AI_API_KEY: 'quote"inside', CODELPHI_SERVER_URL: "https://codelphi.com" });
    expect(text).toContain("AI_API_KEY=\"quote\\\"inside\"");
    expect(parseEnvFile(text).values).toEqual({ AI_MODEL: "a b", AI_API_KEY: 'quote"inside', CODELPHI_SERVER_URL: "https://codelphi.com" });
    // 普通的值不加引号；只有一项时文件也以换行结束。
    expect(text).toContain("CODELPHI_SERVER_URL=https://codelphi.com\n");
    expect(serializeEnvFile({ AI_MODEL: "m" })).toBe("AI_MODEL=m\n");
    expect(serializeEnvFile({})).toBe("");
  });
});

describe("resolveConfig", () => {
  it("lets the process environment win over --env-file, and --env-file over the credentials file", () => {
    const resolved = resolveConfig({
      process: { AI_MODEL: "from-process" },
      envFile: { AI_MODEL: "from-env-file", AI_API_KEY: "key-from-env-file" },
      credentials: { AI_MODEL: "from-file", AI_API_KEY: "key-from-file", CODELPHI_SERVER_URL: "https://server" },
    });
    expect(resolved).toMatchObject({ AI_MODEL: "from-process", AI_API_KEY: "key-from-env-file", CODELPHI_SERVER_URL: "https://server" });
  });

  it("falls back to the public server address when nothing says otherwise", () => {
    expect(resolveConfig({}).CODELPHI_SERVER_URL).toBe(DEFAULT_SERVER_URL);
  });
});

describe("credential file writing", () => {
  it("writes atomically with owner-only permissions, merges with what is there, and removes keys set to null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codelphi-credentials-"));
    try {
      const path = join(directory, "nested", "credentials.env");
      await writeCredentials(path, { AI_API_KEY: "first", AI_MODEL: "m1", CODELPHI_SNAPSHOT_KEY: "sk_cd_1" });
      const first = await stat(path);
      expect(first.mode & 0o777).toBe(0o600);
      await writeCredentials(path, { AI_MODEL: "m2", CODELPHI_SNAPSHOT_KEY: null, AI_BASE_URL: "https://gateway" });
      expect(await readCredentials(path)).toEqual({ AI_API_KEY: "first", AI_MODEL: "m2", AI_BASE_URL: "https://gateway" });
      // 改写不放宽已有的权限。
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // 同目录里不留临时文件。
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(join(directory, "nested"))).toEqual(["credentials.env"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads an absent file as empty", async () => {
    expect(await readCredentials("/nonexistent/codelphi/credentials.env")).toEqual({});
  });
});

describe("describeConfig", () => {
  it("never shows a secret and shows everything else", () => {
    const described = describeConfig({ AI_API_KEY: "sk-secret", CODELPHI_SNAPSHOT_KEY: "sk_cd_secret", AI_MODEL: "model-x", AI_BASE_URL: undefined });
    expect(described).toEqual({
      AI_BASE_URL: { state: "missing" },
      AI_API_KEY: { state: "set" },
      AI_MODEL: { state: "set", value: "model-x" },
      CODELPHI_SERVER_URL: { state: "set", value: DEFAULT_SERVER_URL },
      CODELPHI_SNAPSHOT_KEY: { state: "set" },
    });
    expect(JSON.stringify(described)).not.toContain("secret");
    expect(CREDENTIAL_KEYS).toHaveLength(5);
  });
});

describe("server client", () => {
  function recordingFetch(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
    let index = 0;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string>, bytes: init?.body ? (init.body as Uint8Array).byteLength : 0 });
      const response = responses[Math.min(index++, responses.length - 1)];
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    });
    return { calls, fetchImpl };
  }
  const server = { serverUrl: "https://codelphi.example/", key: "sk_cd_write" };

  it("sends the key only in the Authorization header when it asks for the context", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { contractVersion: "2.0.0", organization: { name: "Acme" }, products: [] } }]);
    const context = await fetchContext(server, fetchImpl as never);
    expect(context.organization.name).toBe("Acme");
    expect(calls).toEqual([{ url: "https://codelphi.example/api/client-analysis/context", headers: { authorization: "Bearer sk_cd_write" }, bytes: 0 }]);
  });

  it("carries a refusal's status and body instead of throwing them away", async () => {
    const { fetchImpl } = recordingFetch([{ status: 403, body: { error: "forbidden", reason: "needs snapshot_write" } }]);
    await expect(fetchContext(server, fetchImpl as never)).rejects.toMatchObject({ name: "ServerRequestError", status: 403, message: "forbidden" });
    await expect(fetchContext(server, fetchImpl as never)).rejects.toBeInstanceOf(ServerRequestError);
  });

  it("uploads a small proposal in one request and a large one in ordered chunks with the shared protocol's headers", async () => {
    const small = recordingFetch([{ status: 200, body: { replayed: false, specVersionId: 9 } }]);
    expect(await uploadProposal(server, "acme", '{"a":1}', { fetchImpl: small.fetchImpl as never })).toEqual({ status: 200, body: { replayed: false, specVersionId: 9 } });
    expect(small.calls).toHaveLength(1);
    expect(small.calls[0].url).toBe("https://codelphi.example/api/products/acme/analysis-proposals");
    expect(small.calls[0].headers["content-type"]).toBe("application/octet-stream");
    expect(small.calls[0].headers["x-import-id"]).toBeUndefined();

    const big = recordingFetch([{ status: 200, body: { received: true } }, { status: 200, body: { received: true } }, { status: 200, body: { replayed: false, specVersionId: 10 } }]);
    const payload = JSON.stringify({ text: "x".repeat(50_000) });
    const result = await uploadProposal(server, "acme", payload, { fetchImpl: big.fetchImpl as never, chunkBytes: 20_000 });
    expect(result.body).toEqual({ replayed: false, specVersionId: 10 });
    expect(big.calls.map((call) => call.headers["x-import-chunk-index"])).toEqual(["0", "1", "2"]);
    expect(new Set(big.calls.map((call) => call.headers["x-import-id"])).size).toBe(1);
    expect(big.calls.every((call) => call.headers["x-import-chunk-total"] === "3")).toBe(true);
    expect(big.calls.map((call) => call.bytes)).toEqual([20_000, 20_000, payload.length - 40_000]);
  });

  it("stops at the first chunk the server refuses and reports why", async () => {
    const { fetchImpl, calls } = recordingFetch([{ status: 200, body: { received: true } }, { status: 409, body: { error: "base_changed", details: { verdict: "reanalyze" } } }]);
    const result = await uploadProposal(server, "acme", JSON.stringify({ text: "y".repeat(50_000) }), { fetchImpl: fetchImpl as never, chunkBytes: 20_000 });
    expect(result).toEqual({ status: 409, body: { error: "base_changed", details: { verdict: "reanalyze" } } });
    expect(calls).toHaveLength(2);
  });
});
