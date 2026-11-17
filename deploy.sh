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
CODELPHI_IMAGE="$IMAGE" dc --profile migrate up --exit-code-from migrate migrate

log "restart app with $IMAGE"
CODELPHI_IMAGE="$IMAGE" dc up -d app

log "smoke"
if smoke "$APP_PORT"; then
  save_state "$IMAGE"
  log "prune outdated images"
  prune_images
  log "DEPLOY OK: $IMAGE（prev=$(printf '%s' "${PREV_GOOD_IMAGE:-$LAST_GOOD_IMAGE}")）"
else
  # 回滚目标 = 部署前正在运行且冒烟通过的那个版本（LAST_GOOD_IMAGE 是 save_state 前的旧值）；
  # PREV_GOOD_IMAGE 是「上一版」，用它会把生产切到两版之前并跳过正在运行的好版本
  log "smoke FAILED；回滚"
  local_target="${LAST_GOOD_IMAGE:-}"
  if [[ -n "$local_target" ]]; then
    CODELPHI_IMAGE="$local_target" dc up -d app
    save_state "$local_target"
    die "已回滚到 $local_target；请排查镜像 $IMAGE"
  fi
  die "冒烟失败且无上一好版本（首次部署）：app 保持 $IMAGE 运行，请人工排查"
fi
