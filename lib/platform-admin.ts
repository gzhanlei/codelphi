import type { SessionUser } from "./types";
import type { Organization } from "./organizations";

export function adminEmails() {
  return new Set((process.env.RADAR_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export function isPlatformAdmin(user: SessionUser, organization: Organization, emails = adminEmails()) {
  if (emails.size > 0) return Boolean(user.email && emails.has(user.email.toLowerCase()));
  return organization.slug === "default" && organization.role === "owner";
}

export async function requirePlatformAdmin(user: SessionUser, organization: Organization) {
  if (!isPlatformAdmin(user, organization)) throw new Error("forbidden");
  return organization;
}
