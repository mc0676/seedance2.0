/**
 * HappyHorse 后台轮询器
 *
 * 定时扫描 tasks_happyhorse 表中 status='processing' 的记录，调 DashScope getTask 同步状态：
 *   - SUCCEEDED → 写入 video_url、usage 字段，按真实 usage.duration × rate 结算积分
 *   - FAILED / UNKNOWN → 写入 error_message，释放积分
 *   - PENDING / RUNNING → 跳过
 *
 * DashScope 文档：视频生成约 1-5 分钟，task_id 有效期 24h。
 */

import { getDatabase } from '../database/index.js';
import { getTask } from './happyhorseService.js';
import {
  settleForHappyhorse,
  releaseForHappyhorse,
} from './creditLockService.js';
import { getCreditsPerSecond } from './happyhorsePricingService.js';
import { getActiveDiscount } from './discountService.js';

const POLL_INTERVAL_MS = 30_000;
const MAX_RUNNING_HOURS = 24;

let timer = null;
let ticking = false;

function getApiKey() {
  const row = getDatabase().prepare("SELECT value FROM system_config WHERE key = 'happyhorse_api_key'").get();
  return row?.value || '';
}

function resolutionFromSR(sr) {
  const n = Number(sr);
  if (!Number.isFinite(n)) return null;
  return n >= 1080 ? '1080P' : '720P';
}

async function syncOne(row) {
  const db = getDatabase();
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn(`[happyhorse worker] API Key 未配置，跳过 task=${row.id}`);
    return;
  }
  if (!row.dashscope_task_id) {
    console.warn(`[happyhorse worker] task=${row.id} 无 dashscope_task_id`);
    return;
  }

  let resp;
  try {
    resp = await getTask({ apiKey, taskId: row.dashscope_task_id });
  } catch (e) {
    console.error(`[happyhorse worker] task=${row.id} 查询异常:`, e.message);
    return;
  }

  const status = resp?.task_status;
  if (status === 'SUCCEEDED') {
    const usage = resp.usage || {};
    // 计费秒数：video-edit 用 usage.duration（含输入+输出），其他用 output_video_duration
    const billingSeconds = row.mode === 'video-edit'
      ? Math.max(0, Number(usage.duration) || Number(usage.output_video_duration) || row.duration || 0)
      : Math.max(0, Number(usage.output_video_duration) || Number(usage.duration) || row.duration || 0);
    const realResolution = resolutionFromSR(usage.SR) || row.resolution;
    const rate = getCreditsPerSecond(row.mode, realResolution) ?? 0;

    const user = db.prepare('SELECT unlimited_credits FROM users WHERE id = ?').get(row.user_id);
    let actualCredits = 0;
    if (!user?.unlimited_credits) {
      actualCredits = Math.max(0, Math.ceil(billingSeconds * rate));
      // 应用折扣
      const discount = getActiveDiscount(row.mode, realResolution);
      if (discount && discount.value > 0 && discount.type === 'percent') {
        actualCredits = Math.ceil(actualCredits * (1 - discount.value / 100));
      }
    }

    db.prepare(
      `UPDATE tasks_happyhorse
       SET status='done', video_url=?, request_id=?,
           result_duration=?, result_output_duration=?, result_input_duration=?,
           result_resolution=?, result_ratio=?,
           credits_used=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).run(
      resp.video_url || null,
      resp.request_id || null,
      Number(usage.duration) || null,
      Number(usage.output_video_duration) || null,
      Number(usage.input_video_duration) || null,
      Number(usage.SR) || null,
      usage.ratio || null,
      actualCredits,
      row.id,
    );
    try {
      settleForHappyhorse({ happyhorseTaskId: row.id, actualCredits });
    } catch (e) {
      console.error(`[happyhorse worker] settle 失败 task=${row.id}:`, e.message);
    }
    console.log(`[happyhorse worker] task=${row.id} 完成 sec=${billingSeconds} res=${realResolution} 实扣=${actualCredits}`);
  } else if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
    const errMsg = resp.message || resp.code || (status === 'UNKNOWN' ? '任务不存在或已过期' : `HappyHorse 任务${status}`);
    db.prepare(
      `UPDATE tasks_happyhorse SET status='error', error_message=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).run(errMsg, row.id);
    try {
      releaseForHappyhorse({ happyhorseTaskId: row.id, reason: errMsg });
    } catch (e) {
      console.error(`[happyhorse worker] release 失败 task=${row.id}:`, e.message);
    }
    console.log(`[happyhorse worker] task=${row.id} 失败：${errMsg}`);
  }
  // PENDING / RUNNING：下个 tick 再查
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // 1) 超时（>24h）的任务直接标失败并退款
    const expired = getDatabase().prepare(
      `SELECT id FROM tasks_happyhorse
       WHERE status='processing' AND deleted_at IS NULL
         AND created_at <= datetime('now', '-${MAX_RUNNING_HOURS} hours')`
    ).all();
    for (const e of expired) {
      const errMsg = `任务超过 ${MAX_RUNNING_HOURS}h 未完成，自动标记失败`;
      getDatabase().prepare(
        `UPDATE tasks_happyhorse SET status='error', error_message=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(errMsg, e.id);
      try {
        releaseForHappyhorse({ happyhorseTaskId: e.id, reason: errMsg });
      } catch (err) {
        console.error(`[happyhorse worker] 超时 release 失败 task=${e.id}:`, err.message);
      }
      console.log(`[happyhorse worker] task=${e.id} 超时(>${MAX_RUNNING_HOURS}h)，已标记 error 并退积分`);
    }

    // 2) 处理仍在窗口内的任务
    const rows = getDatabase().prepare(
      `SELECT * FROM tasks_happyhorse
       WHERE status='processing' AND deleted_at IS NULL
         AND dashscope_task_id IS NOT NULL
         AND created_at > datetime('now', '-${MAX_RUNNING_HOURS} hours')`
    ).all();
    if (rows.length === 0) return;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await syncOne(row);
    }
  } catch (e) {
    console.error('[happyhorse worker] tick 异常:', e.message);
  } finally {
    ticking = false;
  }
}

export function start() {
  if (timer) return;
  console.log(`[happyhorse worker] 启动，间隔 ${POLL_INTERVAL_MS / 1000}s`);
  setTimeout(() => { void tick(); }, 5_000);
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export default { start };
