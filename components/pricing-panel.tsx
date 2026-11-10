"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

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

export function PricingPanel() {
  const [offers, setOffers] = useState<Offers | null>(null);
  const [channel, setChannel] = useState<"wechat" | "alipay">("wechat");
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
        body: JSON.stringify({ ...body, channel }),
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
  }, [channel]);

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

  if (!offers) return <div className="panel"><p>加载中…</p></div>;
  if (offers.plans.length === 0) {
    return (
      <div className="panel">
        <h2>定价校准中</h2>
        <p>套餐价格与配额正在按实测用量校准，暂不开放购买。已注册账户保留试用额度。</p>
      </div>
    );
  }

  return (
    <>
      <div className="channel-toggle">
        <button className={channel === "wechat" ? "primary-button" : "text-button"} type="button" onClick={() => setChannel("wechat")}>微信支付</button>
        <button className={channel === "alipay" ? "primary-button" : "text-button"} type="button" onClick={() => setChannel("alipay")}>支付宝</button>
      </div>
      <div className="pricing-grid">
        {offers.plans.map((plan) => (
          <div className="panel pricing-card" key={plan.planId}>
            <h2>{plan.planId}</h2>
            <p className="price">¥{(plan.amount / 100).toFixed(2)} / {plan.durationMonths} 个月</p>
            <p>每月包含 {plan.includedSau} SAU 标准分析额度</p>
            <p>失败不扣额度 · 消费封顶可配 · 规格历史永久保留</p>
            <button className="primary-button" type="button" disabled={pending}
              onClick={() => purchase({ kind: "subscription", planId: plan.planId, durationMonths: plan.durationMonths })}>
              {pending ? "下单中…" : "订阅"}
            </button>
          </div>
        ))}
        {offers.overageEnabled
          ? offers.packs.map((pack) => (
            <div className="panel pricing-card" key={pack.sku}>
              <h2>超额包 {pack.sku}</h2>
              <p className="price">¥{(pack.amount / 100).toFixed(2)}</p>
              <p>额外 {pack.units} SAU（12 个月有效）</p>
              <button className="primary-button" type="button" disabled={pending}
                onClick={() => purchase({ kind: "overage_pack", packSku: pack.sku })}>
                {pending ? "下单中…" : "购买"}
              </button>
            </div>
          ))
          : null}
      </div>

      {order ? (
        <div className="panel" id="pay-panel">
          <h2>待支付订单 {order.orderNo.slice(0, 18)}…</h2>
          {order.status === "pending" ? (
            <>
              {order.prepay?.codeUrl ? (
                <>
                  {qrDataUrl ? <img src={qrDataUrl} alt="微信支付二维码" width={220} height={220} style={{ border: "1px solid #ddd", borderRadius: 8 }} /> : null}
                  <p>微信扫码：请打开微信「扫一扫」支付<br /><code className="pay-code">{order.prepay.codeUrl}</code></p>
                </>
              ) : null}
              {order.prepay?.h5Url ? <p><a href={order.prepay.h5Url} target="_blank" rel="noreferrer">打开微信 H5 收银台支付 →</a></p> : null}
              {order.prepay?.payUrl ? <p><a href={order.prepay.payUrl} target="_blank" rel="noreferrer">打开支付宝支付 →</a></p> : null}
              <p>支付完成后本页自动更新（轮询中…）。</p>
            </>
          ) : order.status === "fulfilled" || order.status === "paid" ? (
            <p className="success-text">支付成功，额度已到账。可在「设置」页查看余额。</p>
          ) : (
            <p>订单状态：{order.status}。如长时间未更新请刷新或联系支持。</p>
          )}
        </div>
      ) : null}
      {message ? <p className="error-text">{message}</p> : null}
    </>
  );
}
