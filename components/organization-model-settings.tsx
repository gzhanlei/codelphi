"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { type OrganizationModelView, deleteOrganizationModel, saveOrganizationModel } from "@/lib/organization-model-client";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { ORGANIZATION_MODEL, SETTINGS_COMMON } from "@/lib/ui-strings/workspace";
import { formatDateTimeIn } from "@/lib/format";

/**
 * 设置页 · 模型配置：工作区自己的模型（服务地址、API key、模型名）。
 * 保存前服务端用这一份真调一次模型，通过了才加密入库；之后只显示地址、模型名和验证时间，key 不再出现。
 */
export function OrganizationModelSettings({ initial, canManage, locale = "zh-CN" }: { initial: OrganizationModelView | null; canManage: boolean; locale?: UiLocale }) {
  const L = ORGANIZATION_MODEL;
  const formatDate = (value: string | Date | null | undefined) => formatDateTimeIn(locale, value ?? null);
  const [saved, setSaved] = useState(initial);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const save = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const next = await saveOrganizationModel({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
      setSaved(next);
      // key 只在这一次保存里用到；输入框里不留它。
      setApiKey("");
      setBaseUrl("");
      setModel("");
      setNotice(pick(locale, L.savedNotice));
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存模型配置失败"));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await deleteOrganizationModel();
      setSaved(null);
      setConfirming(false);
      setNotice(pick(locale, L.deletedNotice));
    } catch (cause: unknown) {
      setConfirming(false);
      setError(errorMessage(cause, "删除模型配置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>07</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.intro)}</p>
      {saved ? (
        <div className="settings-form">
          <p style={{ fontWeight: 650, margin: "0 0 4px" }}>
            {pick(locale, L.currentLabel)}：<code>{saved.model}</code>
            <span className="mcp-key-meta">{saved.baseUrl}</span>
            <span className="mcp-key-meta">{pick(locale, L.verifiedPrefix)}{formatDate(saved.verifiedAt)}</span>
          </p>
          <p className="overview-note" style={{ margin: 0 }}>{pick(locale, L.keyHidden)}</p>
          {canManage ? (
            confirming ? (
              <div role="group" aria-label={pick(locale, L.deleteButton)}>
                <p className="overview-note" role="alert">{pick(locale, L.deleteConfirm)}</p>
                <button className="secondary-button" type="button" disabled={pending} onClick={remove}>{pick(locale, L.deleteButton)}</button>
                <button className="secondary-button" type="button" disabled={pending} onClick={() => setConfirming(false)}>取消</button>
              </div>
            ) : (
              <button className="secondary-button" type="button" disabled={pending} onClick={() => setConfirming(true)}>{pick(locale, L.deleteButton)}</button>
            )
          ) : null}
        </div>
      ) : (
        <p className="overview-note">{pick(locale, L.none)}</p>
      )}
      {canManage ? (
        <div className="settings-form">
          <p className="overview-note">{pick(locale, L.disclosure)}</p>
          <label className="field"><span>{pick(locale, L.addressLabel)}</span><input value={baseUrl} maxLength={500} placeholder={pick(locale, L.addressPlaceholder)} aria-label={pick(locale, L.addressLabel)} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label className="field"><span>{pick(locale, L.keyLabel)}</span><input type="password" value={apiKey} maxLength={4000} autoComplete="off" placeholder={pick(locale, L.keyPlaceholder)} aria-label={pick(locale, L.keyLabel)} onChange={(event) => setApiKey(event.target.value)} /></label>
          <label className="field"><span>{pick(locale, L.modelLabel)}</span><input value={model} maxLength={64} placeholder={pick(locale, L.modelPlaceholder)} aria-label={pick(locale, L.modelLabel)} onChange={(event) => setModel(event.target.value)} /></label>
          <button className="secondary-button" type="button" disabled={pending || !baseUrl.trim() || !apiKey.trim() || !model.trim()} onClick={save}>{pending ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, L.saveButton)}</button>
        </div>
      ) : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
