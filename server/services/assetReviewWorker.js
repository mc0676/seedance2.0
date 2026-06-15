/**
 * 素材审核状态后台轮询器
 *
 * 定时扫描 project_assets 表中 review_status='pending' 且有 volc_asset_id 的记录，
 * 调用 ARK GetAsset 同步审核状态：
 *   - Active / enabled  → review_status='approved', status='active'
 *   - Failed / disabled → review_status='rejected', status='rejected'
 *   - 其他              → 保持 pending（下个 tick 再查）
 *
 * 火山引擎审核通常 10 分钟内完成，最短 30 秒后才有结果。
 * 仅轮询创建时间 >30s 的记录，避免创建即查浪费 API 调用。
 */

import { getDatabase } from '../database/index.js';
import { syncAssetReviewFromVolc } from './assetService.js';

const POLL_INTERVAL_MS = 30_000;
const MIN_AGE_SECONDS = 30;

let timer = null;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT id, project_id, name, volc_asset_id
       FROM project_assets
       WHERE review_status = 'pending'
         AND volc_asset_id IS NOT NULL
         AND status = 'active'
         AND created_at <= datetime('now', '-${MIN_AGE_SECONDS} seconds')
       ORDER BY created_at ASC`
    ).all();

    if (rows.length === 0) return;

    console.log(`[asset-review worker] 发现 ${rows.length} 个待同步素材`);
    for (const row of rows) {
      try {
        const updated = await syncAssetReviewFromVolc(row.id, row.project_id);
        if (updated.review_status !== 'pending') {
          console.log(`[asset-review worker] #${row.id} "${row.name?.substring(0, 30)}" → ${updated.review_status}`);
        }
      } catch (e) {
        console.error(`[asset-review worker] #${row.id} 同步失败:`, e.message);
      }
    }
  } catch (e) {
    console.error('[asset-review worker] tick 异常:', e.message);
  } finally {
    ticking = false;
  }
}

export function start() {
  if (timer) return;
  console.log(`[asset-review worker] 启动，间隔 ${POLL_INTERVAL_MS / 1000}s，最小素材年龄 ${MIN_AGE_SECONDS}s`);
  // 启动 5s 后首次执行（catch-up）
  setTimeout(() => { void tick(); }, 5_000);
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export default { start };
