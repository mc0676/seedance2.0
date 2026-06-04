import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import OSS from 'ali-oss';

import { initDatabase, getDatabase, closeDatabase } from './database/index.js';
import * as projectService from './services/projectService.js';
import * as taskService from './services/taskService.js';
import * as settingsService from './services/settingsService.js';
// batchScheduler removed in project-centric refactor
import * as videoDownloader from './services/videoDownloader.js';
import { generateSeedanceVideo as generateSeedanceVideoCore, getArkTask } from './services/videoGenerator.js';
import * as authService from './services/authService.js';
import * as jimengSessionService from './services/jimengSessionService.js'; // activation codes only
import * as usageService from './services/usageService.js';
import * as assetService from './services/assetService.js';
import * as permissionService from './services/permissionService.js';
import * as pricingService from './services/pricingService.js';
import * as creditLockService from './services/creditLockService.js';
import * as volcArkService from './services/volcArkService.js';
import * as mediaKitService from './services/mediaKitService.js';
import * as enhancementWorker from './services/enhancementWorker.js';
import * as enhancementPricingService from './services/enhancementPricingService.js';
import * as audioGenerationService from './services/audioGenerationService.js';
import { submitTask as happyhorseSubmitTask, getTask as happyhorseGetTask } from './services/happyhorseService.js';
import * as happyhorsePricingService from './services/happyhorsePricingService.js';
import * as happyhorseWorker from './services/happyhorseWorker.js';
import * as bssService from './services/bssService.js';
import * as volcBillingService from './services/volcBillingService.js';
import * as discountService from './services/discountService.js';
import { readFileSync } from 'fs';

// 初始化数据库
initDatabase();
// 启动画质增强后台轮询
enhancementWorker.start();
// 启动 HappyHorse 后台轮询
happyhorseWorker.start();

// 启动一次性：把存量同项目同名的素材组改名为 `xxx (2)` 等，确保同一项目组内素材组名唯一
try {
  const changed = assetService.migrateDeduplicateAssetGroupNames();
  if (changed > 0) console.log(`[启动] 素材组名去重：${changed} 条被自动改名`);
} catch (e) {
  console.warn('[启动] 素材组名去重失败:', e.message);
}

// 启动时：若环境变量中有火山引擎 AK/SK，写入 system_config（Docker 部署首次配置兜底）
try {
  const _db = getDatabase();
  const envAk = process.env.VOLC_ACCESS_KEY_ID;
  const envSk = process.env.VOLC_SECRET_ACCESS_KEY;
  if (envAk) {
    _db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('volc_access_key_id', ?, '火山引擎 Access Key ID（来自环境变量）')").run(envAk);
  }
  if (envSk) {
    _db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('volc_secret_access_key', ?, '火山引擎 Secret Access Key（来自环境变量）')").run(envSk);
  }
  if (envAk || envSk) {
    console.log('[启动] 已从环境变量写入火山引擎 AK/SK 到 system_config');
  }
} catch (e) {
  console.warn('[启动] 写入火山引擎 AK/SK 失败:', e.message);
}

// 启动时：若环境变量中有阿里云 BSS AK/SK，写入 system_config
try {
  const _db3 = getDatabase();
  const bssAk = process.env.BSS_ACCESS_KEY_ID;
  const bssSk = process.env.BSS_ACCESS_KEY_SECRET;
  if (bssAk) {
    _db3.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('bss_access_key_id', ?, '阿里云 BSS AccessKey ID（来自环境变量）')").run(bssAk);
  }
  if (bssSk) {
    _db3.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('bss_access_key_secret', ?, '阿里云 BSS AccessKey Secret（来自环境变量）')").run(bssSk);
  }
  if (bssAk || bssSk) {
    console.log('[启动] 已从环境变量写入 BSS AK/SK 到 system_config');
  }
} catch (e) {
  console.warn('[启动] 写入 BSS AK/SK 失败:', e.message);
}

// 启动时清理僵尸任务（status=generating 但超过 30 分钟无更新）
try {
  const _db = getDatabase();
  const zombies = _db.prepare(`
    SELECT id FROM tasks
    WHERE status = 'generating'
      AND (julianday('now') - julianday(updated_at)) * 24 * 60 > 30
  `).all();
  if (zombies.length > 0) {
    const ids = zombies.map((z) => z.id);
    _db.prepare(`UPDATE tasks SET status = 'error', error_message = '服务重启时检测到任务超过 30 分钟未更新，自动标记失败', completed_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    // 释放对应的锁定积分
    _db.prepare(`UPDATE credit_locks SET status = 'released', release_reason = '启动时僵尸任务清理', settled_at = CURRENT_TIMESTAMP WHERE task_id IN (${ids.map(() => '?').join(',')}) AND status = 'locked'`).run(...ids);
    console.log(`[启动] 清理僵尸任务 ${zombies.length} 个：${ids.join(',')}`);
  }
} catch (e) {
  console.warn('[启动] 僵尸任务清理失败:', e.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_SESSION_ID = process.env.VITE_DEFAULT_SESSION_ID || '';

app.use(cors());
app.use(express.json());

// GET /api/status - 维护模式状态（无需登录）
app.get('/api/status', (req, res) => {
  try {
    const db = getDatabase();
    const mRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_mode'").get();
    const msgRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_message'").get();
    const maintenance = mRow?.value === '1';
    const message = msgRow?.value || '系统维护中，请稍后再试。';
    res.json({ maintenance, message });
  } catch {
    res.json({ maintenance: false, message: '' });
  }
});

// 维护模式中间件（admin/super_admin 跳过）
app.use((req, res, next) => {
  if (req.path === '/api/status' || req.path === '/api/login' || req.path === '/api/register') return next();
  try {
    const db = getDatabase();
    const mRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_mode'").get();
    if (mRow?.value !== '1') return next();
    // 已登录的 admin 跳过
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
      const session = db.prepare('SELECT u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime(\'now\')').get(sessionId);
      if (session && ['admin', 'super_admin'].includes(session.role)) return next();
    }
    const msgRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_message'").get();
    return res.status(503).json({ maintenance: true, message: msgRow?.value || '系统维护中，请稍后再试。' });
  } catch {
    next();
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB for video/audio
});

// ============================================================
// 阿里云 OSS 配置
// ============================================================
const OSS_CONFIG = {
  region: 'oss-cn-shanghai',
  accessKeyId: 'LTAI5tL9SYY5FN5eSJ3Yhxw9',
  accessKeySecret: 'atR8ItYSJhCIA76C2imtUKNr3h24Zr',
  bucket: 'yunyu-oss',
};
const OSS_URL_PREFIX = 'https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/';

function createOssClient() {
  return new OSS({
    ...OSS_CONFIG,
    timeout: 300000, // 300秒超时
  });
}

function buildOssKey(filename, mediaType) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const ext = path.extname(filename).toLowerCase() || '';
  const typeFolder = mediaType === 'video' ? 'videos' : mediaType === 'audio' ? 'audio' : 'images';
  const uuid = crypto.randomUUID();
  return `seedance/${dateStr}/${typeFolder}/${uuid}${ext}`;
}

// ============================================================
// 常量定义
// ============================================================
const JIMENG_BASE_URL = 'https://jimeng.jianying.com';
const DEFAULT_ASSISTANT_ID = 513695;
const VERSION_CODE = '8.4.0';
const PLATFORM_CODE = '7';
const WEB_ID = Math.random() * 999999999999999999 + 7000000000000000000;
const USER_ID = crypto.randomUUID().replace(/-/g, '');
const downloadTokens = new Map();
const DOWNLOAD_TOKEN_TTL_MS = 60 * 1000;

function cleanupExpiredDownloadTokens() {
  const now = Date.now();
  for (const [token, record] of downloadTokens.entries()) {
    if (record.expiresAt <= now) {
      downloadTokens.delete(token);
    }
  }
}

function createDownloadToken(taskId, userId, extra = {}) {
  cleanupExpiredDownloadTokens();
  const token = crypto.randomBytes(24).toString('hex');
  downloadTokens.set(token, {
    taskId: String(taskId),
    userId: Number(userId),
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS,
    ...extra,
  });
  return token;
}

function consumeDownloadToken(token, userId = null) {
  cleanupExpiredDownloadTokens();
  const record = downloadTokens.get(token);
  if (!record) {
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    return null;
  }
  if (userId !== null && record.userId !== Number(userId)) {
    downloadTokens.delete(token);
    return null;
  }
  downloadTokens.delete(token);
  return record;
}

// 与 consumeDownloadToken 相同但不删除 token，允许下载暂停/续传时多次请求
function validateDownloadToken(token) {
  cleanupExpiredDownloadTokens();
  const record = downloadTokens.get(token);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    return null;
  }
  return record;
}

setInterval(cleanupExpiredDownloadTokens, DOWNLOAD_TOKEN_TTL_MS).unref();

// 认证中间件
const authenticate = async (req, res, next) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.status(401).json({ error: '未登录' });
  }

  try {
    const user = await authService.getCurrentUser(sessionId);
    if (!user) {
      return res.status(401).json({ error: 'Session 已过期或无效' });
    }
    req.user = user;
    req.sessionId = sessionId; // 保存原始 sessionId 供后续使用
    next();
  } catch (error) {
    res.status(401).json({ error: '认证失败' });
  }
};

// 管理员认证中间件（admin 或 super_admin 均可通过）
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};

// 系统管理员认证中间件（仅 super_admin 可通过）
const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({ error: '需要系统管理员权限' });
  }
  next();
};

const FAKE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-language': 'zh-CN,zh;q=0.9',
  'App-Sdk-Version': '48.0.0',
  'Cache-control': 'no-cache',
  Appid: String(DEFAULT_ASSISTANT_ID),
  Appvr: VERSION_CODE,
  Lan: 'zh-Hans',
  Loc: 'cn',
  Origin: 'https://jimeng.jianying.com',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: 'https://jimeng.jianying.com',
  Pf: PLATFORM_CODE,
  'Sec-Ch-Ua':
    '"Google Chrome";v="132", "Chromium";v="132", "Not_A Brand";v="8"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
};

// 模型映射
const MODEL_MAP = {
  'seedance-2.0': 'dreamina_seedance_40_pro',
  'seedance-2.0-fast': 'dreamina_seedance_40',
};

const BENEFIT_TYPE_MAP = {
  'seedance-2.0': 'dreamina_video_seedance_20_pro',
  'seedance-2.0-fast': 'dreamina_seedance_20_fast',
};

const SEEDANCE_DRAFT_VERSION = '3.3.9';

// 分辨率配置
const VIDEO_RESOLUTION = {
  '1:1': { width: 720, height: 720 },
  '4:3': { width: 960, height: 720 },
  '3:4': { width: 720, height: 960 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '21:9': { width: 1680, height: 720 },
};

// ============================================================
// 异步任务管理
// ============================================================
const tasks = new Map();
let taskCounter = 0;

function getMissingSessionErrorMessage() {
  return '未配置可用的 API Key，请在管理后台激活一个火山Key组';
}

// 从激活的火山Key组取 ARK API Key（无项目上下文时的兜底）
function isMultiAccountEnabled() {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
  return (row?.value === '1' || row?.value === 'true');
}

function resolveApiKey() {
  const db = getDatabase();
  const activeGroup = db.prepare('SELECT ark_model_key FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
  return activeGroup?.ark_model_key || '';
}

// 根据项目绑定的 volc_id 取对应的 ARK API Key
function resolveProjectApiKey(projectId, forceMulti = false) {
  if (!projectId) return resolveApiKey();
  const db = getDatabase();
  const row = db.prepare(`
    SELECT v.ark_model_key FROM volc_key_groups v
    INNER JOIN projects p ON p.volc_id = v.id
    WHERE p.id = ?
  `).get(projectId);
  return (isMultiAccountEnabled() || forceMulti) ? (row?.ark_model_key || resolveApiKey()) : resolveApiKey();
}

// 根据项目绑定的 volc_id 取对应的 Key 组（含 id, name, ark_model_key 等）
function resolveProjectKeyGroup(projectId) {
  if (!projectId) return null;
  const db = getDatabase();
  return db.prepare(`
    SELECT v.* FROM volc_key_groups v
    INNER JOIN projects p ON p.volc_id = v.id
    WHERE p.id = ?
  `).get(projectId) || null;
}

function pickFirstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length >= 0) || [];
}

function extractItemId(item) {
  return item?.item_id || item?.local_item_id || item?.common_attr?.id || item?.id || null;
}

function extractHistoryId(item) {
  return item?.history_id || item?.history_record_id || item?.common_attr?.history_id || item?.item_base?.history_id || null;
}

function extractVideoUrl(item) {
  return item?.video?.transcoded_video?.origin?.video_url || item?.video?.download_url || item?.video?.play_url || item?.video?.url || item?.video?.play_addr?.url_list?.[0] || item?.item_video?.url || null;
}

async function resolveItemIdsByHistoryIds(sessionId, historyIds) {
  const normalizedHistoryIds = [...new Set(historyIds.map((historyId) => String(historyId || '')).filter(Boolean))];
  const itemIdByHistoryId = new Map();

  if (normalizedHistoryIds.length === 0) {
    return itemIdByHistoryId;
  }

  const historyResult = await jimengRequest('post', '/mweb/v1/get_history_by_ids', sessionId, {
    data: {
      history_ids: normalizedHistoryIds,
    },
  });

  const historyRecords = [
    ...pickFirstArray(
      historyResult?.history_list,
      historyResult?.list,
      historyResult?.data?.history_list,
      historyResult?.data?.list
    ),
    ...normalizedHistoryIds
      .map((historyId) => historyResult?.[historyId] || historyResult?.data?.[historyId] || null)
      .filter(Boolean),
  ];

  for (const record of historyRecords) {
    const historyId = extractHistoryId(record);
    if (!historyId) {
      continue;
    }

    const item = pickFirstArray(record?.item_list, record?.items, record?.data?.item_list)[0];
    const itemId = extractItemId(item);
    if (!itemId) {
      continue;
    }

    itemIdByHistoryId.set(String(historyId), String(itemId));
  }

  return itemIdByHistoryId;
}

async function fetchLocalItemsByItemIds(sessionId, itemIds) {
  const normalizedItemIds = [...new Set(itemIds.map((itemId) => String(itemId || '')).filter(Boolean))];
  if (normalizedItemIds.length === 0) {
    return [];
  }

  const result = await jimengRequest('post', '/mweb/v1/get_local_item_list', sessionId, {
    data: {
      item_id_list: normalizedItemIds,
      pack_item_opt: {
        scene: 1,
        need_data_integrity: true,
      },
      is_for_video_download: true,
    },
  });

  return pickFirstArray(
    result?.item_list,
    result?.local_item_list,
    result?.list,
    result?.data?.item_list,
    result?.data?.local_item_list,
    result?.data?.list
  );
}

async function resolveTaskVideoByHistory(sessionId, task) {
  const historyId = task?.history_id ? String(task.history_id) : '';
  if (!historyId) {
    return { itemId: null, videoUrl: null };
  }

  const itemId = task?.item_id ? String(task.item_id) : (await resolveItemIdsByHistoryIds(sessionId, [historyId])).get(historyId) || null;
  if (!itemId) {
    return { itemId: null, videoUrl: null };
  }

  const items = await fetchLocalItemsByItemIds(sessionId, [itemId]);
  const matchedItem = items.find((item) => {
    const resolvedItemId = extractItemId(item);
    const resolvedHistoryId = extractHistoryId(item);
    return String(resolvedItemId || '') === itemId || String(resolvedHistoryId || '') === historyId;
  }) || items[0];

  return {
    itemId,
    videoUrl: matchedItem ? extractVideoUrl(matchedItem) : null,
  };
}

function persistResolvedVideoTask(db, taskId, { itemId = null, videoUrl = null }) {
  if (videoUrl) {
    db.prepare(`
      UPDATE tasks
      SET item_id = COALESCE(?, item_id), video_url = ?, status = 'done', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(itemId, videoUrl, taskId);
    return;
  }

  if (itemId) {
    db.prepare(`
      UPDATE tasks
      SET item_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(itemId, taskId);
  }
}

function createTaskId() {
  return `task_${++taskCounter}_${Date.now()}`;
}

// 定期清理过期任务
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (now - task.startTime > 30 * 60 * 1000) {
      tasks.delete(id);
    }
  }
}, 60000);

// ============================================================
// 工具函数
// ============================================================
function generateUUID() {
  return crypto.randomUUID();
}

function unixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function generateCookie(sessionId) {
  return [
    `_tea_web_id=${WEB_ID}`,
    `is_staff_user=false`,
    `store-region=cn-gd`,
    `store-region-src=uid`,
    `uid_tt=${USER_ID}`,
    `uid_tt_ss=${USER_ID}`,
    `sid_tt=${sessionId}`,
    `sessionid=${sessionId}`,
    `sessionid_ss=${sessionId}`,
  ].join('; ');
}

function generateSign(uri) {
  const deviceTime = unixTimestamp();
  const sign = md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );
  return { deviceTime, sign };
}

// ============================================================
// 即梦 API 请求函数
// ============================================================
async function jimengRequest(method, uri, sessionId, options = {}) {
  const { deviceTime, sign } = generateSign(uri);
  const fullUrl = new URL(`${JIMENG_BASE_URL}${uri}`);

  const defaultParams = {
    aid: DEFAULT_ASSISTANT_ID,
    device_platform: 'web',
    region: 'cn',
    webId: WEB_ID,
    da_version: '3.3.2',
    web_component_open_flag: 1,
    web_version: '7.5.0',
    aigc_features: 'app_lip_sync',
    ...(options.params || {}),
  };

  for (const [key, value] of Object.entries(defaultParams)) {
    fullUrl.searchParams.set(key, String(value));
  }

  const headers = {
    ...FAKE_HEADERS,
    Cookie: generateCookie(sessionId),
    'Device-Time': String(deviceTime),
    Sign: sign,
    'Sign-Ver': '1',
    ...(options.headers || {}),
  };

  const fetchOptions = { method: method.toUpperCase(), headers };

  if (options.data) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(options.data);
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        console.log(`  [jimeng] 重试 ${uri} (第${attempt}次)`);
      }

      const response = await fetch(fullUrl.toString(), {
        ...fetchOptions,
        signal: AbortSignal.timeout(45000),
      });
      const data = await response.json();

      if (isFinite(Number(data.ret))) {
        if (String(data.ret) === '0') return data.data;
        // API 业务错误不重试，直接抛出
        const errMsg = data.errmsg || String(data.ret);
        const retCode = String(data.ret);
        if (retCode === '5000')
          throw new Error('即梦积分不足，请前往即梦官网领取积分');
        throw Object.assign(
          new Error(`即梦API错误 (ret=${retCode}): ${errMsg}`),
          { isApiError: true }
        );
      }

      return data;
    } catch (err) {
      // API 业务错误（非网络问题）不重试
      if (err.isApiError) throw err;
      if (attempt === 3) throw err;
      console.log(
        `  [jimeng] 请求 ${uri} 失败 (第${attempt + 1}次): ${err.message}`
      );
    }
  }
}

// ============================================================
// AWS4-HMAC-SHA256 签名
// ============================================================
function createAWSSignature(
  method,
  url,
  headers,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  payload = ''
) {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname || '/';

  const timestamp = headers['x-amz-date'];
  const date = timestamp.substr(0, 8);
  const region = 'cn-north-1';
  const service = 'imagex';

  // 规范化查询参数
  const queryParams = [];
  urlObj.searchParams.forEach((value, key) => {
    queryParams.push([key, value]);
  });
  queryParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQueryString = queryParams
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // 签名头部
  const headersToSign = { 'x-amz-date': timestamp };
  if (sessionToken)
    headersToSign['x-amz-security-token'] = sessionToken;

  let payloadHash = crypto.createHash('sha256').update('').digest('hex');
  if (method.toUpperCase() === 'POST' && payload) {
    payloadHash = crypto
      .createHash('sha256')
      .update(payload, 'utf8')
      .digest('hex');
    headersToSign['x-amz-content-sha256'] = payloadHash;
  }

  const signedHeaders = Object.keys(headersToSign)
    .map((k) => k.toLowerCase())
    .sort()
    .join(';');
  const canonicalHeaders = Object.keys(headersToSign)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}:${headersToSign[k].trim()}\n`)
    .join('');

  const canonicalRequest = [
    method.toUpperCase(),
    pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    crypto
      .createHash('sha256')
      .update(canonicalRequest, 'utf8')
      .digest('hex'),
  ].join('\n');

  const kDate = crypto
    .createHmac('sha256', `AWS4${secretAccessKey}`)
    .update(date)
    .digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto
    .createHmac('sha256', kRegion)
    .update(service)
    .digest();
  const kSigning = crypto
    .createHmac('sha256', kService)
    .update('aws4_request')
    .digest();
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ============================================================
// CRC32 计算
// ============================================================
function calculateCRC32(buffer) {
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[i] = crc;
  }

  let crc = 0 ^ -1;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

// ============================================================
// 图片上传 (4步 ImageX 流程)
// ============================================================
async function uploadImageBuffer(buffer, sessionId) {
  console.log(`  [upload] 开始上传图片, 大小: ${buffer.length} 字节`);

  // 第1步: 获取上传令牌
  const tokenResult = await jimengRequest(
    'post',
    '/mweb/v1/get_upload_token',
    sessionId,
    { data: { scene: 2 } }
  );

  const { access_key_id, secret_access_key, session_token, service_id } =
    tokenResult;
  if (!access_key_id || !secret_access_key || !session_token) {
    throw new Error('获取上传令牌失败');
  }
  const actualServiceId = service_id || 'tb4s082cfz';
  console.log(`  [upload] 上传令牌获取成功: serviceId=${actualServiceId}`);

  const fileSize = buffer.length;
  const crc32 = calculateCRC32(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );

  // 第2步: 申请上传权限
  const timestamp = new Date()
    .toISOString()
    .replace(/[:\-]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const randomStr = Math.random().toString(36).substring(2, 12);
  const applyUrl = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}&FileSize=${fileSize}&s=${randomStr}`;

  const reqHeaders = {
    'x-amz-date': timestamp,
    'x-amz-security-token': session_token,
  };
  const authorization = createAWSSignature(
    'GET',
    applyUrl,
    reqHeaders,
    access_key_id,
    secret_access_key,
    session_token
  );

  const applyResponse = await fetch(applyUrl, {
    method: 'GET',
    headers: {
      accept: '*/*',
      authorization: authorization,
      origin: 'https://jimeng.jianying.com',
      referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'user-agent': FAKE_HEADERS['User-Agent'],
      'x-amz-date': timestamp,
      'x-amz-security-token': session_token,
    },
  });

  if (!applyResponse.ok)
    throw new Error(`申请上传权限失败: ${applyResponse.status}`);
  const applyResult = await applyResponse.json();
  if (applyResult?.ResponseMetadata?.Error)
    throw new Error(
      `申请上传权限失败: ${JSON.stringify(applyResult.ResponseMetadata.Error)}`
    );

  const uploadAddress = applyResult?.Result?.UploadAddress;
  if (!uploadAddress?.StoreInfos?.length || !uploadAddress?.UploadHosts?.length) {
    throw new Error('获取上传地址失败');
  }

  const storeInfo = uploadAddress.StoreInfos[0];
  const uploadHost = uploadAddress.UploadHosts[0];
  const uploadUrl = `https://${uploadHost}/upload/v1/${storeInfo.StoreUri}`;

  console.log(`  [upload] 上传图片到: ${uploadHost}`);

  // 第3步: 上传图片文件
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      Authorization: storeInfo.Auth,
      'Content-CRC32': crc32,
      'Content-Disposition': 'attachment; filename="undefined"',
      'Content-Type': 'application/octet-stream',
      Origin: 'https://jimeng.jianying.com',
      Referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'User-Agent': FAKE_HEADERS['User-Agent'],
    },
    body: buffer,
  });

  if (!uploadResponse.ok)
    throw new Error(`图片上传失败: ${uploadResponse.status}`);
  console.log(`  [upload] 图片文件上传成功`);

  // 第4步: 提交上传
  const commitUrl = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${actualServiceId}`;
  const commitTimestamp = new Date()
    .toISOString()
    .replace(/[:\-]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const commitPayload = JSON.stringify({
    SessionKey: uploadAddress.SessionKey,
    SuccessActionStatus: '200',
  });
  const payloadHash = crypto
    .createHash('sha256')
    .update(commitPayload, 'utf8')
    .digest('hex');

  const commitReqHeaders = {
    'x-amz-date': commitTimestamp,
    'x-amz-security-token': session_token,
    'x-amz-content-sha256': payloadHash,
  };
  const commitAuth = createAWSSignature(
    'POST',
    commitUrl,
    commitReqHeaders,
    access_key_id,
    secret_access_key,
    session_token,
    commitPayload
  );

  const commitResponse = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      accept: '*/*',
      authorization: commitAuth,
      'content-type': 'application/json',
      origin: 'https://jimeng.jianying.com',
      referer: 'https://jimeng.jianying.com/ai-tool/video/generate',
      'user-agent': FAKE_HEADERS['User-Agent'],
      'x-amz-date': commitTimestamp,
      'x-amz-security-token': session_token,
      'x-amz-content-sha256': payloadHash,
    },
    body: commitPayload,
  });

  if (!commitResponse.ok)
    throw new Error(`提交上传失败: ${commitResponse.status}`);
  const commitResult = await commitResponse.json();
  if (commitResult?.ResponseMetadata?.Error)
    throw new Error(
      `提交上传失败: ${JSON.stringify(commitResult.ResponseMetadata.Error)}`
    );

  if (!commitResult?.Result?.Results?.length)
    throw new Error('提交上传响应缺少结果');
  const result = commitResult.Result.Results[0];
  if (result.UriStatus !== 2000)
    throw new Error(`图片上传状态异常: UriStatus=${result.UriStatus}`);

  const imageUri =
    commitResult.Result?.PluginResult?.[0]?.ImageUri || result.Uri;
  console.log(`  [upload] 图片上传完成: ${imageUri}`);
  return imageUri;
}

// ============================================================
// 解析 prompt 中的图片占位符, 构建 meta_list
// ============================================================
function buildMetaListFromPrompt(prompt, imageCount) {
  const metaList = [];
  const placeholderRegex = /@(?:图|image)?(\d+)/gi;
  let lastIndex = 0;
  let match;

  while ((match = placeholderRegex.exec(prompt)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = prompt.substring(lastIndex, match.index);
      if (textBefore.trim()) {
        metaList.push({ meta_type: 'text', text: textBefore });
      }
    }

    const imageIndex = parseInt(match[1]) - 1;
    if (imageIndex >= 0 && imageIndex < imageCount) {
      metaList.push({
        meta_type: 'image',
        text: '',
        material_ref: { material_idx: imageIndex },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < prompt.length) {
    const remainingText = prompt.substring(lastIndex);
    if (remainingText.trim()) {
      metaList.push({ meta_type: 'text', text: remainingText });
    }
  }

  // 如果没有占位符, 构建默认 meta_list
  if (metaList.length === 0) {
    for (let i = 0; i < imageCount; i++) {
      if (i === 0) metaList.push({ meta_type: 'text', text: '使用' });
      metaList.push({
        meta_type: 'image',
        text: '',
        material_ref: { material_idx: i },
      });
      if (i < imageCount - 1)
        metaList.push({ meta_type: 'text', text: '和' });
    }
    if (prompt && prompt.trim()) {
      metaList.push({ meta_type: 'text', text: `图片，${prompt}` });
    } else {
      metaList.push({ meta_type: 'text', text: '图片生成视频' });
    }
  }

  return metaList;
}


// ============================================================
// Express 路由
// ============================================================

// POST /api/upload/oss - 上传文件到阿里云 OSS
const ossUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.post('/api/upload/oss', authenticate, ossUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const { mimetype, buffer, size } = req.file;
    const originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const mediaType = req.body.mediaType || (mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : 'image');
    const key = buildOssKey(originalname, mediaType);
    const client = createOssClient();

    const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10MB 以上走分片上传
    if (size > MULTIPART_THRESHOLD) {
      await client.multipartUpload(key, buffer, {
        mime: mimetype,
        partSize: 5 * 1024 * 1024,
        parallel: 3,
      });
    } else {
      await client.put(key, buffer, { mime: mimetype });
    }

    const url = `${OSS_URL_PREFIX}${key}`;
    console.log(`[OSS] 上传成功: ${key} (${(size / 1024).toFixed(1)}KB)`);

    // 记录上传信息到 uploads 表（UUID key → 原始文件名映射）
    try {
      const db = getDatabase();
      db.prepare(`INSERT INTO uploads (user_id, original_name, oss_key, oss_url, media_type, file_size)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(
        req.user.id, originalname, key, url, mediaType, size
      );
    } catch (e) {
      console.warn('[OSS] uploads 记录失败:', e.message);
    }

    // 视频文件：服务端探测真实时长 / 分辨率（不下载，调用 OSS video/info 处理）
    // 失败不阻断上传成功的返回，前端用 fallback 流程提示用户
    let videoInfo = null;
    if (mediaType === 'video') {
      try {
        const { probeVideoInfo } = await import('./services/ossVideoInfoService.js');
        const info = await probeVideoInfo(url);
        if (info.ok) {
          videoInfo = {
            durationSec: info.durationSec,
            width: info.width,
            height: info.height,
            fps: info.fps,
          };
          console.log(`[OSS] 视频探测: ${info.durationSec}s ${info.width}x${info.height} @${info.fps}fps`);
        } else {
          console.warn(`[OSS] 视频探测失败: ${info.error}`);
        }
      } catch (e) {
        console.warn('[OSS] 视频探测异常:', e.message);
      }
    }

    res.json({ success: true, url, key, videoInfo, originalName: originalname });
  } catch (error) {
    console.error('[OSS] 上传失败:', error.message);
    res.status(500).json({ error: `OSS 上传失败: ${error.message}` });
  }
});

// POST /api/oss/probe-video - 探测已存在的 OSS 视频元数据（不下载到服务器）
// 用途：复用历史任务、表单回填等场景，需要重新拿到 durationSec 用于计费预估
app.post('/api/oss/probe-video', authenticate, async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });
    const { probeVideoInfo } = await import('./services/ossVideoInfoService.js');
    const info = await probeVideoInfo(url);
    if (!info.ok) {
      return res.status(400).json({ error: info.error || '视频探测失败' });
    }
    res.json({
      success: true,
      data: {
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        fps: info.fps,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/generate-image - 使用速创异步API生成图片（Nano Banana 2 / GPT-Image-2）
// 积分流程与视频一致：先 lockForImage → 生成 → settleForImage / releaseForImage
//
// 吴音上游错误映射：吴音后端在「上游模型暂时不可用 / 维护 / 通道异常」时会统一返回
// 这条与终端用户余额无关的固定文案，直接透传会误导用户。仅命中此精确字符串才映射；
// 其他错误（密钥/IP/内容违规等）保持原文返回，便于排查。
function mapWuyinUpstreamError(msg) {
  if (msg === '请求失败，账户余额不足或没有权限') {
    return '图片生成服务暂时不可用（上游接口维护中或繁忙），请稍后再试。';
  }
  return msg;
}

// 重启后恢复 pending 状态的图片任务：通过 wuyin_task_id 轮询结果
async function recoverImageRecord(db, record) {
  if (!record.wuyin_task_id) return false;
  const wuyinRow = db.prepare("SELECT value FROM system_config WHERE key = 'wuyin_api_key'").get();
  const WUYIN_API_KEY = wuyinRow?.value || 'H8ZPElPf5BKM1amJrauK6txc73';
  const WUYIN_BASE = 'https://api.wuyinkeji.com';
  try {
    const detailResp = await fetch(
      `${WUYIN_BASE}/api/async/detail?id=${encodeURIComponent(record.wuyin_task_id)}&key=${encodeURIComponent(WUYIN_API_KEY)}`,
      { headers: { 'Authorization': WUYIN_API_KEY } }
    );
    const detailData = await detailResp.json();
    if (!detailResp.ok || detailData?.code !== 200) return false; // keep pending
    const status = detailData?.data?.status;
    if (status === 2) {
      const resultUrls = Array.isArray(detailData.data.result) ? detailData.data.result : [];
      const userRow = db.prepare('SELECT unlimited_credits FROM users WHERE id = ?').get(record.user_id);
      const actualCost = userRow?.unlimited_credits ? 0 : 10;
      try { creditLockService.settleForImage({ imageRecordId: record.id, actualCredits: actualCost }); } catch {}
      db.prepare(`UPDATE image_records SET result_urls=?, credits_used=?, status='done' WHERE id=?`)
        .run(JSON.stringify(resultUrls), actualCost, record.id);
      return true;
    } else if (status === 3) {
      const rawMsg = detailData?.data?.message || '生成失败';
      const friendly = mapWuyinUpstreamError(rawMsg) || rawMsg;
      try { creditLockService.releaseForImage({ imageRecordId: record.id, reason: friendly }); } catch {}
      db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(friendly, record.id);
      return true;
    }
    return false; // still processing
  } catch { return false; }
}

app.post('/api/generate-image', authenticate, async (req, res) => {
  const db = getDatabase();
  const { prompt, model, size, aspectRatio, urls, projectId: reqProjectId, sizeLabel, refUrls: reqRefUrls } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt 不能为空' });
  if (!['gpt-image-2', 'nano-banana-2'].includes(model)) {
    return res.status(400).json({ error: '不支持的图片生成模型' });
  }

  const IMAGE_GEN_COST = 10; // 固定 10 积分/次（0.1 元）

  const wuyinRow = db.prepare("SELECT value FROM system_config WHERE key = 'wuyin_api_key'").get();
  const WUYIN_API_KEY = wuyinRow?.value || 'H8ZPElPf5BKM1amJrauK6txc73';
  const WUYIN_BASE = 'https://api.wuyinkeji.com';

  // 1) 预插入 image_record（status='pending'），获取 id 供 lock 使用
  let imageRecordId;
  try {
    const ins = db.prepare(
      `INSERT INTO image_records (user_id, project_id, prompt, model, size_label, ref_urls, result_urls, credits_used, status)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 'pending')`
    ).run(
      req.user.id,
      reqProjectId || null,
      prompt,
      model,
      sizeLabel || '',
      JSON.stringify(Array.isArray(reqRefUrls) ? reqRefUrls : []),
    );
    imageRecordId = ins.lastInsertRowid;
  } catch (e) {
    return res.status(500).json({ error: '初始化记录失败：' + e.message });
  }

  // 2) 积分锁定（等同视频 lock，可用余额 = credits - 已锁定视频积分）
  try {
    creditLockService.lockForImage({
      userId: req.user.id,
      imageRecordId,
      credits: IMAGE_GEN_COST,
      meta: { model },
    });
  } catch (e) {
    // 积分不足：清理 pending 记录
    db.prepare(`DELETE FROM image_records WHERE id = ?`).run(imageRecordId);
    return res.status(402).json({ error: e.message });
  }

  // DEV 模拟上游「请求失败，账户余额不足或没有权限」错误：
  // MOCK_WUYIN_ERROR=1 / true 时启用；0 / false / 空 / 未设置都视为关闭。
  // 仅模拟这一种特定的上游错误，走真实失败链路（释放积分锁、status='error'、写 error_message、502）。
  const mockFlag = (process.env.MOCK_WUYIN_ERROR || '').toLowerCase();
  if (process.env.NODE_ENV !== 'production' && (mockFlag === '1' || mockFlag === 'true')) {
    const upstreamMsg = '请求失败，账户余额不足或没有权限';
    const friendly = mapWuyinUpstreamError(upstreamMsg);
    creditLockService.releaseForImage({ imageRecordId, reason: friendly });
    db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(friendly, imageRecordId);
    return res.status(502).json({ error: friendly });
  }

  // 3) 提交异步任务
  const endpoint = model === 'gpt-image-2' ? 'image_gpt' : 'image_nanoBanana2';
  const submitBody = { prompt };
  if (model === 'gpt-image-2') {
    if (size) submitBody.size = size;
  } else {
    if (size) submitBody.size = size;
    if (aspectRatio) submitBody.aspectRatio = aspectRatio;
  }
  if (Array.isArray(urls) && urls.length > 0) submitBody.urls = urls;

  let wuyinTaskId;
  try {
    const submitResp = await fetch(`${WUYIN_BASE}/api/async/${endpoint}?key=${encodeURIComponent(WUYIN_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': WUYIN_API_KEY },
      body: JSON.stringify(submitBody),
    });
    const submitData = await submitResp.json();
    if (!submitResp.ok || submitData?.code !== 200 || !submitData?.data?.id) {
      const rawMsg = submitData?.msg || submitData?.message || '任务提交失败';
      const friendly = mapWuyinUpstreamError(rawMsg) || rawMsg;
      creditLockService.releaseForImage({ imageRecordId, reason: friendly });
      db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(friendly, imageRecordId);
      return res.status(502).json({ error: friendly });
    }
    wuyinTaskId = submitData.data.id;
    // 立即持久化 wuyin_task_id，防止重启后任务丢失
    db.prepare(`UPDATE image_records SET wuyin_task_id=? WHERE id=?`).run(wuyinTaskId, imageRecordId);
  } catch (e) {
    creditLockService.releaseForImage({ imageRecordId, reason: e.message });
    db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(e.message, imageRecordId);
    return res.status(502).json({ error: '提交请求异常：' + e.message });
  }

  // 4) 轮询查询结果
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const startedAt = Date.now();
  let resultUrls = null;
  try {
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const detailResp = await fetch(
        `${WUYIN_BASE}/api/async/detail?id=${encodeURIComponent(wuyinTaskId)}&key=${encodeURIComponent(WUYIN_API_KEY)}`,
        { headers: { 'Authorization': WUYIN_API_KEY } }
      );
      const detailData = await detailResp.json();
      if (!detailResp.ok || detailData?.code !== 200) {
        const rawMsg = detailData?.msg || '查询任务失败';
        const friendly = mapWuyinUpstreamError(rawMsg) || rawMsg;
        creditLockService.releaseForImage({ imageRecordId, reason: friendly });
        db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(friendly, imageRecordId);
        return res.status(502).json({ error: friendly });
      }
      const status = detailData?.data?.status;
      if (status === 2) {
        resultUrls = Array.isArray(detailData.data.result) ? detailData.data.result : [];
        break;
      }
      if (status === 3) {
        const rawMsg = detailData?.data?.message || '生成失败';
        const friendly = mapWuyinUpstreamError(rawMsg) || rawMsg;
        creditLockService.releaseForImage({ imageRecordId, reason: friendly });
        db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(friendly, imageRecordId);
        return res.status(502).json({ error: friendly });
      }
    }
  } catch (e) {
    creditLockService.releaseForImage({ imageRecordId, reason: e.message });
    db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run(e.message, imageRecordId);
    return res.status(500).json({ error: '轮询异常：' + e.message });
  }

  if (!resultUrls) {
    creditLockService.releaseForImage({ imageRecordId, reason: '生成超时' });
    db.prepare(`UPDATE image_records SET status='error', error_message=? WHERE id=?`).run('生成超时（轮询超时，超过5分钟未返回结果）', imageRecordId);
    return res.status(504).json({ error: '生成超时，请稍后再试' });
  }

  // 5) 生成成功：settle 积分（等同视频 settle，usage_logs 自动写入）
  const userRow = db.prepare('SELECT unlimited_credits FROM users WHERE id = ?').get(req.user.id);
  const actualCost = userRow?.unlimited_credits ? 0 : IMAGE_GEN_COST;
  creditLockService.settleForImage({ imageRecordId, actualCredits: actualCost });

  // 6) 更新 image_record 为完成状态
  db.prepare(
    `UPDATE image_records SET result_urls=?, credits_used=?, status='done' WHERE id=?`
  ).run(JSON.stringify(resultUrls), actualCost, imageRecordId);

  res.json({
    success: true,
    taskId: wuyinTaskId,
    urls: resultUrls,
    creditsUsed: actualCost,
  });
});

// GET /api/image-records - 图片生成历史（按项目组过滤，无限滚动分页）
app.get('/api/image-records', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { page = 1, pageSize = 20, projectId } = req.query;
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = (parseInt(page) - 1) * limit;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const conditions = ['deleted_at IS NULL'];
    const params = [];
    // 项目组共享：管理员看全部；普通用户看自己创建的 + 所在项目组其他成员创建的
    if (!isAdmin) {
      conditions.push(`(user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = image_records.project_id AND pm.user_id = ?
      ))`);
      params.push(req.user.id, req.user.id);
    }
    if (projectId && projectId !== 'all') {
      conditions.push('project_id = ?');
      params.push(parseInt(projectId));
    }
    const where = conditions.length ? conditions.join(' AND ') : '1=1';

    // 恢复 pending 记录（重启后通过 wuyin_task_id 轮询结果）
    const pendingRows = db.prepare(
      `SELECT * FROM image_records WHERE ${where} AND status='pending' AND wuyin_task_id IS NOT NULL`
    ).all(...params);
    for (const row of pendingRows) {
      await recoverImageRecord(db, row);
    }

    // pending 但没有 wuyin_task_id 的记录无法恢复，直接标记为失败
    db.prepare(
      `UPDATE image_records SET status='error', error_message='任务提交失败（未获取到上游任务ID），请重试' WHERE ${where} AND status='pending' AND wuyin_task_id IS NULL`
    ).run(...params);
    // 同时释放这些记录的积分锁
    const orphanPending = db.prepare(
      `SELECT id FROM image_records WHERE ${where} AND status='error' AND error_message='任务提交失败（未获取到上游任务ID），请重试'`
    ).all(...params);
    for (const r of orphanPending) {
      try { creditLockService.releaseForImage({ imageRecordId: r.id, reason: '未获取到上游任务ID' }); } catch {}
    }

    // 历史保留 done/error/pending：pending 是"生成中"持久化状态，切换页面/刷新后还能看到进度条
    const statusFilter = "status IN ('done','error','pending')";
    const total = db.prepare(`SELECT COUNT(*) as n FROM image_records WHERE ${where} AND ${statusFilter}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM image_records WHERE ${where} AND ${statusFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const records = rows.map((r) => ({
      ...r,
      ref_urls: JSON.parse(r.ref_urls || '[]'),
      result_urls: JSON.parse(r.result_urls || '[]'),
    }));
    res.json({ success: true, data: { records, total, page: parseInt(page), pageSize: limit } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/image-records/:id/mark-downloaded - 标记图片记录已下载（持久化）
// 与视频 /api/download/tasks/:id/mark-downloaded 行为对齐：仅写时间戳，不校验下载手段
app.post('/api/image-records/:id/mark-downloaded', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    // 项目组共享权限：自己创建的 或 同 project_members 任一行的记录都可标记
    const row = isAdmin
      ? db.prepare('SELECT id FROM image_records WHERE id = ?').get(id)
      : db.prepare(`SELECT id FROM image_records WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = image_records.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    db.prepare(`UPDATE image_records SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/audio-generations/:id/mark-downloaded - 标记音频记录已下载（持久化）
app.post('/api/audio-generations/:id/mark-downloaded', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = isAdmin
      ? db.prepare('SELECT id FROM audio_generations WHERE id = ?').get(id)
      : db.prepare(`SELECT id FROM audio_generations WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = audio_generations.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    db.prepare(`UPDATE audio_generations SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/image-records/:id - 软删图片记录（置 deleted_at）
app.delete('/api/image-records/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = isAdmin
      ? db.prepare('SELECT id, deleted_at FROM image_records WHERE id = ?').get(id)
      : db.prepare(`SELECT id, deleted_at FROM image_records WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = image_records.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    if (row.deleted_at) return res.json({ success: true });
    db.prepare('UPDATE image_records SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/audio-generations/:id - 软删音频记录（置 deleted_at + 同步软删中转视频）
app.delete('/api/audio-generations/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = isAdmin
      ? db.prepare('SELECT id, task_id, deleted_at FROM audio_generations WHERE id = ?').get(id)
      : db.prepare(`SELECT id, task_id, deleted_at FROM audio_generations WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = audio_generations.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    if (row.deleted_at) return res.json({ success: true });

    const tx = db.transaction(() => {
      db.prepare('UPDATE audio_generations SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      if (row.task_id) {
        db.prepare(
          "UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND task_kind = 'audio_intermediate' AND deleted_at IS NULL"
        ).run(row.task_id);
      }
    });
    tx();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/video-enhancements/:id/mark-downloaded - 标记画质增强结果已下载
app.post('/api/video-enhancements/:id/mark-downloaded', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = isAdmin
      ? db.prepare('SELECT id FROM video_enhancements WHERE id = ?').get(id)
      : db.prepare(`SELECT id FROM video_enhancements WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = video_enhancements.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    db.prepare(`UPDATE video_enhancements SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/video-enhancements/:id - 软删画质增强记录（置 deleted_at）
app.delete('/api/video-enhancements/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = isAdmin
      ? db.prepare('SELECT id, deleted_at FROM video_enhancements WHERE id = ?').get(id)
      : db.prepare(`SELECT id, deleted_at FROM video_enhancements WHERE id = ? AND (
          user_id = ? OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = video_enhancements.project_id AND pm.user_id = ?
          )
        )`).get(id, req.user.id, req.user.id);
    if (!row) return res.status(404).json({ error: '记录不存在或无权限' });
    if (row.deleted_at) return res.json({ success: true });
    db.prepare('UPDATE video_enhancements SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/generate-video - 提交任务, 立即返回 taskId
app.post('/api/generate-video', authenticate, upload.array('files', 5), async (req, res) => {
  const startTime = Date.now();

  try {
    const { prompt, ratio, duration, model, projectId: reqProjectId } = req.body;
    const referenceMode = req.body.referenceMode === 'first_last_frame' ? 'first_last_frame' : 'reference';
    const maxConcurrent = parseInt(settingsService.getSetting('max_concurrent') || '5', 10);
    const batchSize = Math.max(1, Math.min(parseInt(req.body.batchSize, 10) || 1, maxConcurrent || 5));
    const firstFrameProvided = String(req.body.firstFrameProvided || '') === 'true';
    const lastFrameProvided = String(req.body.lastFrameProvided || '') === 'true';
    const files = req.files;

    // 解析 OSS URL（JSON 数组字符串或逗号分隔）
    let imageUrls = [];
    let videoUrl = req.body.videoUrl || null;
    let audioUrl = req.body.audioUrl || null;
    try {
      imageUrls = JSON.parse(req.body.imageUrls || '[]');
    } catch {
      imageUrls = (req.body.imageUrls || '').split(',').map(s => s.trim()).filter(Boolean);
    }

    // 要求前端传入 projectId
    if (!reqProjectId) {
      return res.status(400).json({ error: '必须指定所属项目组（projectId）' });
    }

    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const targetProject = projectService.getProjectById(Number(reqProjectId), req.user.id, isAdmin);
    if (!targetProject) {
      return res.status(403).json({ error: '项目组不存在或您不是该项目组成员' });
    }

    const totalImages = (Array.isArray(files) ? files.length : 0) + imageUrls.length;
    const hasContent = (prompt && prompt.trim()) || totalImages > 0 || videoUrl || audioUrl;
    if (!hasContent) {
      return res.status(400).json({ error: '请提供文本提示词或上传参考素材' });
    }
    // 仅音频无画面（无图无视频）不支持
    if (audioUrl && totalImages === 0 && !videoUrl) {
      return res.status(400).json({ error: '仅上传音频无法生成视频，请同时提供图片或视频参考素材' });
    }
    // 首尾帧模式校验：允许无图/仅首/仅尾/首尾，超过 2 张拒绝
    if (referenceMode === 'first_last_frame' && totalImages > 2) {
      return res.status(400).json({ error: '首尾帧模式最多上传 2 张图片（首图+尾图）' });
    }
    if (referenceMode === 'first_last_frame' && totalImages > 0) {
      const expectedCount = Number(firstFrameProvided) + Number(lastFrameProvided);
      if (expectedCount !== totalImages) {
        return res.status(400).json({ error: '首尾帧图片数量与首图/尾图标记不一致' });
      }
    }

    // 功能权限拦截
    if (!permissionService.hasPermission(req.user.id, 'generate_video_seedance')) {
      return res.status(403).json({ error: '当前账号未开通视频生成权限，请联系管理员' });
    }

    // 推断分辨率档位（VIP=720p；普通=720p；后续可由模型规格表定义）
    const resolvedModel = model || 'seedance-2.0';
    const hasVideoInput = !!videoUrl;
    let resolution = req.body.resolution || '720p';
    if (!['480p', '720p', '1080p'].includes(resolution)) {
      resolution = '720p';
    }
    if (resolution === '1080p' && resolvedModel === 'seedance-2.0-fast') {
      return res.status(400).json({ error: '快速模型不支持 1080p，请选择 480p 或 720p' });
    }
    const estimateParams = {
      inputDurationSec: Number(req.body.inputDurationSec) || 0,
      outputDurationSec: Number(duration) || 5,
      resolution,
      ratio: ratio || '16:9',
      hasVideoInput,
      hasAudio: !!audioUrl,
      isDraft: false,
    };
    const estimateResult = pricingService.estimate(resolvedModel, estimateParams);
    const lockedCredits = estimateResult.lockedCredits;

    // 检查用户额度（积分 - 已锁定 ≥ lockedCredits）
    const quota = usageService.checkUserQuota(req.user.id);
    if (!quota.allowed) {
      return res.status(402).json({ error: `积分不足（当前 ${quota.credits}），请联系管理员充值` });
    }
    if (!quota.unlimited) {
      const lockedSum = creditLockService.getLockedTotal(req.user.id);
      const available = quota.credits - lockedSum;
      const totalNeeded = lockedCredits * batchSize;
      if (lockedCredits > 0 && available < totalNeeded) {
        return res.status(402).json({
          error: batchSize > 1
            ? `批量生成 ${batchSize} 个任务积分不足（可用 ${available}，需要 ${totalNeeded}）`
            : `可用积分不足（可用 ${available}，本次预计需要 ${lockedCredits}）`,
          estimate: estimateResult,
        });
      }
    }

    // 批量生成时生成批次 ID
    const concurrentId = batchSize > 1 ? crypto.randomUUID() : null;

    const apiKey = resolveProjectApiKey(targetProject.id);
    if (!apiKey) {
      return res.status(401).json({ error: getMissingSessionErrorMessage() });
    }

    // 创建 N 个任务（batchSize ≥ 1）
    const taskIds = [];
    const dbTaskIds = [];
    const memTasks = [];
    let creditLockFailed = false;

    for (let i = 0; i < batchSize; i++) {
      const taskId = createTaskId();
      const task = {
        id: taskId,
        status: 'processing',
        progress: '正在准备...',
        startTime,
        result: null,
        error: null,
      };
      tasks.set(taskId, task);
      taskIds.push(taskId);
      memTasks.push(task);

      try {
        const createdTask = taskService.createTask({
          projectId: targetProject.id,
          userId: req.user.id,
          prompt: prompt || '',
          model: model || null,
          ratio: ratio || null,
          duration: duration ? String(duration) : null,
          resolution: req.body.resolution || null,
          status: 'generating',
          downloadStatus: 'pending',
          progress: '正在准备...',
          startedAt: new Date().toISOString(),
          concurrentId: concurrentId,
        });
        const thisDbTaskId = createdTask.id;
        dbTaskIds.push(thisDbTaskId);
        console.log(`[生成任务] 数据库记录已创建，db_task_id = ${thisDbTaskId}, project_id = ${targetProject.id}${concurrentId ? ', concurrent_id = ' + concurrentId : ''}`);

        // 保存素材 URL 到 task_assets（每个任务独立一份）
        {
          const db = getDatabase();
          let sortOrder = 0;
          const getOriginalName = (url) => {
            if (url.startsWith('asset://')) return url;
            const row = db.prepare('SELECT original_name FROM uploads WHERE oss_url = ?').get(url);
            if (row) return row.original_name;
            return url.split('/').pop()?.split('?')[0] || 'file';
          };
          for (const url of imageUrls) {
            db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'image', '', ?, ?, ?)`)
              .run(thisDbTaskId, url, getOriginalName(url), sortOrder++);
          }
          if (videoUrl) {
            db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'video', '', ?, ?, ?)`)
              .run(thisDbTaskId, videoUrl, getOriginalName(videoUrl), sortOrder++);
          }
          if (audioUrl) {
            db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'audio', '', ?, ?, ?)`)
              .run(thisDbTaskId, audioUrl, getOriginalName(audioUrl), sortOrder++);
          }
        }

        // 锁定预估积分
        if (lockedCredits > 0) {
          try {
            creditLockService.lock({
              userId: req.user.id,
              taskId: thisDbTaskId,
              estimatedCredits: estimateResult.credits,
              lockedCredits,
              meta: { ...estimateParams, model: resolvedModel },
            });
            console.log(`[积分] 锁定 ${lockedCredits}（预估 ${estimateResult.credits}）user=${req.user.id} task=${thisDbTaskId}`);
          } catch (lockErr) {
            console.error('[积分] 锁定失败：', lockErr.message);
            if (thisDbTaskId) {
              try { taskService.updateTaskStatus(thisDbTaskId, 'error', { error_message: '积分锁定失败：' + lockErr.message }); } catch {}
            }
            creditLockFailed = true;
            if (!res.headersSent) {
              res.status(402).json({ error: '积分锁定失败，任务已取消：' + lockErr.message });
            }
            break;
          }
        }
      } catch (dbError) {
        console.error('[生成任务] 创建数据库记录失败:', dbError.message);
        creditLockFailed = true;
        break;
      }
    }

    if (creditLockFailed) return;

    console.log(`\n========== 收到视频生成请求 (批量=${batchSize}) ==========`);
    console.log(`  prompt: ${(prompt || '').substring(0, 80)}${(prompt || '').length > 80 ? '...' : ''}`);
    console.log(`  model: ${model || 'seedance-2.0'}, ratio: ${ratio || '4:3'}, duration: ${duration || 4}秒`);
    console.log(`  files: ${(files || []).length}张, batchSize: ${batchSize}, concurrentId: ${concurrentId || '(无)'}`);
    console.log(`  dbTaskIds: [${dbTaskIds.join(', ')}]`);

    // 批量生成返回 taskIds 数组，单次生成保持向后兼容
    if (batchSize > 1) {
      res.json({ taskIds: dbTaskIds, concurrent_id: concurrentId });
    } else {
      res.json({ taskId: dbTaskIds[0], dbTaskId: dbTaskIds[0] });
    }

    // 将 prompt 中的 @asset-xxx chip 标签转换为 Ark API 要求的"图片N/视频N/音频N"格式
    // 官方文档要求 content.text 中用位置序号指代素材，不能用 asset ID
    let finalPrompt = prompt || '';
    {
      let imgIdx = 0;
      for (const url of (imageUrls || [])) {
        imgIdx++;
        if (url && url.startsWith('asset://')) {
          const assetId = url.slice('asset://'.length);
          finalPrompt = finalPrompt.replaceAll(`@${assetId}`, `图片${imgIdx}`);
        }
      }
      if (videoUrl && videoUrl.startsWith('asset://')) {
        const assetId = videoUrl.slice('asset://'.length);
        finalPrompt = finalPrompt.replaceAll(`@${assetId}`, `视频1`);
      }
      if (audioUrl && audioUrl.startsWith('asset://')) {
        const assetId = audioUrl.slice('asset://'.length);
        finalPrompt = finalPrompt.replaceAll(`@${assetId}`, `音频1`);
      }
      // 去掉上传素材 chip 的 @ 前缀：@图片1 → 图片1, @视频1 → 视频1, @音频1 → 音频1
      finalPrompt = finalPrompt.replace(/@(图片|视频|音频)(\d+)/g, '$1$2');
      if (finalPrompt !== (prompt || '')) {
        console.log(`[prompt转换] 原始: ${(prompt || '').substring(0, 100)}`);
        console.log(`[prompt转换] 转换后: ${finalPrompt.substring(0, 100)}`);
      }
    }

    // 为每个任务启动异步生成（批次内每个请求间隔 2s 避免瞬时并发冲击）
    for (let i = 0; i < dbTaskIds.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const dbTaskId = dbTaskIds[i];
      const taskId = taskIds[i];
      const task = memTasks[i];

      generateSeedanceVideoCore({
        prompt: finalPrompt,
        ratio: ratio || '4:3',
        duration: parseInt(duration) || 4,
        resolution,
        files: files || [],
        imageUrls: imageUrls || [],
        videoUrl: videoUrl || null,
        audioUrl: audioUrl || null,
        sessionId: apiKey,
        model: model || 'seedance-2.0',
        referenceMode,
        firstFrameProvided,
        lastFrameProvided,
        onProgress: async (progress) => {
          task.progress = progress;
          console.log(`[${taskId}] 进度：${progress}`);
          if (dbTaskId) {
            try { taskService.updateTask(dbTaskId, { progress }); } catch {}
          }
        },
        onSubmitId: async (submitId) => {
          if (dbTaskId) {
            try {
              taskService.updateTask(dbTaskId, { submit_id: submitId, submitted_at: new Date().toISOString() });
              console.log(`[生成任务] submitId 已保存到数据库：${submitId}`);
            } catch {}
          }
        },
        onHistoryId: async (historyId) => {
          if (dbTaskId) {
            try {
              taskService.updateTask(dbTaskId, { history_id: historyId, status: 'generating' });
              console.log(`[生成任务] historyId 已保存到数据库：${historyId}`);
            } catch {}
          }
        },
        onItemId: async (itemId) => {
          if (dbTaskId) {
            try {
              taskService.updateTask(dbTaskId, { item_id: itemId });
              console.log(`[生成任务] itemId 已保存到数据库：${itemId}`);
            } catch {}
          }
        },
        onVideoReady: async (videoUrl) => {
          if (dbTaskId) {
            try { taskService.updateTask(dbTaskId, { video_url: videoUrl }); } catch {}
          }
        },
      })
        .then((result) => {
          try {
            console.log(`[计费][ark-usage] task=${dbTaskId} usage=${JSON.stringify(result?.usage || null)}`);
            const tokens = Number(result?.usage?.total_tokens) || Number(result?.usage?.completion_tokens) || 0;
            if (dbTaskId) {
              if (tokens > 0) {
                const actualCredits = pricingService.actualCredits(model || 'seedance-2.0', tokens, estimateParams);
                creditLockService.settle({ taskId: dbTaskId, actualCredits });
                console.log(`[积分] 结算 task=${dbTaskId} tokens=${tokens} credits=${actualCredits}`);
              } else {
                creditLockService.release({ taskId: dbTaskId, reason: 'usage 缺失或 token=0，视为未计费' });
                console.log(`[积分] 释放 task=${dbTaskId}（usage 缺失）`);
              }
            }
          } catch (usageErr) {
            console.error('[usage] 结算积分失败:', usageErr.message);
          }
          task.status = 'done';
          task.result = {
            created: Math.floor(Date.now() / 1000),
            data: [{ url: result.videoUrl, revised_prompt: result.revisedPrompt || prompt || '' }],
          };
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`========== [${taskId}] ✅ 视频生成成功 (${elapsed}秒) ==========\n`);

          if (dbTaskId) {
            try {
              taskService.updateTaskStatus(dbTaskId, 'done', {
                submit_id: result.submitId || null,
                history_id: result.historyId || null,
                item_id: result.itemId || null,
                video_url: result.videoUrl,
                progress: '',
                error_message: null,
              });
              console.log('[生成任务] 数据库记录已更新，status = done');
            } catch (dbError) {
              console.error('[生成任务] 更新数据库记录失败:', dbError.message);
            }
          }
        })
        .catch((err) => {
          task.status = 'error';
          task.error = err.message || '视频生成失败';
          try {
            if (dbTaskId) {
              creditLockService.release({ taskId: dbTaskId, reason: err.message || '生成失败' });
              console.log(`[积分] 释放 task=${dbTaskId}（生成失败）`);
            }
            usageService.logFailure({ userId: req.user.id, taskId: dbTaskId, model: model || 'seedance-2.0', errorMessage: err.message });
          } catch (usageErr) {
            console.error('[usage] 释放积分失败:', usageErr.message);
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.error(`========== [${taskId}] ❌ 视频生成失败 (${elapsed}秒): ${err.message} ==========\n`);
          if (err.stack) console.error(err.stack);

          if (dbTaskId) {
            try {
              taskService.updateTaskStatus(dbTaskId, 'error', {
                progress: '',
                error_message: err.message,
              });
              console.log('[生成任务] 数据库记录已更新，status = error');
            } catch (dbError) {
              console.error('[生成任务] 更新数据库记录失败:', dbError.message);
            }
          }
        });
    }
  } catch (error) {
    console.error(`请求处理错误: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
});

// GET /api/task/:taskId - 轮询任务状态（优先查 DB + Ark API，内存 Map 作为兜底）
app.get('/api/task/:taskId', authenticate, async (req, res) => {
  const taskIdParam = req.params.taskId;
  const db = getDatabase();

  // 尝试从 DB 查（taskId 可能是 DB id 或旧的内存 UUID）
  const dbTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskIdParam);

  if (dbTask) {
    // 检查归属：任务创建者 或 同项目组成员 或 管理员
    const isAdminUser = ['admin', 'super_admin'].includes(req.user.role);
    if (!isAdminUser && dbTask.user_id !== req.user.id) {
      const isMember = db.prepare(
        'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?'
      ).get(dbTask.project_id, req.user.id);
      if (!isMember) {
        return res.status(403).json({ error: '无权访问此任务' });
      }
    }

    if (dbTask.status === 'done') {
      return res.json({ status: 'done', result: { created: Math.floor(Date.now() / 1000), data: [{ url: dbTask.video_url, revised_prompt: dbTask.prompt }] } });
    }

    if (dbTask.status === 'error') {
      return res.json({ status: 'error', error: dbTask.error_message || '生成失败' });
    }

    // 仍在生成中 — 用 submit_id 直接查 Ark API
    const arkTaskId = dbTask.submit_id || dbTask.history_id;
    if (arkTaskId) {
      try {
        const apiKey = resolveProjectApiKey(dbTask.project_id);
        if (apiKey) {
          const arkResult = await getArkTask(apiKey, arkTaskId);

          if (arkResult.status === 'succeeded') {
            const videoUrl = arkResult.content?.video_url;
            if (videoUrl) {
              taskService.updateTask(dbTask.id, { status: 'done', video_url: videoUrl, download_status: 'pending', progress: '', completed_at: new Date().toISOString() });
              // 同步结算积分锁（settle 幂等，若 generator 的 .then() 已结算会跳过）
              try {
                const tokens = Number(arkResult?.usage?.total_tokens) || Number(arkResult?.usage?.completion_tokens) || 0;
                if (tokens > 0) {
                  const lockRow = db.prepare('SELECT meta FROM credit_locks WHERE task_id = ? AND status = ?').get(dbTask.id, 'locked');
                  if (lockRow) {
                    const estimateParams = JSON.parse(lockRow.meta || '{}');
                    const actualCredits = pricingService.actualCredits(estimateParams.model || dbTask.model || 'seedance-2.0', tokens, estimateParams);
                    creditLockService.settle({ taskId: dbTask.id, actualCredits });
                  }
                } else {
                  creditLockService.release({ taskId: dbTask.id, reason: '轮询补结算：usage 缺失' });
                }
              } catch (e) { console.error('[poll] 补结算失败:', e.message); }
              return res.json({ status: 'done', result: { created: Math.floor(Date.now() / 1000), data: [{ url: videoUrl, revised_prompt: dbTask.prompt }] } });
            }
          }

          if (arkResult.status === 'failed') {
            const errMsg = arkResult.error?.message || arkResult.error?.code || 'Ark 任务失败';
            taskService.updateTask(dbTask.id, { status: 'error', error_message: errMsg, progress: '' });
            try { creditLockService.release({ taskId: dbTask.id, reason: '轮询补结算：' + errMsg }); } catch (e) { console.error('[poll] 补释放失败:', e.message); }
            return res.json({ status: 'error', error: errMsg });
          }
        }
      } catch (err) {
        console.error('[poll] Ark API 查询失败:', err.message);
      }
    }

    const elapsed = Math.floor((Date.now() - new Date(dbTask.started_at || dbTask.created_at).getTime()) / 1000);
    return res.json({ status: 'processing', elapsed, progress: dbTask.progress || '生成中...' });
  }

  // 兜底：旧内存 Map（容器未重启时有效）
  const memTask = tasks.get(taskIdParam);
  if (!memTask) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const elapsed = Math.floor((Date.now() - memTask.startTime) / 1000);
  if (memTask.status === 'done') {
    res.json({ status: 'done', elapsed, result: memTask.result });
    setTimeout(() => tasks.delete(memTask.id), 300000);
    return;
  }
  if (memTask.status === 'error') {
    res.json({ status: 'error', elapsed, error: memTask.error });
    setTimeout(() => tasks.delete(memTask.id), 300000);
    return;
  }
  res.json({ status: 'processing', elapsed, progress: memTask.progress });
});

// GET /api/video-proxy - 代理视频流，绕过 CDN 跨域限制
app.get('/api/video-proxy', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  try {
    console.log(`[video-proxy] 代理视频: ${videoUrl.substring(0, 100)}...`);

    const response = await fetch(videoUrl, {
      headers: {
        'User-Agent': FAKE_HEADERS['User-Agent'],
        Referer: 'https://jimeng.jianying.com/',
      },
    });

    if (!response.ok) {
      console.error(`[video-proxy] 上游错误: ${response.status}`);
      return res.status(response.status).json({ error: `视频获取失败: ${response.status}` });
    }

    // 转发响应头
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (req.query.download) {
      const rawName = String(req.query.download);
      const safeAscii = rawName.replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(rawName)}`);
    }

    // 流式转发视频数据
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        if (!res.write(value)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    };
    pump().catch((err) => {
      console.error(`[video-proxy] 流传输错误: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (error) {
    console.error(`[video-proxy] 错误: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: '视频代理失败' });
    }
  }
});

// multer 错误处理
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: '文件大小超过限制 (最大20MB)' });
    if (err.code === 'LIMIT_FILE_COUNT')
      return res.status(400).json({ error: '文件数量超过限制 (最多5个)' });
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ============================================================
// 批量管理功能 API 路由
// ============================================================

// -------------------- 项目管理 --------------------
// GET /api/projects - 获取项目列表（始终只返回当前用户自己的项目组）
app.get('/api/projects', authenticate, (req, res) => {
  try {
    const projects = projectService.getAllProjects(req.user.id, false);
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 项目组名称去重：全局唯一，重名时自动追加（2）（3）... ────────────
function resolveProjectName(db, excludeId, name) {
  let result = name;
  let suffix = 2;
  while (true) {
    const dup = excludeId
      ? db.prepare('SELECT id FROM projects WHERE name = ? AND id != ?').get(result, excludeId)
      : db.prepare('SELECT id FROM projects WHERE name = ?').get(result);
    if (!dup) break;
    result = `${name}（${suffix}）`;
    suffix++;
  }
  return result;
}

// POST /api/projects - 创建项目
app.post('/api/projects', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { name, description, settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }
    const finalName = resolveProjectName(db, null, name.trim());
    const project = projectService.createProject({ name: finalName, description, settings, user_id: req.user.id });
    res.json({ success: true, data: project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/projects/:id - 获取项目详情
app.get('/api/projects/:id', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    res.json({ success: true, data: project });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/projects/:id - 更新项目
app.put('/api/projects/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    // 非管理员只能更新自己的项目
    if (!isAdmin && project.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此项目' });
    }
    const { name, description, settings, video_save_path, default_concurrent, default_min_interval, default_max_interval } = req.body;
    const finalName = name ? resolveProjectName(db, req.params.id, name.trim()) : undefined;
    const updated = projectService.updateProject(req.params.id, {
      name: finalName,
      description,
      settings_json: settings ? JSON.stringify(settings) : undefined,
      video_save_path,
      default_concurrent,
      default_min_interval,
      default_max_interval,
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:id/rename - 重命名项目组
app.post('/api/projects/:id/rename', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    if (!isAdmin && project.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此项目' });
    }
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '名称不能为空' });
    }
    const finalName = resolveProjectName(db, req.params.id, name.trim());
    const updated = projectService.updateProject(req.params.id, { name: finalName });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/projects/:id - 删除项目
app.delete('/api/projects/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    // 非管理员只能删除自己创建的项目（owner 角色）
    if (!isAdmin && project.my_role !== 'owner') {
      return res.status(403).json({ error: '无权删除此项目，仅创建者或管理员可删除' });
    }
    projectService.deleteProject(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/projects/:id/tasks - 获取项目下的任务列表
app.get('/api/projects/:id/tasks', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.id, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在或无权访问' });
    }

    const { status, taskKind, sourceTaskId, rowGroupId } = req.query;
    const tasks = taskService.getTasksByProjectId(req.params.id, {
      status: typeof status === 'string' ? status : undefined,
      taskKind: typeof taskKind === 'string' ? taskKind : undefined,
      sourceTaskId: sourceTaskId !== undefined ? Number(sourceTaskId) : undefined,
      rowGroupId: typeof rowGroupId === 'string' ? rowGroupId : undefined,
    }, req.user.id, isAdmin);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- 任务管理 --------------------
// GET /api/tasks/:id - 获取任务详情
app.get('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:projectId/tasks - 创建任务
app.post('/api/projects/:projectId/tasks', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(req.params.projectId, req.user.id, isAdmin);
    if (!project) {
      return res.status(404).json({ success: false, error: '项目不存在或无权访问' });
    }

    const { prompt = '' } = req.body || {};

    if (!String(prompt).trim()) {
      return res.status(400).json({ success: false, error: '任务提示词不能为空' });
    }

    const task = taskService.createTask({
      projectId: req.params.projectId,
      prompt,
      userId: req.user.id,
    });
    res.json({ success: true, data: task });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/tasks/:id - 更新任务
app.put('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能更新自己创建的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改他人任务' });
    }
    const updates = req.body;
    const updated = taskService.updateTask(req.params.id, updates);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tasks/:id - 删除任务
app.delete('/api/tasks/:id', authenticate, (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能删除自己创建的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除他人任务' });
    }
    taskService.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/assets - 添加任务素材
app.post('/api/tasks/:id/assets', authenticate, upload.fields([
  { name: 'images', maxCount: 5 },
  { name: 'audios', maxCount: 2 },
]), async (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能为自己创建的任务添加素材
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权为此任务添加素材' });
    }

    const files = req.files;
    const results = [];

    // 处理图片
    if (files.images) {
      for (const file of files.images) {
        const saveDir = path.join(__dirname, '../data/assets/tasks', req.params.id);
        const filename = `${Date.now()}_${file.originalname}`;

        // 确保目录存在
        const fs = await import('fs');
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }

        const filePath = path.join(saveDir, filename);
        fs.writeFileSync(filePath, file.buffer);

        const asset = taskService.addTaskAsset(req.params.id, {
          assetType: 'image',
          filePath,
          sortOrder: results.filter(r => r.asset_type === 'image').length,
        });
        results.push(asset);
      }
    }

    // 处理音频
    if (files.audios) {
      for (const file of files.audios) {
        const saveDir = path.join(__dirname, '../data/assets/tasks', req.params.id);
        const filename = `${Date.now()}_${file.originalname}`;

        const fs = await import('fs');
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }

        const filePath = path.join(saveDir, filename);
        fs.writeFileSync(filePath, file.buffer);

        const asset = taskService.addTaskAsset(req.params.id, {
          assetType: 'audio',
          filePath,
          sortOrder: results.filter(r => r.asset_type === 'audio').length,
        });
        results.push(asset);
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tasks/:id/assets - 获取任务素材列表
app.get('/api/tasks/:id/assets', authenticate, (req, res) => {
  try {
    const task = taskService.getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (req.user.role !== "admin" && !projectService.isProjectMember(task.project_id, req.user.id)) {
      return res.status(403).json({ error: '无权访问' });
    }
    const assets = taskService.getTaskAssets(req.params.id);
    res.json({ success: true, data: assets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/tasks/assets/:assetId - 删除任务素材
app.delete('/api/tasks/assets/:assetId', authenticate, (req, res) => {
  try {
    taskService.deleteTaskAsset(req.params.assetId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



// POST /api/tasks/:id/cancel - 取消任务（包括正在生成的任务）
app.post('/api/tasks/:id/cancel', authenticate, async (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能取消自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权取消此任务' });
    }

    // 直接取消任务 + 释放锁定积分
    taskService.updateTaskStatus(req.params.id, 'cancelled', {
      progress: '',
      error_message: '用户取消任务',
    });
    try {
      creditLockService.release({ taskId: req.params.id, reason: '用户取消' });
    } catch (e) {
      console.error('[积分] 释放锁定失败:', e.message);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/collect - 二次采集视频（根据 history_id）
app.post('/api/tasks/:id/collect', authenticate, async (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    // 非管理员只能采集自己的任务
    if (!isAdmin && task.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权采集此任务' });
    }
    if (!task.history_id) {
      return res.status(400).json({ error: '任务没有 history_id，无法采集' });
    }

    const sessionId = req.body.sessionId || resolveApiKey();
    if (!sessionId) {
      return res.status(400).json({ error: getMissingSessionErrorMessage() });
    }

    const resolved = await resolveTaskVideoByHistory(sessionId, task);
    if (!resolved.itemId) {
      return res.status(404).json({ error: '即梦 API 未找到该历史记录对应的视频条目' });
    }
    if (!resolved.videoUrl) {
      return res.status(400).json({ error: '历史记录中没有视频 URL，可能还在生成中' });
    }

    const db = getDatabase();
    persistResolvedVideoTask(db, task.id, resolved);

    res.json({
      success: true,
      data: {
        videoUrl: resolved.videoUrl,
        historyId: task.history_id,
        itemId: resolved.itemId,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/download - 下载任务视频
app.post('/api/tasks/:id/download', authenticate, async (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }

    const downloadPath = videoDownloader.getDefaultDownloadPath();
    const result = await videoDownloader.downloadVideoByTaskId(task.id, downloadPath);

    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/tasks/:id/open-folder - 打开视频所在文件夹
app.post('/api/tasks/:id/open-folder', authenticate, async (req, res) => {
  try {
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const task = taskService.getTaskById(req.params.id, req.user.id, isAdmin);
    if (!task) {
      return res.status(404).json({ error: '任务不存在或无权访问' });
    }
    if (!task.video_path) {
      return res.status(400).json({ error: '视频尚未下载' });
    }

    const result = await videoDownloader.openVideoFolder(task.video_path);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- 全局设置 --------------------
// GET /api/settings - 获取全局设置
app.get('/api/settings', authenticate, (req, res) => {
  try {
    const settings = settingsService.getAllSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings - 更新全局设置
app.put('/api/settings', authenticate, (req, res) => {
  try {
    const settings = req.body;
    const updated = settingsService.updateSettings(settings);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/activate - 用激活码兑换积分
app.post('/api/settings/activate', authenticate, (req, res) => {
  try {
    const { code } = req.body;
    jimengSessionService.redeemActivationCode(req.user.id, code);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/batch-concurrent - 获取批量生成设置（仅系统管理员）
app.get('/api/admin/batch-concurrent', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const maxConcurrent = settingsService.getSetting('max_concurrent') || '5';
    res.json({ success: true, data: { max_concurrent: maxConcurrent } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/batch-concurrent - 更新批量生成设置（仅系统管理员）
app.put('/api/admin/batch-concurrent', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const { max_concurrent } = req.body;
    const n = parseInt(max_concurrent, 10);
    if (isNaN(n) || n < 1 || n > 10) {
      return res.status(400).json({ error: '批量生成数量上限需在 1-10 之间' });
    }
    settingsService.updateSetting('max_concurrent', String(n));
    res.json({ success: true, data: { max_concurrent: String(n) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------- 下载 API --------------------
function sendDownloadedVideoFile(res, result) {
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.download(result.filePath, result.filename);
}

// GET /api/download/tasks/:id/preview - 流式预览服务器本地已保存的视频（支持 Range）
app.get('/api/download/tasks/:id/preview', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }

    const filePath = result.filePath;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`);

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/video-proxy-token - 创建远程视频代理下载 token（CORS 回退方案）
app.post('/api/download/video-proxy-token', authenticate, async (req, res) => {
  try {
    const { videoUrl, filename } = req.body || {};
    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ error: '缺少 videoUrl' });
    }
    // 用 URL 的 hash 作为 taskId 占位（只需要唯一标识，不需要真实 taskId）
    const pseudoId = crypto.createHash('md5').update(videoUrl).digest('hex').slice(0, 8);
    const token = createDownloadToken(pseudoId, req.user.id, { videoUrl, filename: filename || 'video.mp4' });
    res.json({ success: true, data: { token } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/video-by-token - 使用 token 代理下载远程视频（无需登录态，支持断点续传）
app.get('/api/download/video-by-token', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      return res.status(400).json({ error: '下载参数无效' });
    }

    const record = validateDownloadToken(token);
    if (!record || !record.videoUrl) {
      return res.status(401).json({ error: '下载链接已失效，请重试' });
    }

    const headers = {};
    const range = req.headers.range;
    if (range) headers.Range = range;

    const upstream = await fetch(record.videoUrl, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: `上游视频请求失败 HTTP ${upstream.status}` });
    }

    const contentLength = upstream.headers.get('content-length');
    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    const contentRange = upstream.headers.get('content-range');

    if (upstream.status === 206 && contentRange) {
      res.status(206);
      res.setHeader('Content-Range', contentRange);
      res.setHeader('Accept-Ranges', 'bytes');
    } else {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${record.filename || 'video.mp4'}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    };
    pump().catch(() => { if (!res.writableEnded) res.end(); });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST /api/download/tasks/:id/file-token - 创建一次性下载 token
app.post('/api/download/tasks/:id/file-token', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error === '视频文件不存在，可能已被删除'
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    const token = createDownloadToken(taskId, req.user.id);
    res.json({ success: true, data: { token } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/file-by-token - 使用一次性 token 下载服务器本地已保存的视频文件
app.get('/api/download/file-by-token', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const userIdParam = req.query.userId;
    const userId = userIdParam === undefined || userIdParam === null || userIdParam === ''
      ? null
      : Number(userIdParam);
    if (!token) {
      return res.status(400).json({ error: '下载参数无效' });
    }

    const record = consumeDownloadToken(token, Number.isFinite(userId) ? userId : null);
    if (!record) {
      return res.status(401).json({ error: '下载链接已失效，请重试' });
    }

    const result = videoDownloader.getDownloadedVideoFileByTaskId(record.taskId);
    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error === '视频文件不存在，可能已被删除'
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    sendDownloadedVideoFile(res, result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/download/tasks/:id/file - 下载服务器本地已保存的视频文件
app.get('/api/download/tasks/:id/file', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = videoDownloader.getDownloadedVideoFileByTaskId(taskId);

    if (!result.success) {
      const statusCode = result.error === '任务不存在'
        ? 404
        : result.error === '任务尚未下载到服务器' || result.error === '视频文件不存在，可能已被删除'
          ? 400
          : 500;
      return res.status(statusCode).json({ error: result.error });
    }

    sendDownloadedVideoFile(res, result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 下载管理 API 路由
// ============================================================

// GET /api/download/tasks - 获取下载任务列表
app.get('/api/download/tasks', authenticate, (req, res) => {
  try {
    const { status = 'all', type = 'all', page = 1, pageSize = 20, projectId, includeHappyhorse, groupByConcurrent } = req.query;
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const result = videoDownloader.getDownloadTasks({
      status,
      type,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      userId: req.user.id,
      isAdmin,
      projectId: projectId ? Number(projectId) : null,
      // 仅当显式 ?includeHappyhorse=1 时，把 HappyHorse 行合并到 video / all
      includeHappyhorse: includeHappyhorse === '1' || includeHappyhorse === 'true',
      groupByConcurrent: groupByConcurrent === '1' || groupByConcurrent === 'true',
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/refresh - 查询 Ark API 更新所有 generating 任务状态
app.post('/api/download/refresh', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const userWhereClause = isAdmin ? '' : 'AND t.user_id = ?';
    const userParams = isAdmin ? [] : [req.user.id];

    const generatingTasks = db.prepare(`
      SELECT t.id, t.user_id, t.submit_id, t.history_id, t.prompt,
             COALESCE(t.submitted_at, t.created_at) as createdAt
      FROM tasks t
      WHERE t.status IN ('generating', 'processing')
        AND (t.submit_id IS NOT NULL OR t.history_id IS NOT NULL)
        AND t.deleted_at IS NULL
        ${userWhereClause}
    `).all(...userParams);

    let refreshed = 0;

    await Promise.all(generatingTasks.map(async (task) => {
      const arkTaskId = task.submit_id || task.history_id;
      if (!arkTaskId) return;
      try {
        const apiKey = resolveProjectApiKey(task.project_id);
        if (!apiKey) return;

        const arkResult = await getArkTask(apiKey, arkTaskId);

        if (arkResult.status === 'succeeded') {
          const videoUrl = arkResult.content?.video_url;
          if (videoUrl) {
            taskService.updateTask(task.id, { status: 'done', video_url: videoUrl, progress: '', completed_at: new Date().toISOString() });
            refreshed++;
          }
        } else if (arkResult.status === 'failed') {
          const errMsg = arkResult.error?.message || arkResult.error?.code || 'Ark 任务失败';
          taskService.updateTask(task.id, { status: 'error', error_message: errMsg, progress: '' });
          refreshed++;
        }
      } catch (err) {
        console.error(`[refresh] 查询任务 ${task.id} (${arkTaskId}) 失败:`, err.message);
      }
    }));

    // 重新查还在 generating 的任务
    const stillGenerating = db.prepare(`
      SELECT t.id as taskId, t.history_id as historyId, COALESCE(t.submitted_at, t.created_at) as createdAt
      FROM tasks t
      WHERE t.status IN ('generating', 'processing')
        AND t.deleted_at IS NULL
        ${userWhereClause}
    `).all(...userParams);

    res.json({
      success: true,
      data: {
        refreshed,
        total: stillGenerating.length,
        generating: stillGenerating.length,
        generatingTasks: stillGenerating,
        message: `已刷新，${refreshed} 个任务状态更新`,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/tasks/:id/mark-downloaded - 标记任务已下载到本地
app.post('/api/download/tasks/:id/mark-downloaded', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const task = db.prepare('SELECT id, user_id FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (!['admin', 'super_admin'].includes(req.user.role) && task.user_id !== req.user.id) return res.status(403).json({ error: '无权操作' });
    db.prepare('UPDATE tasks SET download_status = ?, downloaded_at = ? WHERE id = ?')
      .run('done', new Date().toISOString(), task.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/sync-from-jimeng - 已删除：Ark API 生成的视频会自动记录，无需手工同步

// POST /api/download/tasks/:id - 下载单个任务视频
app.post('/api/download/tasks/:id', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    // 获取任务信息
    const task = db.prepare(`
      SELECT t.*, p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ? AND t.deleted_at IS NULL
    `).get(taskId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (req.user.role !== "admin" && req.user.role !== "super_admin" && !projectService.isProjectMember(task.project_id, req.user.id)) {
      return res.status(403).json({ error: '无权访问' });
    }

    if (!task.video_url) {
      return res.status(400).json({ error: '视频仍在生成中，暂时无法下载' });
    }

    // 更新状态为 downloading
    videoDownloader.updateDownloadStatus(taskId, 'downloading');

    // 获取下载路径
    const baseDownloadPath = videoDownloader.getDefaultDownloadPath();

    // 下载视频
    const result = await videoDownloader.downloadVideoByTaskId(taskId, baseDownloadPath);

    if (result.success) {
      videoDownloader.updateDownloadStatus(taskId, 'done', { downloadPath: result.path });
      res.json({ success: true, data: { path: result.path, size: result.size } });
    } else {
      videoDownloader.updateDownloadStatus(taskId, 'failed', { error: result.error });
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/batch - 批量下载视频
app.post('/api/download/batch', authenticate, async (req, res) => {
  try {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds 必须是非空数组' });
    }

    if (req.user.role !== "admin" && req.user.role !== "super_admin") {
      for (const t of tasks) {
        if (!projectService.isProjectMember(t.project_id, req.user.id)) {
          return res.status(403).json({ error: `无权访问任务 ${t.id}` });
        }
      }
    }

    const baseDownloadPath = videoDownloader.getDefaultDownloadPath();
    const results = await videoDownloader.batchDownloadVideos(taskIds, baseDownloadPath);

    // 更新下载状态
    const db = getDatabase();
    for (const result of results) {
      if (result.success) {
        videoDownloader.updateDownloadStatus(result.taskId, 'done', { downloadPath: result.path });
      } else {
        videoDownloader.updateDownloadStatus(result.taskId, 'failed', { error: result.error });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download/tasks/:id/open - 打开视频所在文件夹
app.post('/api/download/tasks/:id/open', authenticate, async (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const task = db.prepare('SELECT video_path, project_id FROM tasks WHERE id = ?').get(taskId);
    if (!task || !task.video_path) {
      return res.status(404).json({ error: '任务不存在或未下载' });
    }
    if (req.user.role !== "admin" && req.user.role !== "super_admin" && !projectService.isProjectMember(task.project_id, req.user.id)) {
      return res.status(403).json({ error: '无权访问' });
    }(task.video_path);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/download/tasks/:id - 软删任务（置 deleted_at）
app.delete('/api/download/tasks/:id', authenticate, (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const task = db.prepare('SELECT project_id, deleted_at FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.deleted_at) {
      return res.json({ success: true }); // 已软删，幂等
    }
    if (req.user.role !== "admin" && req.user.role !== "super_admin" && !projectService.isProjectMember(task.project_id, req.user.id)) {
      return res.status(403).json({ error: '无权访问' });
    }

    db.prepare('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(taskId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 认证相关 API
// ============================================================

// POST /api/auth/register - 用户注册
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, emailCode } = req.body;

    const _regDb = getDatabase();
    const _regRow = _regDb.prepare("SELECT value FROM system_config WHERE key = 'registration_enabled'").get();
    if (_regRow && _regRow.value === '0') {
      return res.status(403).json({ error: '注册功能已关闭' });
    }

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const result = await authService.registerUser(email, password, emailCode);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/login - 用户登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' });
    }

    const result = await authService.loginUser(email, password);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// POST /api/auth/logout - 用户登出
app.post('/api/auth/logout', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
      await authService.logoutUser(sessionId);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me - 获取当前用户信息
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: { user: req.user } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/me - 更新当前用户信息（姓名 + 首次部门补填；二次改部门需走管理员）
app.put('/api/auth/me', authenticate, async (req, res) => {
  try {
    const { name, department } = req.body || {};
    const db = getDatabase();
    const currentUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
    const isFirstTimeProfile = !currentUser?.name?.trim(); // 首次补填姓名

    await authService.updateOwnProfile(req.user.id, { name, department });

    // 首次补填姓名时，自动创建 "xxx 的项目组"
    let autoProject = null;
    if (isFirstTimeProfile && name && String(name).trim()) {
      const projectName = resolveProjectName(db, null, `${String(name).trim()} 的项目组`);
      try {
        autoProject = projectService.createProject({ name: projectName, description: '', settings: {}, user_id: req.user.id });
      } catch (e) {
        // 创建失败不阻塞 profile 更新
        console.error('[auto-project] 自动创建项目组失败:', e.message);
      }
    }

    // 重新拉一遍 getCurrentUser，把最新字段返回给前端
    const sessionId = req.headers['x-session-id'];
    const fresh = await authService.getCurrentUser(sessionId);
    res.json({ success: true, data: { user: fresh || req.user, autoProject } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/departments - 部门下拉数据源（模糊查询）
app.get('/api/departments', authenticate, async (req, res) => {
  try {
    const { listDepartments } = await import('./services/departmentService.js');
    const q = String(req.query.q || '');
    const items = listDepartments(q, 50);
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/profile - 管理员代填 / 修改任意用户的姓名 + 部门
app.put('/api/admin/users/:id/profile', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, department } = req.body || {};
    await authService.updateUserProfileByAdmin(Number(req.params.id), { name, department }, req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 管理员：部门字典 CRUD ─────────────────────────────────────────
// GET /api/admin/departments - 列表（带每部门用户数）
app.get('/api/admin/departments', authenticate, requireAdmin, async (req, res) => {
  try {
    const { listDepartmentsWithCount } = await import('./services/departmentService.js');
    res.json({ success: true, data: { items: listDepartmentsWithCount() } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/departments - 新建部门
app.post('/api/admin/departments', authenticate, requireAdmin, async (req, res) => {
  try {
    const { createDepartment } = await import('./services/departmentService.js');
    const row = createDepartment(req.body?.name);
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/departments/:id - 改名部门
app.put('/api/admin/departments/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { renameDepartment } = await import('./services/departmentService.js');
    const row = renameDepartment(Number(req.params.id), req.body?.name);
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/admin/departments/:id - 删除部门（受 FK ON DELETE SET NULL 保护：用户被解绑而非删除）
app.delete('/api/admin/departments/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { deleteDepartment } = await import('./services/departmentService.js');
    const out = deleteDepartment(Number(req.params.id));
    res.json({ success: true, data: out });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/departments/:id/members - 获取小组成员列表（消耗分析 autocomplete 用）
app.get('/api/admin/departments/:id/members', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    // 检查部门存在
    const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(id);
    if (!dept) return res.status(404).json({ error: '部门不存在' });
    const rows = db.prepare(
      'SELECT id, email, COALESCE(name, \'\') AS name FROM users WHERE department_id = ? AND status = \'active\' ORDER BY name, email'
    ).all(id);
    res.json({ success: true, data: { department: dept, members: rows } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/auth/password - 修改密码
app.put('/api/auth/password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '原密码和新密码不能为空' });
    }

    await authService.changePassword(req.user.id, oldPassword, newPassword);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/email-code - 发送邮箱验证码
app.post('/api/auth/email-code', async (req, res) => {
  try {
    const { email, purpose = 'register' } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 获取请求 IP
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    // 开发环境下返回验证码，生产环境应该发送邮件
    const result = await authService.generateAndSaveVerificationCode(email, purpose, ip);
    res.json(result); // 生产环境不返回 debugCode
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/email-status - 检查邮箱状态
app.post('/api/auth/email-status', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    const result = await authService.checkEmailStatus(email);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/auth/verify-email-code - 验证邮箱验证码
app.post('/api/auth/verify-email-code', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: '邮箱和验证码不能为空' });
    }

    const result = await authService.verifyEmailCode(email, code);
    if (result.valid) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/credits/deduct - 扣减积分（管理员）
app.post('/api/credits/deduct', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '积分数量无效' });
    }

    const result = await authService.deductCredits(userId || req.user.id, amount);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ── 普通管理员发分额度检查（按管理员单独限额） ────────────────────────
function checkAdminQuota(db, adminId, amount) {
  const quota = db.prepare('SELECT total_quota, daily_quota FROM admin_quotas WHERE admin_id = ?').get(adminId);
  const totalQuota = quota ? quota.total_quota : 0;
  const dailyQuota = quota ? quota.daily_quota : 0;

  if (totalQuota > 0) {
    // 已实际发放
    const totalUsed = db.prepare(`
      SELECT COALESCE(SUM(credits_amount), 0) AS total
      FROM credit_distribution_logs
      WHERE admin_id = ?
    `).get(adminId).total;

    // 已创建但未兑完的激活码理论剩余额度
    const pendingCodes = db.prepare(`
      SELECT COALESCE(SUM(credits_value * (max_uses - used_count)), 0) AS total
      FROM activation_codes
      WHERE created_by = ? AND credits_value > 0 AND used_count < max_uses
    `).get(adminId).total;

    const committed = totalUsed + pendingCodes + amount;
    if (committed > totalQuota) {
      return `超出您的发分总额度（总额度 ${totalQuota}，已发 ${totalUsed}，待兑激活码 ${pendingCodes}，本次 ${amount}，合计 ${committed}）`;
    }
  }

  if (dailyQuota > 0) {
    // 今日实际发放
    const todayUsed = db.prepare(`
      SELECT COALESCE(SUM(credits_amount), 0) AS total
      FROM credit_distribution_logs
      WHERE admin_id = ? AND date(created_at) = date('now', 'localtime')
    `).get(adminId).total;

    // 今日创建的激活码剩余可兑额度
    const todayCodes = db.prepare(`
      SELECT COALESCE(SUM(credits_value * (max_uses - used_count)), 0) AS total
      FROM activation_codes
      WHERE created_by = ? AND credits_value > 0 AND used_count < max_uses
        AND date(created_at) = date('now', 'localtime')
    `).get(adminId).total;

    const todayCommitted = todayUsed + todayCodes + amount;
    if (todayCommitted > dailyQuota) {
      return `超出您的每日发分额度（每日额度 ${dailyQuota}，今日已发 ${todayUsed}，今日待兑激活码 ${todayCodes}，本次 ${amount}，合计 ${todayCommitted}）`;
    }
  }

  return null; // 通过
}

// POST /api/credits/add - 充值积分（管理员）
app.post('/api/credits/add', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '积分数量无效' });
    }

    // 普通管理员额度检查
    if (req.user.role === 'admin') {
      const db = getDatabase();
      const err = checkAdminQuota(db, req.user.id, amount);
      if (err) return res.status(400).json({ error: err });
    }

    const targetUserId = userId || req.user.id;
    const result = await authService.rechargeCredits(targetUserId, amount, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/credits/checkin - 每日签到
app.post('/api/credits/checkin', authenticate, async (req, res) => {
  try {
    const result = await authService.checkIn(req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/credits/checkin/status - 获取签到状态
app.get('/api/credits/checkin/status', authenticate, async (req, res) => {
  try {
    const result = await authService.getCheckInStatus(req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 管理员 API
// ============================================================

// GET /api/admin/stats - 获取系统统计
app.get('/api/admin/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const stats = await authService.getSystemStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 管理员：积分消耗分析面板 ────────────────────────────────────────

// GET /api/admin/credits/daily-trend - 每日积分消耗趋势（读预聚合表，O(30行)）
app.get('/api/admin/credits/daily-trend', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));
    const data = db.prepare(`
      SELECT a.day,
             a.consumed,
             (SELECT COUNT(*) FROM analytics_daily_users u WHERE u.day = a.day) AS active_users,
             a.total_calls
      FROM analytics_daily a
      WHERE a.day >= date('now', ? || ' days')
      ORDER BY a.day ASC
    `).all(`-${days}`);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/today-ranking - 当日消耗排行
app.get('/api/admin/credits/today-ranking', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { departmentId } = req.query;
    let where = "date(ul.created_at) = date('now', 'localtime') AND ul.status = 'success'";
    const params = [];
    if (departmentId) { where += ' AND u.department_id = ?'; params.push(Number(departmentId)); }
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name,
             COALESCE((SELECT d.name FROM departments d WHERE d.id = u.department_id), '') AS department,
             SUM(ul.credits_cost) AS total_credits,
             COUNT(*) AS call_count
      FROM usage_logs ul
      JOIN users u ON u.id = ul.user_id
      WHERE ${where}
      GROUP BY u.id
      ORDER BY total_credits DESC
      LIMIT 50
    `).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/details - 消耗明细查询
app.get('/api/admin/credits/details', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const { name, email, date, action, model, departmentId } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (name) { where += ' AND u.name LIKE ?'; params.push(`%${name}%`); }
    if (email) { where += ' AND u.email LIKE ?'; params.push(`%${email}%`); }
    if (date) { where += " AND date(ul.created_at) = ?"; params.push(date); }
    if (action) { where += ' AND ul.action = ?'; params.push(action); }
    if (model) { where += ' AND ul.model LIKE ?'; params.push(`%${model}%`); }
    if (departmentId) { where += ' AND u.department_id = ?'; params.push(Number(departmentId)); }

    const batchFilter = `AND (
      t.concurrent_id IS NULL
      OR ul.id = (
        SELECT MIN(ul3.id) FROM usage_logs ul3
        JOIN tasks t3 ON t3.id = ul3.task_id
        WHERE t3.concurrent_id = t.concurrent_id
      )
    )`;

    const total = db.prepare(`
      SELECT COUNT(*) as count
      FROM usage_logs ul
      JOIN users u ON u.id = ul.user_id
      LEFT JOIN tasks t ON t.id = ul.task_id
      ${where} ${batchFilter}
    `).get(...params).count;

    const rows = db.prepare(`
      SELECT ul.id, ul.user_id, ul.task_id, ul.model, ul.action, ul.credits_cost, ul.status,
             ul.error_message, ul.created_at,
             u.email, u.name,
             COALESCE((SELECT d.name FROM departments d WHERE d.id = u.department_id), '') AS department,
             t.concurrent_id,
             CASE WHEN t.concurrent_id IS NOT NULL
               THEN (SELECT SUM(ul2.credits_cost) FROM usage_logs ul2
                     JOIN tasks t2 ON t2.id = ul2.task_id
                     WHERE t2.concurrent_id = t.concurrent_id AND ul2.status = 'success')
               ELSE NULL
             END AS batch_total_credits,
             CASE WHEN t.concurrent_id IS NOT NULL
               THEN (SELECT COUNT(*) FROM tasks t2 WHERE t2.concurrent_id = t.concurrent_id)
               ELSE NULL
             END AS batch_count,
             CASE WHEN t.concurrent_id IS NOT NULL
               THEN (SELECT ul2.credits_cost FROM usage_logs ul2
                     WHERE ul2.task_id = ul.task_id LIMIT 1)
               ELSE NULL
             END AS unit_credits
      FROM usage_logs ul
      JOIN users u ON u.id = ul.user_id
      LEFT JOIN tasks t ON t.id = ul.task_id
      ${where} ${batchFilter}
      ORDER BY ul.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({ success: true, data: { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/export - 导出消耗明细（全量，按日期范围筛选）
app.get('/api/admin/credits/export', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { dateFrom, dateTo, departmentId } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (dateFrom) { where += ' AND date(ul.created_at) >= ?'; params.push(dateFrom); }
    if (dateTo) { where += ' AND date(ul.created_at) <= ?'; params.push(dateTo); }
    if (departmentId) { where += ' AND u.department_id = ?'; params.push(Number(departmentId)); }

    const rows = db.prepare(`
      SELECT ul.id, ul.user_id, ul.task_id, ul.model, ul.action, ul.credits_cost, ul.status,
             ul.error_message, ul.created_at,
             u.email, u.name,
             COALESCE((SELECT d.name FROM departments d WHERE d.id = u.department_id), '') AS department
      FROM usage_logs ul
      JOIN users u ON u.id = ul.user_id
      ${where}
      ORDER BY ul.created_at DESC
    `).all(...params);

    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/group-summary - 按小组汇总消耗（支持下钻用户明细）
app.get('/api/admin/credits/group-summary', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { group, days, departmentId } = req.query;
    const ndays = Math.min(90, Math.max(1, parseInt(days) || 7));

    if (group) {
      // 下钻：指定小组的用户消耗明细
      const rows = db.prepare(`
        SELECT u.id, u.email, u.name,
               SUM(ul.credits_cost) AS total_credits,
               COUNT(*) AS call_count
        FROM usage_logs ul
        JOIN users u ON u.id = ul.user_id
        JOIN departments d ON d.id = u.department_id
        WHERE d.name = ? AND ul.created_at >= date('now', ? || ' days') AND ul.status = 'success'
        GROUP BY u.id
        ORDER BY total_credits DESC
        LIMIT 100
      `).all(group, `-${ndays}`);
      res.json({ success: true, data: rows, group });
    } else {
      // 第一级：按小组汇总（order by 暂停）
      let where = "ul.created_at >= date('now', ? || ' days') AND ul.status = 'success'";
      const gsParams = [`-${ndays}`];
      if (departmentId) { where += ' AND u.department_id = ?'; gsParams.push(Number(departmentId)); }
      const rows = db.prepare(`
        SELECT COALESCE(d.name, '未设置') AS department,
               COUNT(DISTINCT u.id) AS user_count,
               SUM(ul.credits_cost) AS total_credits,
               COUNT(*) AS call_count
        FROM usage_logs ul
        JOIN users u ON u.id = ul.user_id
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE ${where}
        GROUP BY d.name
        ORDER BY total_credits DESC
      `).all(...gsParams);
      res.json({ success: true, data: rows });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/project-consumption - 项目组资源消耗排行
app.get('/api/admin/credits/project-consumption', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));
    const { departmentId } = req.query;
    let extra = '';
    const params = [`-${days}`];
    if (departmentId) { extra = ' AND u.department_id = ?'; params.push(Number(departmentId)); }
    const rows = db.prepare(`
      SELECT COALESCE(p.id, 0) AS id,
             COALESCE(p.name, '无项目') AS name,
             COUNT(DISTINCT cl.user_id) AS user_count,
             SUM(cl.actual_credits) AS total_credits,
             COUNT(*) AS task_count
      FROM credit_locks cl
      LEFT JOIN tasks t ON t.id = cl.task_id
      LEFT JOIN tasks_happyhorse th ON th.id = cl.task_happyhorse_id
      LEFT JOIN image_records ir ON ir.id = cl.image_record_id
      LEFT JOIN video_enhancements ve ON ve.id = cl.enhancement_id
      LEFT JOIN projects p ON p.id = COALESCE(t.project_id, th.project_id, ir.project_id, ve.project_id)
      JOIN users u ON u.id = cl.user_id
      WHERE cl.status = 'settled'
        AND cl.settled_at >= date('now', ? || ' days')${extra}
      GROUP BY p.id
      ORDER BY total_credits DESC
      LIMIT 30
    `).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/export-group-summary - 导出用小组汇总（按日期范围）
app.get('/api/admin/credits/export-group-summary', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { dateFrom, dateTo, departmentId } = req.query;

    let where = "ul.status = 'success'";
    const params = [];
    if (dateFrom) { where += ' AND date(ul.created_at) >= ?'; params.push(dateFrom); }
    if (dateTo) { where += ' AND date(ul.created_at) <= ?'; params.push(dateTo); }
    if (departmentId) { where += ' AND u.department_id = ?'; params.push(Number(departmentId)); }

    const rows = db.prepare(`
      SELECT COALESCE(d.name, '未设置') AS department,
             COUNT(DISTINCT u.id) AS user_count,
             SUM(ul.credits_cost) AS total_credits,
             COUNT(*) AS call_count
      FROM usage_logs ul
      JOIN users u ON u.id = ul.user_id
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE ${where}
      GROUP BY d.name
      ORDER BY total_credits DESC
    `).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/export-project-consumption - 导出用项目组消耗（按日期范围）
app.get('/api/admin/credits/export-project-consumption', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { dateFrom, dateTo, departmentId } = req.query;

    let where = "cl.status = 'settled'";
    const params = [];
    if (dateFrom) { where += ' AND date(cl.settled_at) >= ?'; params.push(dateFrom); }
    if (dateTo) { where += ' AND date(cl.settled_at) <= ?'; params.push(dateTo); }
    if (departmentId) { where += ' AND u.department_id = ?'; params.push(Number(departmentId)); }

    const rows = db.prepare(`
      SELECT COALESCE(p.id, 0) AS id,
             COALESCE(p.name, '无项目') AS name,
             COUNT(DISTINCT cl.user_id) AS user_count,
             SUM(cl.actual_credits) AS total_credits,
             COUNT(*) AS task_count
      FROM credit_locks cl
      JOIN users u ON u.id = cl.user_id
      LEFT JOIN tasks t ON t.id = cl.task_id
      LEFT JOIN tasks_happyhorse th ON th.id = cl.task_happyhorse_id
      LEFT JOIN image_records ir ON ir.id = cl.image_record_id
      LEFT JOIN video_enhancements ve ON ve.id = cl.enhancement_id
      LEFT JOIN projects p ON p.id = COALESCE(t.project_id, th.project_id, ir.project_id, ve.project_id)
      WHERE ${where}
      GROUP BY p.id
      ORDER BY total_credits DESC
    `).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credits/failure-analysis - 失败分析（从源表直接查询）
app.get('/api/admin/credits/failure-analysis', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const days = parseInt(req.query.days) || 7;
    const { departmentId } = req.query;
    const params = [];
    const daysVal = days > 0 ? `-${Math.min(90, days)}` : null;
    const dateClause = daysVal ? ` AND created_at >= date('now', '${daysVal}' || ' days')` : '';
    const audioDateClause = daysVal ? ` AND t2.created_at >= date('now', '${daysVal}' || ' days')` : '';
    // 部门过滤：在外部 WHERE 中统一处理
    let deptJoin = '';
    let deptWhere = '';
    if (departmentId) {
      deptJoin = 'JOIN users u ON u.id = base.user_id';
      deptWhere = 'AND u.department_id = ?';
      params.push(Number(departmentId));
    }

    const sql = `
      SELECT base.action, COALESCE(base.error_message, '未知错误') AS error_message,
             SUM(base.fail_count) AS fail_count,
             SUM(base.wasted_credits) AS wasted_credits
      FROM (
        -- 1. 图片生成：image_records
        SELECT '图片生成' AS action, ir.error_message,
               1 AS fail_count,
               COALESCE((SELECT SUM(cl.locked_credits) FROM credit_locks cl WHERE cl.image_record_id = ir.id AND cl.status = 'released'), 0) AS wasted_credits,
               ir.user_id
        FROM image_records ir
        WHERE ir.status = 'error'${dateClause}

        UNION ALL

        -- 2. 视频生成：tasks (task_kind='video')
        SELECT '视频生成' AS action, t.error_message,
               1 AS fail_count,
               COALESCE((SELECT SUM(cl.locked_credits) FROM credit_locks cl WHERE cl.task_id = t.id AND cl.status = 'released'), 0) AS wasted_credits,
               t.user_id
        FROM tasks t
        WHERE t.status = 'error' AND t.task_kind = 'video'${dateClause}

        UNION ALL

        -- 3. 音频生成：audio_generations 关联 tasks (task_kind='audio_intermediate')
        SELECT '音频生成' AS action, t2.error_message,
               1 AS fail_count,
               COALESCE((SELECT SUM(cl.locked_credits) FROM credit_locks cl WHERE cl.task_id = t2.id AND cl.status = 'released'), 0) AS wasted_credits,
               t2.user_id
        FROM audio_generations ag
        JOIN tasks t2 ON t2.id = ag.task_id
        WHERE t2.status = 'error' AND t2.task_kind = 'audio_intermediate'${audioDateClause}

        UNION ALL

        -- 4. 视频生成：tasks_happyhorse
        SELECT '视频生成' AS action, th.error_message,
               1 AS fail_count,
               COALESCE((SELECT SUM(cl.locked_credits) FROM credit_locks cl WHERE cl.task_happyhorse_id = th.id AND cl.status = 'released'), 0) AS wasted_credits,
               th.user_id
        FROM tasks_happyhorse th
        WHERE th.status = 'error'${dateClause}

        UNION ALL

        -- 5. 视频增强：video_enhancements
        SELECT '视频增强' AS action, ve.error_message,
               1 AS fail_count,
               COALESCE((SELECT SUM(cl.locked_credits) FROM credit_locks cl WHERE cl.enhancement_id = ve.id AND cl.status = 'released'), 0) AS wasted_credits,
               ve.user_id
        FROM video_enhancements ve
        WHERE ve.status = 'error'${dateClause}
      ) AS base
      ${deptJoin}
      WHERE 1=1 ${deptWhere}
      GROUP BY base.action, base.error_message
      ORDER BY fail_count DESC
      LIMIT 30
    `;
    const rows = db.prepare(sql).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 管理员：积分发放统计 ────────────────────────────────────────

// GET /api/admin/credit-distributions - 积分发放记录列表
app.get('/api/admin/credit-distributions', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    const adminId = parseInt(req.query.adminId) || 0;
    const method = req.query.method || '';

    const conditions = [];
    const params = [];

    if (startDate) {
      conditions.push("l.created_at >= ?");
      params.push(startDate);
    }
    if (endDate) {
      conditions.push("l.created_at <= ?");
      params.push(endDate + ' 23:59:59');
    }
    if (adminId > 0) {
      conditions.push("l.admin_id = ?");
      params.push(adminId);
    }
    if (method) {
      conditions.push("l.method = ?");
      params.push(method);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total FROM credit_distribution_logs l ${whereClause}
    `).get(...params);

    const rows = db.prepare(`
      SELECT l.*,
             COALESCE(a.email, '系统') AS admin_email,
             COALESCE(a.name, '') AS admin_name,
             u.email AS recipient_email,
             COALESCE(u.name, '') AS recipient_name,
             COALESCE(d.name, '') AS recipient_department
      FROM credit_distribution_logs l
      LEFT JOIN users a ON a.id = l.admin_id
      JOIN users u ON u.id = l.recipient_id
      LEFT JOIN departments d ON d.id = u.department_id
      ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
      success: true,
      data: {
        rows,
        pagination: {
          page,
          pageSize,
          total: countRow.total,
          totalPages: Math.ceil(countRow.total / pageSize),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/credit-distributions/summary - 按管理员汇总
app.get('/api/admin/credit-distributions/summary', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';

    const conditions = [];
    const params = [];

    if (startDate) {
      conditions.push("l.created_at >= ?");
      params.push(startDate);
    }
    if (endDate) {
      conditions.push("l.created_at <= ?");
      params.push(endDate + ' 23:59:59');
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // 汇总只统计有管理员的记录（排除签到的 NULL admin_id）
    const summaryConditions = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ') + ' AND l.admin_id IS NOT NULL'
      : 'WHERE l.admin_id IS NOT NULL';

    const rows = db.prepare(`
      SELECT l.admin_id,
             a.email AS admin_email,
             COALESCE(a.name, '') AS admin_name,
             SUM(l.credits_amount) AS total_credits,
             COUNT(*) AS distribution_count
      FROM credit_distribution_logs l
      JOIN users a ON a.id = l.admin_id
      ${summaryConditions}
      GROUP BY l.admin_id
      ORDER BY total_credits DESC
    `).all(...params);

    // 总计
    const totalRow = db.prepare(`
      SELECT COALESCE(SUM(credits_amount), 0) AS total_credits,
             COUNT(*) AS total_count
      FROM credit_distribution_logs l ${whereClause}
    `).get(...params);

    res.json({
      success: true,
      data: {
        admins: rows,
        totalCredits: totalRow.total_credits,
        totalCount: totalRow.total_count,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 管理员：积分发放额度管理（按管理员单独设置） ─────────────────────

// GET /api/admin/admin-quotas - 获取所有管理员的额度与使用情况（super_admin）
app.get('/api/admin/admin-quotas', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const db = getDatabase();

    // 所有 role=admin 的用户（不含 super_admin）
    const admins = db.prepare(`
      SELECT u.id, u.email, COALESCE(u.name, '') AS name,
             COALESCE(d.name, '') AS department
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.role = 'admin'
      ORDER BY u.id
    `).all();

    const rows = admins.map((a) => {
      const quota = db.prepare('SELECT total_quota, daily_quota FROM admin_quotas WHERE admin_id = ?').get(a.id);
      // 累计每日额度已兑出
      const totalDailyUsed = db.prepare(`
        SELECT COALESCE(SUM(ac.credits_value * ac.used_count), 0) AS total FROM activation_codes ac
        WHERE ac.created_by = ? AND ac.is_credit_daily = 1
      `).get(a.id).total;
      // 累计自费已兑出
      const totalSelfDistributed = db.prepare(`
        SELECT COALESCE(SUM(ac.credits_value * ac.used_count), 0) AS total FROM activation_codes ac
        WHERE ac.created_by = ? AND ac.is_credit_daily = 0
      `).get(a.id).total;
      // 今日每日额度兑出量
      const todayDailyUsed = db.prepare(`
        SELECT COALESCE(SUM(ac.credits_value * ac.used_count), 0) AS total FROM activation_codes ac
        WHERE ac.created_by = ? AND ac.is_credit_daily = 1 AND date(ac.updated_at) = date('now', 'localtime')
      `).get(a.id).total;
      // 今日自费兑出量
      const todaySelfDistributed = db.prepare(`
        SELECT COALESCE(SUM(ac.credits_value * ac.used_count), 0) AS total FROM activation_codes ac
        WHERE ac.created_by = ? AND ac.is_credit_daily = 0 AND date(ac.updated_at) = date('now', 'localtime')
      `).get(a.id).total;

      return {
        adminId: a.id,
        adminEmail: a.email,
        adminName: a.name,
        adminDepartment: a.department,
        totalQuota: quota ? quota.total_quota : 0,
        dailyQuota: quota ? quota.daily_quota : 0,
        totalUsed: totalDailyUsed + totalSelfDistributed,
        todayDailyUsed,
        todaySelfPaying: todaySelfDistributed,
        todaySelfRefund: 0,
      };
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/admin-quotas/:adminId - 设置某管理员的额度（super_admin）
app.put('/api/admin/admin-quotas/:adminId', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const adminId = parseInt(req.params.adminId);
    const { totalQuota, dailyQuota } = req.body;

    // 确认目标用户存在且为 admin
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(adminId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.role !== 'admin') return res.status(400).json({ error: '只能为普通管理员设置额度' });

    const tq = totalQuota !== undefined ? Math.max(0, parseInt(totalQuota) || 0) : undefined;
    const dq = dailyQuota !== undefined ? Math.max(0, parseInt(dailyQuota) || 0) : undefined;

    if (tq !== undefined || dq !== undefined) {
      db.prepare(`
        INSERT INTO admin_quotas (admin_id, total_quota, daily_quota, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(admin_id) DO UPDATE SET
          total_quota = COALESCE(?, total_quota),
          daily_quota = COALESCE(?, daily_quota),
          updated_at = CURRENT_TIMESTAMP
      `).run(adminId, tq ?? 0, dq ?? 0, tq, dq);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users/activity - 用户活跃度（读预聚合表 + 优化休眠查询）
app.get('/api/admin/users/activity', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const days = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));

    // 每日活跃用户数（读预聚合表）
    const dailyActive = db.prepare(`
      SELECT day, COUNT(*) AS active_users
      FROM analytics_daily_users
      WHERE day >= date('now', ? || ' days')
      GROUP BY day
      ORDER BY day ASC
    `).all(`-${days}`);

    // 休眠用户：单次 LEFT JOIN 替代每行子查询
    const dormant = db.prepare(`
      SELECT u.id, u.email, u.name,
             COALESCE(d.name, '') AS department,
             COALESCE(last_active, u.created_at) AS last_active,
             u.created_at
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS last_active
        FROM usage_logs
        GROUP BY user_id
      ) ul ON ul.user_id = u.id
      WHERE u.status = 'active'
        AND (ul.last_active IS NULL OR ul.last_active < date('now', ? || ' days'))
      ORDER BY last_active ASC
      LIMIT 100
    `).all(`-${days}`);

    res.json({ success: true, data: { dailyActive, dormant } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/projects - 管理员查看全量项目列表（支持筛选）
app.get('/api/admin/projects', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const { email, name } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (email) { where += ' AND u.email LIKE ?'; params.push(`%${email}%`); }
    if (name)  { where += ' AND p.name LIKE ?';  params.push(`%${name}%`); }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      ${where}
    `).get(...params).count;

    const projects = db.prepare(`
      SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
             u.email AS owner_email,
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL) AS task_count,
             (SELECT COUNT(*) FROM project_assets pa WHERE pa.project_id = p.id AND pa.status != 'deleted') AS asset_count
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({ success: true, data: { projects, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/projects/:id - 管理员删除项目（资产库有内容则保留资产，转移给管理员）
app.delete('/api/admin/projects/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const assetCount = db.prepare(
      "SELECT COUNT(*) as count FROM project_assets WHERE project_id = ? AND status != 'deleted'"
    ).get(req.params.id).count;

    if (assetCount > 0) {
      // 资产库保留 → 将项目转移给管理员
      db.prepare('UPDATE projects SET user_id = ?, name = ? WHERE id = ?')
        .run(req.user.id, `[已转移] ${project.name}`, req.params.id);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(req.params.id);
      db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(req.params.id, req.user.id, 'owner');
      return res.json({ success: true, preserved: true, message: `项目含 ${assetCount} 个资产，已转移给管理员账号` });
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ success: true, preserved: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users - 获取用户列表
app.get('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, role, status, email } = req.query;
    const result = await authService.getUserList(
      parseInt(page),
      parseInt(pageSize),
      { role, status, email },
      req.user
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users/export - 导出全量用户（所有字段，无分页，仅系统管理员）
app.get('/api/admin/users/export', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.credits, u.unlimited_credits,
             u.daily_check_in, u.last_check_in_at, u.department_id, u.created_at, u.updated_at,
             u.password_hash, d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      ORDER BY u.created_at DESC
    `).all();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users/:id - 获取用户详情
app.get('/api/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await authService.getUserDetail(userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/status - 更新用户状态
app.put('/api/admin/users/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { status } = req.body;

    await authService.updateUserStatus(userId, status, req.user);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/credits - 修改用户积分
app.put('/api/admin/users/:id/credits', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { credits, operation = 'set' } = req.body;

    // 普通管理员额度检查
    if (req.user.role === 'admin') {
      const db = getDatabase();
      const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      let increase = 0;
      if (operation === 'add') {
        increase = credits;
      } else if (operation === 'set' && credits > user.credits) {
        increase = credits - user.credits;
      }

      if (increase > 0) {
        const err = checkAdminQuota(db, req.user.id, increase);
        if (err) return res.status(400).json({ error: err });
      }
    }

    await authService.updateUserCredits(userId, credits, operation, req.user.id);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/password - 重置用户密码
app.put('/api/admin/users/:id/password', authenticate, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { newPassword } = req.body;

    await authService.resetUserPassword(userId, newPassword);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/activation-codes - 获取激活码列表
app.get('/api/admin/activation-codes', authenticate, (req, res) => {
  try {
    const codes = jimengSessionService.listActivationCodes();
    res.json({ success: true, data: codes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/activation-codes - 创建激活码
// 每日额度逻辑：superAdmin 不受限；普通 admin 先走每日免费额度，超出的由管理员个人积分承担
app.post('/api/admin/activation-codes', authenticate, (req, res) => {
  try {
    const { creditsValue, maxUses } = req.body;
    const cv = parseInt(creditsValue) || 0;
    const mu = parseInt(maxUses) || 1;
    const db = getDatabase();

    if (req.user.role === 'admin' && cv > 0) {
      const totalNeed = cv * mu;
      const quota = db.prepare('SELECT total_quota, daily_quota FROM admin_quotas WHERE admin_id = ?').get(req.user.id);
      const dailyQuota = quota ? quota.daily_quota : 0;
      const adminCredits = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id)?.credits || 0;

      const usedDaily = db.prepare(`
        SELECT COALESCE(SUM(ac.credits_value * ac.used_count), 0) AS total FROM activation_codes ac
        WHERE ac.created_by = ? AND ac.is_credit_daily = 1 AND date(ac.updated_at) = date('now', 'localtime')
      `).get(req.user.id).total;
      const pendingDaily = db.prepare(`
        SELECT COALESCE(SUM(credits_value * (max_uses - used_count)), 0) AS total FROM activation_codes
        WHERE created_by = ? AND is_credit_daily = 1 AND credits_value > 0 AND used_count < max_uses
          AND date(created_at) = date('now', 'localtime')
          AND (time_of_expiration IS NULL OR datetime(time_of_expiration) > datetime('now', 'localtime'))
      `).get(req.user.id).total;
      const remainingDaily = dailyQuota > 0 ? dailyQuota - usedDaily - pendingDaily : 0;

      if (dailyQuota > 0 && totalNeed <= remainingDaily) {
        req.body.is_credit_daily = 1;
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const pad2 = (n) => String(n).padStart(2, '0');
        req.body.time_of_expiration = `${endOfDay.getFullYear()}-${pad2(endOfDay.getMonth() + 1)}-${pad2(endOfDay.getDate())} ${pad2(endOfDay.getHours())}:${pad2(endOfDay.getMinutes())}:${pad2(endOfDay.getSeconds())}`;
      } else {
        if (adminCredits < totalNeed) {
          return res.status(400).json({
            error: `目前你期望发放 ${totalNeed}，今日预计发放 ${dailyQuota}，其中已发 ${usedDaily}（${usedDaily} 积分被领取），剩余可发 ${Math.max(0, remainingDaily)}，你的账户余额不足（${adminCredits}），无法进行发放。`
          });
        }
        if (!req.body.confirm) {
          return res.json({
            success: true,
            data: {
              needConfirm: true,
              totalNeed,
              dailyQuota,
              usedDaily,
              adminCredits,
              warning: `目前你期望发放 ${totalNeed}，今日预计发放 ${dailyQuota}，其中已发 ${usedDaily}（${usedDaily} 积分被领取），剩余可发 ${Math.max(0, remainingDaily)}，剩余积分不足，如果继续将从你的账户余额里扣除 ${totalNeed}，是否继续？`
            }
          });
        }
        db.prepare(`UPDATE users SET credits = MAX(0, credits - ?) WHERE id = ?`).run(totalNeed, req.user.id);
        db.prepare(`INSERT INTO credit_distribution_logs (admin_id, recipient_id, credits_amount, method, note) VALUES (?, ?, ?, 'self_paying', ?)`)
          .run(req.user.id, req.user.id, -totalNeed, '管理员自费发分');
        req.body.is_credit_daily = 0;
        req.body.time_of_expiration = null;
      }
    }

    const { confirm: _confirm, ...cleanBody } = req.body;
    const code = jimengSessionService.createActivationCode({ ...cleanBody, createdBy: req.user.id });
    res.json({ success: true, data: code });
  } catch (error) {
    const msg = error.message?.includes('UNIQUE constraint failed')
      ? '激活码已存在，请换一个不同的激活码'
      : error.message;
    res.status(400).json({ error: msg });
  }
});

// PUT /api/admin/activation-codes/:id - 修改激活码
app.put('/api/admin/activation-codes/:id', authenticate, (req, res) => {
  try {
    const code = jimengSessionService.updateActivationCode(Number(req.params.id), req.body);
    res.json({ success: true, data: code });
  } catch (error) {
    const msg = error.message?.includes('UNIQUE constraint failed')
      ? '激活码已存在，请换一个不同的激活码'
      : error.message;
    res.status(400).json({ error: msg });
  }
});

// DELETE /api/admin/activation-codes/:id - 删除激活码
app.delete('/api/admin/activation-codes/:id', authenticate, (req, res) => {
  try {
    jimengSessionService.deleteActivationCode(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/admin/consumption-analysis - 积分消耗分析（credit_locks 为主，关联各业务表）
app.get('/api/admin/consumption-analysis', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { page = 1, pageSize = 20, user, department, project, action, status } = req.query;
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = (parseInt(page) - 1) * limit;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAdmin = req.user.role === 'admin';

    const isUser = !isSuperAdmin && !isAdmin;

    const conditions = [];
    const params = [];

    // ── 错锁/死锁自动检测与修复 ──
    const fixLog = [];
    const lockedRows = db.prepare(`
      SELECT cl.* FROM credit_locks cl
      LEFT JOIN users u ON cl.user_id = u.id
      WHERE cl.status = 'locked'
      ${isUser ? 'AND cl.user_id = ?' : ''}
      ${isAdmin ? 'AND u.department_id = ?' : ''}
    `).all(...(isUser ? [req.user.id] : isAdmin ? [req.user.department_id || -1] : []));

    for (const lock of lockedRows) {
      let found = false;
      let taskDone = false;
      if (lock.task_id) {
        const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(lock.task_id);
        if (t) { found = true; if (t.status === 'done' || t.status === 'error') taskDone = true; }
      }
      if (!found && lock.image_record_id) {
        const ir = db.prepare('SELECT status FROM image_records WHERE id = ?').get(lock.image_record_id);
        if (ir) { found = true; if (ir.status === 'done' || ir.status === 'error') taskDone = true; }
      }
      if (!found && lock.enhancement_id) {
        const ve = db.prepare('SELECT status FROM video_enhancements WHERE id = ?').get(lock.enhancement_id);
        if (ve) { found = true; if (ve.status === 'done' || ve.status === 'error') taskDone = true; }
      }
      if (!found && lock.task_happyhorse_id) {
        const th = db.prepare('SELECT status FROM tasks_happyhorse WHERE id = ?').get(lock.task_happyhorse_id);
        if (th) { found = true; if (th.status === 'done' || th.status === 'error') taskDone = true; }
      }

      const fixType = (found && taskDone) ? 'wrong' : (!found ? 'dead' : null);
      if (fixType) {
        try {
          if (lock.task_id) creditLockService.release({ taskId: lock.task_id, reason: fixType === 'wrong' ? '错锁已解锁' : '死锁已解锁' });
          else if (lock.image_record_id) creditLockService.releaseForImage({ imageRecordId: lock.image_record_id, reason: fixType === 'wrong' ? '错锁已解锁' : '死锁已解锁' });
          else if (lock.enhancement_id) creditLockService.releaseForEnhancement({ enhancementId: lock.enhancement_id, reason: fixType === 'wrong' ? '错锁已解锁' : '死锁已解锁' });
          else if (lock.task_happyhorse_id) creditLockService.releaseForHappyhorse({ happyhorseTaskId: lock.task_happyhorse_id, reason: fixType === 'wrong' ? '错锁已解锁' : '死锁已解锁' });
          // 归还积分到用户账户
          const u2 = db.prepare('SELECT unlimited_credits FROM users WHERE id = ?').get(lock.user_id);
          if (u2 && !u2.unlimited_credits) {
            db.prepare('UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lock.locked_credits, lock.user_id);
          }
          fixLog.push({ id: lock.id, type: fixType, returnedCredits: lock.locked_credits });
        } catch (e) {
          console.warn(`[consumption] 自动释放锁 ${lock.id} 失败:`, e.message);
        }
      }
    }

    // 角色权限过滤
    if (isUser) {
      conditions.push('cl.user_id = ?');
      params.push(req.user.id);
    } else if (isAdmin) {
      conditions.push('u.department_id = ?');
      params.push(req.user.department_id || -1);
    }

    if (user) {
      conditions.push('(u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${user}%`, `%${user}%`);
    }
    if (department) {
      conditions.push('d.name LIKE ?');
      params.push(`%${department}%`);
    }
    if (project) {
      conditions.push('p.name LIKE ?');
      params.push(`%${project}%`);
    }
    if (action) {
      switch (action) {
        case 'image': conditions.push('cl.image_record_id IS NOT NULL'); break;
        case 'audio': conditions.push("cl.task_id IS NOT NULL AND t_video.task_kind = 'audio_intermediate'"); break;
        case 'video': conditions.push("((cl.task_id IS NOT NULL AND (t_video.task_kind IS NULL OR t_video.task_kind = 'video')) OR cl.task_happyhorse_id IS NOT NULL)"); break;
        case 'enhancement': conditions.push('cl.enhancement_id IS NOT NULL'); break;
      }
    }
    if (status) {
      conditions.push('cl.status = ?');
      params.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) AS c FROM credit_locks cl
      LEFT JOIN users u ON cl.user_id = u.id
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN image_records ir ON cl.image_record_id = ir.id
      LEFT JOIN tasks t_video ON cl.task_id = t_video.id
      LEFT JOIN tasks_happyhorse th ON cl.task_happyhorse_id = th.id
      LEFT JOIN video_enhancements ve ON cl.enhancement_id = ve.id
      LEFT JOIN projects p ON p.id = COALESCE(ir.project_id, t_video.project_id, th.project_id, ve.project_id)
      ${where}`;
    const { c: total } = db.prepare(countSql).get(...params);

    const dataSql = `SELECT
        cl.id, cl.user_id, cl.status AS lock_status, cl.locked_credits, cl.actual_credits,
        cl.meta, cl.created_at AS cl_created_at,
        u.name AS user_name, u.email AS user_email, d.name AS department_name,
        COALESCE(ir.created_at, t_video.created_at, th.created_at, ve.created_at, cl.created_at) AS action_time,
        p.id AS project_id, p.name AS project_name,
        CASE
          WHEN cl.image_record_id IS NOT NULL THEN 'image'
          WHEN cl.enhancement_id IS NOT NULL THEN 'enhancement'
          WHEN cl.task_happyhorse_id IS NOT NULL THEN 'video'
          WHEN cl.task_id IS NOT NULL AND t_video.task_kind = 'audio_intermediate' THEN 'audio'
          WHEN cl.task_id IS NOT NULL THEN 'video'
          ELSE 'unknown'
        END AS action_type,
        CASE
          WHEN cl.enhancement_id IS NOT NULL THEN COALESCE(ve.tool_version, json_extract(cl.meta, '$.tool_version'))
          WHEN cl.task_happyhorse_id IS NOT NULL THEN th.model
          WHEN cl.image_record_id IS NOT NULL THEN ir.model
          WHEN cl.task_id IS NOT NULL THEN t_video.model
          ELSE json_extract(cl.meta, '$.model')
        END AS model_name
      FROM credit_locks cl
      LEFT JOIN users u ON cl.user_id = u.id
      LEFT JOIN departments d ON u.department_id = d.id
      LEFT JOIN image_records ir ON cl.image_record_id = ir.id
      LEFT JOIN tasks t_video ON cl.task_id = t_video.id
      LEFT JOIN tasks_happyhorse th ON cl.task_happyhorse_id = th.id
      LEFT JOIN video_enhancements ve ON cl.enhancement_id = ve.id
      LEFT JOIN projects p ON p.id = COALESCE(ir.project_id, t_video.project_id, th.project_id, ve.project_id)
      ${where}
      ORDER BY action_time DESC LIMIT ? OFFSET ?`;

    const rows = db.prepare(dataSql).all(...params, limit, offset);

    const ACTION_LABELS = { image: '图片生成', audio: '音频生成', video: '视频生成', enhancement: '视频增强', unknown: '未知' };

    const data = rows.map(r => ({
      id: r.id, time: r.action_time,
      userName: r.user_name || '', userEmail: r.user_email || '',
      department: r.department_name || '', project: r.project_name || '',
      action: r.action_type, actionLabel: ACTION_LABELS[r.action_type] || r.action_type,
      model: r.model_name || '', status: r.lock_status,
      lockedCredits: r.locked_credits, actualCredits: r.actual_credits,
    }));

    res.json({ success: true, data: { rows: data, total, fixLog, page: parseInt(page), pageSize: limit } });
  } catch (e) {
    console.error('[consumption-analysis]', e.message);
    res.status(500).json({ error: e.message });
  }
});
// GET /api/admin/system-config
app.get('/api/admin/system-config', authenticate, (req, res) => {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'registration_enabled'").get();
  const mRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_mode'").get();
  const msgRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_message'").get();
  const infoRow = db.prepare("SELECT value FROM system_config WHERE key = 'information_of_account_of_volc'").get();
  res.json({
    success: true,
    data: {
      registrationEnabled: row ? row.value !== '0' : true,
      maintenanceMode: mRow?.value === '1',
      maintenanceMessage: msgRow?.value || '系统维护中，请稍后再试。',
      informationOfAccountOfVolc: infoRow?.value === '1',
    },
  });
});

// PUT /api/admin/system-config
app.put('/api/admin/system-config', authenticate, (req, res) => {
  const db = getDatabase();
  const { registrationEnabled, maintenanceMode, maintenanceMessage, informationOfAccountOfVolc } = req.body;
  if (registrationEnabled !== undefined) {
    const val = registrationEnabled ? '1' : '0';
    db.prepare("INSERT INTO system_config (key, value, description) VALUES ('registration_enabled', ?, '是否允许用户注册') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
  }
  if (maintenanceMode !== undefined) {
    const val = maintenanceMode ? '1' : '0';
    db.prepare("INSERT INTO system_config (key, value, description) VALUES ('maintenance_mode', ?, '维护模式') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
  }
  if (maintenanceMessage !== undefined) {
    db.prepare("INSERT INTO system_config (key, value, description) VALUES ('maintenance_message', ?, '维护公告内容') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(maintenanceMessage);
  }
  if (informationOfAccountOfVolc !== undefined) {
    const val = informationOfAccountOfVolc ? '1' : '0';
    db.prepare("INSERT INTO system_config (key, value, description) VALUES ('information_of_account_of_volc', ?, '项目组与资产管理页显示当前API账户') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
  }
  res.json({ success: true });
});

// GET /api/system-config/information_of_account_of_volc - 公开读取开关状态
app.get('/api/system-config/information_of_account_of_volc', (req, res) => {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'information_of_account_of_volc'").get();
  res.json({ success: true, enabled: row?.value === '1' });
});


// GET /api/admin/works - 获取作品列表（预留）
app.get('/api/admin/works', authenticate, requireAdmin, async (req, res) => {
  try {
    // 预留作品管理功能
    res.json({ success: true, data: { works: [], pagination: { total: 0 } } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/works/:id/featured - 切换作品推荐状态（预留）
app.put('/api/admin/works/:id/featured', authenticate, requireAdmin, async (req, res) => {
  try {
    // 预留作品推荐功能
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 系统配置接口（SMTP 等）
// ============================================================

// GET /api/admin/config - 获取系统配置（SMTP 等批量配置；预留 admin SMTP 设置 UI 接入）
app.get('/api/admin/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const configs = db.prepare('SELECT key, value, description FROM system_config').all();
    const configObj = {};
    for (const c of configs) {
      configObj[c.key] = { value: c.value, description: c.description };
    }
    res.json({ success: true, data: configObj });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/config - 保存系统配置（预留 admin SMTP 设置 UI 接入）
app.post('/api/admin/config', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { configs } = req.body; // { smtp_host: 'value', smtp_port: 'value', ... }

    if (!configs || typeof configs !== 'object') {
      return res.status(400).json({ error: '配置数据格式错误' });
    }

    const smtpConfigKeys = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_from_name', 'smtp_tls_reject_unauthorized'];
    const descriptions = {
      smtp_host: 'SMTP 服务器地址',
      smtp_port: 'SMTP 端口号',
      smtp_secure: '是否启用 SSL（true/false）',
      smtp_user: 'SMTP 用户名',
      smtp_pass: 'SMTP 密码/授权码',
      smtp_from: '发件人邮箱',
      smtp_from_name: '发件人名称',
      smtp_tls_reject_unauthorized: 'TLS 证书校验（true/false）'
    };

    for (const [key, value] of Object.entries(configs)) {
      if (smtpConfigKeys.includes(key)) {
        const description = descriptions[key] || '';
        db.prepare(`
          INSERT INTO system_config (key, value, description)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?, description = ?, updated_at = datetime('now')
        `).run(key, String(value), description, String(value), description);
      }
    }

    // 清除邮件传输器缓存，以便重新加载配置
    const { resetMailTransporterCache } = await import('./services/authService.js');
    if (resetMailTransporterCache) resetMailTransporterCache();

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mode: 'direct-jimeng-api' });
});

// ============================================================
// 使用量统计 API
// ============================================================

// GET /api/usage/stats - 当前用户使用量统计（预留：UI 个人中心未来接入）
app.get('/api/usage/stats', authenticate, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const stats = usageService.getUserUsageStats(req.user.id, days);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[usage] 获取统计失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/usage/stats - 管理员全量使用量统计（预留：AdminPage 仪表盘未来接入）
app.get('/api/admin/usage/stats', authenticate, (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const stats = usageService.getSystemUsageStats(days);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('[usage] 获取系统统计失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 用户 unlimited_credits 管理
// ============================================================

// PUT /api/admin/users/:id/unlimited - 切换无限积分
app.put('/api/admin/users/:id/unlimited', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { unlimited } = req.body;
    db.prepare('UPDATE users SET unlimited_credits = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(unlimited ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[admin] 更新 unlimited_credits 失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 用户功能权限管理（管理员）
// ============================================================

// GET /api/admin/permissions/features - 已定义的功能键清单
app.get('/api/admin/permissions/features', authenticate, (req, res) => {
  res.json({ success: true, data: permissionService.FEATURE_KEYS });
});

// GET /api/admin/permissions/defaults - 系统默认权限
app.get('/api/admin/permissions/defaults', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: permissionService.getDefaultPermissions() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/permissions/defaults - 更新系统默认权限
app.put('/api/admin/permissions/defaults', authenticate, (req, res) => {
  try {
    const { permissions } = req.body || {};
    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'permissions 必须是对象' });
    }
    const merged = permissionService.setDefaultPermissions(permissions);
    res.json({ success: true, data: merged });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/users/:id/permissions - 获取指定用户的权限
app.get('/api/admin/users/:id/permissions', authenticate, (req, res) => {
  try {
    const data = permissionService.getUserPermissions(Number(req.params.id));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/permissions - 更新指定用户的某项权限
app.put('/api/admin/users/:id/permissions', authenticate, (req, res) => {
  try {
    const { feature_key: featureKey, enabled } = req.body || {};
    if (!featureKey) return res.status(400).json({ error: 'feature_key 不能为空' });
    permissionService.setUserPermission(Number(req.params.id), featureKey, !!enabled, req.user.id);
    res.json({ success: true, data: permissionService.getUserPermissions(Number(req.params.id)) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/role - 修改用户管理角色（仅系统管理员）
app.put('/api/admin/users/:id/role', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const targetId = Number(req.params.id);
    const { role } = req.body;
    if (!['user', 'admin', 'super_admin'].includes(role)) {
      return res.status(400).json({ error: '无效的角色值' });
    }
    // 不允许修改自己的角色
    if (targetId === req.user.id) {
      return res.status(400).json({ error: '不能修改自己的角色' });
    }
    db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, targetId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/tasks/by-account - 按即梦账号查任务
app.get('/api/admin/tasks/by-account', authenticate, (req, res) => {
  try {
    const accountId = Number(req.query.accountId);
    if (!accountId) return res.status(400).json({ error: 'accountId 必填' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const db = getDatabase();
    // SQLite json_extract 路径：account_info 是 TEXT JSON
    const where = `account_info IS NOT NULL AND json_extract(account_info, '$.accountId') = ? AND deleted_at IS NULL`;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE ${where}`).get(accountId).c;
    const rows = db.prepare(`
      SELECT t.id, t.project_id, t.user_id, t.prompt, t.status, t.video_url, t.created_at,
             p.name AS project_name, u.email AS created_by_email
      FROM tasks t
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(accountId, pageSize, offset);

    res.json({
      success: true,
      data: {
        tasks: rows,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      },
    });
  } catch (error) {
    console.error('[admin] 按账号查任务失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 火山方舟 Ark API 任务直查（按账号秘钥反查火山平台任务）
// ============================================================

// GET /api/admin/volc/tasks?apiKey=&pageNum=&pageSize=&model=&status=
app.get('/api/admin/volc/tasks', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { apiKey: rawApiKey, pageNum = 1, pageSize = 20, model, status } = req.query;
    let apiKey = rawApiKey;
    if (!apiKey) {
      // 使用当前激活的火山Key组中的 ark_model_key
      const activeGroup = db.prepare('SELECT * FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
      if (activeGroup) apiKey = activeGroup.ark_model_key;
    }
    if (!apiKey) return res.status(400).json({ error: '无可用的 ARK API Key，请先在后台配置火山Key组' });
    const result = await volcArkService.listContentGenerationTasks(apiKey, {
      pageNum: Number(pageNum),
      pageSize: Number(pageSize),
      model,
      status,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[volc-ark] 列任务失败:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// GET /api/admin/volc/tasks/:taskId?apiKey=  - 单任务完整字段
app.get('/api/admin/volc/tasks/:taskId', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { apiKey: rawApiKey } = req.query;
    let apiKey = rawApiKey;
    if (!apiKey) {
      const activeGroup = db.prepare('SELECT * FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
      if (activeGroup) apiKey = activeGroup.ark_model_key;
    }
    if (!apiKey) return res.status(400).json({ error: '无可用的 ARK API Key' });
    const result = await volcArkService.getContentGenerationTask(apiKey, req.params.taskId);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[volc-ark] 查任务详情失败:', error.message);
    res.status(502).json({ error: error.message });
  }
});

// ============================================================
// 模型计费管理
// ============================================================

// GET /api/model-pricing - 当前用户可见的启用中模型（含价格）
app.get('/api/model-pricing', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: pricingService.listEnabled() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/model-pricing - 管理员看到所有模型
app.get('/api/admin/model-pricing', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: pricingService.listAll() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/model-pricing/:modelKey - 新增或修改模型计费配置
app.put('/api/admin/model-pricing/:modelKey', authenticate, (req, res) => {
  try {
    const row = pricingService.upsert(req.params.modelKey, req.body || {});
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/admin/model-pricing/:modelKey
app.delete('/api/admin/model-pricing/:modelKey', authenticate, (req, res) => {
  try {
    pricingService.remove(req.params.modelKey);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 火山Key组管理（支持多组同时激活，按权重分配）
// ============================================================

// GET /api/admin/volc-key-groups
app.get('/api/admin/volc-key-groups', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const groups = db.prepare(`
      SELECT v.*,
        (SELECT COUNT(*) FROM projects WHERE volc_id = v.id) AS bound_count,
        (SELECT COUNT(*) FROM projects WHERE volc_id IS NULL) AS default_count
      FROM volc_key_groups v ORDER BY v.id ASC
    `).all();
    res.json({ success: true, data: groups });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 辅助：调整其他已激活组的 grouping_weight 腾空间
function redistributeGroupingWeight(db, excludeId, newWeight) {
  const others = db.prepare(
    'SELECT id, grouping_weight FROM volc_key_groups WHERE is_active = 1 AND id != ? ORDER BY id'
  ).all(excludeId);
  if (others.length === 0) return;
  const currentSum = others.reduce((s, o) => s + (o.grouping_weight || 0), 0);
  const targetOthersSum = 100 - newWeight;
  if (targetOthersSum < 0) throw new Error('grouping_weight 不能超过 100');
  if (others.length === 1) {
    db.prepare('UPDATE volc_key_groups SET grouping_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(targetOthersSum, others[0].id);
    return;
  }
  const delta = targetOthersSum - currentSum;
  const perGroup = Math.floor(delta / others.length);
  let remainder = delta - perGroup * others.length;
  for (const o of others) {
    let newVal = (o.grouping_weight || 0) + perGroup + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    if (newVal < 0) newVal = 0;
    db.prepare('UPDATE volc_key_groups SET grouping_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newVal, o.id);
  }
}

// POST /api/admin/volc-key-groups
app.post('/api/admin/volc-key-groups', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { name, ark_model_key, volc_access_key = '', volc_secret_key = '', note = '', grouping_weight = 0 } = req.body;
    if (!name || !ark_model_key) {
      return res.status(400).json({ error: 'name 和 ark_model_key 均必填' });
    }
    const result = db.prepare(
      'INSERT INTO volc_key_groups (name, ark_model_key, ark_asset_key, volc_access_key, volc_secret_key, is_active, grouping_weight, note) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
    ).run(name, ark_model_key, '', volc_access_key, volc_secret_key, grouping_weight, note);
    const group = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, data: group });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/volc-key-groups/:id
app.put('/api/admin/volc-key-groups/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });
    const { name, ark_model_key, volc_access_key, volc_secret_key, note, grouping_weight } = req.body;
    // grouping_weight: 若该组已激活且 weight 变更，重新分配其他组权重
    if (grouping_weight !== undefined && existing.is_active && grouping_weight !== existing.grouping_weight) {
      redistributeGroupingWeight(db, id, grouping_weight);
    }
    db.prepare(
      'UPDATE volc_key_groups SET name=?, ark_model_key=?, volc_access_key=?, volc_secret_key=?, grouping_weight=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(
      name ?? existing.name,
      ark_model_key ?? existing.ark_model_key,
      volc_access_key ?? existing.volc_access_key ?? '',
      volc_secret_key ?? existing.volc_secret_key ?? '',
      grouping_weight ?? existing.grouping_weight ?? 0,
      note ?? existing.note,
      id
    );
    const group = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    res.json({ success: true, data: group });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/volc-key-groups/:id/activate - 激活Key组
// 多账户关闭时：单组模式，激活目标组并停用其他所有组
// 多账户开启时：多组模式，可同时激活多组（权重总和需保持 100%）
app.put('/api/admin/volc-key-groups/:id/activate', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });

    const multiRow = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
    const multiEnabled = multiRow?.value === '1' || multiRow?.value === 'true';

    if (multiEnabled) {
      // 多账户模式：允许多组同时激活
      // 如果当前无任何激活组，作为第一个激活组，重置所有权重后设为 100%
      const existingActive = db.prepare('SELECT COUNT(*) AS c FROM volc_key_groups WHERE is_active = 1').get();
      if (existingActive.c === 0) {
        db.prepare('UPDATE volc_key_groups SET grouping_weight = 0').run();
        db.prepare('UPDATE volc_key_groups SET is_active = 1, grouping_weight = 100, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        console.log(`[volc-key] 多账户模式首个激活组：重置所有权重，Key组 id=${id} 权重设为 100%`);
      } else {
        db.prepare('UPDATE volc_key_groups SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      }
      // 校验激活后 grouping_weight 总和 = 100
      const activeGroups = db.prepare(
        'SELECT id, grouping_weight FROM volc_key_groups WHERE is_active = 1'
      ).all();
      const totalWeight = activeGroups.reduce((s, g) => s + (g.grouping_weight || 0), 0);
      if (totalWeight !== 100) {
        console.warn(`[volc-key] 激活后分组权重总和=${totalWeight}（期望=100），请手动调整`);
      }
    } else {
      // 单账户模式：只允许一组激活，先停用其他所有组
      db.prepare('UPDATE volc_key_groups SET is_active = (CASE WHEN id = ? THEN 1 ELSE 0 END), updated_at = CURRENT_TIMESTAMP').run(id);
      console.log(`[volc-key] 单账户模式：Key组 id=${id} 已激活，其余已停用`);
    }

    // 同步 AK/SK 到 system_config
    if (existing.volc_access_key) {
      db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('volc_access_key_id', ?)").run(existing.volc_access_key);
    }
    if (existing.volc_secret_key) {
      db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('volc_secret_access_key', ?)").run(existing.volc_secret_key);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/volc-key-groups/:id/deactivate - 停用Key组（仅多账户模式下可用）
// 停用时自动将停用组的权重平均分配到剩余激活组
app.put('/api/admin/volc-key-groups/:id/deactivate', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });
    if (!existing.is_active) return res.status(400).json({ error: '该Key组未激活' });

    const multiRow = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
    const multiEnabled = multiRow?.value === '1' || multiRow?.value === 'true';
    if (!multiEnabled) {
      return res.status(400).json({ error: '单账户模式下不允许停用Key组，请直接激活其他组' });
    }

    const deactivatedWeight = existing.grouping_weight || 0;

    // 停用目标组
    db.prepare('UPDATE volc_key_groups SET is_active = 0, grouping_weight = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

    // 查询剩余激活组，将停用组权重平均分配
    const remaining = db.prepare(
      'SELECT id, grouping_weight FROM volc_key_groups WHERE is_active = 1 AND id != ? ORDER BY id'
    ).all(id);

    if (remaining.length > 0 && deactivatedWeight > 0) {
      const share = Math.floor(deactivatedWeight / remaining.length);
      const remainder = deactivatedWeight - share * remaining.length;

      const updateStmt = db.prepare('UPDATE volc_key_groups SET grouping_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const distributeMany = db.transaction((groups, baseShare, extra) => {
        for (let i = 0; i < groups.length; i++) {
          const newWeight = (groups[i].grouping_weight || 0) + baseShare + (i === groups.length - 1 ? extra : 0);
          updateStmt.run(newWeight, groups[i].id);
        }
      });
      distributeMany(remaining, share, remainder);

      // 均分后校验总和，若不为 100 则按比例归一化
      const afterGroups = db.prepare('SELECT id, grouping_weight FROM volc_key_groups WHERE is_active = 1').all();
      const afterTotal = afterGroups.reduce((s, g) => s + (g.grouping_weight || 0), 0);
      if (afterTotal > 0 && afterTotal !== 100) {
        const normStmt = db.prepare('UPDATE volc_key_groups SET grouping_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const normMany = db.transaction((groups, total) => {
          let distributed = 0;
          for (let i = 0; i < groups.length; i++) {
            const raw = Math.floor((groups[i].grouping_weight || 0) * 100 / total);
            const w = (i === groups.length - 1) ? (100 - distributed) : raw;
            distributed += w;
            normStmt.run(w, groups[i].id);
          }
        });
        normMany(afterGroups, afterTotal);
        console.log(`[volc-key] 权重归一化：总和 ${afterTotal} → 100`);
      }
    }

    console.log(`[volc-key] 多账户模式：Key组 id=${id} 已停用，权重 ${deactivatedWeight}% 已均分给 ${remaining.length} 组`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/volc-key-groups/:id
app.delete('/api/admin/volc-key-groups/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });
    if (existing.is_active) return res.status(400).json({ error: '不能删除当前激活的Key组，请先激活其他组' });
    db.prepare('DELETE FROM volc_key_groups WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 速创API Key 管理
// ============================================================

// GET /api/admin/wuyin-key
app.get('/api/admin/wuyin-key', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'wuyin_api_key'").get();
    res.json({ success: true, data: { key: row?.value || '' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/volc-key-groups/stats - 获取各组绑定的项目组数量
app.get('/api/admin/volc-key-groups/stats', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const stats = db.prepare(`
      SELECT v.id, v.name,
        (SELECT COUNT(*) FROM projects WHERE volc_id = v.id) AS bound_count
      FROM volc_key_groups v ORDER BY v.id ASC
    `).all();
    const defaultCount = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE volc_id IS NULL').get();
    res.json({ success: true, data: { stats, defaultCount: defaultCount?.c || 0 } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/multi-account — 获取多账户开关状态
app.get('/api/admin/multi-account', authenticate, (req, res) => {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
  res.json({ success: true, data: { enabled: row?.value === '1' || row?.value === 'true' } });
});

// GET /api/volc-key-status — 普通用户获取多账户开关状态（用于判断项目绑定的火山账号是否可用）
app.get('/api/volc-key-status', authenticate, (req, res) => {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
  res.json({ success: true, data: { multiAccountEnabled: row?.value === '1' || row?.value === 'true' } });
});

// PUT /api/admin/multi-account — 切换多账户开关
// 开启时：将当前激活组的权重设为 100%
// 关闭时（单账户模式）：若有多组激活，只保留第一组，其余停用
app.put('/api/admin/multi-account', authenticate, (req, res) => {
  const db = getDatabase();
  const { enabled } = req.body || {};
  db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('multi_volc_is_enable', ?)").run(enabled ? '1' : '0');
  if (enabled) {
    // 多账户模式：重置所有权重为 0，只给唯一激活组设 100
    const activeGroup = db.prepare('SELECT id FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
    db.prepare('UPDATE volc_key_groups SET grouping_weight = 0').run();
    if (activeGroup) {
      db.prepare('UPDATE volc_key_groups SET grouping_weight = 100 WHERE id = ?').run(activeGroup.id);
      console.log(`[multi-account] 多账户模式已启用，重置所有权重，Key组 id=${activeGroup.id} 权重设为 100%`);
    }
  } else {
    // 单账户模式：只保留第一组，停用其余
    const firstGroup = db.prepare('SELECT id FROM volc_key_groups ORDER BY id ASC LIMIT 1').get();
    if (firstGroup) {
      db.prepare('UPDATE volc_key_groups SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP').run(firstGroup.id);
      console.log(`[multi-account] 单账户模式：仅保留Key组 id=${firstGroup.id} 激活，其余已停用`);
    }
  }
  res.json({ success: true, data: { enabled: !!enabled } });
});

// PUT /api/admin/wuyin-key
app.put('/api/admin/wuyin-key', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key 不能为空' });
    db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('wuyin_api_key', ?)").run(key);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 火山 AI MediaKit Key 管理
// ============================================================

app.get('/api/admin/mediakit-key', authenticate, (req, res) => {
  try {
    const row = getDatabase().prepare("SELECT value FROM system_config WHERE key = 'mediakit_api_key'").get();
    res.json({ success: true, data: { key: row?.value || '' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/mediakit-key', authenticate, (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key 不能为空' });
    getDatabase()
      .prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES ('mediakit_api_key', ?, '火山 AI MediaKit API Key（画质增强）')")
      .run(key);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 音频生成中转视频配置
// ============================================================

const ALLOWED_AUDIO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const ALLOWED_AUDIO_RESOLUTIONS = ['480p', '720p', '1080p'];
const ALLOWED_AUDIO_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

app.get('/api/admin/audio-gen-config', authenticate, (req, res) => {
  try {
    const cfg = getAudioGenConfig();
    res.json({
      success: true,
      data: {
        config: cfg,
        defaults: AUDIO_GEN_DEFAULTS,
        options: {
          ratios: ALLOWED_AUDIO_RATIOS,
          resolutions: ALLOWED_AUDIO_RESOLUTIONS,
          durations: ALLOWED_AUDIO_DURATIONS,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/audio-gen-config', authenticate, (req, res) => {
  try {
    const { model, ratio, resolution, duration } = req.body || {};
    if (!model || typeof model !== 'string') return res.status(400).json({ error: 'model 不能为空' });
    if (!ALLOWED_AUDIO_RATIOS.includes(ratio)) return res.status(400).json({ error: `ratio 非法，允许：${ALLOWED_AUDIO_RATIOS.join(',')}` });
    if (!ALLOWED_AUDIO_RESOLUTIONS.includes(resolution)) return res.status(400).json({ error: `resolution 非法，允许：${ALLOWED_AUDIO_RESOLUTIONS.join(',')}` });
    const durNum = parseInt(duration, 10);
    if (!ALLOWED_AUDIO_DURATIONS.includes(durNum)) return res.status(400).json({ error: `duration 非法，允许：${ALLOWED_AUDIO_DURATIONS.join(',')}` });

    const db = getDatabase();
    const upsert = db.prepare("INSERT OR REPLACE INTO system_config (key, value, description) VALUES (?, ?, ?)");
    upsert.run('audio_gen_model', model, '音频生成中转视频：模型');
    upsert.run('audio_gen_ratio', ratio, '音频生成中转视频：画面比例');
    upsert.run('audio_gen_resolution', resolution, '音频生成中转视频：分辨率');
    upsert.run('audio_gen_duration', String(durNum), '音频生成中转视频：时长（秒）');
    res.json({ success: true, data: getAudioGenConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 画质增强计费配置
// 画质增强计费配置（admin 读 + 改）
// 新规则下：16 项系数固定（与 MediaKit 官方计费表一致），admin 只能改基础单价（积分/分钟）。
app.get('/api/admin/enhancement-pricing', authenticate, (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        baseCreditsPerMinute: enhancementPricingService.getBaseCreditsPerMinute(),
        defaultBaseCreditsPerMinute: enhancementPricingService.DEFAULT_BASE_CREDITS_PER_MINUTE,
        coefficients: enhancementPricingService.getCoefficientTable(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/enhancement-pricing', authenticate, (req, res) => {
  try {
    const { baseCreditsPerMinute } = req.body;
    if (baseCreditsPerMinute == null) {
      return res.status(400).json({ error: '缺少 baseCreditsPerMinute' });
    }
    enhancementPricingService.setBaseCreditsPerMinute(baseCreditsPerMinute);
    res.json({
      success: true,
      data: { baseCreditsPerMinute: enhancementPricingService.getBaseCreditsPerMinute() },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// 视频画质增强（用户侧）
// ============================================================

// GET /api/enhancement-pricing - 普通用户也能读，用于弹窗预估积分
app.get('/api/enhancement-pricing', authenticate, (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        baseCreditsPerMinute: enhancementPricingService.getBaseCreditsPerMinute(),
        coefficients: enhancementPricingService.getCoefficientTable(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/video-enhancements?taskId=:id - 列出某任务的所有增强记录
app.get('/api/video-enhancements', authenticate, (req, res) => {
  try {
    const taskId = parseInt(req.query.taskId);
    if (!taskId) return res.status(400).json({ error: 'taskId 必填' });
    const db = getDatabase();
    const task = db.prepare(`SELECT user_id FROM tasks WHERE id = ?`).get(taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.user_id !== req.user.id && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: '无权访问' });
    }
    const rows = db.prepare(
      `SELECT id, task_id, status, tool_version, scene, target_resolution, resolution_limit, target_fps,
              enhanced_video_url, result_resolution, result_fps,
              error_message, credits_used, duration_seconds,
              created_at, finished_at
       FROM video_enhancements WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
    ).all(taskId);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/video-enhancements - 提交画质增强任务
// 支持两种模式：
//   1) { taskId, ... }                              —— 增强本平台已生成的视频
//   2) { videoUrl, durationSeconds, ... }           —— 增强外部视频（http/https URL）
app.post('/api/video-enhancements', authenticate, async (req, res) => {
  const db = getDatabase();
  const {
    taskId, videoUrl, durationSeconds,
    scene = 'common',
    toolVersion = 'standard',
    resolution,             // 预设档：'240p' | '360p' | '480p' | '540p' | '720p' | '1080p' | '2k' | '4k'
    resolutionLimit,        // 自定义短边像素 [64, 2160]（与 resolution 互斥）
    targetFps = 30,
    projectId: reqProjectId, // 当前项目组（外部视频源时必须；taskId 源时以 task.project_id 为准）
  } = req.body;

  if (!['aigc', 'short_series', 'ugc', 'old_film', 'common'].includes(scene)) {
    return res.status(400).json({ error: '无效的 scene' });
  }
  if (!['standard', 'professional'].includes(toolVersion)) {
    return res.status(400).json({ error: '无效的 tool_version' });
  }
  // resolution / resolutionLimit 互斥校验
  const hasResolution = resolution != null && resolution !== '';
  const hasResolutionLimit = resolutionLimit != null && resolutionLimit !== '';
  if (hasResolution && hasResolutionLimit) {
    return res.status(400).json({ error: 'resolution 与 resolutionLimit 不能同时设置' });
  }
  if (!hasResolution && !hasResolutionLimit) {
    return res.status(400).json({ error: '必须设置 resolution（预设）或 resolutionLimit（短边像素）' });
  }
  const RES_PRESETS = ['240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k'];
  let normalizedResolution = null;
  let normalizedResolutionLimit = null;
  if (hasResolution) {
    if (!RES_PRESETS.includes(resolution)) {
      return res.status(400).json({ error: `无效的 resolution（应为 ${RES_PRESETS.join(' / ')} 之一）` });
    }
    normalizedResolution = resolution;
  } else {
    const n = parseInt(resolutionLimit, 10);
    if (!Number.isFinite(n) || n < 64 || n > 2160) {
      return res.status(400).json({ error: '无效的 resolutionLimit（应为 64~2160 之间的整数）' });
    }
    normalizedResolutionLimit = n;
  }
  const targetFpsNum = parseInt(targetFps, 10);
  if (!Number.isFinite(targetFpsNum) || targetFpsNum <= 0 || targetFpsNum > 120) {
    return res.status(400).json({ error: '无效的 targetFps（应为 1~120 之间的整数）' });
  }

  // 1) 来源分支：taskId 优先；否则走外部 videoUrl
  let sourceUrl, durationSec, sourceTaskId = null, projectId = null;
  if (taskId) {
    const task = db.prepare(
      `SELECT id, user_id, project_id, video_url, duration, status FROM tasks WHERE id = ?`
    ).get(taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.user_id !== req.user.id) return res.status(403).json({ error: '无权操作他人任务' });
    if (task.status !== 'done' || !task.video_url) {
      return res.status(400).json({ error: '源视频未生成完成，无法增强' });
    }
    // 防重：同一任务已有 pending/processing 记录时拒绝再次提交（软删的不算）
    const inProgress = db.prepare(
      `SELECT id FROM video_enhancements WHERE task_id = ? AND status IN ('pending', 'processing') AND deleted_at IS NULL LIMIT 1`
    ).get(taskId);
    if (inProgress) return res.status(409).json({ error: '该视频已有增强任务正在进行中，请等待完成后再试' });
    sourceUrl = task.video_url;
    // 校验 TOS 签名 URL 是否过期（X-Tos-Date + X-Tos-Expires）
    const tosDate = sourceUrl.match(/X-Tos-Date=(\d{8}T\d{6}Z)/)?.[1];
    const tosExpires = parseInt(sourceUrl.match(/X-Tos-Expires=(\d+)/)?.[1] || '0');
    if (tosDate && tosExpires) {
      const signedAt = new Date(tosDate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
      const expireAt = new Date(signedAt.getTime() + tosExpires * 1000);
      if (Date.now() > expireAt.getTime()) {
        return res.status(400).json({ error: '源视频链接已过期，请重新生成视频后再提交增强' });
      }
    }
    durationSec = Math.max(1, Math.round(Number(task.duration) || 5));
    sourceTaskId = task.id;
    projectId = task.project_id || null;
  } else if (videoUrl && durationSeconds) {
    if (!/^https?:\/\//i.test(videoUrl)) {
      return res.status(400).json({ error: '视频 URL 必须为 http/https' });
    }
    const d = Number(durationSeconds);
    if (!Number.isFinite(d) || d <= 0) {
      return res.status(400).json({ error: '时长必须为正数' });
    }
    // 校验 TOS 签名 URL 是否过期
    const tosDateExt = videoUrl.match(/X-Tos-Date=(\d{8}T\d{6}Z)/)?.[1];
    const tosExpiresExt = parseInt(videoUrl.match(/X-Tos-Expires=(\d+)/)?.[1] || '0');
    if (tosDateExt && tosExpiresExt) {
      const signedAt = new Date(tosDateExt.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
      const expireAt = new Date(signedAt.getTime() + tosExpiresExt * 1000);
      if (Date.now() > expireAt.getTime()) {
        return res.status(400).json({ error: '视频链接已过期，请重新上传或更换链接' });
      }
    }
    sourceUrl = videoUrl;
    durationSec = Math.max(1, Math.min(300, Math.round(d)));
    // 外部视频分支：projectId 走前端传入（与图片/音频/视频生成一致）。
    // 校验是否为当前用户可访问的项目组，避免把记录挂到别的项目组下。
    const pidNum = parseInt(reqProjectId, 10);
    if (Number.isFinite(pidNum) && pidNum > 0) {
      const allowed = projectService.isProjectMember(pidNum, req.user.id)
        || ['admin', 'super_admin'].includes(req.user.role);
      if (!allowed) {
        return res.status(403).json({ error: '无权访问该项目组' });
      }
      projectId = pidNum;
    }
  } else {
    return res.status(400).json({ error: '请提供 taskId 或 videoUrl+durationSeconds' });
  }

  // 2) TOS 签名 URL → OSS 永久链接转存（避免 MediaKit 因链接过期无法下载）
  if (/X-Tos-Date=/i.test(sourceUrl)) {
    try {
      console.log(`[增强] 检测到 TOS 签名 URL，转存到 OSS...`);
      const videoResp = await fetch(sourceUrl);
      if (!videoResp.ok) throw new Error(`下载源视频失败 HTTP ${videoResp.status}`);
      const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
      const ossKey = `seedance/${new Date().toISOString().slice(0,10)}/enhancement/${Date.now()}_source.mp4`;
      const ossClient = createOssClient();
      if (videoBuffer.length > 10 * 1024 * 1024) {
        await ossClient.multipartUpload(ossKey, videoBuffer, { mime: 'video/mp4', partSize: 5 * 1024 * 1024, parallel: 3 });
      } else {
        await ossClient.put(ossKey, videoBuffer, { mime: 'video/mp4' });
      }
      sourceUrl = `${OSS_URL_PREFIX}${ossKey}`;
      console.log(`[增强] 转存完成: ${sourceUrl}`);
    } catch (e) {
      return res.status(502).json({ error: `视频转存 OSS 失败：${e.message}` });
    }
  }

  // 3) 取计费配置 + Key
  const apiKeyRow = db.prepare("SELECT value FROM system_config WHERE key = 'mediakit_api_key'").get();
  const apiKey = apiKeyRow?.value || '';
  if (!apiKey) return res.status(503).json({ error: 'MediaKit API Key 未配置，请联系管理员' });

  // 按 MediaKit 官方规则估算（基础单价 × 系数 × 时长分钟），1.2× 锁定 buffer 防上游实扣略高
  // 计费档位由「输出短边」决定：用预设时直接传 '1080p' 等；用 resolutionLimit 时按像素值定档
  const billingResolution = normalizedResolution ?? normalizedResolutionLimit;
  const estimateResult = enhancementPricingService.estimate({
    toolVersion,
    resolution: billingResolution,
    fps: targetFpsNum,
    durationSec,
  });
  if (estimateResult.coefficient === 0) {
    return res.status(400).json({ error: '该参数组合（版本/分辨率/帧率）暂未配置计费系数' });
  }
  const estimatedCredits = estimateResult.credits;
  const lockedCredits = estimateResult.lockedCredits;
  const versionLabel = toolVersion === 'professional' ? '画质增强 专业版' : '画质增强 标准版';

  // 3) 预插入 video_enhancements 行
  let enhancementId;
  try {
    const ins = db.prepare(
      `INSERT INTO video_enhancements
         (task_id, user_id, project_id, source_video_url, tool_version, scene,
          target_resolution, resolution_limit, target_fps, duration_seconds, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      sourceTaskId, req.user.id, projectId, sourceUrl, toolVersion, scene,
      normalizedResolution, normalizedResolutionLimit, targetFpsNum, durationSec,
    );
    enhancementId = ins.lastInsertRowid;
  } catch (e) {
    return res.status(500).json({ error: '初始化记录失败：' + e.message });
  }

  // 4) 锁定积分（按 lockedCredits = ceil(credits × 1.2)）
  try {
    creditLockService.lockForEnhancement({
      userId: req.user.id,
      enhancementId,
      credits: lockedCredits,
      meta: {
        tool_version: toolVersion, scene,
        resolution: normalizedResolution,
        resolution_limit: normalizedResolutionLimit,
        fps: targetFpsNum,
        duration: durationSec, model: versionLabel,
        estimated_credits: estimatedCredits,
        coefficient: estimateResult.coefficient,
        resolution_tier: estimateResult.resolutionTier,
        base_credits_per_minute: estimateResult.baseCreditsPerMinute,
        source: sourceTaskId ? 'task' : 'url',
      },
    });
  } catch (e) {
    db.prepare(`DELETE FROM video_enhancements WHERE id = ?`).run(enhancementId);
    return res.status(402).json({ error: e.message });
  }

  // 5) 调 MediaKit
  let mediakitTaskId;
  try {
    mediakitTaskId = await mediaKitService.submitEnhanceVideo({
      apiKey,
      videoUrl: sourceUrl,
      scene,
      toolVersion,
      resolution: normalizedResolution,
      resolutionLimit: normalizedResolutionLimit,
      fps: targetFpsNum,
    });
  } catch (e) {
    creditLockService.releaseForEnhancement({ enhancementId, reason: 'MediaKit 提交失败：' + e.message });
    db.prepare(`UPDATE video_enhancements SET status='error', error_message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(e.message, enhancementId);
    return res.status(502).json({ error: 'MediaKit 提交失败：' + e.message });
  }

  // 6) 写回 mediakit_task_id 并切到 processing
  db.prepare(
    `UPDATE video_enhancements SET mediakit_task_id=?, status='processing' WHERE id=?`
  ).run(mediakitTaskId, enhancementId);

  const row = db.prepare(`SELECT * FROM video_enhancements WHERE id = ?`).get(enhancementId);
  res.json({ success: true, data: row, estimatedCredits });
});

// GET /api/video-enhancements/list - 列出当前项目组可见的所有增强记录（管理员看全部；普通用户看自己创建的 + 所在项目组其他成员创建的）
app.get('/api/video-enhancements/list', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

    // 项目组共享：与视频生成历史一致——同一 project_members 的所有记录互相可见。
    // 外部增强(project_id IS NULL)：与创建者共享任一项目组的成员均可见，避免外部记录变成"创作者私有黑洞"
    const ownership = isAdmin ? '1=1' : `(
      user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = video_enhancements.project_id AND pm.user_id = ?
      ) OR (
        video_enhancements.project_id IS NULL AND EXISTS (
          SELECT 1 FROM project_members pm1
          JOIN project_members pm2 ON pm2.project_id = pm1.project_id
          WHERE pm1.user_id = video_enhancements.user_id AND pm2.user_id = ?
        )
      )
    )`;
    let where = `deleted_at IS NULL AND ${ownership}`;
    const params = isAdmin ? [] : [req.user.id, req.user.id, req.user.id];
    const queryProjectId = parseInt(req.query.projectId) || null;
    if (queryProjectId) {
      where += ' AND project_id = ?';
      params.push(queryProjectId);
    }

    const total = db.prepare(`SELECT COUNT(*) AS n FROM video_enhancements WHERE ${where}`).get(...params).n;

    const items = db.prepare(
      `SELECT id, task_id, user_id, project_id, source_video_url, mediakit_task_id,
              tool_version, scene, target_resolution, resolution_limit, target_fps,
              duration_seconds, status,
              enhanced_video_url, result_resolution, result_fps,
              credits_used, error_message, created_at, finished_at
       FROM video_enhancements
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    res.json({ success: true, data: { items, total, page, pageSize } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// HappyHorse 视频生成（阿里云百炼 DashScope）
// 4 个子模式共用 tasks_happyhorse 表 + 一个异步 worker
// ============================================================

const HAPPYHORSE_MODE_MODELS = {
  't2v': 'happyhorse-1.0-t2v',
  'i2v': 'happyhorse-1.0-i2v',
  'r2v': 'happyhorse-1.0-r2v',
  'video-edit': 'happyhorse-1.0-video-edit',
};
const HAPPYHORSE_RESOLUTIONS = ['720P', '1080P'];
const HAPPYHORSE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4'];

function happyhorseRowToDto(row) {
  if (!row) return null;
  let media = [];
  try { media = row.media_json ? JSON.parse(row.media_json) : []; } catch { media = []; }
  const { media_json, ...rest } = row;
  return { ...rest, media };
}

function authorizeHappyhorseRow(row, req) {
  if (!row) return { ok: false, status: 404, error: '任务不存在' };
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  if (!isAdmin && row.user_id !== req.user.id) {
    if (!projectService.isProjectMember(row.project_id, req.user.id)) {
      return { ok: false, status: 403, error: '无权访问该任务' };
    }
  }
  return { ok: true };
}

// GET /api/happyhorse/pricing - 公开（已登录）拿计费表
app.get('/api/happyhorse/pricing', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: { pricing: happyhorsePricingService.getPricingTable() } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/happyhorse-tasks - 提交任务
app.post('/api/happyhorse-tasks', authenticate, async (req, res) => {
  const db = getDatabase();
  try {
    if (!permissionService.hasPermission(req.user.id, 'generate_video_happyhorse')) {
      return res.status(403).json({ error: '当前账号未开通 HappyHorse 视频生成权限，请联系管理员' });
    }

    const {
      projectId, mode, prompt, resolution,
      ratio, duration, media, audioSetting, seed,
      inputVideoDurationSec, batchSize: rawBatchSize,
    } = req.body || {};
    const maxHHConcurrent = parseInt(settingsService.getSetting('max_concurrent') || '5', 10);
    const batchSize = Math.max(1, Math.min(parseInt(rawBatchSize, 10) || 1, maxHHConcurrent || 5));

    const m = String(mode || '').toLowerCase();
    if (!HAPPYHORSE_MODE_MODELS[m]) {
      return res.status(400).json({ error: '无效的 mode，应为 t2v / i2v / r2v / video-edit 之一' });
    }
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return res.status(400).json({ error: '必须指定所属项目组（projectId）' });

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(pid, req.user.id, isAdmin);
    if (!project) return res.status(403).json({ error: '项目组不存在或您不是该项目组成员' });

    const promptStr = String(prompt || '').trim();
    if (!promptStr && m === 't2v') return res.status(400).json({ error: '请输入文本提示词' });
    if (promptStr.length > 5000) return res.status(400).json({ error: '提示词过长（≤5000 字符）' });

    const resolutionUp = String(resolution || '').toUpperCase();
    if (!HAPPYHORSE_RESOLUTIONS.includes(resolutionUp)) {
      return res.status(400).json({ error: '无效的 resolution，应为 720P / 1080P' });
    }

    let normalizedRatio = null;
    if (m === 't2v' || m === 'r2v') {
      const r = String(ratio || '16:9');
      if (!HAPPYHORSE_RATIOS.includes(r)) return res.status(400).json({ error: '无效的 ratio' });
      normalizedRatio = r;
    }

    let normalizedDuration = null;
    if (m !== 'video-edit') {
      const d = parseInt(duration ?? 5, 10);
      if (!Number.isFinite(d) || d < 3 || d > 15) {
        return res.status(400).json({ error: 'duration 应为 3~15 之间的整数' });
      }
      normalizedDuration = d;
    }

    // 校验 / 规范化 media
    const mediaArr = Array.isArray(media) ? media : [];
    function pick(item) {
      if (!item || typeof item !== 'object') return null;
      const type = String(item.type || '').toLowerCase();
      const url = String(item.url || '').trim();
      if (!url) return null;
      return { type, url, original_name: item.original_name || item.originalName || null };
    }
    const cleaned = mediaArr.map(pick).filter(Boolean);

    let apiInputMedia = null;
    if (m === 't2v') {
      if (cleaned.length > 0) return res.status(400).json({ error: '文生视频不支持上传媒体素材' });
    } else if (m === 'i2v') {
      const first = cleaned.find((x) => x.type === 'first_frame') || cleaned[0];
      if (!first) return res.status(400).json({ error: '图生视频需上传 1 张首帧图片' });
      apiInputMedia = [{ type: 'first_frame', url: first.url }];
    } else if (m === 'r2v') {
      const refs = cleaned.filter((x) => x.type === 'reference_image' || x.type === '');
      if (refs.length < 1 || refs.length > 9) {
        return res.status(400).json({ error: '参考生视频需 1~9 张参考图' });
      }
      apiInputMedia = refs.map((x) => ({ type: 'reference_image', url: x.url }));
    } else if (m === 'video-edit') {
      const vid = cleaned.find((x) => x.type === 'video');
      if (!vid) return res.status(400).json({ error: '视频编辑需上传 1 个待编辑视频' });
      const refs = cleaned.filter((x) => x.type === 'reference_image');
      if (refs.length > 5) return res.status(400).json({ error: '视频编辑参考图最多 5 张' });
      apiInputMedia = [{ type: 'video', url: vid.url }, ...refs.map((x) => ({ type: 'reference_image', url: x.url }))];
    }

    // 估算积分。
    //   - t2v / i2v / r2v：按用户选择的输出 duration
    //   - video-edit：若前端 probe 出了真实输入视频时长，按 effective×2 精确预扣；否则 30s 上限兜底
    const hintInputDur = Number(inputVideoDurationSec);
    const est = happyhorsePricingService.estimate({
      mode: m,
      resolution: resolutionUp,
      durationSec: m === 'video-edit' ? undefined : normalizedDuration,
      inputVideoDurationSec: m === 'video-edit' && Number.isFinite(hintInputDur) && hintInputDur > 0
        ? hintInputDur
        : undefined,
    });
    if (!est.creditsPerSecond) {
      return res.status(400).json({ error: '该模式/分辨率未配置计费单价' });
    }
    const lockedCredits = est.discountedLockedCredits ?? est.lockedCredits;

    // 批量生成：检查总积分
    if (batchSize > 1) {
      const quota = usageService.checkUserQuota(req.user.id);
      if (!quota.allowed) {
        return res.status(402).json({ error: `积分不足（当前 ${quota.credits}），请联系管理员充值` });
      }
      if (!quota.unlimited) {
        const lockedSum = creditLockService.getLockedTotal(req.user.id);
        const available = quota.credits - lockedSum;
        const totalNeeded = lockedCredits * batchSize;
        if (lockedCredits > 0 && available < totalNeeded) {
          return res.status(402).json({
            error: `批量生成 ${batchSize} 个任务积分不足（可用 ${available}，需要 ${totalNeeded}）`,
          });
        }
      }
    }
    const hhConcurrentId = batchSize > 1 ? crypto.randomUUID() : null;

    // API Key
    const apiKeyRow = db.prepare("SELECT value FROM system_config WHERE key = 'happyhorse_api_key'").get();
    const apiKey = apiKeyRow?.value || '';
    if (!apiKey) return res.status(503).json({ error: 'HappyHorse API Key 未配置，请联系管理员' });

    const mediaJson = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
    // 强制不加水印（产品决策）
    const wm = 0;
    const audioSettingStr = (m === 'video-edit' && (audioSetting === 'origin' || audioSetting === 'auto')) ? audioSetting : null;
    const seedNum = (seed !== undefined && seed !== null && seed !== '') ? parseInt(seed, 10) : null;

    // 批量：创建 N 条任务，锁定积分，并行提交 DashScope
    const hhTaskIds = [];
    const hhResults = [];

    for (let i = 0; i < batchSize; i++) {
      // 预插入
      const ins = db.prepare(
        `INSERT INTO tasks_happyhorse
           (user_id, project_id, mode, model, prompt, ratio, duration, resolution, media_json,
            watermark, audio_setting, seed, status, concurrent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(
        req.user.id, pid, m, HAPPYHORSE_MODE_MODELS[m], promptStr, normalizedRatio,
        normalizedDuration, resolutionUp, mediaJson, wm, audioSettingStr, Number.isFinite(seedNum) ? seedNum : null,
        hhConcurrentId,
      );
      const happyhorseTaskId = ins.lastInsertRowid;
      hhTaskIds.push(happyhorseTaskId);

      try {
        creditLockService.lockForHappyhorse({
          userId: req.user.id,
          happyhorseTaskId,
          credits: lockedCredits,
          meta: {
            mode: m, model: HAPPYHORSE_MODE_MODELS[m],
            resolution: resolutionUp, ratio: normalizedRatio, duration: normalizedDuration,
            estimated_credits: est.discountedCredits ?? est.credits, credits_per_second: est.creditsPerSecond,
          },
        });
      } catch (e) {
        db.prepare('DELETE FROM tasks_happyhorse WHERE id = ?').run(happyhorseTaskId);
        // 回滚已创建的前几个任务
        for (const tid of hhTaskIds) {
          if (tid !== happyhorseTaskId) {
            try { creditLockService.releaseForHappyhorse({ happyhorseTaskId: tid, reason: '批量创建回滚' }); } catch {}
          }
        }
        return res.status(402).json({ error: e.message });
      }

      hhResults.push({ id: happyhorseTaskId, lockedCredits });
    }

    // 顺序提交 DashScope（每个请求间隔 2s）
    const apiInput = { prompt: promptStr };
    if (apiInputMedia) apiInput.media = apiInputMedia;
    const apiParams = { resolution: resolutionUp, watermark: wm === 1 };
    if (normalizedRatio) apiParams.ratio = normalizedRatio;
    if (normalizedDuration) apiParams.duration = normalizedDuration;
    if (audioSettingStr) apiParams.audio_setting = audioSettingStr;
    if (Number.isFinite(seedNum)) apiParams.seed = seedNum;

    // 顺序提交 DashScope，每个请求间隔 2s 避免瞬时并发冲击
    const submitResults = [];
    for (let i = 0; i < hhTaskIds.length; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const hhId = hhTaskIds[i];
      try {
        const result = await happyhorseSubmitTask({
          apiKey,
          model: HAPPYHORSE_MODE_MODELS[m],
          input: apiInput,
          parameters: apiParams,
        });
        db.prepare(
          `UPDATE tasks_happyhorse
           SET dashscope_task_id=?, request_id=?, status='processing', submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
           WHERE id=?`
        ).run(result.task_id, result.request_id || null, hhId);
        submitResults.push({ id: hhId, success: true, dashscope_task_id: result.task_id });
      } catch (e) {
        creditLockService.releaseForHappyhorse({ happyhorseTaskId: hhId, reason: 'DashScope 提交失败：' + e.message });
        db.prepare(`UPDATE tasks_happyhorse SET status='error', error_message=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(e.message, hhId);
        submitResults.push({ id: hhId, success: false, error: e.message });
      }
    }
    const allFailed = submitResults.every((r) => !r.success);

    if (allFailed) {
      const firstError = submitResults[0]?.error || '未知错误';
      if (batchSize <= 1) {
        return res.status(502).json({ error: `快乐马（HappyHorse）提交失败：${firstError}` });
      }
      const detail = submitResults.map((r, i) => `#${i + 1} ${r.error}`).join('；');
      return res.status(502).json({ error: `快乐马（HappyHorse）提交失败（${submitResults.length}/${submitResults.length} 失败）：${detail}` });
    }

    const rows = hhTaskIds.map((hhId) => db.prepare('SELECT * FROM tasks_happyhorse WHERE id = ?').get(hhId));
    const tasks_ = rows.map((row) => happyhorseRowToDto(row));

    if (batchSize > 1) {
      res.json({
        success: true,
        data: { tasks: tasks_, concurrent_id: hhConcurrentId, batchSize },
        estimatedCredits: est.credits,
        lockedCredits: lockedCredits * batchSize,
      });
    } else {
      res.json({ success: true, data: tasks_[0], estimatedCredits: est.credits, lockedCredits });
    }
  } catch (error) {
    console.error('[happyhorse] 提交失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/happyhorse-tasks - 列出当前用户/项目组可见的任务（分页）
app.get('/api/happyhorse-tasks', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const projectId = parseInt(req.query.projectId, 10);
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

    const filters = ['deleted_at IS NULL'];
    const params = [];
    if (Number.isFinite(projectId) && projectId > 0) {
      filters.push('project_id = ?');
      params.push(projectId);
    }
    if (!isAdmin) {
      // 用户：自己创建的，或在同一 project 内的所有成员可见
      filters.push(`(user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = tasks_happyhorse.project_id AND pm.user_id = ?
      ))`);
      params.push(req.user.id, req.user.id);
    }
    const where = filters.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks_happyhorse WHERE ${where}`).get(...params).n;
    const rows = db.prepare(
      `SELECT * FROM tasks_happyhorse WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    res.json({ success: true, data: { items: rows.map(happyhorseRowToDto), total, page, pageSize } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/happyhorse-tasks/:id - 单条详情
app.get('/api/happyhorse-tasks/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM tasks_happyhorse WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    const auth = authorizeHappyhorseRow(row, req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    res.json({ success: true, data: happyhorseRowToDto(row) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/happyhorse-tasks/:id - 软删 HappyHorse 记录（置 deleted_at）
app.delete('/api/happyhorse-tasks/:id', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM tasks_happyhorse WHERE id = ?').get(req.params.id);
    const auth = authorizeHappyhorseRow(row, req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (row.deleted_at) return res.json({ success: true });
    db.prepare('UPDATE tasks_happyhorse SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 注：HappyHorse 视频统一走「浏览器直连 DashScope OSS URL」下载（24h 有效），
// 不在服务器本地落盘 —— 避免硬盘膨胀。前端 fetch + Blob + a[download] 触发即可。

// POST /api/happyhorse-tasks/:id/mark-downloaded - 标记 HappyHorse 任务已下载（持久化）
// 与视频/图片/音频/增强一致：仅写时间戳，不校验下载手段
app.post('/api/happyhorse-tasks/:id/mark-downloaded', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM tasks_happyhorse WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    const auth = authorizeHappyhorseRow(row, req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    db.prepare(`UPDATE tasks_happyhorse SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 管理员：HappyHorse API Key 读/写
app.get('/api/admin/happyhorse-key', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'happyhorse_api_key'").get();
    const v = row?.value || '';
    const masked = v ? `${v.slice(0, 4)}****${v.slice(-4)}` : '';
    res.json({ success: true, data: { configured: !!v, masked } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/happyhorse-key', authenticate, (req, res) => {
  try {
    const apiKey = String(req.body?.apiKey || '').trim();
    const db = getDatabase();
    db.prepare(
      `INSERT INTO system_config (key, value, description)
       VALUES ('happyhorse_api_key', ?, 'HappyHorse (阿里云百炼 DashScope) API Key')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    ).run(apiKey);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 系统管理员：阿里云 BSS AK 读/写
app.get('/api/admin/bss-config', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'bss_access_key_id'").get();
    const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'bss_access_key_secret'").get();
    const ak = akRow?.value || '';
    const maskedAk = ak ? `${ak.slice(0, 4)}****${ak.slice(-4)}` : '';
    const maskedSk = skRow?.value ? '****' : '';
    res.json({ success: true, data: { akConfigured: !!ak, maskedAk, skConfigured: !!(skRow?.value) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/bss-config', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const { accessKeyId, accessKeySecret } = req.body || {};
    const db = getDatabase();
    if (accessKeyId !== undefined) {
      const val = String(accessKeyId || '').trim();
      db.prepare(
        `INSERT INTO system_config (key, value, description)
         VALUES ('bss_access_key_id', ?, '阿里云 BSS AccessKey ID')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).run(val);
    }
    if (accessKeySecret !== undefined) {
      const val = String(accessKeySecret || '').trim();
      db.prepare(
        `INSERT INTO system_config (key, value, description)
         VALUES ('bss_access_key_secret', ?, '阿里云 BSS AccessKey Secret')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).run(val);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 系统管理员：查询阿里云账户余额
app.get('/api/admin/bss-balance', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const balance = await bssService.queryAccountBalance();
    res.json({ success: true, data: balance });
  } catch (e) {
    res.status(502).json({ error: e.message || '查询余额失败' });
  }
});

// 系统管理员：查询火山引擎账户余额（指定Key组或激活组）
app.get('/api/admin/volc-balance', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const keyGroupId = parseInt(req.query.keyGroupId, 10);
    let balance;
    if (Number.isFinite(keyGroupId) && keyGroupId > 0) {
      const db = getDatabase();
      const group = db.prepare('SELECT volc_access_key, volc_secret_key FROM volc_key_groups WHERE id = ?').get(keyGroupId);
      if (!group || !group.volc_access_key || !group.volc_secret_key) {
        return res.status(400).json({ error: '该Key组不存在或未配置 AK/SK' });
      }
      balance = await volcBillingService.queryBalanceAcct({
        accessKeyId: group.volc_access_key,
        secretAccessKey: group.volc_secret_key,
      });
    } else {
      balance = await volcBillingService.queryBalanceAcct();
    }
    res.json({ success: true, data: balance });
  } catch (e) {
    res.status(502).json({ error: e.message || '查询余额失败' });
  }
});

// 管理员：HappyHorse 计费读/写
app.get('/api/admin/happyhorse-pricing', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: { pricing: happyhorsePricingService.getPricingTable() } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/happyhorse-pricing', authenticate, (req, res) => {
  try {
    const items = Array.isArray(req.body?.pricing) ? req.body.pricing : [];
    for (const it of items) {
      happyhorsePricingService.setPricing({
        mode: it.mode,
        resolution: it.resolution,
        creditsPerSecond: it.credits_per_second ?? it.creditsPerSecond,
      });
    }
    res.json({ success: true, data: { pricing: happyhorsePricingService.getPricingTable() } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ============================================================
// 模型折扣管理（模型计费 + HappyHorse 共用）
// ============================================================

app.get('/api/admin/discounts', authenticate, (req, res) => {
  try {
    const discounts = discountService.getDiscounts();
    res.json({ success: true, data: { discounts } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/discounts/active', authenticate, (req, res) => {
  try {
    const discounts = discountService.getActiveDiscounts();
    res.json({ success: true, data: { discounts } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/discounts', authenticate, requireSuperAdmin, (req, res) => {
  try {
    const items = Array.isArray(req.body?.discounts) ? req.body.discounts : [];
    const tx = getDatabase().transaction(() => {
      // 全量替换：先清空旧数据，再插入新数据
      getDatabase().prepare('DELETE FROM model_discounting').run();
      for (const it of items) {
        discountService.upsertDiscount({
          model: it.model,
          subKey: it.sub_key ?? it.subKey ?? '',
          type: it.type,
          value: it.value,
          startDate: it.start_date ?? it.startDate,
          endDate: it.end_date ?? it.endDate,
        });
      }
    });
    tx();
    res.json({ success: true, data: { discounts: discountService.getDiscounts() } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/discounts/:id', authenticate, requireSuperAdmin, (req, res) => {
  try {
    discountService.deleteDiscount(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 音频生成（参考图 + 语气提示词 → seedance 视频，前端转 mp3）
// 默认值经过优化以最小化中转资源消耗，可通过 system_config 覆盖（管理后台 → 音频生成中转配置）
// ============================================================

const AUDIO_GEN_DEFAULTS = {
  model: 'seedance-2.0-fast',
  duration: 4,
  ratio: '1:1',
  resolution: '480p',
};

function getAudioGenConfig() {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT key, value FROM system_config WHERE key IN ('audio_gen_model','audio_gen_ratio','audio_gen_resolution','audio_gen_duration')"
  ).all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  const durationNum = parseInt(map.audio_gen_duration, 10);
  return {
    model: map.audio_gen_model || AUDIO_GEN_DEFAULTS.model,
    ratio: map.audio_gen_ratio || AUDIO_GEN_DEFAULTS.ratio,
    resolution: map.audio_gen_resolution || AUDIO_GEN_DEFAULTS.resolution,
    duration: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : AUDIO_GEN_DEFAULTS.duration,
  };
}

// POST /api/audio-generations - 提交音频生成（即视频生成 + 音频提取标记）
app.post('/api/audio-generations', authenticate, async (req, res) => {
  let dbTaskId = null;
  let audioGenId = null;
  try {
    const { projectId: reqProjectId, referenceImageUrl, referenceAssetUri, voicePrompt } = req.body || {};

    if (!reqProjectId) return res.status(400).json({ error: '必须指定所属项目组（projectId）' });
    if (!referenceImageUrl || typeof referenceImageUrl !== 'string') {
      return res.status(400).json({ error: '请上传参考图（referenceImageUrl 必填）' });
    }
    if (!voicePrompt || !String(voicePrompt).trim()) {
      return res.status(400).json({ error: '请输入语气提示词（voicePrompt 必填）' });
    }
    // referenceAssetUri 可选，格式 asset://asset-xxx-xxx；若提供则推理时优先用它（已入库素材，规避真人检测拦截）
    if (referenceAssetUri && typeof referenceAssetUri === 'string' && !/^asset:\/\/asset-/.test(referenceAssetUri)) {
      return res.status(400).json({ error: 'referenceAssetUri 必须为 asset://asset-xxx 形式' });
    }

    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const targetProject = projectService.getProjectById(Number(reqProjectId), req.user.id, isAdmin);
    if (!targetProject) {
      return res.status(403).json({ error: '项目组不存在或您不是该项目组成员' });
    }

    if (!permissionService.hasPermission(req.user.id, 'generate_video_seedance')) {
      return res.status(403).json({ error: '当前账号未开通视频生成权限，请联系管理员' });
    }

    const audioCfg = getAudioGenConfig();

    const estimateParams = {
      inputDurationSec: 0,
      outputDurationSec: audioCfg.duration,
      resolution: audioCfg.resolution,
      ratio: audioCfg.ratio,
      hasVideoInput: false,
      hasAudio: false,
      isDraft: false,
    };
    const estimateResult = pricingService.estimate(audioCfg.model, estimateParams);
    const lockedCredits = estimateResult.lockedCredits;

    const quota = usageService.checkUserQuota(req.user.id);
    if (!quota.allowed) {
      return res.status(402).json({ error: `积分不足（当前 ${quota.credits}），请联系管理员充值` });
    }
    if (!quota.unlimited) {
      const lockedSum = creditLockService.getLockedTotal(req.user.id);
      const available = quota.credits - lockedSum;
      if (lockedCredits > 0 && available < lockedCredits) {
        return res.status(402).json({
          error: `可用积分不足（可用 ${available}，本次预计需要 ${lockedCredits}）`,
          estimate: estimateResult,
        });
      }
    }

    const apiKey = resolveProjectApiKey(targetProject.id);
    if (!apiKey) {
      return res.status(401).json({ error: getMissingSessionErrorMessage() });
    }

    // 1) 创建中间视频 task（标记 task_kind='audio_intermediate'，下载管理不显示）
    const createdTask = taskService.createTask({
      projectId: targetProject.id,
      userId: req.user.id,
      prompt: voicePrompt,
      model: audioCfg.model,
      ratio: audioCfg.ratio,
      duration: String(audioCfg.duration),
      resolution: audioCfg.resolution,
      status: 'generating',
      downloadStatus: 'pending',
      progress: '正在准备...',
      startedAt: new Date().toISOString(),
      taskKind: 'audio_intermediate',
    });
    dbTaskId = createdTask.id;

    // 2) 写参考图到 task_assets
    {
      const db = getDatabase();
      const originalName = referenceImageUrl.split('/').pop()?.split('?')[0] || 'reference.png';
      db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'image', '', ?, ?, 0)`)
        .run(dbTaskId, referenceImageUrl, originalName);
    }

    // 3) 锁定积分
    if (lockedCredits > 0) {
      try {
        creditLockService.lock({
          userId: req.user.id,
          taskId: dbTaskId,
          estimatedCredits: estimateResult.credits,
          lockedCredits,
          meta: { ...estimateParams, model: audioCfg.model, source: 'audio_generation' },
        });
      } catch (lockErr) {
        try { taskService.updateTaskStatus(dbTaskId, 'error', { error_message: '积分锁定失败：' + lockErr.message }); } catch {}
        return res.status(402).json({ error: '积分锁定失败：' + lockErr.message });
      }
    }

    // 4) 创建 audio_generations 元数据行
    const audioGen = audioGenerationService.createAudioGeneration({
      taskId: dbTaskId,
      userId: req.user.id,
      projectId: targetProject.id,
      referenceImageUrl,
      voicePrompt,
    });
    audioGenId = audioGen.id;
    audioGenerationService.markGenerating(audioGenId);

    // 5) 立即响应
    res.json({ success: true, data: { audioGenerationId: audioGenId, taskId: dbTaskId } });

    // 6) 异步生成
    console.log(`[音频生成] audio_gen=${audioGenId} task=${dbTaskId} 启动 seedance 调用`);
    generateSeedanceVideoCore({
      prompt: voicePrompt,
      ratio: audioCfg.ratio,
      duration: audioCfg.duration,
      resolution: audioCfg.resolution,
      files: [],
      imageUrls: [referenceAssetUri || referenceImageUrl], // 已入库素材优先用 asset:// URI 引用，避开 Ark 真人检测
      videoUrl: null,
      audioUrl: null,
      sessionId: apiKey,
      model: audioCfg.model,
      referenceMode: 'reference',
      firstFrameProvided: false,
      lastFrameProvided: false,
      onProgress: async (progress) => {
        try { taskService.updateTask(dbTaskId, { progress }); } catch {}
      },
      onSubmitId: async (submitId) => {
        try { taskService.updateTask(dbTaskId, { submit_id: submitId, submitted_at: new Date().toISOString() }); } catch {}
      },
      onHistoryId: async (historyId) => {
        try { taskService.updateTask(dbTaskId, { history_id: historyId, status: 'generating' }); } catch {}
      },
      onItemId: async (itemId) => {
        try { taskService.updateTask(dbTaskId, { item_id: itemId }); } catch {}
      },
      onVideoReady: async (videoUrl) => {
        try { taskService.updateTask(dbTaskId, { video_url: videoUrl }); } catch {}
      },
    })
      .then((result) => {
        let actualCredits = 0;
        try {
          const tokens = Number(result?.usage?.total_tokens) || Number(result?.usage?.completion_tokens) || 0;
          if (tokens > 0) {
            actualCredits = pricingService.actualCredits(audioCfg.model, tokens, estimateParams);
            creditLockService.settle({ taskId: dbTaskId, actualCredits });
          } else {
            creditLockService.release({ taskId: dbTaskId, reason: 'usage 缺失或 token=0' });
          }
        } catch (e) { console.error('[音频生成][settle] 失败:', e.message); }

        try {
          taskService.updateTaskStatus(dbTaskId, 'done', {
            submit_id: result.submitId || null,
            history_id: result.historyId || null,
            item_id: result.itemId || null,
            video_url: result.videoUrl,
            progress: '',
            error_message: null,
          });
        } catch (e) { console.error('[音频生成][task] 更新失败:', e.message); }

        try {
          audioGenerationService.markDone(audioGenId, result.videoUrl, actualCredits);
          console.log(`[音频生成] audio_gen=${audioGenId} 完成，video_url 已保存`);
        } catch (e) { console.error('[音频生成][markDone] 失败:', e.message); }
      })
      .catch((err) => {
        const errMsg = err?.message || '音频生成失败';
        try { creditLockService.release({ taskId: dbTaskId, reason: errMsg }); } catch {}
        try { usageService.logFailure({ userId: req.user.id, taskId: dbTaskId, model: audioCfg.model, errorMessage: errMsg }); } catch {}
        try { taskService.updateTaskStatus(dbTaskId, 'error', { progress: '', error_message: errMsg }); } catch {}
        try { audioGenerationService.markError(audioGenId, errMsg); } catch {}
        console.error(`[音频生成] audio_gen=${audioGenId} 失败:`, errMsg);
      });
  } catch (error) {
    console.error('[音频生成] 请求处理错误:', error.message);
    if (audioGenId) { try { audioGenerationService.markError(audioGenId, error.message); } catch {} }
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || '服务器内部错误' });
    }
  }
});

// GET /api/audio-generations/config - 当前音频生成中转视频的运行配置（普通用户可读）
app.get('/api/audio-generations/config', authenticate, (req, res) => {
  try {
    res.json({ success: true, data: getAudioGenConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/audio-generations/list - 列出当前用户音频生成记录（分页）
app.get('/api/audio-generations/list', authenticate, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize) || 20));
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const projectId = parseInt(req.query.projectId) || null;
    const result = audioGenerationService.listByUser({ userId: req.user.id, isAdmin, page, pageSize, projectId });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/audio-generations/:id - 单条详情（用于轮询状态）
app.get('/api/audio-generations/:id', authenticate, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const row = audioGenerationService.getByIdForUser(id, req.user.id, isAdmin);
    if (!row) return res.status(404).json({ error: '记录不存在' });
    // 同步附加最新 task 状态/视频 URL（done 之前 a.intermediate_video_url 可能为空）
    const db = getDatabase();
    const t = row.task_id ? db.prepare(`SELECT status, video_url, progress FROM tasks WHERE id = ?`).get(row.task_id) : null;
    res.json({ success: true, data: { ...row, task_status: t?.status || null, task_video_url: t?.video_url || null, task_progress: t?.progress || null } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 火山引擎 ARK 原生资产库查询（AK/SK 签名）
// ============================================================

function volcSign(method, host, path, query, body, accessKeyId, secretAccessKey) {
  const now = new Date();
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timestamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const service = 'ark';
  const region = 'cn-beijing';
  const credentialScope = `${datestamp}/${region}/${service}/request`;

  const sortedQuery = Object.keys(query).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`
  ).join('&');

  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  const headers = {
    'content-type': 'application/json',
    'host': host,
    'x-date': timestamp,
  };
  const signedHeaders = 'content-type;host;x-date';
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${timestamp}\n`;

  const canonicalRequest = [method, path, sortedQuery, canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const stringToSign = ['HMAC-SHA256', timestamp, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const kDate = crypto.createHmac('sha256', secretAccessKey).update(datestamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, 'x-date': timestamp };
}

/** 翻译 ARK API 常见错误信息 */
function translateArkError(msg) {
  const map = {
    'Width must be between 300px and 6000px.': '图片宽度必须在 300px 到 6000px 之间',
    'Height must be between 300px and 6000px.': '图片高度必须在 300px 到 6000px 之间',
    'Width and Height must be between 300px and 6000px.': '图片宽高必须在 300px 到 6000px 之间',
    'The asset is invalid.': '素材无效（可能是不支持的格式或损坏的文件）',
    'The asset is too small.': '素材尺寸过小',
    'The asset is too large.': '素材文件过大',
    'The asset format is not supported.': '不支持的素材格式',
    'The file format is not supported.': '不支持的文件格式',
    'Quota exceeded': 'API 配额已用尽',
    'Invalid parameter': '请求参数无效',
    'Unauthorized': '认证失败，请检查 AK/SK',
    'Forbidden': '无权限访问该资源',
    'Not Found': '资源不存在',
    'Internal Server Error': '火山引擎内部错误，请稍后重试',
    'Service Unavailable': '火山引擎服务暂时不可用',
  };
  // 精确匹配
  if (map[msg]) return map[msg];
  // 包含匹配
  for (const [en, zh] of Object.entries(map)) {
    if (msg.includes(en)) return zh;
  }
  return msg;
}

async function volcArkAssetRequest(action, body, db, keyGroupId = null) {
  let ak, sk;
  if (keyGroupId) {
    const kg = db.prepare('SELECT volc_access_key, volc_secret_key FROM volc_key_groups WHERE id = ?').get(keyGroupId);
    ak = kg?.volc_access_key;
    sk = kg?.volc_secret_key;
  }
  if (!ak) {
    const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_access_key_id'").get();
    ak = akRow?.value || process.env.VOLC_ACCESS_KEY_ID;
  }
  if (!sk) {
    const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_secret_access_key'").get();
    sk = skRow?.value || process.env.VOLC_SECRET_ACCESS_KEY;
  }
  if (!ak || !sk) throw new Error('未配置火山引擎 AK/SK（请在管理员后台设置或配置 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY 环境变量）');

  const host = 'open.volcengineapi.com';
  const urlPath = '/';
  const query = { Action: action, Version: '2024-01-01' };
  const bodyStr = body ? JSON.stringify(body) : '{}';
  const signHeaders = volcSign('POST', host, urlPath, query, bodyStr, ak, sk);
  const sortedQuery = Object.keys(query).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`
  ).join('&');

  const resp = await fetch(`https://${host}${urlPath}?${sortedQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Date': signHeaders['x-date'],
      'Authorization': signHeaders.authorization,
    },
    body: bodyStr,
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`火山API返回非JSON响应（HTTP ${resp.status}）：${text.slice(0, 200)}`);
  }
  if (!resp.ok || json.ResponseMetadata?.Error) {
    const rawMsg = json.ResponseMetadata?.Error?.Message || JSON.stringify(json);
    throw new Error(translateArkError(rawMsg));
  }
  return json.Result || json;
}

// GET /api/admin/volc-native/aksk
app.get('/api/admin/volc-native/aksk', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_access_key_id'").get();
    const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_secret_access_key'").get();
    res.json({ success: true, data: { access_key_id: akRow?.value || '', secret_access_key: skRow?.value || '' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/volc-native/aksk
app.put('/api/admin/volc-native/aksk', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { access_key_id, secret_access_key } = req.body;
    if (access_key_id) db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('volc_access_key_id', ?)").run(access_key_id);
    if (secret_access_key) db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('volc_secret_access_key', ?)").run(secret_access_key);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/volc-native/asset?id=&projectName= — 查单个 Asset
app.get('/api/admin/volc-native/asset', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { id, projectName = 'default', keyGroupId } = req.query;
    if (!id) return res.status(400).json({ error: 'id 参数必填' });
    // 若未传 keyGroupId，从 project_assets 查
    let kId = keyGroupId ? Number(keyGroupId) : null;
    if (!kId) {
      const pa = db.prepare('SELECT volc_id FROM project_assets WHERE volc_asset_id = ?').get(id);
      kId = pa?.volc_id || null;
    }
    const result = await volcArkAssetRequest('GetAsset', { Id: id, ProjectName: projectName }, db, kId);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/admin/volc-native/asset-groups?pageNumber=&pageSize=&name=&keyGroupId=
app.get('/api/admin/volc-native/asset-groups', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { pageNumber = 1, pageSize = 20, name, keyGroupId } = req.query;
    const filter = { GroupType: 'AIGC' };
    if (name) filter.Name = name;
    const result = await volcArkAssetRequest('ListAssetGroups', {
      Filter: filter,
      PageNumber: Number(pageNumber),
      PageSize: Number(pageSize),
    }, db, keyGroupId ? Number(keyGroupId) : null);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/admin/volc-native/assets?groupId=&pageNumber=&pageSize=&name=&statuses=&keyGroupId=
app.get('/api/admin/volc-native/assets', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, pageNumber = 1, pageSize = 20, name, statuses, keyGroupId } = req.query;
    const filter = { GroupType: 'AIGC' };
    if (groupId) filter.GroupIds = [groupId];
    if (name) filter.Name = name;
    if (statuses) filter.Statuses = statuses.split(',');
    // 若未传 keyGroupId，从 asset_groups 查
    let kId = keyGroupId ? Number(keyGroupId) : null;
    if (!kId && groupId) {
      const ag = db.prepare('SELECT volc_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      kId = ag?.volc_id || null;
    }
    const result = await volcArkAssetRequest('ListAssets', {
      Filter: filter,
      PageNumber: Number(pageNumber),
      PageSize: Number(pageSize),
    }, db, kId);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/admin/volc-native/asset-groups — 创建素材组
app.post('/api/admin/volc-native/asset-groups', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description = '', projectName = 'default', keyGroupId } = req.body;
    if (!name) return res.status(400).json({ error: 'name 必填' });
    const result = await volcArkAssetRequest('CreateAssetGroup', {
      Name: name, Description: description, GroupType: 'AIGC', ProjectName: projectName,
    }, db, keyGroupId ? Number(keyGroupId) : null);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/admin/volc-native/assets — 上传素材（通过 URL）
app.post('/api/admin/volc-native/assets', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, url, assetType = 'Image', name = '', projectName = 'default', keyGroupId } = req.body;
    if (!groupId || !url) return res.status(400).json({ error: 'groupId 和 url 必填' });
    // 若未传 keyGroupId，从 asset_groups 表查该组的 volc_id
    let kId = keyGroupId ? Number(keyGroupId) : null;
    if (!kId) {
      const ag = db.prepare('SELECT volc_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      kId = ag?.volc_id || null;
    }
    const result = await volcArkAssetRequest('CreateAsset', {
      GroupId: groupId, URL: url, AssetType: assetType, Name: name, ProjectName: projectName,
    }, db, kId);
    // 写入本地 project_assets 表，便于后续按 volc_id 查询
    if (result?.Id && kId) {
      const ag = db.prepare('SELECT project_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      db.prepare(`
        INSERT OR REPLACE INTO project_assets (project_id, asset_group_id, volc_asset_id, volc_id, name, file_type, file_url, status, updated_at)
        VALUES (?, (SELECT id FROM asset_groups WHERE volc_group_id = ?), ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      `).run(ag?.project_id || null, groupId, result.Id, kId, name, assetType === 'Video' ? 'video' : 'image', url);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/admin/volc-native/assets/:id
app.delete('/api/admin/volc-native/assets/:id', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { projectName = 'default', keyGroupId } = req.body || {};
    const result = await volcArkAssetRequest('DeleteAsset', { Id: req.params.id, ProjectName: projectName }, db, keyGroupId ? Number(keyGroupId) : null);
    // 同步删除本地记录
    db.prepare("UPDATE project_assets SET status = 'deleted' WHERE volc_asset_id = ?").run(req.params.id);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/admin/volc-native/asset-groups/get — GetAssetGroup
app.post('/api/admin/volc-native/asset-groups/get', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { id, projectName = 'default', keyGroupId } = req.body;
    if (!id) return res.status(400).json({ error: 'id 必填' });
    const result = await volcArkAssetRequest('GetAssetGroup', { Id: id, ProjectName: projectName }, db, keyGroupId ? Number(keyGroupId) : null);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PUT /api/admin/volc-native/asset-groups/:id — UpdateAssetGroup
app.put('/api/admin/volc-native/asset-groups/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description, projectName = 'default', keyGroupId } = req.body;
    const groupId = req.params.id;

    // 先写入本地数据库（admin 端点不查重，直接写）
    if (name !== undefined || description !== undefined) {
      const updates = [];
      const values = [];
      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }
      if (updates.length > 0) {
        values.push(groupId);
        db.prepare(`UPDATE asset_groups SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE volc_group_id = ?`).run(...values);
      }
    }

    // 再尝试同步 ARK
    const body = { Id: groupId, ProjectName: projectName };
    if (name !== undefined) body.Name = name;
    if (description !== undefined) body.Description = description;
    const result = await volcArkAssetRequest('UpdateAssetGroup', body, db, keyGroupId ? Number(keyGroupId) : null);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PUT /api/volc-native/asset-groups/:id — UpdateAssetGroup（普通用户，本地查重）
app.put('/api/volc-native/asset-groups/:id', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description, projectId, projectName = 'default' } = req.body;
    const groupId = req.params.id;
    if (!projectId) return res.status(400).json({ error: 'projectId 必填' });

    // 查本地记录
    const local = db.prepare('SELECT id, project_id, name AS current_name FROM asset_groups WHERE volc_group_id = ?').get(groupId);
    let finalName = (name ?? local?.current_name ?? '').trim();
    let suggested = false;

    // 查重：全局不能重名，重名时循环加 (N) 直到不重
    if (finalName && local) {
      const checkStmt = db.prepare(
        'SELECT COUNT(*) AS c FROM asset_groups WHERE name = ? AND id != ?'
      );
      let candidate = finalName;
      while (checkStmt.get(candidate, local.id).c > 0) {
        // 已有 "name (2)" 形式 → 递增数字；否则从 2 开始
        const m = candidate.match(/^(.*) \((\d+)\)$/);
        if (m) {
          candidate = `${m[1]} (${parseInt(m[2]) + 1})`;
        } else {
          candidate = `${candidate} (2)`;
        }
        suggested = true;
      }
      if (suggested) finalName = candidate;
    }

    // 写入本地数据库
    if (local && (finalName !== undefined || description !== undefined)) {
      const updates = [];
      const values = [];
      if (finalName !== undefined) { updates.push('name = ?'); values.push(finalName); }
      if (description !== undefined) { updates.push('description = ?'); values.push(description); }
      if (updates.length > 0) {
        values.push(groupId);
        db.prepare(`UPDATE asset_groups SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE volc_group_id = ?`).run(...values);
      }
    }

    // 同步 ARK
    const body = { Id: groupId, ProjectName: projectName };
    if (finalName !== undefined) body.Name = finalName;
    if (description !== undefined) body.Description = description;
    const keyGroupId = db.prepare('SELECT volc_id FROM projects WHERE id = ?').get(projectId)?.volc_id || null;
    const result = await volcArkAssetRequest('UpdateAssetGroup', body, db, keyGroupId);
    res.json({ success: true, data: { ...result, finalName, suggested } });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/admin/volc-native/asset-groups/:id — DeleteAssetGroup
app.delete('/api/admin/volc-native/asset-groups/:id', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { projectName = 'default', keyGroupId } = req.body || {};
    const result = await volcArkAssetRequest('DeleteAssetGroup', { Id: req.params.id, ProjectName: projectName }, db, keyGroupId ? Number(keyGroupId) : null);
    // 先删除关联素材，再删素材组（FK ON DELETE SET NULL）
    const ag = db.prepare('SELECT id FROM asset_groups WHERE volc_group_id = ?').get(req.params.id);
    if (ag) {
      db.prepare('DELETE FROM project_assets WHERE asset_group_id = ?').run(ag.id);
    }
    db.prepare('DELETE FROM asset_groups WHERE volc_group_id = ?').run(req.params.id);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PUT /api/admin/volc-native/assets/:id — UpdateAsset
app.put('/api/admin/volc-native/assets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, projectName = 'default', keyGroupId } = req.body;
    const assetId = req.params.id;

    // 先写入本地数据库
    if (name !== undefined) {
      db.prepare('UPDATE project_assets SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE volc_asset_id = ?').run(name, assetId);
    }

    // 再尝试同步 ARK
    const body = { Id: assetId, ProjectName: projectName };
    if (name !== undefined) body.Name = name;
    const result = await volcArkAssetRequest('UpdateAsset', body, db, keyGroupId ? Number(keyGroupId) : null);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PUT /api/volc-native/assets/:id — UpdateAsset（普通用户，先写本地再同步 OSS）
app.put('/api/volc-native/assets/:id', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, projectName = 'default' } = req.body;
    const assetId = req.params.id;

    // 先写入本地数据库；无记录时 INSERT 一条
    if (name !== undefined) {
      const r = db.prepare('UPDATE project_assets SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE volc_asset_id = ?').run(name, assetId);
      if (r.changes === 0) {
        db.prepare(
          'INSERT OR IGNORE INTO project_assets (volc_asset_id, name, file_type, file_url, status, updated_at) VALUES (?, ?, \'image\', \'\', \'active\', CURRENT_TIMESTAMP)'
        ).run(assetId, name);
      }
    }

    // 查该素材所属的 volc_id
    const pa = db.prepare('SELECT volc_id FROM project_assets WHERE volc_asset_id = ?').get(assetId);
    const keyGroupId = pa?.volc_id || null;

    // 同步 ARK
    const body = { Id: assetId, ProjectName: projectName };
    if (name !== undefined) body.Name = name;
    const result = await volcArkAssetRequest('UpdateAsset', body, db, keyGroupId);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── 项目组资产库（普通用户可访问）──
// GET /api/volc-native/asset-groups
// projectId 参数：仅返回该项目绑定的素材组（隔离项目组）；不传 + 管理员则返回全部
app.get('/api/volc-native/asset-groups', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { pageNumber = 1, pageSize = 20, name, projectId, sync } = req.query;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

    // 项目隔离：projectId 提供时严格过滤为该项目绑定的素材组
    if (projectId) {
      const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
      if (!project) return res.status(404).json({ error: '项目不存在或无权访问' });
      // 单账户模式：激活 Key id=1 时 null 视为 1；其它 id 只精确匹配，null 不再视为该 id
      let assetGroupQuery = 'SELECT id, volc_group_id, name, description, volc_id, thumbnail_oss_url FROM asset_groups WHERE project_id = ?';
      const assetGroupParams = [projectId];
      if (!isMultiAccountEnabled()) {
        const active = db.prepare('SELECT id FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
        if (active) {
          assetGroupQuery += ' AND (volc_id = ? OR (? = 1 AND volc_id IS NULL))';
          assetGroupParams.push(active.id, active.id);
        }
      }
      // name 过滤
      if (name) {
        assetGroupQuery += ' AND name LIKE ?';
        assetGroupParams.push(`%${name}%`);
      }
      // 先查总数
      const total = db.prepare(assetGroupQuery.replace('SELECT id, volc_group_id, name, volc_id, thumbnail_oss_url', 'SELECT COUNT(*) AS c')).get(...assetGroupParams).c;
      // 分页
      const offset = (Number(pageNumber) - 1) * Number(pageSize);
      assetGroupQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      assetGroupParams.push(Number(pageSize), offset);
      const boundRows = db.prepare(assetGroupQuery).all(...assetGroupParams);
      // 本地 volc_group_id → 我们落库时已去重过的 name
      const localNameByVolcId = new Map(boundRows.map((r) => [r.volc_group_id, r.name]));
      // 按 volc_group_id → thumbnail_oss_url 映射（OSS永久URL）
      const thumbOssByVolcId = new Map(boundRows.map((r) => [r.volc_group_id, r.thumbnail_oss_url]));
      // 按 volc_group_id → volc_id 映射，用于查询时指定 keyGroupId
      const keyGroupByVolcId = new Map(boundRows.map((r) => [r.volc_group_id, r.volc_id]).filter(([, vid]) => vid != null));
      const volcGroupIds = boundRows.map(r => r.volc_group_id).filter(Boolean);

      // sync=1 时同步 project_assets（刷新按钮触发）
      if (sync === '1' && volcGroupIds.length > 0) {
        try {
          await assetService.syncProjectAssetsFromVolc(projectId, project.volc_id || null, boundRows, db, volcArkAssetRequest);
        } catch(e) { console.warn('[asset-groups] sync failed:', e.message); }
      }

      // 非 sync 模式：直接从本地 DB 构建响应，不调 ARK
      const items = boundRows.map(r => ({
        Id: r.volc_group_id,
        Name: r.name,
        Description: r.description || '',
        _localId: r.id,
        thumbnail_oss_url: r.thumbnail_oss_url || null,
      }));

      // 有文件夹但无素材时，自动触发一次同步
      if (items.length > 0) {
        const assetCount = db.prepare(
          `SELECT COUNT(*) AS c FROM project_assets WHERE project_id = ? AND asset_group_id IS NOT NULL AND status != 'deleted'`
        ).get(projectId).c;
        if (assetCount === 0) {
          setImmediate(() => {
            assetService.syncProjectAssetsFromVolc(projectId, project.volc_id || null, boundRows, db, volcArkAssetRequest).catch(() => {});
          });
        }
      }

      return res.json({ success: true, data: { Items: items, TotalCount: total } });
    }

    // 无 projectId：仅管理员可见全量
    if (!isAdmin) return res.status(403).json({ error: '需要 projectId 或管理员权限' });

    const filter = { GroupType: 'AIGC' };
    if (name) filter.Name = name;
    const result = await volcArkAssetRequest('ListAssetGroups', {
      Filter: filter, PageNumber: Number(pageNumber), PageSize: Number(pageSize),
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/volc-native/assets — 默认从本地 DB 读取，sync=1 才调 ARK
app.get('/api/volc-native/assets', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, pageNumber = 1, pageSize = 20, name, sync } = req.query;

    // sync=1 时才调 ARK
    if (sync === '1' && groupId) {
      const filter = { GroupType: 'AIGC' };
      filter.GroupIds = [groupId];
      if (name) filter.Name = name;
      let kId = null;
      const ag = db.prepare('SELECT volc_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      kId = ag?.volc_id || null;
      const result = await volcArkAssetRequest('ListAssets', {
        Filter: filter, PageNumber: Number(pageNumber), PageSize: Number(pageSize),
      }, db, kId);
      return res.json({ success: true, data: result });
    }

    // 默认：从本地 project_assets 读
    if (!groupId) return res.json({ success: true, data: { Items: [], TotalCount: 0 } });
    const ag = db.prepare('SELECT id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
    const agId = ag?.id;
    if (!agId) return res.json({ success: true, data: { Items: [], TotalCount: 0 } });
    const offset = (Number(pageNumber) - 1) * Number(pageSize);
    const total = db.prepare(
      'SELECT COUNT(*) AS c FROM project_assets WHERE asset_group_id = ? AND status != \'deleted\''
    ).get(agId).c;
    const rows = db.prepare(
      'SELECT * FROM project_assets WHERE asset_group_id = ? AND status != \'deleted\' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(agId, Number(pageSize), offset);
    const items = rows.map(r => ({
      Id: r.volc_asset_id,
      Name: r.name,
      GroupId: groupId,
      AssetType: r.file_type === 'video' ? 'Video' : r.file_type === 'audio' ? 'Audio' : 'Image',
      Status: r.review_status === 'approved' ? 'Active' : r.review_status === 'rejected' ? 'Failed' : 'Pending',
      URL: r.file_url,
      ThumbnailURL: r.thumbnail_url,
      CreateTime: r.created_at,
      UpdateTime: r.updated_at,
    }));
    return res.json({ success: true, data: { Items: items, TotalCount: total } });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/volc-native/asset?id= — 从本地 DB 读取（不走 ARK）
app.get('/api/volc-native/asset', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id 必填' });
    const r = db.prepare('SELECT * FROM project_assets WHERE volc_asset_id = ?').get(id);
    if (!r) return res.status(404).json({ error: '素材不存在' });
    res.json({ success: true, data: {
      Id: r.volc_asset_id,
      Name: r.name,
      AssetType: r.file_type === 'video' ? 'Video' : r.file_type === 'audio' ? 'Audio' : 'Image',
      Status: r.review_status === 'approved' ? 'Active' : r.review_status === 'rejected' ? 'Failed' : 'Pending',
      URL: r.file_url,
      ThumbnailURL: r.thumbnail_url,
      CreateTime: r.created_at,
      UpdateTime: r.updated_at,
    }});
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/volc-native/asset-groups/check-name?name=&projectId= — 查重接口
// 返回 { exists, suggestedName } —— 名字已存在时给出 `name (N)` 形态的建议名
app.get('/api/volc-native/asset-groups/check-name', authenticate, (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const projectId = Number(req.query.projectId);
    if (!name) return res.status(400).json({ error: 'name 必填' });
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'projectId 必填' });
    }
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
    if (!project) return res.status(404).json({ error: '项目组不存在或无权访问' });
    const suggestedName = assetService.resolveUniqueAssetGroupName(projectId, name);
    res.json({ success: true, data: { exists: suggestedName !== name, suggestedName } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/volc-native/asset-groups — CreateAssetGroup（普通用户）
// 必须传 projectId，创建后会自动绑定到该项目（写入 asset_groups 表）
app.post('/api/volc-native/asset-groups', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description = '', projectName = 'default', projectId, thumbnail_oss_url } = req.body;
    if (!name) return res.status(400).json({ error: 'name 必填' });
    if (!projectId) return res.status(400).json({ error: 'projectId 必填（素材组必须绑定到一个项目组）' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
    if (!project) return res.status(404).json({ error: '项目组不存在或无权访问' });

    const displayName = String(name).trim();
    const keyGroupId = project.volc_id || null;

    const result = await volcArkAssetRequest('CreateAssetGroup', {
      Name: displayName, Description: description, GroupType: 'AIGC', ProjectName: projectName,
    }, db, keyGroupId);

    const volcGroupId = result?.Id;
    if (!volcGroupId) {
      return res.status(502).json({ error: 'ARK 创建素材组失败，未返回 ID' });
    }

    // 用 volc_group_id 尾段 UUID 保证唯一（如 group-...-z2sls → z2sls）
    const uuidSuffix = volcGroupId.split('-').pop();
    const storedName = displayName + '-' + uuidSuffix;

    try {
      db.prepare('INSERT INTO asset_groups (project_id, volc_group_id, name, volc_id, thumbnail_oss_url, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(projectId, volcGroupId, storedName, keyGroupId, thumbnail_oss_url || null);
    } catch (insertErr) {
      if (insertErr.message?.includes('UNIQUE')) {
        console.warn('[asset-groups] 重复 volc_group_id 插入（忽略）:', volcGroupId);
      } else {
        console.error('[asset-groups] INSERT 失败:', insertErr.message, 'volc_group_id:', volcGroupId);
        return res.status(500).json({ error: '本地保存失败' });
      }
    }

    res.json({ success: true, data: { ...result, storedName } });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PATCH /api/volc-native/asset-groups/:volcGroupId/rename — 重命名素材组（本地权威，火山不同步）
// 入参: { name, projectId }；新名若撞名，自动加 (N) 后缀
app.patch('/api/volc-native/asset-groups/:volcGroupId/rename', authenticate, (req, res) => {
  try {
    const volcGroupId = req.params.volcGroupId;
    const projectId = Number(req.body?.projectId);
    const rawName = String(req.body?.name || '').trim();
    if (!volcGroupId) return res.status(400).json({ error: 'volcGroupId 必填' });
    if (!rawName) return res.status(400).json({ error: 'name 必填' });
    if (!Number.isFinite(projectId) || projectId <= 0) return res.status(400).json({ error: 'projectId 必填' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
    if (!project) return res.status(404).json({ error: '项目组不存在或无权访问' });

    const db = getDatabase();
    const row = db.prepare(
      'SELECT id, name FROM asset_groups WHERE project_id = ? AND volc_group_id = ?'
    ).get(projectId, volcGroupId);
    if (!row) return res.status(404).json({ error: '该素材组未绑定到此项目组' });

    // 自身名不变直接返回
    if (row.name === rawName) {
      return res.json({ success: true, data: { name: row.name, suggested: false } });
    }

    // 同项目内查重，撞名加 (N) 后缀；excludeId 排除自己
    const finalName = assetService.resolveUniqueAssetGroupName(projectId, rawName, row.id);
    db.prepare(
      `UPDATE asset_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(finalName, row.id);

    res.json({ success: true, data: { name: finalName, suggested: finalName !== rawName } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/volc-native/assets — CreateAsset（普通用户）
app.post('/api/volc-native/assets', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, url, assetType = 'Image', name = '', projectName = 'default', keyGroupId } = req.body;
    if (!groupId || !url) return res.status(400).json({ error: 'groupId 和 url 必填' });
    // 若未传 keyGroupId，从 asset_groups 表查该组的 volc_id
    let kId = keyGroupId ? Number(keyGroupId) : null;
    if (!kId) {
      const ag = db.prepare('SELECT volc_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      kId = ag?.volc_id || null;
    }
    const result = await volcArkAssetRequest('CreateAsset', {
      GroupId: groupId, URL: url, AssetType: assetType, Name: name, ProjectName: projectName,
    }, db, kId);
    // 写入本地 project_assets 表，便于后续按 volc_id 查询
    if (result?.Id && kId) {
      const ag = db.prepare('SELECT project_id FROM asset_groups WHERE volc_group_id = ?').get(groupId);
      db.prepare(`
        INSERT OR REPLACE INTO project_assets (project_id, asset_group_id, volc_asset_id, volc_id, name, file_type, file_url, status, updated_at)
        VALUES (?, (SELECT id FROM asset_groups WHERE volc_group_id = ?), ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      `).run(ag?.project_id || null, groupId, result.Id, kId, name, assetType === 'Video' ? 'video' : 'image', url);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/pricing/estimate - 提交前实时估算积分
app.post('/api/pricing/estimate', authenticate, (req, res) => {
  try {
    const { model, ...params } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model 必填' });
    const result = pricingService.estimate(model, {
      inputDurationSec: Number(params.inputDurationSec) || 0,
      outputDurationSec: Number(params.outputDurationSec) || Number(params.duration) || 5,
      resolution: params.resolution || '720p',
      ratio: params.ratio || '16:9',
      hasVideoInput: !!params.hasVideoInput,
      hasAudio: !!params.hasAudio,
      isDraft: !!params.isDraft,
      fps: params.fps,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/credits/balance - 当前积分余额（含锁定明细）
app.get('/api/credits/balance', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const locked = creditLockService.getLockedTotal(req.user.id);
    const available = user.unlimited_credits ? Infinity : Math.max(0, user.credits - locked);
    res.json({
      success: true,
      data: {
        credits: user.credits,
        unlimited: !!user.unlimited_credits,
        locked,
        available: Number.isFinite(available) ? available : -1,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/credits/locks - 当前用户的活跃锁定列表
app.get('/api/credits/locks', authenticate, (req, res) => {
  try {
    const onlyActive = req.query.onlyActive !== 'false';
    res.json({ success: true, data: creditLockService.listUserLocks(req.user.id, { onlyActive }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 项目成员管理
// ============================================================

// GET /api/projects/:id/members - 获取项目成员列表
app.get('/api/projects/:id/members', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const projectId = req.params.id;
    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const members = db.prepare(`
      SELECT pm.*, u.email, u.role as user_role
      FROM project_members pm
      JOIN users u ON pm.user_id = u.id
      WHERE pm.project_id = ?
      ORDER BY pm.role ASC, pm.created_at ASC
    `).all(projectId);
    res.json({ success: true, data: members });
  } catch (error) {
    console.error('[project-members] 获取成员失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:id/members - 邀请成员
app.post('/api/projects/:id/members', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const projectId = req.params.id;
    const { email, role = 'member' } = req.body;
    if (!email) return res.status(400).json({ error: '邮箱不能为空' });

    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const invitedUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!invitedUser) return res.status(404).json({ error: '用户不存在' });

    db.prepare(`
      INSERT OR IGNORE INTO project_members (project_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?)
    `).run(projectId, invitedUser.id, role, req.user.id);

    res.json({ success: true });
  } catch (error) {
    console.error('[project-members] 邀请成员失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/projects/:id/members/:userId - 移除成员
app.delete('/api/projects/:id/members/:userId', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { id: projectId, userId } = req.params;
    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const target = db.prepare(
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
    ).get(projectId, userId);
    if (!target) return res.status(404).json({ error: '成员不存在' });
    if (target.role === 'owner') {
      return res.status(400).json({ error: '不能移除项目组所有者' });
    }

    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    res.json({ success: true });
  } catch (error) {
    console.error('[project-members] 移除成员失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 项目资产库
// ============================================================

// GET /api/projects/:id/asset-groups - 获取项目素材组列表（含缩略图）
app.get('/api/projects/:id/asset-groups', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const db = getDatabase();
    // 单账户时用激活 Key 组 id 过滤，多账户时用 project.volc_id；null 永远等价于 1
    let targetVolcId;
    if (!isMultiAccountEnabled()) {
      const active = db.prepare('SELECT id FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
      targetVolcId = active?.id ?? null;
    } else {
      targetVolcId = project.volc_id ?? null;
    }
    let volcFilter = '';
    const volcParams = [projectId];
    if (targetVolcId != null) {
      if (targetVolcId === 1) {
        volcFilter = 'AND (ag.volc_id IS NULL OR ag.volc_id = 1)';
      } else {
        volcFilter = 'AND (ag.volc_id = ?)';
        volcParams.push(targetVolcId);
      }
    }
    const groups = db.prepare(`
      SELECT ag.*,
        (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_group_id = ag.id AND pa.review_status != 'rejected' AND pa.status = 'active' AND pa.file_url IS NOT NULL) AS asset_count,
        (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_group_id = ag.id AND pa.review_status = 'pending' AND pa.status = 'active') AS pending_count,
        (SELECT COALESCE(
           CASE WHEN pa.thumbnail_url LIKE '%aliyuncs.com%' THEN pa.thumbnail_url END,
           pa.thumbnail_url, pa.file_url) FROM project_assets pa
         WHERE pa.asset_group_id = ag.id AND pa.review_status != 'rejected' AND pa.status = 'active'
         AND (pa.file_url IS NOT NULL OR pa.thumbnail_url IS NOT NULL)
         ORDER BY pa.created_at DESC LIMIT 1) AS preview_url
      FROM asset_groups ag
      WHERE ag.project_id = ? ${volcFilter}
      ORDER BY ag.created_at DESC
    `).all(...volcParams);

    // 有文件夹但无关联素材时，等待同步完成，再重新查询确保返回最新数据
    const totalAssetCount = groups.reduce((s, g) => s + (g.asset_count || 0), 0);
    if (groups.length > 0 && totalAssetCount === 0) {
      const volcGroupIds = groups.map(g => g.volc_group_id).filter(Boolean);
      if (volcGroupIds.length > 0) {
        try {
          await assetService.syncProjectAssetsFromVolc(projectId, project.volc_id || null, groups, db, volcArkAssetRequest);
          // 同步完成后重新查询，确保 asset_count / preview_url 反映最新数据
          const fresh = db.prepare(`
            SELECT ag.*,
              (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_group_id = ag.id AND pa.review_status != 'rejected' AND pa.status = 'active' AND pa.file_url IS NOT NULL) AS asset_count,
              (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_group_id = ag.id AND pa.review_status = 'pending' AND pa.status = 'active') AS pending_count,
              (SELECT COALESCE(
                 CASE WHEN pa.thumbnail_url LIKE '%aliyuncs.com%' THEN pa.thumbnail_url END,
                 pa.thumbnail_url, pa.file_url) FROM project_assets pa
               WHERE pa.asset_group_id = ag.id AND pa.review_status != 'rejected' AND pa.status = 'active'
               AND (pa.file_url IS NOT NULL OR pa.thumbnail_url IS NOT NULL)
               ORDER BY pa.created_at DESC LIMIT 1) AS preview_url
            FROM asset_groups ag
            WHERE ag.project_id = ? ${volcFilter}
            ORDER BY ag.created_at DESC
          `).all(...volcParams);
          // 用最新结果覆盖旧 groups
          groups.length = 0;
          groups.push(...fresh);
        } catch(e) { console.warn('[project-asset-groups] auto-sync failed:', e.message); }
      }
    }

    // 后台将非 OSS 缩略图转存到 OSS（非阻塞）
    refreshAssetThumbnailsToOss(projectId).catch(e =>
      console.warn('[project-asset-groups] 后台缩略图刷新失败:', e.message)
    );

    // 统计还有多少缩略图需迁移，前端据此决定是否稍后刷新
    const { thumbPending } = db.prepare(`
      SELECT COUNT(*) AS thumbPending FROM project_assets pa
      WHERE pa.project_id = ? AND pa.status != 'deleted'
        AND pa.volc_asset_id IS NOT NULL
        AND (pa.thumbnail_url IS NULL OR pa.thumbnail_url NOT LIKE '%aliyuncs.com%')
    `).get(projectId);

    res.json({ success: true, data: groups, thumbnailsPending: thumbPending || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 防止同一项目重复触发缩略图刷新
const _thumbRefreshInFlight = new Set();

// 将非 OSS 缩略图从火山引擎下载并转存到 OSS，防止 12h 过期
async function refreshAssetThumbnailsToOss(projectId) {
  if (_thumbRefreshInFlight.has(projectId)) return;
  _thumbRefreshInFlight.add(projectId);
  try {
    const db = getDatabase();
    const assets = db.prepare(`
      SELECT pa.*, ag.volc_id
      FROM project_assets pa
      LEFT JOIN asset_groups ag ON pa.asset_group_id = ag.id
      WHERE pa.project_id = ?
        AND pa.volc_asset_id IS NOT NULL
        AND pa.status != 'deleted'
        AND (pa.thumbnail_url IS NULL OR pa.thumbnail_url NOT LIKE '%aliyuncs.com%')
    `).all(projectId);

    if (assets.length === 0) return;

    console.log(`[assets] 后台刷新 ${assets.length} 个非 OSS 缩略图...`);
    for (const asset of assets) {
      try {
        const volcId = asset.volc_id || undefined;
        const volcAsset = await assetService.getAsset(asset.volc_asset_id, undefined, volcId);
        const freshUrl = volcAsset?.URL || volcAsset?.Url || volcAsset?.url;
        if (!freshUrl) continue;

        // 下载火山图片
        const imageResp = await fetch(freshUrl);
        if (!imageResp.ok) continue;
        const buffer = Buffer.from(await imageResp.arrayBuffer());

        // 上传到 OSS
        const client = createOssClient();
        const ossKey = `seedance/thumbnails/${asset.project_id}/${asset.volc_asset_id}.jpg`;
        await client.put(ossKey, buffer, { mime: 'image/jpeg' });
        const ossUrl = `${OSS_URL_PREFIX}${ossKey}`;

        // 更新 DB：file_url 存火山地址（参考），thumbnail_url 存 OSS 永久地址
        db.prepare(`
          UPDATE project_assets
          SET thumbnail_url = ?, file_url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(ossUrl, freshUrl, asset.id);

        console.log(`[assets] 缩略图→OSS: ${asset.volc_asset_id}`);
      } catch (e) {
        // 火山侧已删除的素材直接跳过
        if (e.message && e.message.includes('not found')) {
          console.warn(`[assets] 素材已从火山删除，跳过: ${asset.volc_asset_id}`);
        } else {
          console.warn(`[assets] 缩略图转存失败 ${asset.volc_asset_id}:`, e.message);
        }
      }
    }
  } finally {
    _thumbRefreshInFlight.delete(projectId);
  }
}

// GET /api/projects/:id/assets - 获取项目资产列表（火山为真值实时过滤）
app.get('/api/projects/:id/assets', authenticate, async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const { page = 1, pageSize = 20, status, autoInject, skipLive } = req.query;
    const result = skipLive === 'true'
      ? assetService.listProjectAssets(projectId, { page: parseInt(page), pageSize: parseInt(pageSize), status, autoInject: autoInject !== undefined ? autoInject === 'true' : undefined })
      : await assetService.listProjectAssetsLive(projectId, {
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      status,
      autoInject: autoInject !== undefined ? autoInject === 'true' : undefined,
    });
    // 后台将非 OSS 缩略图转存到 OSS（非阻塞）
    refreshAssetThumbnailsToOss(projectId).catch(e =>
      console.warn('[assets] 后台缩略图刷新失败:', e.message)
    );

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[assets] 获取资产列表失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:id/assets - 上传素材到项目资产库
const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/projects/:id/assets', authenticate, assetUpload.single('file'), async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = projectService.getProjectById(projectId, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    let volcAssetId = null;
    const keyGroupId = project.volc_id || null;
    let fileUrl = null;
    let thumbnailUrl = null;

    // 获取或创建资产组
    let assetGroup = assetService.getOrCreateProjectAssetGroup(projectId);
    let volcGroupId = assetGroup?.volc_group_id;

    if (!volcGroupId) {
      try {
        const groupResult = await assetService.createAssetGroup({ name: `project-${projectId}-${project.name}` }, keyGroupId);
        volcGroupId = groupResult.GroupId || groupResult.group_id;
        assetGroup = assetService.saveAssetGroup(projectId, volcGroupId, `project-${projectId}`, keyGroupId);
        console.log(`[assets] 创建火山引擎资产组: ${volcGroupId}`);
      } catch (err) {
        console.error('[assets] 创建资产组失败:', err.message, err.stack);
        // 继续，资产组创建失败时仍保存到本地 DB
      }
    }

    const rawName = req.file?.originalname || req.body.name || 'asset';
    // multer encodes originalname as latin1; decode back to utf-8
    const decodedRawName = req.file?.originalname
      ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
      : (req.body.name || 'asset');
    // name = 用户可见别名（用户输入或上传时原文件名）
    const name = (req.body.alias || req.body.name || decodedRawName).trim() || '未命名';
    // original_name = 系统标准化名（YYYYMMDD_<rand>_<safeBase>.<ext>），用于火山上传 fileName
    const originalName = assetService.generateOriginalName(decodedRawName);
    const fileType = req.body.fileType || (req.file?.mimetype?.startsWith('video/') ? 'video' : req.file?.mimetype?.startsWith('audio/') ? 'audio' : 'image');

    if (req.file) {
      // ARK API 不支持 Base64 直传；先上传到 OSS，再通过 URL 导入 ARK
      try {
        const ossClient = createOssClient();
        const ossKey = buildOssKey(originalName, fileType);
        await ossClient.put(ossKey, req.file.buffer);
        fileUrl = `${OSS_URL_PREFIX}${ossKey}`;
        thumbnailUrl = fileType === 'image' ? fileUrl : null;
        console.log(`[assets] 已上传 OSS: ${fileUrl}`);
        // 记录上传映射到 uploads 表
        try {
          const db = getDatabase();
          db.prepare(`INSERT INTO uploads (user_id, original_name, oss_key, oss_url, media_type, file_size)
                      VALUES (?, ?, ?, ?, ?, ?)`).run(
            req.user.id, decodedRawName, ossKey, fileUrl, fileType, req.file.size
          );
        } catch (e) {
          console.warn('[assets] uploads 记录失败:', e.message);
        }
        try {
          const assetTypeMap = { image: 'Image', video: 'Video', audio: 'Audio' };
          const uploadResult = await assetService.uploadAssetByUrl({
            url: fileUrl,
            assetType: assetTypeMap[fileType] || 'Image',
            groupId: volcGroupId,
            name: originalName,
          }, keyGroupId);
          volcAssetId = uploadResult.Id || uploadResult.AssetId || uploadResult.asset_id;
          fileUrl = uploadResult.URL || uploadResult.Url || uploadResult.url || fileUrl;
          thumbnailUrl = uploadResult.ThumbnailURL || uploadResult.ThumbnailUrl || thumbnailUrl;
          console.log(`[assets] ARK 导入成功: assetId=${volcAssetId}`);
        } catch (arkErr) {
          console.error('[assets] ARK 导入失败（已保存 OSS URL）:', arkErr.message);
          // 仍保存本地记录，但返回警告让前端提示用户
          const asset = assetService.saveProjectAsset({
            projectId,
            assetGroupId: assetGroup?.id,
            volcAssetId: null,
            name,
            originalName,
            fileType,
            fileSize: req.file?.size || 0,
            fileUrl,
            thumbnailUrl,
            uploadedBy: req.user.id,
          });
          return res.status(201).json({
            success: true,
            data: asset,
            warning: `ARK 导入失败：${arkErr.message}。素材已保存到项目，但可能无法用于生成。`,
          });
        }
      } catch (ossErr) {
        console.error('[assets] OSS 上传失败，回退本地:', ossErr.message);
        try {
          const localUploadsPath = path.join(__dirname, 'data', 'uploads');
          if (!fs.existsSync(localUploadsPath)) fs.mkdirSync(localUploadsPath, { recursive: true });
          fs.writeFileSync(path.join(localUploadsPath, originalName), req.file.buffer);
          fileUrl = `/uploads/${originalName}`;
          thumbnailUrl = fileType === 'image' ? fileUrl : null;
          console.log(`[assets] 已保存到本地: ${fileUrl}`);
        } catch (saveErr) {
          console.error('[assets] 本地保存失败:', saveErr.message);
        }
      }
    } else if (req.body.url) {
      try {
        const assetTypeMap = { image: 'Image', video: 'Video', audio: 'Audio' };
        const uploadResult = await assetService.uploadAssetByUrl({
          url: req.body.url,
          assetType: assetTypeMap[fileType] || 'Image',
          groupId: volcGroupId,
          name: originalName,
        }, keyGroupId);
        volcAssetId = uploadResult.Id || uploadResult.AssetId || uploadResult.asset_id;
        fileUrl = uploadResult.URL || uploadResult.Url || uploadResult.url || req.body.url;
        thumbnailUrl = uploadResult.ThumbnailURL || uploadResult.ThumbnailUrl;
      } catch (volcErr) {
        console.error('[assets] 通过 URL 上传 ARK 失败:', volcErr.message);
        fileUrl = req.body.url;
        // 保存本地记录，返回警告
        const asset = assetService.saveProjectAsset({
          projectId,
          assetGroupId: assetGroup?.id,
          volcAssetId: null,
          name,
          originalName,
          fileType,
          fileSize: 0,
          fileUrl,
          thumbnailUrl: null,
          uploadedBy: req.user.id,
        });
        return res.status(201).json({
          success: true,
          data: asset,
          warning: `ARK 导入失败：${volcErr.message}。素材已保存到项目，但可能无法用于生成。`,
        });
      }
    }

    if (!volcAssetId && !fileUrl) {
      return res.status(502).json({ error: '上传到火山引擎失败，请检查 ACCESS KEY / 资产组配置后重试' });
    }

    const asset = assetService.saveProjectAsset({
      projectId,
      assetGroupId: assetGroup?.id,
      volcAssetId,
      name,
      originalName,
      fileType,
      fileSize: req.file?.size || 0,
      fileUrl: fileUrl || req.body.url || null,
      thumbnailUrl,
      uploadedBy: req.user.id,
    });

    res.json({ success: true, data: asset });
  } catch (error) {
    console.error('[assets] 上传失败:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/projects/:id/assets/:assetId - 更新素材名称和简介
app.put('/api/projects/:id/assets/:assetId', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const projectId = Number(req.params.id);
    const assetId = Number(req.params.assetId);
    const { name, description } = req.body;

    const asset = db.prepare('SELECT * FROM project_assets WHERE id = ? AND project_id = ?').get(assetId, projectId);
    if (!asset) return res.status(404).json({ error: '素材不存在' });

    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (updates.length === 0) return res.json({ success: true, data: asset });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(assetId);
    db.prepare(`UPDATE project_assets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const updated = db.prepare('SELECT * FROM project_assets WHERE id = ?').get(assetId);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/projects/:id/assets/:assetId/review - 管理员手动审核（保留兼容，一般不用）
app.put('/api/projects/:id/assets/:assetId/review', authenticate, (req, res) => {
  try {
    const { reviewStatus } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(reviewStatus)) {
      return res.status(400).json({ error: '审核状态无效' });
    }
    assetService.updateProjectAssetReview(req.params.assetId, reviewStatus);
    res.json({ success: true });
  } catch (error) {
    console.error('[assets] 审核失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:id/assets/:assetId/sync-review - 从火山引擎同步单个素材审核状态
app.post('/api/projects/:id/assets/:assetId/sync-review', authenticate, async (req, res) => {
  try {
    const project = projectService.getProjectById(req.params.id, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });
    const updated = await assetService.syncAssetReviewFromVolc(req.params.assetId, req.params.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('[assets] 同步审核状态失败:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects/:id/assets/sync-reviews - 批量同步所有待审核素材
app.post('/api/projects/:id/assets/sync-reviews', authenticate, async (req, res) => {
  try {
    const project = projectService.getProjectById(req.params.id, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });
    const results = await assetService.syncAllPendingReviews(req.params.id);
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('[assets] 批量同步审核失败:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/projects/:id/assets/:assetId/auto-inject - 设置自动注入
app.put('/api/projects/:id/assets/:assetId/auto-inject', authenticate, (req, res) => {
  try {
    const { autoInject } = req.body;
    assetService.setAssetAutoInject(req.params.assetId, autoInject);
    res.json({ success: true });
  } catch (error) {
    console.error('[assets] 设置自动注入失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/projects/:id/assets/:assetId - 删除素材（联动火山）
app.delete('/api/projects/:id/assets/:assetId', authenticate, async (req, res) => {
  try {
    const project = projectService.getProjectById(req.params.id, req.user.id, ['admin','super_admin'].includes(req.user.role));
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const db = getDatabase();
    const asset = db.prepare('SELECT * FROM project_assets WHERE id = ? AND project_id = ?').get(req.params.assetId, req.params.id);
    if (!asset) return res.status(404).json({ error: '素材不存在' });

    if (asset.volc_asset_id) {
      try {
        await assetService.deleteAsset(asset.volc_asset_id);
      } catch (volcErr) {
        console.error('[assets] 删除火山引擎素材失败:', volcErr.message);
      }
    }
    assetService.deleteProjectAsset(req.params.assetId, req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('[assets] 删除失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 生产模式: 提供前端静态文件
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  // /api/* 未匹配返回 JSON 404，避免 SPA fallback 把 API 请求当成路由刷新
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `接口不存在：${req.method} ${req.path}` });
  });
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// 本地上传文件托管（Volc 不可用时的降级存储）
const localUploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(localUploadsDir)) fs.mkdirSync(localUploadsDir, { recursive: true });
app.use('/uploads', express.static(localUploadsDir));

process.on('SIGTERM', () => {
  console.log('[server] 收到 SIGTERM，正在关闭...');
  closeDatabase();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[server] 收到 SIGINT，正在关闭...');
  closeDatabase();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n🚀 服务器已启动: http://localhost:${PORT}`);
  console.log(`🔗 火山引擎 Ark API`);
  console.log(
    `📁 运行模式: ${process.env.NODE_ENV === 'production' ? '生产' : '开发'}\n`
  );
});