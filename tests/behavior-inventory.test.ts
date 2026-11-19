import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildBehaviorInventory,
  DETECTOR_REGISTRY_VERSION,
  INVENTORY_SCHEMA_VERSION,
  type BehaviorInventoryResult,
  type InventorySource,
} from "../lib/behavior-inventory";
import { makeUnitKey } from "../lib/behavior-inventory/identity";
import { rangeLineCount, subtractRanges, unionRanges } from "../lib/behavior-inventory/ranges";
import type { BehaviorUnit, CodeRange, LineRange } from "../lib/behavior-inventory/types";

function source(path: string, content: string): InventorySource {
  return { path, content };
}

function lineCount(content: string): number {
  return content.split("\n").length;
}

const nextRouteSource = source(
  "app/api/orders/route.ts",
  readFileSync(new URL("./fixtures/behavior-inventory/next-route.ts", import.meta.url), "utf8"),
);
const flaskDynamicSource = source(
  "flask-dynamic.py",
  readFileSync(new URL("./fixtures/behavior-inventory/flask-dynamic.py", import.meta.url), "utf8"),
);

const dashboardPageSource = source(
  "app/dashboard/page.tsx",
  [
    "export default function DashboardPage() {",
    "  return <main><h1>Dashboard</h1></main>;",
    "}",
    "",
  ].join("\n"),
);

const moneyLibSource = source(
  "lib/money.ts",
  [
    "export function formatMoney(cents: number): string {",
    "  const dollars = (cents / 100).toFixed(2);",
    "  return dollars;",
    "}",
    "",
    "export function parseMoney(text: string): number {",
    "  const value = Number(text);",
    "  if (Number.isNaN(value)) {",
    "    throw new Error(\"invalid money\");",
    "  }",
    "  return Math.round(value * 100);",
    "}",
    "",
  ].join("\n"),
);

const automationSource = source(
  "scripts/automation.ts",
  [
    "import { program } from \"commander\";",
    "import cron from \"node-cron\";",
    "import { eventBus } from \"./bus\";",
    "",
    "function syncHandler(): void {",
    "  eventBus.emit(\"sync\");",
    "}",
    "",
    "function nightlyJob(): void {",
    "  eventBus.emit(\"nightly\");",
    "}",
    "",
    "function onOrderCreated(): void {",
    "  eventBus.emit(\"order.ack\");",
    "}",
    "",
    "program.command(\"sync\").action(syncHandler);",
    "cron.schedule(\"0 3 * * *\", nightlyJob);",
    "eventBus.subscribe(\"order.created\", onOrderCreated);",
    "",
  ].join("\n"),
);

function primaryCodeRanges(unit: BehaviorUnit): CodeRange[] {
  return (unit.primaryRanges ?? []).map((range) => ({ path: unit.primaryPath, ...range }));
}

function reviewCodeRanges(unit: BehaviorUnit): CodeRange[] {
  return unit.anchors
    .filter((anchor) => anchor.role !== "entry")
    .flatMap((anchor) => anchor.ranges.map((range) => ({ path: unit.primaryPath, ...range })));
}

function expectUnitAnchorCoverage(unit: BehaviorUnit): void {
  const covered = unionRanges(reviewCodeRanges(unit));
  const primary = unionRanges(primaryCodeRanges(unit));
  expect(covered).toEqual(primary);
}

describe("next detector", () => {
  it("splits GET/POST method exports into http units with entry and implicit review anchors", () => {
    const result = buildBehaviorInventory({ afterSha: "sha-next", sources: [nextRouteSource] });
    const httpUnits = result.units.filter((unit) => unit.kind === "http");
    expect(httpUnits).toHaveLength(2);
    const getUnit = httpUnits.find((unit) => unit.unitKey.includes("\"GET\""));
    const postUnit = httpUnits.find((unit) => unit.unitKey.includes("\"POST\""));
    expect(getUnit).toBeDefined();
    expect(postUnit).toBeDefined();
    const routeUnit = getUnit!;
    expect(routeUnit.primaryPath).toBe("app/api/orders/route.ts");
    expect(routeUnit.unitKey).toContain("\"/api/orders\"");
    expect(routeUnit.anchors.some((anchor) => anchor.role === "entry")).toBe(true);
    expect(routeUnit.anchors.filter((a) => a.role === "implicit_review")).not.toHaveLength(0);
    expect(routeUnit.detector).toBe("next");
    expect(routeUnit.detectorVersion).toBe("1");
  });

  it("keeps permission, validation and exception regions inside implicit review anchors", () => {
    const result = buildBehaviorInventory({ afterSha: "sha-next", sources: [nextRouteSource] });
    const lines = nextRouteSource.content.split("\n");
    const lineNumberOf = (marker: string): number => {
      const index = lines.findIndex((line) => line.includes(marker));
      expect(index).toBeGreaterThanOrEqual(0);
      return index + 1;
    };
    const reviewed = result.units
      .filter((unit) => unit.primaryPath === nextRouteSource.path && unit.kind === "http")
      .flatMap((unit) => unit.anchors.filter((anchor) => anchor.role === "implicit_review"));
    for (const marker of ["unauthorized", "forbidden", "invalid_order", "create_failed"]) {
      const line = lineNumberOf(marker);
      expect(
        reviewed.some((anchor) =>
          anchor.ranges.some((range) => range.startLine <= line && line <= range.endLine),
        ),
      ).toBe(true);
    }
    for (const unit of result.units) expectUnitAnchorCoverage(unit);
  });

  it("pins the page key composition route ?? path + registrationPath + handler", () => {
    const twinPageSource = source(
      "pages/dashboard.tsx",
      [
        "export default function DashboardPage() {",
        "  return <main><h1>Legacy</h1></main>;",
        "}",
        "",
      ].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-page", sources: [dashboardPageSource, twinPageSource] });
    const pages = result.units.filter((unit) => unit.kind === "page");
    expect(pages).toHaveLength(2);
    const appPage = pages.find((unit) => unit.primaryPath === dashboardPageSource.path)!;
    const pagesPage = pages.find((unit) => unit.primaryPath === twinPageSource.path)!;
    expect(appPage.unitKey).toContain("\"/dashboard\"");
    expect(pagesPage.unitKey).toContain("\"/dashboard\"");
    expect(appPage.unitKey).not.toBe(pagesPage.unitKey);
    expect(appPage.anchors.filter((anchor) => anchor.role === "implicit_review")).not.toHaveLength(0);

    const routeNullKey = makeUnitKey({
      kind: "page",
      route: null,
      path: "app/standalone/page.tsx",
      registrationPath: "app/standalone/page.tsx",
      symbol: "StandalonePage",
    });
    expect(routeNullKey.startsWith("unit|page|[\"app/standalone/page.tsx\"")).toBe(true);
  });
});

describe("generic detector", () => {
  it("maps public exports to public_api units with covering behavior anchors", () => {
    const result = buildBehaviorInventory({ afterSha: "sha-lib", sources: [moneyLibSource] });
    const apiUnits = result.units.filter((unit) => unit.kind === "public_api");
    expect(apiUnits.map((unit) => unit.unitKey).join("\n")).toContain("formatMoney");
    expect(apiUnits.map((unit) => unit.unitKey).join("\n")).toContain("parseMoney");
    expect(apiUnits).toHaveLength(2);
    for (const unit of apiUnits) {
      const behaviorAnchors = unit.anchors.filter((anchor) => anchor.role === "behavior");
      expect(behaviorAnchors).not.toHaveLength(0);
      expect(behaviorAnchors.every((anchor) => !anchor.coarse)).toBe(true);
      expectUnitAnchorCoverage(unit);
    }
  });

  it("detects explicit CLI, job and event registrations with named handlers", () => {
    const result = buildBehaviorInventory({ afterSha: "sha-auto", sources: [automationSource] });
    const cli = result.units.find((unit) => unit.kind === "cli");
    const job = result.units.find((unit) => unit.kind === "job");
    const event = result.units.find((unit) => unit.kind === "event");
    expect(cli?.unitKey).toContain("\"sync\"");
    expect(job?.unitKey).toContain("0 3 * * *");
    expect(event?.unitKey).toContain("order.created");
    for (const unit of [cli, job, event]) {
      expect(unit).toBeDefined();
      expect(unit!.anchors.some((anchor) => anchor.role === "entry")).toBe(true);
      expect(unit!.anchors.filter((anchor) => anchor.role === "implicit_review")).not.toHaveLength(0);
      expectUnitAnchorCoverage(unit!);
    }
  });

  it("disambiguates duplicate named registrations with occurrence ordinals", () => {
    const duplicateSource = source(
      "scripts/duplicate.ts",
      [
        "import { eventBus } from \"./bus\";",
        "",
        "function onOrderCreated(): void {",
        "  eventBus.emit(\"ack\");",
        "}",
        "",
        "eventBus.subscribe(\"order.created\", onOrderCreated);",
        "eventBus.subscribe(\"order.created\", onOrderCreated);",
        "",
      ].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-dup", sources: [duplicateSource] });
    const events = result.units.filter((unit) => unit.kind === "event");
    expect(events).toHaveLength(2);
    const keys = events.map((unit) => unit.unitKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.some((key) => key.includes("#1"))).toBe(true);
    expect(keys.some((key) => key.includes("#2"))).toBe(true);
    const anchorKeys = result.units.flatMap((unit) => unit.anchors.map((anchor) => anchor.anchorKey));
    expect(new Set(anchorKeys).size).toBe(anchorKeys.length);
  });

  it("identifies anonymous handlers by registration position", () => {
    const anonymousSource = source(
      "scripts/anonymous.ts",
      [
        "import { eventBus } from \"./bus\";",
        "",
        "eventBus.on(\"order.cancelled\", () => {",
        "  eventBus.emit(\"cancelled\");",
        "});",
        "",
      ].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-anon", sources: [anonymousSource] });
    const event = result.units.find((unit) => unit.kind === "event");
    expect(event?.unitKey).toContain("anonymous@scripts/anonymous.ts:");
  });

  it("falls back to residual units for repeated anonymous registrations built in a loop", () => {
    const loopSource = source(
      "scripts/loop.ts",
      [
        "import { eventBus } from \"./bus\";",
        "",
        "const topics = [\"alpha\", \"beta\"];",
        "for (const topic of topics) {",
        "  eventBus.on(topic, () => {",
        "    eventBus.emit(topic);",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-loop", sources: [loopSource] });
    expect(result.diagnostics.dynamicRegistrationFallback).toContain("scripts/loop.ts");
    expect(result.units.filter((unit) => unit.kind === "event")).toHaveLength(0);
    const residual = result.units.filter((unit) => unit.primaryPath === "scripts/loop.ts");
    expect(residual).not.toHaveLength(0);
    expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
  });

  it("normalizes empty-string locator components to null at the detector boundary", () => {
    const emptyIdSource = source(
      "scripts/empty.ts",
      [
        "import { eventBus } from \"./bus\";",
        "",
        "function handler(): void {",
        "  eventBus.emit(\"x\");",
        "}",
        "",
        "eventBus.on(\"\", handler);",
        "",
      ].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-empty", sources: [emptyIdSource] });
    const event = result.units.find((unit) => unit.kind === "event");
    expect(event).toBeDefined();
    expect(event!.unitKey).toContain("null");
    expect(event!.unitKey).not.toContain("\"\"");
  });
});

describe("residual fallback inventory", () => {
  it("keeps flask dynamic registration files as residual units instead of dropping them", () => {
    const result = buildBehaviorInventory({ afterSha: "sha-flask", sources: [flaskDynamicSource] });
    expect(result.diagnostics.dynamicRegistrationFallback).toContain("flask-dynamic.py");
    expect(result.units.map((u) => u.primaryPath)).toContain("flask-dynamic.py");
    expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
    const residual = result.units.find((unit) => unit.primaryPath === "flask-dynamic.py")!;
    expect(residual.kind).toBe("file");
    expect(residual.primaryRanges).toEqual([{ startLine: 1, endLine: lineCount(flaskDynamicSource.content) }]);
    expect(residual.anchors.filter((anchor) => anchor.role === "implicit_review")).not.toHaveLength(0);
    expect(residual.anchors.every((anchor) => anchor.coarse)).toBe(true);
  });

  it("records detectorUnsupported for unknown frameworks and still claims the file", () => {
    const railsSource = source(
      "config/routes.rb",
      ["Rails.application.routes.draw do", "  get \"/status\", to: \"status#show\"", "end", ""].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-rails", sources: [railsSource] });
    expect(result.diagnostics.detectorUnsupported).toContain("config/routes.rb");
    const residual = result.units.find((unit) => unit.primaryPath === "config/routes.rb")!;
    expect(residual.kind).toBe("file");
    expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
  });

  it("records detectorParseFailure and falls back to a whole-file residual unit", () => {
    const brokenSource = source(
      "app/api/broken/route.ts",
      ["export async function GET(request: Request) {", "  if (request) {", ""].join("\n"),
    );
    const result = buildBehaviorInventory({ afterSha: "sha-broken", sources: [brokenSource] });
    expect(result.diagnostics.detectorParseFailure).toContain("app/api/broken/route.ts");
    const residual = result.units.find((unit) => unit.primaryPath === "app/api/broken/route.ts")!;
    expect(residual.kind).toBe("file");
    expect(residual.primaryRanges).toEqual([{ startLine: 1, endLine: lineCount(brokenSource.content) }]);
    expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
  });
});

describe("buildBehaviorInventory invariants", () => {
  const allSources: InventorySource[] = [
    nextRouteSource,
    dashboardPageSource,
    moneyLibSource,
    automationSource,
    flaskDynamicSource,
    source("docs/guide.md", "# Guide\n\nSee the runbook.\n"),
    source("tests/money.test.ts", "import { formatMoney } from \"../lib/money\";\n"),
  ];

  function build(): BehaviorInventoryResult {
    return buildBehaviorInventory({ afterSha: "sha-all", scopeRoots: ["."], sources: allSources });
  }

  it("covers the eligible implementation surface exactly once with no overlap and no omission", () => {
    const result = build();
    const eligible = allSources.filter((item) => !item.path.startsWith("docs/") && !item.path.startsWith("tests/"));
    const eligibleRanges: CodeRange[] = eligible.map((item) => ({
      path: item.path,
      startLine: 1,
      endLine: lineCount(item.content),
    }));
    const allPrimary = result.units.flatMap(primaryCodeRanges);
    expect(subtractRanges(eligibleRanges, allPrimary)).toEqual([]);
    const uniqueLines = rangeLineCount(allPrimary);
    const summedLines = result.units.reduce((total, unit) => total + rangeLineCount(primaryCodeRanges(unit)), 0);
    expect(uniqueLines).toBe(summedLines);
    expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
    expect(result.diagnostics.semanticUnits + result.diagnostics.residualUnits).toBe(result.units.length);
    for (const unit of result.units) expectUnitAnchorCoverage(unit);
    const unitKeys = result.units.map((unit) => unit.unitKey);
    expect(new Set(unitKeys).size).toBe(unitKeys.length);
  });

  it("excludes non-implementation evidence from the inventory surface", () => {
    const result = build();
    expect(result.diagnostics.excludedNonImplementation).toContain("docs/guide.md");
    expect(result.diagnostics.excludedNonImplementation).toContain("tests/money.test.ts");
    expect(result.units.some((unit) => unit.primaryPath === "docs/guide.md")).toBe(false);
    expect(result.units.some((unit) => unit.primaryPath === "tests/money.test.ts")).toBe(false);
  });

  it("is deterministic for the same revision, scope and registry", () => {
    const first = build();
    const second = build();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.scopeFingerprint).toBe(first.scopeFingerprint);
    expect(first.inventorySchemaVersion).toBe(INVENTORY_SCHEMA_VERSION);
    expect(first.detectorRegistryVersion).toBe(DETECTOR_REGISTRY_VERSION);
  });

  it("changes the scope fingerprint when the eligible file set changes", () => {
    const baseline = build();
    const expanded = buildBehaviorInventory({
      afterSha: "sha-all",
      scopeRoots: ["."],
      sources: [...allSources, source("lib/extra.ts", "export function extra(): number {\n  return 1;\n}\n")],
    });
    expect(expanded.scopeFingerprint).not.toBe(baseline.scopeFingerprint);
  });
});
