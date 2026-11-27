import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../lib/secret-box";
import {
  ModelUrlError,
  assertPublicModelUrl,
  bindOrganizationModel,
  currentOrganizationModel,
  deleteOrganizationModel,
  describeOrganizationModel,
  isPublicAddress,
  loadOrganizationModel,
  organizationModelConfigured,
  pinnedLookup,
  postToModel,
  resolvePublicHost,
  saveOrganizationModel,
  withOrganizationModel,
} from "../lib/organization-model";

const SECRET = "test-secret-for-the-model-key";
const stored = { base_url: "https://api.example/v1", api_key_encrypted: "", model: "k3-256k", verified_at: new Date("2026-11-27T10:00:00.000Z") };

/** 按语句片段回答的 execute 替身：记下每条语句，让测试断言顺序、参数，以及「密文进了库、明文没有」。 */
function database(row: Record<string, unknown> | null = null) {
  const statements: Array<[string, unknown[]]> = [];
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    statements.push([sql, params]);
    if (sql.includes("SELECT") && sql.includes("FROM organization_models")) return [row ? [row] : []];
    // 删除时：有这一行才删得掉。
    if (sql.includes("DELETE")) return [{ affectedRows: row ? 1 : 0 }];
    return [{ affectedRows: 1 }];
  });
  return { execute, statements };
}

const encryptedOf = (apiKey: string) => encryptSecret(apiKey, SECRET);
/** Node 的 lookup 是回调式的：这里按它的调用方式回答。 */
const lookupAnswering = (answers: Array<[string, 4 | 6]>) =>
  vi.fn((_hostname: string, _options: unknown, callback: (error: null, result: unknown) => void) => {
    callback(null, answers.map(([address, family]) => ({ address, family })));
  }) as never;

/** 按 Node 调 lookup 的方式调一次，拿它的应答（单个地址时是「地址、协议族」，要整张表时是那张表）。 */
function callLookup(lookup: unknown, options: Record<string, unknown>): unknown {
  let answer: unknown = "not called";
  (lookup as (hostname: string, opts: object, callback: (error: unknown, ...rest: unknown[]) => void) => void)("api.example.com", options, (_error, ...rest) => {
    answer = rest.length === 1 ? rest[0] : rest;
  });
  return answer;
}

beforeEach(() => vi.stubEnv("SESSION_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("the model service address a workspace may configure", () => {
  it("accepts https addresses with a path, a port and an IPv6 literal host", () => {
    expect(assertPublicModelUrl("https://api.kimi.com/coding/v1").href).toBe("https://api.kimi.com/coding/v1");
    expect(assertPublicModelUrl("https://gateway.example:8443/v1/").href).toBe("https://gateway.example:8443/v1/");
    expect(assertPublicModelUrl("https://[2606:4700::1111]/v1").hostname).toBe("[2606:4700::1111]");
    expect(assertPublicModelUrl("  https://api.example/v1  ").href).toBe("https://api.example/v1");
  });

  it("refuses anything that is not a plain https address to a public host", () => {
    const cases: Array<[string, string]> = [
      ["http://api.example/v1", "not_https"],
      ["ftp://api.example/v1", "not_https"],
      ["https://user:pass@api.example/v1", "credentials_in_url"],
      ["https://user@api.example/v1", "credentials_in_url"],
      ["https://:pass@api.example/v1", "credentials_in_url"],
      ["https://localhost/v1", "not_public"],
      ["https://api.localhost/v1", "not_public"],
      ["https://printer.local/v1", "not_public"],
      ["https://metadata.google.internal/v1", "not_public"],
      ["https://127.0.0.1/v1", "not_public"],
      ["https://10.0.0.5/v1", "not_public"],
      ["https://192.168.1.1:4000/v1", "not_public"],
      ["https://169.254.169.254/latest", "not_public"],
      ["https://[::1]/v1", "not_public"],
      ["https://[fd00::1]/v1", "not_public"],
      ["https://[::ffff:10.0.0.5]/v1", "not_public"],
      ["https://api.example/v1#fragment", "has_fragment"],
      ["https://api.example/v1?x=1", "has_query"],
      ["not a url", "invalid"],
      ["", "invalid"],
    ];
    for (const [value, code] of cases) {
      const refused = () => assertPublicModelUrl(value);
      expect(refused, value).toThrow(ModelUrlError);
      expect(refused, value).toThrow(new RegExp(`^${code}`));
    }
  });
});

describe("which addresses count as public", () => {
  it("tells public addresses from everything a server could be tricked into talking to", () => {
    for (const publicAddress of ["8.8.8.8", "1.1.1.1", "104.16.1.1", "2606:4700::1111", "2a00:1450::1", "::ffff:8.8.8.8"]) expect(isPublicAddress(publicAddress), publicAddress).toBe(true);
    for (const privateAddress of [
      "0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1", "100.64.0.1", "169.254.169.254", "224.0.0.1", "240.0.0.1",
      "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
      "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "2002::1", "::ffff:10.0.0.1", "::ffff:192.168.0.1",
    ]) expect(isPublicAddress(privateAddress), privateAddress).toBe(false);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("resolving a host before the server connects to it", () => {
  it("returns the addresses when every one of them is public", async () => {
    expect(await resolvePublicHost("api.example.com", lookupAnswering([["8.8.8.8", 4], ["2606:4700::1111", 6]]))).toEqual(["8.8.8.8", "2606:4700::1111"]);
  });

  it("refuses the host when any resolved address is not public, and when it does not resolve", async () => {
    await expect(resolvePublicHost("api.example.com", lookupAnswering([["8.8.8.8", 4], ["10.0.0.5", 4]]))).rejects.toThrow(/^private_address/);
    await expect(resolvePublicHost("api.example.com", lookupAnswering([]))).rejects.toThrow(/^unresolvable/);
    await expect(resolvePublicHost("api.example.com", vi.fn((_hostname: string, _options: unknown, callback: (error: Error) => void) => callback(new Error("ENOTFOUND"))) as never)).rejects.toThrow(/^unresolvable/);
  });

  it("asks for every address the host resolves to: a public one in front must not hide a private one behind it", async () => {
    // 和 Node 的 dns.lookup 一样：不要整张表就只给第一个地址。
    const nodeLike = vi.fn((_hostname: string, options: { all?: boolean }, callback: (error: null, result: unknown) => void) => {
      const answers = [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }];
      callback(null, options.all ? answers : answers[0].address);
    }) as never;
    await expect(resolvePublicHost("api.example.com", nodeLike)).rejects.toThrow(/^private_address/);
    expect(nodeLike).toHaveBeenCalledTimes(1);
  });

  it("judges the one address it is given when the lookup implementation answers with a bare string", async () => {
    const bare = (address: string) => vi.fn((_hostname: string, _options: unknown, callback: (error: null, result: string) => void) => callback(null, address)) as never;
    expect(await resolvePublicHost("api.example.com", bare("8.8.8.8"))).toEqual(["8.8.8.8"]);
    await expect(resolvePublicHost("api.example.com", bare("10.0.0.5"))).rejects.toThrow(/^private_address/);
  });

  it("does not look up a literal address, and checks it directly", async () => {
    const lookup = lookupAnswering([["8.8.8.8", 4]]);
    expect(await resolvePublicHost("8.8.8.8", lookup)).toEqual(["8.8.8.8"]);
    expect(lookup).not.toHaveBeenCalled();
    await expect(resolvePublicHost("10.0.0.5", lookup)).rejects.toThrow(ModelUrlError);
  });

  it("hands the connection only the addresses that were checked", () => {
    const pinned = pinnedLookup(["8.8.8.8", "2606:4700::1111"]);
    expect(callLookup(pinned, { family: 4 })).toEqual(["8.8.8.8", 4]);
    expect(callLookup(pinned, { family: 6 })).toEqual(["2606:4700::1111", 6]);
    expect(callLookup(pinned, {})).toEqual(["8.8.8.8", 4]);
    // Node 新版本会要整张表自己挑：给它的也只有校验过的这两个。
    expect(callLookup(pinned, { all: true })).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
    // 只校验过一个 IPv4 地址、却要 IPv6：交出的仍然是校验过的那个，不是 undefined，也不是别的。
    expect(callLookup(pinnedLookup(["8.8.8.8"]), { family: 6 })).toEqual(["8.8.8.8", 4]);
    expect(callLookup(pinnedLookup(["8.8.8.8"]), { family: 6, all: true })).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });
});

describe("sending a request to a workspace's model", () => {
  /** https.request 的替身：记下地址和选项，立刻回一个应答。 */
  function fakeRequest(status = 200, body = '{"ok":true}') {
    const seen: Array<{ url: string; options: Record<string, unknown> }> = [];
    const sent: unknown[] = [];
    const request = vi.fn((url: URL, options: Record<string, unknown>, onResponse: (response: unknown) => void) => {
      seen.push({ url: url.href, options });
      const req = Object.assign(new EventEmitter(), {
        setTimeout: () => req,
        destroy: () => req,
        end(chunk?: unknown) {
          sent.push(chunk);
          queueMicrotask(() => {
            const response = Object.assign(new EventEmitter(), { statusCode: status, headers: {} });
            onResponse(response);
            response.emit("data", Buffer.from(body));
            response.emit("end");
          });
          return req;
        },
      });
      return req;
    });
    return { request: request as never, seen, sent };
  }
  const target = "https://api.example.com/v1/chat/completions";
  const payload = { headers: { Authorization: "Bearer sk_x" }, body: '{"model":"m"}', timeoutMs: 5_000 };

  it("connects only to an address it checked, with the host name for TLS, and reports the status and the body", async () => {
    const { request, seen, sent } = fakeRequest(200);
    const response = await postToModel(target, payload, { lookup: lookupAnswering([["8.8.8.8", 4]]), request });
    expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seen).toEqual([{ url: target, options: expect.objectContaining({ method: "POST", servername: "api.example.com", headers: { Authorization: "Bearer sk_x" } }) }]);
    expect(callLookup(seen[0].options.lookup, { family: 4 })).toEqual(["8.8.8.8", 4]);
    expect(sent).toEqual(['{"model":"m"}']);
  });

  it("never reaches the network when the address is not a public one", async () => {
    const { request } = fakeRequest(200);
    await expect(postToModel("http://10.0.0.5/v1", payload, { lookup: lookupAnswering([["8.8.8.8", 4]]), request })).rejects.toThrow(ModelUrlError);
    await expect(postToModel(target, payload, { lookup: lookupAnswering([["192.168.0.9", 4]]), request })).rejects.toThrow(/^private_address/);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails when the provider does not answer in time", async () => {
    const request = vi.fn((_url: URL, _options: Record<string, unknown>, _onResponse: unknown) => {
      const req = Object.assign(new EventEmitter(), {
        setTimeout: (_ms: number, callback: () => void) => {
          queueMicrotask(callback);
          return req;
        },
        destroy: (error: Error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        },
        end: () => req,
      });
      return req;
    }) as never;
    await expect(postToModel(target, { ...payload, timeoutMs: 10 }, { lookup: lookupAnswering([["8.8.8.8", 4]]), request })).rejects.toThrow(/timed out/);
  });
});

describe("keeping a workspace's model configuration", () => {
  const input = { organizationId: 3, baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-secret", model: "k3-256k", by: "user-1" };

  it("stores the key encrypted and never the plaintext, in a way that replaces an earlier configuration", async () => {
    const { execute, statements } = database(stored);
    await saveOrganizationModel(execute, input);
    const [sql, params] = statements[0];
    expect(sql).toContain("INSERT INTO organization_models");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(params.slice(0, 4)).toEqual([3, "https://api.kimi.com/coding/v1", params[2], "k3-256k"]);
    expect(String(params[2])).not.toContain("sk-kimi-secret");
    expect(decryptSecret(String(params[2]), SECRET)).toBe("sk-kimi-secret");
    expect(JSON.stringify(params)).not.toContain("sk-kimi-secret");
  });

  it("refuses an address that is not a public https address, a model name the receipts cannot hold, or an empty key", async () => {
    const { execute, statements } = database();
    await expect(saveOrganizationModel(execute, { ...input, baseUrl: "http://127.0.0.1:4000" })).rejects.toThrow(ModelUrlError);
    await expect(saveOrganizationModel(execute, { ...input, model: "x".repeat(65) })).rejects.toThrow(/64/);
    await expect(saveOrganizationModel(execute, { ...input, apiKey: "  " })).rejects.toThrow(/API key/);
    await expect(saveOrganizationModel(execute, { ...input, model: "" })).rejects.toThrow(/64/);
    await expect(saveOrganizationModel(execute, { ...input, model: "x".repeat(64) })).resolves.toBeUndefined();
    await expect(saveOrganizationModel(execute, { ...input, model: "k" })).resolves.toBeUndefined();
    expect(statements).toHaveLength(2);
    expect(statements.map(([, params]) => (params[3] as string).length)).toEqual([64, 1]);
  });

  it("loads the decrypted configuration, describes it without the key, and says whether one exists", async () => {
    const good = database({ ...stored, api_key_encrypted: encryptedOf("sk-kimi-secret") });
    expect(await loadOrganizationModel(3, good.execute)).toEqual({ baseUrl: "https://api.example/v1", apiKey: "sk-kimi-secret", model: "k3-256k" });
    const described = await describeOrganizationModel(3, good.execute);
    expect(described).toEqual({ baseUrl: "https://api.example/v1", model: "k3-256k", verifiedAt: stored.verified_at });
    expect(JSON.stringify(described)).not.toContain("sk-kimi-secret");
    const empty = database();
    expect(await loadOrganizationModel(3, empty.execute)).toBeNull();
    expect(await describeOrganizationModel(3, empty.execute)).toBeNull();
    expect(await organizationModelConfigured(good.execute, 3)).toBe(true);
    expect(await organizationModelConfigured(empty.execute, 3)).toBe(false);
  });

  it("fails loudly when the stored key cannot be read, instead of using something else", async () => {
    const broken = database({ ...stored, api_key_encrypted: "Zm9v" });
    await expect(loadOrganizationModel(3, broken.execute)).rejects.toThrow();
  });

  it("deletes the configuration", async () => {
    const { execute, statements } = database(stored);
    expect(await deleteOrganizationModel(3, execute)).toBe(true);
    expect(statements[0][0]).toContain("DELETE FROM organization_models");
    expect(statements[0][1]).toEqual([3]);
    expect(await deleteOrganizationModel(3, database().execute)).toBe(false);
  });
});

describe("binding a workspace's model to the work the server does for it", () => {
  const model = { baseUrl: "https://api.example/v1", apiKey: "sk-kimi-secret", model: "k3-256k" };

  it("makes the workspace's model visible inside the work, across awaits, and not outside it", async () => {
    const db = database({ ...stored, api_key_encrypted: encryptedOf("sk-kimi-secret") });
    expect(currentOrganizationModel()).toBeNull();
    const seen = await withOrganizationModel(
      3,
      async () => {
        const first = currentOrganizationModel();
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await Promise.resolve().then(() => currentOrganizationModel());
        return [first, second];
      },
      db.execute,
    );
    expect(seen).toEqual([model, model]);
    expect(currentOrganizationModel()).toBeNull();
    // 加载一次就够：绑定期间不再读库。
    expect(db.statements).toHaveLength(1);
  });

  it("does no work and falls back to nothing when the workspace has no model", async () => {
    const work = vi.fn(async () => "done");
    await expect(withOrganizationModel(3, work, database().execute)).rejects.toMatchObject({ code: "model_not_configured" });
    expect(work).not.toHaveBeenCalled();
  });

  it("can bind a configuration directly, for a request that already holds it", async () => {
    expect(await bindOrganizationModel(model, async () => currentOrganizationModel())).toEqual(model);
    expect(currentOrganizationModel()).toBeNull();
  });
});
