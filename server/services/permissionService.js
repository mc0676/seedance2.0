import { getDatabase } from '../database/index.js';

/**
 * 功能权限定义。新增功能时在此追加。
 * defaultEnabled 仅在 system_config.default_user_permissions 缺失对应键时使用。
 */
export const FEATURE_KEYS = [
  { key: 'generate_video_seedance', label: '视频生成 (Seedance 2.0)', defaultEnabled: true },
];

const FEATURE_KEY_SET = new Set(FEATURE_KEYS.map((f) => f.key));

function isValidFeatureKey(key) {
  return FEATURE_KEY_SET.has(key);
}

/**
 * 读取系统默认权限（缺失键回退到 FEATURE_KEYS.defaultEnabled）。
 */
export function getDefaultPermissions() {
  const db = getDatabase();
  const row = db.prepare(`SELECT value FROM system_config WHERE key = 'default_user_permissions'`).get();
  let stored = {};
  try {
    stored = row?.value ? JSON.parse(row.value) : {};
  } catch {
    stored = {};
  }
  const out = {};
  for (const { key, defaultEnabled } of FEATURE_KEYS) {
    out[key] = stored[key] !== undefined ? Boolean(stored[key]) : Boolean(defaultEnabled);
  }
  return out;
}

/**
 * 覆盖式写入系统默认权限。
 */
export function setDefaultPermissions(map) {
  const db = getDatabase();
  const merged = {};
  for (const { key } of FEATURE_KEYS) {
    if (map[key] !== undefined) merged[key] = Boolean(map[key]);
  }
  const value = JSON.stringify(merged);
  db.prepare(`
    INSERT INTO system_config (key, value, description)
    VALUES ('default_user_permissions', ?, '新注册用户默认开启的功能权限（JSON）')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(value);
  return getDefaultPermissions();
}

/**
 * 读取用户所有功能权限（含缺失键的默认值）。
 * 返回 { feature_key: boolean }
 */
export function getUserPermissions(userId) {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT feature_key, enabled FROM user_permissions WHERE user_id = ?'
  ).all(userId);
  const explicit = new Map(rows.map((r) => [r.feature_key, Boolean(r.enabled)]));
  const defaults = getDefaultPermissions();
  const out = {};
  for (const { key } of FEATURE_KEYS) {
    out[key] = explicit.has(key) ? explicit.get(key) : Boolean(defaults[key]);
  }
  return out;
}

/**
 * 设置用户某个功能权限（管理员）。
 */
export function setUserPermission(userId, featureKey, enabled, updatedBy = null) {
  if (!isValidFeatureKey(featureKey)) {
    throw new Error(`未知功能权限：${featureKey}`);
  }
  const db = getDatabase();
  db.prepare(`
    INSERT INTO user_permissions (user_id, feature_key, enabled, updated_at, updated_by)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(user_id, feature_key) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(userId, featureKey, enabled ? 1 : 0, updatedBy);
}

/**
 * 判断用户是否拥有某项功能权限。管理员永远 true。
 */
export function hasPermission(userId, featureKey) {
  if (!isValidFeatureKey(featureKey)) return false;
  const db = getDatabase();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.role === 'admin') return true;

  const row = db.prepare(
    'SELECT enabled FROM user_permissions WHERE user_id = ? AND feature_key = ?'
  ).get(userId, featureKey);
  if (row) return Boolean(row.enabled);

  const defaults = getDefaultPermissions();
  return Boolean(defaults[featureKey]);
}

/**
 * 注册成功后调用：把当前默认权限快照写入用户表。
 * 这样后续修改默认权限不会影响已注册用户。
 */
export function applyDefaultPermissions(userId) {
  const db = getDatabase();
  const defaults = getDefaultPermissions();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO user_permissions (user_id, feature_key, enabled)
    VALUES (?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const { key } of FEATURE_KEYS) {
      stmt.run(userId, key, defaults[key] ? 1 : 0);
    }
  });
  tx();
}

export default {
  FEATURE_KEYS,
  getDefaultPermissions,
  setDefaultPermissions,
  getUserPermissions,
  setUserPermission,
  hasPermission,
  applyDefaultPermissions,
};
