import Link from "next/link";
import { NewProductForm } from "./new-product-form";
import { hasProductCredentials } from "@/lib/integration-ui";
import type { OutputLanguage } from "@/lib/analysis-language";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { NEW_PRODUCT as L } from "@/lib/ui-strings/dashboard";

export function NewProductContent({ connections, hasServerToken, defaultOutputLanguage, locale = "zh-CN" }: { connections: Array<{ id: number; accountLogin: string }>; hasServerToken: boolean; defaultOutputLanguage?: OutputLanguage; locale?: UiLocale }) {
  if (!hasProductCredentials(connections, hasServerToken)) {
    return (
      <section className="integration-card credentials-required">
        <span className="eyebrow">CONNECTION REQUIRED</span>
        <h2>{pick(locale, L.connectionRequiredHeading)}</h2>
        <p>{pick(locale, L.connectionRequiredBody)}</p>
        <Link className="primary-button" href="/integrations">{pick(locale, L.goToIntegrations)}</Link>
      </section>
    );
  }
  return <NewProductForm connections={connections} hasServerToken={hasServerToken} defaultOutputLanguage={defaultOutputLanguage} locale={locale} />;
}
