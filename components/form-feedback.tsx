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

import { pick, type UiLocale } from "@/lib/ui-locale";
import { FEEDBACK } from "@/lib/ui-strings/dashboard";

export function analysisButtonLabel(pending: boolean, locale: UiLocale = "zh-CN") {
  return pending ? pick(locale, FEEDBACK.analyzing) : pick(locale, FEEDBACK.analyzeNow);
}

export function submitLabel(pending: boolean, analyze: boolean, locale: UiLocale = "zh-CN") {
  if (pending) return pick(locale, FEEDBACK.submittingAdd);
  return analyze ? pick(locale, FEEDBACK.addAndAnalyze) : pick(locale, FEEDBACK.addProduct);
}

export function ProductSubmitButton({ pending, analyze, locale = "zh-CN" }: { pending: boolean; analyze: boolean; locale?: UiLocale }) {
  return <button className="primary-button" type="submit" disabled={pending}>{submitLabel(pending, analyze, locale)}</button>;
}
