import { chandlerBaseUrl } from "./env";

export interface InvitationEmail {
  to: string;
  organizationName: string;
  role: "editor" | "viewer";
  inviteUrl: string;
}

export async function sendInvitationEmail(input: InvitationEmail, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${chandlerBaseUrl()}/v1/auth/register/send-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: input.to }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return true;
  if (response.status === 400 || response.status === 409) return false;
  throw new Error(`Chandler registration email failed: ${response.status}`);
}
