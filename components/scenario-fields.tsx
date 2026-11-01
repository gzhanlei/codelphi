interface ScenarioFieldsProps {
  context: string;
  action: string;
  outcome: string;
  category: string;
  onContextChange: (value: string) => void;
  onActionChange: (value: string) => void;
  onOutcomeChange: (value: string) => void;
  onCategoryChange: (value: "happy" | "edge" | "error") => void;
}

export function ScenarioFields({ context, action, outcome, category, onContextChange, onActionChange, onOutcomeChange, onCategoryChange }: ScenarioFieldsProps) {
  return (
    <>
      <label className="field"><span>使用情境 <b>*</b></span><input value={context} onChange={(event) => onContextChange(event.target.value)} required maxLength={2000} /></label>
      <label className="field"><span>用户操作 <b>*</b></span><textarea value={action} onChange={(event) => onActionChange(event.target.value)} required maxLength={2000} rows={2} /></label>
      <label className="field"><span>系统结果 <b>*</b></span><textarea value={outcome} onChange={(event) => onOutcomeChange(event.target.value)} required maxLength={2000} rows={2} /></label>
      <label className="field"><span>场景分类</span><select value={category} onChange={(event) => onCategoryChange(event.target.value as "happy" | "edge" | "error")}><option value="happy">正常路径</option><option value="edge">边界情况</option><option value="error">错误路径</option></select></label>
    </>
  );
}
