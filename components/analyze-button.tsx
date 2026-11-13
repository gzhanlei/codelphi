"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestAnalysis } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";
import { useDemoGuard } from "./demo-mode";
import { InlineMessage, analysisButtonLabel } from "./form-feedback";

/** 有效写权限：edit=可写（编辑者/管理员），demo=匿名只读演示，readonly=登录只读成员。 */
export type WriteAccess = "edit" | "demo" | "readonly";

/**
 * 立即分析入口（设计 §11.2）：只读状态降为次要操作并明示原因——匿名给登录引导
 * （登录链接本身不产生写请求），只读成员给权限说明；实际写能力仍以服务端校验为准。
 */
export function AnalyzeButton({ slug, writeAccess = "edit" }: { slug: string; writeAccess?: WriteAccess }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function analyze() {
    if (guard()) return;
    setPending(true);
    setMessage("");
    try {
      await requestAnalysis(slug);
      setMessage("分析已排队，稍后刷新查看");
      router.refresh();
    } catch (error) {
      setMessage(errorMessage(error, "分析请求失败"));
    } finally {
      setPending(false);
    }
  }

  if (writeAccess === "demo") {
    return (
      <div className="analyze-control demo-gate">
        <span className="readonly-hint">只读演示：分析、编辑与发布需登录自己的工作区。</span>
        <Link className="secondary-button" href="/login">登录后可分析</Link>
      </div>
    );
  }
  if (writeAccess === "readonly") {
    return (
      <div className="analyze-control">
        <button className="secondary-button" type="button" disabled aria-disabled="true">发起分析 · 需编辑权限</button>
        <span className="readonly-hint">当前账号对该产品为只读权限。</span>
      </div>
    );
  }

  const quotaBlocked = message.includes("额度不足");
  return (
    <div className="analyze-control">
      <button className="primary-button" type="button" onClick={analyze} disabled={pending}>
        {analysisButtonLabel(pending)}
      </button>
      <InlineMessage message={message} />
      {quotaBlocked ? (
        <p className="quota-blocked-hint">
          分析未执行、未计费。<Link href="/pricing">升级套餐或购买超额包 →</Link>
        </p>
      ) : null}
    </div>
  );
}
