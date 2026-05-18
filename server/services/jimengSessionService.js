import { getDatabase } from '../database/index.js';

export function redeemActivationCode(userId, code) {
  const db = getDatabase();
  const trimmed = String(code || '').trim();
  if (!trimmed) throw new Error('激活码不能为空');

  const record = db.prepare(`SELECT * FROM activation_codes WHERE code = ?`).get(trimmed);
  if (!record) throw new Error('激活码无效');
  if (record.used_count >= record.max_uses) throw new Error('激活码已达到最大使用次数');

  const transaction = db.transaction(() => {
    const creditsValue = Number(record.credits_value) || 0;
    if (creditsValue !== 0) {
      db.prepare(`UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ?`).run(creditsValue, userId);
    }
    db.prepare(`UPDATE activation_codes SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(record.id);

    // 记录积分发放日志（仅记录正数发放，归属到创建该激活码的管理员）
    if (creditsValue > 0) {
      db.prepare(`
        INSERT INTO credit_distribution_logs (admin_id, recipient_id, credits_amount, method, note)
        VALUES (?, ?, ?, 'activation_code', ?)
      `).run(record.created_by || null, userId, creditsValue, `激活码: ${trimmed}`);
    }
  });
  transaction();
}

export function listActivationCodes() {
  const db = getDatabase();
  return db.prepare(`SELECT * FROM activation_codes ORDER BY created_at DESC`).all();
}

export function createActivationCode(payload) {
  const db = getDatabase();
  const code = String(payload.code || '').trim();
  const maxUses = Number(payload.maxUses) || 1;
  const note = String(payload.note || '').trim();
  const createdBy = payload.createdBy || null;
  const creditsValue = Number(payload.creditsValue) || 0;
  if (!code) throw new Error('激活码不能为空');

  const result = db.prepare(`
    INSERT INTO activation_codes (code, max_uses, note, credits_value, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, maxUses, note, creditsValue, createdBy);
  return db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(result.lastInsertRowid);
}

export function updateActivationCode(id, payload) {
  const db = getDatabase();
  const record = db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(id);
  if (!record) throw new Error('激活码不存在');

  const maxUses = payload.maxUses !== undefined ? Number(payload.maxUses) : record.max_uses;
  const note = payload.note !== undefined ? String(payload.note) : record.note;
  const creditsValue = payload.creditsValue !== undefined ? Number(payload.creditsValue) : (record.credits_value || 0);
  db.prepare(`
    UPDATE activation_codes SET max_uses = ?, note = ?, credits_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(maxUses, note, creditsValue, id);
  return db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(id);
}

export function deleteActivationCode(id) {
  const db = getDatabase();
  db.prepare('DELETE FROM activation_codes WHERE id = ?').run(id);
}

export default {
  redeemActivationCode,
  listActivationCodes,
  createActivationCode,
  updateActivationCode,
  deleteActivationCode,
};
