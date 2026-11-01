import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { NewProductContent } from "@/components/new-product-content";
import { listConnectionStates } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const user = await requireSessionUser();
  const connections = (await listConnectionStates()).filter((connection) => connection.status === "active");
  const hasServerToken = Boolean(process.env.GITHUB_TOKEN?.trim());

  return (
    <AppShell user={user}>
      <Link href="/" className="back-link">← 所有产品</Link>
      <div className="page-heading">
        <div><span className="eyebrow">NEW PRODUCT SPACE</span><h1>添加产品</h1><p>接入一个 GitHub 仓库，开始维护可追溯的产品知识。</p></div>
      </div>
      <NewProductContent connections={connections} hasServerToken={hasServerToken} />
    </AppShell>
  );
}
