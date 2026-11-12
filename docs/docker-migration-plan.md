# CoDelphi Docker 化部署迁移方案

> 2026-11-12 起草。目标：生产部署从「git checkout + 服务器侧构建」迁移到「无源码 Docker Compose 产物部署」，对齐本机 SalesBuddy 已验证的部署形态（`/data/www/salesbuddy`：sha 固定镜像、部署锁、last_good/prev_good 回滚、迁移 profile、冒烟检查）。
>
> 状态：**✅ 已实施并完成首次部署**（2026-11-12，镜像 `codelphi-server:sha-dcea71b`，systemd 已停用保留应急）。首次走 GitHub 不可达窗口 → 实际通道 = 本地构建 `docker save | gzip | ssh docker load`（约 320MB 镜像，秒级切换，零错误日志）。实施实况与两个踩坑见 §9。

## 1. 现状（事实）

- 服务：systemd `codelphi.service`，`npm start -- -H 127.0.0.1 -p 3008`，nginx codelphi.com 反代 127.0.0.1:3008
- 服务器：TencentOS，node v20.20.2，`/data/www/codelphi` 为 git checkout（deploy 用 GitHub 只读拉取）
- 数据：MySQL 8 @ VPC 172.19.16.5:3306（DATABASE_URL 指向 VPC 内网 IP）
- 配置：`/data/www/codelphi/.env`（chmod 600；DB/Chandler/AI/PPT_PARTNER 等）
- 入口：nginx → 3008（页面 + GitHub webhook `/api/webhooks/github` + MCP `/api/mcp`）
- 关键进程行为：`instrumentation.ts` 启动恢复 + 8 个 sweep（含 digest-weekly）；分析经 `after()` 在请求外继续执行 → **进程不能是请求结束即冻结的 Serverless**
- 服务器上无 Docker 常驻给 codelphi（SalesBuddy/PPTCreator 已用 Docker）

## 2. 目标形态

- 服务器上**无源码、无 .next、无 devDependencies**：只有 `docker-compose.prod.yml` + `.env`（env_file 注入）+ 数据/状态目录
- 镜像：GHCR `ghcr.io/gzhanlei/codelphi-server:<sha>`（CI 构建多平台推送，SalesBuddy 同通道）
- 编排：`docker-compose.prod.yml` 单 app 服务 + migrate 一次性 profile（SalesBuddy 同款）
- 部署/回滚：仿 `deploy-common.sh` —— 部署锁、last_good/prev_good 状态、`rollback.sh` 一键回上一镜像、迁移 profile、冒烟检查（/login 200 + 首页 200）

## 3. 镜像构建

多阶段 Dockerfile（仓库根新增）：

```dockerfile
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 仓库 build 脚本已带 --webpack（规避 SWC 原生依赖）
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
# tsx 供 db:migrate 一次性容器使用
COPY --from=deps /app/node_modules/.bin/tsx ./node_modules/.bin/
USER 1000
EXPOSE 3000
CMD ["npm", "start"]
```

注意：仓库 build 已是 `next build --webpack`（规避 SWC 原生二进制），镜像内无需 SWC；`db:migrate` 需要 tsx + lib 全量 → runner 保留完整 node_modules（`npm ci` 全量而非 omit=dev，体积换简单，后续可再裁）。

## 4. compose.prod.yml（要点）

- app：镜像 sha 固定；ports `127.0.0.1:3008:3000`（nginx 不动）；env_file 注入 `.env`；`extra_hosts: host.docker.internal:host-gateway`（PPT_PARTNER_URL 指向宿主机 pptcreator-web:3100 时改用网关地址）
- migrate profile：`command: ["npm","run","db:migrate"]`，restart: "no"
- restart: unless-stopped；healthcheck：`wget -qO- http://127.0.0.1:3000/login`
- 卷：无状态（分析数据全在 MySQL；无本地文件依赖——`lib/archify` 系列如需产物目录再评估）
- 网络：默认 bridge 出站可达 VPC MySQL（SalesBuddy 同款已验证）

## 5. 环境变量差异清单（迁移前必须核对）

| 键 | 容器内值 | 说明 |
|---|---|---|
| PORT / HOSTNAME | `3000` / `0.0.0.0` | 旧 .env 是 `3008`/`127.0.0.1`，原样复制会让容器监听错端口（见 §9 踩坑） |
| DATABASE_URL | 不变（VPC IP 直连，bridge 出站可达） | SalesBuddy 同款已验证 |
| PPT_PARTNER_URL | `https://easymakeppt.com/mcp` | host-gateway 到不了只绑 127.0.0.1 的宿主服务（见 §9 踩坑） |
| 其余 CHANDLER_*/AI_*/SESSION_SECRET | 原值经 env_file 注入 | 无需改动 |

## 6. 迁移步骤（切换窗口 ≈ 5 分钟）

1. 前置：CI 推镜像至 GHCR（sha tag）；服务器安装 compose 文件与 `.env`（新增/改动键核对 §5）
2. `docker compose --profile migrate up`（迁移 060–066 已在现有库应用，此步幂等跳过）
3. app 容器起来 → 冒烟（/login 200、产品页 200、问答回 200）
4. nginx 保持 3008 不动 → 无切换窗口（3008 由 systemd 换成 compose 接管，端口一致）
5. 停用 `codelphi.service`（不卸载，保留紧急回滚路径）
6. 回滚：`systemctl start codelphi.service`（compose down 3008 释放端口）+ git revert（如涉及 schema，回滚脚本另行评估）

## 7. 风险与开放问题

1. **GitHub/ghcr 不可达窗口**（今晚实测双侧均断）：镜像拉取失败 → 部署中止（compose up 前置 pull 失败即退出，旧容器不受影响）；兜底 = 本地 bundle 推镜像（`docker save | ssh docker load`），写入部署文档
2. **after() 语义**：容器内 Next `after()` 同样可用（非 Serverless）✓
3. **webhook**：nginx 不动，GitHub → codelphi.com → nginx → 3008 → 容器 ✓
4. **MCP 3100**：PPTCreator 在宿主机 127.0.0.1:3100 —— 容器内访问宿主机需 `extra_hosts: host.docker.internal:host-gateway`，PPT_PARTNER_URL 相应改为 `http://host.docker.internal:3100/mcp`
5. **限流桶**：rate_limit_hits 在 MySQL，容器与宿主共用 ✓（迁移后 owner 身份桶不丢）

## 8. 明确不做（本方案边界）

- 不做 Kubernetes/多机编排；不做镜像瘦身极限优化（保留全量 node_modules 换 migrate 可用性，后续可再裁）
- 不动 MySQL/Redis/nginx/PPTCreator 的部署形态
- 服务器 git checkout 保留为回滚路径（`.git` 目录不删），但日常部署不再使用它

## 9. 首次部署实施实况（2026-11-12）

实际执行顺序与结果（全部成功，冒烟 3 秒绿，零错误日志）：

1. 本地构建 `docker build --platform linux/amd64 -t codelphi-server:sha-dcea71b .`（~320MB）
2. 传输：`docker save | gzip -1 | ssh 'gunzip | docker load'`（GitHub 不可达期间的主通道，非兜底）
3. 部署件 scp 到 **`/data/www/codelphi-docker/`**：compose + deploy.sh/rollback.sh/deploy-lib.sh + `.env`（从旧目录复制后改，chmod 600）
4. `--profile migrate up migrate`：容器→VPC MySQL 链路验证 ✓，顺带应用 `067_scenario_step.sql`（并行会话 W-DECISION 的迁移随镜像首次上生产）
5. `systemctl stop/disable codelphi.service`（释放 3008，保留 unit 文件应急）→ `./deploy.sh codelphi-server:sha-dcea71b`（pull 跳过→migrate 幂等→up→smoke→state.env 记账）
6. 验证：容器 health=healthy；`/login` 200；匿名产品页 `/products/u-a8811be775/codelphi` 200（PUBLIC_DEMO_SLUGS 放行）；8 个 sweep 全启动（含 digest-weekly）；容器内 DB 查询正常（3 篇已发布稿）

### 踩坑记录（下次部署照抄）

| 坑 | 现象 | 正解 |
|---|---|---|
| `.env` 的 PORT/HOSTNAME | 旧值 `3008`/`127.0.0.1` 原样进容器 → 监听错端口、compose 端口映射失效 | 复制后必改：`PORT=3000`、`HOSTNAME=0.0.0.0` |
| host-gateway 到不了宿主 loopback | `host.docker.internal:3100` ECONNREFUSED（pptcreator-web 只绑 127.0.0.1） | PPT_PARTNER_URL 用公网域名 `https://easymakeppt.com/mcp`（同机 nginx 回环，实测 401 通） |
| compose 插值变量 | `up` 报 `CODELPHI_IMAGE required`（compose 插值不读 env_file 的 app 变量） | 显式传：`CODELPHI_IMAGE=<image> docker compose -f docker-compose.prod.yml up -d app`（deploy.sh 已封装） |

### 回滚路径（当前有效）

- **容器间回滚**：`cd /data/www/codelphi-docker && sudo ./rollback.sh`（回 PREV_GOOD_IMAGE；首次部署 prev 为空）
- **退回 systemd**：`docker compose down` 释放 3008 → `systemctl start codelphi.service`（旧 checkout + 旧 .env 仍在 `/data/www/codelphi`）


## 10. 语义流程图批次（已部署）

- 生产镜像：`codelphi-server:sha-dce6973`（含 CJS 回填入口修复）；migration `068_feature_flows.sql` 已应用，容器 healthy，部署冒烟通过。
- 单工作台 feature `9176` 回填完成：14 节点、13 边、16 个说明/重复场景独立排除；未执行全库回填。
- 线上 RepoMap 路径验收通过：主链、分支、终态清晰，连线未穿文字，节点详情与证据可用；390px 窄屏通过。
- 本地 203 个测试文件 0 真实失败、typecheck、生产构建均通过。WD-4 重放仍未执行。
