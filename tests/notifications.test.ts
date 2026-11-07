import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAnalysisNotifications, getUserEmailPref, renderNotificationText, saveNotificationChannel, sendEmailNotification, setUserEmailPref } from "../lib/notifications";

vi.mock("../lib/secret-box", () => ({
  encryptSecret: (plaintext: string) => plaintext,
  decryptSecret: (payload: string) => payload,
}));

const execute = vi.fn();
const post = vi.fn();

const run = {
  id: 8,
  productId: 3,
  productSlug: "radar",
  productName: "Radar",
  owner: "gzhanlei",
  name: "radar",
  afterSha: "abc1234def5678",
};

const changes = [
  {
    kind: "changed",
    entityType: "scenario",
    featureName: "统一登录",
    scenarioReference: "HP-1",
    summary: "登录成功后跳转页从 /dashboard 改为 /workspace",
    beforeJson: { evidence: [{ path: "lib/auth.ts", startLine: 10 }] },
    afterJson: { evidence: [{ path: "lib/auth.ts", startLine: 20 }] },
  },
  {
    kind: "added",
    entityType: "feature",
    featureName: "规格导出",
    scenarioReference: "",
    summary: "新增 Gherkin 测试骨架导出能力",
    beforeJson: null,
    afterJson: { evidence: [{ path: "lib/scenario-export.ts" }] },
  },
];

function stubDb({ channels = 1, changeRows = changes as never[] } = {}) {
  execute.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM notification_channels")) {
      return channels > 0 ? [[{ id: 5, kind: "slack", target_encrypted: "enc-slack" }]] : [[]];
    }
    if (sql.includes("FROM user_email_prefs")) return [[]];
    if (sql.includes("FROM spec_changes")) return [changeRows];
    return [{ affectedRows: 1 }];
  });
}

describe("notification rendering", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
  });

  it("renders product name, release link and numbered change list with evidence links", () => {
    const text = renderNotificationText("Radar", "https://codelphi.com/commit/abc", changes, [["https://github.com/gzhanlei/radar/blob/abc/lib/auth.ts#L20"], []]);
    expect(text).toContain("【CoDelphi】Radar 检测到 2 条规格行为变化");
    expect(text).toContain("https://codelphi.com/commit/abc");
    expect(text).toContain("1. [变化] 统一登录 · HP-1 — 登录成功后跳转页从 /dashboard 改为 /workspace");
    expect(text).toContain("2. [新增] 规格导出 — 新增 Gherkin 测试骨架导出能力");
    expect(text).toContain("证据: https://github.com/gzhanlei/radar/blob/abc/lib/auth.ts#L20");
  });

  it("returns null when there is nothing to notify about", () => {
    expect(renderNotificationText("Radar", "https://codelphi.com/commit/abc", [], [])).toBeNull();
  });
});

describe("analysis notification delivery", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    vi.clearAllMocks();
    post.mockResolvedValue(undefined);
  });

  it("delivers the rendered summary to every enabled channel and records success", async () => {
    stubDb();
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    expect(post).toHaveBeenCalledTimes(1);
    const [target, body] = post.mock.calls[0];
    expect(target).toBe("enc-slack");
    expect(JSON.parse(body).text).toContain("Radar 检测到 2 条规格行为变化");
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_deliveries"),
      [5, null, 8, "sent", null],
    );
  });

  it("stays silent when the spec version has no behavior changes", async () => {
    stubDb({ changeRows: [] });
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    expect(post).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_deliveries"), expect.anything());
  });

  it("records delivery failure without throwing so analysis state is unaffected", async () => {
    stubDb();
    post.mockRejectedValue(new Error("connection refused"));
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_deliveries"),
      [5, null, 8, "failed", "connection refused"],
    );
  });

  it("re-delivering the same run and channel overwrites the delivery record instead of duplicating it", async () => {
    stubDb();
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    const inserts = execute.mock.calls.filter(([sql]) => (sql as string).includes("INSERT INTO notification_deliveries"));
    expect(post).toHaveBeenCalledTimes(2);
    expect(inserts).toHaveLength(2);
    expect(inserts[0][0]).toContain("ON DUPLICATE KEY UPDATE");
  });

  it("delivers structured JSON to generic webhook channels", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM notification_channels")) {
        return [[{ id: 6, kind: "webhook", target_encrypted: "enc-hook" }]];
      }
      if (sql.includes("FROM user_email_prefs")) return [[]];
      if (sql.includes("FROM spec_changes")) return [changes];
      return [{ affectedRows: 1 }];
    });
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post });
    const payload = JSON.parse(post.mock.calls[0][1]);
    expect(payload.product).toEqual({ slug: "radar", name: "Radar" });
    expect(payload.releaseUrl).toBe("https://codelphi.com/commit/abc");
    expect(payload.changes).toHaveLength(2);
    expect(payload.changes[0]).toMatchObject({ kind: "changed", featureName: "统一登录", scenarioReference: "HP-1" });
    expect(payload.changes[0].evidenceUrls).toEqual(["https://github.com/gzhanlei/radar/blob/abc1234def5678/lib/auth.ts#L20"]);
  });
});

describe("channel management", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
  });

  it("upserts a channel target encrypted for storage", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await saveNotificationChannel(3, "slack", "https://hooks.slack.com/services/T/B/X", execute);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("ON DUPLICATE KEY UPDATE"),
      [3, "slack", "https://hooks.slack.com/services/T/B/X"],
    );
  });
});

describe("per-user email preference", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    vi.clearAllMocks();
  });

  it("upserts the preference keyed by user and product", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await setUserEmailPref(3, 9, true, execute);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user_email_prefs"),
      [9, 3, 1],
    );
  });

  it("reads the preference as disabled when no row exists", async () => {
    execute.mockResolvedValue([[]]);
    await expect(getUserEmailPref(3, 9, execute)).resolves.toBe(false);
  });
});

describe("email delivery via Chandler", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    vi.clearAllMocks();
    post.mockResolvedValue(undefined);
  });

  it("emails every opted-in user and records a user-scoped delivery", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM notification_channels")) return [[]];
      if (sql.includes("FROM user_email_prefs")) {
        return [[{ userId: 9, email: "qa@example.com" }, { userId: 10, email: "pm@example.com" }]];
      }
      if (sql.includes("FROM spec_changes")) return [changes];
      return [{ affectedRows: 1 }];
    });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post, sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const [to, subject, text] = sendEmail.mock.calls[0];
    expect(to).toBe("qa@example.com");
    expect(subject).toBe("【CoDelphi】Radar 检测到 2 条规格行为变化");
    expect(text).toContain("https://codelphi.com/commit/abc");
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_deliveries"),
      [null, 9, 8, "sent", null],
    );
  });

  it("records a failed email without affecting other recipients", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM notification_channels")) return [[]];
      if (sql.includes("FROM user_email_prefs")) return [[{ userId: 9, email: "qa@example.com" }, { userId: 10, email: "pm@example.com" }]];
      if (sql.includes("FROM spec_changes")) return [changes];
      return [{ affectedRows: 1 }];
    });
    const sendEmail = vi.fn()
      .mockRejectedValueOnce(new Error("chandler mail 502: mail.send_failed"))
      .mockResolvedValueOnce(undefined);
    await deliverAnalysisNotifications({ run, releaseUrl: "https://codelphi.com/commit/abc", specVersionId: 44 }, { execute, post, sendEmail });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_deliveries"),
      [null, 9, 8, "failed", "chandler mail 502: mail.send_failed"],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO notification_deliveries"),
      [null, 10, 8, "sent", null],
    );
  });

  it("sends a test email through the Chandler mail API", async () => {
    vi.stubEnv("CHANDLER_MAIL_API_KEY", "test-key");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { status: "sent" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await sendEmailNotification("qa@example.com", "【CoDelphi】Radar 通知渠道测试", "正文");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/v1/mail/send");
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer test-key" } });
    expect(JSON.parse(String(init.body))).toMatchObject({ to: "qa@example.com", subject: "【CoDelphi】Radar 通知渠道测试" });
  });

  it("fails with a clear error when the Chandler mail API key is not configured", async () => {
    vi.stubEnv("CHANDLER_MAIL_API_KEY", "");
    await expect(sendEmailNotification("qa@example.com", "s", "t")).rejects.toThrow("CHANDLER_MAIL_API_KEY not configured");
  });
});
