import { describe, expect, it } from "vitest";
import { changeDescriptionVariantSimilar, featureVariantSimilar, type SpecFeature, type SpecScenario } from "../lib/spec-diff";

/**
 * BM-11 功能级变体通道：dogfood 账本实锤的变体形态作为 fixtures。
 * 生产实锤：①「无壳页面语言切换」(13310, f7b2d60 波) ↔「无外壳页面语言切换」(13311,
 * 38d3c7e 波) 跨 run 改名并存；②release 220 同一 admin-pay-orders.tsx 面板单 run 内
 * 「管理端支付台账/管理端支付订单台账/超管支付台账面板/超管支付订单台账」×4 标新增。
 * 判定口径宁漏勿错合——名近但行为不同的真功能必须全部拒绝。
 */

const shellLessSwitcher: [SpecFeature, SpecFeature] = [
  {
    name: "无壳页面语言切换",
    summary: "登录、403、条款与数据说明等独立页面在页面内提供界面语言切换器，语言由服务端解析并随切换刷新当前页。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "用户打开登录页且未登录", action: "在 auth-panel 头部点击语言切换器中的另一语言", outcome: "写入语言 cookie 后刷新当前页，登录页文案按新语言渲染", evidence: [{ path: "components/language-switcher.tsx" }] },
      { reference: "HP-9", category: "happy", context: "用户打开登录页", action: "LoginPage 渲染 auth-panel", outcome: "auth-panel 头部显示语言切换器，按服务端解析的 locale 渲染", evidence: [{ path: "components/language-switcher.tsx" }] },
      { reference: "HP-12", category: "happy", context: "用户打开条款页", action: "TermsPage 渲染标题区", outcome: "标题区右侧显示语言切换器", evidence: [{ path: "components/language-switcher.tsx" }] },
      { reference: "HP-13", category: "happy", context: "用户打开数据说明页", action: "DataNoticePage 渲染页眉行", outcome: "DATA NOTICE 标签右侧显示语言切换器", evidence: [{ path: "components/language-switcher.tsx" }] },
    ],
  },
  {
    name: "无外壳页面语言切换",
    summary: "登录、403、条款与数据说明页在各自标题区挂载语言切换器，locale 由服务端解析后传入，使无外壳页面也能切换界面语言。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "用户打开登录页", action: "渲染认证面板头部", outcome: "面板右上角显示语言切换器，locale 为服务端解析值", evidence: [{ path: "app/login/page.tsx" }] },
      { reference: "HP-2", category: "happy", context: "用户打开 403 页", action: "渲染页面顶部", outcome: "页面顶部右侧显示语言切换器", evidence: [{ path: "app/forbidden/page.tsx" }] },
      { reference: "HP-3", category: "happy", context: "用户打开条款页", action: "渲染页面标题区", outcome: "标题区右侧显示语言切换器", evidence: [{ path: "app/terms/page.tsx" }] },
      { reference: "HP-4", category: "happy", context: "用户打开数据说明页", action: "渲染页眉行", outcome: "DATA NOTICE 标签右侧显示语言切换器", evidence: [{ path: "app/data-notice/page.tsx" }] },
    ],
  },
];

const payLedgerVariants: [SpecFeature, SpecFeature] = [
  {
    name: "管理端支付台账",
    summary: "超管支付操作面板：创建 0.01 元联调测试单并展示支付入口，列出最近 20 笔订单台账并对可退订单发起退款。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "超管需要验证支付链路", action: "点击创建 0.01 元测试单", outcome: "创建测试单并展示二维码/H5/支付宝支付入口", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "HP-2", category: "happy", context: "订单台账中存在已支付且未退款的订单", action: "点击该行退款按钮", outcome: "提交退款请求，退款态由服务端推进", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "EC-1", category: "edge", context: "订单台账为空", action: "渲染订单表格", outcome: "表格显示空态文案", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
    ],
  },
  {
    name: "管理端支付订单台账",
    summary: "超管支付页的联调测试单与订单台账面板：创建测试单并展示支付入口，列出订单台账并支持发起退款。",
    scenarios: [
      { reference: "HP-3", category: "happy", context: "超管需要验证支付链路", action: "点击创建 0.01 元测试单", outcome: "展示微信支付二维码、H5 收银台与支付宝跳转链接", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "HP-4", category: "happy", context: "台账中存在可退款订单", action: "点击退款按钮", outcome: "提交退款请求，按钮显示提交中", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "EC-1", category: "edge", context: "台账无任何订单", action: "渲染订单表格", outcome: "显示空订单提示行", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
    ],
  },
];

const sameNameDifferentBehavior: [SpecFeature, SpecFeature] = [
  {
    name: "管理端支付台账",
    summary: "超管支付操作面板：创建测试单并展示支付入口，列出订单台账并发起退款。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "超管需要验证支付链路", action: "点击创建测试单", outcome: "创建测试单并展示支付入口", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
    ],
  },
  {
    name: "管理端支付退款台账",
    summary: "超管退款操作流水：按订单维度记录退款请求、退款态与退款时间，支持按状态筛选。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "超管查看退款流水", action: "打开退款台账页", outcome: "按订单维度展示退款请求与退款态", evidence: [{ path: "app/admin/refunds/page.tsx" }] },
    ],
  },
];

const crossLanguageFeature: [SpecFeature, SpecFeature] = [
  {
    name: "无壳页面语言切换",
    summary: "登录、403、条款与数据说明等独立页面在页面内提供界面语言切换器。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "用户打开登录页", action: "渲染认证面板头部", outcome: "面板右上角显示语言切换器", evidence: [{ path: "components/language-switcher.tsx" }] },
      { reference: "HP-2", category: "happy", context: "用户打开条款页", action: "渲染页面标题区", outcome: "标题区右侧显示语言切换器", evidence: [{ path: "components/language-switcher.tsx" }] },
    ],
  },
  {
    name: "Shell-less page language switcher",
    summary: "Shell-less pages (login, 403, terms, data notice) provide an in-page UI language switcher resolved server-side.",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "User opens the login page", action: "Render the auth panel header", outcome: "Language switcher shown at the panel's top-right corner", evidence: [{ path: "app/login/page.tsx" }] },
      { reference: "HP-2", category: "happy", context: "User opens the terms page", action: "Render the page heading area", outcome: "Language switcher shown right of the heading", evidence: [{ path: "app/terms/page.tsx" }] },
    ],
  },
];

/** 名近、身近，但行为不同（台账↔退款流水）——场景门禁必须拒绝。 */
const nameAndIdentityCloseButBehaviorDiffers: [SpecFeature, SpecFeature] = [
  {
    name: "管理端支付台账",
    summary: "超管支付操作面板：创建测试单并展示支付入口，列出订单台账并发起退款。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "超管需要验证支付链路", action: "点击创建测试单", outcome: "创建测试单并展示支付入口", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "HP-2", category: "happy", context: "台账中存在可退款订单", action: "点击退款按钮", outcome: "提交退款请求", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
    ],
  },
  {
    name: "管理端支付退款台账",
    summary: "超管支付台账的退款流水视图：按订单维度记录退款请求、退款态与退款时间。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "超管查看退款流水", action: "打开退款台账页", outcome: "按订单维度展示退款请求与退款态", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      { reference: "HP-2", category: "happy", context: "退款态更新", action: "刷新退款流水", outcome: "退款时间与退款态同步刷新", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
    ],
  },
];

const emptyScenarios: [SpecFeature, SpecFeature] = [
  { name: "无壳页面语言切换", summary: "登录等独立页面提供语言切换器。", scenarios: [] },
  { name: "无外壳页面语言切换", summary: "登录等独立页面挂载语言切换器。", scenarios: [] },
];

/** 名近、证据同文件，但 outcome 语义翻转（重试可用性相反）——否定守护必须拒绝。 */
const outcomeNegationFlip: [SpecFeature, SpecFeature] = [
  {
    name: "配额重试",
    summary: "配额不足时的重试交互。",
    scenarios: [
      { reference: "EC-1", category: "edge", context: "配额不足", action: "点击重试", outcome: "提示可以重试", evidence: [{ path: "components/quota.tsx" }] },
      { reference: "HP-1", category: "happy", context: "配额恢复", action: "继续操作", outcome: "操作正常提交", evidence: [{ path: "components/quota.tsx" }] },
    ],
  },
  {
    name: "配额重试提示",
    summary: "配额不足时的重试提示交互。",
    scenarios: [
      { reference: "EC-2", category: "edge", context: "配额不足", action: "点击重试", outcome: "提示不可以重试", evidence: [{ path: "components/quota.tsx" }] },
      { reference: "EC-3", category: "edge", context: "配额耗尽", action: "点击重试", outcome: "提示配额已用尽，需升级套餐", evidence: [{ path: "components/quota.tsx" }] },
    ],
  },
];

const cleanupScriptVariants: [SpecFeature, SpecFeature] = [
  {
    name: "changes 表存量变体清理脚本",
    summary: "按仓库（可选指定发布）读取 changes 行，以 changeDescriptionVariantSimilar 在同 release 同 featureKey+kind 分组内贪心去重，keeper 取 id 最小先落库者；默认 dry-run 打印保留与删除提案，--apply 才在事务内删除变体行。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "清理历史 changes 表中的措辞变体行", action: "运行 dedupe-release-changes 脚本", outcome: "dry-run 打印每组保留行与待删除变体行提案，不改动数据", evidence: [{ path: "scripts/dedupe-release-changes.ts" }] },
      { reference: "HP-2", category: "happy", context: "人工审阅 dry-run 提案后确认执行", action: "追加 --apply 重新运行脚本", outcome: "事务内删除各组变体行并提交，keeper 为 id 最小的先落库行", evidence: [{ path: "scripts/dedupe-release-changes.ts" }] },
      { reference: "EC-1", category: "edge", context: "两条变化行属于不同功能或不同类型", action: "planChangesDedupe 执行", outcome: "不跨 feature 或 kind 边界比较，返回空计划", evidence: [{ path: "scripts/dedupe-release-changes.ts" }] },
    ],
  },
  {
    name: "发布变化存量去重脚本",
    summary: "按仓库与可选发布读取 changes 表行，以同一变体判定口径在同发布同功能同类型内规划去重（keeper 取 id 最小先落库者），默认 dry-run 打印提案，--apply 才在事务内删除变体行。",
    scenarios: [
      { reference: "HP-1", category: "happy", context: "某发布同一功能同一类型下存在多条措辞变体的变化行", action: "运行存量去重脚本", outcome: "输出合并计划，keepId 为 id 最小的行，其余 id 进入 dropIds", evidence: [{ path: "scripts/dedupe-release-changes.ts" }, { path: "tests/dedupe-release-changes.test.ts" }] },
      { reference: "HP-2", category: "happy", context: "已人工审阅 dry-run 提案", action: "以 --apply 运行脚本", outcome: "事务内删除各组变体行并提交，打印删除条数", evidence: [{ path: "scripts/dedupe-release-changes.ts" }] },
      { reference: "EC-1", category: "edge", context: "未加 --apply 运行脚本", action: "main 执行", outcome: "只打印提案与 dry-run 提示，不改动数据", evidence: [{ path: "scripts/dedupe-release-changes.ts" }] },
    ],
  },
];

describe("featureVariantSimilar (BM-11 功能级变体通道)", () => {
  it("folds the real shell-less switcher rename pair (13310 ↔ 13311)", () => {
    expect(featureVariantSimilar(...shellLessSwitcher)).toBe(true);
  });

  it("folds the real pay-ledger variant pair (release 220 ×4)", () => {
    expect(featureVariantSimilar(...payLedgerVariants)).toBe(true);
  });

  it("rejects same-name-family features with different behaviors", () => {
    expect(featureVariantSimilar(...sameNameDifferentBehavior)).toBe(false);
    expect(featureVariantSimilar(...nameAndIdentityCloseButBehaviorDiffers)).toBe(false);
  });

  it("rejects cross-language feature pairs", () => {
    expect(featureVariantSimilar(...crossLanguageFeature)).toBe(false);
  });

  it("rejects features without scenarios (no behavior to compare)", () => {
    expect(featureVariantSimilar(...emptyScenarios)).toBe(false);
  });

  it("rejects outcome negation flips (可以重试 ↔ 不可以重试)", () => {
    expect(featureVariantSimilar(...outcomeNegationFlip)).toBe(false);
  });

  it("folds differently-named features sharing one evidence file with matching scenarios (release 226 ×5 pattern)", () => {
    expect(featureVariantSimilar(...cleanupScriptVariants)).toBe(true);
  });

  it("still rejects same evidence file but genuinely different scenario sets", () => {
    const differentBehavior: [SpecFeature, SpecFeature] = [
      { name: "管理端支付台账", summary: "超管支付操作面板", scenarios: [
        { reference: "HP-1", category: "happy", context: "超管需要验证支付链路", action: "点击创建测试单", outcome: "创建测试单并展示支付入口", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
        { reference: "HP-2", category: "happy", context: "台账中存在可退款订单", action: "点击退款按钮", outcome: "提交退款请求", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      ] },
      { name: "管理端退款流水", summary: "超管退款流水视图", scenarios: [
        { reference: "HP-1", category: "happy", context: "超管查看退款流水", action: "打开退款台账页", outcome: "按订单维度展示退款请求与退款态", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
        { reference: "HP-2", category: "happy", context: "退款态更新", action: "刷新退款流水", outcome: "退款时间与退款态同步刷新", evidence: [{ path: "components/admin-pay-orders.tsx" }] },
      ] },
    ];
    expect(featureVariantSimilar(...differentBehavior)).toBe(false);
  });
});

describe("changeDescriptionVariantSimilar (BM-11 changes 去重)", () => {
  const variants = [
    "mergeIntegrity 维度新增 featuresFolded 字段，折叠数大于 0 时该维度记为 partial；deriveMergeIntegrity 入参新增 featuresFolded。",
    "合并完整性维度新增 featuresFolded 计数，大于 0 时该维度记为 partial。",
    "MergeIntegrityDimension 新增 featuresFolded 字段，deriveMergeIntegrity 在 featuresFolded>0 时把合并完整性记为 partial。",
    "合并完整性维度新增 featuresFolded 字段，功能级变体被折叠时该维度记为 partial 并如实披露折叠数量。",
  ];
  it("folds the real release-225 wording variants of the same change", () => {
    for (let index = 1; index < variants.length; index += 1) {
      expect(changeDescriptionVariantSimilar(variants[0], variants[index])).toBe(true);
    }
  });

  it("rejects genuinely different change items and traps", () => {
    expect(changeDescriptionVariantSimilar(variants[0], "新增 scripts/merge-variant-features.ts 存量清理脚本")).toBe(false);
    // 数字签名冲突：不同阈值/计数的变更不得互折
    expect(changeDescriptionVariantSimilar("错误响应携带 404 错误码", "错误响应携带 400 错误码")).toBe(false);
    // 跨语种拒绝
    expect(changeDescriptionVariantSimilar("合并完整性维度记为 partial", "Merge integrity marked as partial")).toBe(false);
  });
});
