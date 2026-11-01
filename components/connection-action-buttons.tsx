function CheckButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return <button className="text-button" type="button" disabled={pending} onClick={onClick}>{pending ? "检查中…" : "重新检查"}</button>;
}

function DisconnectButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return <button className="text-button danger-link" type="button" disabled={pending} onClick={onClick}>{pending ? "断开中…" : "断开连接"}</button>;
}

export function ConnectionActionButtons({ pending, status, onRun }: { pending: string; status: string; onRun: (action: "check" | "disconnect") => void }) {
  return (
    <div className="connection-actions">
      <CheckButton pending={pending === "check"} onClick={() => onRun("check")} />
      {status === "active" && <DisconnectButton pending={pending === "disconnect"} onClick={() => onRun("disconnect")} />}
    </div>
  );
}
