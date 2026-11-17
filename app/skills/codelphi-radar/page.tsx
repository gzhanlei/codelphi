import { PublicShell } from "@/components/public-shell";
import { resolveUiLocale } from "@/lib/ui-locale-server";

const ZIP_URL = "https://github.com/gzhanlei/codelphi/releases/latest/download/codelphi-radar.zip";

export async function generateMetadata() {
  const locale = await resolveUiLocale();
  return { title: locale === "en" ? "CoDelphi Radar skill" : "CoDelphi Radar Skill" };
}

export default async function RadarInstallPage() {
  const locale = await resolveUiLocale();
  const t = (zh: string, en: string) => locale === "en" ? en : zh;
  return (
    <PublicShell>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CODELPHI RADAR</span>
          <h1>{t("从代码理解产品", "Understand a product from its code")}</h1>
          <p>{t("在你的 agent 宿主中分析本地 Git 仓库或公开 GitHub 仓库，生成一份可离线打开、带源码证据的产品简报。", "Analyze a local Git repository or a public GitHub repository in your agent host and generate an offline product brief with source evidence.")}</p>
        </div>
      </div>

      <section className="overview-panel">
        <h2>{t("一句话安装", "Install in one sentence")}</h2>
        <p>{t("在支持技能的 agent 宿主（Claude Code、Kimi Code 等）里，直接对它说：", "In a skill-capable agent host (Claude Code, Kimi Code, etc.), just tell it:")}</p>
        <pre><code>{`安装 ${ZIP_URL} 这个 skill`}</code></pre>
        <p>{t("宿主会下载 zip 并解压到自己的技能目录（Claude Code 为 ~/.claude/skills/codelphi-radar/）。也可以手动下载后自行解压到对应目录。", "The host downloads the zip and unpacks it into its skill directory (~/.claude/skills/codelphi-radar/ for Claude Code). You can also download the zip and unpack it manually.")}</p>
        <p><a href={ZIP_URL}>{t("下载 codelphi-radar.zip（GitHub Releases）", "Download codelphi-radar.zip (GitHub Releases)")}</a></p>
      </section>

      <section className="overview-panel">
        <h2>{t("一句话使用", "Use in one sentence")}</h2>
        <p>{t("安装后对宿主说：", "After installing, tell your host:")}</p>
        <pre><code>{`用 codelphi radar skill 分析 https://github.com/owner/repo`}</code></pre>
        <p>{t("目标也可以是本地仓库路径。宿主会运行 prepare 固定 commit 并切分工作单，用 complete 快路径并发完成，最后 finalize 生成 radar.html；产物默认写在工作目录的 .radar-work/ 下。", "The target can also be a local repository path. The host runs prepare to pin the commit and split work orders, completes them concurrently via the complete fast path, then finalize writes radar.html; output lands under .radar-work/ in the working directory.")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("三步命令（宿主原生）", "The three commands (host-native)")}</h2>
        <pre><code>{`node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN
CODELPHI_SKILL_HOST=claude-code node codelphi-radar/scripts/snapshot.cjs complete --workdir .radar-work --concurrency 4
node codelphi-radar/scripts/snapshot.cjs finalize --workdir .radar-work`}</code></pre>
        <p>{t("complete 按序探测完成通道：standalone AI 配置 → 宿主注入的显式桥 → 当前宿主自己的 headless CLI（用 CODELPHI_SKILL_HOST 标明宿主身份：claude-code、codex、gemini、cursor、kimi、qwen、opencode、antigravity；绝不跨厂商探测）。全部不可用时输出原因并回退为宿主逐个执行工作单。", "complete probes backends in order: standalone AI config → host-injected bridge → the current host's own headless CLI (declare the host via CODELPHI_SKILL_HOST: claude-code, codex, gemini, cursor, kimi, qwen, opencode, antigravity; never probed across vendors). When nothing is available it prints the reasons and falls back to per-order agent execution.")}</p>
        <p>{t("公开 GitHub 仓库直接把目标换成 https://github.com/owner/repo。可用 --ref 指定版本，用重复的 --scope 限定 monorepo 范围，用 --language en 生成英文报告。维护者可在主仓库运行 npm run radar:package 自行构建分发包。", "For a public GitHub repository, replace the target with https://github.com/owner/repo. Use --ref to select a revision, repeat --scope to limit a monorepo, and use --language en for an English report. Maintainers can build the bundle themselves with npm run radar:package in the main repository.")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("可选 standalone 模式", "Optional standalone mode")}</h2>
        <p>{t("没有 agent 宿主时，可显式选择 standalone，由 CLI 使用 AI_BASE_URL、AI_API_KEY、AI_MODEL 完成分析。只有明确选择该模式时才需要这些配置。", "Without an agent host, explicitly choose standalone mode and let the CLI analyze with AI_BASE_URL, AI_API_KEY, and AI_MODEL. These settings are needed only when you explicitly select that mode.")}</p>
        <pre><code>{`node codelphi-radar/scripts/snapshot.cjs https://github.com/owner/repo --standalone --language en --output radar.html`}</code></pre>
      </section>
    </PublicShell>
  );
}
