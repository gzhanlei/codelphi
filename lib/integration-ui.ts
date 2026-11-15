import { pick, type UiLocale } from "./ui-locale";
import { INTEGRATION } from "./ui-strings/product";

export function integrationFeedback(error: string | undefined, success: string | undefined, messages: Record<string, string>) {
  const key = error ?? success;
  return { text: key ? messages[key] : undefined, isError: Boolean(error) };
}

export function integrationMessageClass(isError: boolean) {
  return `integration-message ${isError ? "error" : "success"}`;
}

export function manifestCallbackPath(error: string | null) {
  return error ? `/integrations?error=${error}` : "/integrations/github/install";
}

export function connectionStatusLabel(status: string, locale: UiLocale = "zh-CN") {
  return status === "active" ? pick(locale, INTEGRATION.connected) : pick(locale, INTEGRATION.disconnected);
}

export function hasProductCredentials(connections: Array<{ id: number }>, hasServerToken: boolean) {
  return hasServerToken || connections.length > 0;
}

function stateFor<T>(condition: boolean, positive: T, negative: T) {
  return condition ? positive : negative;
}

export function patPresentation(configured: boolean, locale: UiLocale = "zh-CN") {
  return stateFor(configured,
    { disabled: false, className: "connection-status active", label: pick(locale, INTEGRATION.patConfigured), optionLabel: pick(locale, INTEGRATION.patOptionFallback) },
    { disabled: true, className: "connection-status disconnected", label: pick(locale, INTEGRATION.patNotConfigured), optionLabel: pick(locale, INTEGRATION.patOptionApp) },
  );
}

export function parseConnectionId(value: string) {
  return value ? Number(value) : null;
}
