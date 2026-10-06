#!/usr/bin/env bash
# Ship the keeper to a VPS and (re)start it under pm2. Usage: bash deploy-vps.sh user@your-vps
# Needs: ssh key auth, Node 22 + pm2 on the box (pm2 is installed if missing), keeper/.env and
# keeper/deployments.json prepared locally (deploy.sh does this).
set -euo pipefail
VPS="${1:?usage: deploy-vps.sh user@host}"
DIR="${REMOTE_DIR:-/home/ubuntu/zkbnb-keeper}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${PM2_NAME:-zkbnb-keeper}"

test -f "$HERE/.env" || { echo "keeper/.env missing"; exit 1; }
test -f "$HERE/deployments.json" || { echo "keeper/deployments.json missing"; exit 1; }

echo "== packing"
TAR="$(mktemp -t zkbnb-keeper-XXXX).tgz"
tar -C "$HERE" -czf "$TAR" --exclude node_modules --exclude snapshots --exclude dist .

echo "== uploading to $VPS:$DIR"
ssh -o BatchMode=yes "$VPS" "mkdir -p '$DIR'"
scp -o BatchMode=yes "$TAR" "$VPS:/tmp/zkbnb-keeper.tgz"
rm -f "$TAR"

echo "== installing and starting"
ssh -o BatchMode=yes "$VPS" bash -s <<EOF
set -e
cd '$DIR'
tar -xzf /tmp/zkbnb-keeper.tgz && rm -f /tmp/zkbnb-keeper.tgz
command -v pm2 >/dev/null || sudo npm i -g pm2
npm ci >/dev/null 2>&1 || npm i >/dev/null   # full install: the keeper runs through tsx (a dev dependency)
pm2 delete grove-keeper >/dev/null 2>&1 || true
pm2 delete '$NAME' >/dev/null 2>&1 || true
PM2_NAME='$NAME' pm2 start ecosystem.config.cjs
pm2 save >/dev/null
pm2 status '$NAME'
EOF
echo "== done: ssh $VPS 'pm2 logs $NAME --lines 50'"
