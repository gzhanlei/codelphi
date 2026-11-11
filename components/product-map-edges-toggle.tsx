"use client";

import { useState, type ReactNode } from "react";

/**
 * 地图连线降噪开关（唯一客户端岛屿）：画布本体仍由服务端渲染，全部连线都在 DOM 中，
 * 默认用 CSS 隐藏前 N 条强连接之外的连线；开关只翻容器类名，不做任何数据请求。
 */
export function MapEdgesToggle({ children, extraCount }: { children: ReactNode; extraCount: number }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div className={showAll ? "map-body map--all-edges" : "map-body"}>
      <div className="map-canvas">{children}</div>
      {extraCount > 0 ? (
        <button className="text-button map-edges-toggle" type="button" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "只看强连接" : `显示全部连线（+${extraCount}）`}
        </button>
      ) : null}
    </div>
  );
}
