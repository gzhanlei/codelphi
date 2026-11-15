"use client";


import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PAY_ORDERS } from "@/lib/ui-strings/admin";

export interface AdminOrderRow {
  order_no: string;
  platform_order_no: string | null;
  kind: string;
  channel: string;
  amount: number;
  status: string;
  refund_status: string;
  refund_amount: number | null;
  created_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
}

const STATUS_LABEL: Record<string, keyof typeof PAY_ORDERS> = {
  pending: "statusPending",
  paid: "statusPaid",
  fulfilled: "statusFulfilled",
  closed: "statusClosed",
  refunded: "statusRefunded",
  failed: "statusFailed",
};

const REFUND_LABEL: Record<string, keyof typeof PAY_ORDERS> = {
  none: "refundNone",
  refund_pending: "refundPending",
  refund_submitted: "refundSubmitted",
  refund_confirmed: "refundConfirmed",
  refund_failed: "refundFailed",
};

/** 超管支付操作面板：测试单创建、订单台账、退款（动作走既有 API，状态机语义在服务端）。 */
function PayQrCode({ codeUrl, locale }: { codeUrl: string; locale: UiLocale }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(codeUrl, { width: 440, margin: 1 }).then(setDataUrl).catch(() => setDataUrl(null));
  }, [codeUrl]);
  if (!dataUrl) return <p>{pick(locale, PAY_ORDERS.qrGenerating)}</p>;
  return (
    <p style={{ textAlign: "center" }}>
      {pick(locale, PAY_ORDERS.qrWechat)}
      <br />
      <img src={dataUrl} alt={pick(locale, PAY_ORDERS.qrWechatAlt)} width={220} height={220} style={{ border: "1px solid #ddd", borderRadius: 8 }} />
    </p>
  );
}

export function AdminPayOrders({ orders, locale = "zh-CN" }: { orders: AdminOrderRow[]; locale?: UiLocale }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [prepay, setPrepay] = useState<{ codeUrl?: string | null; payUrl?: string | null; h5Url?: string | null; orderNo: string } | null>(null);

  async function createTestOrder() {
    setPending("test");
    setMessage("");
    setPrepay(null);
    try {
      const response = await fetch("/api/admin/pay/test-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "wechat" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`测试单创建失败（${response.status}）：${data.error ?? data.message ?? "未知错误"}`);
        return;
      }
      setPrepay({ codeUrl: data.prepay?.codeUrl ?? null, payUrl: data.prepay?.payUrl ?? null, h5Url: data.prepay?.h5Url ?? null, orderNo: data.orderNo });
      setMessage(`测试单已创建：${data.orderNo}。请扫码支付，支付后 webhook 自动履约（kind=test 不授予任何权益）。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试单创建失败");
    } finally {
      setPending(null);
    }
  }

  async function refund(orderNo: string) {
    setPending(orderNo);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/pay/orders/${orderNo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "联调测试退款" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`退款请求失败（${response.status}）：${data.message ?? data.error ?? "未知错误"}`);
        return;
      }
      setMessage(`退款请求已提交：${data.refundStatus}（金额 ${data.refundAmount} 分）。超时会停在 refund_submitted 由对账自动推进确认。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退款请求失败");
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>{pick(locale, PAY_ORDERS.testHeading)}</h2>
        <p>{pick(locale, PAY_ORDERS.testBody)}</p>
        <button className="primary-button" type="button" onClick={createTestOrder} disabled={pending !== null}>
          {pending === "test" ? pick(locale, PAY_ORDERS.creating) : pick(locale, PAY_ORDERS.createTest)}
        </button>
        {prepay ? (
          <div>
            {prepay.codeUrl ? <PayQrCode codeUrl={prepay.codeUrl} locale={locale} /> : null}
            {prepay.h5Url ? <p><a href={prepay.h5Url} target="_blank" rel="noreferrer">{pick(locale, PAY_ORDERS.wechatH5)}</a></p> : null}
            {prepay.payUrl ? <p><a href={prepay.payUrl} target="_blank" rel="noreferrer">{pick(locale, PAY_ORDERS.alipay)}</a></p> : null}
          </div>
        ) : null}
      </div>

      {message ? <div className="panel"><p>{message}</p></div> : null}

      <div className="panel">
        <h2>{pick(locale, PAY_ORDERS.ledgerHeading)}</h2>
        <table className="scenario-table">
          <thead>
            <tr><th>{pick(locale, PAY_ORDERS.colOrderNo)}</th><th>{pick(locale, PAY_ORDERS.colPlatformNo)}</th><th>{pick(locale, PAY_ORDERS.colKindChannel)}</th><th>{pick(locale, PAY_ORDERS.colAmount)}</th><th>{pick(locale, PAY_ORDERS.colPayStatus)}</th><th>{pick(locale, PAY_ORDERS.colRefundStatus)}</th><th>{pick(locale, PAY_ORDERS.colTimes)}</th><th>{pick(locale, PAY_ORDERS.colActions)}</th></tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.order_no}>
                <td><code>{order.order_no.slice(0, 20)}…</code></td>
                <td><code>{order.platform_order_no ?? "—"}</code></td>
                <td>{order.kind} / {order.channel}</td>
                <td>¥{(order.amount / 100).toFixed(2)}</td>
                <td>{pick(locale, PAY_ORDERS[STATUS_LABEL[order.status] ?? "statusPending"])}</td>
                <td>{pick(locale, PAY_ORDERS[REFUND_LABEL[order.refund_status] ?? "refundNone"])}{order.refund_amount ? `（${(order.refund_amount / 100).toFixed(2)}）` : ""}</td>
                <td>{order.created_at.slice(0, 16).replace("T", " ")}<br />{order.paid_at ? `${pick(locale, PAY_ORDERS.paidAt)}${order.paid_at.slice(5, 16).replace("T", " ")}` : ""}</td>
                <td>
                  {(order.status === "paid" || order.status === "fulfilled") && (order.refund_status === "none" || order.refund_status === "refund_failed") ? (
                    <button className="text-button" type="button" disabled={pending !== null} onClick={() => refund(order.order_no)}>
                      {pending === order.order_no ? pick(locale, PAY_ORDERS.refunding) : pick(locale, PAY_ORDERS.refundButton)}
                    </button>
                  ) : (
                    <span className="sidebar-note">—</span>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 ? <tr><td colSpan={8}>{pick(locale, PAY_ORDERS.emptyOrders)}</td></tr> : null}
          </tbody>
        </table>
        <p className="sidebar-note">{pick(locale, PAY_ORDERS.refundNote)}</p>
      </div>
    </>
  );
}

