import Link from "next/link";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { CONNECTION_STATUS, GITHUB_APP_CARD } from "@/lib/ui-strings/workspace";
import { ConnectionActions } from "./connection-actions";

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

function connectionStatusLabel(locale: UiLocale, status: string) {
  return pick(locale, status === "active" ? CONNECTION_STATUS.connected : CONNECTION_STATUS.disconnected);
}

function ConnectionList({ connections, canEdit, locale }: { connections: Connection[]; canEdit: boolean; locale: UiLocale }) {
  if (connections.length === 0) return <div className="empty-state compact"><p>{pick(locale, GITHUB_APP_CARD.listEmpty)}</p></div>;
  return (
    <div className="connection-list">
      {connections.map((connection) => (
        <article className="connection-row" key={connection.id}>
          <div><strong>{connection.accountLogin}</strong><span>{connection.accountType} · Installation {connection.installationId}</span></div>
          <span className={`connection-status ${connection.status}`}>{connectionStatusLabel(locale, connection.status)}</span>
          {canEdit && <ConnectionActions id={connection.id} status={connection.status} />}
        </article>
      ))}
    </div>
  );
}

export function GitHubAppCard({ app, connections, canEdit = true, locale = "zh-CN" }: { app: App | null; connections: Connection[]; canEdit?: boolean; locale?: UiLocale }) {
  const L = GITHUB_APP_CARD;
  return (
    <section className="integration-card" id="github">
      <div className="integration-card-heading"><div className="integration-icon" aria-hidden="true">GH</div><div><h2>GitHub</h2><p>{pick(locale, L.subtitle)}</p></div></div>
      {!app ? (
        <div className="integration-empty"><p>{canEdit ? pick(locale, L.emptyEditor) : pick(locale, L.emptyViewer)}</p>{canEdit && <Link className="primary-button" href="/integrations/github/manifest">{pick(locale, L.connectLink)}</Link>}</div>
      ) : (
        <>
          <div className="integration-summary"><span>{pick(locale, L.appPrefix)}<strong>{app.slug}</strong></span><span>{connections.filter((connection) => connection.status === "active").length}{pick(locale, connections.filter((connection) => connection.status === "active").length === 1 ? L.installationsSuffixOne : L.installationsSuffix)}</span>{canEdit && <Link className="secondary-button" href="/integrations/github/install">{pick(locale, L.addAccountLink)}</Link>}{canEdit && <a className="secondary-button" href={`https://github.com/settings/apps/${encodeURIComponent(app.slug)}`} target="_blank" rel="noreferrer">{pick(locale, L.pushSettingsLink)}</a>}</div>
          <ConnectionList connections={connections} canEdit={canEdit} locale={locale} />
        </>
      )}
    </section>
  );
}
