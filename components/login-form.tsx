"use client";

import { useState } from "react";
import { authErrorText, postAuth } from "@/components/auth-form-shared";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { AUTH_FORM } from "@/lib/ui-strings/dashboard";

/** 登录表单（Chandler 密码通道）：428 时切换到 MFA 挑战输入。 */
export function LoginForm({ locale, next }: { locale: UiLocale; next: string }) {
  const L = AUTH_FORM;
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  const submit = async () => {
    setError("");
    setPending(true);
    try {
      if (mfaToken !== null) {
        const { data } = await postAuth("/api/auth/mfa", { mfaToken, code: mfaCode.trim() });
        if (data.ok) window.location.assign(next);
        else setError(authErrorText(data.code, locale));
        return;
      }
      const { data } = await postAuth("/api/auth/login", { account: account.trim(), password });
      if (data.mfaRequired) {
        setMfaToken(typeof data.mfaToken === "string" ? data.mfaToken : null);
        return;
      }
      if (data.ok) {
        window.location.assign(next);
        return;
      }
      setError(authErrorText(data.code, locale));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {mfaToken === null ? (
        <>
          <label className="auth-field">
            <span>{pick(locale, L.accountLabel)}</span>
            <input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" placeholder={pick(locale, L.accountPlaceholder)} required />
          </label>
          <label className="auth-field">
            <span>{pick(locale, L.passwordLabel)}</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder={pick(locale, L.passwordPlaceholder)} required />
          </label>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <button className="login-button" type="submit" disabled={pending}>
            {pending ? pick(locale, L.submitting) : pick(locale, L.loginSubmit)} {pending ? "" : <span>→</span>}
          </button>
        </>
      ) : (
        <>
          <p className="auth-form-hint">{pick(locale, L.mfaHint)}</p>
          <label className="auth-field">
            <span>{pick(locale, L.mfaLabel)}</span>
            <input value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          </label>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <button className="login-button" type="submit" disabled={pending}>{pending ? pick(locale, L.submitting) : pick(locale, L.mfaSubmit)}</button>
          <button className="auth-ghost-button" type="button" onClick={() => { setMfaToken(null); setMfaCode(""); setError(""); }}>
            {pick(locale, L.mfaBack)}
          </button>
        </>
      )}
    </form>
  );
}
