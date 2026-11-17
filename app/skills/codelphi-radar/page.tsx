import { PublicShell } from "@/components/public-shell";
import { resolveUiLocale } from "@/lib/ui-locale-server";

const BUILD_URL = "https://github.com/gzhanlei/codelphi#codelphi-radar";

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
        <h2>{t("构建独立 Skill 包", "Build the standalone skill bundle")}</h2>
        <p>{t("在主仓库运行 npm run radar:package，会依次构建 dist/codelphi-radar 和 dist/codelphi-radar.zip。包内包含 SKILL.md、prepare/finalize CLI、共享提取契约和 standalone 驱动，不需要目标环境存在 CoDelphi 源码、Next.js、MySQL 或根 node_modules。", "Run npm run radar:package in the main repository to build dist/codelphi-radar and dist/codelphi-radar.zip. The bundle includes SKILL.md, the prepare/finalize CLI, the shared extraction contract, and the standalone driver. No CoDelphi checkout, Next.js, MySQL, or root node_modules is required in the target environment.")}</p>
        <pre><code>{`git clone --depth 1 https://github.com/gzhanlei/codelphi.git
cd codelphi
npm ci
npm run radar:package`}</code></pre>
        <p><a href={BUILD_URL} target="_blank" rel="noreferrer">{t("查看主仓库与构建说明", "View the repository and build instructions")}</a></p>
        <p>{t("解压后会得到 codelphi-radar 目录。宿主原生模式不需要模型 API、桥接、token 或 AI 环境变量。", "After extraction you will have a codelphi-radar directory. Host-native mode requires no model API, bridge, token, or AI environment variables.")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("宿主原生：准备、完成、定稿", "Host-native: prepare, complete, finalize")}</h2>
        <p>{t("先让脚本准备固定 commit 的工作单，再由宿主使用自己的当前模型完成每个工作单，最后由脚本统一校验并生成 HTML。", "The script prepares work orders for a fixed commit, your host completes each work order with its current model, and the script validates everything and generates the HTML.")}</p>
        <pre><code>{`node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN
# 按 work-orders/*.json 完成结果并写入 results/<partition-id>.json
node codelphi-radar/scripts/snapshot.cjs finalize --workdir .radar-work`}</code></pre>
        <p>{t("公开 GitHub 仓库直接把目标换成 https://github.com/owner/repo。可用 --ref 指定版本，用重复的 --scope 限定 monorepo 范围，用 --language en 生成英文报告。", "For a public GitHub repository, replace the target with https://github.com/owner/repo. Use --ref to select a revision, repeat --scope to limit a monorepo, and use --language en for an English report.")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("可选 standalone 模式", "Optional standalone mode")}</h2>
        <p>{t("没有 agent 宿主时，可显式选择 standalone，由 CLI 使用 AI_BASE_URL、AI_API_KEY、AI_MODEL 完成分析。只有明确选择该模式时才需要这些配置。", "Without an agent host, explicitly choose standalone mode and let the CLI analyze with AI_BASE_URL, AI_API_KEY, and AI_MODEL. These settings are needed only when you explicitly select that mode.")}</p>
        <pre><code>{`node codelphi-radar/scripts/snapshot.cjs https://github.com/owner/repo --standalone --language en --output radar.html`}</code></pre>
      </section>
    </PublicShell>
  );
}
