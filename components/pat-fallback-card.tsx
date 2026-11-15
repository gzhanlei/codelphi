import { pick, type UiLocale } from "@/lib/ui-locale";
import { PAT_FALLBACK_CARD } from "@/lib/ui-strings/workspace";

export function PatFallbackCard({ configured, locale = "zh-CN" }: { configured: boolean; locale?: UiLocale }) {
  const className = configured ? "connection-status active" : "connection-status disconnected";
  return (
    <section className="integration-card fallback-card">
      <div><h2>{pick(locale, PAT_FALLBACK_CARD.heading)}</h2><p>{pick(locale, PAT_FALLBACK_CARD.body)}</p></div>
      <span className={className}>{configured ? pick(locale, PAT_FALLBACK_CARD.configured) : pick(locale, PAT_FALLBACK_CARD.notConfigured)}</span>
    </section>
  );
}
