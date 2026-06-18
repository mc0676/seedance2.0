import { Router } from 'express';
import { getDatabase } from '../database/index.js';

const router = Router();

// ── 辅助：检查当前用户是否有权访问该画布 ──
function checkClothAccess(db, clothId, userId, requireOwner = false) {
  const cloth = db.prepare('SELECT * FROM canvas__cloths WHERE id = ?').get(clothId);
  if (!cloth) return { ok: false, status: 404, error: '画布不存在', cloth: null };
  // 画布无身份限制，仅项目成员可访问
  if (cloth.user_id === userId) return { ok: true, cloth };
  if (cloth.project_id) {
    const member = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(cloth.project_id, userId);
    if (member) return { ok: true, cloth };
  }
  if (requireOwner) return { ok: false, status: 403, error: '仅画布创建者可执行此操作', cloth };
  return { ok: false, status: 403, error: '无权访问此画布', cloth: null };
}

// ============================================================
//  CLOTHS — 画布
// ============================================================

// GET / — 画布列表（必须提供 projectId，项目隔离）
router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const projectId = parseInt(req.query.projectId);
    if (!projectId) return res.status(400).json({ error: '缺少 projectId 参数' });
    // 验证用户是否为该项目成员
    const member = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, req.user.id);
    if (!member) return res.status(403).json({ error: '您不是该项目成员' });
    const items = db.prepare('SELECT * FROM canvas__cloths WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    res.json({ success: true, data: items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — 新建画布
router.post('/', (req, res) => {
  try {
    const db = getDatabase();
    const { id, title, project_id } = req.body;
    if (!id) return res.status(400).json({ error: 'id 不能为空' });
    db.prepare(`INSERT INTO canvas__cloths (id, user_id, project_id, title) VALUES (?,?,?,?)`).run(id, req.user.id, project_id || null, title || '未命名画布');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /settings — 获取画布全局设置（key-value）
router.get('/settings', (req, res) => {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM canvas__settings').all();
    const data = {};
    for (const r of rows) {
      try { data[r.key] = JSON.parse(r.value); } catch { data[r.key] = r.value; }
    }
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /settings — 更新画布全局设置（key-value，支持批量）
router.put('/settings', (req, res) => {
  try {
    const db = getDatabase();
    const entries = req.body; // { key1: value1, key2: value2, ... }
    if (!entries || typeof entries !== 'object') return res.status(400).json({ error: '请求体必须为 key-value 对象' });
    const stmt = db.prepare('INSERT INTO canvas__settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by');
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const [k, v] of Object.entries(entries)) {
        stmt.run(k, typeof v === 'string' ? v : JSON.stringify(v), now, req.user.id);
      }
    });
    tx();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — 删除画布
router.delete('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id, true);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    // 先清理画布专属数据（config/script），图片/视频/音频不删
    db.prepare(`DELETE FROM canvas__configs WHERE id IN (SELECT id_of_resource FROM canvas__clothses_assets WHERE id_of_cloth = ? AND type = 'config')`).run(access.cloth.id);
    db.prepare(`DELETE FROM canvas__scripts WHERE id IN (SELECT id_of_resource FROM canvas__clothses_assets WHERE id_of_cloth = ? AND type = 'script')`).run(access.cloth.id);
    // CASCADE 删除 assets / connections
    db.prepare('DELETE FROM canvas__cloths WHERE id = ?').run(access.cloth.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — 获取单个画布
router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    res.json({ success: true, data: access.cloth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — 更新画布
router.put('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id, true);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { title, viewport, background_mode, show_image_info } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (viewport !== undefined) updates.viewport = JSON.stringify(viewport);
    if (background_mode !== undefined) updates.background_mode = background_mode;
    if (show_image_info !== undefined) updates.show_image_info = show_image_info ? 1 : 0;
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE canvas__cloths SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), access.cloth.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ################
// ################
// ################

// ============================================================
//  ASSETS — 元素卡片
// ============================================================

// GET /:id/assets — 画布所有节点
router.get('/:id/assets', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const assets = db.prepare(`
      SELECT a.*, c.generation_mode, c.model AS config_model, c.prompt AS config_prompt,
             c.params AS config_params, c.assets_of_at AS config_assets_of_at
      FROM canvas__clothses_assets a
      LEFT JOIN canvas__configs c ON c.id = a.id_of_resource
      WHERE a.id_of_cloth = ?
    `).all(access.cloth.id);
    res.json({ success: true, data: assets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/assets/:assetId — 删除单个节点（CASCADE 自动清理连线 + canvas__scripts）
router.delete('/:id/assets/:assetId', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    // 脚本类型：同步删除 canvas__scripts 记录
    const asset = db.prepare('SELECT type, id_of_resource FROM canvas__clothses_assets WHERE id = ? AND id_of_cloth = ?')
      .get(req.params.assetId, access.cloth.id);
    if (asset && asset.type === 'script' && asset.id_of_resource) {
      db.prepare('DELETE FROM canvas__scripts WHERE id = ?').run(asset.id_of_resource);
    }
    if (asset && asset.type === 'config' && asset.id_of_resource) {
      db.prepare('DELETE FROM canvas__configs WHERE id = ?').run(asset.id_of_resource);
    }
    db.prepare('DELETE FROM canvas__clothses_assets WHERE id = ? AND id_of_cloth = ?').run(req.params.assetId, access.cloth.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/assets — 新增单个节点（立即执行）
router.post('/:id/assets', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { assets } = req.body;
    if (!Array.isArray(assets) || assets.length === 0) return res.status(400).json({ error: 'assets 必须为非空数组' });
    const a = assets[0];
    // 配置类型：先创建 canvas__configs 记录，获取 id 作为 id_of_resource
    let idOfResource = a.id_of_resource || null;
    if (a.type === 'config' && !idOfResource) {
      const info = db.prepare(`INSERT INTO canvas__configs (user_id, project_id, generation_mode, model, prompt, params, assets_of_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        req.user.id,
        access.cloth.project_id,
        (a.generation_mode || a.config_generation_mode) || 'image',
        (a.config_model || a.model) || null,
        (a.prompt || a.config_prompt) || '',
        (a.params || a.config_params) || '{}',
        (a.assets_of_at) || '[]',
        new Date().toISOString()
      );
      idOfResource = info.lastInsertRowid;
    }
    db.prepare(`INSERT INTO canvas__clothses_assets (id, id_of_cloth, type, subtype, id_of_resource, title, pos_x, pos_y, width, height)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(a.id, access.cloth.id, a.type, a.subtype || a.model || null, idOfResource, a.title || '', a.pos_x || 0, a.pos_y || 0, a.width || 200, a.height || 120);
    res.json({ success: true, id_of_resource: idOfResource });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/assets — 批量更新节点（1s 延迟后发出，仅修改不移除）
router.put('/:id/assets', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { assets } = req.body;
    if (!Array.isArray(assets)) return res.status(400).json({ error: 'assets 必须为数组' });
    db.transaction(() => {
      for (const a of assets) {
        db.prepare(`UPDATE canvas__clothses_assets SET type=?, subtype=?, id_of_resource=?, title=?, pos_x=?, pos_y=?, width=?, height=? WHERE id=? AND id_of_cloth=?`)
          .run(a.type, a.subtype || a.model || null, a.id_of_resource || null, a.title || '', a.pos_x || 0, a.pos_y || 0, a.width || 200, a.height || 120, a.id, access.cloth.id);
        // 脚本类型：同步更新 canvas__scripts.content
        if (a.type === 'script' && a.id_of_resource && a.content !== undefined) {
          db.prepare('UPDATE canvas__scripts SET content = ?, updated_at = ? WHERE id = ?')
            .run(a.content, new Date().toISOString(), a.id_of_resource);
        }
        // 配置类型：通过 id_of_resource 同步更新 canvas__configs
        if (a.type === 'config' && a.id_of_resource) {
          db.prepare(`UPDATE canvas__configs SET generation_mode=?, model=?, prompt=?, params=?, assets_of_at=?, updated_at=?
            WHERE id=?`).run(
            (a.generation_mode || a.config_generation_mode) || 'image',
            (a.config_model || a.model) || null,
            (a.prompt || a.config_prompt) || '',
            (a.params || a.config_params) || '{}',
            (a.assets_of_at) || '[]',
            new Date().toISOString(),
            a.id_of_resource
          );
        }
      }
    })();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ################
// ################
// ################

// ============================================================
//  CONNECTIONS — 连线
// ============================================================

// GET /:id/connections — 画布所有连线
router.get('/:id/connections', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const conns = db.prepare('SELECT * FROM canvas__clothses_connections WHERE id_of_cloth = ?').all(access.cloth.id);
    res.json({ success: true, data: conns });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/connections/:connId — 删除单条连线
router.delete('/:id/connections/:connId', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    db.prepare('DELETE FROM canvas__clothses_connections WHERE id = ? AND id_of_cloth = ?').run(req.params.connId, access.cloth.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/connections — 新增单条连线（立即执行）
router.post('/:id/connections', (req, res) => {
  try {
    const db = getDatabase();
    const access = checkClothAccess(db, req.params.id, req.user.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { id, from_asset_id, to_asset_id } = req.body;
    if (!id || !from_asset_id || !to_asset_id) return res.status(400).json({ error: 'id, from_asset_id, to_asset_id 必填' });
    db.prepare('INSERT INTO canvas__clothses_connections (id, id_of_cloth, from_asset_id, to_asset_id) VALUES (?,?,?,?)').run(id, access.cloth.id, from_asset_id, to_asset_id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
