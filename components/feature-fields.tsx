export function FeatureFields({ name, displayName, summary, locked, onNameChange, onDisplayNameChange, onSummaryChange }: { name: string; displayName: string; summary: string; locked: boolean; onNameChange: (value: string) => void; onDisplayNameChange: (value: string) => void; onSummaryChange: (value: string) => void }) {
  return (
    <>
      <label className="field"><span>功能名称 <b>*</b></span><input name="name" value={name} onChange={(event) => onNameChange(event.target.value)} required maxLength={191} autoFocus={!locked} disabled={locked} /></label>
      <label className="field"><span>首页显示名</span><input name="displayName" value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} maxLength={191} autoFocus={locked} /><small>只改变展示，不影响代码分析关联。</small></label>
      <label className="field"><span>功能说明</span><textarea name="summary" value={summary} onChange={(event) => onSummaryChange(event.target.value)} rows={3} maxLength={4000} /></label>
    </>
  );
}
