# Seedance 2.0 前端性能审计 & 修复报告

> **日期**: 2026-07-01  
> **审计范围**: `seedance2.0` 前端 (`src/`) + 后端 (`server/index.js`)  
> **说明**: `seedance-sandbox` 已废弃，不再维护

---

## 一、已修复的 Bug（本轮会话）

### 1.1 setMentionQuery 未定义 → ReferenceError

| 项 | 详情 |
|---|------|
| **文件** | `src/pages/SingleTaskPage.tsx:345` |
| **问题** | 点击失效 @ 素材 chip 时调用未声明的 `setMentionQuery('')`，触发 ReferenceError，打断 @ 面板 |
| **修复** | 删除该行，仅保留 `setShowMention(true)` + `setMentionFocusIdx(-1)` |

### 1.2 @音色 fileType=audio 过滤失灵

| 项 | 详情 |
|---|------|
| **文件** | `src/pages/SingleTaskPage.tsx:1663` |
| **问题** | 用户 @ 引用 image 类型素材做声音参考，`activeAssetAudUri` 只匹配 `fileType==='audio'`，导致 `audioUrl` 为空 |
| **修复** | 新增 `chipHasVoiceContext()` 检测 chip 附近语音关键词（声音/语音/语气/配音等），audio 引用改为两阶段：先匹配 audio 类型 → 再匹配有语音上下文的非 audio 资产 |

### 1.3 素材组过滤后仍显示全部资产

| 项 | 详情 |
|---|------|
| **文件** | `src/pages/SingleTaskPage.tsx:1991` |
| **问题** | 选中素材组后 `AssetGrid` 渲染 `gridAssets`（全量）而非 `mentionableAssets`（过滤后） |
| **修复** | `assets={gridAssets}` → `assets={mentionableAssets}` |

### 1.4 复用素材序号错位匹配

| 项 | 详情 |
|---|------|
| **文件** | `src/pages/SingleTaskPage.tsx:2540-2560` |
| **问题** | `assetRefs[idx]` 与 `tagMatches[idx]` 按索引对应，但后端返回的 assets 顺序与 prompt 中 tag 顺序不一定一致，导致错位 |
| **修复** | 改为 `tagMatches.find(tag => tag.includes(volcId))` 按 volc_asset_id 精确匹配 |

### 1.5 历史视频卡片过期 URL 洪水

| 项 | 详情 |
|---|------|
| **文件** | `src/pages/SingleTaskPage.tsx:2288, 2358` |
| **问题** | 历史列表中 `<video preload="metadata">` 自动发起 HTTP 请求到已过期的火山签名 URL → 10-16 个 ERR_ABORTED 并发阻塞 |
| **修复** | `preload="metadata"` → `preload="none"`，仅在 hover 时加载 |

### 1.6 后端缩略图刷新死循环

| 项 | 详情 |
|---|------|
| **文件** | `server/index.js:8075` |
| **问题** | `refreshAssetThumbnailsToOss()` 每 30s 对 10 个已删除的火山素材调用 `GetAsset` API，全部返回 not found → 死循环日志 |
| **修复** | not found 时静默跳过，不标记素材状态（之前过度修复标记 `status='deleted'` 已回滚） |

### 1.7 轮询优化

| 文件 | 修复 |
|------|------|
| `src/App.tsx:140` | 维护轮询增加 `visibilitychange` 暂停 |
| `src/pages/SingleTaskPage.tsx:962` | 历史刷新轮询增加 `visibilitychange` 暂停 |

---

## 二、性能审计结果（已验证）

### 2.1 渲染性能

#### 🔴 AdminPage（3360 行，119 个 useState）

| 指标 | 值 |
|------|---|
| useState | **119** |
| useMemo | **0** |
| useCallback | **0** |
| React.memo | **无** |
| 子组件拆分 | **0**（全部内联） |

**影响**: 任何一个 `setXxx()` → 整个 3360 行组件 + 所有内联面板重渲染。搜索、翻页、切换 Tab 全部全量渲染。

#### 🔴 CanvasEditorPage（2994 行，31 个 useState）

| 指标 | 值 |
|------|---|
| useState | **31** |
| useMemo | **0** |
| useCallback | **18**（但无 memo 配合，效果有限） |
| React.memo | **无** |
| 内联箭头函数 | **86** |

**影响**: 拖拽一个画布节点 → 31 个状态可能在同一帧修改 → 多次全组件重渲染。86 个内联 `onClick={() => ...}` 每次渲染创建新函数引用。

#### 🔴 SingleTaskPage（2661 行，36 个 useState）

| 指标 | 值 |
|------|---|
| useState | **36** |
| useMemo | **7** |
| 内联函数 | 大量 |

**影响**: 资产选择、prompt 输入、积分估算等状态变化互相触发重渲染。

#### 🟡 其他大型组件

| 文件 | 行数 | useState |
|------|------|----------|
| `HappyHorsePage.tsx` | 1683 | 24 |
| `CanvasConfigNodePanel.tsx` | 1345 | - |
| `ProjectWorkspacePage.tsx` | 1056 | 45 |
| `ImageGenPage.tsx` | 1047 | 17 |
| `DownloadManagement.tsx` | 918 | - |

### 2.2 零优化基础设施

| 特性 | 全项目状态 |
|------|-----------|
| `React.memo` | **0 个页面 / 0 个组件** |
| `ErrorBoundary` | **0 个** |
| `<Suspense>` | **0 个** |
| `React.lazy` | **0 处** |

**影响**:
- 无 memo → 父组件任何重渲染级联到所有子组件
- 无 Error Boundary → 一个组件抛异常，整个 App 白屏
- 无 lazy/Suspense → 1.7 MB JS 首屏全量加载

### 2.3 轮询统计

| 文件 | setInterval 数量 |
|------|-----------------|
| `SingleTaskPage.tsx` | 3 |
| `App.tsx` | 2 |
| `DownloadManagement.tsx` | 2 |
| `HappyHorsePage.tsx` | 2 |
| `ProjectWorkspacePage.tsx` | 2 |
| `AudioGenPage.tsx` | 1 |
| `EnhancementPage.tsx` | 1 |
| `ImageGenPage.tsx` | 1 |
| `CanvasAudioPromptPanel.tsx` | 1 |
| `CanvasConfigNodePanel.tsx` | 1 |
| `CanvasVideoPromptPanel.tsx` | 1 |
| **总计** | **17** |

> 已修复 App.tsx 和 SingleTaskPage.tsx 的 visibility 暂停（共 5 个），其余 12 个未处理。

### 2.4 包体积

| 文件 | 大小 |
|------|------|
| `index-CMZr0ZH_.js`（最新） | **1685 KB** |
| 旧构建残留 | 445-447 KB × 5 个 |
| `server/public/assets/` | **11 个文件**（应该只有 2 个） |

**依赖分析**（估算）:
| 包 | 大小 |
|----|------|
| `xlsx` | ~500 KB |
| `@xyflow/react` | ~400 KB |
| `react-markdown` + `remark-gfm` | ~300 KB |
| `lamejs` | ~100 KB |
| `react` + `react-dom` + `react-router` | ~150 KB |
| 业务代码 | ~235 KB |

### 2.5 代码质量

| 问题 | 数量 |
|------|------|
| useEffect 缺少 cleanup（setInterval/addEventListener） | **5 个** |
| 内联箭头函数（CanvasEditor 86 + Admin 73 + ...） | **200+** |
| 超过 500 行的组件 | **9 个** |

---

## 三、修复建议（按优先级）

### P0 — 立即修复（用户可感知的卡顿）

| 序号 | 任务 | 文件 | 预估改动 |
|------|------|------|----------|
| 1 | `React.memo` 包裹所有页面和重度组件 | 全部 src/pages/ + src/components/ | 每文件 1 行 |
| 2 | `ErrorBoundary` 全局包裹 | 新建 `src/components/ErrorBoundary.tsx` + App.tsx | ~30 行 |

### P1 — 显著改善

| 序号 | 任务 | 文件 | 预估改动 |
|------|------|------|----------|
| 3 | `React.lazy` + `<Suspense>` 路由分割 | `App.tsx` | ~40 行 |
| 4 | Vite `manualChunks` 分包 | `vite.config.ts` | ~15 行 |
| 5 | 所有轮询加 `visibilitychange` | 6 个页面 | 每处 ~10 行 |
| 6 | 历史列表虚拟化 | `SingleTaskPage` / `ImageGenPage` / `AudioGenPage` | 中等 |
| 7 | 清理 `server/public/assets/` 旧构建 | 终端 | `rm` 命令 |

### P2 — 架构优化

| 序号 | 任务 | 文件 | 预估改动 |
|------|------|------|----------|
| 8 | `AdminPage` 拆分为多个 Tab 子组件 | `AdminPage.tsx` | 大 |
| 9 | `CanvasEditorPage` 拆分为独立面板 | `CanvasEditorPage.tsx` | 大 |
| 10 | `useState` → `useReducer` 合并相关状态 | 全项目 | 大 |
| 11 | Icons.tsx 替换为 `lucide-react` 按需导入 | `Icons.tsx` | 中 |
| 12 | 5 个 useEffect 补充 cleanup | 各文件 | 每处 ~3 行 |

---

## 四、GitHub 提交记录

所有修复已提交并推送到 `mc0676/main`：

```
commit f7d3b5a: "fix: @asset reuse, perf, and deploy improvements"
  - fix: setMentionQuery undefined → removed dead code
  - fix: @audio fileType filtering → voice context detection
  - fix: asset group filtering → use mentionableAssets
  - fix: reuse index mismatch → volcId-based tag matching
  - fix: video preload=metadata → preload=none
  - fix: thumbnail refresh → silent skip (no status change)
  - perf: maintenance + history polling → visibilitychange pause
  - fix: cloth router position in server/index.js
  - chore: deploy.sh improvements
```

---

## 五、补充说明

### 缩略图刷新问题
`server/index.js:8031` 的 `refreshAssetThumbnailsToOss()` 每次请求 `/api/projects/:id/assets` 时触发，对无 OSS 缩略图的素材调用火山 `GetAsset` API。本地数据库中 10 个素材的火山侧已删除（生产同步残留），导致每次返回 not found。**已改为静默跳过，不标记素材状态**。重启服务器后生效。

### 素材复用失效问题
复用逻辑中 `currentProjectAssets` 过滤 `review_status !== 'rejected'`，而素材网格面板不过滤该字段。两条路径过滤条件不一致。当前数据库所有素材均为 `active`/`approved`，问题已恢复。

### sandbox 版本
`seedance-sandbox/` 目录已废弃，不再同步修复。
