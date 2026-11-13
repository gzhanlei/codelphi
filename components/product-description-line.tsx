"use client";

import { EditDescriptionButton } from "./edit-description-button";

/**
 * 产品简介行（头部整合）：全文展示不截断；✎ 编辑入口仅编辑者可见。
 * 空简介不渲染占位。
 */
export function ProductDescriptionLine({ slug, text, canEdit }: { slug: string; text: string; canEdit: boolean }) {
  const trimmed = text.trim();
  if (!trimmed) {
    return canEdit ? (
      <div className="product-desc-row">
        <p className="product-desc empty">尚无产品简介——点击 ✎ 由 AI 生成或手写。</p>
        <span className="product-desc-tools"><EditDescriptionButton slug={slug} description="" /></span>
      </div>
    ) : null;
  }
  return (
    <div className="product-desc-row">
      <p className="product-desc">{trimmed}</p>
      {canEdit ? <span className="product-desc-tools"><EditDescriptionButton slug={slug} description={trimmed} /></span> : null}
    </div>
  );
}
