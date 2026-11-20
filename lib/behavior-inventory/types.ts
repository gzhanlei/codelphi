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
  /** 影子阶段限制（M）：没有调用图分析，恒为空数组——绝不把整份共享依赖文件塞进上下文顶替。
   *  排空必须显式可见，后续引入调用图时按最小依赖区间填充。 */
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

/** 清单生成诊断（D）：随 manifest 持久化，恢复时与单元清单一同受 hash 保护；
 *  编排层据此向枚举摘要暴露 detector 失败面与不可读文件，不再停留在内存返回值。 */
export interface BehaviorInventoryDiagnostics {
  detectorUnsupported: string[];
  detectorParseFailure: string[];
  dynamicRegistrationFallback: string[];
  excludedNonImplementation: string[];
  /** 读取失败的实现面文件（生成零区间占位单元，激活被阻断直到可读）。 */
  unreadablePaths: string[];
  /** 清单生成时由实现面枚举独立计算的可读实现区间（K：覆盖判定的独立真源）。 */
  eligibleRanges: CodeRange[];
  fallbackInventorySuccess: boolean;
  semanticUnits: number;
  residualUnits: number;
}

export interface BehaviorManifest {
  inventorySchemaVersion: string;
  detectorRegistryVersion: string;
  afterSha: string;
  scopeFingerprint: string;
  units: BehaviorUnit[];
  tasks: BehaviorExecutionTask[];
  /** schema v2 起随 manifest 持久化；缺省时按空值物化（见 manifest.ts normalizeManifest）。 */
  diagnostics?: BehaviorInventoryDiagnostics;
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
