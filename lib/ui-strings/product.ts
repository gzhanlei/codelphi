import type { LocaleEntry } from "../ui-locale";

/**
 * Wave 4b 域字典：产品页族（产品页 chrome/Tab、总览、规格卡、发布卡、发布稿面板、
 * 知识健康、规格问答与 lib 纯函数标签）。页面经 resolveUiLocale() 取 locale 后用
 * pick() 取值；客户端组件经 props 接收 locale（缺省 "zh-CN" 保持存量渲染不变）。
 * zh 槽位逐字节复制迁移前的字符串；带插值的句子用 {name}/{count} 占位由调用方 replace。
 */

// ── 产品页 chrome（app/products/[slug]/[product]/page.tsx） ──
export const PRODUCT_PAGE = {
  backLink: { "zh-CN": "← 所有产品", en: "← All products" },
  export: { "zh-CN": "导出 ▾", en: "Export ▾" },
  exportCasesMarkdown: { "zh-CN": "用例 Markdown ↓", en: "Test cases Markdown ↓" },
  driftBanner: {
    "zh-CN": " 条人工规格可能已过时（最近一次分析的行为变化触及了这些功能）。逐条「标记已核实」后标记会消除。",
    en: " manually maintained spec entries may be stale (behavior changes in the latest analysis touched these features). Mark each one as verified to clear the flag.",
  },
  driftBannerGo: { "zh-CN": "去核实 →", en: "Verify →" },
  noteBadgeDraft: { "zh-CN": "待校对", en: "Draft" },
} satisfies Record<string, LocaleEntry>;

// ── 运行状态与视图 Tab（components/product-navigation.tsx） ──
export const RUN_STATUS = {
  label: { "zh-CN": "最近一次分析：", en: "Latest analysis: " },
} satisfies Record<string, LocaleEntry>;

export const PRODUCT_TABS = {
  aria: { "zh-CN": "产品视图", en: "Product views" },
  overview: { "zh-CN": "概览", en: "Overview" },
  journeys: { "zh-CN": "使用场景", en: "Use cases" },
  map: { "zh-CN": "产品地图", en: "Product map" },
  spec: { "zh-CN": "产品规格", en: "Spec" },
  notes: { "zh-CN": "发布稿", en: "Release notes" },
  changes: { "zh-CN": "发布变化", en: "Changes" },
  settings: { "zh-CN": "设置", en: "Settings" },
  noReleases: { "zh-CN": "尚无发布，先生成一次分析。", en: "No releases yet; run an analysis first." },
} satisfies Record<string, LocaleEntry>;

// ── 产品总览（components/product-overview.tsx） ──
export const PRODUCT_OVERVIEW = {
  impactHeading: { "zh-CN": "本次发布对用户的影响", en: "How this release affects users" },
  allDiffs: { "zh-CN": "全部前后差异 →", en: "All before/after diffs →" },
  viewDiffs: { "zh-CN": "查看前后差异 →", en: "View before/after diff →" },
  impactMore: { "zh-CN": "另有 {count} 条影响说明，见全部前后差异。", en: "{count} more impact notes are in the full before/after diff view." },
  impactFallback: { "zh-CN": "本次发布未附用户影响说明，检测到 {count} 处规格行为变化：", en: "This release has no impact notes; {count} spec behavior changes were detected:" },
  quietNote: { "zh-CN": "本次未发现规格行为变化。", en: "No spec behavior changes in this release." },
  priorRelease: { "zh-CN": "最近一次有行为变化的发布：{title}（{date}）→", en: "Last release with behavior changes: {title} ({date}) →" },
  askHeading: { "zh-CN": "规格问答", en: "Ask the spec" },
  askNote: { "zh-CN": "用一句话问产品行为，答案附源码证据。", en: "Ask about product behavior in one sentence; answers cite source evidence." },
  askSuggestion: { "zh-CN": "{name} 是怎么工作的？", en: "How does {name} work?" },
  tasksHeading: { "zh-CN": "你想了解什么？", en: "What do you want to know?" },
  tasksNote: { "zh-CN": "按你想回答的问题进入对应视图。", en: "Jump to the view that answers your question." },
  taskOpen: { "zh-CN": "查看 →", en: "Open →" },
  timelineHeading: { "zh-CN": "发布时间线", en: "Release timeline" },
  allChanges: { "zh-CN": "全部发布变化 →", en: "All release changes →" },
  headlineGenerated: { "zh-CN": " · 代码生成 · ", en: " · generated from code · " },
  evidenceFilesUnit: { "zh-CN": "{count} 个证据文件", en: "{count} evidence files" },
  quietRunSummary: { "zh-CN": "{count} 次提交均未发现规格行为变化 · 展开提交记录", en: "{count} commits with no spec behavior changes · expand to see them" },
  chipDraft: { "zh-CN": "发布稿待校对", en: "Draft awaiting review" },
  chipPublished: { "zh-CN": "已发布", en: "Published" },
  chipUnpublished: { "zh-CN": "已下线", en: "Unpublished" },
  capabilitiesHeading: { "zh-CN": "当前核心能力", en: "Current capabilities" },
  capabilitiesNote: { "zh-CN": "按场景覆盖排序，点击进入规格工作台。", en: "Sorted by scenario coverage; click to open the spec workspace." },
  capabilitiesNoteAi: {
    "zh-CN": "能力分组由 AI 归纳，已校验每个功能恰好归属一次，尚未经人工确认；点击查看该能力的使用场景。",
    en: "Capability groups are summarized by AI; every feature is verified to belong to exactly one group, but the grouping has not been confirmed by a person. Click to see the use cases for a capability.",
  },
  fullCapabilitiesLink: { "zh-CN": "完整能力（规格） →", en: "All capabilities (spec) →" },
  aiBadge: { "zh-CN": "AI 归纳", en: "AI-summarized" },
  capabilityFeatures: { "zh-CN": "{count} 个功能", en: "{count} features" },
  capabilityScenariosCount: { "zh-CN": "{count} 个场景", en: "{count} scenarios" },
  capabilityFeaturesToggle: { "zh-CN": "查看成员功能", en: "Show member features" },
  emptyCapabilities: { "zh-CN": "尚无功能规格。", en: "No feature specs yet." },
  capabilityScenarios: { "zh-CN": " 个场景 · ", en: " scenarios · " },
  journeysHeading: { "zh-CN": "典型使用场景", en: "Typical ways to use it" },
  journeysNote: {
    "zh-CN": "每一步都指向一个已有场景，场景附源码证据；步骤先后与跨步依赖未经验证。",
    en: "Every step points to an existing scenario with source evidence; the order of steps and the dependencies between them are not verified.",
  },
  allJourneys: { "zh-CN": "全部使用场景（{count}）→", en: "All use cases ({count}) →" },
  journeySteps: { "zh-CN": "{count} 步", en: "{count} steps" },
  journeyFeatures: { "zh-CN": "{count} 个功能", en: "{count} features" },
} satisfies Record<string, LocaleEntry>;

// ── 使用场景视图（components/product-use-cases.tsx）与设置页理解层卡片 ──
export const PRODUCT_JOURNEYS = {
  heading: { "zh-CN": "典型使用场景", en: "Typical ways to use it" },
  note: {
    "zh-CN": "每一步都指向一个已有场景，场景附源码证据；步骤先后与跨步依赖未经验证。",
    en: "Every step points to an existing scenario with source evidence; the order of steps and the dependencies between them are not verified.",
  },
  summary: {
    "zh-CN": "{journeys} 条使用场景 · 覆盖 {covered}/{total} 个功能 · 生成于 {time}",
    en: "{journeys} use cases · covers {covered}/{total} features · generated {time}",
  },
  aiNote: { "zh-CN": "AI 归纳 · 只重组已有场景，不新增事实", en: "Summarized by AI from existing scenarios only; nothing is added" },
  importedNote: { "zh-CN": "来自导入的 Radar 快照，未经服务端独立分析。", en: "Imported from a Radar snapshot; not independently analyzed by the server." },
  pendingNote: { "zh-CN": "规格在上次生成后有过变化，使用场景等待刷新。", en: "The spec changed after these use cases were generated; they are waiting to be refreshed." },
  headlineGroup: { "zh-CN": "全局典型场景", en: "Typical across the product" },
  ungroupedGroup: { "zh-CN": "其他使用场景", en: "More use cases" },
  groupCount: { "zh-CN": "{count} 条", en: "{count}" },
  startingPoint: { "zh-CN": "起点", en: "Starting point" },
  finalOutcome: { "zh-CN": "终点", en: "Final outcome" },
  stepLabel: { "zh-CN": "第 {count} 步", en: "Step {count}" },
  openScenario: { "zh-CN": "查看场景：{feature} {reference}", en: "Open scenario: {feature} {reference}" },
  context: { "zh-CN": "情境", en: "Context" },
  action: { "zh-CN": "操作", en: "Action" },
  outcome: { "zh-CN": "结果", en: "Outcome" },
  evidence: { "zh-CN": "证据：", en: "Evidence: " },
  staleGroup: { "zh-CN": "待更新（引用的场景已变更）", en: "Needs refresh (referenced scenarios changed)" },
  staleNote: {
    "zh-CN": "有 {count} 步引用的场景在当前规格里已找不到，这条使用场景等待刷新。",
    en: "{count} step(s) reference scenarios that can no longer be found in the current spec; this use case is waiting to be refreshed.",
  },
  missingScenario: { "zh-CN": "引用的场景已不存在", en: "Referenced scenario no longer exists" },
  brokenNote: { "zh-CN": "另有 {count} 条使用场景的引用已全部失效，暂不展示。", en: "{count} more use case(s) reference scenarios that no longer exist and are hidden." },
  related: { "zh-CN": "途经这项能力、在别处展示的场景：", en: "Also passing through this capability (shown elsewhere): " },
  relatedSeparator: { "zh-CN": "、", en: ", " },
  foldedGroup: { "zh-CN": "未展示的场景（较早的生成规则）", en: "Not shown (from an earlier rule)" },
  foldedNote: {
    "zh-CN": "这些场景由较早的生成规则产出——与上面的场景经过相同的功能组合，或只是把同一功能的多条场景首尾相接；下次重新生成时会自动清理。",
    en: "These came from an earlier generation rule: they cover the same features as a use case shown above, or only chain several scenarios of one feature. They are cleaned up on the next regeneration.",
  },
  emptyNoSpec: { "zh-CN": "尚无功能规格。生成一次分析后，这里会给出产品的典型使用场景。", en: "No feature specs yet. After an analysis, typical ways to use the product will appear here." },
  emptyNotGenerated: { "zh-CN": "典型使用场景尚未生成：首次分析完成后会自动生成。", en: "Typical use cases have not been generated yet; they are created automatically after the first analysis." },
  emptyGenerating: { "zh-CN": "正在生成典型使用场景，稍后刷新页面即可看到。", en: "Typical use cases are being generated; refresh the page in a moment." },
  emptyFailed: { "zh-CN": "典型使用场景生成失败：{reason}", en: "Generating typical use cases failed: {reason}" },
  failureAiUnavailable: { "zh-CN": "模型服务暂时不可用。", en: "The model service is temporarily unavailable." },
  failureUnknown: { "zh-CN": "原因未记录。", en: "The cause was not recorded." },
  emptyNoJourneys: { "zh-CN": "现有场景不足以组成跨功能的使用场景。", en: "The current scenarios do not form any cross-feature use case." },
  goSettings: { "zh-CN": "到设置中重新生成 →", en: "Regenerate in settings →" },
  navLabel: { "zh-CN": "使用场景分组", en: "Use case groups" },
} satisfies Record<string, LocaleEntry>;

export const PRESENTATION_SETTINGS = {
  title: { "zh-CN": "理解层", en: "Understanding layer" },
  summary: { "zh-CN": "总览的核心能力归纳与「使用场景」视图，由 AI 从已有规格重组而来，不新增事实。", en: "The capability summary on the overview and the Use cases view, reorganized by AI from the existing spec without adding facts." },
  status: { "zh-CN": "状态", en: "Status" },
  statusGenerated: { "zh-CN": "已生成", en: "Generated" },
  statusPartial: { "zh-CN": "已生成（不完整）", en: "Generated (incomplete)" },
  statusFailed: { "zh-CN": "生成失败", en: "Generation failed" },
  statusNone: { "zh-CN": "尚未生成", en: "Not generated yet" },
  statusRefreshing: { "zh-CN": "正在生成", en: "Generating" },
  statusPending: { "zh-CN": "规格已变化，等待刷新", en: "Spec changed; refresh pending" },
  generatedAt: { "zh-CN": "生成时间", en: "Generated" },
  lastError: { "zh-CN": "最近错误", en: "Last error" },
  journeys: { "zh-CN": "使用场景", en: "Use cases" },
  coverage: { "zh-CN": "覆盖功能", en: "Features covered" },
  regenerating: { "zh-CN": "正在提交…", en: "Submitting…" },
  regenerate: { "zh-CN": "重新生成", en: "Regenerate" },
  regenerateTitle: { "zh-CN": "立即重算核心能力归纳与使用场景（会调用模型）", en: "Recompute the capability summary and use cases now (calls the model)" },
  submitted: { "zh-CN": "已开始重新生成，稍后刷新页面查看。", en: "Regeneration started; refresh the page in a moment." },
  submittedBusy: { "zh-CN": "已经在生成中，稍后刷新页面查看。", en: "A generation is already running; refresh the page in a moment." },
  error: { "zh-CN": "提交失败：{reason}", en: "Failed to submit: {reason}" },
} satisfies Record<string, LocaleEntry>;

// ── 产品总览数据标签（lib/product-overview.ts） ──
export const OVERVIEW_DATA = {
  headlineFallback: { "zh-CN": "产品概览", en: "Product overview" },
  analysisNone: { "zh-CN": "尚无分析记录", en: "No analysis yet" },
  analysisSucceeded: { "zh-CN": "最近分析成功", en: "Latest analysis succeeded" },
  analysisFailed: { "zh-CN": "最近分析失败", en: "Latest analysis failed" },
  analysisRunning: { "zh-CN": "正在分析", en: "Analyzing" },
  analysisQueued: { "zh-CN": "等待分析", en: "Analysis queued" },
  analysisStatus: { "zh-CN": "分析状态：", en: "Analysis status: " },
  specNone: { "zh-CN": "尚未生成规格", en: "No spec generated yet" },
  specUpdated: { "zh-CN": " · 更新 ", en: " · updated " },
  unknownFeature: { "zh-CN": "未知功能", en: "Unknown feature" },
  groupAdded: { "zh-CN": "新增 {count}", en: "{count} added" },
  groupRemoved: { "zh-CN": "移除 {count}", en: "{count} removed" },
  groupChanged: { "zh-CN": "更新 {count}", en: "{count} changed" },
  groupNone: { "zh-CN": "无行为变化", en: "No behavior changes" },
  taskCapabilityQuestion: { "zh-CN": "这个产品现在能做什么？", en: "What can this product do now?" },
  taskReleaseImpactQuestion: { "zh-CN": "这次发布改变了什么？", en: "What did this release change?" },
  taskRegressionQuestion: { "zh-CN": "这次建议重新验证什么？", en: "What should be re-verified this time?" },
  taskTraceableQuestion: { "zh-CN": "最近有哪些可追溯的变化？", en: "Which recent changes are traceable?" },
  taskDisabledNoSpec: { "zh-CN": "尚无功能规格", en: "No feature specs yet" },
  taskDisabledNoRelease: { "zh-CN": "尚无发布", en: "No releases yet" },
  taskDisabledNoRegression: { "zh-CN": "最新发布暂无回归建议", en: "No regression suggestions for the latest release yet" },
} satisfies Record<string, LocaleEntry>;

// ── 场景卡（components/scenario-card.tsx） ──
export const SCENARIO_CARD = {
  testOnlyBadge: { "zh-CN": "测试佐证", en: "Test-backed" },
  testOnlyTitle: {
    "zh-CN": "本场景的证据全部来自测试/文档，未链接实现代码——行为以人工核实为准。",
    en: "This scenario's evidence comes entirely from tests/docs with no implementation links; behavior is subject to human verification.",
  },
  staleBadge: { "zh-CN": "可能过时", en: "Possibly stale" },
  sourceManual: { "zh-CN": "人工", en: "Manual" },
  sourceGenerated: { "zh-CN": "生成", en: "Generated" },
  editedBy: { "zh-CN": "由 {name} 编辑", en: "Edited by {name}" },
  lastEditedAtTitle: { "zh-CN": "最后编辑于 {time}", en: "Last edited {time}" },
  context: { "zh-CN": "情境", en: "Context" },
  action: { "zh-CN": "操作", en: "Action" },
  outcome: { "zh-CN": "结果", en: "Outcome" },
  edit: { "zh-CN": "编辑", en: "Edit" },
  remove: { "zh-CN": "删除", en: "Delete" },
} satisfies Record<string, LocaleEntry>;

// ── 功能详情（components/feature-detail.tsx） ──
export const FEATURE_DETAIL = {
  staleBadge: { "zh-CN": "可能过时", en: "Possibly stale" },
  editedBy: { "zh-CN": "由 {name} 编辑", en: "Edited by {name}" },
  lastEditedAtTitle: { "zh-CN": "最后编辑于 {time}", en: "Last edited {time}" },
  stableLinkTitle: { "zh-CN": "始终解析到最新规格的稳定链接", en: "Stable link that always resolves to the latest spec" },
  stableLink: { "zh-CN": "稳定链接", en: "Stable link" },
  implementationFiles: { "zh-CN": "已发现证据（不代表完整实现）· {count} 个文件", en: "Evidence found (not proof of full implementation) · {count} files" },
  implementationLines: { "zh-CN": "{count} 行", en: "{count} lines" },
  addChild: { "zh-CN": "＋ 子功能", en: "＋ Child feature" },
  edit: { "zh-CN": "编辑", en: "Edit" },
  remove: { "zh-CN": "删除", en: "Delete" },
  viewsAria: { "zh-CN": "功能视图", en: "Feature views" },
  tabScenarios: { "zh-CN": "场景", en: "Scenarios" },
  tabFlow: { "zh-CN": "流程图", en: "Flow" },
} satisfies Record<string, LocaleEntry>;

// ── 功能行为变迁史（components/feature-history.tsx） ──
export const FEATURE_HISTORY = {
  loadFailed: { "zh-CN": "加载变迁史失败", en: "Failed to load change history" },
  panelFailed: { "zh-CN": "行为变迁史加载失败：{error}", en: "Failed to load change history: {error}" },
  summary: { "zh-CN": "行为变迁史 · 最近 {count} 个发布", en: "Change history · last {count} releases" },
  summaryEmpty: { "zh-CN": "（无行为变化记录）", en: " (no behavior changes recorded)" },
  emptyBody: { "zh-CN": "「{name}」自分析以来没有行为级变化记录。", en: "\"{name}\" has had no behavior-level changes since analysis started." },
  kindAdded: { "zh-CN": "新增", en: "Added" },
  kindChanged: { "zh-CN": "更新", en: "Updated" },
  kindRemoved: { "zh-CN": "移除", en: "Removed" },
  highlightTitle: { "zh-CN": "Highlight 分类", en: "Highlight category" },
} satisfies Record<string, LocaleEntry>;

// ── 发布卡与回归清单（components/release-card.tsx） ──
export const RELEASE_CARD = {
  quietRelease: {
    "zh-CN": "本次分析未发现规格行为变化，无需全量回归；建议做瘦身回归——按近期风险抽查核心路径与既有冒烟用例即可。",
    en: "This analysis found no spec behavior changes, so no full regression is needed; we suggest a slim regression — spot-check core paths and existing smoke cases based on recent risk.",
  },
  fromChanges: { "zh-CN": "来自 {count} 条变化", en: "from {count} changes" },
  regressionHeading: { "zh-CN": "回归清单", en: "Regression checklist" },
  exportMarkdown: { "zh-CN": "导出 Markdown ↓", en: "Export Markdown ↓" },
  impactHint: { "zh-CN": "影响面推荐 · 证据路径与本次改动文件命中", en: "Impact-suggested · evidence paths matched files changed in this release" },
  scenarioRef: { "zh-CN": "场景 {id}", en: "Scenario {id}" },
  statusAria: { "zh-CN": "回归状态：{feature} {reference}", en: "Regression status: {feature} {reference}" },
  skipPlaceholder: { "zh-CN": "跳过原因（可选）", en: "Skip reason (optional)" },
  skipAria: { "zh-CN": "跳过原因：{feature} {reference}", en: "Skip reason: {feature} {reference}" },
  failPlaceholder: { "zh-CN": "发现的问题 / 关联缺陷（可选）", en: "Issues found / linked defects (optional)" },
  failAria: { "zh-CN": "失败备注：{feature} {reference}", en: "Failure note: {feature} {reference}" },
  markedBy: { "zh-CN": "由 {name} 标记", en: "Marked by {name}" },
  saveFailed: { "zh-CN": "保存验证状态失败", en: "Failed to save verification status" },
  aiChangeHeading: { "zh-CN": "变更说明（AI）", en: "AI change notes" },
  detailsSummary: { "zh-CN": "行为变化 {behavior} 条 · 变更说明 {notes} 条", en: "{behavior} behavior changes · {notes} AI change notes" },
  collapse: { "zh-CN": "收起", en: "Collapse" },
  expand: { "zh-CN": "展开", en: "Expand" },
  foldedSummary: {
    "zh-CN": "另有 {count} 条差异判定为仅措辞/编号调整，已折叠（未计入行为变化）",
    en: "{count} more diffs judged wording/numbering-only are folded (not counted as behavior changes)",
  },
} satisfies Record<string, LocaleEntry>;

// ── 发布稿面板（components/release-notes-view.tsx / release-notes-panel.tsx） ──
export const RELEASE_NOTES = {
  statusDraft: { "zh-CN": "草稿", en: "Draft" },
  statusPublished: { "zh-CN": "已发布", en: "Published" },
  statusUnpublished: { "zh-CN": "已下线", en: "Unpublished" },
  kindAdded: { "zh-CN": "新增", en: "Added" },
  kindChanged: { "zh-CN": "更新", en: "Updated" },
  kindRemoved: { "zh-CN": "移除", en: "Removed" },
  highlightSuffix: { "zh-CN": "（{type}）", en: " ({type})" },
  noCandidates: { "zh-CN": "本次发布没有行为变化，无可宣布项。", en: "No behavior changes in this release — nothing to announce." },
  overriddenBadge: { "zh-CN": "已人工改写", en: "Manually rewritten" },
  resetOriginal: { "zh-CN": "还原原文", en: "Restore original" },
  blockAria: { "zh-CN": "块文案：{title}", en: "Block text: {title}" },
  heading: { "zh-CN": "发布稿", en: "Release notes" },
  headingDescription: {
    "zh-CN": "最新一次发布（release #{id}）的客户向说明。每块锚定规格变更与证据，人工校对并发布后生成公开页。",
    en: "Customer-facing notes for the latest release (release #{id}). Each block is anchored to a spec change with evidence; after human review and publishing it becomes a public page.",
  },
  panelHeading: { "zh-CN": "发布稿（客户向）", en: "Release notes (customer-facing)" },
  publicPage: { "zh-CN": "公开页 ↗", en: "Public page ↗" },
  changelog: { "zh-CN": "公开变更日志 ↗", en: "Public changelog ↗" },
  pickPrompt: { "zh-CN": "勾选本次发布要宣布的变更（不自动全选），生成发布稿草稿。", en: "Pick the changes to announce in this release (nothing is pre-selected) to generate a draft." },
  pickPromptPanel: {
    "zh-CN": "勾选要宣布的变更（不自动全选），生成客户向发布稿草稿；每条都锚定规格变更并附证据。",
    en: "Pick the changes to announce (nothing is pre-selected) to generate a customer-facing draft; every item is anchored to a spec change with evidence.",
  },
  generate: { "zh-CN": "生成发布稿", en: "Generate release notes" },
  generateSelected: { "zh-CN": "（已选 {count} 条）", en: " ({count} selected)" },
  headlineLabel: { "zh-CN": "公告标题（发布稿的 H1，AI 合成后可修改）", en: "Announcement headline (the H1 of the release notes; editable after AI synthesis)" },
  headlinePlaceholder: { "zh-CN": "一句话公告标题，如：一条命令连接产品规格与 AI 助手", en: "A one-sentence headline, e.g. one command connects your spec to AI assistants" },
  emphasisLabel: { "zh-CN": "重点强调（可选）", en: "Emphasis (optional)" },
  emphasisPlaceholder: { "zh-CN": "一句话强调本次发布的重点", en: "One sentence on what matters most in this release" },
  regeneratePrompt: { "zh-CN": "调整勾选后重新生成（覆盖当前草稿与块级改写）：", en: "Regenerate with a new selection (overwrites the current draft and block rewrites):" },
  regenerate: { "zh-CN": "按勾选重新生成", en: "Regenerate from selection" },
  cancel: { "zh-CN": "取消", en: "Cancel" },
  publish: { "zh-CN": "发布", en: "Publish" },
  republish: { "zh-CN": "重新发布", en: "Republish" },
  adjustSelection: { "zh-CN": "调整勾选", en: "Adjust selection" },
  copyLink: { "zh-CN": "复制公开链接", en: "Copy public link" },
  unpublish: { "zh-CN": "下线", en: "Unpublish" },
  publishedNote: {
    "zh-CN": "已发布只读：先下线才能修改或重新生成；公开页对匿名可见，证据仅展示路径。",
    en: "Published and read-only: unpublish first to edit or regenerate; the public page is anonymous and shows evidence paths only.",
  },
  exportMarkdown: { "zh-CN": "导出 Markdown ↓", en: "Export Markdown ↓" },
  loadFailedPrefix: { "zh-CN": "发布稿：{error}", en: "Release notes: {error}" },
  loginPrompt: { "zh-CN": "登录后可在工作区生成并发布发布稿。", en: "Sign in to generate and publish release notes in your workspace." },
  loginPromptPanel: { "zh-CN": "登录后可在工作区生成并发布本版的发布稿。", en: "Sign in to generate and publish release notes for this version in your workspace." },
  loadFailed: { "zh-CN": "加载发布稿失败", en: "Failed to load release notes" },
  operationFailed: { "zh-CN": "操作失败", en: "Operation failed" },
  noticeHeadlineSaved: { "zh-CN": "标题已保存", en: "Headline saved" },
  noticeEmphasisSaved: { "zh-CN": "强调语已保存", en: "Emphasis saved" },
  noticeDraftGenerated: { "zh-CN": "发布稿草稿已生成", en: "Release notes draft generated" },
  noticeDraftGeneratedPanel: { "zh-CN": "发布稿草稿已生成，逐块校对后发布", en: "Draft generated; review each block before publishing" },
  noticePublished: { "zh-CN": "已发布，公开链接可分享", en: "Published; the public link is ready to share" },
  noticeUnpublished: { "zh-CN": "已下线，公开链接不再展示", en: "Unpublished; the public link is no longer shown" },
  noticeCopied: { "zh-CN": "公开链接已复制", en: "Public link copied" },
  enhance: { "zh-CN": "AI 润色（只改措辞，锚定与证据不变）", en: "AI polish (wording only; anchors and evidence stay unchanged)" },
  enhancing: { "zh-CN": "AI 改写中…", en: "AI rewriting…" },
  enhanceFailed: { "zh-CN": "AI 改写失败", en: "AI rewrite failed" },
} satisfies Record<string, LocaleEntry>;

// ── 知识健康（components/knowledge-health-panel.tsx） ──
export const KNOWLEDGE_HEALTH = {
  loadFailed: { "zh-CN": "加载知识健康失败", en: "Failed to load knowledge health" },
  heading: { "zh-CN": "知识健康", en: "Knowledge health" },
  intro: { "zh-CN": "事实统计，不是健康分——每项数字都可点开追溯；采纳前应经人工核实。", en: "Facts, not a health score — every number is traceable; verify before adopting." },
  staleLabel: { "zh-CN": "待核实漂移", en: "Unverified drift" },
  staleUnit: { "zh-CN": "条人工规格可能过时", en: "manually maintained spec entries may be stale" },
  verifiedLabel: { "zh-CN": "已核实条目", en: "Verified entries" },
  verifiedUnit: { "zh-CN": "当前版本核实覆盖约 {share}%", en: "about {share}% of the current version is verified" },
  lastVerifiedLabel: { "zh-CN": "最近一次核实", en: "Last verified" },
  lastVerifiedUnit: { "zh-CN": "核实是唯一清漂移的人工动作", en: "human verification is the only way to clear drift" },
  regressionLabel: { "zh-CN": "最新发布回归", en: "Latest release regression" },
  regressionUnit: { "zh-CN": "通过 · 未通过 {failed} · 跳过 {skipped} · 待验证 {pending}", en: "{passed} passed · {failed} failed · {skipped} skipped · {pending} pending" },
  staleListHeading: { "zh-CN": "最久未核实的漂移条目", en: "Longest-unverified drift entries" },
  kindFeature: { "zh-CN": "功能", en: "Feature" },
  kindScenario: { "zh-CN": "场景", en: "Scenario" },
  staleSince: { "zh-CN": "自 {date}", en: "since {date}" },
  maintenanceHeading: { "zh-CN": "近 {days} 天人工编辑分布", en: "Manual edits in the last {days} days" },
  maintenanceEdits: { "zh-CN": "{count} 次", en: "{count} edits" },
  maintenanceUnattributed: {
    "zh-CN": "另有 {count} 次归因前（migration 064 之前）的历史编辑未计入。",
    en: "{count} historical edits from before attribution (prior to migration 064) are not counted.",
  },
  maintenanceDisclaimer: {
    "zh-CN": "维护记录 ≠ 掌握知识：分布只反映编辑投入，不做人员能力或 Bus Factor 推断。",
    en: "Maintenance records ≠ knowledge: the distribution reflects editing effort only and implies nothing about individual skill or Bus Factor.",
  },
} satisfies Record<string, LocaleEntry>;

// ── 规格问答（components/spec-ask.tsx） ──
export const SPEC_ASK = {
  aria: { "zh-CN": "向规格提问", en: "Ask the spec" },
  placeholder: {
    "zh-CN": "用一句话问产品行为，例如：上传文件最多几个？单个文件最大多大？",
    en: "Ask about product behavior in one sentence, e.g.: how many files can be uploaded? How large can one file be?",
  },
  searching: { "zh-CN": "查询中…", en: "Searching…" },
  search: { "zh-CN": "查规格", en: "Search spec" },
  rateLimitedMinutes: { "zh-CN": "提问频率已达上限（每 IP 每小时 10 次），约 {minutes} 分钟后可再试。", en: "Ask rate limit reached (10 questions per IP per hour); try again in about {minutes} minutes." },
  rateLimitedUntil: { "zh-CN": "提问频率已达上限，{time} 后可再试。", en: "Ask rate limit reached; try again after {time}." },
  unavailable: { "zh-CN": "查询暂时不可用，请稍后重试。", en: "Search is temporarily unavailable; please try again later." },
  aiAnswerLabel: { "zh-CN": "AI 综合回答 · 仅基于下方规格条目，未采信条目之外的内容", en: "AI-synthesized answer · based only on the spec entries below; nothing beyond them is trusted" },
  insufficientLabel: { "zh-CN": "规格里没有能直接回答这个问题的条目。缺口：", en: "No spec entry directly answers this question. Gap:" },
  kindFeature: { "zh-CN": "功能", en: "Feature" },
  kindScenario: { "zh-CN": "场景", en: "Scenario" },
  versionNote: { "zh-CN": "基于规格版本 #{id}；未覆盖结论仅对该版本有效。", en: "Based on spec version #{id}; uncovered conclusions only apply to that version." },
  hitsOmitted: { "zh-CN": "其余 {count} 条命中条目已省略——可换更具体的问法收窄范围。", en: "{count} more matching entries omitted — refine your question to narrow the results." },
} satisfies Record<string, LocaleEntry>;

// ── 规格编辑器 UI（lib/spec-editor-ui.ts） ──
export const SPEC_EDITOR = {
  deleteFeatureError: { "zh-CN": "删除功能失败", en: "Failed to delete the feature" },
  emptyTitle: { "zh-CN": "选择一个功能", en: "Select a feature" },
  emptyBody: { "zh-CN": "从左侧功能树选择，或新建顶级功能。", en: "Pick one from the feature tree, or create a new top-level feature." },
  newFeature: { "zh-CN": "＋ 新功能", en: "＋ New feature" },
  categoryHappy: { "zh-CN": "正常路径", en: "Happy path" },
  categoryEdge: { "zh-CN": "边界情况", en: "Edge case" },
  categoryError: { "zh-CN": "错误路径", en: "Error path" },
  filterAll: { "zh-CN": "全部", en: "All" },
  sourceManual: { "zh-CN": "人工维护", en: "Manually maintained" },
  sourceGenerated: { "zh-CN": "代码生成", en: "Generated from code" },
  scenarioEditTitle: { "zh-CN": "编辑场景 {reference}", en: "Edit scenario {reference}" },
  scenarioNewTitle: { "zh-CN": "新建场景", en: "New scenario" },
  featureEditTitle: { "zh-CN": "编辑功能", en: "Edit feature" },
  featureNewTopTitle: { "zh-CN": "新建顶级功能", en: "New top-level feature" },
  featureNewChildTitle: { "zh-CN": "新建子功能", en: "New child feature" },
  saving: { "zh-CN": "保存中…", en: "Saving…" },
  verificationUnverified: { "zh-CN": "未核实", en: "Unverified" },
  verificationVerified: { "zh-CN": "已核实", en: "Verified" },
  verificationStale: { "zh-CN": "待重新核实", en: "Needs re-verification" },
} satisfies Record<string, LocaleEntry>;

// ── 回归任务标签（lib/regression-task-view.ts） ──
export const REGRESSION = {
  statusPending: { "zh-CN": "待验证", en: "Pending" },
  statusPassed: { "zh-CN": "已通过", en: "Passed" },
  statusFailed: { "zh-CN": "未通过", en: "Failed" },
  statusSkipped: { "zh-CN": "已跳过", en: "Skipped" },
  hitBehaviorChange: { "zh-CN": "行为变化", en: "Behavior change" },
  hitEvidencePath: { "zh-CN": "证据路径命中", en: "Evidence path hit" },
  hitFeatureWide: { "zh-CN": "整功能受影响", en: "Whole feature affected" },
} satisfies Record<string, LocaleEntry>;

// ── 完整性账本（lib/completeness-ledger-view.ts） ──
export const LEDGER = {
  dimSourceCoverage: { "zh-CN": "源码覆盖", en: "Source coverage" },
  dimBehavioralEnumeration: { "zh-CN": "行为枚举", en: "Behavioral enumeration" },
  dimExtractionCompletion: { "zh-CN": "提取完成度", en: "Extraction completion" },
  dimEvidenceIntegrity: { "zh-CN": "证据完整性", en: "Evidence integrity" },
  dimMergeIntegrity: { "zh-CN": "合并完整性", en: "Merge integrity" },
  dimVerification: { "zh-CN": "核验", en: "Verification" },
  reasonSourceCoverage: { "zh-CN": "未覆盖全部实现面，未覆盖部分不产生结论", en: "not all implementation surface was covered; uncovered parts produce no conclusions" },
  reasonBehavioralEnumeration: { "zh-CN": "部分行为文件未完成枚举", en: "some behavior files were not fully enumerated" },
  reasonExtractionCompletion: { "zh-CN": "部分提取趟重试或为空结果", en: "some extraction passes retried or returned empty" },
  reasonEvidenceIntegrity: { "zh-CN": "存在被剔除的不可溯源声明", en: "some claims without traceable sources were dropped" },
  reasonMergeIntegrity: { "zh-CN": "合并层有截断/冲突/护栏检出", en: "the merge layer hit truncation/conflict/guardrail findings" },
  reasonVerification: { "zh-CN": "存在一致性冲突或影子对比不一致", en: "consistency conflicts or shadow-diff mismatches were found" },
  overallComplete: { "zh-CN": "完整分析", en: "Complete analysis" },
  overallPartial: { "zh-CN": "部分完整", en: "Partially complete" },
  overallFailed: { "zh-CN": "完整性不足", en: "Insufficient completeness" },
  overallNotApplicable: { "zh-CN": "不适用", en: "Not applicable" },
  statePartial: { "zh-CN": "部分", en: "partial" },
  stateFailed: { "zh-CN": "失败", en: "failed" },
  dimensionsTitle: { "zh-CN": "六维度状态：{states}", en: "Six-dimension states: {states}" },
  disclosurePrefix: { "zh-CN": "分析完整性：{overall}", en: "Analysis completeness: {overall}" },
  disclosureSuffix: { "zh-CN": "。分析成功不等于完整，完整不等于正确；结论采纳前应经人工核实。", en: ". A successful analysis is not a complete one, and complete is not correct; have a human verify before adopting conclusions." },
} satisfies Record<string, LocaleEntry>;

// ── 覆盖率展示（lib/coverage-display.ts） ──
export const COVERAGE = {
  byteLabel: { "zh-CN": "源码装配覆盖率（按文件字节）", en: "Source assembly coverage (by file bytes) " },
  filesLabel: { "zh-CN": "已装配实现文件 {assembled}/{total} 个", en: "Assembled implementation files {assembled}/{total}" },
  runtimeBlindSpotPrefix: { "zh-CN": "运行时开关与数据依赖行为静态提取不可见（", en: "Runtime switches and data-dependent behavior are invisible to static extraction (" },
  boundaryLabel: { "zh-CN": "边界说明", en: "boundary notice" },
  runtimeBlindSpotTail: {
    "zh-CN": "）；发现缺口请在左侧功能树进入功能页，用「编辑/新增场景」人工补充并标记核实。",
    en: "); to fill gaps, open the feature page from the feature tree and add scenarios manually, marking them verified.",
  },
} satisfies Record<string, LocaleEntry>;

// ── 流程图空态（lib/feature-flow-view.ts） ──
export const FEATURE_FLOW = {
  noError: { "zh-CN": "流程图尚未生成，将随下次分析自动生成；完整场景清单见「场景」标签。", en: "The flow diagram has not been generated yet; it will be generated with the next analysis. The full scenario list is under the \"Scenarios\" tab." },
  fallback: {
    "zh-CN": "AI 生成的流程图未通过证据校验，已按护栏要求不渲染未经证实的图；下次分析会自动重试生成，完整场景清单见「场景」标签。",
    en: "The AI-generated flow diagram failed evidence validation, so the unverified diagram is not rendered per the guardrails; generation retries automatically with the next analysis. The full scenario list is under the \"Scenarios\" tab.",
  },
  MAIN_CHAIN_MISSING: {
    "zh-CN": "这个功能的场景之间没有形成可表达的先后主链——这类功能（如仪表盘、清单、管理面板）能力是并列的，没有真实的执行顺序。强行画图会制造假流程，所以按证据护栏不渲染；完整场景清单见「场景」标签。",
    en: "This feature's scenarios do not form an expressible main chain — features like dashboards, lists and admin panels have parallel capabilities with no real execution order. Forcing a diagram would fabricate a fake flow, so the guardrails skip it; the full scenario list is under the \"Scenarios\" tab.",
  },
  TOO_MANY_ENTRIES: {
    "zh-CN": "这个功能包含超过 8 条真正独立的子流程，超出单张流程图的承载范围，更适合拆分后分别生成；完整场景清单见「场景」标签。",
    en: "This feature contains more than 8 truly independent sub-flows, beyond what a single flow diagram can carry; splitting it up would work better. The full scenario list is under the \"Scenarios\" tab.",
  },
  TOO_MANY_NODES: {
    "zh-CN": "这个功能的场景规模超出单张流程图的表达上限（最多 24 个节点），完整场景清单见「场景」标签。",
    en: "This feature's scenarios exceed what a single flow diagram can express (max 24 nodes); the full scenario list is under the \"Scenarios\" tab.",
  },
  TOO_MANY_EDGES: {
    "zh-CN": "这个功能的关系数量超出单张流程图的表达上限（最多 48 条边），完整场景清单见「场景」标签。",
    en: "This feature's relationships exceed what a single flow diagram can express (max 48 edges); the full scenario list is under the \"Scenarios\" tab.",
  },
  RETRY_EVIDENCE_MISSING: {
    "zh-CN": "图中出现了重试/返回步骤，但现有场景证据不足以支持它，按证据校验暂不渲染；下次分析会自动重试生成。",
    en: "The diagram contains retry/return steps that current scenario evidence cannot support, so it is not rendered per evidence validation; generation retries automatically with the next analysis.",
  },
  INVALID_GRAPH_SHAPE: {
    "zh-CN": "AI 生成的图结构未通过校验（多为瞬时问题），下次分析会自动重试生成。",
    en: "The AI-generated graph structure failed validation (usually a transient issue); generation retries automatically with the next analysis.",
  },
  UNCONDITIONAL_ERROR_ENTRY: {
    "zh-CN": "场景证据不支持从入口直接进入错误处理，按证据校验暂不渲染；完整场景清单见「场景」标签。",
    en: "Scenario evidence does not support jumping from the entry straight into error handling, so the diagram is not rendered per evidence validation; the full scenario list is under the \"Scenarios\" tab.",
  },
  EXCLUDED_SCENARIO_IN_GRAPH: {
    "zh-CN": "AI 把已排除的场景又画进了图里，未通过一致性校验；下次分析会自动重试生成。",
    en: "The AI drew an excluded scenario back into the diagram, failing consistency validation; generation retries automatically with the next analysis.",
  },
  UNKNOWN_SCENARIO_REFERENCE: {
    "zh-CN": "AI 引用了不存在的场景编号，未通过证据校验；下次分析会自动重试生成。",
    en: "The AI referenced a scenario reference that does not exist, failing evidence validation; generation retries automatically with the next analysis.",
  },
  UNEXPECTED_CYCLE: {
    "zh-CN": "图中出现了证据不足以支持的循环依赖，按证据校验暂不渲染；完整场景清单见「场景」标签。",
    en: "The diagram contains a cycle the evidence cannot support, so it is not rendered per evidence validation; the full scenario list is under the \"Scenarios\" tab.",
  },
  UNREACHABLE_NODE: {
    "zh-CN": "图中存在无法从入口到达的节点，未通过完整性校验；下次分析会自动重试生成。",
    en: "The diagram contains nodes unreachable from the entry, failing completeness validation; generation retries automatically with the next analysis.",
  },
} satisfies Record<string, LocaleEntry>;

// ── 集成 UI（lib/integration-ui.ts） ──
export const INTEGRATION = {
  connected: { "zh-CN": "已连接", en: "Connected" },
  disconnected: { "zh-CN": "已断开", en: "Disconnected" },
  patConfigured: { "zh-CN": "已配置", en: "Configured" },
  patNotConfigured: { "zh-CN": "未配置", en: "Not configured" },
  patOptionFallback: { "zh-CN": "Personal Access Token 回退", en: "Personal Access Token fallback" },
  patOptionApp: { "zh-CN": "选择 GitHub App 安装", en: "Install the GitHub App" },
} satisfies Record<string, LocaleEntry>;

/** 发布变化视图（ProductChanges，客户端）chrome。 */
export const PRODUCT_CHANGES = {
  emptyTitle: { "zh-CN": "还没有发布记录", en: "No releases yet" },
  emptyBody: { "zh-CN": "GitHub push 或手动分析后，这里会显示产品变化。", en: "After a GitHub push or a manual analysis, product changes appear here." },
  exportIndex: { "zh-CN": "导出 30 天变更索引 ↓", en: "Export 30-day change index ↓" },
  loadMore: { "zh-CN": "加载更多（还有 {count} 条）", en: "Load more ({count} remaining)" },
  loading: { "zh-CN": "加载中…", en: "Loading…" },
  loadError: { "zh-CN": "加载更多发布失败", en: "Failed to load more releases" },
} satisfies Record<string, LocaleEntry>;
