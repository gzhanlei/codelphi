import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { importSPKI, jwtVerify } from "jose";
import { convertManifestCode, createAppJwt, getAppInstallation, getInstallationAccessToken, radarManifest } from "../lib/github-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const app = { clientId: "Iv1.test", pem };

describe("GitHub App boundaries", () => {
  it("requests only read permissions and uses local callback routes", () => {
    const manifest = radarManifest("http://localhost:3008");
    expect(manifest.default_permissions).toEqual({ contents: "read", metadata: "read" });
    expect(manifest).not.toHaveProperty("default_permissions.administration");
    expect(manifest.redirect_url).toBe("http://localhost:3008/integrations/github/callback");
    expect(manifest.setup_url).toBe("http://localhost:3008/integrations/github/setup");
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ url: "http://localhost:3008/api/webhooks/github", active: true });
    expect(manifest.default_events).toEqual(["push"]);
    expect(radarManifest("http://localhost:3008/").hook_attributes.url).toBe("http://localhost:3008/api/webhooks/github");
  });

  it("converts a manifest code into validated app credentials", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 123, slug: "radar-test", client_id: "Iv1.test", client_secret: "secret", pem: "private-pem", webhook_secret: "hook" }), { status: 201 }));
    const result = await convertManifestCode("conversion-code", fetcher);
    expect(result).toMatchObject({ appId: 123, slug: "radar-test", clientId: "Iv1.test", pem: "private-pem" });
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/app-manifests/conversion-code/conversions", expect.objectContaining({ method: "POST" }));
  });

  it("treats a missing webhook secret as undefined", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 123, slug: "radar-test", client_id: "Iv1.test", client_secret: "secret", pem: "private-pem", webhook_secret: null }), { status: 201 }));
    const result = await convertManifestCode("conversion-code", fetcher);
    expect(result.webhookSecret).toBeUndefined();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ id: 123, slug: "radar-test", client_id: "Iv1.test", client_secret: "secret", pem: "private-pem", webhook_secret: "" }), { status: 201 }));
    expect((await convertManifestCode("conversion-code", fetcher)).webhookSecret).toBe("");
  });

  it("accepts GitHub PKCS#1 private keys", async () => {
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const token = await createAppJwt({ clientId: app.clientId, pem: pkcs1 }, 1_800_000_000);
    await jwtVerify(token, await importSPKI(publicPem, "RS256"), { issuer: app.clientId });
  });

  it("signs RS256 App JWTs and exchanges an installation token", async () => {
    const token = await createAppJwt(app, 1_800_000_000);
    const { payload } = await jwtVerify(token, await importSPKI(publicPem, "RS256"), { issuer: app.clientId });
    expect(payload.iat).toBe(1_800_000_000 - 30);
    expect(payload.exp).toBe(1_800_000_000 + 540);

    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ token: "installation-token", expires_at: "2026-11-01T01:00:00Z" }), { status: 201 }));
    const installation = await getInstallationAccessToken(app, 42, fetcher);
    expect(installation.token).toBe("installation-token");
    const init = fetcher.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it("rejects suspended installations before they can become active", async () => {
    const account = { login: "radar-user", type: "User" };
    const fetcher = vi.fn(async () => Response.json({ id: 42, account, suspended_at: "2026-11-01T00:00:00Z" }));
    await expect(getAppInstallation(app, 42, fetcher)).rejects.toThrow("suspended");
    fetcher.mockResolvedValueOnce(Response.json({ id: 42, account, suspended_at: null }));
    await expect(getAppInstallation(app, 42, fetcher)).resolves.toMatchObject({ id: 42, account });
  });
});
