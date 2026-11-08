"use client";


import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

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

const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  fulfilled: "已履约",
  closed: "已关闭",
  refunded: "已退款",
  failed: "失败",
};

const REFUND_LABEL: Record<string, string> = {
  none: "—",
  refund_pending: "退款待提交",
  refund_submitted: "退款已提交（待确认）",
  refund_confirmed: "退款已确认",
  refund_failed: "退款失败",
};

/** 超管支付操作面板：测试单创建、订单台账、退款（动作走既有 API，状态机语义在服务端）。 */
function PayQrCode({ codeUrl }: { codeUrl: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(codeUrl, { width: 440, margin: 1 }).then(setDataUrl).catch(() => setDataUrl(null));
  }, [codeUrl]);
  if (!dataUrl) return <p>二维码生成中…</p>;
  return (
    <p style={{ textAlign: "center" }}>
      微信扫码支付
      <br />
      <img src={dataUrl} alt="微信支付二维码" width={220} height={220} style={{ border: "1px solid #ddd", borderRadius: 8 }} />
    </p>
  );
}

export function AdminPayOrders({ orders }: { orders: AdminOrderRow[] }) {
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
        <h2>联调测试单</h2>
        <p>0.01 元「CoDelphi 测试支付」：走完整建单/支付/webhook/履约链路，履约不授予任何额度（kind=test）。</p>
        <button className="primary-button" type="button" onClick={createTestOrder} disabled={pending !== null}>
          {pending === "test" ? "创建中…" : "创建 0.01 元测试单"}
        </button>
        {prepay ? (
          <div>
            {prepay.codeUrl ? <PayQrCode codeUrl={prepay.codeUrl} /> : null}
            {prepay.h5Url ? <p><a href={prepay.h5Url} target="_blank" rel="noreferrer">微信 H5 收银台 →</a></p> : null}
            {prepay.payUrl ? <p><a href={prepay.payUrl} target="_blank" rel="noreferrer">支付宝 →</a></p> : null}
          </div>
        ) : null}
      </div>

      {message ? <div className="panel"><p>{message}</p></div> : null}

      <div className="panel">
        <h2>订单台账（最近 20 笔）</h2>
        <table className="scenario-table">
          <thead>
            <tr><th>商户单号</th><th>平台单号</th><th>类型 / 渠道</th><th>金额</th><th>支付态</th><th>退款态</th><th>创建 / 支付时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.order_no}>
                <td><code>{order.order_no.slice(0, 20)}…</code></td>
                <td><code>{order.platform_order_no ?? "—"}</code></td>
                <td>{order.kind} / {order.channel}</td>
                <td>¥{(order.amount / 100).toFixed(2)}</td>
                <td>{STATUS_LABEL[order.status] ?? order.status}</td>
                <td>{REFUND_LABEL[order.refund_status] ?? order.refund_status}{order.refund_amount ? `（${(order.refund_amount / 100).toFixed(2)}）` : ""}</td>
                <td>{order.created_at.slice(0, 16).replace("T", " ")}<br />{order.paid_at ? `支付 ${order.paid_at.slice(5, 16).replace("T", " ")}` : ""}</td>
                <td>
                  {(order.status === "paid" || order.status === "fulfilled") && (order.refund_status === "none" || order.refund_status === "refund_failed") ? (
                    <button className="text-button" type="button" disabled={pending !== null} onClick={() => refund(order.order_no)}>
                      {pending === order.order_no ? "提交中…" : "退款"}
                    </button>
                  ) : (
                    <span className="sidebar-note">—</span>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 ? <tr><td colSpan={8}>暂无订单。先创建一笔测试单。</td></tr> : null}
          </tbody>
        </table>
        <p className="sidebar-note">退款语义：提交后停在 refund_submitted 属正常（结果未知），webhook/对账会在确认后推进 refund_confirmed 并原子完成权益回收；绝不因超时重发退款请求。</p>
      </div>
    </>
  );
}

