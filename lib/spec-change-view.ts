import type { BehaviorChangeRow } from "./types";

export function changeSubject(change: BehaviorChangeRow) {
  return change.after === null ? change.before : change.after;
}

export function changeEvidence(change: BehaviorChangeRow) {
  const subject = changeSubject(change);
  if (typeof subject !== "object" || subject === null || !("evidence" in subject)) return [];
  const evidence = (subject as { evidence?: unknown }).evidence;
  return Array.isArray(evidence) ? evidence : [];
}

export function isScenarioSubject(value: unknown): value is { reference: string; context: string; action: string; outcome: string } {
  return typeof value === "object" && value !== null && "reference" in value;
}
