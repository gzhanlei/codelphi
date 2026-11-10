import { afterEach, describe, expect, it } from "vitest";
import { allowStartupSideEffects } from "../instrumentation";

describe("startup side-effect guard (本地 dev 防护)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const env = process.env as unknown as { NODE_ENV?: string };
  const originalOverride = process.env.ALLOW_PROD_SIDE_EFFECTS;

  afterEach(() => {
    env.NODE_ENV = originalNodeEnv;
    if (originalOverride === undefined) delete process.env.ALLOW_PROD_SIDE_EFFECTS;
    else process.env.ALLOW_PROD_SIDE_EFFECTS = originalOverride;
  });

  it("blocks recovery and sweeps in development unless explicitly overridden", () => {
    env.NODE_ENV = "development";
    delete process.env.ALLOW_PROD_SIDE_EFFECTS;
    expect(allowStartupSideEffects()).toBe(false);
    process.env.ALLOW_PROD_SIDE_EFFECTS = "true";
    expect(allowStartupSideEffects()).toBe(true);
  });

  it("always allows side effects outside development (production start)", () => {
    env.NODE_ENV = "production";
    delete process.env.ALLOW_PROD_SIDE_EFFECTS;
    expect(allowStartupSideEffects()).toBe(true);
    env.NODE_ENV = "test";
    expect(allowStartupSideEffects()).toBe(true);
  });
});
