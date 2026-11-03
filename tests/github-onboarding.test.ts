import { describe, expect, it, vi } from "vitest";
import { completeInstallationSetup, completeManifest } from "../lib/github-onboarding";

describe("GitHub onboarding services", () => {
  it("validates manifest state and converts credentials", async () => {
    const convert = vi.fn(async () => ({ appId: 1, slug: "radar", clientId: "client", clientSecret: "secret", pem: "pem" }));
    const save = vi.fn(async () => undefined);
    expect(await completeManifest(null, "state", "state", { convert, save })).toBe("manifest_state");
    expect(await completeManifest("code", "wrong", "state", { convert, save })).toBe("manifest_state");
    expect(await completeManifest("code", "state", "state", { convert, save })).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it("maps conversion failures", async () => {
    const convert = vi.fn(async () => { throw new Error("conversion failed"); });
    expect(await completeManifest("code", "state", "state", { convert, save: vi.fn() })).toBe("conversion_failed");
  });

  it("validates and saves installations", async () => {
    const getLatest = vi.fn(async () => ({ id: 1, clientId: "client", pem: "pem" }));
    const getInstallation = vi.fn(async () => ({ id: 42, account: { login: "gzhanlei", type: "User" } }));
    const save = vi.fn(async () => undefined);
    expect(await completeInstallationSetup(0, { getLatest, getInstallation, save })).toBe("installation_id");
    expect(await completeInstallationSetup(-1, { getLatest, getInstallation, save })).toBe("installation_id");
    expect(await completeInstallationSetup(42, { getLatest, getInstallation, save })).toBeNull();
    expect(await completeInstallationSetup(1, { getLatest, getInstallation, save })).toBeNull();
    expect(save).toHaveBeenCalledWith(1, { id: 42, account: { login: "gzhanlei", type: "User" } }, 1);
  });

  it("handles missing apps and installation API failures", async () => {
    const getLatest = vi.fn(async () => null);
    expect(await completeInstallationSetup(42, { getLatest, getInstallation: vi.fn(), save: vi.fn() })).toBe("app_missing");
    const dependencies = { getLatest: vi.fn(async () => ({ id: 1, clientId: "client", pem: "pem" })), getInstallation: vi.fn(async () => { throw new Error("denied"); }), save: vi.fn() };
    expect(await completeInstallationSetup(42, dependencies)).toBe("installation_failed");
  });
});
