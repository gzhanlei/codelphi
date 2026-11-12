"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildFeatureFlow } from "@/lib/feature-flow";
import {
  layoutFeatureFlow,
  toReactFlowElements,
  type FeatureFlowReactNode,
} from "@/lib/feature-flow-layout";
import { evidenceItems, evidenceLabel } from "@/lib/evidence";
import type { ScenarioRow } from "@/lib/types";

const nodeTypes = {
  feature: FeatureNode,
};

const edgeTypes = {
  fanout: FanoutEdge,
};

function FanoutEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, label }: EdgeProps) {
  const trunkX = 16;
  const sourceBusY = sourceY + 24;
  const targetBusY = targetY - 32;
  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${sourceBusY} L ${trunkX} ${sourceBusY} L ${trunkX} ${targetBusY} L ${targetX} ${targetBusY} L ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="flow-fanout-label" style={{ transform: `translate(-50%, -50%) translate(${targetX}px, ${targetBusY}px)` }}>{label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function FitViewOnDetailsChange({ detailsOpen }: { detailsOpen: boolean }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.16, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [detailsOpen, fitView]);
  return null;
}

function categoryLabel(category: ScenarioRow["category"]) {
  return { happy: "Happy path", edge: "边界情况", error: "错误处理" }[category];
}

export function FeatureNode({ data }: NodeProps<FeatureFlowReactNode>) {
  const content = (
    <>
      {data.kind === "start" ? <span className="flow-node-kind">START</span> : null}
      <strong className="flow-title">{data.title}</strong>
      {data.kind !== "start" && data.outcome ? <span className="flow-outcome">{data.outcome}</span> : null}
    </>
  );
  return (
    <div className={`flow-react-node ${data.kind === "scenario" ? "scenario-node" : data.kind} cat-${data.category ?? "happy"}`}>
      {data.kind !== "start" ? <Handle type="target" position={Position.Top} /> : null}
      {data.kind === "start" ? <div className="flow-node-content">{content}</div> : (
        <button type="button" className="flow-node-content" aria-label={`查看 ${data.title} 的场景详情`}>
          {content}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function FeatureFlowDetails({ title, scenarios, onClose }: { title: string; scenarios: ScenarioRow[]; onClose: () => void }) {
  return (
    <aside className="flow-details" aria-labelledby="flow-details-title">
      <div className="flow-details-header">
        <div>
          <span className="flow-details-eyebrow">节点详情</span>
          <h3 id="flow-details-title">{title}</h3>
        </div>
        <button type="button" className="flow-details-close" onClick={onClose} aria-label="关闭详情">×</button>
      </div>
      <p className="flow-details-count">关联场景 {scenarios.length}</p>
      <div className="flow-scenario-list">
        {scenarios.map((scenario) => {
          const evidence = evidenceItems(scenario.evidence);
          return (
            <article className={`flow-scenario-card cat-${scenario.category}`} key={scenario.id}>
              <div className="flow-scenario-meta">
                <span className={`scenario-kind ${scenario.category}`}>{categoryLabel(scenario.category)}</span>
                <code>{scenario.reference}</code>
                {scenario.step ? <span>步骤 {scenario.step}</span> : null}
              </div>
              <dl>
                <div><dt>Context</dt><dd>{scenario.context}</dd></div>
                <div><dt>Action</dt><dd>{scenario.action}</dd></div>
                <div><dt>Outcome</dt><dd>{scenario.outcome}</dd></div>
              </dl>
              {evidence.length > 0 ? (
                <div className="flow-scenario-evidence">
                  <strong>代码证据</strong>
                  <div className="evidence-list">
                    {evidence.map((item) => item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" key={`${item.path}-${item.startLine ?? 0}`}>{evidenceLabel(item)} ↗</a>
                    ) : <code key={`${item.path}-${item.startLine ?? 0}`}>{evidenceLabel(item)}</code>)}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </aside>
  );
}

export function FeatureFlow({ featureName, scenarios }: { featureName: string; scenarios: ScenarioRow[] }) {
  const flow = useMemo(() => buildFeatureFlow(scenarios.map((scenario) => ({
    ...scenario,
    evidence: evidenceItems(scenario.evidence),
  }))), [scenarios]);
  const [elements, setElements] = useState<ReturnType<typeof toReactFlowElements> | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const [selected, setSelected] = useState<FeatureFlowReactNode | null>(null);

  useEffect(() => {
    if (!flow.structured) return;
    let active = true;
    setElements(null);
    setLayoutError(false);
    setSelected(null);
    void layoutFeatureFlow(flow).then((positioned) => {
      if (active) setElements(toReactFlowElements(positioned, scenarios));
    }).catch(() => {
      if (active) setLayoutError(true);
    });
    return () => {
      active = false;
    };
  }, [flow, scenarios]);

  return (
    <section className="feature-flow" aria-label={`${featureName} 流程图`}>
      <div className="flow-note">根据场景步骤与情境自动生成。拖拽平移、滚轮缩放；点击节点查看完整场景和代码证据。</div>
      {!flow.structured ? (
        <div className="empty-state">该功能没有步骤顺序或多情境分支的结构证据，暂不渲染流程图；完整场景清单见「场景」标签。</div>
      ) : layoutError ? (
        <div className="empty-state" role="alert">自动布局暂时不可用，请刷新重试；完整场景清单见「场景」标签。</div>
      ) : (
        <div className={`flow-workspace${selected ? " has-details" : ""}`}>
          <div className="flow-canvas" aria-busy={!elements}>
            {elements ? (
              <ReactFlow
                key={`${featureName}-${elements.nodes.length}-${elements.edges.length}`}
                defaultNodes={elements.nodes}
                defaultEdges={elements.edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={1.75}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable
                edgesFocusable
                elementsSelectable
                onNodeClick={(_, node) => {
                  if (node.data.scenarios.length > 0) setSelected(node as FeatureFlowReactNode);
                }}
                onPaneClick={() => setSelected(null)}
                proOptions={{ hideAttribution: false }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="#cbd8d1" />
                <Controls position="top-right" showInteractive={false} aria-label="流程图视图控制" />
                <FitViewOnDetailsChange detailsOpen={selected !== null} />
                <Panel position="bottom-left" className="flow-legend">实线：顺序　虚线：边界 / 错误</Panel>
              </ReactFlow>
            ) : <div className="flow-loading">正在计算流程布局…</div>}
          </div>
          {selected ? <FeatureFlowDetails title={selected.data.title} scenarios={selected.data.scenarios} onClose={() => setSelected(null)} /> : null}
        </div>
      )}
    </section>
  );
}
