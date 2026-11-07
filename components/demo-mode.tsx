"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";

type DemoMode = { demo: boolean; showNotice: () => void };

const DemoModeContext = createContext<DemoMode>({ demo: false, showNotice: () => {} });

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  return (
    <DemoModeContext.Provider value={{ demo: true, showNotice: () => dialogRef.current?.showModal() }}>
      {children}
      <dialog className="description-dialog demo-mode-dialog" ref={dialogRef} aria-label="Demo 模式提示">
        <h3>Demo 模式</h3>
        <p>这是 CoDelphi 的只读演示站点，编辑内容不会保存。</p>
        <p className="description-dialog-hint">登录后可在自己的工作区体验完整功能。</p>
        <div className="description-dialog-actions">
          <button className="primary-button" type="button" onClick={() => dialogRef.current?.close()}>知道了</button>
        </div>
      </dialog>
    </DemoModeContext.Provider>
  );
}

export function useDemoMode() {
  return useContext(DemoModeContext);
}

/** Demo 模式统一拦截：展示只读提示并返回 true，调用方据此跳过写操作。 */
export function demoIntercepted(demo: boolean, showNotice: () => void) {
  if (demo) showNotice();
  return demo;
}

export function useDemoGuard() {
  const { demo, showNotice } = useDemoMode();
  return () => demoIntercepted(demo, showNotice);
}
