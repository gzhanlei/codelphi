import { buildFeatureFlow, clipFlowLabel, findEdgeNodes, type FlowEdge, type FlowNode } from "@/lib/feature-flow";
import { evidenceItems } from "@/lib/evidence";
import type { ScenarioRow } from "@/lib/types";

function BranchEdge({ source, target }: { source: FlowNode; target: FlowNode }) {
  return <path className="flow-edge branch" d={`M ${source.x + 80} ${source.y + 70} C ${source.x + 80} ${source.y + 100}, ${target.x + 80} ${target.y - 35}, ${target.x + 80} ${target.y}`} markerEnd="url(#flow-arrow)" />;
}

function RequiredEdge({ source, target }: { source: FlowNode; target: FlowNode }) {
  if (target.kind === "branch") return <BranchEdge source={source} target={target} />;
  return <line className="flow-edge" x1={source.x + 160} y1={source.y + 35} x2={target.x} y2={target.y + 35} markerEnd="url(#flow-arrow)" />;
}

function Edge({ edge, nodes }: { edge: FlowEdge; nodes: FlowNode[] }) {
  const endpoints = findEdgeNodes(edge, nodes);
  if (!endpoints) return null;
  return <RequiredEdge source={endpoints.source} target={endpoints.target} />;
}

function ReferenceText({ node }: { node: FlowNode }) {
  if (!node.reference) return null;
  return <text className="flow-reference" x={node.x + 10} y={node.y + 17}>{node.reference}</text>;
}

function OutcomeText({ node }: { node: FlowNode }) {
  if (!node.outcome) return null;
  return <text className="flow-outcome" x={node.x + 10} y={node.y + 56}>{clipFlowLabel(node.outcome)}</text>;
}

function NodeText({ node }: { node: FlowNode }) {
  return <>
    <ReferenceText node={node} />
    <text className="flow-title" x={node.x + 10} y={node.y + (node.reference ? 36 : 30)}>{clipFlowLabel(node.title)}</text>
    <OutcomeText node={node} />
  </>;
}

function Node({ node }: { node: FlowNode }) {
  const tooltip = `${node.title}${node.outcome ? ` → ${node.outcome}` : ""}`;
  return (
    <g className={`flow-node ${node.kind}`}>
      <rect x={node.x} y={node.y} width={160} height={70} rx={8} />
      {/* React 19 会把 <title> 当文档元数据提升到 head，SVG 内的悬浮提示必须用原始 HTML 注入。 */}
      <title dangerouslySetInnerHTML={{ __html: tooltip }} />
      <NodeText node={node} />
    </g>
  );
}

export function FeatureFlow({ featureName, scenarios }: { featureName: string; scenarios: ScenarioRow[] }) {
  const flow = buildFeatureFlow(scenarios.map((scenario) => ({ ...scenario, evidence: evidenceItems(scenario.evidence) })));
  return (
    <section className="feature-flow">
      <div className="flow-note">每个场景从使用情境独立展开，节点内即操作与结果；不按编号推断先后顺序，也不添加额外结束条件。</div>
      {flow.nodes.length === 0 ? <div className="empty-state">暂无可推导的场景。</div> : (
      <div className="flow-canvas">
        <svg role="img" aria-label={`${featureName} 流程图`} viewBox={`0 0 ${flow.width} ${flow.height}`}>
          <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {flow.edges.map((edge) => <Edge edge={edge} nodes={flow.nodes} key={edge.id} />)}
          {flow.nodes.map((node) => <Node node={node} key={node.id} />)}
        </svg>
      </div>
      )}
    </section>
  );
}
