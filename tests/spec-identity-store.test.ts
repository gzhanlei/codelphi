import { describe, expect, it, vi } from "vitest";
import type { Execute } from "../lib/db";
import { planVersionIdentities, restoredFeatures, restoredScenarios, emptyIdentityMaps, foldRegistry, toVersionIdentities, type VersionIdentities } from "../lib/spec-identity";
import { ASSIGN_CHUNK_SIZE, assignVersionIdentities, bulkAssignSql, loadIdentityRegistry, loadIdentitySources, loadVersionIdentityMaps, loadVersionIdentities, recordIdentityPlan } from "../lib/spec-identity-store";

type Call = [string, Array<string | number | null>];

/**
 * 按语句里的表名回数据的假库。没提到的语句返回 [{}]，和生产测试里的 mock 一致。
 * 这里没有真数据库来报错，所以每条语句发出时当场核对一件事：占位符的个数等于参数的个数。
 * 拼语句时列清单和占位符各算各的，就会对不上，到真数据库上是一条“列数与值数不一致”。
 */
function fakeDb(answer: (sql: string) => unknown = () => [{}]) {
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null> = []) => {
    expect(parameters, sql).toHaveLength((sql.match(/\?/g) ?? []).length);
    return answer(sql);
  });
  const calls = (): Call[] => execute.mock.calls.map(([sql, parameters]) => [sql, parameters ?? []]);
  return { execute: execute as unknown as Execute, calls };
}

describe("fakeDb 自己", () => {
  it("catches a statement whose placeholders and parameters disagree", async () => {
    const db = fakeDb();
    await expect(db.execute("INSERT INTO t (a, b) VALUES (?, ?)", [1])).rejects.toThrow();
  });
});

describe("loadIdentityRegistry", () => {
  it("maps every name key to its identity and groups scenario identities by feature identity", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM feature_identities")) return [[{ nameKey: "统一登录", identity_key: "统一登录" }, { nameKey: "支付", identity_key: "支付" }]];
      if (sql.includes("FROM scenario_identities")) {
        return [[{ featureIdentityKey: "统一登录", reference: "HP-1", identity_key: '["统一登录","HP-1"]' }, { featureIdentityKey: "支付", reference: "EC-2", identity_key: '["支付","EC-2"]' }]];
      }
      return [{}];
    });

    const registry = await loadIdentityRegistry(4, db.execute);

    expect([...registry.features]).toEqual([["统一登录", "统一登录"], ["支付", "支付"]]);
    expect(registry.scenarios.get("统一登录")).toEqual(new Map([["HP-1", '["统一登录","HP-1"]']]));
    expect(registry.scenarios.get("支付")).toEqual(new Map([["EC-2", '["支付","EC-2"]']]));
    expect(db.calls().every(([, parameters]) => parameters[0] === 4)).toBe(true);
  });

  it("returns empty maps when nothing has been written yet", async () => {
    expect(await loadIdentityRegistry(4, fakeDb().execute)).toEqual({ features: new Map(), scenarios: new Map() });
  });

  it("ignores rows that carry no identity instead of storing garbage", async () => {
    const db = fakeDb(() => [[{ nameKey: "统一登录", identity_key: "统一登录" }, { nameKey: "支付", identity_key: null }, {}, { identity_key: "没有名称键" }]]);
    expect([...(await loadIdentityRegistry(4, db.execute)).features]).toEqual([["统一登录", "统一登录"]]);
  });
});

  it("skips a scenario row in which any of its three parts is missing", async () => {
    const db = fakeDb((sql) => (sql.includes("FROM scenario_identities")
      ? [[{ featureIdentityKey: "统一登录", reference: null, identity_key: "x" }, { featureIdentityKey: null, reference: "HP-1", identity_key: "x" }, { featureIdentityKey: "统一登录", reference: "HP-1", identity_key: '["统一登录","HP-1"]' }]]
      : [{}]));
    expect((await loadIdentityRegistry(4, db.execute)).scenarios).toEqual(new Map([["统一登录", new Map([["HP-1", '["统一登录","HP-1"]']])]]));
  });

describe("loadVersionIdentities", () => {
  it("reads the identities a version already has, keyed by name key and by feature identity", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("identity_key FROM spec_features WHERE spec_version_id")) return [[{ versionId: 11, nameKey: "统一登录", identity_key: "统一登录" }]];
      if (sql.includes("FROM spec_scenarios ss")) return [[{ versionId: 11, featureIdentityKey: "统一登录", reference: "HP-1", identity_key: '["统一登录","HP-1"]' }]];
      return [{}];
    });

    expect(await loadVersionIdentities(11, db.execute)).toEqual({
      features: new Map([["统一登录", "统一登录"]]),
      scenarios: new Map([["统一登录", new Map([["HP-1", '["统一登录","HP-1"]']])]]),
    });
    expect(db.calls().map(([, parameters]) => parameters)).toEqual([[11], [11]]);
  });

  it("treats a version that was written before the identity layer as having no identities", async () => {
    // 回填之前身份列全是空的。这时不能按名称去猜，映射就是空的，由写入路径按规则新建。
    const db = fakeDb(() => [[{ nameKey: "统一登录", identity_key: null }, { featureIdentityKey: null, reference: "HP-1", identity_key: null }]]);
    expect(await loadVersionIdentities(11, db.execute)).toEqual({ features: new Map(), scenarios: new Map() });
  });

  it("lets a feature that has an identity keep it when a sibling row does not", async () => {
    const db = fakeDb((sql) => (sql.includes("identity_key FROM spec_features WHERE spec_version_id") ? [[{ versionId: 11, nameKey: "a", identity_key: "a" }, { versionId: 11, nameKey: "b", identity_key: null }]] : [{}]));
    expect([...(await loadVersionIdentities(11, db.execute)).features]).toEqual([["a", "a"]]);
  });
});

describe("bulkAssignSql", () => {
  it("builds one update that joins the rows to assign by their primary key", () => {
    const built = bulkAssignSql("spec_features", ["identity_key", "parent_identity_key"], [
      { id: 10, values: ["统一登录", null] },
      { id: 11, values: ["支付", "统一登录"] },
    ]);
    expect(built?.sql.replace(/\s+/g, " ")).toBe(
      "UPDATE `spec_features` AS t JOIN (SELECT CAST(? AS UNSIGNED) AS id, CAST(? AS CHAR) AS identity_key, CAST(? AS CHAR) AS parent_identity_key UNION ALL SELECT ?, ?, ?) AS src ON src.id = t.id " +
        "SET t.identity_key = src.identity_key, t.parent_identity_key = src.parent_identity_key",
    );
    expect(built?.params).toEqual([10, "统一登录", null, 11, "支付", "统一登录"]);
  });

  it("builds a single-column statement with the same shape", () => {
    expect(bulkAssignSql("spec_scenarios", ["identity_key"], [{ id: 500, values: ["x"] }])?.sql.replace(/\s+/g, " ")).toBe(
      "UPDATE `spec_scenarios` AS t JOIN (SELECT CAST(? AS UNSIGNED) AS id, CAST(? AS CHAR) AS identity_key) AS src ON src.id = t.id SET t.identity_key = src.identity_key",
    );
  });

  it("returns nothing when there is nothing to assign", () => {
    expect(bulkAssignSql("spec_scenarios", ["identity_key"], [])).toBeNull();
  });
});

describe("recordIdentityPlan", () => {
  const [first, second] = (() => {
    const a = planVersionIdentities({ features: [{ name: "统一登录", references: ["HP-1"] }, { name: "支付", references: [] }], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() });
    const b = planVersionIdentities({ features: [{ name: "统一登录", references: ["HP-2"] }], previous: toVersionIdentities(a), registry: foldRegistry(emptyIdentityMaps(), a) });
    return [a, b];
  })();

  it("inserts the identities that were minted, and for one already registered only moves its first version earlier", async () => {
    const db = fakeDb();
    await recordIdentityPlan(4, 99, first, db.execute);

    const featureInsert = db.calls().find(([sql]) => sql.includes("INSERT INTO feature_identities"));
    // 同一个身份已经登记过时（重复运行，同一产品下别的仓库先写下它，或者部署之后、回填之前发布过）这一行不重建。
    // 只把“首次出现的版本”往更早修：登记表里记下的那次发布，可能晚于它真正第一次出现的版本。
    expect(featureInsert?.[0]).toContain("ON DUPLICATE KEY UPDATE first_spec_version_id = LEAST(first_spec_version_id, VALUES(first_spec_version_id))");
    // 其余几列不被改写。也不用 INSERT IGNORE：那会把别的错误也降成警告吞掉。
    expect(featureInsert?.[0]).not.toContain("IGNORE");
    expect(featureInsert?.[0]).not.toMatch(/UPDATE (?:identity_key|first_name|feature_identity_key|reference) =/);
    // 列清单和占位符要对得上：写错了数据库会直接报错。
    expect(featureInsert?.[0]).toContain("(product_id, identity_key, first_name, first_spec_version_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)");
    expect(featureInsert?.[1]).toEqual([4, "统一登录", "统一登录", 99, 4, "支付", "支付", 99]);
    expect(db.calls().find(([sql]) => sql.includes("INSERT INTO scenario_identities"))?.[0]).toContain(
      "(product_id, identity_key, feature_identity_key, reference, first_spec_version_id) VALUES (?, ?, ?, ?, ?)",
    );
    const scenarioInsert = db.calls().find(([sql]) => sql.includes("INSERT INTO scenario_identities"));
    expect(scenarioInsert?.[1]).toEqual([4, '["统一登录","HP-1"]', "统一登录", "HP-1", 99]);
    // 登记表只追加：没有任何语句去改已经写下的行。
    expect(db.calls().filter(([sql]) => sql.startsWith("UPDATE"))).toEqual([]);
  });

  it("records a retire link for everything that left the version chain at this version", async () => {
    const db = fakeDb();
    await recordIdentityPlan(4, 100, second, db.execute);

    // 这一版新建了一个场景，退休了一个功能和一个场景。退休不 UPDATE 登记表，只记关系。
    expect(db.calls().filter(([sql]) => sql.startsWith("INSERT INTO ")).map(([sql]) => sql.includes("scenario_identities"))).toEqual([true]);
    const links = db.calls().filter(([sql]) => sql.includes("INSERT IGNORE INTO"));
    expect(links.map(([sql, parameters]) => [sql.includes("feature_identity_links") ? "feature" : "scenario", parameters.slice(1)])).toEqual([
      ["feature", [100, "retire", "支付"]],
      ["scenario", [100, "retire", '["统一登录","HP-1"]']],
    ]);
  });

  it("sends exactly one full chunk as one statement, with no empty statement after it", async () => {
    const db = fakeDb();
    const plan = planVersionIdentities({
      features: [{ name: "统一登录", parentKey: null, references: Array.from({ length: ASSIGN_CHUNK_SIZE }, (_, index) => `HP-${index + 1}`) }],
      previous: emptyIdentityMaps(),
      registry: emptyIdentityMaps(),
    });

    await recordIdentityPlan(4, 99, plan, db.execute);

    const inserts = db.calls().filter(([sql]) => sql.startsWith("INSERT INTO scenario_identities"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]).toHaveLength(ASSIGN_CHUNK_SIZE * 5);
  });

  it("inserts the one identity a version mints, and records the one link it causes", async () => {
    // 恰好一个：数量判断的边界。只新建一个功能的版本是最常见的版本。
    const db = fakeDb();
    const only = planVersionIdentities({ features: [{ name: "统一登录", parentKey: null, references: ["HP-1"] }], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() });
    await recordIdentityPlan(4, 99, only, db.execute);
    expect(db.calls().map(([sql, parameters]) => [sql.includes("feature_identities") ? "feature" : "scenario", parameters])).toEqual([
      ["feature", [4, "统一登录", "统一登录", 99]],
      ["scenario", [4, '["统一登录","HP-1"]', "统一登录", "HP-1", 99]],
    ]);

    const links = fakeDb();
    await recordIdentityPlan(4, 100, planVersionIdentities({ features: [], previous: toVersionIdentities(only), registry: emptyIdentityMaps() }), links.execute);
    expect(links.calls().map(([sql, parameters]) => [sql.includes("feature_identity_links") ? "feature" : "scenario", parameters.slice(1)])).toEqual([
      ["feature", [100, "retire", "统一登录"]],
      ["scenario", [100, "retire", '["统一登录","HP-1"]']],
    ]);
  });

  it("does nothing for a version in which nothing was minted, retired or restored", async () => {
    const db = fakeDb();
    await recordIdentityPlan(4, 99, planVersionIdentities({ features: [], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() }), db.execute);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("records a restore link for what came back, without inserting it again", async () => {
    // 支付在第一版出现、第二版消失、第三版回来。第三版里它和它的场景都是恢复，不是新建。
    const f = (name: string, references: string[] = []) => ({ name, parentKey: null, references });
    const none = emptyIdentityMaps();
    const v1 = planVersionIdentities({ features: [f("支付", ["HP-1"])], previous: none, registry: none });
    const v2 = planVersionIdentities({ features: [f("统一登录", ["HP-1"])], previous: toVersionIdentities(v1), registry: foldRegistry(none, v1) });
    const restored = planVersionIdentities({ features: [f("统一登录", ["HP-1"]), f("支付", ["HP-1"])], previous: toVersionIdentities(v2), registry: foldRegistry(foldRegistry(none, v1), v2) });
    expect(restoredFeatures(restored)).toEqual(["支付"]);
    expect(restoredScenarios(restored)).toEqual(['["支付","HP-1"]']);

    const db = fakeDb();
    await recordIdentityPlan(4, 101, restored, db.execute);

    // 恢复的身份登记表里早就有：不重新插入，也不改任何行，只记关系。
    expect(db.calls().filter(([sql]) => !sql.includes("INSERT IGNORE INTO"))).toEqual([]);
    // 关系种类是参数，不在语句文本里：按参数里的种类来认。
    expect(db.calls().map(([, parameters]) => parameters.slice(1))).toEqual([[101, "restore", "支付"], [101, "restore", '["支付","HP-1"]']]);
  });
});

describe("assignVersionIdentities", () => {
  const rows = {
    features: [{ id: 10, name: "统一登录", parentKey: null }, { id: 11, name: "会话管理", parentKey: "统一登录" }],
    scenarios: [{ id: 500, featureId: 10, reference: "HP-1" }, { id: 501, featureId: 11, reference: "EC-2" }],
    changes: [{ id: 900, featureKey: "统一登录", scenarioReference: "" }, { id: 901, featureKey: "会话管理", scenarioReference: "EC-2" }, { id: 902, featureKey: "旧功能", scenarioReference: "HP-3" }],
  };

  it("writes each row's identity next to the row and then records the plan", async () => {
    const db = fakeDb();
    const plan = await assignVersionIdentities(4, 99, rows, emptyIdentityMaps(), db.execute);

    const byTable = (table: string) => db.calls().filter(([sql]) => sql.startsWith(`UPDATE \`${table}\``));
    expect(byTable("spec_features").map(([, parameters]) => parameters)).toEqual([[10, "统一登录", null, 11, "会话管理", "统一登录"]]);
    expect(byTable("spec_scenarios").map(([, parameters]) => parameters)).toEqual([[500, '["统一登录","HP-1"]', 501, '["会话管理","EC-2"]']]);
    // 变化记录的身份以本版为准。旧功能不在本版、也不在上一版或登记表里，身份留空，不去猜：
    // 这样的行不需要写，所以这条语句里没有它。
    expect(byTable("spec_changes").map(([, parameters]) => parameters)).toEqual([[900, "统一登录", null, 901, "会话管理", '["会话管理","EC-2"]']]);
    // 登记表写在这三张表之后，同一个事务里。
    const order = db.calls().map(([sql]) => (sql.includes("feature_identities") ? "registry" : sql.startsWith("UPDATE") ? "rows" : "other"));
    expect(order.lastIndexOf("rows")).toBeLessThan(order.indexOf("registry"));
    // 返回的就是写下去的那份计划，调用方拿它接着算下一版。
    expect([...plan.features.keys()]).toEqual(["统一登录", "会话管理"]);
  });

  it("resolves a removed entry's identity from the previous version, then from the registry", async () => {
    const previous: VersionIdentities = { features: new Map([["旧功能", "旧功能"]]), scenarios: new Map([["旧功能", new Map([["HP-3", '["旧功能","HP-3"]']])]]) };
    const fromRegistry = fakeDb();
    await assignVersionIdentities(4, 99, { features: rows.features.slice(0, 1), scenarios: rows.scenarios.slice(0, 1), changes: [rows.changes[2]] }, previous, fromRegistry.execute);
    expect(fromRegistry.calls().find(([sql]) => sql.startsWith("UPDATE `spec_changes`"))?.[1]).toEqual([902, "旧功能", '["旧功能","HP-3"]']);

    const db = fakeDb();
    await assignVersionIdentities(4, 99, { features: rows.features.slice(0, 1), scenarios: rows.scenarios.slice(0, 1), changes: [rows.changes[2]] }, emptyIdentityMaps(), db.execute, previous);
    expect(db.calls().find(([sql]) => sql.startsWith("UPDATE `spec_changes`"))?.[1]).toEqual([902, "旧功能", '["旧功能","HP-3"]']);
  });

  it("leaves a scenario row whose feature is not in the version alone, instead of inventing an identity", async () => {
    const db = fakeDb();
    await assignVersionIdentities(4, 99, { ...rows, scenarios: [...rows.scenarios, { id: 999, featureId: 424242, reference: "HP-9" }] }, emptyIdentityMaps(), db.execute);
    expect(db.calls().find(([sql]) => sql.startsWith("UPDATE `spec_scenarios`"))?.[1]).toEqual([500, '["统一登录","HP-1"]', 501, '["会话管理","EC-2"]']);
  });

  it("sends long lists in several statements instead of one oversized one", async () => {
    const db = fakeDb();
    const many = Array.from({ length: ASSIGN_CHUNK_SIZE + 1 }, (_, index) => ({ id: 1000 + index, featureId: 10, reference: `HP-${index + 1}` }));
    await assignVersionIdentities(4, 99, { features: rows.features.slice(0, 1), scenarios: many, changes: [] }, emptyIdentityMaps(), db.execute);
    expect(db.calls().filter(([sql]) => sql.startsWith("UPDATE `spec_scenarios`")).map(([, parameters]) => parameters.length / 2)).toEqual([ASSIGN_CHUNK_SIZE, 1]);
  });
});

describe("loadIdentitySources", () => {
  it("loads the registries and the base version's identities, and hands both back", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM feature_identities")) return [[{ nameKey: "sign-in", identity_key: "sign-in" }]];
      if (sql.includes("identity_key FROM spec_features WHERE spec_version_id")) return [[{ versionId: 11, nameKey: "authentication", identity_key: "sign-in" }]];
      return [{}];
    });

    const sources = await loadIdentitySources(4, 11, db.execute);

    expect(sources?.registry.features.get("sign-in")).toBe("sign-in");
    expect(sources?.previous.features.get("authentication")).toBe("sign-in");
    // 登记表两条、上一版两条，都带着各自的键。
    expect(db.calls().map(([, parameters]) => parameters)).toEqual([[4], [4], [11], [11]]);
  });

  it("does not read a base version when the publication is the first version", async () => {
    const db = fakeDb();
    const sources = await loadIdentitySources(4, null, db.execute);
    expect(sources?.previous).toEqual({ features: new Map(), scenarios: new Map() });
    expect(db.calls().map(([, parameters]) => parameters)).toEqual([[4], [4]]);
  });

  it("returns null and reads nothing when the identity layer is switched off", async () => {
    vi.stubEnv("SPEC_IDENTITY_LAYER", "false");
    try {
      const db = fakeDb();
      expect(await loadIdentitySources(4, 11, db.execute)).toBeNull();
      expect(db.execute).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
