import Link from "next/link";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { termsSections, TERMS } from "@/lib/ui-strings/legal";
import { LanguageSwitcher } from "@/components/language-switcher";

export async function generateMetadata() {
  const locale = await resolveUiLocale();
  return { title: pick(locale, TERMS.title) };
}

/**
 * C1 条款页（docs/specsight-gap-improvement-plan.md §6.1）：
 * 四类条款的公开草稿——子处理方名单、源码处理条款、事故通知与责任上限、数据保留。
 * 数据边界事实来自 README「数据与安全边界」与 docs/codelphi-pricing-and-billing.md；
 * 标注「待业务确认」的条目需子处理方清单 / 法务结论后替换，不得当作正式承诺。
 */

export default async function TermsPage() {
  const locale = await resolveUiLocale();
  const sections = termsSections(locale);
  return (
    <main className="terms-page">
      <div className="page-heading">
        <div><span className="eyebrow">LEGAL</span><h1>{pick(locale, TERMS.title)}</h1><p>{pick(locale, TERMS.subtitle)}</p></div>
        <div><LanguageSwitcher locale={locale} /></div>
      </div>
      <p className="sidebar-note">{pick(locale, TERMS.draftNote)}</p>
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.body.map((item) => (
              <li key={item.text.slice(0, 24)}>
                {item.text}
                {item.pending ? <strong>{pick(locale, TERMS.pending)}</strong> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p><Link href="/pricing" className="text-button">{pick(locale, TERMS.pricingLink)}</Link>　<Link href="/" className="text-button">{pick(locale, TERMS.backLink)}</Link></p>
    </main>
  );
}
