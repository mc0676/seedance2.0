/**
 * 火山引擎 ARK 素材库 API
 * 使用 HMAC-SHA256 签名认证（Access Key / Secret Key）
 * 从 system_config 表读取 AK/SK
 */
import crypto from 'crypto';
import { getDatabase } from '../database/index.js';

const ARK_HOST = 'open.volcengineapi.com';
const ARK_REGION = 'cn-beijing';

const DO_SHOW_STATUS_OF_SYNCHRONIZATION_OF_ASSET_OF_VOLC = ['1', 'true'].includes((process.env.SHOW_STATUS_OF_SYNCHRONIZATION_OF_ASSET_OF_VOLC || '').toLowerCase());
const ARK_SERVICE = 'ark';
const ARK_VERSION = '2024-01-01';

function isMultiAccountEnabled(db) {
  const row = db.prepare("SELECT value FROM system_config WHERE key = 'multi_volc_is_enable'").get();
  return (row?.value === '1' || row?.value === 'true');
}

/** 查询时应使用的目标 volc_id：单账户时用激活的 Key 组 id，多账户时用 project.volc_id */
function resolveFilterVolcId(db, projectId) {
  if (!isMultiAccountEnabled(db)) {
    const active = db.prepare('SELECT id FROM volc_key_groups WHERE is_active = 1 LIMIT 1').get();
    return active?.id ?? null;
  }
  const project = db.prepare('SELECT volc_id FROM projects WHERE id = ?').get(projectId);
  const pv = project?.volc_id ?? null;
  return pv; // null 表示不过滤
}

/** 根据目标 volc_id 生成过滤 SQL：null 永远等价于 1 */
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
  if (map[msg]) return map[msg];
  for (const [en, zh] of Object.entries(map)) {
    if (msg.includes(en)) return zh;
  }
  return msg;
}

function buildVolcFilter(targetVolcId, prefix = '') {
  const col = prefix ? prefix + '.volc_id' : 'volc_id';
  if (targetVolcId == null) return { sql: '', params: [] };
  if (targetVolcId === 1) return { sql: col + ' IS NULL OR ' + col + ' = 1', params: [] };
  return { sql: col + ' = ?', params: [targetVolcId] };
}

function getCredentials(keyGroupId = null) {
  const db = getDatabase();
  if (keyGroupId) {
    const kg = db.prepare('SELECT volc_access_key, volc_secret_key FROM volc_key_groups WHERE id = ?').get(keyGroupId);
    if (kg?.volc_access_key && kg?.volc_secret_key) {
      return { ak: kg.volc_access_key, sk: kg.volc_secret_key };
    }
  }
  const akRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_access_key_id'").get();
  const skRow = db.prepare("SELECT value FROM system_config WHERE key = 'volc_secret_access_key'").get();
  const ak = akRow?.value || process.env.VOLC_ACCESS_KEY_ID;
  const sk = skRow?.value || process.env.VOLC_SECRET_ACCESS_KEY;
  if (!ak || !sk) throw new Error('未配置火山引擎 AK/SK（请在管理员后台设置或配置 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY 环境变量）');
  return { ak, sk };
}

function arkSign(method, body, query, keyGroupId = null) {
  const { ak, sk } = getCredentials(keyGroupId);
  const now = new Date();
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timestamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const credentialScope = `${datestamp}/${ARK_REGION}/${ARK_SERVICE}/request`;

  const sortedQuery = Object.keys(query).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');

  const bodyStr = body ? JSON.stringify(body) : '{}';
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const signedHeaders = 'content-type;host;x-date';
  const canonicalHeaders = `content-type:application/json\nhost:${ARK_HOST}\nx-date:${timestamp}\n`;
  const canonicalRequest = [method, '/', sortedQuery, canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const stringToSign = ['HMAC-SHA256', timestamp, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const kDate = crypto.createHmac('sha256', sk).update(datestamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(ARK_REGION).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(ARK_SERVICE).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, 'x-date': timestamp, bodyStr, sortedQuery };
}

async function arkRequest(action, body = {}, keyGroupId = null) {
  const query = { Action: action, Version: ARK_VERSION };
  const { authorization, 'x-date': xDate, bodyStr, sortedQuery } = arkSign('POST', body, query, keyGroupId);

  if (DO_SHOW_STATUS_OF_SYNCHRONIZATION_OF_ASSET_OF_VOLC) {
    const ts = new Date().toISOString();
    console.log(`[assetService.js] ${ts} [ark-assets] ${action} 请求：${bodyStr}`);
  }
  const resp = await fetch(`https://${ARK_HOST}/?${sortedQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': ARK_HOST,
      'X-Date': xDate,
      'Authorization': authorization,
    },
    body: bodyStr,
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`ARK API 返回非JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`);
  }
  if (DO_SHOW_STATUS_OF_SYNCHRONIZATION_OF_ASSET_OF_VOLC) {
    console.log('---------------------------------------------------------------------------------------------------');
    const ts = new Date().toISOString();
    console.log(`[assetService.js] ${ts} [ark-assets] ${action} 已经收到响应，本次入参是：`);
    console.log(JSON.stringify(body, null, 2));
    console.log(`本次出参是：`);
    console.log(JSON.stringify(json, null, 2));
  }
  if (!resp.ok || json.ResponseMetadata?.Error) {
    const err = json.ResponseMetadata?.Error;
    // NotFound.asset_id 表示火山侧已删除，返回 null 让调用方标记本地为已删除
    if (err?.Code === 'NotFound.asset_id') {
      if (DO_SHOW_STATUS_OF_SYNCHRONIZATION_OF_ASSET_OF_VOLC) {
        console.log(`[assetService.js] [ark-assets] ${action} 资源已被火山侧删除 (NotFound.asset_id)，返回 null`);
      }
      return null;
    }
    throw new Error(translateArkError(err?.Message || JSON.stringify(json)));
  }
  return json.Result !== undefined ? json.Result : json;
}

// ============================================================
// 资产组管理
// ============================================================

export async function createAssetGroup({ name, description = '', projectName = 'default' }, keyGroupId = null) {
  return arkRequest('CreateAssetGroup', { Name: name, Description: description, ProjectName: projectName, GroupType: 'AIGC' }, keyGroupId);
}

export async function listAssetGroups({ pageNumber = 1, pageSize = 20, name } = {}) {
  const filter = { GroupType: 'AIGC' };
  if (name) filter.Name = name;
  return arkRequest('ListAssetGroups', { Filter: filter, PageNumber: pageNumber, PageSize: pageSize });
}

export async function getAssetGroup(id, projectName = 'default') {
  return arkRequest('GetAssetGroup', { Id: id, ProjectName: projectName });
}

export async function updateAssetGroup(id, { name, description, projectName = 'default' } = {}) {
  const body = { Id: id, ProjectName: projectName };
  if (name !== undefined) body.Name = name;
  if (description !== undefined) body.Description = description;
  return arkRequest('UpdateAssetGroup', body);
}

export async function deleteAssetGroup(id, projectName = 'default') {
  return arkRequest('DeleteAssetGroup', { Id: id, ProjectName: projectName });
}

// ============================================================
// 素材管理
// ============================================================

/**
 * 通过 URL 创建素材（ARK API）
 */
export async function uploadAssetByUrl({ url, assetType = 'Image', groupId, name = 'asset', projectName = 'default' }, keyGroupId = null) {
  const body = { URL: url, AssetType: assetType, Name: name, ProjectName: projectName };
  if (groupId) body.GroupId = groupId;
  return arkRequest('CreateAsset', body, keyGroupId);
}

/**
 * 上传图片 Base64（ARK API 不支持 Base64，先转 URL 上传）
 * 降级：将文件内容通过 OSS 预上传，或直接标记本地状态。
 * 实际业务中建议前端先上传到 OSS，再通过 URL 导入 ARK。
 */
export async function uploadImageBase64({ base64Data, mimeType = 'image/jpeg', groupId, fileName = 'asset' }) {
  throw new Error('ARK API 不支持 Base64 直传，请先上传到 OSS 后使用 URL 导入');
}

/**
 * 查询素材列表
 */
export async function listAssets({ groupId, pageSize = 20, pageNum = 1, statuses, name, keyGroupId = null } = {}) {
  const filter = { GroupType: 'AIGC' };
  if (groupId) filter.GroupIds = [groupId];
  if (statuses) filter.Statuses = Array.isArray(statuses) ? statuses : [statuses];
  if (name) filter.Name = name;
  return arkRequest('ListAssets', { Filter: filter, PageNumber: pageNum, PageSize: pageSize }, keyGroupId);
}

/**
 * 查询单个素材详情
 */
export async function getAsset(id, projectName = 'default') {
  return arkRequest('GetAsset', { Id: id, ProjectName: projectName });
}

/**
 * 创建素材（通用，支持 URL）
 */
export async function createAsset({ url, assetType = 'Image', groupId, name = 'asset', projectName = 'default' }) {
  return uploadAssetByUrl({ url, assetType, groupId, name, projectName });
}

/**
 * 更新素材
 */
export async function updateAsset(id, { name, description, projectName = 'default' } = {}) {
  const body = { Id: id, ProjectName: projectName };
  if (name !== undefined) body.Name = name;
  if (description !== undefined) body.Description = description;
  return arkRequest('UpdateAsset', body);
}

/**
 * 删除素材
 */
export async function deleteAsset(id, projectName = 'default') {
  return arkRequest('DeleteAsset', { Id: id, ProjectName: projectName });
}

// ============================================================
// 素材组名字唯一化（同一工作组内不允许重名）
// ============================================================

/**
 * 在指定项目内，给一个候选 name 计算可用的唯一名字。
 * 若原名未被占用，原样返回；否则附加 `(2)`、`(3)` … 直到不撞。
 *
 * @param {number} projectId
 * @param {string} desiredName  用户输入的原始名字（已 trim）
 * @param {number} [excludeId]  若是改名场景，把自身 id 排除掉，避免「跟自己撞」
 */
export function resolveUniqueAssetGroupName(projectId, desiredName, excludeId = null) {
  const db = getDatabase();
  const base = String(desiredName || '').trim();
  if (!base) return base;

  const baseExists = db.prepare(
    excludeId == null
      ? `SELECT 1 FROM asset_groups WHERE name = ?`
      : `SELECT 1 FROM asset_groups WHERE name = ? AND id != ?`
  ).get(...(excludeId == null ? [base] : [base, excludeId]));

  if (!baseExists) return base;

  const likeRows = db.prepare(
    `SELECT name FROM asset_groups WHERE name LIKE ? ${excludeId == null ? '' : 'AND id != ?'}`
  ).all(...(excludeId == null ? [`${base} (%)`] : [`${base} (%)`, excludeId]));
  const taken = new Set(likeRows.map((r) => r.name));

  for (let i = 2; i < 9999; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/**
 * 一次性迁移：把现有同名素材组重命名为 `name (2)`、`name (3)` …
 * 创建时间晚的被改名（保留第一份原名）。返回受影响行数。
 */
export function migrateDeduplicateAssetGroupNames() {
  const db = getDatabase();
  // 找出所有同名的组（按 created_at 升序，保留最早那条原名）
  const dups = db.prepare(
    `SELECT name FROM asset_groups
     GROUP BY name HAVING COUNT(*) > 1`
  ).all();
  if (dups.length === 0) return 0;
  let changed = 0;
  for (const { name } of dups) {
    const rows = db.prepare(
      `SELECT id FROM asset_groups WHERE name = ? ORDER BY created_at ASC, id ASC`
    ).all(name);
    // 跳过第一个（保留原名）；其余依次改成 name (2)、name (3)...
    for (let i = 1; i < rows.length; i++) {
      const unique = resolveUniqueAssetGroupName(null, name, rows[i].id);
      if (unique !== name) {
        db.prepare(`UPDATE asset_groups SET name = ? WHERE id = ?`).run(unique, rows[i].id);
        changed++;
      }
    }
  }
  return changed;
}

// ============================================================
// 项目资产库数据库操作
// ============================================================

export function getOrCreateProjectAssetGroup(projectId) {
  const db = getDatabase();
  const existing = db.prepare('SELECT * FROM asset_groups WHERE project_id = ?').get(projectId);
  if (existing) return existing;
  return null;
}

export function saveAssetGroup(projectId, volcGroupId, name, volcId = null) {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO asset_groups (project_id, volc_group_id, name, volc_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(projectId, volcGroupId, name, volcId);
  return db.prepare('SELECT * FROM asset_groups WHERE project_id = ?').get(projectId);
}

export function listProjectAssets(projectId, { page = 1, pageSize = 20, status, autoInject } = {}) {
  const db = getDatabase();
  const targetVolcId = resolveFilterVolcId(db, projectId);
  const filter = buildVolcFilter(targetVolcId, 'ag');
  const volcJoin = filter.sql ? ` LEFT JOIN asset_groups ag ON ag.id = pa.asset_group_id` : '';
  const conditions = ['pa.project_id = ?'];
  const params = [projectId];
  if (status) { conditions.push('pa.status = ?'); params.push(status); }
  else { conditions.push("pa.status != 'deleted'"); }
  if (autoInject !== undefined) { conditions.push('pa.auto_inject = ?'); params.push(autoInject ? 1 : 0); }
  if (filter.sql) {
    conditions.push(`(${filter.sql} OR pa.asset_group_id IS NULL)`);
    params.push(...filter.params);
  }
  const offset = (page - 1) * pageSize;
  const total = db.prepare(`SELECT COUNT(*) as n FROM project_assets pa${volcJoin} WHERE ${conditions.join(' AND ')}`).get(...params).n;
  const orderBy = 'ag.created_at DESC, pa.created_at DESC';
  const assets = db.prepare(`SELECT pa.* FROM project_assets pa LEFT JOIN asset_groups ag ON ag.id = pa.asset_group_id WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  return { assets, total, page, pageSize };
}

export function getAutoInjectAssetIds(projectId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT volc_asset_id FROM project_assets
    WHERE project_id = ? AND auto_inject = 1 AND review_status = 'approved' AND status = 'active'
    ORDER BY created_at ASC
  `).all(projectId).map(r => r.volc_asset_id).filter(Boolean);
}

export function saveProjectAsset({ projectId, assetGroupId, volcAssetId, name, originalName, fileType, fileSize, fileUrl, thumbnailUrl, uploadedBy }) {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO project_assets (project_id, asset_group_id, volc_asset_id, name, original_name, file_type, file_size, file_url, thumbnail_url, status, review_status, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'pending', ?)
  `).run(projectId, assetGroupId || null, volcAssetId, name, originalName || null, fileType, fileSize || 0, fileUrl || null, thumbnailUrl || null, uploadedBy || null);
  return db.prepare('SELECT * FROM project_assets WHERE id = ?').get(result.lastInsertRowid);
}

export function updateProjectAssetReview(assetId, reviewStatus) {
  const db = getDatabase();
  db.prepare(`UPDATE project_assets SET review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reviewStatus, assetId);
}

export function setAssetAutoInject(assetId, autoInject) {
  const db = getDatabase();
  db.prepare(`UPDATE project_assets SET auto_inject = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(autoInject ? 1 : 0, assetId);
}

export function deleteProjectAsset(assetId, projectId) {
  const db = getDatabase();
  db.prepare('DELETE FROM project_assets WHERE id = ? AND project_id = ?').run(assetId, projectId);
}

/**
 * 标准化原始文件名：YYYYMMDD_<rand6>_<safe_basename>.<ext>
 */
export function generateOriginalName(originalFileName = 'asset') {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const date = `${yyyy}${mm}${dd}`;
  const rand = crypto.randomBytes(3).toString('hex');

  const lastDot = originalFileName.lastIndexOf('.');
  const base = lastDot > 0 ? originalFileName.slice(0, lastDot) : originalFileName;
  const ext = lastDot > 0 ? originalFileName.slice(lastDot + 1).toLowerCase() : '';

  let safeBase = base
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 32);
  if (!safeBase) safeBase = 'asset';

  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'bin';
  return `${date}_${rand}_${safeBase}.${safeExt}`;
}

/**
 * 列出项目资产；合并本地 DB + ARK 上的素材。
 * ARK 资产若本地 DB 未记录则以虚拟记录形式追加，保证 @ 面板能看到所有可用资产。
 */
export async function listProjectAssetsLive(projectId, options = {}) {
  const db = getDatabase();

  // 获取当前项目 ALL 资产组（不做 volc_id 过滤，确保映射完整）
  const allGroupRows = db.prepare('SELECT volc_group_id, name, volc_id, id FROM asset_groups WHERE project_id = ?').all(projectId);
  // 本地权威组名映射（已通过 resolveUniqueAssetGroupName 去重）
  const groupNameByVolcId = new Map(allGroupRows.map((r) => [r.volc_group_id, r.name]));
  // volc_group_id → local asset_groups.id 映射，用于写入 project_assets.asset_group_id
  const assetGroupIdByVolcGroupId = new Map(
    allGroupRows.filter((r) => r.volc_group_id).map((r) => [r.volc_group_id, r.id])
  );

  // 拉取 ARK 资产时按 volc_id 过滤（不影响映射）
  const targetVolcId = resolveFilterVolcId(db, projectId);
  const filter = buildVolcFilter(targetVolcId);
  let fetchGroupIds = allGroupRows.map((r) => r.volc_group_id).filter(Boolean);
  if (filter.sql) {
    const filteredRows = db.prepare(
      'SELECT volc_group_id FROM asset_groups WHERE project_id = ? AND ' + filter.sql
    ).all(projectId, ...filter.params);
    const filteredVolcIds = new Set(filteredRows.map((r) => r.volc_group_id).filter(Boolean));
    fetchGroupIds = fetchGroupIds.filter((gid) => filteredVolcIds.has(gid));
  }
  // volc_group_id → volc_id（Key组ID）映射，用于多账户凭证
  const volcIdByGroupId = new Map(
    allGroupRows.filter((r) => r.volc_id).map((r) => [r.volc_group_id, r.volc_id])
  );

  // 无 ARK 资产组：降级为本地 DB
  if (fetchGroupIds.length === 0) {
    return listProjectAssets(projectId, options);
  }

  // 串行拉取所有资产组（避免并发触发 ARK rate limit 导致部分失败、数量不稳定）
  let arkItems = [];
  for (const volcGroupId of fetchGroupIds) {
    const keyGroupId = volcIdByGroupId.get(volcGroupId) || null;
    try {
      const items = [];
      let pageNum = 1;
      while (pageNum <= 20) {
        const resp = await listAssets({ groupId: volcGroupId, pageSize: 100, pageNum, keyGroupId });
        const batch = resp?.Items || [];
        items.push(...batch);
        if (!batch.length || batch.length < 100) break;
        pageNum++;
      }
      arkItems.push(...items);
    } catch (e) {
      console.warn('[assets] ARK ListAssets 拉取失败:', e.message);
    }
  }

  // 过滤已删除，按 CreateTime 升序排列（保证每次顺序一致）
  arkItems = arkItems
    .filter((it) => it.Status !== 'Deleted')
    .sort((a, b) => (a.CreateTime || '').localeCompare(b.CreateTime || ''));

  // 从本地 DB 拉取元数据（name、file_url、auto_inject、review_status 等）供合并
  const localRows = db.prepare(
    'SELECT * FROM project_assets WHERE project_id = ? AND status != \'deleted\''
  ).all(projectId);
  const localByVolcId = new Map(localRows.map((r) => [r.volc_asset_id, r]));

  const fileTypeMap = { Image: 'image', Video: 'video', Audio: 'audio' };

  const assets = arkItems.map((it, idx) => {
    const local = localByVolcId.get(it.Id);
    return {
      id: local?.id ?? -(idx + 1),
      project_id: Number(projectId),
      volc_asset_id: it.Id,
      volc_group_id: it.GroupId || null,
      asset_group_id: (it.GroupId && assetGroupIdByVolcGroupId.get(it.GroupId)) || null,
      group_name: (it.GroupId && groupNameByVolcId.get(it.GroupId)) || it.GroupName || null,
      name: local?.name || it.Name || it.Id,
      file_type: fileTypeMap[it.AssetType] || local?.file_type || 'image',
      file_url: it.URL || local?.file_url || null,
      // 缩略图优先用本地 OSS 永久 URL（火山 URL 12h 过期）；无 OSS URL 时回退火山 URL
      thumbnail_url: (local?.thumbnail_url && local.thumbnail_url.includes('aliyuncs.com'))
        ? local.thumbnail_url
        : (it.URL || local?.thumbnail_url || null),
      status: 'active',
      review_status: it.Status === 'Active' ? 'approved' : (local?.review_status || 'pending'),
      auto_inject: local?.auto_inject ?? 0,
      created_at: it.CreateTime || local?.created_at || '',
      updated_at: it.UpdateTime || local?.updated_at || '',
    };
  });

  // 后台异步回写到本地 DB，保证下次 skipLive=true 能立即显示完整列表
  const toSync = assets.filter((a) => a.volc_asset_id);
  setImmediate(() => {
    try {
      const syncMany = db.transaction((rows) => {
        for (const a of rows) {
          if (!a.volc_asset_id) continue;
          const existing = db.prepare(
            'SELECT id FROM project_assets WHERE project_id = ? AND volc_asset_id = ?'
          ).get(a.project_id, a.volc_asset_id);
          if (existing) {
            // 保留已有的 OSS 缩略图 URL（不会被火山临时 URL 覆盖）
            const existingAsset = db.prepare('SELECT thumbnail_url FROM project_assets WHERE id = ?').get(existing.id);
            const keepThumb = existingAsset?.thumbnail_url && existingAsset.thumbnail_url.includes('aliyuncs.com')
              ? existingAsset.thumbnail_url
              : a.thumbnail_url;
            db.prepare(`
              UPDATE project_assets SET name=?, file_url=?, thumbnail_url=?, asset_group_id=?, status='active', review_status=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=?
            `).run(a.name, a.file_url, keepThumb, a.asset_group_id, a.review_status, existing.id);
          } else {
            db.prepare(`
              INSERT INTO project_assets (project_id, volc_asset_id, asset_group_id, name, file_type, file_url, thumbnail_url, status, review_status, auto_inject)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 0)
            `).run(a.project_id, a.volc_asset_id, a.asset_group_id, a.name, a.file_type, a.file_url, a.thumbnail_url, a.review_status);
          }
        }
      });
      syncMany(toSync);
    } catch (e) {
      console.warn('[assets] 本地 DB 同步失败:', e.message);
    }
  });

  return {
    assets,
    total: assets.length,
    page: 1,
    pageSize: assets.length,
    volcSync: true,
  };
}

/**
 * 从 ARK 同步单个素材的审核状态
 */
export async function syncAssetReviewFromVolc(localAssetId, projectId) {
  const db = getDatabase();
  const asset = db.prepare('SELECT * FROM project_assets WHERE id = ? AND project_id = ?').get(localAssetId, projectId);
  if (!asset) throw new Error('素材不存在');
  if (!asset.volc_asset_id) throw new Error('该素材尚未上传到 ARK，无法同步审核状态');

  const volcAsset = await getAsset(asset.volc_asset_id);

  // 火山侧已删除，标记本地为已删除，清空无用字段
  if (!volcAsset) {
    db.prepare(`
      UPDATE project_assets
      SET status = 'deleted', file_url = NULL, file_size = NULL, review_status = NULL, auto_inject = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(localAssetId);
    return db.prepare('SELECT * FROM project_assets WHERE id = ?').get(localAssetId);
  }

  // ARK 返回的 Status: enabled=通过, disabled=拒绝, pending=审核中
  const volcStatus = volcAsset.Status || volcAsset.status;
  let reviewStatus = 'pending';
  let assetStatus = 'active';
  if (volcStatus === 'Active' || volcStatus === 'enabled' || volcStatus === 1) {
    reviewStatus = 'approved';
    assetStatus = 'active';
  } else if (volcStatus === 'Failed' || volcStatus === 'disabled' || volcStatus === 2) {
    reviewStatus = 'rejected';
    assetStatus = 'rejected';
  }

  const fileUrl = volcAsset.URL || volcAsset.FileUrl || volcAsset.file_url || asset.file_url;
  const thumbnailUrl = volcAsset.ThumbnailURL || volcAsset.ThumbnailUrl || volcAsset.thumbnail_url || asset.thumbnail_url;

  db.prepare(`
    UPDATE project_assets
    SET review_status = ?, status = ?, file_url = COALESCE(?, file_url), thumbnail_url = COALESCE(?, thumbnail_url), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reviewStatus, assetStatus, fileUrl, thumbnailUrl, localAssetId);

  return db.prepare('SELECT * FROM project_assets WHERE id = ?').get(localAssetId);
}

/**
 * 批量同步项目内所有待审核素材
 */
/**
 * 拉取 ARK ListAssets 同步 project_assets（首次无关联数据时自动调用）
 * @param {number} projectId
 * @param {number|null} keyGroupId
 * @param {{volc_group_id:string, id:number}[]} groups — asset_groups 行
 * @param {object} db
 */
export async function syncProjectAssetsFromVolc(projectId, keyGroupId, groups, db, arkRequestFn) {
  const volcGroupIds = groups.map(g => g.volc_group_id).filter(Boolean);
  if (volcGroupIds.length === 0) return;
  const agIdMap = new Map(groups.map(g => [g.volc_group_id, g.id]));
  let arkItems = [];
  let pageNum = 1;
  while (pageNum <= 20) {
    try {
      const resp = await arkRequestFn('ListAssets', {
        Filter: { GroupIds: volcGroupIds, GroupType: 'AIGC' },
        PageNumber: pageNum, PageSize: 100,
      }, db, keyGroupId);
      const batch = resp?.Items || [];
      arkItems.push(...batch);
      if (!batch.length || batch.length < 100) break;
      pageNum++;
    } catch (e) { break; }
  }
  arkItems = arkItems.filter(it => it.Status !== 'Deleted');
  if (arkItems.length === 0) return;
  const phs = arkItems.map(() => '?').join(',');
  const existingSet = new Set(
    db.prepare(`SELECT volc_asset_id FROM project_assets WHERE project_id=? AND volc_asset_id IN (${phs})`)
      .all(projectId, ...arkItems.map(it => it.Id)).map(r => r.volc_asset_id)
  );
  const fileTypeMap = { Image: 'image', Video: 'video', Audio: 'audio' };
  db.transaction(() => {
    for (const it of arkItems) {
      const agId = agIdMap.get(it.GroupId) || null;
      const ft = fileTypeMap[it.AssetType] || 'image';
      if (existingSet.has(it.Id)) {
        db.prepare(`UPDATE project_assets SET name=?,file_url=?,thumbnail_url=?,asset_group_id=?,status='active',review_status=?,updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND volc_asset_id=?`)
          .run(it.Name||it.Id, it.URL||null, it.URL||null, agId, it.Status==='Active'?'approved':'pending', projectId, it.Id);
      } else {
        db.prepare(`INSERT INTO project_assets (project_id,volc_asset_id,asset_group_id,name,file_type,file_url,thumbnail_url,status,review_status,auto_inject) VALUES (?,?,?,?,?,?,?,'active',?,0)`)
          .run(projectId, it.Id, agId, it.Name||it.Id, ft, it.URL||null, it.URL||null, it.Status==='Active'?'approved':'pending');
      }
    }
  })();
}

export async function syncAllPendingReviews(projectId) {
  const db = getDatabase();
  const pending = db.prepare(`
    SELECT * FROM project_assets
    WHERE project_id = ? AND volc_asset_id IS NOT NULL AND review_status = 'pending'
  `).all(projectId);

  const results = [];
  for (const asset of pending) {
    try {
      const updated = await syncAssetReviewFromVolc(asset.id, projectId);
      results.push({ id: asset.id, success: true, reviewStatus: updated.review_status });
    } catch (err) {
      console.error(`[assets] 同步素材 ${asset.id} 审核状态失败:`, err.message);
      results.push({ id: asset.id, success: false, error: err.message });
    }
  }
  return results;
}