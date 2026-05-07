# 服务器更新指南（不影响数据库）

数据库存储在 Docker named volume `seedance-data` 中，与容器镜像完全分离。  
只要不执行 `docker volume rm`，更新镜像不会影响任何数据。

---

## 本地操作（每次更新执行一次）

**1. 构建新镜像并导出**

```bash
cd seedance2.0

# 构建镜像
docker build -t seedance2.0:latest .

# 导出为压缩包
docker save seedance2.0:latest | gzip > ../seedance2.0-new.tar.gz
```

**2. 手动将 `seedance2.0-new.tar.gz` 上传到服务器**

---

## 服务器操作（上传完成后执行）

**3. 加载新镜像**

```bash
docker load < seedance2.0-new.tar.gz
```

**4. 停止并删除旧容器（volume 不受影响）**

```bash
docker stop seedance-web
docker rm seedance-web
```

**5. 用新镜像启动容器**

```bash
docker run -d \
  --name seedance-web \
  -p 3001:3001 \
  -v seedance-data:/app/server/data \
  --restart unless-stopped \
  --health-cmd="curl -f http://localhost:3001/api/health || exit 1" \
  --health-interval=30s \
  --health-retries=3 \
  seedance2.0:latest
```

**6. 验证**

```bash
# 查看容器状态
docker ps

# 查看启动日志
docker logs seedance-web

# 确认数据库文件存在
docker exec seedance-web ls /app/server/data
```

---

## 快速一键命令（步骤 3-5 合并）

```bash
docker load < /root/seedance2.0-new.tar.gz && \
docker stop seedance-web && \
docker rm seedance-web && \
docker run -d \
  --name seedance-web \
  -p 3001:3001 \
  -v seedance-data:/app/server/data \
  --restart unless-stopped \
  seedance2.0:latest
```

---

## 关键说明

| 操作 | 数据库是否受影响 |
|------|----------------|
| `docker stop / rm` | ✅ 不影响（数据在 volume） |
| `docker build / load` | ✅ 不影响 |
| `docker run`（带 `-v`） | ✅ 不影响 |
| `docker volume rm seedance-data` | ❌ **会删除数据，禁止执行** |
| `docker run` 不带 `-v` 参数 | ❌ **容器内数据不持久** |
