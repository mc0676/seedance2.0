import { getDatabase } from '../database/index.js';
import { getActiveDiscount } from './discountService.js';

const DO_SHOW_STATUS_OF_ESTIMATION_OF_VOLC = ['1', 'true'].includes((process.env.SHOW_STATUS_OF_ESTIMATION_OF_VOLC || '').toLowerCase());

/**
 * 分辨率档位 → 默认像素（按 16:9 标准），其他比例由 ratio 缩放推断。
 * 参考火山官网 Seedance 2.0 / Fast 标准输出。
 */
const RESOLUTION_BASE = {
  '480p':  { width: 858,  height: 480  },
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
};

const LOCK_BUFFER_RATIO = 1.2; // 锁定时多锁 20%，避免实扣超出穿透余额

/**
 * 由分辨率档位 + 宽高比推断 (W, H)。
 *
 * 实测火山方舟在同一分辨率档位下，不同宽高比的输出帧像素数大致相等
 * （480p 档约 411k 像素，720p 档约 922k，1080p 档约 2073k）。
 * 因此估算时按"基准面积守恒"分配宽高，而不是按短边对齐——后者会在
 * 1:1 / 4:3 等非 16:9 比例下严重低估 token，导致估算与实扣偏差很大。
 *
 * 例如 480p 1:1：基准面积 858×480 ≈ 411840，则 W=H=√411840 ≈ 642。
 */
export function resolveDimensions(resolution = '720p', ratio = '16:9') {
  const base = RESOLUTION_BASE[resolution] || RESOLUTION_BASE['720p'];
  const [w, h] = String(ratio || '16:9').split(':').map(Number);
  if (!w || !h) return base;
  const baseArea = base.width * base.height;
  const longRatio = Math.max(w, h);
  const shortRatio = Math.min(w, h);
  const shortSide = Math.sqrt((baseArea * shortRatio) / longRatio);
  const longSide = baseArea / shortSide;
  const isPortrait = h > w;
  return isPortrait
    ? { width: Math.round(shortSide), height: Math.round(longSide) }
    : { width: Math.round(longSide),  height: Math.round(shortSide) };
}

/**
 * 估算 token 用量
 * 公式：(input_dur + output_dur) × W × H × fps / 1024
 */
export function estimateTokens({
  inputDurationSec = 0,
  outputDurationSec = 5,
  resolution = '720p',
  ratio = '16:9',
  fps = 24,
}) {
  const { width, height } = resolveDimensions(resolution, ratio);
  return Math.ceil(((Number(inputDurationSec) || 0) + (Number(outputDurationSec) || 0)) * width * height * fps / 1024);
}

/**
 * 选取单价（元/百万 token）
 */
export function pickUnitPrice(pricing, { hasVideoInput = false, resolution = '720p', hasAudio = false }) {
  if (!pricing) return 0;
  if (pricing.pricing_type === 'seedance15') {
    return hasAudio ? Number(pricing.price_audio) : Number(pricing.price_silent);
  }
  // seedance2 系列
  const isHigh = resolution === '1080p';
  if (hasVideoInput) {
    return isHigh ? Number(pricing.price_with_video_high) : Number(pricing.price_with_video_low);
  }
  return isHigh ? Number(pricing.price_no_video_high) : Number(pricing.price_no_video_low);
}

/**
 * 选取计费字段名（用于折扣匹配）
 */
export function pickSubKey(pricing, { hasVideoInput = false, resolution = '720p', hasAudio = false }) {
  if (!pricing) return null;
  if (pricing.pricing_type === 'seedance15') {
    return hasAudio ? 'price_audio' : 'price_silent';
  }
  const isHigh = resolution === '1080p';
  if (hasVideoInput) {
    return isHigh ? 'price_with_video_high' : 'price_with_video_low';
  }
  return isHigh ? 'price_no_video_high' : 'price_no_video_low';
}

/**
 * 元 → 积分（向上取整，1元=100积分）
 */
export function yuanToCredits(yuan) {
  if (!yuan || yuan <= 0) return 0;
  return Math.ceil(yuan * 100);
}

/**
 * tokens × 单价 × draft 折算 → 元 → 积分
 */
export function calculateCredits({ tokens, unitPriceYuanPerMTok, draftFactor = 1 }) {
  const yuan = (Number(tokens) || 0) * (Number(unitPriceYuanPerMTok) || 0) / 1_000_000 * (Number(draftFactor) || 1);
  return yuanToCredits(yuan);
}

/**
 * 一站式估算：返回 {tokens, unitPrice, yuan, credits, lockedCredits, discountedCredits?}
 */
export function estimate(modelKey, params = {}) {
  const pricing = getModel(modelKey);
  if (!pricing) {
    return { tokens: 0, unitPrice: 0, yuan: 0, credits: 0, lockedCredits: 0, model: modelKey, warn: '未找到模型计费配置' };
  }
  const fps = params.fps || pricing.default_fps || 24;
  const tokens = estimateTokens({ ...params, fps });
  const unitPrice = pickUnitPrice(pricing, params);
  const draftFactor = params.isDraft
    ? (params.hasAudio ? pricing.draft_factor_audio : pricing.draft_factor_silent)
    : 1;
  const credits = calculateCredits({ tokens, unitPriceYuanPerMTok: unitPrice, draftFactor });
  const lockedCredits = Math.ceil(credits * LOCK_BUFFER_RATIO);
  const yuan = credits / 100;

  // 查询活跃折扣
  const subKey = pickSubKey(pricing, params);
  let discountedCredits = credits;
  let discountedLockedCredits = lockedCredits;
  let hasDiscount = false;
  if (subKey) {
    const discount = getActiveDiscount(modelKey, subKey);
    if (discount && discount.value > 0) {
      hasDiscount = true;
      if (discount.type === 'percent') {
        discountedCredits = Math.ceil(credits * (1 - discount.value / 100));
        discountedLockedCredits = Math.ceil(discountedCredits * LOCK_BUFFER_RATIO);
      }
    }
  }

  if (DO_SHOW_STATUS_OF_ESTIMATION_OF_VOLC) {
    console.log(`[计费][estimate] model=${modelKey} resolution=${params.resolution || '720p'} ratio=${params.ratio || '16:9'} outDur=${params.outputDurationSec || 5}s inDur=${params.inputDurationSec || 0}s hasVideo=${!!params.hasVideoInput} hasAudio=${!!params.hasAudio} draft=${!!params.isDraft} fps=${fps} → tokens=${tokens} unitPrice=${unitPrice}元/M draftFactor=${draftFactor} yuan=${yuan} credits=${credits} locked=${lockedCredits}${hasDiscount ? ` discounted=${discountedCredits}` : ''}`);
  }
  return { tokens, unitPrice, draftFactor, yuan, credits, lockedCredits, model: modelKey, ...(hasDiscount ? { discountedCredits, discountedLockedCredits } : {}) };
}

/**
 * 任务完成后：用 Ark API 返回的 completion_tokens 计算实际积分
 */
export function actualCredits(modelKey, completionTokens, params = {}) {
  const pricing = getModel(modelKey);
  if (!pricing) {
    console.warn(`[计费][actual] model=${modelKey} 未找到计费配置，按 0 处理`);
    return 0;
  }
  const tokens = Number(completionTokens) || 0;
  if (tokens <= 0) {
    console.log(`[计费][actual] model=${modelKey} tokens=0，未计费`);
    return 0;
  }
  const unitPrice = pickUnitPrice(pricing, params);
  const draftFactor = params.isDraft
    ? (params.hasAudio ? pricing.draft_factor_audio : pricing.draft_factor_silent)
    : 1;
  const credits = calculateCredits({ tokens, unitPriceYuanPerMTok: unitPrice, draftFactor });
  console.log(`[计费][actual] model=${modelKey} tokens=${tokens}（火山真值） unitPrice=${unitPrice}元/M draftFactor=${draftFactor} yuan=${credits/100} credits=${credits}`);
  return credits;
}

// ============================================================
// 模型计费 CRUD（给 server/index.js 路由用）
// ============================================================

export function listAll() {
  return getDatabase().prepare(`SELECT * FROM model_pricing ORDER BY sort_order ASC, model_key ASC`).all();
}

export function listEnabled() {
  return getDatabase().prepare(`SELECT * FROM model_pricing WHERE enabled = 1 ORDER BY sort_order ASC`).all();
}

export function getModel(modelKey) {
  if (!modelKey) return null;
  return getDatabase().prepare(`SELECT * FROM model_pricing WHERE model_key = ?`).get(modelKey) || null;
}

const COLUMNS = [
  'label', 'pricing_type',
  'price_no_video_low', 'price_no_video_high', 'price_with_video_low', 'price_with_video_high',
  'price_audio', 'price_silent', 'draft_factor_audio', 'draft_factor_silent',
  'default_fps', 'enabled', 'sort_order', 'description',
];

export function upsert(modelKey, data) {
  if (!modelKey) throw new Error('model_key 必填');
  if (!data?.label) throw new Error('label 必填');
  const db = getDatabase();
  const values = {
    model_key: modelKey,
    label: data.label,
    pricing_type: data.pricing_type === 'seedance15' ? 'seedance15' : 'seedance2',
    price_no_video_low: Number(data.price_no_video_low) || 0,
    price_no_video_high: Number(data.price_no_video_high) || 0,
    price_with_video_low: Number(data.price_with_video_low) || 0,
    price_with_video_high: Number(data.price_with_video_high) || 0,
    price_audio: Number(data.price_audio) || 0,
    price_silent: Number(data.price_silent) || 0,
    draft_factor_audio: Number(data.draft_factor_audio) || 0.6,
    draft_factor_silent: Number(data.draft_factor_silent) || 0.7,
    default_fps: Number(data.default_fps) || 24,
    enabled: data.enabled ? 1 : 0,
    sort_order: Number(data.sort_order) || 0,
    description: data.description || null,
  };
  db.prepare(`
    INSERT INTO model_pricing
      (${['model_key', ...COLUMNS].join(',')}, updated_at)
    VALUES (${['@model_key', ...COLUMNS.map((c) => '@' + c)].join(',')}, CURRENT_TIMESTAMP)
    ON CONFLICT(model_key) DO UPDATE SET
      ${COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')},
      updated_at = CURRENT_TIMESTAMP
  `).run(values);
  return getModel(modelKey);
}

export function remove(modelKey) {
  getDatabase().prepare(`DELETE FROM model_pricing WHERE model_key = ?`).run(modelKey);
}

export default {
  estimate,
  actualCredits,
  estimateTokens,
  yuanToCredits,
  resolveDimensions,
  pickUnitPrice,
  pickSubKey,
  listAll,
  listEnabled,
  getModel,
  upsert,
  remove,
  LOCK_BUFFER_RATIO,
};
