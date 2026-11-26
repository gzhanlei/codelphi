import { describe, expect, it } from "vitest";
import { planFeatureMerges, workbenchFeatures, type PlannableFeature } from "../scripts/merge-variant-features";

/**
 * BM-11 存量清理规划器（纯函数，restore-collapsed-scenarios 模式：判定与执行分离）。
 * fixtures 取生产实锤：无壳/无外壳语言切换（13310/13311）、支付面板 ×4（release 220）。
 */

const scenario = (id: number, reference: string, outcome: string, overrides: Partial<PlannableFeature["scenarios"][number]> = {}) => ({
  id,
  reference,
  context: "用户打开登录页",
  action: "渲染语言切换器",
  outcome,
  category: "happy",
  source: "generated",
  evidence: [] as Array<{ path: string; startLine?: number }>,
  ...overrides,
});

const shellLessPair: PlannableFeature[] = [
  {
    id: 100,
    name: "无壳页面语言切换",
    summary: "登录、403、条款与数据说明等独立页面在页面内提供界面语言切换器。",
    source: "generated",
    scenarios: [scenario(1, "HP-9", "auth-panel 头部显示语言切换器，按服务端解析的 locale 渲染")],
  },
  {
    id: 13311,
    name: "无外壳页面语言切换",
    summary: "登录、403、条款与数据说明页在各自标题区挂载语言切换器。",
    source: "generated",
    scenarios: [
      scenario(2, "HP-1", "面板右上角显示语言切换器，locale 为服务端解析值"),
      scenario(3, "HP-2", "面板右上角显示语言切换器，locale 为服务端解析值"),
    ],
  },
];

describe("planFeatureMerges (BM-11 存量清理规划器)", () => {
  it("plans merging a rename variant into the keeper with scenario moves", () => {
    const plans = planFeatureMerges(shellLessPair);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ keeperId: 100, keeperName: "无壳页面语言切换", variantId: 13311, variantName: "无外壳页面语言切换" });
    // 两条变体场景都与 keeper 行为重复 → 全部删除，不搬
    expect(plans[0].moves.every((move) => move.drop)).toBe(true);
  });

  it("renumbers colliding references when moving non-duplicate scenarios into the keeper", () => {
    const features: PlannableFeature[] = [
      {
        id: 1,
        name: "管理端支付台账",
        summary: "超管支付操作面板：创建测试单并展示支付入口，列出订单台账并支持退款。",
        source: "generated",
        scenarios: [
          scenario(1, "HP-1", "创建测试单并展示扫码支付入口"),
          scenario(2, "HP-2", "提交退款请求，退款态由服务端推进"),
          scenario(3, "HP-5", "台账表头渲染", { context: "超管打开台账", action: "渲染表格" }),
        ],
      },
      {
        id: 2,
        name: "管理端支付订单台账",
        summary: "超管支付页的订单台账面板：创建测试单并展示支付入口，列出订单台账并支持退款。",
        source: "generated",
        scenarios: [
          scenario(4, "HP-1", "创建测试单并展示扫码支付入口"),
          scenario(5, "HP-2", "提交退款请求，退款态由服务端推进"),
          scenario(6, "HP-5", "新增的导出行为", { context: "超管打开台账", action: "点击导出" }),
        ],
      },
    ];
    const plans = planFeatureMerges(features);
    expect(plans).toHaveLength(1);
    const moves = plans[0].moves;
    // 与 keeper 行为相同的 HP-1/HP-2 删除；新行为 HP-5 搬入，引用与 keeper 的 HP-5 冲突 → 重编号 HP-6
    expect(moves.find((move) => move.scenarioId === 4)).toMatchObject({ drop: true });
    expect(moves.find((move) => move.scenarioId === 5)).toMatchObject({ drop: true });
    expect(moves.find((move) => move.scenarioId === 6)).toMatchObject({ drop: false, newReference: "HP-6" });
  });

  it("renumbers around references held by inactive rows (the unique key counts them)", () => {
    // 生产实锤（2026-11-26，codelphi #8）：keeper 22800 下有一条已下线的 EC-2，把 EC-1 重编号成 EC-2 搬入时撞了
    // scenarios_feature_reference_unique，整个事务回滚。已下线的行不在 scenarios 里，但引用仍被占用。
    const summary = "工作台里编辑功能与场景：改名、改摘要、增删场景，保存后进入下一版。";
    const features: PlannableFeature[] = [
      // keeper 下活跃的只有 EC-1；EC-2 是一条已下线的行，读活跃行时看不到它
      { id: 22800, name: "规格编辑（功能与场景）", summary, source: "generated", scenarios: [scenario(1, "EC-1", "打开编辑器", { evidence: [{ path: "lib/spec-editor-service.ts" }] })], occupiedReferences: ["EC-2"] },
      {
        id: 22801,
        name: "规格编辑器功能与场景接口",
        summary,
        source: "generated",
        scenarios: [
          scenario(2, "EC-1", "打开编辑器", { evidence: [{ path: "lib/spec-editor-service.ts" }] }),
          scenario(3, "EC-2", "新增的导入行为", { context: "编辑器里点导入", action: "上传文件", evidence: [{ path: "lib/spec-editor-service.ts" }] }),
        ],
      },
    ];
    const plans = planFeatureMerges(features);
    expect(plans).toHaveLength(1);
    expect(plans[0].moves.find((move) => move.scenarioId === 2)).toMatchObject({ drop: true });
    // EC-1 与 keeper 重复、删掉；EC-2 是新行为、搬入，但 EC-2 已被下线的行占着 → 重编号 EC-3
    expect(plans[0].moves.find((move) => move.scenarioId === 3)).toMatchObject({ drop: false, newReference: "EC-3" });
  });

  it("never folds manual features as source or target (AGENTS.md 红线)", () => {
    const features: PlannableFeature[] = [
      { id: 1, name: "无壳页面语言切换", summary: "手工维护", source: "manual", scenarios: [scenario(1, "HP-1", "手工维护的语言切换说明")] },
      { id: 2, name: "无外壳页面语言切换", summary: "登录、403、条款与数据说明页在各自标题区挂载语言切换器。", source: "generated", scenarios: [scenario(2, "HP-1", "手工维护的语言切换说明")] },
    ];
    expect(planFeatureMerges(features)).toEqual([]);
  });

  it("keeps verified scenarios alive: moves them instead of dropping on duplicates", () => {
    const features: PlannableFeature[] = [
      { id: 1, name: "无壳页面语言切换", summary: "登录、403、条款与数据说明等独立页面在页面内提供界面语言切换器。", source: "generated", scenarios: [scenario(1, "HP-9", "auth-panel 头部显示语言切换器，按服务端解析的 locale 渲染")] },
      { id: 2, name: "无外壳页面语言切换", summary: "登录、403、条款与数据说明页在各自标题区挂载语言切换器。", source: "generated", scenarios: [scenario(2, "HP-1", "auth-panel 头部显示语言切换器，按服务端解析的 locale 渲染", { verified: true })] },
    ];
    const plans = planFeatureMerges(features);
    expect(plans).toHaveLength(1);
    const move = plans[0].moves[0];
    expect(move.drop).toBe(false);
    // 引用 HP-1 与 keeper 的 HP-9 无冲突 → 原引用搬入
    expect(move.newReference).toBeNull();
  });

  it("returns no plans for genuinely distinct features", () => {
    const features: PlannableFeature[] = [
      { id: 1, name: "管理端支付台账", summary: "超管支付操作面板：创建测试单并展示支付入口，列出订单台账并支持退款。", source: "generated", scenarios: [scenario(1, "HP-1", "创建测试单并展示扫码支付入口")] },
      { id: 2, name: "管理端退款流水", summary: "超管退款流水视图：按订单维度记录退款请求与退款态。", source: "generated", scenarios: [scenario(2, "HP-1", "按订单维度展示退款请求与退款态")] },
    ];
    expect(planFeatureMerges(features)).toEqual([]);
  });
});

describe("planFeatureMerges 双信号离线输入（T2 根治：asSpecScenario 不再清空 evidence）", () => {
  // 名字差太远过不了名门禁（release 226 形态），但共享证据文件 + summary 高度近似——
  // 修复前 offline evidence=[] 恒不可达双信号；修复后 DB 真实证据进入判定。
  const sharedPath = { path: "lib/billing/manual-grant.ts", startLine: 42 };
  const grantVariants: PlannableFeature[] = [
    {
      id: 1,
      name: "运营手工充值",
      summary: "运营按邮箱给用户个人工作区的 Trial 钱包发放额度，流水与钱包同事务。",
      source: "generated",
      scenarios: [scenario(1, "HP-1", "定位个人工作区与 Trial 钱包，写 granted 流水并更新余额", { evidence: [sharedPath] })],
    },
    {
      id: 2,
      name: "手动配额发放",
      summary: "管理员按邮箱给用户个人工作区的 Trial 钱包发放额度，事务内写钱包流水并更新余额。",
      source: "generated",
      scenarios: [scenario(2, "HP-2", "定位个人工作区与 Trial 钱包，写 granted 流水并更新余额", { evidence: [sharedPath] })],
    },
  ];

  it("folds summary near-pairs via the evidence+summary dual signal when real evidence is present", () => {
    const plans = planFeatureMerges(grantVariants);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ keeperId: 1, variantId: 2 });
  });

  it("does not fold when summaries diverge beyond the dual-signal floor even with shared evidence", () => {
    const divergent: PlannableFeature[] = [
      { ...grantVariants[0] },
      { ...grantVariants[1], summary: "导出矩阵按产品维度生成 CSV 附件并投递到订阅邮箱，缓存命中零渲染调用。" },
    ];
    expect(planFeatureMerges(divergent)).toHaveLength(0);
  });
});

describe("workbenchFeatures (工作台行模型：已下线的行只占引用)", () => {
  it("keeps active rows as scenarios and inactive rows as occupied references", () => {
    const model = workbenchFeatures(
      [{ id: 7, name: "规格编辑（功能与场景）", summary: "工作台里编辑功能与场景。", source: "generated" }],
      [
        { id: 101, featureId: 7, reference: "EC-1", context: "打开", action: "编辑", outcome: "保存", category: "happy", source: "generated", evidence: [], active: 1 },
        { id: 102, featureId: 7, reference: "EC-2", context: "旧", action: "旧", outcome: "旧", category: "happy", source: "generated", evidence: [], active: 0 },
      ],
    );
    expect(model[0].scenarios.map((scenario) => scenario.id)).toEqual([101]);
    expect(model[0].occupiedReferences).toEqual(["EC-2"]);
  });
});
