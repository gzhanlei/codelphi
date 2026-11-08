import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { NewProductContent } from "@/components/new-product-content";
import { listConnectionStates } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const connections = (await listConnectionStates(organization.id)).filter((connection) => connection.status === "active");
  const hasServerToken = Boolean(process.env.GITHUB_TOKEN?.trim());

  return (
    <AppShell user={user} organizationName={organization.name}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <div className="page-heading">
        <div><span className="eyebrow">NEW PRODUCT SPACE</span><h1>添加产品</h1><p>接入一个 GitHub 仓库，生成带代码证据的功能清单与变更翻译。</p></div>
      </div>
      <NewProductContent connections={connections} hasServerToken={hasServerToken} />
    </AppShell>
  );
}
