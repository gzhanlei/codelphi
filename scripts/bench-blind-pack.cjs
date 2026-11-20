#!/usr/bin/env node
/**
 * Task 15 Phase C 盲评打包：把两路径导出 JSON 去标识化为「甲/乙」两份盲评包。
 * 用法：node scripts/bench-blind-pack.cjs <legacy.json> <inventory.json> <outDir>
 * 产物：outDir/pack-甲.json、pack-乙.json（内容相同结构，标签按 sha 洗牌）、
 *       outDir/sealed-map.json（甲乙↔真实路径映射；盲评期间评审不得打开）。
 * 包内每条输出场景只含：情境/操作/结果/分类/证据（path+行号），不含来源系统名。
 */
const fs = require("fs");
const crypto = require("crypto");

const [legacyPath, inventoryPath, outDir] = process.argv.slice(2);
if (!legacyPath || !inventoryPath || !outDir) {
  console.error("usage: bench-blind-pack.cjs <legacy.json> <inventory.json> <outDir>");
  process.exit(3);
}
const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));

function flatten(exported) {
  const rows = [];
  for (const feature of exported.spec.features) {
    for (const scenario of feature.scenarios) {
      rows.push({
        feature: feature.name,
        context: scenario.context,
        action: scenario.action,
        outcome: scenario.outcome,
        category: scenario.category,
        evidence: scenario.evidence,
      });
    }
  }
  return rows;
}

// 确定性洗牌：以两份导出的 specVersionId+runId 为种子，标签分配稳定可复现
const seed = crypto.createHash("sha256")
  .update(`${legacy.run.id}:${inventory.run.id}`)
  .digest("hex");
const swap = parseInt(seed.slice(0, 8), 16) % 2 === 1;
const labels = swap ? { legacy: "乙", inventory: "甲" } : { legacy: "甲", inventory: "乙" };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/pack-甲.json`, JSON.stringify({ pack: "甲", scenarios: flatten(labels.legacy === "甲" ? legacy : inventory) }, null, 1));
fs.writeFileSync(`${outDir}/pack-乙.json`, JSON.stringify({ pack: "乙", scenarios: flatten(labels.legacy === "乙" ? legacy : inventory) }, null, 1));
fs.writeFileSync(`${outDir}/sealed-map.json`, JSON.stringify({ sealed: "盲评期间不得打开", mapping: { 甲: labels.legacy === "甲" ? "legacy" : "inventory", 乙: labels.legacy === "乙" ? "legacy" : "inventory" } }, null, 2));
console.log(JSON.stringify({ outDir, legacyScenarios: flatten(legacy).length, inventoryScenarios: flatten(inventory).length, legacyLabel: labels.legacy }));
