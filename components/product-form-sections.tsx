import { ConnectionSelect } from "./connection-select";
import { GitHubRepositoryPicker } from "./github-repository-picker";
import { OUTPUT_LANGUAGE_HINTS, OUTPUT_LANGUAGE_LABELS, type OutputLanguage } from "@/lib/analysis-language";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { NEW_PRODUCT as L } from "@/lib/ui-strings/dashboard";

interface ProductInformationProps {
  name: string;
  slug: string;
  description: string;
  outputLanguage: OutputLanguage;
  locale?: UiLocale;
  onNameChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onOutputLanguageChange: (value: OutputLanguage) => void;
}

export function ProductInformationSection({ name, slug, description, outputLanguage, locale = "zh-CN", onNameChange, onSlugChange, onDescriptionChange, onOutputLanguageChange }: ProductInformationProps) {
  return (
    <div className="form-section">
      <div className="form-section-heading"><span>01</span><div><h2>{pick(locale, L.infoHeading)}</h2><p>{pick(locale, L.infoBody)}</p></div></div>
      <div className="form-grid">
        <label className="field"><span>{pick(locale, L.nameLabel)} <b>*</b></span><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder={pick(locale, L.namePlaceholder)} maxLength={100} required autoFocus /></label>
        <label className="field"><span>{pick(locale, L.slugLabel)} <b>*</b></span><input value={slug} onChange={(event) => onSlugChange(event.target.value)} placeholder="salesbuddy" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /><small>{pick(locale, L.slugHint)}</small></label>
      </div>
      <label className="field"><span>{pick(locale, L.descriptionLabel)}</span><textarea value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder={pick(locale, L.descriptionPlaceholder)} rows={3} maxLength={1000} /></label>
      <label className="field">
        <span>{pick(locale, L.outputLanguageLabel)}</span>
        <select aria-label={pick(locale, L.outputLanguageLabel)} value={outputLanguage} onChange={(event) => onOutputLanguageChange(event.target.value as OutputLanguage)}>
          {(Object.keys(OUTPUT_LANGUAGE_LABELS) as OutputLanguage[]).map((language) => (
            <option key={language} value={language}>{OUTPUT_LANGUAGE_LABELS[language]}</option>
          ))}
        </select>
        <small>{OUTPUT_LANGUAGE_HINTS[outputLanguage]}{pick(locale, L.outputLanguageHint)}</small>
      </label>
    </div>
  );
}

interface ConnectionOption {
  id: number;
  accountLogin: string;
}

interface RepositorySectionProps {
  repository: string;
  defaultBranch: string;
  connectionId: number | null;
  connections: ConnectionOption[];
  hasServerToken: boolean;
  locale?: UiLocale;
  onRepositoryChange: (value: string) => void;
  onBranchChange: (value: string) => void;
  onConnectionChange: (value: number | null) => void;
}

export function RepositorySection({ repository, defaultBranch, connectionId, connections, hasServerToken, locale = "zh-CN", onRepositoryChange, onBranchChange, onConnectionChange }: RepositorySectionProps) {
  return (
    <div className="form-section">
      <div className="form-section-heading"><span>02</span><div><h2>{pick(locale, L.repoHeading)}</h2><p>{pick(locale, L.repoBody)}</p></div></div>
      <ConnectionSelect connectionId={connectionId} connections={connections} hasServerToken={hasServerToken} onChange={onConnectionChange} />
      <GitHubRepositoryPicker connectionId={connectionId} repository={repository} onRepositoryChange={onRepositoryChange} onBranchChange={onBranchChange} />
      <div className="form-grid">
        <label className="field"><span>{pick(locale, L.repoLabel)} <b>*</b></span><input value={repository} onChange={(event) => onRepositoryChange(event.target.value)} placeholder="gzhanlei/salesbuddy" required /><small>{pick(locale, L.repoHint)}</small></label>
        <label className="field"><span>{pick(locale, L.branchLabel)}</span><input value={defaultBranch} onChange={(event) => onBranchChange(event.target.value)} placeholder={pick(locale, L.branchPlaceholder)} /><small>{pick(locale, L.branchHint)}</small></label>
      </div>
    </div>
  );
}
