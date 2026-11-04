import { describe, expect, it } from "vitest";
import { mergeArchitectureFragments } from "../lib/architecture/extract";
import type { ArchitectureFragment } from "../lib/architecture/detectors/types";
import type { EdgeFact, NodeFact } from "../lib/architecture/facts";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";
const users: NodeFact = { id: "users", kind: "user", label: "Users", signalIds: [], evidence: [] };
const api: NodeFact = { id: "api", kind: "api", label: "API", signalIds: [], evidence: [{ path: "api.ts", line: 1, detector: "first" }] };
const httpEdge: EdgeFact = { id: "http", from: "users", to: "api", kind: "http", label: "HTTPS", signalIds: [], evidence: [{ path: "api.ts", line: 1, detector: "first" }] };
const fragment = (nodes: NodeFact[] = [users, api], edges: EdgeFact[] = [httpEdge]): ArchitectureFragment => ({ nodes, edges, roots: ["users"], omissions: [] });

describe("architecture fragment merging", () => {
  it("merges duplicate runtime source paths and relationship evidence deterministically", () => {
    const secondApi: NodeFact = { ...api, sourcePaths: ["lib/db.ts"], evidence: [{ path: "api.ts", line: 2, detector: "second" }] };
    const secondEdge: EdgeFact = { ...httpEdge, evidence: [{ path: "api.ts", line: 2, detector: "second" }] };
    const facts = mergeArchitectureFragments(revision, [fragment([users, api], [httpEdge]), fragment([users, secondApi], [secondEdge])]);
    expect(facts.nodes).toHaveLength(2);
    expect(facts.nodes.find((node) => node.id === "api")?.sourcePaths).toEqual(["lib/db.ts"]);
    expect(facts.nodes.find((node) => node.id === "api")?.evidence).toHaveLength(2);
    expect(facts.edges[0].evidence).toHaveLength(2);
  });

  it("rejects conflicting endpoint and relationship-kind duplicates", () => {
    expect(() => mergeArchitectureFragments(revision, [fragment(), fragment([users, api], [{ ...httpEdge, from: "api", to: "users" }])])).toThrow("Conflicting architecture relationship");
    expect(() => mergeArchitectureFragments(revision, [fragment([users, api, { ...api, id: "other" }]), fragment([users, api], [{ ...httpEdge, to: "other" }])])).toThrow("Conflicting architecture relationship");
    expect(() => mergeArchitectureFragments(revision, [fragment(), fragment([users, api], [{ ...httpEdge, kind: "sql" }])])).toThrow("Conflicting architecture relationship");
    expect(() => mergeArchitectureFragments(revision, [fragment(), fragment([users, { ...api, kind: "worker" }])])).toThrow("Conflicting architecture node kind");
  });
});
