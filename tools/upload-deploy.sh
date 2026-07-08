#!/bin/bash
# ============================================================
# 本地执行：上传并触发深夜部署
# 用法: bash tools/upload-deploy.sh
# ============================================================
set -euo pipefail

SERVER="root@47.94.174.146"

echo "=== 上传部署包到服务器 ==="

# 1. 上传 Docker 镜像
echo "[1/4] 上传 Docker 镜像 (75MB)..."
scp seedance2.0.tar $SERVER:/tmp/seedance2.0.tar

# 2. 上传前端文件
echo "[2/4] 上传前端文件..."
ssh $SERVER "rm -rf /tmp/deploy-dist && mkdir -p /tmp/deploy-dist/assets"
scp dist/index.html $SERVER:/tmp/deploy-dist/index.html
scp dist/assets/index-BHg_sMdV.js $SERVER:/tmp/deploy-dist/assets/index-BHg_sMdV.js

# 3. 上传部署脚本
echo "[3/4] 上传部署脚本..."
scp tools/deploy-night.sh $SERVER:/tmp/deploy-night.sh
ssh $SERVER "chmod +x /tmp/deploy-night.sh"

# 4. 检查服务器是否空闲
echo "[4/4] 检查服务器状态..."
ssh $SERVER "docker logs seedance-web --tail 5 2>&1"

echo ""
echo "=== 上传完成 ==="
echo ""
echo "深夜部署时，SSH 到服务器执行:"
echo "  ssh $SERVER"
echo "  bash /tmp/deploy-night.sh"
