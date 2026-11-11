import { featureHref } from "@/lib/spec-editor-ui";
import { buildProductMap, type ProductMapEdge, type ProductMapNode } from "@/lib/product-map";
import { MapEdgesToggle } from "./product-map-edges-toggle";
import type { FeatureRow, ScenarioRow } from "@/lib/types";

/**
 * 产品行为地图视图（B3.2）：服务端组件，零客户端 JS——悬停提示与连接依据与 feature-flow
 * 同款（React 19 会把 SVG <title> 提升到 head，悬浮提示必须用原始 HTML 注入）。
 * 空态显式：0 功能与 0 连接各自有说明，不静默隐藏（入口偏好红线）。
 */

function NodeTooltip({ node }: { node: ProductMapNode }) {
  const meta = node.kind === "feature" && node.childCount > 0 ? ` · ${node.childCount} 个子功能` : "";
  const tooltip = `${node.name}（${node.scenarioCount} 场景${meta}）${node.summary ? `\n${node.summary}` : ""}`;
  return <title dangerouslySetInnerHTML={{ __html: tooltip }} />;
}

function MapNodeShape({ node }: { node: ProductMapNode }) {
  const meta = node.kind === "feature" ? `${node.scenarioCount} 场景${node.childCount > 0 ? ` · ${node.childCount} 子功能` : ""}` : `${node.scenarioCount} 场景`;
  return (
    <g className={`map-node ${node.kind}`}>
      <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={8} />
      <NodeTooltip node={node} />
      <text className="map-title" x={node.x + 12} y={node.y + (node.kind === "feature" ? 26 : 21)}>{node.label}</text>
      <text className="map-meta" x={node.x + 12} y={node.y + (node.kind === "feature" ? 47 : 39)}>{meta}</text>
    </g>
  );
}

function MapEdgePath({ edge, nodes }: { edge: ProductMapEdge; nodes: ProductMapNode[] }) {
  const source = nodes.find((node) => node.id === edge.sourceId);
  const target = nodes.find((node) => node.id === edge.targetId);
  if (!source || !target) return null;
  const x1 = source.x + source.w / 2;
  const y1 = source.y + source.h / 2;
  const x2 = target.x + target.w / 2;
  const y2 = target.y + target.h / 2;
  const bend = Math.max(Math.abs(x2 - x1) / 2, 40);
  const tooltip = `${edge.sourceName} ⇄ ${edge.targetName} · 共享证据面（前 ${edge.sharedFiles.length} 个文件）：${edge.sharedFiles.map((file) => file.path).join("、")}`;
  return (
    <path className={edge.visible ? "map-edge" : "map-edge extra"} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}>
      <title dangerouslySetInnerHTML={{ __html: tooltip }} />
    </path>
  );
}

export function ProductMapView({ features, scenarios }: { features: FeatureRow[]; scenarios: ScenarioRow[] }) {
  const map = buildProductMap(features, scenarios);
  const { stats } = map;
  if (stats.featureCount === 0) {
    return (
      <section className="product-map">
        <div className="empty-state">尚无功能数据。先生成一次分析，或在产品规格页手动添加功能；地图会随规格自动更新。</div>
      </section>
    );
  }
  return (
    <section className="product-map">
      <div className="map-note">
        {stats.topLevelCount} 个顶层功能（含 {stats.childCount} 个子功能）· {stats.scenarioCount} 场景 · {stats.edgeCount} 条共享证据面连接{stats.edgeCount > stats.visibleEdgeCount ? `，默认只显前 ${stats.visibleEdgeCount} 条强连接` : ""}{stats.truncatedEdgeCount > 0 ? `（超出上限的 ${stats.truncatedEdgeCount} 条见下方依据清单）` : ""}。节点点击进入功能详情；悬停连线查看两个功能如何关联。连接来自 B3 确定性层（共享证据文件），不表示调用或依赖方向。
      </div>
      <MapEdgesToggle extraCount={Math.max(map.edges.filter((edge) => !edge.visible).length, 0)}>
        <svg role="img" aria-label="产品行为地图" viewBox={`0 0 ${map.width} ${map.height}`}>
          {map.edges.map((edge) => <MapEdgePath edge={edge} nodes={map.nodes} key={edge.id} />)}
          {map.nodes.map((node) => (
            <a href={featureHref(node.id)} key={node.id}>
              <MapNodeShape node={node} />
            </a>
          ))}
        </svg>
      </MapEdgesToggle>
      {stats.edgeCount === 0 ? (
        <div className="empty-state">暂无功能间共享证据面连接：B3 确定性层未发现跨功能共享的证据文件（常见于功能边界清晰的产品）。功能节点仍完整列出，不表示功能彼此独立。</div>
      ) : (
        <details className="map-connections">
          <summary>连接依据（{stats.edgeCount} 条{stats.truncatedEdgeCount > 0 ? `，已截断 ${stats.truncatedEdgeCount} 条` : ""}）</summary>
          <ul>
            {map.edges.map((edge) => (
              <li key={edge.id}>
                <strong>{edge.sourceName} ⇄ {edge.targetName}</strong>
                <span>共享证据文件（前 5）：{edge.sharedFiles.map((file) => file.path).join("、")}（共享引用 {edge.weight} 处）</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
