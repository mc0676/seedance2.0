# 火山 AI MediaKit 画质增强 API 异常报告

**报告时间：** 2026-05-11 10:30（北京时间）  
**问题类型：** 任务长时间卡在 `running` 状态，无任何结果或错误返回  
**复现次数：** 2 次（相同视频，不同 task_id，均复现）

---

## 一、问题描述

调用 MediaKit 画质增强接口提交任务后，任务状态长时间停留在 `running`，**超过 21 小时仍未返回 `completed` 或 `failed`**，且响应体中无 `result`、无 `error`、无任何进度信息。

同一视频来源已连续复现两次：

| 次数 | 提交时间（北京） | MediaKit Task ID | 最终状态 | 持续时长 |
|------|----------------|-----------------|---------|---------|
| 第 1 次 | 2026-05-09 18:29:38 | amk-tool-enhance-video-65501089026 | 超时（客户端主动放弃）| >9 小时 |
| 第 2 次 | 2026-05-10 13:04:09 | amk-tool-enhance-video-28481917186 | 仍在 running | >21 小时（截至报告时）|

---

## 二、接口信息

### 2.1 Base URL

```
https://mediakit.cn-beijing.volces.com/api/v1
```

### 2.2 认证方式

```
Authorization: Bearer <MEDIAKIT_API_KEY>
Content-Type: application/json
```

---

## 三、提交请求（第 2 次，task_id: amk-tool-enhance-video-28481917186）

### 请求

**Method:** `POST`  
**URL:** `https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video`

**请求头：**
```
Authorization: Bearer AKLTYTA3ZjQ0NjU***（已脱敏）
Content-Type: application/json
```

**请求体（完整 JSON）：**
```json
{
  "video_url": "https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/seedance/2026-05-10/enhancement/1778389448457_source.mp4",
  "scene": "aigc",
  "tool_version": "standard",
  "resolution": "1080p",
  "client_token": "<随机UUID，每次提交唯一生成>"
}
```

**参数说明：**
- `video_url`：已转存至阿里云 OSS 的稳定 URL（非临时签名链接，无过期时间），视频时长 4 秒，格式 mp4
- `scene`：`aigc`（AIGC 生成视频场景）
- `tool_version`：`standard`（标准版，文档标注 RTF≈10）
- `resolution`：`1080p`
- `client_token`：每次提交唯一，防止接口静默复用旧任务

### 响应

**HTTP Status:** `200 OK`

**响应体（完整 JSON）：**
```json
{
  "task_id": "amk-tool-enhance-video-28481917186"
}
```

**提交时间（北京）：** 2026-05-10 13:04:09  
**对应 Unix 时间戳（接口返回）：** `1778389444`

---

## 四、查询请求（多次轮询，均相同结果）

### 请求

**Method:** `GET`  
**URL:** `https://mediakit.cn-beijing.volces.com/api/v1/tasks/amk-tool-enhance-video-28481917186`

**请求头：**
```
Authorization: Bearer AKLTYTA3ZjQ0NjU***（已脱敏）
```

**请求体：** 无

### 响应（每次查询均返回相同内容）

**HTTP Status:** `200 OK`

**响应体（完整 JSON）：**
```json
{
  "success": true,
  "task_id": "amk-tool-enhance-video-28481917186",
  "task_type": "enhance-video",
  "status": "running",
  "created_at": 1778389444,
  "request_id": "20260510130404A797C44E1EA8C430C4F0"
}
```

**异常点：**
- `status` 始终为 `running`，从未变更
- 响应中 **无 `result` 字段**
- 响应中 **无 `error` 字段**
- 响应中 **无进度百分比或预计完成时间**
- `request_id` 每次查询均相同（`20260510130404A797C44E1EA8C430C4F0`），疑似接口缓存了首次响应

### 轮询记录（北京时间）

| 查询时间 | 返回 status | 返回 result | 返回 error |
|---------|------------|------------|-----------|
| 2026-05-10 13:xx | running | 无 | 无 |
| 2026-05-10 21:xx | running | 无 | 无 |
| 2026-05-11 09:37:13 | running | 无 | 无 |
| 2026-05-11 09:xx | running | 无 | 无 |
| 2026-05-11 10:xx | running | 无 | 无 |

**总计持续时间：超过 21 小时，仍未结束。**

---

## 五、源视频信息

| 属性 | 值 |
|------|----|
| URL | `https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/seedance/2026-05-10/enhancement/1778389448457_source.mp4` |
| 存储 | 阿里云 OSS（cn-shanghai），永久有效 |
| 时长 | 4 秒 |
| 格式 | mp4 |
| 来源 | 即梦 Seedance 2.0 Fast 模型生成（seedance-2.0-fast） |
| 原始生成模型 | dreamina_seedance_40 |

---

## 六、第 1 次复现记录（对比）

**提交请求（第 1 次）：**

```json
POST https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video

{
  "video_url": "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0-fast/02177830913060500000000000000000000ffffac15a695ba7534.mp4?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=AKLTYWJkZTExNjA1ZDUyNDc3YzhjNTM5OGIyNjBhNDcyOTQ%2F20260509%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Date=20260509T064730Z&X-Tos-Expires=86400&X-Tos-Signature=99b7783b17230dae677b23f029b4b554ef890761f321c2ca665fbf11c5ccfa37&X-Tos-SignedHeaders=host",
  "scene": "aigc",
  "tool_version": "standard",
  "resolution": "1080p",
  "client_token": "<随机UUID>"
}
```

**提交响应（第 1 次）：**
```json
{
  "task_id": "amk-tool-enhance-video-65501089026"
}
```

**提交时间（北京）：** 2026-05-09 18:29:38  
**客户端主动放弃时间（北京）：** 2026-05-10 11:54:22  
**持续时长：** >9 小时，状态始终为 `running`

**注意：** 第 1 次使用的是 TOS 临时签名 URL（有效期 86400 秒），第 2 次改为 OSS 永久 URL，问题依然复现，**排除 URL 过期导致问题的可能性。**

---

## 七、环境信息

| 项目 | 值 |
|------|----|
| API 地区 | cn-beijing |
| 客户端环境 | Node.js 服务端，fetch API |
| 轮询间隔 | 30 秒 |
| API Key 类型 | 火山引擎 MediaKit API Key（账号正常，鉴权成功） |

---

## 八、预期行为

根据官方文档：
- `standard` 版本 RTF≈10，4 秒视频预计约 **40 秒**内完成
- 任务完成后 `status` 应变为 `completed`，响应包含 `result.video_url`
- 任务失败后 `status` 应变为 `failed`，响应包含 `error` 信息

---

## 九、实际行为

- 任务提交成功（返回 task_id）
- 查询接口始终返回 `status: running`
- **超过 21 小时无任何状态变化**
- 无法得知任务是否在处理、是否已失败、是否已丢失

---

## 十、影响

- 无法为用户提供画质增强功能
- 后台 worker 无限轮询，浪费资源
- 用户积分被锁定（credit_lock 机制），无法使用
- 功能上线前测试阶段即发现，尚未对终端用户造成损失

---

## 十一、请求协助

1. 请确认 task_id `amk-tool-enhance-video-28481917186` 在系统中的实际状态
2. 请确认 task_id `amk-tool-enhance-video-65501089026` 的最终结果
3. 请说明 `status=running` 是否有超时机制，以及任务失败时是否会更新为 `failed`
4. 如该视频格式/来源不受支持，请告知错误原因（当前接口无任何错误提示）
