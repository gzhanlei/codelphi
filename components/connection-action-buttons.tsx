function CheckButton({ pending, disabled, onClick }: { pending: boolean; disabled: boolean; onClick: () => void }) {
  return <button className="text-button" type="button" disabled={disabled} onClick={onClick}>{pending ? "检查中…" : "重新检查"}</button>;
}

function DestructiveButton({ action, pending, disabled, onClick }: { action: "disconnect" | "delete"; pending: boolean; disabled: boolean; onClick: () => void }) {
  const label = action === "delete" ? (pending ? "删除中…" : "删除连接") : (pending ? "断开中…" : "断开连接");
  return <button className="text-button danger-link" type="button" disabled={disabled} onClick={onClick}>{label}</button>;
}

export function ConnectionActionButtons({ pending, status, kind = "github", onRun }: { pending: string; status: string; kind?: "github" | "repository"; onRun: (action: "check" | "disconnect" | "delete") => void }) {
  const destructiveAction = kind === "repository" ? "delete" : "disconnect";
  const disabled = Boolean(pending);
  return (
    <div className="connection-actions">
      <CheckButton pending={pending === "check"} disabled={disabled} onClick={() => onRun("check")} />
      {(status === "active" || kind === "repository") && <DestructiveButton action={destructiveAction} pending={pending === destructiveAction} disabled={disabled} onClick={() => onRun(destructiveAction)} />}
    </div>
  );
}
