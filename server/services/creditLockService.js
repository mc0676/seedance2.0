import { getDatabase } from '../database/index.js';

/**
 * 创建积分锁。事务内：
 *  1. 校验余额（user.credits - 已锁定 >= lockedCredits）
 *  2. INSERT credit_locks
 * 不立即扣减 user.credits，仅"占位"。
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

/**
 * 任务完成成功：按 actual_credits 实际扣减；返还差额（lockedCredits - actual）。
 * actual=0 等同 release。
 */
export function settle({ taskId, actualCredits }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId);
    if (!lockRow) {
      console.warn(`[计费][settle] task=${taskId} 无锁定记录`);
      return null;
    }
    if (lockRow.status !== 'locked') {
      console.warn(`[计费][settle] task=${taskId} 状态已是 ${lockRow.status}，跳过`);
      return lockRow;
    }

    const finalCredits = Math.max(0, Math.floor(Number(actualCredits) || 0));
    const refund = lockRow.locked_credits - finalCredits;
    if (finalCredits > 0) {
      const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(lockRow.user_id);
      if (user && !user.unlimited_credits) {
        const newCredits = Math.max(0, user.credits - finalCredits);
        db.prepare('UPDATE users SET credits = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newCredits, lockRow.user_id);
        console.log(`[计费][settle] user=${lockRow.user_id} task=${taskId} 锁定=${lockRow.locked_credits} 实扣=${finalCredits} 返还=${refund} 余额 ${user.credits}→${newCredits}`);
      } else {
        console.log(`[计费][settle] user=${lockRow.user_id} task=${taskId} 无限额度 实扣=${finalCredits}`);
      }
    } else {
      console.log(`[计费][settle] user=${lockRow.user_id} task=${taskId} 实扣=0 返还=${lockRow.locked_credits}`);
    }
    db.prepare(`
      UPDATE credit_locks
      SET status = 'settled', actual_credits = ?, settled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(finalCredits, lockRow.id);
    db.prepare(`
      INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status)
      VALUES (?, ?, ?, 'generate_video', ?, 'success')
    `).run(
      lockRow.user_id,
      taskId,
      (() => { try { return JSON.parse(lockRow.meta || '{}').model || ''; } catch { return ''; } })(),
      finalCredits,
    );
  });
  tx();
  return getByTask(taskId);
}

/**
 * 任务失败/审核拒/取消：解除锁定不扣分。
 */
export function release({ taskId, reason = '' }) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const lockRow = db.prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId);
    if (!lockRow) {
      console.warn(`[计费][release] task=${taskId} 无锁定记录`);
      return null;
    }
    if (lockRow.status !== 'locked') {
      console.warn(`[计费][release] task=${taskId} 状态已是 ${lockRow.status}，跳过`);
      return lockRow;
    }
    console.log(`[计费][release] user=${lockRow.user_id} task=${taskId} 解锁=${lockRow.locked_credits} 原因=${reason}`);
    db.prepare(`
      UPDATE credit_locks
      SET status = 'released', release_reason = ?, settled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason || null, lockRow.id);
  });
  tx();
  return getByTask(taskId);
}

export function getByTask(taskId) {
  return getDatabase().prepare(`SELECT * FROM credit_locks WHERE task_id = ?`).get(taskId) || null;
}

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
  lock,
  settle,
  release,
  getByTask,
  getLockedTotal,
  listUserLocks,
};
