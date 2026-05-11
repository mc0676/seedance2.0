/**
 * 画质增强后台轮询器
 *
 * 定时扫描 video_enhancements 表中 status='processing' 的记录，
 * 调用 MediaKit getEnhanceTask 同步状态：
 *   - completed → 写入 enhanced_video_url，settle 积分
 *   - failed    → 写入 error_message，release 积分
 *   - 其它      → 跳过
 *
 * MediaKit 处理耗时数分钟～数十分钟，30s 轮询足够。
 */

import { getDatabase } from '../database/index.js';
import { getEnhanceTask } from './mediaKitService.js';
import { settleForEnhancement, releaseForEnhancement } from './creditLockService.js';

const POLL_INTERVAL_MS = 30_000;
const MAX_RUNNING_HOURS = 48;

let timer = null;
let ticking = false;
const seenStatuses = new Set();

function getApiKey() {
  const row = getDatabase().prepare("SELECT value FROM system_config WHERE key = 'mediakit_api_key'").get();
  return row?.value || '';
}

function getPricing(toolVersion) {
  return getDatabase().prepare(
    `SELECT credits_per_second FROM enhancement_pricing WHERE tool_version = ? AND enabled = 1`
  ).get(toolVersion);
}

async function syncOne(row) {
  const db = getDatabase();
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn(`[增强 worker] MediaKit Key 未配置，跳过 enhancement=${row.id}`);
    return;
  }
  if (!row.mediakit_task_id) {
    console.warn(`[增强 worker] enhancement=${row.id} 无 mediakit_task_id`);
    return;
  }

  let resp;
  try {
    resp = await getEnhanceTask({ apiKey, taskId: row.mediakit_task_id });
  } catch (e) {
    console.error(`[增强 worker] enhancement=${row.id} 查询异常:`, e.message);
    return; // 暂时性错误，下个 tick 再试
  }

  const status = String(resp?.status || '').toLowerCase();
  const isDone = ['success', 'completed', 'done', 'succeeded'].includes(status);
  const isFailed = ['failed', 'error', 'fail'].includes(status);
  // MediaKit 文档示例字段为 output，旧代码读 result，这里兼容两者
  const payload = resp?.output || resp?.result || {};

  if (isDone) {
    const result = payload;
    const videoUrl = result.video_url;
    const duration = Math.max(1, Math.round(Number(result.duration) || row.duration_seconds || 0));
    const pricing = getPricing(row.tool_version);
    const cps = pricing?.credits_per_second || 0;
    const user = db.prepare('SELECT unlimited_credits FROM users WHERE id = ?').get(row.user_id);
    const actualCredits = user?.unlimited_credits ? 0 : duration * cps;

    db.prepare(
      `UPDATE video_enhancements
       SET status='done', enhanced_video_url=?, duration_seconds=?, credits_used=?, finished_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).run(videoUrl || null, duration, actualCredits, row.id);
    try {
      settleForEnhancement({ enhancementId: row.id, actualCredits });
    } catch (e) {
      console.error(`[增强 worker] settle 失败 enhancement=${row.id}:`, e.message);
    }
    console.log(`[增强 worker] enhancement=${row.id} 完成，duration=${duration}s 积分=${actualCredits}`);
  } else if (isFailed) {
    const errMsg = resp?.error?.message || resp?.message || '画质增强失败';
    db.prepare(
      `UPDATE video_enhancements SET status='error', error_message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`
    ).run(errMsg, row.id);
    try {
      releaseForEnhancement({ enhancementId: row.id, reason: errMsg });
    } catch (e) {
      console.error(`[增强 worker] release 失败 enhancement=${row.id}:`, e.message);
    }
    console.log(`[增强 worker] enhancement=${row.id} 失败：${errMsg}`);
  } else {
    // pending / running / queueing / 未知 → 不变；首次轮询打一次原始响应方便排查
    if (!seenStatuses.has(status)) {
      seenStatuses.add(status);
      console.log(`[增强 worker] enhancement=${row.id} 状态=${status || '(空)'} resp=${JSON.stringify(resp)}`);
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // 1) 先把超过 48h 还卡在 processing 的标记为 error 并退积分，下次不再轮询
    const expired = getDatabase().prepare(
      `SELECT id FROM video_enhancements
       WHERE status='processing'
         AND created_at <= datetime('now', '-${MAX_RUNNING_HOURS} hours')`
    ).all();
    for (const e of expired) {
      const errMsg = `任务超过 ${MAX_RUNNING_HOURS}h 未完成，自动标记失败`;
      getDatabase().prepare(
        `UPDATE video_enhancements SET status='error', error_message=?, finished_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(errMsg, e.id);
      try {
        releaseForEnhancement({ enhancementId: e.id, reason: errMsg });
      } catch (err) {
        console.error(`[增强 worker] 超时 release 失败 enhancement=${e.id}:`, err.message);
      }
      console.log(`[增强 worker] enhancement=${e.id} 超时(>${MAX_RUNNING_HOURS}h)，已标记 error 并退积分`);
    }

    // 2) 处理仍在窗口内的任务
    const rows = getDatabase().prepare(
      `SELECT * FROM video_enhancements
       WHERE status='processing'
         AND mediakit_task_id IS NOT NULL
         AND created_at > datetime('now', '-${MAX_RUNNING_HOURS} hours')`
    ).all();
    if (rows.length === 0) return;
    // 串行调用，避免一次性给 MediaKit 太大压力（默认并发 20 是任务并发，不是查询）
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await syncOne(row);
    }
  } catch (e) {
    console.error('[增强 worker] tick 异常:', e.message);
  } finally {
    ticking = false;
  }
}

export function start() {
  if (timer) return;
  console.log(`[增强 worker] 启动，间隔 ${POLL_INTERVAL_MS / 1000}s`);
  // 启动 catch-up：避免容器刚重启就漏 tick
  setTimeout(() => { void tick(); }, 5_000);
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export default { start };
