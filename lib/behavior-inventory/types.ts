export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CodeRange extends LineRange {
  path: string;
}

export type BehaviorUnitKind =
  | "http"
  | "page"
  | "cli"
  | "job"
  | "event"
  | "public_api"
  | "file"
  | "symbol_range";

export type BehaviorAnchorRole = "entry" | "behavior" | "implicit_review";

export interface BehaviorEvidence {
  path: string;
  startLine?: number | null;
}

export interface BehaviorAnchor {
  anchorKey: string;
  role: BehaviorAnchorRole;
  ranges: LineRange[];
  evidence: BehaviorEvidence[];
  coarse: boolean;
}

export interface BehaviorUnit {
  unitKey: string;
  kind: BehaviorUnitKind;
  primaryPath: string;
  primaryRanges?: LineRange[] | null;
  contextRanges: CodeRange[];
  anchors: BehaviorAnchor[];
  detector: string;
  detectorVersion: string;
}

export interface BehaviorAnchorFragment {
  anchorKey: string;
  anchorFragmentKey: string;
  ranges: LineRange[];
}

export interface BehaviorExecutionTask {
  taskKey: string;
  unitKey: string;
  anchorFragments: BehaviorAnchorFragment[];
}

export interface BehaviorManifest {
  inventorySchemaVersion: string;
  detectorRegistryVersion: string;
  afterSha: string;
  scopeFingerprint: string;
  units: BehaviorUnit[];
  tasks: BehaviorExecutionTask[];
}

export interface AnonymousPosition {
  path: string;
  startLine: number;
  startColumn: number;
}

/** 单元身份的确定性输入。displayName 是 AI 或展示用名称，不进入身份。 */
export interface BehaviorUnitLocator {
  kind: BehaviorUnitKind;
  path?: string;
  route?: string | null;
  method?: string | null;
  registrationId?: string | null;
  registrationPath?: string | null;
  exportPath?: string | null;
  symbol?: string | null;
  signature?: string | null;
  anonymousAt?: AnonymousPosition | null;
  chunk?: LineRange | null;
  occurrenceOrdinal?: number | null;
  displayName?: string | null;
}

/** 锚点身份的确定性输入。displayName 是 AI 或展示用名称，不进入身份。 */
export interface BehaviorAnchorLocator {
  role: BehaviorAnchorRole;
  path: string;
  symbol?: string | null;
  anonymousAt?: AnonymousPosition | null;
  ranges: LineRange[];
  occurrenceOrdinal?: number | null;
  displayName?: string | null;
}
