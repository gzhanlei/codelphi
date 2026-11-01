import { parseConnectionId, patPresentation } from "@/lib/integration-ui";

export function ConnectionSelect({ connectionId, connections, hasServerToken, onChange }: { connectionId: number | null; connections: Array<{ id: number; accountLogin: string }>; hasServerToken: boolean; onChange: (value: number | null) => void }) {
  const pat = patPresentation(hasServerToken);
  return (
    <label className="field"><span>连接方式 <b>*</b></span><select value={connectionId ?? ""} onChange={(event) => onChange(parseConnectionId(event.target.value))}><option value="" disabled={pat.disabled}>{pat.optionLabel}</option>{connections.map((connection) => <option value={connection.id} key={connection.id}>GitHub App · {connection.accountLogin}</option>)}</select><small>GitHub App 只读取仓库内容，不会写入代码。</small></label>
  );
}
