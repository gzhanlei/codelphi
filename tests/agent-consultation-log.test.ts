import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendConsultation, formatConsultationRecord, parseConsultationRecord } from "../lib/agent-consultation-log";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

const record = {
  project: "tingfeng",
  repository: "gzhanlei/tingfeng",
  sha: "2b2caa7",
  task: "环境重校准",
  question: "needsRecalibration 重启后还会显示吗？",
  answer: "当前状态不持久；建议重校准需要单独持久化标记。",
  evidence: ["ios/Tingfeng/DSP/TargetTracker.swift:82-90"],
  unknowns: ["重校准期间是否继续取证属于产品裁决"],
  decisionImpact: "不能把 currentResult 当稳定入口",
  nextAction: "verify" as const,
};

describe("agent consultation log", () => {
  it("formats a complete reviewable consultation", () => {
    const text = formatConsultationRecord({ ...record, createdAt: "2026-11-25T10:00:00.000Z" });
    expect(text).toContain("## 2026-11-25T10:00:00.000Z · tingfeng");
    expect(text).toContain("- task: 环境重校准");
    expect(text).toContain("- sha: 2b2caa7");
    expect(text).toContain("- question: needsRecalibration 重启后还会显示吗？");
    expect(text).toContain("- answer: 当前状态不持久；建议重校准需要单独持久化标记。");
    expect(text).toContain("- unknowns: 重校准期间是否继续取证属于产品裁决");
    expect(text).toContain("- nextAction: verify");
  });

  it("appends markdown and jsonl per project", async () => {
    const root = await mkdtemp(join(tmpdir(), "consult-log-"));
    created.push(root);
    const first = await appendConsultation(root, record);
    await appendConsultation(root, { ...record, question: "换 id 会清空历史吗？", answer: "不会清空，但会重建 tracker。" });
    const markdown = await readFile(join(root, "artifacts/agent-consultations/tingfeng.md"), "utf8");
    const jsonl = await readFile(join(root, "artifacts/agent-consultations/tingfeng.jsonl"), "utf8");
    expect(first).toContain("needsRecalibration 重启后还会显示吗？");
    expect(markdown.match(/## /g)?.length).toBe(2);
    expect(jsonl.trim().split("\n")).toHaveLength(2);
  });

  it("rejects invalid projects and incomplete records", () => {
    expect(() => parseConsultationRecord({ ...record, project: "../secrets" })).toThrow("project");
    expect(() => parseConsultationRecord({ ...record, answer: "" })).toThrow("answer");
    expect(() => parseConsultationRecord({ ...record, nextAction: "guess" })).toThrow("nextAction");
  });
});
