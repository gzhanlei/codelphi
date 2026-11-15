import Link from "next/link";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { noticeSections, DATA_NOTICE } from "@/lib/ui-strings/legal";

const NOTICE_UPDATED = "2026-11-08";

export async function generateMetadata() {
  const locale = await resolveUiLocale();
  return { title: pick(locale, DATA_NOTICE.title) };
}

export default async function DataNoticePage() {
  const locale = await resolveUiLocale();
  const sections = noticeSections(locale);
  return (
    <main className="data-notice-page">
      <div className="data-notice-body">
        <Link href="/" className="back-link">{pick(locale, DATA_NOTICE.backLink)}</Link>
        <span className="eyebrow">DATA NOTICE</span>
        <h1>{pick(locale, DATA_NOTICE.title)}</h1>
        <p className="data-notice-meta">{pick(locale, DATA_NOTICE.meta).replace("{updated}", NOTICE_UPDATED)}</p>
        {sections.map((section) => (
          <section key={section.heading} className="data-notice-section">
            <h2>{section.heading}</h2>
            <ul>
              {section.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
