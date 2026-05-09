import { getDatabase } from '../database/index.js';

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function getById(lockId) {
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE id = ?`).get(lockId) || null;
}

function _settle(lockRow, actualCredits, refLabel) {
  const db = getDatabase();
  const finalCredits = Math.max(0, Math.floor(Number(actualCredits) || 0));
  const refund = lockRow.locked_credits - finalCredits;
  const meta = (() => { try { return JSON.parse(lockRow.meta || '{}'); } catch { return {}; } })();

  if (finalCredits > 0) {
    const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(lockRow.user_id);
    if (user && !user.unlimited_credits) {
      const newCredits = Math.max(0, user.credits - finalCredits);
      db.prepare('UPDATE users SET credits = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newCredits, lockRow.user_id);
      console.log(`[计费][settle] user=${lockRow.user_id} ${refLabel} 锁定=${lockRow.locked_credits} 实扣=${finalCredits} 返还=${refund} 余额 ${user.credits}→${newCredits}`);
    } else {
      console.log(`[计费][settle] user=${lockRow.user_id} ${refLabel} 无限额度 实扣=${finalCredits}`);
    }
  } else {
    console.log(`[计费][settle] user=${lockRow.user_id} ${refLabel} 实扣=0 返还=${lockRow.locked_credits}`);
  }

  db.prepare(`
    UPDATE credit_locks
    SET status = 'settled', actual_credits = ?, settled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(finalCredits, lockRow.id);

  // usage_logs：视频用 task_id，图片用 NULL（image_record_id 记录在 meta）
  const action = meta.type === 'image' ? 'generate_image'
    : meta.type === 'enhancement' ? 'enhance_video'
    : 'generate_video';
  const logTaskId = lockRow.task_id ?? null;
  db.prepare(`
    INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status)
    VALUES (?, ?, ?, ?, ?, 'success')
  `).run(lockRow.user_id, logTaskId, meta.model || '', action, finalCredits);
}

function _release(lockRow, reason, refLabel) {
  const db = getDatabase();
  console.log(`[计费][release] user=${lockRow.user_id} ${refLabel} 解锁=${lockRow.locked_credits} 原因=${reason}`);
  db.prepare(`
    UPDATE credit_locks
    SET status = 'released', release_reason = ?, settled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason || null, lockRow.id);
}

// ── 视频任务接口（taskId 维度，兼容既有代码）──────────────────────────────────

/**
 * 创建视频积分锁。
 * 事务内：校验可用余额（credits - 已锁定），INSERT credit_locks。
 */
export function lock({ userId, taskId, estimatedCredits, lockedCredits, meta = null }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    if (!user.unlimited_credits) {
      const lockedSum = db.prepare(
        `SELECT COALESCE(SUM(locked_credits), 0) AS sum FROM credit_locks WHERE user_id = ? AND status = 'locked'`
      ).get(userId).sum;
      const available = user.credits - lockedSum;
      if (available < lockedCredits) {
        throw new Error(`可用积分不足（可用 ${available}，需要 ${lockedCredits}）`);
      }
      console.log(`[计费][lock] user=${userId} task=${taskId} 余额=${user.credits} 已锁=${lockedSum} 可用=${available} 本次锁定=${lockedCredits}（预估=${estimatedCredits}）`);
    } else {
      console.log(`[计费][lock] user=${userId} task=${taskId} 无限额度 锁定=${lockedCredits}（预估=${estimatedCredits}）`);
    }
    db.prepare(`
      INSERT INTO credit_locks (user_id, task_id, estimated_credits, locked_credits, status, meta)
      VALUES (?, ?, ?, ?, 'locked', ?)
    `).run(userId, taskId, estimatedCredits, lockedCredits, meta ? JSON.stringify(meta) : null);
  });
  tx();
  return getByTask(taskId);
}

/** 视频任务成功结算 */
export function settle({ taskId, actualCredits }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId);
    if (!lockRow) { console.warn(`[计费][settle] task=${taskId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][settle] task=${taskId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _settle(lockRow, actualCredits, `task=${taskId}`);
  });
  tx();
  return getByTask(taskId);
}

/** 视频任务失败/取消释放 */
export function release({ taskId, reason = '' }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId);
    if (!lockRow) { console.warn(`[计费][release] task=${taskId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][release] task=${taskId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _release(lockRow, reason, `task=${taskId}`);
  });
  tx();
  return getByTask(taskId);
}

export function getByTask(taskId) {
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId) || null;
}

// ── 图片任务接口（imageRecordId 维度）───────────────────────────────────────

/**
 * 创建图片积分锁。
 * imageRecordId：已提前插入的 image_records.id（status='pending'）。
 * 固定费率，不需要 token 估算。
 */
export function lockForImage({ userId, imageRecordId, credits, meta = null }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    if (!user.unlimited_credits) {
      const lockedSum = db.prepare(
        `SELECT COALESCE(SUM(locked_credits), 0) AS sum FROM credit_locks WHERE user_id = ? AND status = 'locked'`
      ).get(userId).sum;
      const available = user.credits - lockedSum;
      if (available < credits) {
        throw new Error(`可用积分不足（可用 ${available}，需要 ${credits}）`);
      }
      console.log(`[计费][lockForImage] user=${userId} imageRecord=${imageRecordId} 余额=${user.credits} 已锁=${lockedSum} 可用=${available} 锁定=${credits}`);
    } else {
      console.log(`[计费][lockForImage] user=${userId} imageRecord=${imageRecordId} 无限额度 锁定=${credits}`);
    }
    const metaObj = Object.assign({ type: 'image' }, meta || {});
    db.prepare(`
      INSERT INTO credit_locks (user_id, image_record_id, estimated_credits, locked_credits, status, meta)
      VALUES (?, ?, ?, ?, 'locked', ?)
    `).run(userId, imageRecordId, credits, credits, JSON.stringify(metaObj));
  });
  tx();
  return getByImageRecord(imageRecordId);
}

/** 图片生成成功结算 */
export function settleForImage({ imageRecordId, actualCredits }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE image_record_id = ?`).get(imageRecordId);
    if (!lockRow) { console.warn(`[计费][settleForImage] imageRecord=${imageRecordId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][settleForImage] imageRecord=${imageRecordId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _settle(lockRow, actualCredits, `imageRecord=${imageRecordId}`);
  });
  tx();
  return getByImageRecord(imageRecordId);
}

/** 图片生成失败/超时释放 */
export function releaseForImage({ imageRecordId, reason = '' }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE image_record_id = ?`).get(imageRecordId);
    if (!lockRow) { console.warn(`[计费][releaseForImage] imageRecord=${imageRecordId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][releaseForImage] imageRecord=${imageRecordId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _release(lockRow, reason, `imageRecord=${imageRecordId}`);
  });
  tx();
  return getByImageRecord(imageRecordId);
}

export function getByImageRecord(imageRecordId) {
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE image_record_id = ?`).get(imageRecordId) || null;
}

// ── 画质增强接口（enhancementId 维度）────────────────────────────────────────

export function lockForEnhancement({ userId, enhancementId, credits, meta = null }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    if (!user.unlimited_credits) {
      const lockedSum = db.prepare(
        `SELECT COALESCE(SUM(locked_credits), 0) AS sum FROM credit_locks WHERE user_id = ? AND status = 'locked'`
      ).get(userId).sum;
      const available = user.credits - lockedSum;
      if (available < credits) {
        throw new Error(`可用积分不足（可用 ${available}，需要 ${credits}）`);
      }
      console.log(`[计费][lockForEnhancement] user=${userId} enhancement=${enhancementId} 余额=${user.credits} 已锁=${lockedSum} 可用=${available} 锁定=${credits}`);
    } else {
      console.log(`[计费][lockForEnhancement] user=${userId} enhancement=${enhancementId} 无限额度 锁定=${credits}`);
    }
    const metaObj = Object.assign({ type: 'enhancement' }, meta || {});
    db.prepare(`
      INSERT INTO credit_locks (user_id, enhancement_id, estimated_credits, locked_credits, status, meta)
      VALUES (?, ?, ?, ?, 'locked', ?)
    `).run(userId, enhancementId, credits, credits, JSON.stringify(metaObj));
  });
  tx();
  return getByEnhancement(enhancementId);
}

export function settleForEnhancement({ enhancementId, actualCredits }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE enhancement_id = ?`).get(enhancementId);
    if (!lockRow) { console.warn(`[计费][settleForEnhancement] enhancement=${enhancementId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][settleForEnhancement] enhancement=${enhancementId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _settle(lockRow, actualCredits, `enhancement=${enhancementId}`);
  });
  tx();
  return getByEnhancement(enhancementId);
}

export function releaseForEnhancement({ enhancementId, reason = '' }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE enhancement_id = ?`).get(enhancementId);
    if (!lockRow) { console.warn(`[计费][releaseForEnhancement] enhancement=${enhancementId} 无锁定记录`); return null; }
    if (lockRow.status !== 'locked') { console.warn(`[计费][releaseForEnhancement] enhancement=${enhancementId} 状态已是 ${lockRow.status}，跳过`); return lockRow; }
    _release(lockRow, reason, `enhancement=${enhancementId}`);
  });
  tx();
  return getByEnhancement(enhancementId);
}

export function getByEnhancement(enhancementId) {
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE enhancement_id = ?`).get(enhancementId) || null;
}

// ── 通用工具 ──────────────────────────────────────────────────────────────────

export function getLockedTotal(userId) {
  return getDatabase().prepare(
    `SELECT COALESCE(SUM(locked_credits), 0) AS sum FROM credit_locks WHERE user_id = ? AND status = 'locked'`
  ).get(userId).sum;
}

export function listUserLocks(userId, { onlyActive = true } = {}) {
  const where = onlyActive ? `user_id = ? AND status = 'locked'` : `user_id = ?`;
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE ${where} ORDER BY created_at DESC`).all(userId);
}

export default {
  lock, settle, release, getByTask,
  lockForImage, settleForImage, releaseForImage, getByImageRecord,
  lockForEnhancement, settleForEnhancement, releaseForEnhancement, getByEnhancement,
  getLockedTotal, listUserLocks,
};
