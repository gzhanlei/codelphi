export function FeatureFields({ name, summary, locked, onNameChange, onSummaryChange }: { name: string; summary: string; locked: boolean; onNameChange: (value: string) => void; onSummaryChange: (value: string) => void }) {
  return (
    <>
      <label className="field"><span>功能名称 <b>*</b></span><input value={name} onChange={(event) => onNameChange(event.target.value)} required maxLength={191} autoFocus={!locked} disabled={locked} /></label>
      <label className="field"><span>功能说明</span><textarea value={summary} onChange={(event) => onSummaryChange(event.target.value)} rows={3} maxLength={4000} /></label>
    </>
  );
}
