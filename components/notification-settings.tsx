"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import type { NotificationChannelView } from "@/lib/notifications";
import { listChannels, removeChannel, saveChannel, testChannel, toggleChannel } from "@/lib/notification-client";
import { useDemoGuard } from "./demo-mode";

const kindLabels: Record<NotificationChannelView["kind"], string> = { slack: "Slack", webhook: "通用 Webhook" };

/** 产品概览里的通知渠道设置：每类渠道一条，目标加密存储，可启停、测试、删除。 */
export function NotificationSettings({ slug }: { slug: string }) {
  const guard = useDemoGuard();
  const [channels, setChannels] = useState<NotificationChannelView[]>([]);
  const [kind, setKind] = useState<"slack" | "webhook">("slack");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      setChannels(await listChannels(slug));
    } catch (cause: unknown) {
      setError(errorMessage(cause, "加载通知渠道失败"));
    }
  }, [slug]);

  useEffect(() => { void reload(); }, [reload]);

  const act = async (action: () => Promise<unknown>, successNotice: string) => {
    if (guard()) return;
    setPending(true);
    setError("");
    try {
      await action();
      setNotice(successNotice);
      await reload();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "操作失败，请重试"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel notification-panel">
      <div className="overview-panel-heading"><span>04</span><h2>通知分发</h2></div>
      <p className="overview-note">分析发现规格行为变化时，把变化摘要推送到团队日常动线；无变化则保持静默。</p>
      {channels.length > 0 ? (
        <ul className="notification-channel-list">
          {channels.map((channel) => (
            <li key={channel.id} className="notification-channel">
              <span className={`notification-kind ${channel.enabled ? "on" : "off"}`}>{kindLabels[channel.kind]}</span>
              <code className="notification-target">{channel.target}</code>
              <span className="notification-channel-actions">
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => testChannel(slug, channel.id), "测试消息已发送")}>测试</button>
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => toggleChannel(slug, channel.id, !channel.enabled), channel.enabled ? "渠道已停用" : "渠道已启用")}>{channel.enabled ? "停用" : "启用"}</button>
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => removeChannel(slug, channel.id), "渠道已删除")}>删除</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">尚未配置通知渠道。</p>
      )}
      <form
        className="notification-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await saveChannel(slug, kind, target.trim());
            setTarget("");
          }, "通知渠道已保存");
        }}
      >
        <select aria-label="渠道类型" value={kind} onChange={(event) => setKind(event.target.value as "slack" | "webhook")}>
          <option value="slack">Slack</option>
          <option value="webhook">通用 Webhook</option>
        </select>
        <input
          aria-label="Webhook 地址"
          type="url"
          required
          placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/codelphi"}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button className="secondary-button" type="submit" disabled={pending}>{pending ? "处理中…" : "保存渠道"}</button>
      </form>
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
