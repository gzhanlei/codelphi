#!/usr/bin/env bash
# CoDelphi 部署/回滚共享库（仿 /data/www/salesbuddy/deploy-common.sh）。
# 约定：source 后由调用方 cd 到 DEPLOY_DIR 再使用这些函数。
# 依赖：docker、docker compose；镜像已推送到 CODELPHI_IMAGE 指向的 registry。

DEPLOY_DIR="${DEPLOY_DIR:-/data/www/codelphi-docker}"
COMPOSE_FILE="docker-compose.prod.yml"
STATE_DIR=".deploy"
APP_PORT="${CODELPHI_PORT:-3008}"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }

# ── 部署锁：防止并发部署/回滚 ──
acquire_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"${STATE_DIR}/deploy.lock"
  flock -n 9 || die "另一个部署/回滚正在运行（${STATE_DIR}/deploy.lock 被占用）"
}

# ── 版本状态：last_good=当前运行且冒烟通过；prev_good=上一个好版本（rollback 默认目标） ──
load_state() {
  LAST_GOOD_IMAGE=""
  PREV_GOOD_IMAGE=""
  [[ -f "${STATE_DIR}/state.env" ]] && . "${STATE_DIR}/state.env"
  return 0
}

save_state() {
  local image="$1"
  [[ -f "${STATE_DIR}/state.env" ]] && cp "${STATE_DIR}/state.env" "${STATE_DIR}/state.env.bak"
  cat > "${STATE_DIR}/state.env" << ENVEOF
LAST_GOOD_IMAGE=${image}
PREV_GOOD_IMAGE=${LAST_GOOD_IMAGE:-}
ENVEOF
  # 同步 shell 变量：prune 守卫与后续回滚决策必须保护刚保存的状态，而非部署开始时载入的过期值
  PREV_GOOD_IMAGE="${LAST_GOOD_IMAGE:-}"
  LAST_GOOD_IMAGE="$image"
}

# 返回布尔而非 die：镜像缺失时调用方（rollback.sh 的 || true 语义）应继续让 compose 拉取，
# 函数体内的 exit 在 || true 上下文里仍会终止整个脚本（bash 语义）。
require_image() {
  local image="$1"
  [[ -n "$image" ]] || { log "ERROR: 镜像未指定（CODELPHI_IMAGE / state.env）"; return 1; }
  docker image inspect "$image" > /dev/null 2>&1 && return 0
  log "warn: 镜像不在本地，交由 compose 拉取：$image"
  return 1
}

# ── 镜像清理：删除过时的 codelphi 镜像，仅保留当前运行版本（LAST_GOOD）与回滚备用上一版本（PREV_GOOD）。
#    只匹配 codelphi-server 两种仓库前缀，不触碰同机其他项目（salesbuddy/pptcreator/mysql 等）的镜像。
prune_images() {
  local image
  while IFS= read -r image; do
    [[ -z "$image" ]] && continue
    [[ "$image" == "$LAST_GOOD_IMAGE" || "$image" == "$PREV_GOOD_IMAGE" ]] && continue
    log "prune outdated image: $image"
    docker rmi "$image" >/dev/null 2>&1 || log "prune skipped (in use or already gone): $image"
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(ghcr\.io/gzhanlei/)?codelphi-server:')
}

# ── 冒烟：/login 200 即应用可达（DB 连接在首页/问答链路各自暴露） ──
smoke() {
  local port="$1"
  for _ in 1 2 3 4 5 6; do
    sleep 3
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/login" || true)
    [[ "$code" == "200" ]] && return 0
    log "smoke retry (last=${code})"
  done
  return 1
}
