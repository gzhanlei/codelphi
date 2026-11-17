# CoDelphi

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)

**中文说明请看 [README.zh-CN.md](README.zh-CN.md)。**

CoDelphi turns a GitHub repository into a traceable product spec: AI-extracted features and scenarios, per-push behavior changes, and every claim backed by clickable source-code evidence — not free-form summaries.

- 🔍 **Traceable evidence** — the AI may only cite code paths actually read in the run; unknown paths fail the analysis outright. Hallucination is ruled out by mechanism, not by prompt conventions.
- 🔄 **Evolves with the code** — driven by GitHub App webhooks; every push is analyzed automatically and release pages lead with before/after behavior diffs.
- ✍️ **Human-in-the-loop** — features, scenarios and the product overview are manually editable; human-authored content is never overwritten by automated analysis.
- 🏃 **Real-world proven** — CoDelphi continuously analyzes its own repository (and others) in production; this project is its first analysis subject.

**Live demo (read-only, no account):** https://codelphi.com/products/u-a8811be775/codelphi

**Hosted service:** https://codelphi.com

## CoDelphi Radar skill

Radar is a standalone skill that analyzes a local Git repository or a public GitHub repository and produces a single-file, offline-openable HTML product brief — description, core capabilities, typical scenarios, the full feature spec, and per-claim source evidence. It does no continuous analysis and writes no database; it shares the same prompts, schema, evidence validation and deterministic merge as the main product.

### Install

In a skill-capable agent host (Claude Code, Kimi Code, etc.), just tell it:

```
安装 https://codelphi.com/downloads/codelphi-radar.zip 这个 skill
```

The host downloads the zip and unpacks it into its skill directory (`~/.claude/skills/codelphi-radar/` for Claude Code). You can also [download the zip](https://codelphi.com/downloads/codelphi-radar.zip) and unpack it manually.

### Use

After installing, tell your host:

```
用 codelphi radar skill 分析 https://github.com/owner/repo
```

The target can also be a local repository path. The host runs `prepare` to pin the commit and split work orders, completes them concurrently via the `complete` fast path, then `finalize` writes `radar.html` under `.radar-work/` in the working directory.

### The three commands

```bash
node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN
CODELPHI_SKILL_HOST=claude-code node codelphi-radar/scripts/snapshot.cjs complete --workdir .radar-work --concurrency 4
node codelphi-radar/scripts/snapshot.cjs finalize --workdir .radar-work
```

`complete` probes completion backends in order: standalone AI config (`--env-file` or `AI_API_KEY`/`AI_MODEL`) → a host-injected bridge (`CODELPHI_HOST_AI_BRIDGE_URL`/`TOKEN` or `CODELPHI_HOST_AI_COMMAND`/`CODELPHI_HOST_AI_ARGS_JSON`) → the current host's own headless CLI (declared via `CODELPHI_SKILL_HOST`: `claude-code`, `codex`, `gemini`, `cursor`, `kimi`, `qwen`, `opencode`, `antigravity` — never probed across vendors). When nothing is available it prints the reasons and falls back to per-order agent execution. Use `--ref` to pin a revision and repeatable `--scope` to limit a monorepo; `--language en` produces an English report.

### Standalone CLI

Without an agent host, explicitly choose standalone mode (`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`, or `--env-file`):

```bash
npm run snapshot -- /path/to/repo --language zh-CN --output report.html
npm run snapshot -- https://github.com/owner/repo --ref main --language en --output report.html
```

### Boundaries

A one-shot understanding tool: no continuous analysis, release tracking, webhooks or polling; no private GitHub repos, SSH URLs, GitLab/Gitee/Gitea; reads Git objects only, never mixing uncommitted files into the analysis. **Features and summaries are unverified AI candidates**: traceable evidence ≠ correct conclusions, and assembled-coverage ratio is not accuracy. Full docs: [docs/local-snapshot.md](docs/local-snapshot.md).

## What CoDelphi implements

CoDelphi continuously analyzes its own repository, so the most current, evidence-backed feature list is the product itself:

**See the live product page: https://codelphi.com/products/u-a8811be775/codelphi** — features, scenarios, per-release behavior changes and knowledge health, all with clickable source evidence.

## Tech stack

Next.js (App Router) · TypeScript · React · MySQL 8 · Vitest · OpenAI-compatible LLM API

## Local setup

### 1. Prepare configuration

```bash
cp .env.example .env
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # GITHUB_WEBHOOK_SECRET
```

Fill at least: `DATABASE_URL` (Tencent Cloud MySQL `mysql://` URL, database `radar`), `CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`, `GITHUB_TOKEN` (read access to internal repos), `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`. Optional: `AUTH_ALLOWED_EMAILS` (login restriction for closed deployments only), `PUBLIC_DEMO_SLUGS` (transitional demo allowlist; prefer the per-product switch in Settings). `DATABASE_SSL=true` is the default; set it to `false` only inside a VPC where TLS is unnecessary.

### 2. Create a dedicated database and account

As the MySQL administrator (replace password and network ranges; never paste real passwords into chats):

```sql
CREATE DATABASE radar CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'radar'@'%' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES, DROP
ON radar.* TO radar@'%';
FLUSH PRIVILEGES;
```

### 3. Initialize and start

> If `.env` points at the production database, local `next dev` will **not** trigger startup recovery or billing sweeps (skipped in development by default, see `instrumentation.ts`); set `ALLOW_PROD_SIDE_EFFECTS=true` to exercise those paths locally.

```bash
npm install
npm run db:create
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000` and sign in with Chandler. Click "Add product" to register a GitHub `owner/repo` with its default branch; keep "analyze immediately after adding" selected for the first spec.

### 4. Chandler OAuth and the GitHub App

Create the app at `https://app.chandler.work/partner/apps` (scope `openid profile email`, callback `http://localhost:3000/auth/callback`).

Then open `/integrations` and click "Create CoDelphi GitHub App" — the app requests only `contents:read` and `metadata:read`, and new apps declare an app-level webhook URL plus the `push` event, so pushes analyze automatically. Existing apps can backfill via "Set up push notifications" (GitHub exposes no REST API for updating app webhooks): set the payload URL to `https://<your-domain>/api/webhooks/github`, paste the deployment's `GITHUB_WEBHOOK_SECRET`, and subscribe to **Push** in **both** the webhook form and the event-subscription area — filling only the webhook form subscribes to nothing.

Verify in App settings → Advanced → Recent Deliveries: redelivering the ping should return 200; pushing a commit should produce a 202 delivery and start an analysis.

You can verify analysis locally without webhooks: `npm run analyze -- <product-slug>`.

## Deployment

Production should run a persistent Node.js service (Docker Compose recommended — see [docs/docker-migration-plan.md](docs/docker-migration-plan.md)), not a serverless platform that freezes after the response: webhooks and in-page "analyze now" both rely on Next.js `after()` continuing past the response.

## Analysis trigger modes

The full analysis pipeline is documented in [docs/analysis-pipeline.md](docs/analysis-pipeline.md). New repositories default to "analyze on every push"; high-frequency repos can switch to "once per day off-peak" or "every N pushes plus an end-of-day catch-up" in product settings to control monthly analysis-unit (SAU) spend. Every mode merges all commits since the last successful analysis into one run.

## Connect AI coding assistants (MCP)

CoDelphi exposes 13 MCP tools (12 read-only + 1 feedback channel) for AI coding assistants across the development cycle: before editing, `lookup_by_files` finds which features/scenarios cite the files you plan to touch; `search_scenarios` retrieves behavior contracts with source evidence; after a push, `list_releases` / `get_release` verify what actually changed; `send_feedback` reports ledger/code mismatches to an AI adjudication pipeline.

1. Create an org-level read-only key under "MCP key management" in codelphi.com settings — the wizard emits a ready-made `mcpServers` config; the public page <https://codelphi.com/mcp> has the full guide (MCP auto-discovery and OAuth dynamic registration supported).
2. Paste that config into your AI coding assistant.
3. Paste the policy block from [docs/coding-agent-mcp.md](docs/coding-agent-mcp.md) into your repository's `AGENTS.md` so the agent follows the ledger workflow in every session.

## Data and security boundaries

- Only the Chandler `sub`, email, display name and avatar are stored — never Chandler passwords or OAuth tokens. Sessions last 7 days.
- The AI may only cite code or diff files read in the run; code is sent only to the configured AI gateway.
- GitHub access prefers per-repo GitHub App installation tokens; a server-wide PAT is a compatibility fallback only.
- **Known limitation**: path guards prevent citation hallucination, not semantic hallucination — a real line number paired with a wrong interpretation still passes validation. Evidence coverage is not conclusion correctness; treat output as unverified until human review.
