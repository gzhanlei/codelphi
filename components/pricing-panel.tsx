"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PRICING_PANEL } from "@/lib/ui-strings/workspace";

/**
 * 套餐购买面板（M4-T2）：POST /api/pay/orders 建单 → 展示渠道支付参数 → 轮询查单至终态。
 * 额度耗尽/闸门拒绝的语义在服务端（402/409），此处只做展示与轮询。
 */

interface PlanOffer {
  planId: string;
  amount: number;
  includedSau: number;
  durationMonths: number;
}
interface PackOffer {
  sku: string;
  amount: number;
  units: number;
}
interface Offers {
  plans: PlanOffer[];
  packs: PackOffer[];
  overageEnabled: boolean;
}
interface OrderState {
  orderNo: string;
  status: string;
  refundStatus?: string;
  prepay?: { codeUrl?: string | null; payUrl?: string | null; h5Url?: string | null };
}

export function PricingPanel({ locale = "zh-CN" }: { locale?: UiLocale }) {
  const L = PRICING_PANEL;
  const [offers, setOffers] = useState<Offers | null>(null);
  const [order, setOrder] = useState<OrderState | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const codeUrl = order?.prepay?.codeUrl;
    if (!codeUrl || order?.status !== "pending") {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(codeUrl, { width: 440, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(null));
  }, [order?.prepay?.codeUrl, order?.status]);

  useEffect(() => {
    fetch("/api/pay/pricing")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setOffers(data))
      .catch(() => setOffers({ plans: [], packs: [], overageEnabled: false }));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const purchase = useCallback(async (body: Record<string, unknown>) => {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/pay/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 支付宝暂不开放（渠道参数服务端保留，恢复时只需加回渠道切换）
        body: JSON.stringify({ ...body, channel: "wechat" }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) setMessage("请先登录后再购买");
        else if (data.error === "payment_unavailable" || data.error === "billing_state_conflict") setMessage(data.message ?? "当前无法购买，请稍后再试");
        else setMessage(data.error ?? "下单失败");
        return;
      }
      setOrder(data as OrderState);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下单失败");
    } finally {
      setPending(false);
    }
  }, []);

  // 订单轮询：pending 每 3 秒查一次，终态停止
  useEffect(() => {
    if (!order || (order.status !== "pending")) return;
    pollRef.current = setInterval(async () => {
      const response = await fetch(`/api/pay/orders/${order.orderNo}`);
      if (!response.ok) return;
      const data = (await response.json()) as OrderState;
      if (data.status !== "pending") setOrder(data);
    }, 3_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [order]);

  if (!offers) return <div className="panel"><p>{pick(locale, L.loading)}</p></div>;
  if (offers.plans.length === 0) {
    return (
      <div className="panel">
        <h2>{pick(locale, L.calibratingHeading)}</h2>
        <p>{pick(locale, L.calibratingBody)}</p>
      </div>
    );
  }

  return (
    <>
      <div className="pricing-grid">
        {offers.plans.map((plan) => (
          <div className="panel pricing-card" key={plan.planId}>
            <h2>{plan.planId}</h2>
            <p className="price">¥{(plan.amount / 100).toFixed(2)} / {plan.durationMonths}{pick(locale, L.priceMonthUnit)}</p>
            <p>{pick(locale, L.monthlyIncludePrefix)}{plan.includedSau}{pick(locale, L.monthlyIncludeSuffix)}</p>
            <p>{pick(locale, L.planPromise)}</p>
            <button className="primary-button" type="button" disabled={pending}
              onClick={() => purchase({ kind: "subscription", planId: plan.planId, durationMonths: plan.durationMonths })}>
              {pending ? pick(locale, L.ordering) : pick(locale, L.subscribeButton)}
            </button>
          </div>
        ))}
        {offers.overageEnabled
          ? offers.packs.map((pack) => (
            <div className="panel pricing-card" key={pack.sku}>
              <h2>{pick(locale, L.packHeadingPrefix)}{pack.sku}</h2>
              <p className="price">¥{(pack.amount / 100).toFixed(2)}</p>
              <p>{pick(locale, L.packExtraPrefix)}{pack.units}{pick(locale, L.packExtraSuffix)}</p>
              <button className="primary-button" type="button" disabled={pending}
                onClick={() => purchase({ kind: "overage_pack", packSku: pack.sku })}>
                {pending ? pick(locale, L.ordering) : pick(locale, L.buyButton)}
              </button>
            </div>
          ))
          : null}
      </div>

      {order ? (
        <div className="panel" id="pay-panel">
          <h2>{pick(locale, L.pendingOrderPrefix)}{order.orderNo.slice(0, 18)}…</h2>
          {order.status === "pending" ? (
            <>
              {order.prepay?.codeUrl ? (
                <>
                  {qrDataUrl ? <img src={qrDataUrl} alt={pick(locale, L.qrAlt)} width={220} height={220} style={{ border: "1px solid #ddd", borderRadius: 8 }} /> : null}
                  <p>{pick(locale, L.wechatScan)}<br /><code className="pay-code">{order.prepay.codeUrl}</code></p>
                </>
              ) : null}
              {order.prepay?.h5Url ? <p><a href={order.prepay.h5Url} target="_blank" rel="noreferrer">{pick(locale, L.wechatH5Link)}</a></p> : null}
              <p>{pick(locale, L.pollingNote)}</p>
            </>
          ) : order.status === "fulfilled" || order.status === "paid" ? (
            <p className="success-text">{pick(locale, L.paidNotice)}</p>
          ) : (
            <p>{pick(locale, L.statusPrefix)}{order.status}{pick(locale, L.statusSuffix)}</p>
          )}
        </div>
      ) : null}
      {message ? <p className="error-text">{message}</p> : null}
    </>
  );
}
