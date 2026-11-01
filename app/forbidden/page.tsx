import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="status-page">
      <span className="eyebrow">403 · ACCESS CONTROL</span>
      <h1>这个账号还没有 Radar 权限</h1>
      <p>请让管理员把你的 Chandler 邮箱加入 <code>AUTH_ALLOWED_EMAILS</code>。</p>
      <Link className="secondary-button" href="/login">返回登录</Link>
    </main>
  );
}
