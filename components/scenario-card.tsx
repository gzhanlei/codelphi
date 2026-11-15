import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { SCENARIO_CARD } from "@/lib/ui-strings/product";
import { formatDateIn } from "@/lib/format";
import type { ScenarioRow } from "@/lib/types";
import { isTestOnlyEvidence } from "@/lib/evidence";
import { scenarioCategoryLabel } from "@/lib/spec-editor-ui";
import { EvidenceLinks } from "./evidence-links";
import { VerifySpecButton } from "./verify-spec-button";

export function ScenarioCard({ slug, scenario, onEdit, onDelete, locale = "zh-CN" }: { slug: string; scenario: ScenarioRow; onEdit: () => void; onDelete: () => void; locale?: UiLocale }) {
  const testOnly = isTestOnlyEvidence(scenario.evidence);
  // 与原 toLocaleString("zh-CN") 同构的数字式日期时间（缺省 locale 渲染不变，仅随 locale 切换）
  const editedAt = scenario.lastEditedAt ? formatDateIn(locale, scenario.lastEditedAt, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "";
  return (
    <article className="scenario">
      <div className="scenario-label"><span className={`scenario-kind ${scenario.category}`}>{scenarioCategoryLabel(scenario.category, locale)}</span><code>{scenario.reference}</code>{testOnly ? <span className="test-only-badge" title={pick(locale, SCENARIO_CARD.testOnlyTitle)}>{pick(locale, SCENARIO_CARD.testOnlyBadge)}</span> : null}{scenario.staleSince ? <span className="drift-badge">{pick(locale, SCENARIO_CARD.staleBadge)}</span> : null}<span className="scenario-source">{scenario.source === "manual" ? pick(locale, SCENARIO_CARD.sourceManual) : pick(locale, SCENARIO_CARD.sourceGenerated)}</span>{scenario.lastEditedBy ? <span className="edited-by" title={scenario.lastEditedAt ? pick(locale, SCENARIO_CARD.lastEditedAtTitle).replace("{time}", editedAt) : undefined}>{pick(locale, SCENARIO_CARD.editedBy).replace("{name}", scenario.lastEditedBy)}</span> : null}<VerifySpecButton slug={slug} entityType="scenario" entityId={scenario.id} item={scenario} /><button className="text-button" type="button" onClick={onEdit}>{pick(locale, SCENARIO_CARD.edit)}</button><button className="text-button danger-link" type="button" onClick={onDelete}>{pick(locale, SCENARIO_CARD.remove)}</button></div>
      <dl><div><dt>{pick(locale, SCENARIO_CARD.context)}</dt><dd>{scenario.context}</dd></div><div><dt>{pick(locale, SCENARIO_CARD.action)}</dt><dd>{scenario.action}</dd></div><div><dt>{pick(locale, SCENARIO_CARD.outcome)}</dt><dd>{scenario.outcome}</dd></div></dl>
      <EvidenceLinks value={scenario.evidence} />
    </article>
  );
}
