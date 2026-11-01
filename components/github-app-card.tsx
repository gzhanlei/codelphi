import Link from "next/link";
import { ConnectionActions } from "./connection-actions";
import { connectionStatusLabel } from "@/lib/integration-ui";

interface App {
  slug: string;
}

interface Connection {
  id: number;
  accountLogin: string;
  accountType: string;
  status: string;
  installationId: number;
}

function ConnectionList({ connections }: { connections: Connection[] }) {
  if (connections.length === 0) return <div className="empty-state compact"><p>App 已创建，但尚未安装到任何 GitHub 账号或组织。</p></div>;
  return (
    <div className="connection-list">
      {connections.map((connection) => (
        <article className="connection-row" key={connection.id}>
          <div><strong>{connection.accountLogin}</strong><span>{connection.accountType} · Installation {connection.installationId}</span></div>
          <span className={`connection-status ${connection.status}`}>{connectionStatusLabel(connection.status)}</span>
          <ConnectionActions id={connection.id} status={connection.status} />
        </article>
      ))}
    </div>
  );
}

export function GitHubAppCard({ app, connections }: { app: App | null; connections: Connection[] }) {
  return (
    <section className="integration-card">
      <div className="integration-card-heading"><div className="integration-icon">⌁</div><div><h2>GitHub App</h2><p>仓库内容只读 · Metadata 只读 · 可随时撤销</p></div></div>
      {!app ? (
        <div className="integration-empty"><p>通过 GitHub 官方 Manifest 创建 Radar App，然后选择允许读取的仓库。</p><Link className="primary-button" href="/integrations/github/manifest">创建 Radar GitHub App</Link></div>
      ) : (
        <>
          <div className="integration-summary"><span>应用 <strong>{app.slug}</strong></span><span>{connections.filter((connection) => connection.status === "active").length} 个可用安装</span><Link className="secondary-button" href="/integrations/github/install">添加安装</Link></div>
          <ConnectionList connections={connections} />
        </>
      )}
    </section>
  );
}
