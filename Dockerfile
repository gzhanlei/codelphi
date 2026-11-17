# CoDelphi 生产镜像（docs/docker-migration-plan.md）
# 多阶段：deps → build（standalone）→ runner（自包含产物 + 全量 node_modules 供 db:migrate）
# node:24 = 当前 LTS（node:20 已 EOL）；apt-get upgrade 拉 Debian 安全补丁
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN NEXT_OUTPUT_STANDALONE=1 npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
# 系统库安全补丁（perl/gnutls/pcre2/libc/tzdata 等）+ 升级 npm 以更新其内置依赖（tar/undici 等）
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@latest
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# 全量 node_modules：db:migrate（tsx + scripts）在一次性 migrate 容器里跑
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY package.json next.config.ts tsconfig.json ./
COPY scripts ./scripts
COPY migrations ./migrations
COPY lib ./lib
RUN mkdir -p /app/.next && chown -R 1000:1000 /app
USER 1000
EXPOSE 3000
CMD ["node", "server.js"]
