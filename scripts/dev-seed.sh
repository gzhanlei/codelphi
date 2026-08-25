#!/bin/sh
# 写入本地 MySQL 联调机构（chandler_sub=dev-local）。生产勿跑。
set -e
cd "$(dirname "$0")/.."
if [ -n "$MYSQL_DSN" ]; then
  echo "using MYSQL_DSN; prefer: mysql ... < scripts/dev-seed.sql"
fi
mysql -h127.0.0.1 -uroot "${MYSQL_DATABASE:-codelphi}" < "$(dirname "$0")/dev-seed.sql"
echo "seeded org 本地联调机构 / member sub=dev-local"
echo "gateway: export CODELPHI_DEV_AUTH_SUB=dev-local"
echo "web:     DEV_AUTH=1 in web/.env.local"
echo "tui:     go run ./cmd/devtui -textbook 课文.md -until ready"
