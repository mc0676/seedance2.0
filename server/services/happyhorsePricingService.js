/**
 * HappyHorse 计费（1 元 = 100 积分）
 *
 *   credits = ceil(durationSec × creditsPerSecond)
 *
 * - durationSec：
 *     t2v / i2v / r2v ：仅输出秒数（usage.output_video_duration，提交时按用户请求的 duration 估算）
 *     video-edit       ：输入 + 输出秒数（usage.duration）。
 *       DashScope 规则：输入 ≤ 15s 时输出与输入等长；输入 > 15s 时上游截前 15s，输出也 15s。
 *       提交时若提供 inputVideoDurationSec（用户上传后 probe 出的真实时长），按 effective×2 精确预扣；
 *       否则用 30s 上限保守预扣。
 * - creditsPerSecond：见 model_pricing_happyhorse 表，admin 后台可调
 *
 * 锁定 buffer：与视频/画质增强一致，1.2× 系数防上游实扣略高。
 */

import { getDatabase } from '../database/index.js';

export const LOCK_BUFFER_RATIO = 1.2;
// video-edit 提交时未上传视频或无法 probe 时长的极端兜底：按 15s + 15s 上限
export const VIDEO_EDIT_MAX_SECONDS = 30;
// DashScope 规定输入 / 输出有效上限均为 15s
const VIDEO_EDIT_EFFECTIVE_CAP = 15;

const VALID_MODES = ['t2v', 'i2v', 'r2v', 'video-edit'];
const VALID_RESOLUTIONS = ['720P', '1080P'];

function normalizeMode(mode) {
  return String(mode || '').toLowerCase();
}

function normalizeResolution(res) {
  return String(res || '').toUpperCase();
}

export function getCreditsPerSecond(mode, resolution) {
  const m = normalizeMode(mode);
  const r = normalizeResolution(resolution);
  if (!VALID_MODES.includes(m) || !VALID_RESOLUTIONS.includes(r)) return null;
  const row = getDatabase()
    .prepare(`SELECT credits_per_second FROM model_pricing_happyhorse WHERE mode = ? AND resolution = ?`)
    .get(m, r);
  return row?.credits_per_second != null ? Number(row.credits_per_second) : null;
}

/**
 * 估算单次任务的积分。
 * @param {object} params
 * @param {string} params.mode        - 't2v' | 'i2v' | 'r2v' | 'video-edit'
 * @param {string} params.resolution  - '720P' | '1080P'
 * @param {number} [params.durationSec] - t2v / i2v / r2v 模式的请求时长（输出秒数）
 * @param {number} [params.inputVideoDurationSec] - video-edit 模式的输入视频真实时长（秒）
 * @returns {{ credits: number, lockedCredits: number, creditsPerSecond: number, billingSeconds: number }}
 */
export function estimate({ mode, resolution, durationSec, inputVideoDurationSec }) {
  const m = normalizeMode(mode);
  const r = normalizeResolution(resolution);
  const rate = getCreditsPerSecond(m, r);
  if (rate == null) {
    return { credits: 0, lockedCredits: 0, creditsPerSecond: 0, billingSeconds: 0 };
  }
  let billingSeconds;
  if (m === 'video-edit') {
    const inputDur = Number(inputVideoDurationSec);
    if (Number.isFinite(inputDur) && inputDur > 0) {
      const effective = Math.min(VIDEO_EDIT_EFFECTIVE_CAP, inputDur);
      billingSeconds = effective * 2; // 输入 + 输出（输出与输入等长，最长 15s）
    } else {
      billingSeconds = VIDEO_EDIT_MAX_SECONDS; // 兜底：30s
    }
  } else {
    billingSeconds = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? Number(durationSec)
      : 5; // 默认 5s
  }
  const credits = Math.max(0, Math.ceil(billingSeconds * rate));
  const lockedCredits = Math.max(credits, Math.ceil(credits * LOCK_BUFFER_RATIO));
  return { credits, lockedCredits, creditsPerSecond: rate, billingSeconds };
}

/** 完整价目表，供前端和后台展示 */
export function getPricingTable() {
  return getDatabase()
    .prepare(`SELECT mode, resolution, credits_per_second FROM model_pricing_happyhorse ORDER BY mode, resolution`)
    .all();
}

/** 后台改价 */
export function setPricing({ mode, resolution, creditsPerSecond }) {
  const m = normalizeMode(mode);
  const r = normalizeResolution(resolution);
  if (!VALID_MODES.includes(m)) throw new Error('无效的 mode');
  if (!VALID_RESOLUTIONS.includes(r)) throw new Error('无效的 resolution');
  const v = Math.max(0, parseInt(creditsPerSecond, 10));
  if (!Number.isFinite(v)) throw new Error('credits_per_second 必须为非负整数');
  getDatabase().prepare(
    `INSERT INTO model_pricing_happyhorse (mode, resolution, credits_per_second, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(mode, resolution) DO UPDATE SET
       credits_per_second = excluded.credits_per_second,
       updated_at = CURRENT_TIMESTAMP`
  ).run(m, r, v);
  return { mode: m, resolution: r, credits_per_second: v };
}

export default {
  LOCK_BUFFER_RATIO,
  VIDEO_EDIT_MAX_SECONDS,
  getCreditsPerSecond,
  estimate,
  getPricingTable,
  setPricing,
};
