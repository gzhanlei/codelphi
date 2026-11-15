"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { pick, type LocaleEntry, type UiLocale } from "@/lib/ui-locale";
import { NOTIFICATIONS } from "@/lib/ui-strings/workspace";
import type { NotificationChannelView } from "@/lib/notifications";
import { listChannels, getEmailPref, setEmailPref, removeChannel, saveChannel, testChannel, toggleChannel } from "@/lib/notification-client";
import { useDemoGuard } from "./demo-mode";

const kindLabels: Record<NotificationChannelView["kind"], LocaleEntry> = { slack: { "zh-CN": "Slack", en: "Slack" }, webhook: NOTIFICATIONS.kindWebhook };

/** 通知渠道设置（现挂产品设置页）：每类渠道一条，目标加密存储，可启停、测试、删除；viewer 仍可改自己的邮件偏好。 */
export function NotificationSettings({ slug, canEditChannels = true, locale = "zh-CN" }: { slug: string; canEditChannels?: boolean; locale?: UiLocale }) {
  const L = NOTIFICATIONS;
  const guard = useDemoGuard();
  const [channels, setChannels] = useState<NotificationChannelView[]>([]);
  const [kind, setKind] = useState<"slack" | "webhook">("slack");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [emailPref, setEmailPrefState] = useState<boolean | null>(null);

  const reload = useCallback(async () => {
    try {
      setChannels(await listChannels(slug));
      setEmailPrefState(await getEmailPref(slug));
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
      <div className="overview-panel-heading"><span>04</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      <div className="notification-email-row">
        <span className="notification-kind on">Email</span>
        <span className="notification-email-text">{pick(locale, L.emailSelf)}</span>
        <button
          className="text-button"
          type="button"
          disabled={pending || emailPref === null}
          onClick={() => act(async () => {
            await setEmailPref(slug, !emailPref);
            setEmailPrefState(!emailPref);
          }, emailPref ? pick(locale, L.emailOffNotice) : pick(locale, L.emailOnNotice))}
        >
          {emailPref === null ? "…" : emailPref ? pick(locale, L.emailOnButton) : pick(locale, L.emailOffButton)}
        </button>
      </div>
      <p className="overview-note">{pick(locale, L.weeklyNote)}<a className="text-button" href={`/api/products/${slug}/digests/latest`} target="_blank" rel="noreferrer">{pick(locale, L.latestDigestLink)}</a></p>
      {canEditChannels && channels.length > 0 ? (
        <ul className="notification-channel-list">
          {channels.map((channel) => (
            <li key={channel.id} className="notification-channel">
              <span className={`notification-kind ${channel.enabled ? "on" : "off"}`}>{pick(locale, kindLabels[channel.kind])}</span>
              <code className="notification-target">{channel.target}</code>
              <span className="notification-channel-actions">
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => testChannel(slug, channel.id), pick(locale, L.testNotice))}>{pick(locale, L.testButton)}</button>
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => toggleChannel(slug, channel.id, !channel.enabled), channel.enabled ? pick(locale, L.disabledNotice) : pick(locale, L.enabledNotice))}>{channel.enabled ? pick(locale, L.disableButton) : pick(locale, L.enableButton)}</button>
                <button className="text-button" type="button" disabled={pending} onClick={() => act(() => removeChannel(slug, channel.id), pick(locale, L.deletedNotice))}>{pick(locale, L.deleteButton)}</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">{pick(locale, L.noneConfigured)}</p>
      )}
      {canEditChannels ? (
        <form
          className="notification-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await saveChannel(slug, kind, target.trim());
            setTarget("");
          }, pick(locale, L.savedNotice));
        }}
      >
        <select aria-label={pick(locale, L.kindAria)} value={kind} onChange={(event) => setKind(event.target.value as "slack" | "webhook")}>
          <option value="slack">Slack</option>
          <option value="webhook">{pick(locale, L.kindWebhook)}</option>
        </select>
        <input
          aria-label={pick(locale, L.targetAria)}
          type="url"
          required
          placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/codelphi"}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button className="secondary-button" type="submit" disabled={pending}>{pending ? pick(locale, L.processing) : pick(locale, L.saveButton)}</button>
        </form>
      ) : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
