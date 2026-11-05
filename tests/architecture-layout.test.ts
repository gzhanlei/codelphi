import { describe, expect, it } from "vitest";
import { architectureLayoutInternals as layout } from "../lib/architecture/layout";

const component = { id: "api", label: "api", type: "backend" as const, pos: [10, 20] as [number, number], size: [100, 40] as [number, number] };
const rect = { left: 0, right: 100, top: 0, bottom: 100 };

describe("architecture layout geometry", () => {
  it("calculates padded rectangles, strict interiors and external ports", () => {
    expect(layout.center(component)).toEqual({ x: 60, y: 40 });
    expect(layout.expandedRect(component)).toEqual({ left: -10, right: 130, top: 0, bottom: 80 });
    expect(layout.expandedRect(component, 8)).toEqual({ left: 2, right: 118, top: 12, bottom: 68 });
    expect(layout.inside({ x: 60, y: 40 }, layout.expandedRect(component))).toBe(true);
    expect(layout.inside({ x: -10, y: 40 }, layout.expandedRect(component))).toBe(false);
    expect(layout.inside({ x: 60, y: 80 }, layout.expandedRect(component))).toBe(false);
    expect(layout.ports(component)).toEqual([
      { x: -10, y: 40 }, { x: 130, y: 40 }, { x: 60, y: 0 }, { x: 60, y: 80 },
    ]);
    const target = { ...component, id: "db", pos: [300, 20] as [number, number] };
    const graph = layout.graphPoints([component, target], component, target);
    expect(graph.sourcePorts).toEqual(layout.ports(component));
    expect(graph.targetPorts).toEqual(layout.ports(target));
    expect(graph.points[0]).toEqual({ x: -10, y: 0 });
    expect(graph.points.at(-1)).toEqual({ x: 420, y: 80 });
    expect(graph.points.some((point) => graph.obstacles.some((obstacle) => layout.inside(point, obstacle)))).toBe(false);
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }];
    const neighbors = layout.buildNeighbors(points, []);
    expect(neighbors.get(0)).toEqual([
      { index: 1, direction: 1, distance: 10 }, { index: 2, direction: 2, distance: 20 },
    ]);
    expect(neighbors.get(1)).toEqual([
      { index: 0, direction: 1, distance: 10 }, { index: 3, direction: 2, distance: 20 },
    ]);
    expect(neighbors.get(2)).toEqual([
      { index: 0, direction: 2, distance: 20 }, { index: 3, direction: 1, distance: 10 },
    ]);
    expect(layout.buildNeighbors([points[0]], []).get(0)).toEqual([]);
  });

  it("allows boundary contact but rejects diagonal and obstacle-crossing segments", () => {
    expect(layout.clearSegment({ x: -10, y: 0 }, { x: 110, y: 0 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: -10, y: 100 }, { x: 110, y: 100 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: 0, y: -10 }, { x: 0, y: 110 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: -10, y: 50 }, { x: 110, y: 50 }, [rect])).toBe(false);
    expect(layout.clearSegment({ x: 50, y: -10 }, { x: 50, y: 110 }, [rect])).toBe(false);
    expect(layout.clearSegment({ x: -10, y: 50 }, { x: 0, y: 50 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: 100, y: 50 }, { x: 110, y: 50 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: 50, y: -10 }, { x: 50, y: 0 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: 50, y: 100 }, { x: 50, y: 110 }, [rect])).toBe(true);
    expect(layout.clearSegment({ x: 0, y: 0 }, { x: 10, y: 10 }, [rect])).toBe(false);
  });

  it("scores route states deterministically and applies turn costs", () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 20 }];
    const target = { x: 4, y: 5 };
    expect(layout.stateHeuristic(points, 1, target)).toBe(21);
    const distances = new Map([["1:0", 5]]);
    expect(layout.stateScore("1:0", distances, points, target)).toBe(26);
    expect(layout.stateScore("0:0", distances, points, target)).toBe(Number.POSITIVE_INFINITY);
    expect(layout.selectState(new Set(["1:0", "0:0"]), new Map([["0:0", 0], ["1:0", 10]]), [{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 10, y: 0 })).toBe("0:0");

    const neighbors = new Map([[0, [{ index: 1, direction: 1 as const, distance: 10 }, { index: 2, direction: 2 as const, distance: 5 }]]]);
    const costs = new Map([["0:0", 0]]);
    const previous = new Map<string, string>();
    const open = new Set<string>();
    layout.relaxNeighbors("0:0", neighbors, costs, previous, open);
    expect(Object.fromEntries(costs)).toEqual({ "0:0": 0, "1:1": 10, "2:2": 5 });
    expect(Object.fromEntries(previous)).toEqual({ "1:1": "0:0", "2:2": "0:0" });
    expect([...open].sort()).toEqual(["1:1", "2:2"]);

    const turnCosts = new Map([["0:1", 10]]);
    const turnPrevious = new Map<string, string>();
    const turnOpen = new Set<string>();
    layout.relaxNeighbors("0:1", neighbors, turnCosts, turnPrevious, turnOpen);
    expect(turnCosts.get("1:1")).toBe(20);
    expect(turnCosts.get("2:2")).toBe(55);
    turnOpen.clear();
    layout.relaxNeighbors("0:1", neighbors, turnCosts, turnPrevious, turnOpen);
    expect(turnCosts.get("1:1")).toBe(20);
    expect(turnOpen.size).toBe(0);
    turnCosts.set("1:1", 0);
    layout.relaxNeighbors("0:1", neighbors, turnCosts, turnPrevious, turnOpen);
    expect(turnCosts.get("1:1")).toBe(0);
  });

  it("distinguishes overlapping rectangles from boundary contact", () => {
    const first = { left: 0, right: 10, top: 0, bottom: 10 };
    expect(layout.overlaps(first, { left: 10, right: 20, top: 0, bottom: 10 })).toBe(false);
    expect(layout.overlaps(first, { left: 9, right: 20, top: 0, bottom: 10 })).toBe(true);
    expect(layout.overlaps(first, { left: 0, right: 10, top: 10, bottom: 20 })).toBe(false);
    expect(layout.overlaps(first, { left: 0, right: 10, top: 9, bottom: 20 })).toBe(true);
    expect(layout.overlaps(first, { left: -10, right: 0, top: 0, bottom: 10 })).toBe(false);
    expect(layout.overlaps(first, { left: -10, right: 1, top: 0, bottom: 10 })).toBe(true);
    expect(layout.overlaps(first, { left: 0, right: 10, top: -10, bottom: 0 })).toBe(false);
    expect(layout.overlaps(first, { left: 0, right: 10, top: -10, bottom: 1 })).toBe(true);
    expect(layout.direction({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("right");
    expect(layout.direction({ x: 10, y: 0 }, { x: 0, y: 0 })).toBe("left");
    expect(layout.direction({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe("bottom");
    expect(layout.direction({ x: 0, y: 10 }, { x: 0, y: 0 })).toBe("top");
    expect(layout.direction({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe("top");
    expect(layout.targetDirection({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe("left");
    expect(layout.targetDirection({ x: 10, y: 0 }, { x: 0, y: 0 })).toBe("right");
    expect(layout.targetDirection({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe("top");
    expect(layout.targetDirection({ x: 0, y: 10 }, { x: 0, y: 0 })).toBe("bottom");
    expect(layout.targetDirection({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe("bottom");
  });

  it("orders label segments and accounts for label bounds and occupied space", () => {
    const segments = layout.pathSegments([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 10 }]);
    expect(segments.map((segment) => segment.index)).toEqual([1, 0]);
    expect(layout.pathSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]).map((segment) => segment.index)).toEqual([0, 1]);
    expect(layout.labelWidth("")).toBe(40);
    expect(layout.labelWidth("abcdef")).toBe(48);
    expect(layout.labelWidth("ÿÿÿÿ")).toBe(40);
    expect(layout.labelWidth("ĀĀĀĀ")).toBe(54);
    expect(layout.connectionLabel({ id: "fallback", label: "" })).toBe("fallback");
    expect(layout.connectionLabel({ id: "fallback", label: "shown" })).toBe("shown");
    expect(layout.connectionLabel({ id: "fallback" })).toBe("fallback");
    expect(layout.architectureViewBox([component], [{ id: "edge", from: "api", to: "db", labelAt: [500, 400], via: [[600, 300]] }])).toEqual([700, 500]);
    expect(layout.clearLabel({ x: 50, y: 50 }, 20, [], [])).toEqual({ point: [50, 50], rect: { left: 40, right: 60, top: 41, bottom: 59 } });
    expect(layout.clearLabel({ x: 50, y: 50 }, 20, [{ left: 40, right: 60, top: 41, bottom: 59 }], [])).toBeUndefined();
    expect(layout.clearLabel({ x: 50, y: 50 }, 20, [], [{ left: 40, right: 60, top: 41, bottom: 59 }])).toBeUndefined();

    const horizontal = { point: { x: 0, y: 50 }, next: { x: 100, y: 50 }, index: 0 };
    expect(layout.segmentLabel(horizontal, 20, [], [])?.point).toEqual([50, 68]);
    expect(layout.segmentLabel(horizontal, 20, [{ left: 45, right: 55, top: 60, bottom: 76 }], [])?.point).toEqual([50, 32]);
    expect(layout.segmentLabel(horizontal, 20, [
      { left: 45, right: 55, top: 60, bottom: 76 }, { left: 45, right: 55, top: 24, bottom: 40 },
    ], [])?.point).toEqual([50, 86]);
    const midpointBlocked = [18, 36, 56, 80, 120, 180].flatMap((offset) => [50 - offset, 50 + offset].map((y) => ({ left: 45, right: 55, top: y - 9, bottom: y + 9 })));
    expect(layout.segmentLabel(horizontal, 20, midpointBlocked, [])?.point).toEqual([25, 68]);
    const vertical = { point: { x: 0, y: 0 }, next: { x: 0, y: 100 }, index: 0 };
    expect(layout.segmentLabel(vertical, 20, [], [])?.point).toEqual([18, 50]);
  });
});
