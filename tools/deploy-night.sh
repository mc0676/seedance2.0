#!/bin/bash
# ============================================================
# Seedance 2.0 深夜部署脚本
# 用法: 在服务器上执行 bash /tmp/deploy-night.sh
# 
# 部署包内容（需提前上传到 /tmp/）：
#   /tmp/seedance2.0.tar     - Docker 镜像
#   /tmp/deploy-dist/         - 前端构建产物
#     ├── index.html
#     ├── assets/index-BHg_sMdV.js
#     └── assets/index-ARFP0_tn.css
# ============================================================
set -euo pipefail

CONTAINER="seedance-web"
IMAGE="seedance2.0:latest"
DIST_VOLUME="/var/lib/docker/volumes/seedance-dist/_data"

echo "========================================="
echo "  Seedance 2.0 深夜部署"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# 1. 加载新镜像
echo "[1/6] 加载 Docker 镜像..."
docker load -i /tmp/seedance2.0.tar
echo "  ✓ 镜像已加载"

# 2. 停止旧容器
echo "[2/6] 停止旧容器..."
docker stop $CONTAINER || true
docker rm $CONTAINER || true
echo "  ✓ 旧容器已停止"

# 3. 启动新容器
echo "[3/6] 启动新容器..."
docker run -d \
  --name $CONTAINER \
  --restart unless-stopped \
  -p 3001:3001 \
  -v seedance-data:/app/server/data \
  -v seedance-dist:/app/dist \
  -e NODE_ENV=production \
  -e PORT=3001 \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --health-cmd="curl -f http://localhost:3001/api/health || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --health-start-period=10s \
  $IMAGE
echo "  ✓ 容器已启动"

# 4. 等待容器就绪
echo "[4/6] 等待服务就绪..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "  ✓ 服务就绪 (${i}s)"
    break
  fi
  sleep 1
done

# 5. 更新前端文件
echo "[5/6] 更新前端文件..."
cp /tmp/deploy-dist/index.html $DIST_VOLUME/index.html
cp /tmp/deploy-dist/assets/index-BHg_sMdV.js $DIST_VOLUME/assets/index-BHg_sMdV.js
# CSS 未变，跳过
echo "  ✓ 前端文件已更新"

# 6. 清理旧前端文件
echo "[6/6] 清理旧文件..."
# 删除旧的 JS 文件（保留新文件 BHg_sMdV）
find $DIST_VOLUME/assets/ -name 'index-*.js' ! -name 'index-BHg_sMdV.js' -delete 2>/dev/null || true
# 删除旧的 CSS 文件（保留新文件 ARFP0_tn）
find $DIST_VOLUME/assets/ -name 'index-*.css' ! -name 'index-ARFP0_tn.css' -delete 2>/dev/null || true
# 清理服务器临时文件
rm -f /tmp/seedance2.0.tar
rm -rf /tmp/deploy-dist
echo "  ✓ 清理完成"

echo ""
echo "========================================="
echo "  部署完成!"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
echo ""
echo "验证: curl http://localhost:3001/api/health"
docker ps --filter name=$CONTAINER --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
