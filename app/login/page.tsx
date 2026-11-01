import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";

const errors: Record<string, string> = {
  invalid_oauth_state: "登录状态已失效，请重新发起登录。",
  token_exchange_failed: "Chandler 凭证交换失败，请重试。",
  userinfo_failed: "无法读取 Chandler 用户信息，请重试。",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSessionUser()) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="auth-brand"><span className="brand-mark"><i /><i /><i /></span><strong>Radar</strong></div>
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
          <p>使用 Chandler 统一账号继续。Radar 不保存你的账号密码。</p>
          {error && <div className="error-banner" role="alert">{errors[error] ?? "登录失败，请重试。"}</div>}
          <Link className="login-button" href="/auth/login">使用 Chandler 登录 <span>→</span></Link>
          <small>仅允许团队名单中的成员访问</small>
        </div>
      </section>
    </main>
  );
}
