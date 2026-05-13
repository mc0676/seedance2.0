/**
 * 音频生成记录服务
 *
 * audio_generations 是元数据/聚合表：
 *  - 参考图 URL、语气提示词
 *  - 关联的中间视频 task_id（task_kind='audio_intermediate'）
 *  - 状态（pending/generating/done/error）
 *  - 完成后写入中间视频 URL，由前端用 Web Audio API + lamejs 转 mp3
 *
 * 积分锁定/结算复用现有 creditLockService.lock(taskId)，不在本表上挂钩。
 */
import { getDatabase } from '../database/index.js';

export function createAudioGeneration({ taskId, userId, projectId, referenceImageUrl, voicePrompt }) {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO audio_generations (task_id, user_id, project_id, reference_image_url, voice_prompt, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(taskId, userId, projectId || null, referenceImageUrl, voicePrompt);
  return getById(result.lastInsertRowid);
}

export function getById(id) {
  return getDatabase().prepare(`SELECT * FROM audio_generations WHERE id = ?`).get(id);
}

// 工作组共享：管理员看全部；普通用户看自己创建的 + 同 project_members 其他成员创建的
export function getByIdForUser(id, userId, isAdmin = false) {
  if (isAdmin) return getById(id);
  return getDatabase().prepare(`
    SELECT * FROM audio_generations
    WHERE id = ? AND (
      user_id = ? OR EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = audio_generations.project_id AND pm.user_id = ?
      )
    )
  `).get(id, userId, userId);
}

export function markGenerating(id) {
  getDatabase().prepare(`UPDATE audio_generations SET status='generating' WHERE id = ? AND status='pending'`).run(id);
}

export function markDone(id, intermediateVideoUrl, creditsUsed) {
  getDatabase().prepare(`
    UPDATE audio_generations
    SET status='done', intermediate_video_url=?, credits_used=?, finished_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(intermediateVideoUrl || null, creditsUsed || 0, id);
}

export function markError(id, errorMessage) {
  getDatabase().prepare(`
    UPDATE audio_generations
    SET status='error', error_message=?, finished_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(errorMessage || '生成失败', id);
}

export function listByUser({ userId, isAdmin = false, page = 1, pageSize = 20 }) {
  const db = getDatabase();
  const offset = (page - 1) * pageSize;
  // 工作组共享，与视频生成历史一致；过滤已软删
  const ownership = isAdmin ? '1=1' : `(
    a.user_id = ? OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = a.project_id AND pm.user_id = ?
    )
  )`;
  const where = `a.deleted_at IS NULL AND ${ownership}`;
  const params = isAdmin ? [] : [userId, userId];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audio_generations a WHERE ${where}`).get(...params).n;
  const items = db.prepare(`
    SELECT a.id, a.task_id, a.user_id, a.project_id, a.reference_image_url, a.voice_prompt,
           a.status, a.intermediate_video_url, a.credits_used, a.error_message,
           a.created_at, a.finished_at,
           t.status AS task_status, t.video_url AS task_video_url, t.progress AS task_progress
    FROM audio_generations a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);
  return { items, total, page, pageSize };
}

export default {
  createAudioGeneration,
  getById,
  getByIdForUser,
  markGenerating,
  markDone,
  markError,
  listByUser,
};
