import Link from "next/link";
import { NewProductForm } from "./new-product-form";
import { hasProductCredentials } from "@/lib/integration-ui";
import type { OutputLanguage } from "@/lib/analysis-language";

export function NewProductContent({ connections, hasServerToken, defaultOutputLanguage }: { connections: Array<{ id: number; accountLogin: string }>; hasServerToken: boolean; defaultOutputLanguage?: OutputLanguage }) {
  if (!hasProductCredentials(connections, hasServerToken)) {
    return (
      <section className="integration-card credentials-required">
        <span className="eyebrow">CONNECTION REQUIRED</span>
        <h2>先连接 GitHub</h2>
        <p>添加产品之前，需要安装只读 CoDelphi GitHub App，或由管理员配置 Personal Access Token。</p>
        <Link className="primary-button" href="/integrations">前往 Integrations</Link>
      </section>
    );
  }
  return <NewProductForm connections={connections} hasServerToken={hasServerToken} defaultOutputLanguage={defaultOutputLanguage} />;
}
