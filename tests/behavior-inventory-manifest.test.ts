import { describe, expect, it } from "vitest";
import type {
  BehaviorAnchorLocator,
  BehaviorManifest,
  BehaviorUnitLocator,
} from "../lib/behavior-inventory/types";
import { makeAnchorKey, makeUnitKey } from "../lib/behavior-inventory/identity";
import { canonicalManifest, manifestHash } from "../lib/behavior-inventory/manifest";

/** Task 1 契约（2026-11-19 行为清单全量分析）：unit/anchor/task 身份与 manifest 序列化
 *  在同 revision、scope、detector registry、inventory schema 下完全确定；
 *  不依赖 AI 生成名称或文件内容 hash，不做跨 revision 语义哈希。 */

function originalManifest(): BehaviorManifest {
  return {
    inventorySchemaVersion: "1",
    detectorRegistryVersion: "next@1,generic@1",
    afterSha: "c0e1d0235f033005238dc07a6bcae8a02ed171f8",
    scopeFingerprint: "scope-fingerprint-1",
    units: [
      {
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        kind: "http",
        primaryPath: "src/orders.ts",
        primaryRanges: [
          { startLine: 1, endLine: 80 },
          { startLine: 90, endLine: 120 },
        ],
        contextRanges: [{ path: "src/db.ts", startLine: 5, endLine: 9 }],
        anchors: [
          {
            anchorKey: "anchor-b",
            role: "implicit_review",
            ranges: [
              { startLine: 40, endLine: 80 },
              { startLine: 20, endLine: 30 },
            ],
            evidence: [{ path: "src/orders.ts", startLine: 40 }],
            coarse: true,
          },
          {
            anchorKey: "anchor-a",
            role: "behavior",
            ranges: [{ startLine: 1, endLine: 39 }],
            evidence: [
              { path: "src/orders.ts", startLine: 3 },
              { path: "src/orders.ts", startLine: 1 },
            ],
            coarse: false,
          },
        ],
        detector: "next",
        detectorVersion: "1",
      },
    ],
    tasks: [
      {
        taskKey: "task-2",
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        anchorFragments: [
          {
            anchorKey: "anchor-b",
            anchorFragmentKey: "anchor-b@40-80#1",
            ranges: [{ startLine: 40, endLine: 80 }],
          },
        ],
      },
      {
        taskKey: "task-1",
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        anchorFragments: [
          {
            anchorKey: "anchor-a",
            anchorFragmentKey: "anchor-a@1-39#1",
            ranges: [{ startLine: 1, endLine: 39 }],
          },
        ],
      },
    ],
  };
}

/** 同内容、不同对象 key 书写顺序与数组插入顺序的 manifest。 */
function reorderedManifest(): BehaviorManifest {
  const unit = originalManifest().units[0];
  return {
    tasks: [
      {
        anchorFragments: [
          {
            ranges: [{ startLine: 1, endLine: 39 }],
            anchorFragmentKey: "anchor-a@1-39#1",
            anchorKey: "anchor-a",
          },
        ],
        unitKey: unit.unitKey,
        taskKey: "task-1",
      },
      {
        anchorFragments: [
          {
            ranges: [{ startLine: 40, endLine: 80 }],
            anchorFragmentKey: "anchor-b@40-80#1",
            anchorKey: "anchor-b",
          },
        ],
        unitKey: unit.unitKey,
        taskKey: "task-2",
      },
    ],
    units: [
      {
        detectorVersion: "1",
        detector: "next",
        anchors: [
          {
            coarse: false,
            evidence: [
              { startLine: 1, path: "src/orders.ts" },
              { startLine: 3, path: "src/orders.ts" },
            ],
            ranges: [{ startLine: 1, endLine: 39 }],
            role: "behavior",
            anchorKey: "anchor-a",
          },
          {
            coarse: true,
            evidence: [{ startLine: 40, path: "src/orders.ts" }],
            ranges: [
              { startLine: 20, endLine: 30 },
              { startLine: 40, endLine: 80 },
            ],
            role: "implicit_review",
            anchorKey: "anchor-b",
          },
        ],
        contextRanges: [{ startLine: 5, endLine: 9, path: "src/db.ts" }],
        primaryRanges: [
          { startLine: 90, endLine: 120 },
          { startLine: 1, endLine: 80 },
        ],
        primaryPath: "src/orders.ts",
        kind: "http",
        unitKey: unit.unitKey,
      },
    ],
    scopeFingerprint: "scope-fingerprint-1",
    afterSha: "c0e1d0235f033005238dc07a6bcae8a02ed171f8",
    detectorRegistryVersion: "next@1,generic@1",
    inventorySchemaVersion: "1",
  };
}

describe("canonicalManifest / manifestHash", () => {
  it("produces the same hash for identical content with different object key and array insertion order", () => {
    const original = originalManifest();
    const reordered = reorderedManifest();
    expect(manifestHash(reordered)).toBe(manifestHash(original));
    expect(canonicalManifest(reordered)).toBe(canonicalManifest(original));
  });

  it("changes the hash when unit content changes", () => {
    const original = originalManifest();
    const changed = originalManifest();
    changed.units[0].anchors[1].ranges = [{ startLine: 1, endLine: 38 }];
    expect(manifestHash(changed)).not.toBe(manifestHash(original));
  });

  it("serializes undefined and explicit null under one unified empty-value rule", () => {
    const withUndefined = originalManifest();
    withUndefined.units[0].primaryRanges = undefined;
    withUndefined.units[0].anchors[1].evidence = [{ path: "src/orders.ts", startLine: undefined }];
    const withNull = originalManifest();
    withNull.units[0].primaryRanges = null;
    withNull.units[0].anchors[1].evidence = [{ path: "src/orders.ts", startLine: null }];
    expect(manifestHash(withNull)).toBe(manifestHash(withUndefined));
  });

  it("rejects empty or inverted ranges instead of hashing them", () => {
    const invalid = originalManifest();
    invalid.units[0].anchors[1].ranges = [{ startLine: 30, endLine: 20 }];
    expect(() => canonicalManifest(invalid)).toThrow(/range/i);
  });
});

describe("makeUnitKey", () => {
  const baseUnitLocator: BehaviorUnitLocator = {
    kind: "http",
    method: "post",
    route: "/api/orders",
    registrationPath: "src/orders.ts",
    symbol: "createOrder",
  };

  it("does not depend on AI-generated feature names", () => {
    const first = makeUnitKey({ ...baseUnitLocator, displayName: "订单创建" });
    const second = makeUnitKey({ ...baseUnitLocator, displayName: "Order Creation" });
    expect(first).toBe(second);
  });

  it("normalizes the http method", () => {
    expect(makeUnitKey({ ...baseUnitLocator, method: "POST" })).toBe(makeUnitKey(baseUnitLocator));
  });

  it("uses the anonymous registration position for anonymous handlers", () => {
    const anonymousUnit: BehaviorUnitLocator = {
      kind: "http",
      method: "POST",
      route: "/api/orders",
      registrationPath: "src/orders.ts",
      symbol: null,
      anonymousAt: { path: "src/orders.ts", startLine: 12, startColumn: 9 },
    };
    expect(makeUnitKey(anonymousUnit)).toContain("anonymous@src/orders.ts:12:9");
  });

  it("disambiguates duplicate registrations with an occurrence ordinal", () => {
    const first = makeUnitKey({ ...baseUnitLocator });
    const second = makeUnitKey({ ...baseUnitLocator, occurrenceOrdinal: 2 });
    expect(second).not.toBe(first);
    expect(second).toContain("2");
  });
});

describe("makeAnchorKey", () => {
  const baseAnchorLocator: BehaviorAnchorLocator = {
    role: "behavior",
    path: "src/orders.ts",
    symbol: "createOrder",
    ranges: [{ startLine: 12, endLine: 40 }],
  };

  it("uses anonymous@path:line:column for anonymous handlers", () => {
    const anonymousLocator: BehaviorAnchorLocator = {
      role: "behavior",
      path: "src/orders.ts",
      symbol: null,
      anonymousAt: { path: "src/orders.ts", startLine: 12, startColumn: 9 },
      ranges: [{ startLine: 12, endLine: 40 }],
    };
    expect(makeAnchorKey(anonymousLocator)).toContain("anonymous@src/orders.ts:12:9");
  });

  it("does not depend on AI-generated feature names", () => {
    const first = makeAnchorKey({ ...baseAnchorLocator, displayName: "下单校验" });
    const second = makeAnchorKey({ ...baseAnchorLocator, displayName: "Checkout Validation" });
    expect(first).toBe(second);
  });

  it("normalizes range order inside the key", () => {
    const forward = makeAnchorKey(baseAnchorLocator);
    const reversed = makeAnchorKey({
      ...baseAnchorLocator,
      ranges: [
        { startLine: 30, endLine: 40 },
        { startLine: 12, endLine: 20 },
      ],
    });
    const mergedOrder = makeAnchorKey({
      ...baseAnchorLocator,
      ranges: [
        { startLine: 12, endLine: 20 },
        { startLine: 30, endLine: 40 },
      ],
    });
    expect(reversed).toBe(mergedOrder);
    expect(reversed).not.toBe(forward);
  });
});
