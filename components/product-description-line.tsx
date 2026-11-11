"use client";

import { useState } from "react";
import { EditDescriptionButton } from "./edit-description-button";

/**
 * 产品简介行（头部整合）：两行截断，点击展开全文；✎ 编辑入口仅编辑者可见。
 * 空简介不渲染占位。
 */
export function ProductDescriptionLine({ slug, text, canEdit }: { slug: string; text: string; canEdit: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) {
    return canEdit ? (
      <div className="product-desc-row">
        <p className="product-desc empty">尚无产品简介——点击 ✎ 由 AI 生成或手写。</p>
        <span className="product-desc-tools"><EditDescriptionButton slug={slug} description="" /></span>
      </div>
    ) : null;
  }
  const long = trimmed.length > 90;
  return (
    <div className="product-desc-row">
      <p className={`product-desc${long && !expanded ? " clamp" : ""}`} title={long && !expanded ? trimmed : undefined}>{trimmed}</p>
      <span className="product-desc-tools">
        {long ? <button className="text-button" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开全文"}</button> : null}
        {canEdit ? <EditDescriptionButton slug={slug} description={trimmed} /> : null}
      </span>
    </div>
  );
}
