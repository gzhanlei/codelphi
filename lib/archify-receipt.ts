import type { ArchifyReceipt } from "./archify-cli";

export function deliverySummary(receipt: ArchifyReceipt) {
  const value = receipt as ArchifyReceipt & {
    specification?: { sha256?: string; bytes?: number };
    artifact?: { sha256?: string; bytes?: number };
    validation?: { checksPassed?: number; checkCount?: number };
    evidence?: { verified?: boolean; references?: number };
  };
  return {
    specification: value.specification,
    artifact: value.artifact,
    validation: value.validation,
    evidence: value.evidence,
  };
}

export function visualSummary(receipt: ArchifyReceipt) {
  const value = receipt as ArchifyReceipt & {
    visualReview?: string;
    containment?: { status?: string };
    captures?: { contactSheet?: string };
  };
  return { visualReview: value.visualReview, containment: value.containment?.status, contactSheet: value.captures?.contactSheet };
}
