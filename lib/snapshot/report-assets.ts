import type { OutputLanguage } from "../analysis-language";

export interface ReportCopy {
  titleSuffix: string;
  productSnapshot: string;
  coreCapabilities: string;
  featureIndex: string;
  journeys: string;
  codebaseNavigation: string;
  concepts: string;
  projectMapNote: string;
  journeyNote: string;
  codebaseNote: string;
  conceptsNote: string;
  specificationNote: string;
  evidenceNote: string;
  startingPoint: string;
  finalOutcome: string;
  linkedScenarios: string;
  evidenceFiles: string;
  specifications: string;
  snapshotDetails: string;
  expandEvidence: string;
  navLabel: string;
  overview: string;
  features: string;
  evidence: string;
  boundaries: string;
  searchLabel: string;
  searchPlaceholder: string;
  categoryLabel: string;
  allCategories: string;
  happy: string;
  edge: string;
  error: string;
  context: string;
  action: string;
  outcome: string;
  source: string;
  revision: string;
  branch: string;
  generatedAt: string;
  model: string;
  noDescription: string;
  noResults: string;
  warnings: string;
  coverage: string;
  assembledFiles: string;
  assembledBytes: string;
  notInDenominator: string;
  partitions: string;
  evidenceUnavailable: string;
  evidenceTruncated: string;
  viewSource: string;
  backToTop: string;
  trustTitle: string;
  trustBody: string;
  coverageNote: string;
  noScript: string;
  ctaTitle: string;
  ctaBody: string;
  ctaGithub: string;
  ctaCloud: string;
  warningMessages: Record<string, string>;
}

export const REPORT_COPY: Record<OutputLanguage, ReportCopy> = {
  en: {
    titleSuffix: " · CoDelphi Product Snapshot",
    productSnapshot: "Product snapshot",
    coreCapabilities: "Project map",
    featureIndex: "Feature index",
    journeys: "Typical ways to use it",
    codebaseNavigation: "Evidence code index",
    concepts: "Key concepts and relations",
    projectMapNote: "AI synthesis · unique feature assignment validated",
    journeyNote: "Source-backed scenarios · step order and cross-step dependencies unverified",
    codebaseNote: "Deterministic from evidence paths · not a module-responsibility map",
    conceptsNote: "AI synthesis · scenario-linked; relation types and defining evidence unverified",
    specificationNote: "Source-backed AI candidates · tests not run",
    evidenceNote: "Source windows actually read at the pinned commit",
    startingPoint: "Starting point",
    finalOutcome: "Final outcome",
    linkedScenarios: "linked scenarios",
    evidenceFiles: "evidence files",
    specifications: "Full product specification",
    snapshotDetails: "Snapshot details",
    expandEvidence: "Browse all source evidence",
    navLabel: "Snapshot navigation",
    overview: "Project at a glance",
    features: "Full product specification",
    evidence: "Source evidence",
    boundaries: "Analysis boundaries",
    searchLabel: "Search",
    searchPlaceholder: "Search features or scenarios",
    categoryLabel: "Scenario category",
    allCategories: "All categories",
    happy: "Happy path",
    edge: "Edge case",
    error: "Error case",
    context: "Context",
    action: "Action",
    outcome: "Outcome",
    source: "Source",
    revision: "Commit",
    branch: "Branch",
    generatedAt: "Generated",
    model: "Model",
    noDescription: "No evidence-backed product description was generated.",
    noResults: "No features or scenarios match the current filters.",
    warnings: "Analysis notices",
    coverage: "Source input coverage",
    assembledFiles: "Relevant files assembled",
    assembledBytes: "Data files excluded",
    notInDenominator: "not included in the denominator",
    partitions: "Analysis partitions",
    evidenceUnavailable: "The cited lines were not present in the assembled source window. No substitute code is shown.",
    evidenceTruncated: "This excerpt was truncated; the complete cited range is not shown.",
    viewSource: "View source at this commit",
    backToTop: "Back to top",
    trustTitle: "What this report does—and does not—establish",
    trustBody: "Features and descriptions are unreviewed AI candidates grounded in the displayed source window. Successful analysis is not proof of completeness or correctness, and this report does not indicate that tests were run.",
    coverageNote: "Source input coverage is the share of relevant source files assembled into analysis partitions. Structured data, CI and lock files are excluded from the denominator. It is not product-feature coverage, behavioral-evidence coverage, correctness, or test coverage; uncovered behavior may still exist.",
    noScript: "Search and filters require JavaScript. The complete report remains readable without it.",
    ctaTitle: "Want continuous analysis for your repositories?",
    ctaBody: "Self-host CoDelphi from GitHub to keep analyzing your repositories, or use CoDelphi.com for continuous product understanding without managing infrastructure.",
    ctaGithub: "Self-host on GitHub",
    ctaCloud: "Use CoDelphi.com",
    warningMessages: {
      working_tree_dirty: "The working tree contains uncommitted or untracked changes. They are not included in this commit snapshot.",
      partition_limit_reached: "The analysis reached its partition limit ({count}/{limit}); additional source may be omitted.",
      extraction_retry: "Extraction required {count} retry attempt(s).",
      empty_pass: "{count} extraction partition(s) produced no evidence-backed scenarios.",
      evidence_dropped: "{count} scenario(s) were removed because their evidence was outside the actual source window.",
      all_candidates_rejected: "All candidates were rejected in {count} partition(s); this is not evidence that the corresponding behavior is absent.",
      scenarios_deduplicated: "{count} behavior-equivalent scenario duplicate(s) were merged.",
      features_folded: "{count} feature variant(s) were merged by the deterministic identity rules.",
      evidence_budget_exceeded: "Some evidence excerpts were omitted after reaching the {limit}-byte report evidence budget.",
      evidence_snippet_truncated: "Some evidence excerpts exceed the {limit}-line excerpt limit and are visibly truncated.",
      evidence_lines_unavailable: "Some cited line numbers were unavailable in the assembled source window.",
      product_description_unavailable: "The product description has no surviving traceable evidence and is therefore shown as unknown.",
      presentation_fallback: "The project map, journeys, or concepts were unavailable or failed evidence validation. The report uses a complete feature index instead of implying a core-capability ranking.",
    },
  },
  "zh-CN": {
    titleSuffix: " · CoDelphi 产品现状快照",
    productSnapshot: "产品现状快照",
    coreCapabilities: "项目地图",
    featureIndex: "功能索引",
    journeys: "典型使用场景",
    codebaseNavigation: "证据代码索引",
    concepts: "关键概念与关系",
    projectMapNote: "AI 归纳 · 功能唯一归属与完整性已校验",
    journeyNote: "步骤有源码证据 · 步骤顺序与跨步骤依赖未验证",
    codebaseNote: "根据证据路径确定性统计 · 不表示模块职责",
    conceptsNote: "AI 归纳 · 有关系场景参考，关系类型与直接定义证据未核实",
    specificationNote: "带源码证据的 AI 候选 · 未执行测试",
    evidenceNote: "固定提交中实际读取的源码窗口",
    startingPoint: "起始条件",
    finalOutcome: "最终结果",
    linkedScenarios: "个关联场景",
    evidenceFiles: "个证据文件",
    specifications: "完整产品规格",
    snapshotDetails: "快照信息",
    expandEvidence: "展开全部源码证据",
    navLabel: "快照导航",
    overview: "快速了解项目",
    features: "完整产品规格",
    evidence: "源码证据",
    boundaries: "分析边界",
    searchLabel: "搜索",
    searchPlaceholder: "搜索功能或场景",
    categoryLabel: "场景分类",
    allCategories: "全部分类",
    happy: "正常路径",
    edge: "边界情况",
    error: "错误情况",
    context: "情境",
    action: "操作",
    outcome: "结果",
    source: "来源",
    revision: "提交",
    branch: "分支",
    generatedAt: "生成时间",
    model: "模型",
    noDescription: "未生成具有可追溯证据的产品简介。",
    noResults: "没有符合当前筛选条件的功能或场景。",
    warnings: "分析提示",
    coverage: "源码输入覆盖率",
    assembledFiles: "有效文件装配数",
    assembledBytes: "排除的数据文件",
    notInDenominator: "不计入有效覆盖分母",
    partitions: "分析分区",
    evidenceUnavailable: "实际装配源码窗口中不存在所引用行号，因此不展示替代代码。",
    evidenceTruncated: "此证据片段已截断，未展示完整引用范围。",
    viewSource: "查看此提交的源码",
    backToTop: "回到顶部",
    trustTitle: "这份报告能说明什么，不能说明什么",
    trustBody: "功能与简介是尚未人工核实的 AI 候选，依据为页面展示的源码窗口。分析成功不代表完整或正确，也不表示已经执行测试。",
    coverageNote: "源码输入覆盖率表示与产品理解相关的源码文件中，被装入分析分区的比例；结构化数据、CI 与锁文件不计入分母。它不是产品功能覆盖率、行为证据覆盖率、正确率或测试覆盖率，未覆盖的行为仍可能存在。",
    noScript: "搜索与筛选需要 JavaScript；禁用后仍可阅读完整报告。",
    ctaTitle: "想持续跟进代码仓库？",
    ctaBody: "从 GitHub 部署自己的 CoDelphi，持续跟进代码仓库的变化；也可以直接使用 CoDelphi.com，无需搭建环境。",
    ctaGithub: "GitHub 自托管",
    ctaCloud: "使用 CoDelphi.com",
    warningMessages: {
      working_tree_dirty: "工作区存在未提交或未跟踪修改，这些内容不在本次提交快照中。",
      partition_limit_reached: "分析已达到分区上限（{count}/{limit}），其他源码可能被遗漏。",
      extraction_retry: "提取过程中发生 {count} 次重试。",
      empty_pass: "{count} 个提取分区没有产出带证据场景。",
      evidence_dropped: "{count} 个场景因证据超出实际源码窗口而被移除。",
      all_candidates_rejected: "{count} 个分区的候选全部被清洗；这不代表对应行为不存在。",
      scenarios_deduplicated: "已合并 {count} 个行为等价的重复场景。",
      features_folded: "已按确定性身份规则合并 {count} 个功能变体。",
      evidence_budget_exceeded: "证据源码达到 {limit} 字节报告预算，部分片段未嵌入。",
      evidence_snippet_truncated: "部分证据超过单片段 {limit} 行上限，已明确标记为截断。",
      evidence_lines_unavailable: "部分引用行号不在实际装配源码窗口中。",
      product_description_unavailable: "产品简介没有保留下来的可追溯证据，因此显示为未知。",
      presentation_fallback: "智能项目地图、用户旅程或概念关系未生成或未通过证据校验，已降级为完整功能索引，不再暗示核心能力排序。",
    },
  },
};

export const REPORT_STYLES = String.raw`
:root{--ink:#172321;--muted:#5c6b66;--line:#dfe6e2;--paper:#f5f7f5;--surface:#fff;--green:#0f6b50;--green-light:#e4f2eb;--navy:#102c27;--amber:#80500f;--code:#f0f4f1}
*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--paper)}body{margin:0;color:var(--ink);background:var(--paper);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Noto Sans SC",sans-serif;line-height:1.65;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #2b9a73;outline-offset:3px}[hidden]{display:none!important}.top-anchor{position:absolute;top:0}.hero{background:var(--navy);color:#f4faf6;padding:48px 24px 42px}.hero-inner,.container{width:min(1120px,100%);margin:0 auto}.eyebrow{margin:0 0 12px;color:#9bdcbc;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}.hero h1{max-width:850px;margin:0;font-size:clamp(32px,5vw,54px);font-weight:650;line-height:1.12;letter-spacing:-.035em;overflow-wrap:anywhere}.hero-description{max-width:760px;margin:20px 0 0;color:#d4e5dc;font-size:17px;line-height:1.75;text-wrap:pretty}.meta{display:flex;flex-wrap:wrap;gap:10px 20px;margin-top:26px;color:#b8cec3;font-size:12px}.meta span{min-width:0;overflow-wrap:anywhere}.meta strong{color:#eef7f1;font-weight:600}.snapshot-nav{position:sticky;top:0;z-index:5;background:#fffffff2;border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.snapshot-nav .container{display:flex;gap:26px;overflow-x:auto;padding:0 24px}.snapshot-nav a{flex:0 0 auto;padding:15px 0 12px;color:var(--muted);font-size:13px;border-bottom:2px solid transparent}.snapshot-nav a:hover{color:var(--green);border-color:var(--green);text-decoration:none}.container{padding:0 24px}.controls{display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:16px;margin:30px 0}.control{display:grid;gap:7px}.control label{font-size:12px;font-weight:650}.control input,.control select{width:100%;min-height:44px;border:1px solid #cbd8d0;border-radius:8px;background:var(--surface);color:var(--ink);padding:10px 12px;font:inherit;font-size:14px}.report-section{margin:38px 0}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}.section-heading h2{margin:0;font-size:22px;letter-spacing:-.02em}.section-heading span{color:var(--muted);font-size:12px}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.summary-card,.feature-card,.evidence-card,.boundary-card{background:var(--surface);border:1px solid var(--line);border-radius:12px}.summary-card{padding:18px}.summary-card span{display:block;color:var(--muted);font-size:12px}.summary-card strong{display:block;margin-top:5px;color:var(--green);font-size:26px;font-weight:600}.summary-card small{color:var(--muted)}.notice-list{display:grid;gap:8px;margin:16px 0 0;padding:0;list-style:none}.notice-list li{padding:12px 14px;border:1px solid #e5d3a1;border-radius:8px;background:#faf3e2;color:#704b16;font-size:13px;overflow-wrap:anywhere}.feature-list,.evidence-list{display:grid;gap:16px}.feature-card{overflow:hidden}.feature-body>summary{cursor:pointer;list-style:none;position:relative}.feature-body>summary::-webkit-details-marker{display:none}.feature-body>summary::after{content:"+";position:absolute;top:26px;right:24px;color:var(--green);font-size:20px;line-height:1}.feature-body[open]>summary::after{content:"−"}.feature-header{padding:22px 24px}.feature-header h3{margin:0 0 7px;font-size:20px;overflow-wrap:anywhere}.feature-header p{margin:0;color:var(--muted);font-size:14px;text-wrap:pretty}.scenario{border-top:1px solid #edf1ee}.scenario summary{cursor:pointer;list-style:none;display:flex;align-items:flex-start;gap:10px;padding:17px 24px;font-size:14px}.scenario summary::-webkit-details-marker{display:none}.scenario summary::after{content:"+";margin-left:auto;color:var(--green);font-size:20px;line-height:1}.scenario[open] summary::after{content:"−"}.scenario-ref{flex:0 0 auto;color:var(--muted);font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}.category{flex:0 0 auto;padding:2px 7px;border-radius:5px;background:var(--green-light);color:var(--green);font-size:11px;font-weight:650}.scenario-body{display:grid;gap:14px;padding:0 24px 20px}.scenario-field{display:grid;grid-template-columns:76px minmax(0,1fr);gap:12px;font-size:14px}.scenario-field strong{color:var(--muted);font-size:12px}.scenario-field p{margin:0;text-wrap:pretty;overflow-wrap:anywhere}.evidence-links{display:flex;flex-wrap:wrap;gap:7px 12px;font-size:12px}.evidence-links a{color:var(--green);font-family:"SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.evidence-card{padding:20px 22px;scroll-margin-top:80px}.evidence-card h3{margin:0 0 7px;font-family:"SFMono-Regular",Consolas,monospace;font-size:13px;overflow-wrap:anywhere}.evidence-card p{margin:6px 0;color:var(--muted);font-size:12px}.evidence-card pre{max-width:100%;margin:14px 0 0;padding:14px 0;overflow:auto;border-radius:8px;background:var(--code);font:12px/1.65 "SFMono-Regular",Consolas,monospace}.code-line{display:grid;grid-template-columns:58px minmax(max-content,1fr);min-height:1.65em;padding-right:16px}.line-number{padding-right:14px;color:#6c7d75;text-align:right;user-select:none}.code-text{white-space:pre}.source-link{display:inline-flex;margin-top:12px;color:var(--green);font-size:12px}.boundary-card{padding:22px}.boundary-card h3{margin:0 0 10px;font-size:16px}.boundary-card p{margin:8px 0;color:var(--muted);font-size:13px;text-wrap:pretty}.empty-state{padding:28px;border:1px dashed #bdcec3;border-radius:10px;color:var(--muted);text-align:center}.noscript{padding:12px 24px;background:#faf3e2;color:#704b16;font-size:13px}.footer{display:flex;justify-content:space-between;gap:16px;margin:44px 0 28px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.footer a{color:var(--green)}
.hero-revision{margin:16px 0 0;color:#9fbdb0;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}.snapshot-details{margin-top:16px;color:#b8cec3;font-size:12px}.snapshot-details summary{cursor:pointer;display:inline-flex;color:#9bdcbc}.snapshot-details .meta{margin-top:14px}.capability-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.capability-card{min-height:160px;padding:24px;border:1px solid #c8d9cf;border-radius:12px;background:var(--surface)}.capability-card h3{margin:0 0 10px;color:var(--navy);font-size:21px;line-height:1.3;letter-spacing:-.02em;text-wrap:pretty}.capability-card p{margin:0 0 18px;color:var(--muted);font-size:14px;line-height:1.75;text-wrap:pretty}.capability-card a{color:var(--green);font-size:12px;font-weight:650}.journey-list{display:grid;gap:12px}.journey-card{display:grid;grid-template-columns:190px minmax(0,1fr);gap:22px;padding:20px 22px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.journey-capability{margin:0;color:var(--green);font-size:13px;font-weight:700}.journey-steps{display:grid;gap:14px}.journey-step{padding-left:16px;border-left:2px solid #b9d9c8}.journey-step h3{margin:0 0 5px;font-size:15px;font-weight:600;text-wrap:pretty}.journey-step p{margin:3px 0;color:var(--muted);font-size:12px;text-wrap:pretty}.evidence-drawer>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer;list-style:none;padding:18px 22px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--green);font-size:14px;font-weight:650}.evidence-drawer>summary::-webkit-details-marker{display:none}.evidence-drawer>summary::after{content:"+";font-size:20px}.evidence-drawer[open]>summary::after{content:"−"}.evidence-drawer .evidence-list{margin-top:16px}.boundary-notices{margin:24px 0}.feature-card{scroll-margin-top:80px}
.section-note{margin:-6px 0 16px;color:var(--muted);font-size:12px}.journey-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 18px}.journey-summary p{margin:0;padding:12px 14px;border-radius:8px;background:var(--green-light);font-size:13px}.journey-summary strong{display:block;margin-bottom:4px;color:var(--green);font-size:11px}.capability-card{min-height:0}.capability-features summary{display:inline-flex;align-items:center;min-height:32px;cursor:pointer;color:var(--green);font-size:12px;font-weight:650}.capability-features ul{display:grid;gap:6px;margin:14px 0 0;padding-left:20px}.capability-features li{font-size:12px;overflow-wrap:anywhere}.journey-card{display:block}.journey-card>h3{margin:0 0 16px;color:var(--navy);font-size:17px}.journey-steps{margin:0;padding-left:24px}.journey-step{margin:0 0 16px;padding-left:12px}.journey-step:last-child{margin-bottom:0}.journey-step h3{margin:0 0 5px}.journey-step a,.concept-card a,.code-area a{color:var(--green);font-size:12px;font-weight:650}.code-area-list,.concept-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0;padding:0;list-style:none}.code-area,.concept-card{padding:20px 22px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.code-area>code{display:block;margin-bottom:8px;color:var(--navy);font-size:14px;font-weight:650;overflow-wrap:anywhere}.code-area>p,.concept-card>p{margin:6px 0 12px;color:var(--muted);font-size:12px}.code-area-links{display:flex;flex-wrap:wrap;gap:6px 12px}.concept-card h3{margin:0 0 8px;font-size:17px}.concept-card ul{display:grid;gap:8px;margin:12px 0 0;padding-left:20px}.concept-card li{font-size:13px}.concept-card li strong{color:var(--green)}
.cta-card{padding:24px;margin:0 0 28px;border:1px solid #c8d9cf;border-radius:12px;background:var(--surface)}.cta-card h2{margin:0 0 10px;color:var(--navy);font-size:21px;line-height:1.3;letter-spacing:-.02em}.cta-card p{margin:0 0 18px;color:var(--muted);font-size:14px;line-height:1.75}.cta-actions{display:flex;flex-wrap:wrap;gap:12px}.cta-actions a{display:inline-flex;align-items:center;min-height:44px;padding:8px 16px;border-radius:8px;background:var(--green);color:#fff;font-size:13px;font-weight:650;text-decoration:none}.cta-actions a.secondary{background:var(--green-light);color:var(--green)}
@media(max-width:700px){.summary-grid{grid-template-columns:1fr}.controls{grid-template-columns:1fr}.hero{padding-top:36px}.feature-header,.evidence-card{padding:18px}.scenario summary,.scenario-body{padding-left:18px;padding-right:18px}.capability-grid,.code-area-list,.concept-list,.journey-summary{grid-template-columns:1fr}.journey-card{grid-template-columns:1fr;gap:12px}}
@media(max-width:480px){.container{padding:0 16px}.snapshot-nav .container{padding:0 16px}.hero{padding:30px 16px}.hero h1{font-size:31px}.hero-description{font-size:15px}.controls{margin-top:22px}.scenario-field{grid-template-columns:1fr;gap:3px}.scenario summary{flex-wrap:wrap}.scenario summary::after{margin-left:0}.footer{display:grid}.code-line{grid-template-columns:44px minmax(max-content,1fr)}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
@media print{.snapshot-nav,.controls,.back-to-top{display:none}.hero{background:#fff;color:var(--ink);padding:20px 0}.hero-description,.meta,.meta strong{color:var(--ink)}.container{padding:0}.report-section{break-inside:avoid}.scenario>*,.evidence-card pre{display:block}.feature-card,.evidence-card,.boundary-card{break-inside:avoid}}
`;

export const REPORT_SCRIPT = String.raw`
(function(){
  var input=document.getElementById("snapshot-search");
  var category=document.getElementById("snapshot-category");
  var features=Array.prototype.slice.call(document.querySelectorAll("[data-feature]"));
  var empty=document.getElementById("snapshot-no-results");
  function applyFilters(){
    var query=(input&&input.value?input.value:"").trim().toLowerCase();
    var selected=category?category.value:"all";
    var filtering=query.length>0||selected!=="all";
    var visibleFeatures=0;
    features.forEach(function(feature){
      var featureText=feature.getAttribute("data-feature-search")||"";
      var featureMatches=!query||featureText.indexOf(query)>=0;
      var visibleScenarios=0;
      feature.querySelectorAll("[data-scenario]").forEach(function(scenario){
        var scenarioText=scenario.getAttribute("data-search")||"";
        var categoryMatches=selected==="all"||scenario.getAttribute("data-category")===selected;
        var queryMatches=featureMatches||scenarioText.indexOf(query)>=0;
        var visible=categoryMatches&&queryMatches;
        scenario.hidden=!visible;
        if(visible) visibleScenarios+=1;
      });
      feature.hidden=visibleScenarios===0;
      // 搜索/筛选时自动展开命中功能的折叠体；清除筛选后不强制收起（保留用户手动状态）。
      if(filtering) feature.querySelectorAll("details.feature-body").forEach(function(body){ body.open=visibleScenarios>0; });
      if(visibleScenarios>0) visibleFeatures+=1;
    });
    if(empty) empty.hidden=visibleFeatures!==0;
  }
  if(input) input.addEventListener("input",applyFilters);
  if(category) category.addEventListener("change",applyFilters);
  function revealAnchor(hash){
    var target=hash&&document.getElementById(hash.slice(1));
    var container=target&&target.parentElement;
    while(container){
      if(container.tagName==="DETAILS") container.open=true;
      container=container.parentElement;
    }
  }
  document.addEventListener("click",function(event){
    var link=event.target&&event.target.closest?event.target.closest('a[href^="#"]'):null;
    if(link) revealAnchor(link.getAttribute("href"));
  });
  if(location.hash) revealAnchor(location.hash);
})();
`;
