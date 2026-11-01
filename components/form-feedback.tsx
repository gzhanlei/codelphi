function TextMessage({ message, className, role }: { message: string; className: string; role?: string }) {
  if (!message) return null;
  return <span className={className} role={role}>{message}</span>;
}

export function FormError({ message }: { message: string }) {
  return <TextMessage message={message} className="error-banner" role="alert" />;
}

export function InlineMessage({ message }: { message: string }) {
  return <TextMessage message={message} className="inline-message" />;
}

export function analysisButtonLabel(pending: boolean) {
  return pending ? "正在提交…" : "立即分析";
}

export function submitLabel(pending: boolean, analyze: boolean) {
  if (pending) return "正在验证并添加…";
  return analyze ? "添加并开始分析" : "添加产品";
}

export function ProductSubmitButton({ pending, analyze }: { pending: boolean; analyze: boolean }) {
  return <button className="primary-button" type="submit" disabled={pending}>{submitLabel(pending, analyze)}</button>;
}
