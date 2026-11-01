import { integrationMessageClass } from "@/lib/integration-ui";

export function IntegrationMessage({ message, isError }: { message?: string; isError: boolean }) {
  if (!message) return null;
  return <div className={integrationMessageClass(isError)}>{message}</div>;
}
