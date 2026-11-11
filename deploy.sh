#!/usr/bin/env bash
# CoDelphi 部署（Docker）：拉镜像 → 迁移（幂等）→ 切换 → 冒烟 → 记状态。
# 失败自动回滚到上一镜像（若有）。用法：sudo ./deploy.sh <image>
set -euo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/data/www/codelphi-docker}"
source "$(dirname "$0")/deploy-lib.sh"

IMAGE="${1:-}"
[[ -n "$IMAGE" ]] || die "用法：./deploy.sh <image>（如 ghcr.io/gzhanlei/codelphi-server:sha-043f688）"
acquire_lock
load_state
[[ "$IMAGE" != "$LAST_GOOD_IMAGE" ]] || die "该镜像已是当前运行版本：$IMAGE"

log "pull $IMAGE"
dc pull app 2>/dev/null || true

log "migrate（幂等）"
CODELPHI_IMAGE="$IMAGE" dc --profile migrate up migrate

log "restart app with $IMAGE"
CODELPHI_IMAGE="$IMAGE" dc up -d app

log "smoke"
if smoke "$APP_PORT"; then
  save_state "$IMAGE"
  log "DEPLOY OK: $IMAGE（prev=$(printf '%s' "${PREV_GOOD_IMAGE:-$LAST_GOOD_IMAGE}")）"
else
  log "smoke FAILED；回滚"
  if [[ -n "${PREV_GOOD_IMAGE:-}" ]]; then
    CODELPHI_IMAGE="$PREV_GOOD_IMAGE" dc up -d app
  fi
  dc down 2>/dev/null || true
  CODELPHI_IMAGE="$PREV_GOOD_IMAGE" dc up -d app
  save_state "$PREV_GOOD_IMAGE"
  die "已回滚到 ${PREV_GOOD_IMAGE:-（无上一版本）}；请排查镜像 $IMAGE"
fi
