#!/bin/bash
# ============================================================
# Seedance 2.0 一键部署脚本（Docker 热更新）
# 用法:
#   本地部署:  ./deploy.sh
#   服务器部署: scp deploy.sh root@IP:/tmp/ && ssh root@IP 'bash /tmp/deploy.sh server'
#
# 前提: 本地需有 .ssh/yunyu_server
# ============================================================
set -euo pipefail

SERVER_IP="47.94.174.146"
SSH_KEY=".ssh/yunyu_server"
CONTAINER="seedance-blue"
DIST_VOLUME="/var/lib/docker/volumes/seedance-dist/_data"

red()   { echo -e "\033[31m$1\033[0m"; }
green() { echo -e "\033[32m$1\033[0m"; }

MODE="${1:-local}"  # local | server

if [ "$MODE" = "server" ]; then
  # ==============================================
  # 服务器模式：已在服务器上，直接操作容器
  # ==============================================
  echo "========================================="
  echo "  Seedance 2.0 服务器部署"
  echo "========================================="

  SRC="${2:-/tmp/seedance_deploy}"
  if [ ! -d "$SRC" ]; then
    red "❌ 缺少部署文件目录: $SRC"
    echo "   请先从本地 scp 文件到此目录"
    exit 1
  fi

  # 前端 → volume
  cp "$SRC/dist/index.html" "$DIST_VOLUME/"
  cp "$SRC/dist/assets/"*.js "$DIST_VOLUME/assets/"
  cp "$SRC/dist/assets/"*.css "$DIST_VOLUME/assets/"
  green "  ✓ 前端已写入"

  # 后端 → 容器
  docker exec "$CONTAINER" mkdir -p /app/server/cloth
  docker cp "$SRC/server/index.js" "$CONTAINER:/app/server/index.js"
  docker cp "$SRC/server/database/index.js" "$CONTAINER:/app/server/database/index.js"
  docker cp "$SRC/server/database/schema.sql" "$CONTAINER:/app/server/database/schema.sql"
  [ -f "$SRC/server/cloth/controller.js" ] && docker cp "$SRC/server/cloth/controller.js" "$CONTAINER:/app/server/cloth/controller.js"
  for f in "$SRC/server/services/"*.js; do
    docker cp "$f" "$CONTAINER:/app/server/services/$(basename $f)"
  done
  green "  ✓ 后端已写入"

  docker restart "$CONTAINER"
  sleep 5

  if curl -sf http://localhost:3001/ > /dev/null; then
    green "✅ 部署成功 — http://localhost:3001"
  else
    red "❌ 部署失败，查看日志: docker logs $CONTAINER --tail 30"
    exit 1
  fi

else
  # ==============================================
  # 本地模式：构建 → scp → 远程执行
  # ==============================================
  echo "========================================="
  echo "  Seedance 2.0 本地构建 + 远程部署"
  echo "========================================="

  if [ ! -f "$SSH_KEY" ]; then
    red "❌ 缺少 SSH 密钥: $SSH_KEY"
    exit 1
  fi
  SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no"
  SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no root@$SERVER_IP"
  TMPDIR="/tmp/seedance_deploy"

  # 1. 构建前端
  echo "[1/3] 构建前端..."
  npx vite build
  green "  ✓ dist/"

  # 2. 打包上传
  echo "[2/3] 打包上传..."
  $SSH "rm -rf $TMPDIR && mkdir -p $TMPDIR/dist/assets $TMPDIR/server/services $TMPDIR/server/database $TMPDIR/server/cloth"

  $SCP dist/index.html "root@$SERVER_IP:$TMPDIR/dist/"
  $SCP dist/assets/*.js "root@$SERVER_IP:$TMPDIR/dist/assets/"
  $SCP dist/assets/*.css "root@$SERVER_IP:$TMPDIR/dist/assets/"
  $SCP server/index.js "root@$SERVER_IP:$TMPDIR/server/"
  $SCP server/database/index.js "root@$SERVER_IP:$TMPDIR/server/database/"
  $SCP server/database/schema.sql "root@$SERVER_IP:$TMPDIR/server/database/"
  [ -f server/cloth/controller.js ] && $SCP server/cloth/controller.js "root@$SERVER_IP:$TMPDIR/server/cloth/"
  for f in server/services/*.js; do
    $SCP "$f" "root@$SERVER_IP:$TMPDIR/server/services/"
  done
  green "  ✓ 已上传"

  # 3. 远程部署
  echo "[3/3] 远程部署..."
  $SSH "bash /tmp/seedance_deploy/../deploy.sh server $TMPDIR" 2>/dev/null || \
  $SSH "bash -s server $TMPDIR" < "$0"
fi
