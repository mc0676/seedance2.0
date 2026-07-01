# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Seedance 2.0 Web 是一个 React + TypeScript 前端、Express + SQLite 后端的 AI 视频生成应用，包含：

- 用户注册 / 登录 / 登出 / 改密 / 积分
- 左侧导航 + 多页面路由
- 项目（工作组）/ 任务管理
- 下载管理
- 管理员后台
- 多即梦 Session 账号管理
- 严格的用户归属隔离（ownership）

## 关键约定

1. 类型入口是 `src/types/index.ts`
2. 平台登录会话存于 localStorage 键 `seedance_session_id`，用户缓存键 `seedance_user_cache`
3. 前端鉴权头使用 `X-Session-ID`
4. 项目 / 任务 / 下载按用户归属隔离，普通用户不能操作其他用户的数据
5. 任务是扁平模型：每条任务对应一次生成，属于一个项目和一个用户
6. 即梦 Session 为"每用户多账号"，解析优先级：`user_default > legacy_global > env_default > none`
7. 浏览器下载走 token 链路：`POST /file-token` → `GET /file-by-token?token=...`

## 模型配置

配置位于 `server/services/videoGenerator.js`：

| 前端 modelKey | model_req_key | benefit_type | draft version | 说明 |
|---|---|---|---|---|
| `seedance-2.0` | `dreamina_seedance_40_pro` | `dreamina_video_seedance_20_pro` | `3.3.9` | 全能模型（schema.sql 已启用） |
| `seedance-2.0-fast` | `dreamina_seedance_40` | `dreamina_seedance_20_fast` | `3.3.9` | 快速模型（schema.sql 已启用） |

VIP 模型未在 `schema.sql` 的 `model_pricing` 中插入，默认不显示。如需启用，在管理后台 → 模型计费管理中手动添加。

前端可用模型从 `/api/model-pricing` 动态拉取；`src/types/index.ts` 的 `MODEL_OPTIONS` 仅作接口失败时的兜底。

## 常用命令

```bash
npm run install:all      # 安装前后端依赖
npm run dev              # 同时启动前端 :5173 与后端 :3001
npm run dev:client       # 仅前端
npm run dev:server       # 仅后端
npx tsc --noEmit         # 前端类型检查
npm run build            # 前端构建
npm start                # 生产启动
```

## 前端结构

```text
src/
├── main.tsx
├── App.tsx
├── index.css
├── types/index.ts
├── context/AppContext.tsx
├── components/
│   ├── Sidebar.tsx
│   ├── VideoPlayer.tsx
│   └── Icons.tsx
├── pages/
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   ├── SingleTaskPage.tsx      ← 视频生成主页 /
│   ├── DownloadManagement.tsx  ← /download
│   ├── Settings.tsx            ← /settings
│   ├── ImageGenPage.tsx        ← /image-gen
│   ├── ProjectWorkspacePage.tsx
│   └── AdminPage.tsx           ← /admin
└── services/
    ├── authService.ts
    ├── videoService.ts
    ├── projectService.ts
    ├── taskService.ts
    ├── downloadService.ts
    └── settingsService.ts
```

### 路由

- `/login`、`/register`
- `/`（视频生成）、`/image-gen`、`/download`、`/settings`、`/admin`
- `* -> /`

`/admin` 仅 `admin` / `super_admin` 可访问；未登录重定向 `/login`。

### 认证与前端状态

`src/context/AppContext.tsx` 在 `currentUser` 变化时清空 projects / currentProject / tasks / currentTask / error / settings。修改认证 / 登出逻辑时同步检查 `App.tsx`、`AppContext.tsx`、`authService.ts`。

## 后端结构

```text
server/
├── index.js
├── browser-service.js
├── database/
│   ├── index.js        ← 初始化：首次运行 schema.sql，无迁移逻辑
│   └── schema.sql      ← 唯一数据库真值，所有表结构在此定义
└── services/
    ├── authService.js
    ├── projectService.js
    ├── taskService.js
    ├── settingsService.js
    ├── jimengSessionService.js
    ├── videoDownloader.js
    └── videoGenerator.js
```

**数据库初始化**：`server/database/index.js` 在首次运行（空库）时执行 `schema.sql`，无历史迁移文件。修改表结构直接改 `schema.sql`，重建容器即生效。

## 数据库核心表

以 `server/database/schema.sql` 为准，核心表：

| 表 | 说明 |
|---|---|
| `users` | 用户，含 `role`（user/admin/super_admin）、`credits`、`unlimited_credits` |
| `sessions` | 登录会话 |
| `projects` | 工作组，含 `user_id`、`video_save_path`、`default_concurrent` 等 |
| `tasks` | 任务，含 `model`、`ratio`、`duration`、`resolution`、`user_id`、`project_id` |
| `task_assets` | 任务素材，含 `original_name` |
| `jimeng_session_accounts` | 即梦账号，每用户多账号 |
| `activation_codes` | 激活码，含 `credits_value` |
| `model_pricing` | 模型积分计费配置 |
| `account_model_permissions` | 账号级模型权限 |
| `user_permissions` | 用户功能权限（如 `generate_video_seedance`） |
| `volc_key_groups` | 火山Key组，含 `volc_access_key`、`volc_secret_key` |
| `system_config` | 系统配置（SMTP、wuyin_api_key 等） |
| `credit_locks` | 积分锁定记录 |
| `asset_groups` / `project_assets` | ARK 素材组和素材 |

## 权限规则

- `super_admin`：全部权限
- `admin`：激活码管理、查看全部用户、操作 `role=user` 的普通用户（启用/禁用/积分/重置密码）
- `user`：自己的项目/任务/素材/下载

排查 ownership 问题优先看 `server/services/projectService.js`、`taskService.js`。

## 下载链路

1. 服务器侧下载：`POST /api/download/tasks/:id`
2. 浏览器下载：`POST /api/download/tasks/:id/file-token` → `GET /api/download/file-by-token?token=...`

## 开发注意事项

- 前端所有用户可见文案为中文
- 后端纯 JavaScript ESM，`npx tsc --noEmit` 只检查前端 `src/`
- 生产模式 Express 同时提供静态资源和 API
- Vite 开发环境通过 `/api -> :3001` 代理
- 首次开发需要 `npx playwright-core install chromium`

## 修改建议顺序

1. `server/database/schema.sql`
2. `src/types/index.ts`
3. `src/App.tsx` / `src/context/AppContext.tsx`
4. `src/services/*.ts` / `server/services/*.js`

## 缩略图与缓存系统

### 组件

| 文件 | 作用 |
|---|---|
| `src/components/AssetGrid.tsx` | 统一素材网格组件（视频生成/音频生成/@弹窗共用），4列平铺，上下滑动 |
| `src/utils/imageCompress.ts` | 浏览器端 Canvas 压缩工具，`compressImageToFile(file, {maxSize,quality})` |
| `src/utils/assetCache.ts` | localStorage 缓存（5min TTL），避免切换页面重拉 API |

### 数据流

```
上传: 文件 → Canvas压缩(200px) → OSS上传缩略图 → POST asset-groups 写入 thumbnail_oss_url
浏览: GET asset-groups → 返回 thumbnail_oss_url → AssetGrid 优先读缩略图
删除: DELETE asset-groups → 火山删除 → 硬删 project_assets → 删 asset_groups
```

### 关键约定

1. `asset_groups.thumbnail_oss_url` — 组封面 OSS 永久缩略图（509 条已回填）
2. `project_assets` 排序: `ag.created_at DESC, pa.created_at DESC`（先组后素材）
3. AssetGrid props: `assets`, `groupNames`, `onSelect`, `selectedUrl`
4. 审核状态：`pending` 显示遮罩不调用 API，`rejected` 置灰不可点击
5. 素材组名防重: 末尾附加火山 groupId UUID 尾段（如 `name-z2sls`），静默处理
6. `asset_groups` 分页: name 过滤 + LIMIT/OFFSET + 独立 COUNT

---

## ⚠️ 数据安全红线（AI 必读，每次操作前确认）

**以下操作绝对禁止，无论任何理由：**

1. 删除数据库 volume，**所有用户数据永久丢失**
2. 后不挂载 volume 重建 — 容器重建必须带 `-v seedance-data:/app/server/data`
3. 在服务器上执行任何覆盖 `/app/server/data/seedance.db` 的操作（`cp`、`mv`、`>`）
4. `docker run` 启动新容器时不带 `-v seedance-data` 参数
5. 用本地数据库文件 `scp` 覆盖服务器数据库

**热更新只允许以下操作：**
- 向 `seedance-dist` volume 写入新的前端静态文件（index.html / JS / CSS）
- 用 `docker cp` 或直接写 overlay UpperDir 替换 `server/index.js` / `server/services/*.js` 等后端代码文件
- `docker restart seedance-blue`（不会影响 volume 中的数据）

**每次数据库操作前，先用只读查询确认数据存在，再执行写操作。**

---

## 生产服务器

- **IP**：`47.94.174.146`
- **SSH 密钥**：项目目录下 `.ssh/yunyu_server`（已加入 .gitignore，不会上传 GitHub）
  - Windows 本地路径：`C:\Users\vomag\Pictures\2\seed\seedance2.0\.ssh\yunyu_server`
  - 也可使用原始位置：`~/.ssh/云屿`
- **SSH 连接**：`ssh -i .ssh/yunyu_server root@47.94.174.146`
- **容器名**：`seedance-blue`
- **对外端口**：`3001`
- **数据库 volume**：`seedance-data`（挂载到容器 `/app/server/data`，重启不丢失）
- **前端 volume**：`seedance-dist`（挂载到容器 `/app/dist`，路径 `/var/lib/docker/volumes/seedance-dist/_data`）

### 一键部署（推荐）

```bash
# 本地执行 — 构建前端 + 上传 + 写入容器 + 重启 + 验证，全自动
./deploy.sh
```

`deploy.sh` 封装完整流程，其他人无需记忆 scp/docker cp/volume 路径等细节。也可分步手动操作：

### 热更新（只改前端）

```bash
# 1. 本地构建
npm run build
cp -r dist/* server/public/

# 2. 上传新构建文件
scp -i .ssh/yunyu_server dist/index.html dist/assets/<新JS>.js dist/assets/<新CSS>.css root@47.94.174.146:/tmp/

# 3. 写入服务器 volume（无需重启容器）
ssh -i .ssh/yunyu_server root@47.94.174.146 "
  DIST=/var/lib/docker/volumes/seedance-dist/_data
  cp /tmp/index.html \$DIST/
  cp /tmp/<新JS>.js \$DIST/assets/
  cp /tmp/<新CSS>.css \$DIST/assets/
"
```

### 热更新（改了后端 server/*.js）

**重要：后端文件必须用 `docker cp` 直接写入容器，不能用 overlay UpperDir。Overlay 方式经多次验证不可靠，文件写入磁盘但容器不一定读取。**

```bash
# 1. 上传服务端文件到宿主机 /tmp
scp -i .ssh/yunyu_server server/index.js root@47.94.174.146:/tmp/
scp -i .ssh/yunyu_server server/services/projectService.js root@47.94.174.146:/tmp/
scp -i .ssh/yunyu_server server/database/index.js root@47.94.174.146:/tmp/

# 2. docker cp 写入容器（数据安全：只覆盖代码文件，不影响 /app/server/data/ 下的数据库）
ssh -i .ssh/yunyu_server root@47.94.174.146 "
  docker cp /tmp/index.js seedance-blue:/app/server/index.js
  docker cp /tmp/projectService.js seedance-blue:/app/server/services/projectService.js
  docker cp /tmp/db_index.js seedance-blue:/app/server/database/index.js
"

# 3. 重启容器使新代码生效
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker restart seedance-blue"
```

**数据安全说明：** `docker cp` 替换的是 `/app/server/services/*.js`、`/app/server/index.js` 等代码文件，数据库 `seedance.db` 存储在 Docker volume `seedance-data`（挂载到 `/app/server/data/`），两者路径完全隔离，互不影响。

### 重启容器

```bash
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker restart seedance-blue"
```

### 验证服务正常

```bash
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker ps && curl -s http://localhost:3001/api/status"
```

### 查看运行日志

```bash
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker logs seedance-blue --tail 50"
```

### 直接查询数据库

```bash
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker exec seedance-blue node -e \"
  const db = require('/app/server/node_modules/better-sqlite3')('/app/server/data/seedance.db');
  // 在这里写查询，例如：
  console.log(db.prepare('SELECT count(*) as c FROM users').get());
\""
```

---

## GitHub

- **Remote**：`mc0676`
- **仓库**：`https://github.com/mc0676/seedance2.0.git`
- **Token**：`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`
- **分支**：`main`

### 本地网络能连 GitHub 时

```bash
git push mc0676 HEAD
```

### 本地无法连接 GitHub（走服务器中转）

```bash
# 1. 打包本地 commits
git bundle create /tmp/seedance_push.bundle HEAD

# 2. 上传到服务器
scp -i .ssh/yunyu_server /tmp/seedance_push.bundle root@47.94.174.146:/tmp/

# 3. 从服务器推送到 GitHub
ssh -i .ssh/yunyu_server root@47.94.174.146 "
  cd /tmp
  git clone seedance_push.bundle seedance_tmp
  cd seedance_tmp
  git remote add mc0676 'https://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@github.com/mc0676/seedance2.0.git'
  git push mc0676 HEAD:main
  rm -rf /tmp/seedance_tmp /tmp/seedance_push.bundle
"
```

---

## 第三方 API

### 吴音图片生成 API

- **Key**：`PzDdXUlAiWmmtWVjWC0g8XjHD7`（存储于 DB `system_config.wuyin_api_key`）
- **安全模式**：IP 白名单（已加白：`47.94.174.146`、`112.32.64.228`）
- **认证方式**：`?key=<KEY>` + `Authorization: <KEY>` 请求头
- **提交接口**：`POST https://api.wuyinkeji.com/api/async/image_nanoBanana2?key=<KEY>`
- **查询接口**：`GET https://api.wuyinkeji.com/api/async/detail?id=<taskId>&key=<KEY>`
- **成功状态**：`data.status === 2`，`data.result` 为图片 URL 数组
- **费用**：10 积分/张（`IMAGE_GEN_COST = 10` in `server/index.js`）

### 更新吴音 Key（在生产 DB 中）

```bash
ssh -i .ssh/yunyu_server root@47.94.174.146 "docker exec seedance-blue node -e \"
  const db = require('/app/server/node_modules/better-sqlite3')('/app/server/data/seedance.db');
  db.prepare(\\\"INSERT OR REPLACE INTO system_config (key, value) VALUES ('wuyin_api_key', ?)\\\").run('新KEY');
  console.log('已更新');
\""
```
