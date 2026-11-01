import { editorSubmitLabel } from "@/lib/spec-editor-ui";

export function EditorActions({ pending, label, onCancel }: { pending: boolean; label: string; onCancel: () => void }) {
  return <div className="form-actions"><button className="text-button" type="button" onClick={onCancel}>取消</button><button className="primary-button" type="submit" disabled={pending}>{editorSubmitLabel(pending, label)}</button></div>;
}
