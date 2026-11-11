#!/usr/bin/env bash
# CoDelphi 回滚：回到 state.env 里的 PREV_GOOD_IMAGE。用法：sudo ./rollback.sh
set -euo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/data/www/codelphi-docker}"
source "$(dirname "$0")/deploy-lib.sh"

acquire_lock
load_state
[[ -n "$PREV_GOOD_IMAGE" ]] || die "没有可回滚的上一版本（PREV_GOOD_IMAGE 为空）"
require_image "$PREV_GOOD_IMAGE" || true

log "rollback to $PREV_GOOD_IMAGE"
CODELPHI_IMAGE="$PREV_GOOD_IMAGE" dc up -d app

log "smoke"
if smoke "$APP_PORT"; then
  save_state "$PREV_GOOD_IMAGE"
  log "ROLLBACK OK: $PREV_GOOD_IMAGE"
else
  die "回滚后冒烟仍失败——请人工介入（docker compose logs app）"
fi
