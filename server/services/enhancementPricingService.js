/**
 * 火山 AI MediaKit 画质增强计费
 *
 * 基于 MediaKit 官方计费规则（1 元 = 100 积分）：
 *
 *   credits = ceil(durationMinutes × coefficient × baseCreditsPerMinute)
 *
 *   - durationMinutes：输出视频时长（精确到秒，再除以 60）
 *   - coefficient：见下方 COEFFICIENTS 表，由 (tool_version, resolution_tier, fps_tier) 决定
 *   - baseCreditsPerMinute：基础单价，默认 75（= 0.75 元/分钟 × 100 积分/元），
 *     管理员可在「画质增强计费管理」卡片调整加成倍率
 *
 * 计费档位由「输出视频短边像素」决定：
 *   ≤720    → 720p
 *   ≤1080   → 1080p
 *   ≤1440   → 2k
 *   ≤2160   → 4k
 * 帧率档由「输出视频 fps」决定：≤30fps 或 >30fps（>30 单价翻倍）。
 *
 * 提交时按用户选择的 target_resolution / target_fps 估算并锁定积分；
 * MediaKit 任务完成后，按其返回的 result.resolution / result.fps / result.duration
 * 重新计算 actual 并 settle，使账单与上游一致。
 */

import { getDatabase } from '../database/index.js';

export const DEFAULT_BASE_CREDITS_PER_MINUTE = 75; // 0.75 元/分钟 × 100 积分/元
export const LOCK_BUFFER_RATIO = 1.2; // 与视频任务一致，防止上游实扣略高

const COEFFICIENTS = {
  standard: {
    '720p':  { le30: 1,  gt30: 2 },
    '1080p': { le30: 2,  gt30: 4 },
    '2k':    { le30: 4,  gt30: 8 },
    '4k':    { le30: 8,  gt30: 16 },
  },
  professional: {
    '720p':  { le30: 10, gt30: 20 },
    '1080p': { le30: 20, gt30: 40 },
    '2k':    { le30: 40, gt30: 80 },
    '4k':    { le30: 80, gt30: 160 },
  },
};

/** 把任意 resolution 表示（'1080p' / '1920x1080' / 数字短边）归一到 720p|1080p|2k|4k 档 */
export function resolutionTier(value) {
  const s = String(value ?? '').toLowerCase().trim();
  if (s === '720p' || s === '1080p' || s === '2k' || s === '4k') return s;
  const m = s.match(/(\d+)\s*x\s*(\d+)/);
  if (m) {
    const shortEdge = Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
    return shortEdgeToTier(shortEdge);
  }
  const n = parseInt(s, 10);
  if (Number.isFinite(n) && n > 0) return shortEdgeToTier(n);
  return '1080p';
}

function shortEdgeToTier(shortEdge) {
  if (shortEdge <= 720) return '720p';
  if (shortEdge <= 1080) return '1080p';
  if (shortEdge <= 1440) return '2k';
  return '4k';
}

export function fpsTier(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return 'le30';
  return n > 30 ? 'gt30' : 'le30';
}

export function getCoefficient(toolVersion, resolution, fps) {
  const v = COEFFICIENTS[toolVersion];
  if (!v) return null;
  return v[resolutionTier(resolution)]?.[fpsTier(fps)] ?? null;
}

export function getBaseCreditsPerMinute() {
  const row = getDatabase()
    .prepare("SELECT value FROM system_config WHERE key = 'enhancement_base_credits_per_minute'")
    .get();
  const v = parseFloat(row?.value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_BASE_CREDITS_PER_MINUTE;
}

export function setBaseCreditsPerMinute(credits) {
  const v = Math.max(0, parseFloat(credits));
  if (!Number.isFinite(v)) throw new Error('基础单价必须是非负数');
  getDatabase()
    .prepare(
      `INSERT INTO system_config (key, value, description)
       VALUES ('enhancement_base_credits_per_minute', ?, '画质增强基础单价（积分/分钟）')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(v));
}

/**
 * 估算单次画质增强的积分。
 * @param {object} params
 * @param {string} params.toolVersion - 'standard' | 'professional'
 * @param {string|number} params.resolution - 输出分辨率（'1080p' / '1920x1080' / 1080）
 * @param {number} params.fps - 输出帧率
 * @param {number} params.durationSec - 输出时长（秒），按毫秒精度若有也可传小数
 * @returns {{ credits: number, lockedCredits: number, coefficient: number, baseCreditsPerMinute: number, durationMinutes: number, resolutionTier: string, fpsTier: string }}
 */
export function estimate({ toolVersion, resolution, fps, durationSec }) {
  const coefficient = getCoefficient(toolVersion, resolution, fps);
  const baseCreditsPerMinute = getBaseCreditsPerMinute();
  if (coefficient == null) {
    return {
      credits: 0,
      lockedCredits: 0,
      coefficient: 0,
      baseCreditsPerMinute,
      durationMinutes: 0,
      resolutionTier: resolutionTier(resolution),
      fpsTier: fpsTier(fps),
    };
  }
  const safeDur = Math.max(0, Number(durationSec) || 0);
  const durationMinutes = safeDur / 60;
  const raw = durationMinutes * coefficient * baseCreditsPerMinute;
  const credits = Math.max(0, Math.ceil(raw));
  const lockedCredits = Math.max(credits, Math.ceil(credits * LOCK_BUFFER_RATIO));
  return {
    credits,
    lockedCredits,
    coefficient,
    baseCreditsPerMinute,
    durationMinutes,
    resolutionTier: resolutionTier(resolution),
    fpsTier: fpsTier(fps),
  };
}

/** 完整系数表，供前端展示「计费规则」表格 */
export function getCoefficientTable() {
  const rows = [];
  for (const [tv, byRes] of Object.entries(COEFFICIENTS)) {
    for (const [res, byFps] of Object.entries(byRes)) {
      for (const [fps, c] of Object.entries(byFps)) {
        rows.push({ tool_version: tv, resolution_tier: res, fps_tier: fps, coefficient: c });
      }
    }
  }
  return rows;
}

export default {
  COEFFICIENTS,
  DEFAULT_BASE_CREDITS_PER_MINUTE,
  LOCK_BUFFER_RATIO,
  resolutionTier,
  fpsTier,
  getCoefficient,
  getBaseCreditsPerMinute,
  setBaseCreditsPerMinute,
  estimate,
  getCoefficientTable,
};
