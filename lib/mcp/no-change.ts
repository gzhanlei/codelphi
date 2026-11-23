import type { OpenedRemoteSourceRevision } from "../remote-source-index/types";
import { detectVisibilityConflicts } from "../spec-consistency";
import { diffSpec, specFeatureKey, specScenarioKey, type SpecFeature } from "../spec-diff";
import type { NoChangeVerification } from "./reconcile";

export interface NoChangeInput {
  baseFeatures?: SpecFeature[];
  currentFeatures?: SpecFeature[];
  index?: Pick<OpenedRemoteSourceRevision, "readLines">;
}

export function noChangeUnavailable(reason: string): NoChangeVerification {
  return {
    verified: false,
    identityPreserved: false,
    semanticsUnchanged: false,
    conflictFree: false,
    evidenceComplete: false,
    evidenceTotal: 0,
    evidenceVerified: 0,
    reasons: [reason],
  };
}

function identities(features: SpecFeature[]): string[] {
  return features.flatMap((feature) => [
    `feature:${specFeatureKey(feature.name)}`,
    ...feature.scenarios.map((scenario) => `scenario:${specScenarioKey(feature.name, scenario.reference)}`),
  ]).sort();
}

function evidenceCount(features: SpecFeature[]): number {
  return features.reduce((total, feature) => total + feature.scenarios.reduce((count, scenario) => count + scenario.evidence.length, 0), 0);
}

export async function verifyNoChange(input: NoChangeInput): Promise<NoChangeVerification> {
  const reasons = new Set<string>();
  const current = input.currentFeatures;
  const base = input.baseFeatures;
  const evidenceTotal = evidenceCount(current ?? []);
  let evidenceVerified = 0;
  let identityPreserved = false;
  let semanticsUnchanged = false;
  let conflictFree = false;
  let evidenceComplete = false;

  if (!base) reasons.add("base_version_missing");
  if (!current) reasons.add("current_version_missing");
  if (base && current) {
    const beforeIdentities = identities(base);
    const afterIdentities = identities(current);
    identityPreserved = beforeIdentities.length === afterIdentities.length
      && beforeIdentities.every((identity, index) => identity === afterIdentities[index])
      && new Set(beforeIdentities).size === beforeIdentities.length
      && new Set(afterIdentities).size === afterIdentities.length;
    if (!identityPreserved) reasons.add("identity_not_preserved");
    semanticsUnchanged = diffSpec(base, current).length === 0;
    if (!semanticsUnchanged) reasons.add("behavior_delta_present");
    conflictFree = detectVisibilityConflicts(current).length === 0;
    if (!conflictFree) reasons.add("behavior_conflict_present");
  }

  if (identityPreserved && semanticsUnchanged && conflictFree && current && input.index) {
    evidenceComplete = true;
    for (const feature of current) {
      for (const scenario of feature.scenarios) {
        if (scenario.evidence.length === 0) {
          evidenceComplete = false;
          reasons.add("evidence_missing");
          continue;
        }
        for (const item of scenario.evidence) {
          const startLine = item.startLine;
          const endLine = item.endLine ?? startLine;
          if (!item.path || !Number.isInteger(startLine) || !Number.isInteger(endLine) || (startLine ?? 0) < 1 || (endLine ?? 0) < (startLine ?? 0)) {
            evidenceComplete = false;
            reasons.add("evidence_anchor_missing");
            continue;
          }
          try {
            const slice = await input.index.readLines({
              path: item.path,
              startLine: startLine!,
              endLine: endLine!,
              requestedBy: "evidence_verifier",
              reason: "expectNoChange afterSha evidence verification",
            });
            if (slice.startLine !== startLine || slice.endLine !== endLine || slice.lines.length !== endLine! - startLine! + 1) {
              evidenceComplete = false;
              reasons.add("evidence_range_invalid");
              continue;
            }
            evidenceVerified += 1;
          } catch {
            evidenceComplete = false;
            reasons.add("evidence_unreadable");
          }
        }
      }
    }
  } else if (identityPreserved && semanticsUnchanged && conflictFree && current) {
    reasons.add("evidence_verification_unavailable");
  }

  if (evidenceVerified !== evidenceTotal) evidenceComplete = false;
  const verified = identityPreserved && semanticsUnchanged && conflictFree && evidenceComplete;
  return {
    verified,
    identityPreserved,
    semanticsUnchanged,
    conflictFree,
    evidenceComplete,
    evidenceTotal,
    evidenceVerified,
    reasons: [...reasons].sort(),
  };
}
