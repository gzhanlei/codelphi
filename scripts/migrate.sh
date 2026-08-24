#!/usr/bin/env bash
# 数据库迁移。用法：scripts/migrate.sh "<mysql-dsn>"   （不传则读 $MYSQL_DSN）
set -euo pipefail
DSN="${1:-${MYSQL_DSN:?need MYSQL_DSN}}"
exec goose -dir db/migrations mysql "$DSN" up
