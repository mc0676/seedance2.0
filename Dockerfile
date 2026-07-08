ARG NODE_VERSION=22

# ==========================================
# 第一阶段：安装前端依赖
# ==========================================
FROM node:${NODE_VERSION}-alpine AS deps-frontend
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ==========================================
# 第二阶段：构建前端
# ==========================================
FROM deps-frontend AS frontend-build
COPY src/ ./src/
COPY index.html tsconfig.json vite.config.ts tailwind.config.js postcss.config.js ./
RUN npm run build

# ==========================================
# 第三阶段：安装后端依赖
# ==========================================
FROM node:${NODE_VERSION}-alpine AS deps-server
WORKDIR /app/server
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json* ./
RUN npm ci --production
RUN apk del python3 make g++

# ==========================================
# 第四阶段：生产镜像（后端）
# ==========================================
FROM node:${NODE_VERSION}-alpine AS backend
WORKDIR /app

RUN apk add --no-cache curl tini

COPY --from=deps-server /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/index.js ./server/
COPY server/database/ ./server/database/
COPY server/services/ ./server/services/
COPY server/cloth/ ./server/cloth/
COPY server/public/ ./server/public/

# 前端 dist 由外部 volume 挂载，此处预建空目录
RUN mkdir -p /app/dist

ENV NODE_ENV=production
ENV PORT=3001

VOLUME ["/app/server/data"]
VOLUME ["/app/dist"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
  CMD curl -f http://localhost:3001/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]

# ==========================================
# 独立阶段：仅用于导出前端构建产物
# ==========================================
FROM alpine:3 AS dist-export
COPY --from=frontend-build /app/dist /dist
CMD ["sh", "-c", "cp -r /dist/. /target/"]
