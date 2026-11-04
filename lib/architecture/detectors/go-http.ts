import type { ArchitectureEvidence, NodeFact } from "../facts";
import { architectureRuntimeSources, findArchitectureEvidence } from "../source";
import { factEdge, type ArchitectureContext } from "./types";

interface RouteGroup {
  base: string;
  indent: number;
}

function routeGroup(rawLine: string, current: RouteGroup | undefined): RouteGroup | undefined {
  const line = rawLine.replace(/^\s*\d+:\s?/, "");
  const trimmed = line.trim();
  const indent = /^\s*/.exec(line)![0].length;
  if (current && trimmed === "})" && indent <= current.indent) return undefined;
  const group = trimmed.match(/\.Route\(["'`](\/api\/[^"'`]+)["'`]/);
  return group ? { base: group[1], indent } : current;
}

function routeRegistration(rawLine: string, group: RouteGroup | undefined) {
  const trimmed = rawLine.replace(/^\s*\d+:\s?/, "").trim();
  const match = trimmed.match(/\.(?:Get|Post|Put|Delete|Patch)\(["'`](?<route>\/[^"'`]+)["'`]/);
  if (match === null) return undefined;
  const routePath = match.groups!.route;
  const route = routePath.startsWith("/api/") ? routePath : `${group === undefined ? "" : group.base}${routePath}`;
  return route.startsWith("/api/") ? { route, marker: routePath } : undefined;
}

function registeredRoutes(node: NodeFact, context: ArchitectureContext) {
  const routes = new Map<string, ArchitectureEvidence>();
  for (const source of architectureRuntimeSources(node, context.sources)) {
    let group: RouteGroup | undefined;
    for (const rawLine of source.content.split("\n")) {
      group = routeGroup(rawLine, group);
      const registration = routeRegistration(rawLine, group);
      if (!registration) continue;
      const evidence = findArchitectureEvidence(source, [registration.marker], "go-route-registration");
      if (evidence) routes.set(registration.route, evidence);
    }
  }
  return routes;
}

function httpCallEvidence(source: Parameters<typeof findArchitectureEvidence>[0], route: string) {
  return findArchitectureEvidence(source, [route], "go-internal-http-caller", (line) => {
    const code = line.replace(/^\s*\d+:\s?/, "").trim();
    const comment = ["//", "#", "*"].some((prefix) => code.startsWith(prefix));
    return !comment && /doJSON|http\.|NewRequest|fetch\(|\.Post\(|\.Get\(|request\(/.test(code);
  });
}

function internalHttpCalls(runtime: NodeFact, api: NodeFact, routes: Map<string, ArchitectureEvidence>, context: ArchitectureContext) {
  return architectureRuntimeSources(runtime, context.sources).flatMap((source) => [...routes.keys()].flatMap((route) => {
    const evidence = httpCallEvidence(source, route);
    return evidence ? [factEdge(`http:${runtime.id}->${api.id}:${route}`, runtime.id, api.id, "http", route, [evidence])] : [];
  }));
}

function agentWakeCalls(api: NodeFact, agents: NodeFact[], context: ArchitectureContext) {
  const evidence = architectureRuntimeSources(api, context.sources).flatMap((source) => {
    const match = findArchitectureEvidence(source, ["AgentWakeURL", "wakeRenderAgent"], "go-agent-wake");
    return match ? [match] : [];
  });
  if (evidence.length === 0) return [];
  return agents.map((agent) => factEdge(`http:${api.id}->${agent.id}:wake`, api.id, agent.id, "http", "Agent 唤醒", evidence));
}

export function goInternalHttpRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const apis = nodes.filter((node) => node.kind === "api" && node.id.startsWith("go:"));
  const runtimes = nodes.filter((node) => ["api", "worker", "agent", "cli"].includes(node.kind));
  const agents = nodes.filter((node) => node.kind === "agent");
  return apis.flatMap((api) => {
    const routes = registeredRoutes(api, context);
    const calls = runtimes.filter((runtime) => runtime.id !== api.id).flatMap((runtime) => internalHttpCalls(runtime, api, routes, context));
    return [...calls, ...agentWakeCalls(api, agents, context)];
  });
}
