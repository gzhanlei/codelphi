"use client";

import { useEffect } from "react";

/**
 * 使用场景默认折叠成卡片（原生 details，无 JS 也能点开）。从总览的典型场景卡或页内「途经」链接
 * 带着 #journey-N 进来时，替读者把落点那一条展开——否则深链会对着一张折叠的卡片。
 * 只做这一件事：没有 hash、目标不是使用场景、或它已经展开时，什么都不动。
 */
export function JourneyDeepLink() {
  useEffect(() => {
    const openTarget = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      // 页内锚点还有分组（#capability-N、#headline），只展开使用场景自己
      if (target instanceof HTMLDetailsElement && target.classList.contains("journey")) target.open = true;
    };
    openTarget();
    window.addEventListener("hashchange", openTarget);
    return () => window.removeEventListener("hashchange", openTarget);
  }, []);
  return null;
}
