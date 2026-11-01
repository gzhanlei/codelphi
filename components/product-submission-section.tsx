import { FormError, ProductSubmitButton } from "./form-feedback";

export function ProductSubmissionSection({ analyze, error, pending, onAnalyze }: { analyze: boolean; error: string; pending: boolean; onAnalyze: (value: boolean) => void }) {
  return (
    <>
      <label className="analysis-option"><input type="checkbox" checked={analyze} onChange={(event) => onAnalyze(event.target.checked)} /><span><strong>添加后立即分析</strong><small>读取当前代码，生成第一版产品规格和发布记录。</small></span></label>
      <FormError message={error} />
      <div className="form-actions"><a href="/" className="cancel-link">取消</a><ProductSubmitButton pending={pending} analyze={analyze} /></div>
    </>
  );
}
