import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginError } from "@/components/login-error";
import { loadPublicDemoProduct } from "@/lib/public-demo";
import { getSessionUser } from "@/lib/session";

/** 公开演示的五个匿名导出入口，与产品页的导出能力一一对应。 */
function DemoExports({ slug }: { slug: string }) {
  const exports: Array<[string, string, boolean]> = [
    ["规格清单（spec.json）", `/api/products/${slug}/spec.json`, true],
    ["Gherkin 回归用例", `/api/products/${slug}/export/tests?format=gherkin`, false],
    ["Markdown 规格书", `/api/products/${slug}/export/tests?format=markdown`, false],
    ["30 天变更索引", `/api/products/${slug}/progress-summary?days=30`, false],
    ["Explainer 一页说明", `/api/products/${slug}/explainer`, true],
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
  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="auth-brand"><span className="brand-mark"><i /><i /><i /></span><strong>CoDelphi</strong></div>
        <div className="auth-statement">
          <span className="eyebrow">PRODUCT OBSERVABILITY</span>
          <h1>读懂每一次<br />产品变化。</h1>
          <p>把 GitHub 代码变更翻译成人人看得懂的发布说明与回归范围：每条结论附代码证据，采纳前经人工核实。</p>
        </div>
        <div className="auth-foot">SOURCE-BACKED RELEASE NOTES</div>
      </section>
      <section className="auth-panel">
        <div className="login-card">
          <span className="eyebrow">工作区登录</span>
          <h2>欢迎回来</h2>
          <p>使用 Chandler 统一账号继续。CoDelphi 不保存你的账号密码。</p>
          <LoginError error={error} />
          <Link className="login-button" href="/auth/login">使用 Chandler 登录 <span>→</span></Link>
          <small>所有 Chandler 用户均可登录，自动创建个人工作区</small>
          <small><Link href="/data-notice">数据说明</Link>：源码仅发送给部署配置的 AI 网关及其上游，不用于模型训练。</small>
          {demo ? (
            <div className="demo-entry">
              <strong>不想登录？先看公开演示</strong>
              <p>{demo.name} 的规格清单、回归用例与 30 天变更索引全部匿名只读开放。</p>
              <Link className="secondary-button" href={`/products/${demo.slug}`}>进入在线演示 →</Link>
              <DemoExports slug={demo.slug} />
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
