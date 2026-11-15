import Link from "next/link";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { FORBIDDEN } from "@/lib/ui-strings/dashboard";
import { LanguageSwitcher } from "@/components/language-switcher";

export default async function ForbiddenPage() {
  const locale = await resolveUiLocale();
  return (
    <main className="status-page">
      <div style={{ display: "flex", justifyContent: "flex-end" }}><LanguageSwitcher locale={locale} /></div>
      <span className="eyebrow">403 · ACCESS CONTROL</span>
      <h1>{pick(locale, FORBIDDEN.heading)}</h1>
      <p>{pick(locale, FORBIDDEN.body)}</p>
      <Link className="secondary-button" href="/login">{pick(locale, FORBIDDEN.backToLogin)}</Link>
    </main>
  );
}
