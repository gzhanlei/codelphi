import { buildFeatureFlow, clipFlowLabel, findEdgeNodes, type FlowEdge, type FlowNode } from "@/lib/feature-flow";
import { evidenceItems } from "@/lib/evidence";
import type { ScenarioRow } from "@/lib/types";

function BranchEdge({ source, target }: { source: FlowNode; target: FlowNode }) {
  return <path className="flow-edge branch" d={`M ${source.x + 80} ${source.y + 70} C ${source.x + 80} ${source.y + 100}, ${target.x + 80} ${target.y - 35}, ${target.x + 80} ${target.y}`} markerEnd="url(#flow-arrow)" />;
}

function RequiredEdge({ source, target }: { source: FlowNode; target: FlowNode }) {
  if (target.kind === "branch" && source.kind === "scenario") return <BranchEdge source={source} target={target} />;
  return <line className="flow-edge" x1={source.x + 160} y1={source.y + 35} x2={target.x} y2={target.y + 35} markerEnd="url(#flow-arrow)" />;
}

const ENTRY_WIDTH = 120;
const TRUNK_X = 20 + ENTRY_WIDTH + 30;

/** 入口干线：一条竖线从「开始工作」下行，各场景用带箭头的短支线接入——29 条边不会挤成一股缆绳。 */
function EntryEdgeBundle({ source, edges, nodes }: { source: FlowNode; edges: FlowEdge[]; nodes: FlowNode[] }) {
  const stubs = edges.flatMap((edge) => {
    const endpoints = findEdgeNodes(edge, nodes);
    if (!endpoints || endpoints.source.id !== source.id) return [];
    return [{ edge, target: endpoints.target }];
  });
  if (stubs.length === 0) return null;
  const x0 = source.x + ENTRY_WIDTH;
  const y0 = source.y + 35;
  const bottom = Math.max(y0, ...stubs.map(({ target }) => target.y + 35));
  return (
    <g>
      <path className="flow-edge" d={`M ${x0} ${y0} L ${TRUNK_X} ${y0} L ${TRUNK_X} ${bottom}`} />
      {stubs.map(({ edge, target }) => (
        <path key={edge.id} className={`flow-edge${target.kind === "branch" ? " branch" : ""}`} d={`M ${TRUNK_X} ${target.y + 35} L ${target.x} ${target.y + 35}`} markerEnd="url(#flow-arrow)" />
      ))}
    </g>
  );
}

function EdgeLabel({ edge, nodes }: { edge: FlowEdge; nodes: FlowNode[] }) {
  const endpoints = findEdgeNodes(edge, nodes);
  if (!endpoints || !edge.label) return null;
  return <text className="flow-edge-label" x={endpoints.target.x + 2} y={endpoints.target.y - 7}>{clipFlowLabel(edge.label, 24)}</text>;
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
    <g className={`flow-node ${node.kind} cat-${node.category ?? "happy"}`}>
      <rect x={node.x} y={node.y} width={node.kind === "start" ? ENTRY_WIDTH : 160} height={70} rx={8} />
      {/* React 19 会把 <title> 当文档元数据提升到 head，SVG 内的悬浮提示必须用原始 HTML 注入。 */}
      <title dangerouslySetInnerHTML={{ __html: tooltip }} />
      <NodeText node={node} />
    </g>
  );
}

export function FeatureFlow({ featureName, scenarios }: { featureName: string; scenarios: ScenarioRow[] }) {
  const flow = buildFeatureFlow(scenarios.map((scenario) => ({ ...scenario, evidence: evidenceItems(scenario.evidence) })));
  const entry = flow.nodes.find((node) => node.kind === "start");
  const chainEdges = flow.edges.filter((edge) => {
    const endpoints = findEdgeNodes(edge, flow.nodes);
    return endpoints && endpoints.source.kind !== "start";
  });
  return (
    <section className="feature-flow">
      <div className="flow-note">图从「开始工作」单一入口展开：入口引出一条干线，各场景经短支线接入，支线上方小字是进入该分支的情境（前置条件，即条件判断）；同一情境下标注了步骤顺序（step 1..N）的场景连成绿色实线主链（顺序结构）；虚线分支表示该情境下的出错/边界结果，不是顺序；没有步骤标注的场景并列排布，不代表先后。循环结构目前没有标注协议，图中不表达。</div>
      {!flow.structured ? <div className="empty-state">该功能没有步骤顺序或多情境分支的结构证据，暂不渲染流程图（避免画出没有控制结构支撑的假流程）；完整场景清单见「场景」标签。</div> : (
      <div className="flow-canvas">
        <svg role="img" aria-label={`${featureName} 流程图`} viewBox={`0 0 ${flow.width} ${flow.height}`}>
          <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {entry ? <EntryEdgeBundle source={entry} edges={flow.edges} nodes={flow.nodes} /> : null}
          {chainEdges.map((edge) => <Edge edge={edge} nodes={flow.nodes} key={edge.id} />)}
          {flow.edges.map((edge) => <EdgeLabel edge={edge} nodes={flow.nodes} key={`label-${edge.id}`} />)}
          {flow.nodes.map((node) => <Node node={node} key={node.id} />)}
        </svg>
      </div>
      )}
    </section>
  );
}
