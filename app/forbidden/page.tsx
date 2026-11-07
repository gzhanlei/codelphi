import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="status-page">
      <span className="eyebrow">403 · ACCESS CONTROL</span>
      <h1>这个账号还没有 CoDelphi 权限</h1>
      <p>当前部署启用了专用登录限制。请使用已授权的 Chandler 账号，或联系工作区管理员处理访问授权。</p>
      <Link className="secondary-button" href="/login">返回登录</Link>
    </main>
  );
}
