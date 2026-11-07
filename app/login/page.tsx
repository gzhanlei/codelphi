import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginError } from "@/components/login-error";
import { getSessionUser } from "@/lib/session";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUser()) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="auth-brand"><span className="brand-mark"><i /><i /><i /></span><strong>CoDelphi</strong></div>
        <div className="auth-statement">
          <span className="eyebrow">PRODUCT OBSERVABILITY</span>
          <h1>读懂每一次<br />产品变化。</h1>
          <p>从 GitHub 代码到可追溯的产品规格、发布摘要和团队知识，保持所有产品同频。</p>
        </div>
        <div className="auth-foot">BUILT FOR THE CHANDLER PRODUCT FAMILY</div>
      </section>
      <section className="auth-panel">
        <div className="login-card">
          <span className="eyebrow">内部工作区</span>
          <h2>欢迎回来</h2>
          <p>使用 Chandler 统一账号继续。CoDelphi 不保存你的账号密码。</p>
          <LoginError error={error} />
          <Link className="login-button" href="/auth/login">使用 Chandler 登录 <span>→</span></Link>
          <small>仅允许团队名单中的成员访问</small>
        </div>
      </section>
    </main>
  );
}
