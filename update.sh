#!/bin/bash
# Seedance 2.0 - 服务器端更新部署脚本
# 放到服务器 /www/wwwroot/seedance2.0/update.sh
# 每次迭代只需：git pull && bash update.sh

set -e
cd "$(dirname "$0")"

echo "========================================="
echo "  Seedance 2.0 更新部署"
echo "========================================="

# 检测部署模式
if [ -f docker-compose.yml ] && command -v docker &> /dev/null; then
    echo "📦 Docker 模式部署..."
    docker compose down
    docker compose build --no-cache
    docker compose up -d
    echo ""
    echo "✅ 更新完成！"
    echo "   docker compose logs -f  # 查看日志"
else
    echo "📦 PM2 模式部署..."

    # 重新安装后端依赖（如果 package.json 有变化）
    cd server && npm ci --production && cd ..

    # 重新构建前端（如果前端代码有变化）
    npm ci
    npm run build

    # 重启
    pm2 restart seedance || pm2 start server/index.js --name seedance
    pm2 save

    echo ""
    echo "✅ 更新完成！"
    echo "   pm2 logs seedance  # 查看日志"
fi
