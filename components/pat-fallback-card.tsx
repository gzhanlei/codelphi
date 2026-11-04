import { patPresentation } from "@/lib/integration-ui";

export function PatFallbackCard({ configured }: { configured: boolean }) {
  const status = patPresentation(configured);
  return (
    <section className="integration-card fallback-card">
      <div><h2>服务器共享 Token · 旧版兼容</h2><p>仅用于现有 GitHub 产品，不是客户配置入口。新连接请使用上方的工作区级设置。</p></div>
      <span className={status.className}>{status.label}</span>
    </section>
  );
}
