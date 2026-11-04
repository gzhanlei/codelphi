import Link from "next/link";
import { ConnectionActions } from "./connection-actions";
import { connectionStatusLabel } from "../lib/integration-ui";

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

function ConnectionList({ connections, canEdit }: { connections: Connection[]; canEdit: boolean }) {
  if (connections.length === 0) return <div className="empty-state compact"><p>App 已创建，但尚未安装到任何 GitHub 账号或组织。</p></div>;
  return (
    <div className="connection-list">
      {connections.map((connection) => (
        <article className="connection-row" key={connection.id}>
          <div><strong>{connection.accountLogin}</strong><span>{connection.accountType} · Installation {connection.installationId}</span></div>
          <span className={`connection-status ${connection.status}`}>{connectionStatusLabel(connection.status)}</span>
          {canEdit && <ConnectionActions id={connection.id} status={connection.status} />}
        </article>
      ))}
    </div>
  );
}

export function GitHubAppCard({ app, connections, canEdit = true }: { app: App | null; connections: Connection[]; canEdit?: boolean }) {
  return (
    <section className="integration-card" id="github">
      <div className="integration-card-heading"><div className="integration-icon" aria-hidden="true">GH</div><div><h2>GitHub</h2><p>推荐使用 GitHub App · 按仓库授权 · Contents 与 Metadata 只读</p></div></div>
      {!app ? (
        <div className="integration-empty"><p>{canEdit ? "通过 GitHub 官方引导创建 Radar App，然后选择允许读取的仓库。" : "尚未创建 GitHub App，请联系工作区编辑者或所有者配置。"}</p>{canEdit && <Link className="primary-button" href="/integrations/github/manifest">连接 GitHub</Link>}</div>
      ) : (
        <>
          <div className="integration-summary"><span>应用 <strong>{app.slug}</strong></span><span>{connections.filter((connection) => connection.status === "active").length} 个可用安装</span>{canEdit && <Link className="secondary-button" href="/integrations/github/install">添加账号或组织</Link>}</div>
          <ConnectionList connections={connections} canEdit={canEdit} />
        </>
      )}
    </section>
  );
}
