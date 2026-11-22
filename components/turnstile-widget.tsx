"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Cloudflare Turnstile widget（注册/登录页人机验证）：
 * - 显式渲染（render=explicit）拿到 widgetId；token 经 onToken 上交给表单。
 * - token 单次有效：提交失败后调用方必须 reset()（每个受保护面保留并重置自己的 widgetId）。
 * - siteverify 不在本项目执行——token 随 cf_turnstile_response 透传给 Chandler 服务端校验，
 *   绝不能在浏览器或 CoDelphi 服务端消费 token（二次 siteverify 必失败）。
 */

interface TurnstileApi {
  render: (container: HTMLElement, params: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const WIDGET_TIMEOUT_MS = 30_000;

let loader: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("turnstile requires a browser"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loader) {
    loader = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => {
        loader = null;
        reject(new Error("turnstile_load_timeout"));
      }, WIDGET_TIMEOUT_MS);
      script.src = SCRIPT_SRC;
      script.async = true;
      script.addEventListener("load", () => {
        window.clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else {
          loader = null;
          reject(new Error("turnstile_api_missing"));
        }
      });
      script.addEventListener("error", () => {
        window.clearTimeout(timer);
        script.remove();
        loader = null;
        reject(new Error("turnstile_load_failed"));
      });
      document.head.appendChild(script);
    });
  }
  return loader;
}

export interface TurnstileHandle {
  reset: () => void;
}

interface TurnstileWidgetProps {
  sitekey: string;
  /** Turnstile action（1-32 字符）：注册面用 "register"，登录面用 "login"，与 Chandler 校验口径一致。 */
  action: string;
  onToken: (token: string) => void;
  onError?: (message: string) => void;
  label?: string;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, TurnstileWidgetProps>(function TurnstileWidget(
  { sitekey, action, onToken, onError, label },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  const reset = useCallback(() => {
    const widgetId = widgetIdRef.current;
    if (widgetId && window.turnstile) {
      window.turnstile.reset(widgetId);
    }
    onTokenRef.current("");
  }, []);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  useEffect(() => {
    if (!sitekey) return;
    let cancelled = false;
    let mountedWidgetId: string | null = null;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        mountedWidgetId = turnstile.render(containerRef.current, {
          sitekey,
          action,
          callback: (token: string) => onTokenRef.current(token),
          // token 过期/校验组件出错都回到未完成态，等待用户重试或 reset
          "expired-callback": () => onTokenRef.current(""),
          "error-callback": (code: string) => {
            onTokenRef.current("");
            onErrorRef.current?.(code);
          },
        });
        widgetIdRef.current = mountedWidgetId;
      })
      .catch((error: unknown) => {
        if (!cancelled) onErrorRef.current?.(error instanceof Error ? error.message : "turnstile_load_failed");
      });
    return () => {
      cancelled = true;
      if (mountedWidgetId && window.turnstile) {
        window.turnstile.remove(mountedWidgetId);
      }
      widgetIdRef.current = null;
    };
  }, [sitekey, action]);

  if (!sitekey) return null;

  return (
    <label className="auth-field">
      <span>{label}</span>
      <div className="turnstile-slot" ref={containerRef} />
    </label>
  );
});
