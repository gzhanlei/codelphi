#!/usr/bin/env bash
# 部署 gateway 到生产机（默认 root@124.156.160.168，VM-32-3）。
# 流程：本机交叉编译 linux/amd64 静态二进制 → scp → 原子替换 → systemctl 重启。
# 不依赖 Docker（本机与服务器都不需要）。
# 服务器约定：
#   /data/www/codelphi/gateway.env   环境变量（MYSQL_DSN、MEDIA_SIGNING_KEY 等，不进仓库）
#   /data/www/codelphi/storage       local 存储驱动的数据目录
#   /etc/systemd/system/codelphi-gateway.service（deploy/codelphi-gateway.service）
#   nginx: app.codelphi.com → 127.0.0.1:18080（deploy/nginx-codelphi.conf；
#   8080–8084 已被该机其他服务占用，故用 18080）
set -euo pipefail

HOST="${DEPLOY_HOST:-root@124.156.160.168}"
SSH="ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
SCP="scp -o BatchMode=yes"

echo "==> build linux/amd64"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o dist/gateway ./cmd/gateway

echo "==> ship to $HOST"
$SCP dist/gateway "$HOST:/data/www/codelphi/gateway.new"
$SCP deploy/codelphi-gateway.service "$HOST:/etc/systemd/system/codelphi-gateway.service"

echo "==> swap & restart"
$SSH "$HOST" bash -s <<'EOF'
set -euo pipefail
cd /data/www/codelphi
id codelphi &>/dev/null || useradd -r -s /usr/sbin/nologin codelphi
mv gateway.new gateway
chmod +x gateway
chown -R codelphi:codelphi /data/www/codelphi
systemctl daemon-reload
systemctl enable codelphi-gateway
systemctl restart codelphi-gateway
systemctl --no-pager --quiet is-active codelphi-gateway && echo SERVICE_ACTIVE
EOF

echo "==> health check"
$SSH "$HOST" 'sleep 1; curl -sf http://127.0.0.1:18080/healthz && echo'
echo "==> done"
