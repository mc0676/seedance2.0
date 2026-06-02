import { getDatabase } from '../database/index.js';

export function redeemActivationCode(userId, code) {
  const db = getDatabase();
  const trimmed = String(code || '').trim();
  if (!trimmed) throw new Error('激活码不能为空');

  const record = db.prepare(`SELECT * FROM activation_codes WHERE code = ?`).get(trimmed);
  if (!record) throw new Error('激活码无效');
  if (record.used_count >= record.max_uses) throw new Error('激活码已达到最大使用次数');
  // 检查是否过期（每日额度激活码有时限）
  if (record.time_of_expiration) {
    const exp = new Date(record.time_of_expiration);
    if (!isNaN(exp.getTime()) && new Date() > exp) throw new Error('激活码已过期');
  }

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
    INSERT INTO activation_codes (code, max_uses, note, credits_value, created_by, is_credit_daily, time_of_expiration)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(code, maxUses, note, creditsValue, createdBy,
    payload.is_credit_daily === 1 ? 1 : payload.is_credit_daily === 0 ? 0 : null,
    payload.time_of_expiration || null
  );
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
  const record = db.prepare('SELECT * FROM activation_codes WHERE id = ?').get(id);
  if (!record) return;
  // 自费激活码（is_credit_daily = 0）删除时退还剩余未使用积分
  if (record.is_credit_daily === 0 && record.created_by) {
    const unused = (record.max_uses - record.used_count) * record.credits_value;
    if (unused > 0) {
      // 还原到管理员账户
      db.prepare(`UPDATE users SET credits = credits + ? WHERE id = ?`).run(unused, record.created_by);
      // 记录退还日志
      db.prepare(`
        INSERT INTO credit_distribution_logs (admin_id, recipient_id, credits_amount, method, note)
        VALUES (?, ?, ?, 'code_refund', ?)
      `).run(record.created_by, record.created_by, unused, `删除激活码退还盈余积分: ${record.code || ''}`);
    }
  }
  db.prepare('DELETE FROM activation_codes WHERE id = ?').run(id);
}

export default {
  redeemActivationCode,
  listActivationCodes,
  createActivationCode,
  updateActivationCode,
  deleteActivationCode,
};