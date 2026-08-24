#!/usr/bin/env bash
# 部署工作台到生产机：rsync web/ → 服务器 npm ci && next build → systemd 重启。
# Next 听 127.0.0.1:13000（3000 已被本机 chandler 占用）。
# nginx 分流见 deploy/nginx-codelphi-m5.conf（保留 certbot 证书行）。
set -euo pipefail

HOST="${DEPLOY_HOST:-root@124.156.160.168}"
SSH="ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> rsync web/"
$SSH "$HOST" 'mkdir -p /data/www/codelphi/web'
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .env.local --exclude .env \
  -e "ssh -o BatchMode=yes" \
  "$ROOT/web/" "$HOST:/data/www/codelphi/web/"

echo "==> web.env (before build, so NEXT_PUBLIC_* 打进中间件)"
scp -o BatchMode=yes "$ROOT/deploy/codelphi-web.service" "$HOST:/etc/systemd/system/codelphi-web.service"
$SSH "$HOST" bash -s <<'EOF'
set -euo pipefail
umask 077
ENV=/data/www/codelphi/web.env
GW=/data/www/codelphi/gateway.env
if [ ! -f "$ENV" ]; then
  AUTH=$(openssl rand -hex 32)
  python3 - "$GW" "$ENV" "$AUTH" <<'PY'
import sys
src, dst, auth = sys.argv[1], sys.argv[2], sys.argv[3]
kv = {}
with open(src) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        kv[k] = v
out = [
    "CHANDLER_CLIENT_ID=" + kv.get("CHANDLER_CLIENT_ID", ""),
    "CHANDLER_CLIENT_SECRET=" + kv.get("CHANDLER_CLIENT_SECRET", ""),
    "CHANDLER_ISSUER=" + kv.get("CHANDLER_ISSUER", "workmembership"),
    "AUTH_SECRET=" + auth,
    "GATEWAY_URL=http://127.0.0.1:18080",
    "NEXT_PUBLIC_APP_URL=https://app.codelphi.com",
]
with open(dst, "w") as f:
    f.write("\n".join(out) + "\n")
print("WEB_ENV_CREATED")
PY
else
  echo "WEB_ENV_EXISTS"
fi
chmod 600 "$ENV"
EOF

echo "==> npm ci && next build"
$SSH "$HOST" bash -s <<'EOF'
set -euo pipefail
cd /data/www/codelphi/web
export NEXT_PUBLIC_APP_URL=https://app.codelphi.com
npm ci
npm run build
EOF

echo "==> systemd + nginx"
scp -o BatchMode=yes "$ROOT/deploy/nginx-codelphi-m5.conf" "$HOST:/etc/nginx/conf.d/codelphi.conf.new"
$SSH "$HOST" bash -s <<'EOF'
set -euo pipefail
id codelphi &>/dev/null || useradd -r -s /usr/sbin/nologin codelphi
chown -R codelphi:codelphi /data/www/codelphi/web /data/www/codelphi/web.env
chmod 600 /data/www/codelphi/web.env

cp -a /etc/nginx/conf.d/codelphi.conf /etc/nginx/conf.d/codelphi.conf.bak
mv /etc/nginx/conf.d/codelphi.conf.new /etc/nginx/conf.d/codelphi.conf
nginx -t
systemctl daemon-reload
systemctl enable codelphi-web
systemctl restart codelphi-web
systemctl --no-pager --quiet is-active codelphi-web && echo WEB_SERVICE_ACTIVE
systemctl reload nginx
echo NGINX_RELOADED
EOF

echo "==> health"
$SSH "$HOST" 'sleep 1; echo -n "gateway "; curl -sf http://127.0.0.1:18080/healthz; echo; echo -n "web "; curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:13000/login; echo'
echo "==> done"
