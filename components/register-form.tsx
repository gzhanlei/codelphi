"use client";

import { useEffect, useRef, useState } from "react";
import { TurnstileWidget, type TurnstileHandle } from "@/components/turnstile-widget";
import { authErrorText, postAuth } from "@/components/auth-form-shared";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { AUTH_ERRORS, AUTH_FORM } from "@/lib/ui-strings/dashboard";

const RESEND_COOLDOWN_SECONDS = 60; // Chandler send-code 60s 冷却，与 429 otp_cooldown 对齐

/** 注册表单（Chandler 公开注册通道）：邮箱验证码（60s 冷却）+ 密码 + Turnstile，成功即建立会话并进入工作区。 */
export function RegisterForm({ locale, sitekey }: { locale: UiLocale; sitekey: string }) {
  const L = AUTH_FORM;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agree, setAgree] = useState(false);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const widgetRef = useRef<TurnstileHandle>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
  }, []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN_SECONDS);
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setCooldown((seconds) => {
        if (seconds <= 1) {
          if (timerRef.current !== null) window.clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return seconds - 1;
      });
    }, 1_000);
  };

  const sendCode = async () => {
    setError("");
    setNotice("");
    if (!email.trim()) {
      setError(pick(locale, AUTH_ERRORS.invalid_input));
      return;
    }
    setSending(true);
    const { status, data } = await postAuth("/api/auth/register/send-code", { email: email.trim() });
    setSending(false);
    if (status === 200) {
      setNotice(pick(locale, L.codeSent));
      startCooldown();
      return;
    }
    setError(authErrorText(data.code, locale));
  };

  const submit = async () => {
    setError("");
    if (sitekey && !token) {
      setError(pick(locale, AUTH_ERRORS.missing_turnstile_token));
      return;
    }
    setPending(true);
    try {
      const { data } = await postAuth("/api/auth/register", {
        email: email.trim(),
        code: code.trim(),
        password,
        displayName: displayName.trim(),
        agreePolicies: agree === true ? true : undefined,
        turnstileToken: token,
      });
      if (data.ok) window.location.assign("/");
      else {
        setError(authErrorText(data.code, locale));
        widgetRef.current?.reset();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="auth-field">
        <span>{pick(locale, L.emailLabel)}</span>
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder={pick(locale, L.accountPlaceholder)} required />
      </label>
      <label className="auth-field">
        <span>{pick(locale, L.codeLabel)}</span>
        <div className="auth-inline-field">
          <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder={pick(locale, L.codePlaceholder)} required />
          <button className="secondary-button" type="button" disabled={sending || cooldown > 0} onClick={() => void sendCode()}>
            {sending ? pick(locale, L.sending) : cooldown > 0 ? `${pick(locale, L.sendCode)} (${cooldown}s)` : pick(locale, L.sendCode)}
          </button>
        </div>
      </label>
      <label className="auth-field">
        <span>{pick(locale, L.passwordLabel)}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={pick(locale, L.passwordPlaceholder)} required />
        <small className="auth-form-hint">{pick(locale, L.passwordHint)}</small>
      </label>
      <label className="auth-field">
        <span>{pick(locale, L.displayNameLabel)}</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={33} autoComplete="nickname" placeholder={pick(locale, L.displayNamePlaceholder)} />
      </label>
      <label className="auth-agree">
        <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} required />
        {/* 同意即透传 agree_policies，Chandler 记录版本化同意行（指南 v3.12 §2.2）；不勾选不下发 */}
        <span>
          {pick(locale, L.agreePrefix)}
          <a href="https://chandler.work/terms" target="_blank" rel="noreferrer">{pick(locale, L.agreeTerms)}</a>
          {pick(locale, L.agreeAnd)}
          <a href="https://chandler.work/privacy" target="_blank" rel="noreferrer">{pick(locale, L.agreePrivacy)}</a>
        </span>
      </label>
      <TurnstileWidget ref={widgetRef} sitekey={sitekey} action="register" onToken={setToken} label={pick(locale, L.turnstileLabel)} onError={() => setError(pick(locale, AUTH_ERRORS.turnstile_unavailable))} />
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {notice && !error ? <div className="auth-notice" role="status">{notice}</div> : null}
      <button className="login-button" type="submit" disabled={pending}>
        {pending ? pick(locale, L.submitting) : pick(locale, L.registerSubmit)} {pending ? "" : <span>→</span>}
      </button>
    </form>
  );
}
