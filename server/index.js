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
import { readFileSync } from 'fs';

// 初始化数据库
initDatabase();
// 启动画质增强后台轮询
enhancementWorker.start();

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
  const ts = Date.now();
  const ext = path.extname(filename).toLowerCase() || '';
  const basename = path.basename(filename, ext).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 40);
  const typeFolder = mediaType === 'video' ? 'videos' : mediaType === 'audio' ? 'audio' : 'images';
  return `seedance/${dateStr}/${typeFolder}/${ts}_${basename}${ext}`;
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

function createDownloadToken(taskId, userId) {
  cleanupExpiredDownloadTokens();
  const token = crypto.randomBytes(24).toString('hex');
  downloadTokens.set(token, {
    taskId: String(taskId),
    userId: Number(userId),
    expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS,
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

// 从激活的火山Key组取 ARK API Key
function resolveApiKey() {
  const db = getDatabase();
  const activeGroup = db.prepare('SELECT ark_model_key FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
  return activeGroup?.ark_model_key || '';
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
    res.json({ success: true, url, key });
  } catch (error) {
    console.error('[OSS] 上传失败:', error.message);
    res.status(500).json({ error: `OSS 上传失败: ${error.message}` });
  }
});

// POST /api/generate-image - 使用速创异步API生成图片（Nano Banana 2 / GPT-Image-2）
// 积分流程与视频一致：先 lockForImage → 生成 → settleForImage / releaseForImage
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
      creditLockService.releaseForImage({ imageRecordId, reason: submitData?.msg || '任务提交失败' });
      db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
      return res.status(502).json({ error: submitData?.msg || submitData?.message || '任务提交失败' });
    }
    wuyinTaskId = submitData.data.id;
  } catch (e) {
    creditLockService.releaseForImage({ imageRecordId, reason: e.message });
    db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
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
        creditLockService.releaseForImage({ imageRecordId, reason: detailData?.msg || '查询任务失败' });
        db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
        return res.status(502).json({ error: detailData?.msg || '查询任务失败' });
      }
      const status = detailData?.data?.status;
      if (status === 2) {
        resultUrls = Array.isArray(detailData.data.result) ? detailData.data.result : [];
        break;
      }
      if (status === 3) {
        const errMsg = detailData?.data?.message || '生成失败';
        creditLockService.releaseForImage({ imageRecordId, reason: errMsg });
        db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
        return res.status(502).json({ error: errMsg });
      }
    }
  } catch (e) {
    creditLockService.releaseForImage({ imageRecordId, reason: e.message });
    db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
    return res.status(500).json({ error: '轮询异常：' + e.message });
  }

  if (!resultUrls) {
    creditLockService.releaseForImage({ imageRecordId, reason: '生成超时' });
    db.prepare(`UPDATE image_records SET status='error' WHERE id=?`).run(imageRecordId);
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

// GET /api/image-records - 图片生成历史（按工作组过滤，无限滚动分页）
app.get('/api/image-records', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const { page = 1, pageSize = 20, projectId } = req.query;
    const limit = Math.min(parseInt(pageSize) || 20, 100);
    const offset = (parseInt(page) - 1) * limit;
    const conditions = ['user_id = ?'];
    const params = [req.user.id];
    if (projectId && projectId !== 'all') {
      conditions.push('project_id = ?');
      params.push(parseInt(projectId));
    }
    const where = conditions.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) as n FROM image_records WHERE ${where} AND status='done'`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM image_records WHERE ${where} AND status='done' ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
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

// POST /api/generate-video - 提交任务, 立即返回 taskId
app.post('/api/generate-video', authenticate, upload.array('files', 5), async (req, res) => {
  const startTime = Date.now();
  let dbTaskId = null;

  try {
    const { prompt, ratio, duration, model, projectId: reqProjectId } = req.body;
    const referenceMode = req.body.referenceMode === 'first_last_frame' ? 'first_last_frame' : 'reference';
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
      return res.status(400).json({ error: '必须指定所属工作组（projectId）' });
    }

    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const targetProject = projectService.getProjectById(Number(reqProjectId), req.user.id, isAdmin);
    if (!targetProject) {
      return res.status(403).json({ error: '工作组不存在或您不是该工作组成员' });
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
      if (lockedCredits > 0 && available < lockedCredits) {
        return res.status(402).json({
          error: `可用积分不足（可用 ${available}，本次预计需要 ${lockedCredits}）`,
          estimate: estimateResult,
        });
      }
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      return res.status(401).json({ error: getMissingSessionErrorMessage() });
    }

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

    let creditLockFailed = false;
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
      });
      dbTaskId = createdTask.id;
      console.log(`[生成任务] 数据库记录已创建，db_task_id = ${dbTaskId}, project_id = ${targetProject.id}`);

      // 保存素材 URL 到 task_assets（供历史记录展示）
      {
        const db = getDatabase();
        let sortOrder = 0;
        const getOriginalName = (url) => url.startsWith('asset://') ? url : (url.split('/').pop()?.split('?')[0] || 'file');
        for (const url of imageUrls) {
          db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'image', '', ?, ?, ?)`)
            .run(dbTaskId, url, getOriginalName(url), sortOrder++);
        }
        if (videoUrl) {
          db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'video', '', ?, ?, ?)`)
            .run(dbTaskId, videoUrl, getOriginalName(videoUrl), sortOrder++);
        }
        if (audioUrl) {
          db.prepare(`INSERT INTO task_assets (task_id, asset_type, file_path, image_uri, original_name, sort_order) VALUES (?, 'audio', '', ?, ?, ?)`)
            .run(dbTaskId, audioUrl, getOriginalName(audioUrl), sortOrder++);
        }
      }

      // 锁定预估积分（不立即扣，任务结束时按 actual 结算）
      if (lockedCredits > 0) {
        try {
          creditLockService.lock({
            userId: req.user.id,
            taskId: dbTaskId,
            estimatedCredits: estimateResult.credits,
            lockedCredits,
            meta: { ...estimateParams, model: resolvedModel },
          });
          console.log(`[积分] 锁定 ${lockedCredits}（预估 ${estimateResult.credits}）user=${req.user.id} task=${dbTaskId}`);
        } catch (lockErr) {
          console.error('[积分] 锁定失败：', lockErr.message);
          // 锁定失败说明积分不足或DB异常，取消任务
          if (dbTaskId) {
            try { taskService.updateTaskStatus(dbTaskId, 'error', { error_message: '积分锁定失败：' + lockErr.message }); } catch {}
          }
          creditLockFailed = true;
          if (!res.headersSent) {
            res.status(402).json({ error: '积分锁定失败，任务已取消：' + lockErr.message });
          }
        }
      }
    } catch (dbError) {
      console.error('[生成任务] 创建数据库记录失败:', dbError.message);
    }

    if (creditLockFailed) return;

    console.log(`\n========== [${taskId}] 收到视频生成请求 ==========`);
    console.log(`  prompt: ${(prompt || '').substring(0, 80)}${(prompt || '').length > 80 ? '...' : ''}`);
    console.log(`  model: ${model || 'seedance-2.0'}, ratio: ${ratio || '4:3'}, duration: ${duration || 4}秒`);
    console.log(`  files: ${(files || []).length}张`);
    (files || []).forEach((f, i) => {
      console.log(
        `  file[${i}]: ${f.originalname} (${f.mimetype}, ${(f.size / 1024).toFixed(1)}KB)`
      );
    });

    res.json({ taskId: dbTaskId || taskId, dbTaskId });

    generateSeedanceVideoCore({
      prompt,
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
        // 按 Ark API 返回的 usage.total_tokens 实际扣费；缺失或 0 则视为未计费
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
    // 检查归属：任务创建者 或 同工作组成员 或 管理员
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
        const apiKey = resolveApiKey();
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
// GET /api/projects - 获取项目列表（始终只返回当前用户自己的工作组）
app.get('/api/projects', authenticate, (req, res) => {
  try {
    const projects = projectService.getAllProjects(req.user.id, false);
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/projects - 创建项目
app.post('/api/projects', authenticate, (req, res) => {
  try {
    const { name, description, settings } = req.body;
    if (!name) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }
    const project = projectService.createProject({ name, description, settings, user_id: req.user.id });
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
    const updated = projectService.updateProject(req.params.id, {
      name,
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

// DELETE /api/projects/:id - 删除项目
app.delete('/api/projects/:id', authenticate, (req, res) => {
  try {
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
app.put('/api/settings', authenticate, requireAdmin, (req, res) => {
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
    const { status = 'all', type = 'all', page = 1, pageSize = 20, projectId } = req.query;
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const result = videoDownloader.getDownloadTasks({
      status,
      type,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      userId: req.user.id,
      isAdmin,
      projectId: projectId ? Number(projectId) : null,
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
        ${userWhereClause}
    `).all(...userParams);

    let refreshed = 0;

    await Promise.all(generatingTasks.map(async (task) => {
      const arkTaskId = task.submit_id || task.history_id;
      if (!arkTaskId) return;
      try {
        const apiKey = resolveApiKey();
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
      WHERE t.id = ?
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

// DELETE /api/download/tasks/:id - 删除任务
app.delete('/api/download/tasks/:id', authenticate, (req, res) => {
  try {
    const taskId = req.params.id;
    const db = getDatabase();

    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (req.user.role !== "admin" && req.user.role !== "super_admin" && !projectService.isProjectMember(task.project_id, req.user.id)) {
      return res.status(403).json({ error: '无权访问' });
    }

    // 删除任务（外键会自动删除 task_assets 和 generation_history）
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

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

// PUT /api/auth/me - 更新当前用户信息
app.put('/api/auth/me', authenticate, async (req, res) => {
  try {
    // 预留扩展功能
    res.json({ success: true, data: { user: req.user } });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// POST /api/credits/add - 充值积分（管理员）
app.post('/api/credits/add', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '积分数量无效' });
    }

    const targetUserId = userId || req.user.id;
    const result = await authService.rechargeCredits(targetUserId, amount);
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

// GET /api/admin/projects - 管理员查看全量项目列表（支持筛选）
app.get('/api/admin/projects', authenticate, requireAdmin, (req, res) => {
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
             (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
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
app.delete('/api/admin/projects/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const assetCount = db.prepare(
      "SELECT COUNT(*) as count FROM project_assets WHERE project_id = ? AND status != 'deleted'"
    ).get(req.params.id).count;

    if (assetCount > 0) {
      // 保留资产：将资产的 uploaded_by 转移给当前管理员，项目本身标为已删除状态
      // 先把资产的 project_id 置 null（解除关联），再删项目
      // 实际上外键级联会删除资产；所以先将资产状态标记 deleted 以保留记录，再删项目
      // 更简单：不删项目，只通知前端已转移
      // 按照需求：资产库保留 → 将项目 user_id 改为当前管理员，并更新名称备注
      db.prepare('UPDATE projects SET user_id = ?, name = ? WHERE id = ?')
        .run(req.user.id, `[已转移] ${project.name}`, req.params.id);
      // 移除所有项目成员，只保留管理员
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
      { role, status, email }
    );
    res.json({ success: true, data: result });
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

    await authService.updateUserStatus(userId, status);
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

    await authService.updateUserCredits(userId, credits, operation);
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
app.get('/api/admin/activation-codes', authenticate, requireAdmin, (req, res) => {
  try {
    const codes = jimengSessionService.listActivationCodes();
    res.json({ success: true, data: codes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/activation-codes - 创建激活码
app.post('/api/admin/activation-codes', authenticate, requireAdmin, (req, res) => {
  try {
    const code = jimengSessionService.createActivationCode({ ...req.body, createdBy: req.user.id });
    res.json({ success: true, data: code });
  } catch (error) {
    const msg = error.message?.includes('UNIQUE constraint failed')
      ? '激活码已存在，请换一个不同的激活码'
      : error.message;
    res.status(400).json({ error: msg });
  }
});

// PUT /api/admin/activation-codes/:id - 修改激活码
app.put('/api/admin/activation-codes/:id', authenticate, requireAdmin, (req, res) => {
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
app.delete('/api/admin/activation-codes/:id', authenticate, requireAdmin, (req, res) => {
  try {
    jimengSessionService.deleteActivationCode(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
// GET /api/admin/system-config
app.get('/api/admin/system-config', authenticate, requireAdmin, (req, res) => {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'registration_enabled'").get();
  const mRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_mode'").get();
  const msgRow = db.prepare("SELECT value FROM system_config WHERE key = 'maintenance_message'").get();
  res.json({
    success: true,
    data: {
      registrationEnabled: row ? row.value !== '0' : true,
      maintenanceMode: mRow?.value === '1',
      maintenanceMessage: msgRow?.value || '系统维护中，请稍后再试。',
    },
  });
});

// PUT /api/admin/system-config
app.put('/api/admin/system-config', authenticate, requireAdmin, (req, res) => {
  const db = getDatabase();
  const { registrationEnabled, maintenanceMode, maintenanceMessage } = req.body;
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
  res.json({ success: true });
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
app.get('/api/admin/usage/stats', authenticate, requireAdmin, (req, res) => {
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
app.put('/api/admin/users/:id/unlimited', authenticate, requireAdmin, (req, res) => {
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
app.get('/api/admin/permissions/features', authenticate, requireAdmin, (req, res) => {
  res.json({ success: true, data: permissionService.FEATURE_KEYS });
});

// GET /api/admin/permissions/defaults - 系统默认权限
app.get('/api/admin/permissions/defaults', authenticate, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, data: permissionService.getDefaultPermissions() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/permissions/defaults - 更新系统默认权限
app.put('/api/admin/permissions/defaults', authenticate, requireAdmin, (req, res) => {
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
app.get('/api/admin/users/:id/permissions', authenticate, requireAdmin, (req, res) => {
  try {
    const data = permissionService.getUserPermissions(Number(req.params.id));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id/permissions - 更新指定用户的某项权限
app.put('/api/admin/users/:id/permissions', authenticate, requireAdmin, (req, res) => {
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
app.get('/api/admin/tasks/by-account', authenticate, requireAdmin, (req, res) => {
  try {
    const accountId = Number(req.query.accountId);
    if (!accountId) return res.status(400).json({ error: 'accountId 必填' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const db = getDatabase();
    // SQLite json_extract 路径：account_info 是 TEXT JSON
    const where = `account_info IS NOT NULL AND json_extract(account_info, '$.accountId') = ?`;
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
app.get('/api/admin/model-pricing', authenticate, requireAdmin, (req, res) => {
  try {
    res.json({ success: true, data: pricingService.listAll() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/model-pricing/:modelKey - 新增或修改模型计费配置
app.put('/api/admin/model-pricing/:modelKey', authenticate, requireAdmin, (req, res) => {
  try {
    const row = pricingService.upsert(req.params.modelKey, req.body || {});
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/admin/model-pricing/:modelKey
app.delete('/api/admin/model-pricing/:modelKey', authenticate, requireAdmin, (req, res) => {
  try {
    pricingService.remove(req.params.modelKey);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 火山Key组管理（全局唯一激活）
// ============================================================

// GET /api/admin/volc-key-groups
app.get('/api/admin/volc-key-groups', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const groups = db.prepare('SELECT * FROM volc_key_groups ORDER BY id ASC').all();
    res.json({ success: true, data: groups });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/volc-key-groups
app.post('/api/admin/volc-key-groups', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const { name, ark_model_key, volc_access_key = '', volc_secret_key = '', note = '' } = req.body;
    if (!name || !ark_model_key) {
      return res.status(400).json({ error: 'name 和 ark_model_key 均必填' });
    }
    const result = db.prepare(
      'INSERT INTO volc_key_groups (name, ark_model_key, ark_asset_key, volc_access_key, volc_secret_key, is_active, note) VALUES (?, ?, ?, ?, ?, 0, ?)'
    ).run(name, ark_model_key, '', volc_access_key, volc_secret_key, note);
    const group = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, data: group });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/volc-key-groups/:id
app.put('/api/admin/volc-key-groups/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });
    const { name, ark_model_key, volc_access_key, volc_secret_key, note } = req.body;
    db.prepare(
      'UPDATE volc_key_groups SET name=?, ark_model_key=?, volc_access_key=?, volc_secret_key=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(
      name ?? existing.name,
      ark_model_key ?? existing.ark_model_key,
      volc_access_key ?? existing.volc_access_key ?? '',
      volc_secret_key ?? existing.volc_secret_key ?? '',
      note ?? existing.note,
      id
    );
    const group = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    res.json({ success: true, data: group });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/volc-key-groups/:id/activate - 激活（同时停用其他组，同步 AK/SK 到 system_config）
app.put('/api/admin/volc-key-groups/:id/activate', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM volc_key_groups WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '未找到该Key组' });
    db.prepare('UPDATE volc_key_groups SET is_active = 0').run();
    db.prepare('UPDATE volc_key_groups SET is_active = 1, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(id);
    // 同步该组的 AK/SK 到 system_config（供 volcArkAssetRequest 使用）
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

// DELETE /api/admin/volc-key-groups/:id
app.delete('/api/admin/volc-key-groups/:id', authenticate, requireAdmin, (req, res) => {
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
app.get('/api/admin/wuyin-key', authenticate, requireAdmin, (req, res) => {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'wuyin_api_key'").get();
    res.json({ success: true, data: { key: row?.value || '' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/wuyin-key
app.put('/api/admin/wuyin-key', authenticate, requireAdmin, (req, res) => {
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

app.get('/api/admin/mediakit-key', authenticate, requireAdmin, (req, res) => {
  try {
    const row = getDatabase().prepare("SELECT value FROM system_config WHERE key = 'mediakit_api_key'").get();
    res.json({ success: true, data: { key: row?.value || '' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/mediakit-key', authenticate, requireAdmin, (req, res) => {
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

// 画质增强计费配置
app.get('/api/admin/enhancement-pricing', authenticate, requireAdmin, (req, res) => {
  try {
    const rows = getDatabase().prepare(
      `SELECT tool_version, label, credits_per_second, enabled, description, updated_at
       FROM enhancement_pricing ORDER BY tool_version ASC`
    ).all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/enhancement-pricing/:toolVersion', authenticate, requireAdmin, (req, res) => {
  try {
    const { toolVersion } = req.params;
    if (!['standard', 'professional'].includes(toolVersion)) {
      return res.status(400).json({ error: '无效的 tool_version' });
    }
    const { credits_per_second, enabled, label, description } = req.body;
    const db = getDatabase();
    const existing = db.prepare(`SELECT * FROM enhancement_pricing WHERE tool_version = ?`).get(toolVersion);
    if (!existing) return res.status(404).json({ error: '配置不存在' });
    const next = {
      credits_per_second: credits_per_second != null ? Math.max(0, Math.floor(Number(credits_per_second))) : existing.credits_per_second,
      enabled: enabled != null ? (enabled ? 1 : 0) : existing.enabled,
      label: label != null ? String(label) : existing.label,
      description: description != null ? String(description) : existing.description,
    };
    db.prepare(
      `UPDATE enhancement_pricing SET credits_per_second=?, enabled=?, label=?, description=?, updated_at=CURRENT_TIMESTAMP
       WHERE tool_version=?`
    ).run(next.credits_per_second, next.enabled, next.label, next.description, toolVersion);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 视频画质增强（用户侧）
// ============================================================

// GET /api/enhancement-pricing - 普通用户也能读，用于弹窗预估积分
app.get('/api/enhancement-pricing', authenticate, (req, res) => {
  try {
    const rows = getDatabase().prepare(
      `SELECT tool_version, label, credits_per_second, enabled, description
       FROM enhancement_pricing WHERE enabled = 1 ORDER BY tool_version ASC`
    ).all();
    res.json({ success: true, data: rows });
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
      `SELECT id, task_id, status, tool_version, scene, target_resolution,
              enhanced_video_url, error_message, credits_used, duration_seconds,
              created_at, finished_at
       FROM video_enhancements WHERE task_id = ? ORDER BY created_at DESC`
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
  const { taskId, videoUrl, durationSeconds, scene = 'aigc', toolVersion = 'standard', resolution = '1080p' } = req.body;

  if (!['aigc', 'short_series', 'ugc', 'old_film'].includes(scene)) {
    return res.status(400).json({ error: '无效的 scene' });
  }
  if (!['standard', 'professional'].includes(toolVersion)) {
    return res.status(400).json({ error: '无效的 tool_version' });
  }
  if (!['720p', '1080p', '4k'].includes(resolution)) {
    return res.status(400).json({ error: '无效的 resolution' });
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
    // 防重：同一任务已有 pending/processing 记录时拒绝再次提交
    const inProgress = db.prepare(
      `SELECT id FROM video_enhancements WHERE task_id = ? AND status IN ('pending', 'processing') LIMIT 1`
    ).get(taskId);
    if (inProgress) return res.status(409).json({ error: '该视频已有增强任务正在进行中，请等待完成后再试' });
    sourceUrl = task.video_url;
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
    sourceUrl = videoUrl;
    durationSec = Math.max(1, Math.min(300, Math.round(d)));
  } else {
    return res.status(400).json({ error: '请提供 taskId 或 videoUrl+durationSeconds' });
  }

  // 2) 取计费配置 + Key
  const pricing = db.prepare(
    `SELECT credits_per_second, label FROM enhancement_pricing WHERE tool_version = ? AND enabled = 1`
  ).get(toolVersion);
  if (!pricing) return res.status(400).json({ error: '该版本未启用计费配置' });

  const apiKeyRow = db.prepare("SELECT value FROM system_config WHERE key = 'mediakit_api_key'").get();
  const apiKey = apiKeyRow?.value || '';
  if (!apiKey) return res.status(503).json({ error: 'MediaKit API Key 未配置，请联系管理员' });

  const estimatedCredits = durationSec * pricing.credits_per_second;

  // 3) 预插入 video_enhancements 行
  let enhancementId;
  try {
    const ins = db.prepare(
      `INSERT INTO video_enhancements
         (task_id, user_id, project_id, source_video_url, tool_version, scene, target_resolution, duration_seconds, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(sourceTaskId, req.user.id, projectId, sourceUrl, toolVersion, scene, resolution, durationSec);
    enhancementId = ins.lastInsertRowid;
  } catch (e) {
    return res.status(500).json({ error: '初始化记录失败：' + e.message });
  }

  // 4) 锁定积分
  try {
    creditLockService.lockForEnhancement({
      userId: req.user.id,
      enhancementId,
      credits: estimatedCredits,
      meta: { tool_version: toolVersion, scene, resolution, duration: durationSec, model: pricing.label, source: sourceTaskId ? 'task' : 'url' },
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
      resolution,
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

// GET /api/video-enhancements/list - 列出当前用户的所有增强记录（含外部视频，分页）
app.get('/api/video-enhancements/list', authenticate, (req, res) => {
  try {
    const db = getDatabase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM video_enhancements WHERE user_id = ?`
    ).get(req.user.id).n;

    const items = db.prepare(
      `SELECT id, task_id, user_id, project_id, source_video_url, mediakit_task_id,
              tool_version, scene, target_resolution, duration_seconds, status,
              enhanced_video_url, credits_used, error_message, created_at, finished_at
       FROM video_enhancements
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).all(req.user.id, pageSize, offset);

    res.json({ success: true, data: { items, total, page, pageSize } });
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

async function volcArkAssetRequest(action, body, db) {
  const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_access_key_id'").get();
  const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_secret_access_key'").get();
  const ak = akRow?.value || process.env.VOLC_ACCESS_KEY_ID;
  const sk = skRow?.value || process.env.VOLC_SECRET_ACCESS_KEY;
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
    throw new Error(json.ResponseMetadata?.Error?.Message || JSON.stringify(json));
  }
  return json.Result || json;
}

// GET /api/admin/volc-native/aksk
app.get('/api/admin/volc-native/aksk', authenticate, requireAdmin, (req, res) => {
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
app.put('/api/admin/volc-native/aksk', authenticate, requireAdmin, (req, res) => {
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
    const { id, projectName = 'default' } = req.query;
    if (!id) return res.status(400).json({ error: 'id 参数必填' });
    const result = await volcArkAssetRequest('GetAsset', { Id: id, ProjectName: projectName }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/admin/volc-native/asset-groups?pageNumber=&pageSize=&name=
app.get('/api/admin/volc-native/asset-groups', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { pageNumber = 1, pageSize = 20, name } = req.query;
    const filter = { GroupType: 'AIGC' };
    if (name) filter.Name = name;
    const result = await volcArkAssetRequest('ListAssetGroups', {
      Filter: filter,
      PageNumber: Number(pageNumber),
      PageSize: Number(pageSize),
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/admin/volc-native/assets?groupId=&pageNumber=&pageSize=&name=&statuses=
app.get('/api/admin/volc-native/assets', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, pageNumber = 1, pageSize = 20, name, statuses } = req.query;
    const filter = { GroupType: 'AIGC' };
    if (groupId) filter.GroupIds = [groupId];
    if (name) filter.Name = name;
    if (statuses) filter.Statuses = statuses.split(',');
    const result = await volcArkAssetRequest('ListAssets', {
      Filter: filter,
      PageNumber: Number(pageNumber),
      PageSize: Number(pageSize),
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/admin/volc-native/asset-groups — 创建素材组
app.post('/api/admin/volc-native/asset-groups', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description = '', projectName = 'default' } = req.body;
    if (!name) return res.status(400).json({ error: 'name 必填' });
    const result = await volcArkAssetRequest('CreateAssetGroup', {
      Name: name,
      Description: description,
      GroupType: 'AIGC',
      ProjectName: projectName,
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/admin/volc-native/assets — 上传素材（通过 URL）
app.post('/api/admin/volc-native/assets', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, url, assetType = 'Image', name = '', projectName = 'default' } = req.body;
    if (!groupId || !url) return res.status(400).json({ error: 'groupId 和 url 必填' });
    const result = await volcArkAssetRequest('CreateAsset', {
      GroupId: groupId,
      URL: url,
      AssetType: assetType,
      Name: name,
      ProjectName: projectName,
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/admin/volc-native/assets/:id
app.delete('/api/admin/volc-native/assets/:id', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    // 普通用户需验证素材归属
    if (!isAdmin) {
      const asset = db.prepare('SELECT pa.id FROM project_assets pa JOIN projects p ON pa.project_id = p.id WHERE pa.volc_asset_id = ? AND p.user_id = ?').get(req.params.id, req.user.id);
      if (!asset) return res.status(403).json({ error: '无权删除此素材' });
    }
    const { projectName = 'default' } = req.body || {};
    const result = await volcArkAssetRequest('DeleteAsset', { Id: req.params.id, ProjectName: projectName }, db);
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
    const { id, projectName = 'default' } = req.body;
    if (!id) return res.status(400).json({ error: 'id 必填' });
    const result = await volcArkAssetRequest('GetAssetGroup', { Id: id, ProjectName: projectName }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// PUT /api/admin/volc-native/asset-groups/:id — UpdateAssetGroup
app.put('/api/admin/volc-native/asset-groups/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description, projectName = 'default' } = req.body;
    const body = { Id: req.params.id, ProjectName: projectName };
    if (name !== undefined) body.Name = name;
    if (description !== undefined) body.Description = description;
    const result = await volcArkAssetRequest('UpdateAssetGroup', body, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/admin/volc-native/asset-groups/:id — DeleteAssetGroup
app.delete('/api/admin/volc-native/asset-groups/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const db = getDatabase();
    const { projectName = 'default' } = req.body || {};
    const result = await volcArkAssetRequest('DeleteAssetGroup', { Id: req.params.id, ProjectName: projectName }, db);
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
    const { name, projectName = 'default' } = req.body;
    const body = { Id: req.params.id, ProjectName: projectName };
    if (name !== undefined) body.Name = name;
    const result = await volcArkAssetRequest('UpdateAsset', body, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── 工作组资产库（普通用户可访问）──
// GET /api/volc-native/asset-groups
// projectId 参数：仅返回该项目绑定的素材组（隔离工作组）；不传 + 管理员则返回全部
app.get('/api/volc-native/asset-groups', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { pageNumber = 1, pageSize = 20, name, projectId } = req.query;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);

    // 项目隔离：projectId 提供时严格过滤为该项目绑定的素材组
    if (projectId) {
      const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
      if (!project) return res.status(404).json({ error: '项目不存在或无权访问' });
      const boundRows = db.prepare('SELECT volc_group_id FROM asset_groups WHERE project_id = ?').all(projectId);
      const volcGroupIds = boundRows.map(r => r.volc_group_id).filter(Boolean);
      if (volcGroupIds.length === 0) {
        return res.json({ success: true, data: { Items: [], TotalCount: 0 } });
      }
      // 并发拉取每个绑定素材组的详情
      try {
        const details = await Promise.all(
          volcGroupIds.map(id => volcArkAssetRequest('GetAssetGroup', { Id: id }, db).catch(() => null))
        );
        const items = details.filter(Boolean);
        return res.json({ success: true, data: { Items: items, TotalCount: items.length } });
      } catch (e) {
        return res.json({ success: true, data: { Items: [], TotalCount: 0 } });
      }
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

// GET /api/volc-native/assets
app.get('/api/volc-native/assets', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, pageNumber = 1, pageSize = 20, name, statuses } = req.query;
    const filter = { GroupType: 'AIGC' };
    if (groupId) filter.GroupIds = [groupId];
    if (name) filter.Name = name;
    if (statuses) filter.Statuses = statuses.split(',');
    const result = await volcArkAssetRequest('ListAssets', {
      Filter: filter, PageNumber: Number(pageNumber), PageSize: Number(pageSize),
    }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/volc-native/asset?id=
app.get('/api/volc-native/asset', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { id, projectName = 'default' } = req.query;
    if (!id) return res.status(400).json({ error: 'id 必填' });
    const result = await volcArkAssetRequest('GetAsset', { Id: id, ProjectName: projectName }, db);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/volc-native/asset-groups — CreateAssetGroup（普通用户）
// 必须传 projectId，创建后会自动绑定到该项目（写入 asset_groups 表）
app.post('/api/volc-native/asset-groups', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { name, description = '', projectName = 'default', projectId } = req.body;
    if (!name) return res.status(400).json({ error: 'name 必填' });
    if (!projectId) return res.status(400).json({ error: 'projectId 必填（素材组必须绑定到一个工作组）' });
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    const project = projectService.getProjectById(projectId, req.user.id, isAdmin);
    if (!project) return res.status(404).json({ error: '工作组不存在或无权访问' });

    const result = await volcArkAssetRequest('CreateAssetGroup', {
      Name: name, Description: description, GroupType: 'AIGC', ProjectName: projectName,
    }, db);

    const volcGroupId = result?.Id;
    if (volcGroupId) {
      // 绑定到当前工作组
      db.prepare(`
        INSERT OR REPLACE INTO asset_groups (project_id, volc_group_id, name, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `).run(projectId, volcGroupId, name);
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/volc-native/assets — CreateAsset（普通用户）
app.post('/api/volc-native/assets', authenticate, async (req, res) => {
  try {
    const db = getDatabase();
    const { groupId, url, assetType = 'Image', name = '', projectName = 'default' } = req.body;
    if (!groupId || !url) return res.status(400).json({ error: 'groupId 和 url 必填' });
    const result = await volcArkAssetRequest('CreateAsset', {
      GroupId: groupId, URL: url, AssetType: assetType, Name: name, ProjectName: projectName,
    }, db);
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
      return res.status(400).json({ error: '不能移除工作组所有者' });
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
    let fileUrl = null;
    let thumbnailUrl = null;

    // 获取或创建资产组
    let assetGroup = assetService.getOrCreateProjectAssetGroup(projectId);
    let volcGroupId = assetGroup?.volc_group_id;

    if (!volcGroupId) {
      try {
        const groupResult = await assetService.createAssetGroup({ name: `project-${projectId}-${project.name}` });
        volcGroupId = groupResult.GroupId || groupResult.group_id;
        assetGroup = assetService.saveAssetGroup(projectId, volcGroupId, `project-${projectId}`);
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
        try {
          const assetTypeMap = { image: 'Image', video: 'Video', audio: 'Audio' };
          const uploadResult = await assetService.uploadAssetByUrl({
            url: fileUrl,
            assetType: assetTypeMap[fileType] || 'Image',
            groupId: volcGroupId,
            name: originalName,
          });
          volcAssetId = uploadResult.Id || uploadResult.AssetId || uploadResult.asset_id;
          fileUrl = uploadResult.URL || uploadResult.Url || uploadResult.url || fileUrl;
          thumbnailUrl = uploadResult.ThumbnailURL || uploadResult.ThumbnailUrl || thumbnailUrl;
          console.log(`[assets] ARK 导入成功: assetId=${volcAssetId}`);
        } catch (arkErr) {
          console.error('[assets] ARK 导入失败（已保存 OSS URL）:', arkErr.message);
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
        });
        volcAssetId = uploadResult.Id || uploadResult.AssetId || uploadResult.asset_id;
        fileUrl = uploadResult.URL || uploadResult.Url || uploadResult.url || req.body.url;
        thumbnailUrl = uploadResult.ThumbnailURL || uploadResult.ThumbnailUrl;
      } catch (volcErr) {
        console.error('[assets] 通过 URL 上传 ARK 失败:', volcErr.message);
        fileUrl = req.body.url;
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
app.put('/api/projects/:id/assets/:assetId/review', authenticate, requireAdmin, (req, res) => {
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
