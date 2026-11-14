import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { NewProductContent } from "@/components/new-product-content";
import { listConnectionStates } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { getWorkspaceOutputLanguageDefault } from "@/lib/analysis-trigger";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { NEW_PRODUCT as L } from "@/lib/ui-strings/dashboard";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const connections = (await listConnectionStates(organization.id)).filter((connection) => connection.status === "active");
  const hasServerToken = Boolean(process.env.GITHUB_TOKEN?.trim());
  const defaultOutputLanguage = await getWorkspaceOutputLanguageDefault(organization.id);
  const locale = await resolveUiLocale();

  return (
    <AppShell user={user} organizationName={organization.name}>
      <Link href="/" className="back-link">{pick(locale, L.backLink)}</Link>
      <div className="page-heading">
        <div><span className="eyebrow">NEW PRODUCT SPACE</span><h1>{pick(locale, L.heading)}</h1><p>{pick(locale, L.subheading)}</p></div>
      </div>
      <NewProductContent connections={connections} hasServerToken={hasServerToken} defaultOutputLanguage={defaultOutputLanguage} locale={locale} />
    </AppShell>
  );
}
