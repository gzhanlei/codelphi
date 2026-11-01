import type { SessionUser } from "./types";

export function userDisplayName(user: SessionUser) {
  return user.name ?? user.email ?? "Radar 用户";
}

export function userInitial(user: SessionUser) {
  return userDisplayName(user).slice(0, 1).toUpperCase();
}
