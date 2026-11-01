import { patPresentation } from "@/lib/integration-ui";

export function PatFallbackCard({ configured }: { configured: boolean }) {
  const status = patPresentation(configured);
  return (
    <section className="integration-card fallback-card">
      <div><h2>Personal Access Token 回退</h2><p>仅用于兼容当前本地试点。GitHub App 配置完成后，可以逐步停用共享 PAT。</p></div>
      <span className={status.className}>{status.label}</span>
    </section>
  );
}
