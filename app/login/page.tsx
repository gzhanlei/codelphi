import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginError } from "@/components/login-error";
import { loadPublicDemoProduct } from "@/lib/public-demo";
import { getSessionUser } from "@/lib/session";
import { pick, resolveUiLocaleValue } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { LOGIN } from "@/lib/ui-strings/dashboard";

/** 公开演示的五个匿名导出入口，与产品页的导出能力一一对应。 */
function DemoExports({ slug, locale }: { slug: string; locale: "zh-CN" | "en" }) {
  const exports: Array<[string, string, boolean]> = [
    [pick(locale, LOGIN.demoExports.specJson), `/api/products/${slug}/spec.json`, true],
    [pick(locale, LOGIN.demoExports.gherkin), `/api/products/${slug}/export/tests?format=gherkin`, false],
    [pick(locale, LOGIN.demoExports.markdown), `/api/products/${slug}/export/tests?format=markdown`, false],
    [pick(locale, LOGIN.demoExports.changeIndex), `/api/products/${slug}/progress-summary?days=30`, false],
    [pick(locale, LOGIN.demoExports.explainer), `/api/products/${slug}/explainer`, true],
  ];
  return (
    <ul className="demo-entry-exports">
      {exports.map(([label, href, opensInTab]) => (
        <li key={href}><a href={href} {...(opensInTab ? { target: "_blank", rel: "noreferrer" } : {})}>{label} {opensInTab ? "↗" : "↓"}</a></li>
      ))}
    </ul>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUser()) redirect("/");
  const { error } = await searchParams;
  const demo = await loadPublicDemoProduct();
  const locale = await resolveUiLocale();
  const [headlineLine1, headlineLine2] = pick(locale, LOGIN.headline).split("\n");
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
        <div className="login-card">
          <span className="eyebrow">{pick(locale, LOGIN.panelEyebrow)}</span>
          <h2>{pick(locale, LOGIN.welcome)}</h2>
          <p>{pick(locale, LOGIN.chandlerIntro)}</p>
          <LoginError error={error} />
          <Link className="login-button" href="/auth/login">{pick(locale, LOGIN.chandlerButton)} <span>→</span></Link>
          <small>{pick(locale, LOGIN.allChandlerUsers)}</small>
          <small><Link href="/data-notice">{pick(locale, { "zh-CN": "数据说明", en: "Data notice" })}</Link>{pick(locale, { "zh-CN": "：源码仅发送给部署配置的 AI 网关及其上游，不用于模型训练。", en: ": source code is sent only to the configured AI gateway and its upstream; it is not used for model training." })}</small>
          {demo ? (
            <div className="demo-entry">
              <strong>{pick(locale, LOGIN.demoEntryTitle)}</strong>
              <p>{demo.name}{pick(locale, LOGIN.demoEntryBody)}</p>
              <Link className="secondary-button" href={demo.organizationSlug ? `/products/${demo.organizationSlug}/${demo.slug}` : `/products/${demo.slug}`}>{pick(locale, LOGIN.demoEnter)}</Link>
              <DemoExports slug={demo.slug} locale={locale} />
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
