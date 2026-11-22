import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/register-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getSessionUser } from "@/lib/session";
import { turnstileSiteKey } from "@/lib/env";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { AUTH_FORM, LOGIN, REGISTER } from "@/lib/ui-strings/dashboard";

/** 自建注册页：仍走 Chandler 统一账号（公开注册通道 = 邮箱验证码 + Turnstile），成功后自动建立个人工作区。 */
export default async function RegisterPage() {
  if (await getSessionUser()) redirect("/");
  const locale = await resolveUiLocale();
  const [headlineLine1, headlineLine2] = pick(locale, REGISTER.headline).split("\n");
  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="auth-brand"><span className="brand-mark"><i /><i /><i /></span><strong>CoDelphi</strong></div>
        <div className="auth-statement">
          <span className="eyebrow">PRODUCT OBSERVABILITY</span>
          <h1>{headlineLine1}<br />{headlineLine2}</h1>
          <p>{pick(locale, LOGIN.statement)}</p>
        </div>
        <div className="auth-foot">SOURCE-BACKED RELEASE NOTES</div>
      </section>
      <section className="auth-panel">
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px 0" }}>
          <LanguageSwitcher locale={locale} />
        </div>
        <div className="login-card">
          <span className="eyebrow">{pick(locale, REGISTER.panelEyebrow)}</span>
          <h2>{pick(locale, REGISTER.welcome)}</h2>
          <p>{pick(locale, REGISTER.intro)}</p>
          <RegisterForm locale={locale} sitekey={turnstileSiteKey()} />
          <small className="auth-alt-links">{pick(locale, AUTH_FORM.haveAccount)} <Link href="/login">{pick(locale, AUTH_FORM.goLogin)}</Link></small>
          <small><Link href="/data-notice">{pick(locale, { "zh-CN": "数据说明", en: "Data notice" })}</Link>{pick(locale, { "zh-CN": "：源码仅发送给部署配置的 AI 网关及其上游，不用于模型训练。", en: ": source code is sent only to the configured AI gateway and its upstream; it is not used for model training." })}</small>
        </div>
      </section>
    </main>
  );
}
