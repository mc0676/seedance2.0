#!/bin/bash
# Seedance 2.0 - 宝塔面板一键部署脚本
# 使用方法：将整个 deploy/ 目录上传到服务器后执行此脚本
# bash /www/wwwroot/seedance2.0/deploy.sh

set -e

APP_DIR="/www/wwwroot/seedance2.0"
DATA_DIR="$APP_DIR/server/data"

echo "========================================="
echo "  Seedance 2.0 宝塔部署脚本"
echo "========================================="

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未安装 Node.js，请在宝塔面板 → 软件商店 → Node.js版本管理器 中安装 Node.js 22"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. 安装编译依赖（better-sqlite3 需要）
echo "📦 安装编译依赖..."
if command -v yum &> /dev/null; then
    yum install -y gcc-c++ make python3 2>/dev/null || true
elif command -v apt-get &> /dev/null; then
    apt-get update && apt-get install -y g++ make python3 2>/dev/null || true
fi

# 3. 安装后端依赖
echo "📦 安装后端依赖..."
cd "$APP_DIR/server"
npm install --production

# 4. 创建数据目录
mkdir -p "$DATA_DIR"

# 5. 安装 PM2（如果不存在）
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装 PM2..."
    npm install -g pm2
fi

# 6. 启动/重启应用
echo "🚀 启动应用..."
cd "$APP_DIR"
pm2 delete seedance 2>/dev/null || true
pm2 start server/index.js --name seedance \
    --env production \
    -- --port 3001
pm2 save

echo ""
echo "========================================="
echo "  ✅ 部署完成！"
echo "========================================="
echo ""
echo "  访问地址: http://服务器IP:3001"
echo "  管理员:   admin@seedance.com / admin123456"
echo ""
echo "  ⚠️  请登录后立即："
echo "  1. 修改管理员密码"
echo "  2. 在设置页面添加火山引擎 ARK API Key"
echo ""
echo "  PM2 管理命令："
echo "    pm2 status        # 查看状态"
echo "    pm2 logs seedance # 查看日志"
echo "    pm2 restart seedance # 重启"
echo ""
echo "  Nginx 反向代理配置（宝塔 → 网站 → 反向代理）："
echo "    代理地址: http://127.0.0.1:3001"
echo ""
