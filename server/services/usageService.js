import { getDatabase } from '../database/index.js';

/**
 * 记录一次 API 调用使用量
 */
export function logUsage({ userId, taskId = null, model, action = 'generate_video', creditsCost = 1, status = 'success', errorMessage = null }) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, taskId, model, action, creditsCost, status, errorMessage);
}

/**
 * 检查用户是否有可用额度（积分 > 0 或 unlimited_credits = 1）
 */
export function checkUserQuota(userId) {
  const db = getDatabase();
  const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  if (user.unlimited_credits) return { allowed: true, unlimited: true, credits: user.credits };
  if (user.credits > 0) return { allowed: true, unlimited: false, credits: user.credits };
  return { allowed: false, unlimited: false, credits: 0 };
}

/**
 * 扣减积分 + 记录使用量（atomic）
 */
export function deductAndLog({ userId, taskId = null, model, action = 'generate_video', creditsCost = 1 }) {
  const db = getDatabase();
  const user = db.prepare('SELECT credits, unlimited_credits FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');

  const transaction = db.transaction(() => {
    if (!user.unlimited_credits) {
      if (user.credits < creditsCost) throw new Error(`积分不足（当前 ${user.credits}，需要 ${creditsCost}）`);
      db.prepare('UPDATE users SET credits = credits - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(creditsCost, userId);
    }
    db.prepare(`
      INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status)
      VALUES (?, ?, ?, ?, ?, 'success')
    `).run(userId, taskId, model, action, creditsCost);
  });
  transaction();
}

/**
 * 记录失败的 API 调用（不扣积分）
 */
export function logFailure({ userId, taskId = null, model, action = 'generate_video', errorMessage }) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO usage_logs (user_id, task_id, model, action, credits_cost, status, error_message)
    VALUES (?, ?, ?, ?, 0, 'failed', ?)
  `).run(userId, taskId, model, action, errorMessage);
}

/**
 * 按模型扣减积分（兼容旧调用，固定 1 积分；P0 后所有视频生成走锁定流程，此处不应被调用）
 */
export function deductForModel({ userId, taskId = null, model, action = 'generate_video' }) {
  deductAndLog({ userId, taskId, model, action, creditsCost: 1 });
  return 1;
}

/**
 * 获取用户使用量统计
 */
export function getUserUsageStats(userId, days = 30) {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      model,
      action,
      COUNT(*) as call_count,
      SUM(credits_cost) as total_credits,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
    FROM usage_logs
    WHERE user_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY model, action
    ORDER BY call_count DESC
  `).all(userId, days);
}

/**
 * 管理员获取全量使用量统计
 */
export function getSystemUsageStats(days = 7) {
  const db = getDatabase();
  return {
    byModel: db.prepare(`
      SELECT model, COUNT(*) as call_count, SUM(credits_cost) as total_credits
      FROM usage_logs
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY model ORDER BY call_count DESC
    `).all(days),
    byUser: db.prepare(`
      SELECT u.email, COUNT(*) as call_count, SUM(ul.credits_cost) as total_credits
      FROM usage_logs ul JOIN users u ON ul.user_id = u.id
      WHERE ul.created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY ul.user_id ORDER BY call_count DESC LIMIT 20
    `).all(days),
    daily: db.prepare(`
      SELECT date(created_at) as day, COUNT(*) as call_count
      FROM usage_logs
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day DESC
    `).all(days),
  };
}
