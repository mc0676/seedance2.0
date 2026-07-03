import type {
  ApiResponse, HappyhorseTask, HappyhorseMode, HappyhorseResolution,
  HappyhorseRatio, HappyhorseMediaItem, HappyhorsePricingItem,
} from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

async function asJson<T>(res: Response, fallback: string): Promise<T> {
  const ct = res.headers.get('content-type') || '';
  let data: ApiResponse<T> | null = null;
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || fallback);
  }
  return data.data as T;
}

export interface HappyhorseSubmitParams {
  projectId: number;
  mode: HappyhorseMode;
  prompt: string;
  resolution: HappyhorseResolution;
  ratio?: HappyhorseRatio;
  duration?: number;
  media?: HappyhorseMediaItem[];
  watermark?: boolean;
  audioSetting?: 'auto' | 'origin';
  seed?: number;
  /** video-edit 模式：用户上传视频的真实时长（秒），用于精确预扣 */
  inputVideoDurationSec?: number;
  /** 批量生成数量 */
  batchSize?: number;
}

export interface HappyhorseSubmitResult {
  task: HappyhorseTask;
  tasks?: HappyhorseTask[];       // 批量生成时返回多个任务
  concurrent_id?: string;         // 批量生成批次 ID
  estimatedCredits: number;
  lockedCredits: number;
}

export async function submitHappyhorseTask(params: HappyhorseSubmitParams): Promise<HappyhorseSubmitResult> {
  const res = await fetch(`${API_BASE}/happyhorse-tasks`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
  });
  const ct = res.headers.get('content-type') || '';
  let body: { success?: boolean; error?: string; data?: HappyhorseTask | { tasks: HappyhorseTask[]; concurrent_id: string }; estimatedCredits?: number; lockedCredits?: number } = {};
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error || `提交 HappyHorse 任务失败（HTTP ${res.status})`);
  }
  // 批量生成：data 是 { tasks: [...], concurrent_id: '...' }
  if (body.data && typeof body.data === 'object' && 'tasks' in body.data && Array.isArray(body.data.tasks)) {
    const batchData = body.data as { tasks: HappyhorseTask[]; concurrent_id: string };
    return {
      task: batchData.tasks[0],
      tasks: batchData.tasks,
      concurrent_id: batchData.concurrent_id,
      estimatedCredits: body.estimatedCredits || 0,
      lockedCredits: body.lockedCredits || 0,
    };
  }
  return { task: body.data as HappyhorseTask, estimatedCredits: body.estimatedCredits || 0, lockedCredits: body.lockedCredits || 0 };
}

export interface HappyhorseListResult {
  items: HappyhorseTask[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listMyHappyhorseTasks(projectId?: number, page = 1, pageSize = 20): Promise<HappyhorseListResult> {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (projectId) qs.set('projectId', String(projectId));
  const res = await fetch(`${API_BASE}/happyhorse-tasks?${qs}`, { headers: getAuthHeaders() });
  return asJson<HappyhorseListResult>(res, '获取 HappyHorse 任务列表失败');
}

export async function getHappyhorseTask(id: number): Promise<HappyhorseTask> {
  const res = await fetch(`${API_BASE}/happyhorse-tasks/${id}`, { headers: getAuthHeaders() });
  return asJson<HappyhorseTask>(res, '获取任务失败');
}

export async function deleteHappyhorseTask(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/happyhorse-tasks/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
  await asJson<void>(res, '删除任务失败');
}

export async function getHappyhorsePricing(): Promise<HappyhorsePricingItem[]> {
  const res = await fetch(`${API_BASE}/happyhorse/pricing`, { headers: getAuthHeaders() });
  const out = await asJson<{ pricing: HappyhorsePricingItem[] }>(res, '获取计费失败');
  return out.pricing;
}

export interface DiscountItem {
  model: string;
  sub_key: string;
  type: 'percent' | 'number';
  value: number;
  start_date: string;
  end_date: string;
}

export async function fetchActiveDiscounts(): Promise<DiscountItem[]> {
  try {
    const res = await fetch(`${API_BASE}/discounts/active`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (!data.success) return [];
    return data.data.discounts || [];
  } catch { return []; }
}

// 与后端 happyhorsePricingService.estimate 同步
export const HAPPYHORSE_VIDEO_EDIT_MAX_SECONDS = 30;
export const HAPPYHORSE_LOCK_BUFFER = 1.2;

export function estimateHappyhorseCredits(
  mode: HappyhorseMode,
  resolution: HappyhorseResolution,
  durationSec: number | undefined,
  pricing: HappyhorsePricingItem[] | null,
  discounts?: DiscountItem[],
): { credits: number; lockedCredits: number; rate: number; discountedCredits?: number; discountedLockedCredits?: number } {
  if (!pricing) return { credits: 0, lockedCredits: 0, rate: 0 };
  const row = pricing.find((x) => x.mode === mode && x.resolution === resolution);
  const rate = row?.credits_per_second || 0;
  if (!rate) return { credits: 0, lockedCredits: 0, rate: 0 };
  let sec: number;
  if (mode === 'video-edit') {
    sec = Number.isFinite(durationSec) && (durationSec as number) > 0 ? (durationSec as number) : HAPPYHORSE_VIDEO_EDIT_MAX_SECONDS;
  } else {
    sec = Number.isFinite(durationSec) && (durationSec as number) > 0 ? (durationSec as number) : 5;
  }
  const credits = Math.max(0, Math.ceil(sec * rate));
  const lockedCredits = Math.max(credits, Math.ceil(credits * HAPPYHORSE_LOCK_BUFFER));

  let discountedCredits: number | undefined;
  let discountedLockedCredits: number | undefined;
  if (discounts && discounts.length > 0) {
    const discount = discounts.find((d) => d.model === mode && d.sub_key === resolution);
    if (discount && discount.value > 0 && discount.type === 'percent') {
      discountedCredits = Math.ceil(credits * (1 - discount.value / 100));
      discountedLockedCredits = Math.ceil(discountedCredits * HAPPYHORSE_LOCK_BUFFER);
    }
  }

  return { credits, lockedCredits, rate, ...(discountedCredits != null ? { discountedCredits, discountedLockedCredits } : {}) };
}

const DASHSCOPE_ERROR_MAP: { pattern: RegExp; zh: string }[] = [
  { pattern: /duration.*at least\s*(\d+\.?\d*)\s*s.*got\s*(\d+\.?\d*)/i, zh: '' }, // 动态生成
  { pattern: /overdue balance|overdue.*account|account.*overdue/i, zh: '阿里云账户欠费，请联系管理员充值' },
  { pattern: /account.*good.*standing|good.*standing/i,           zh: '阿里云账户异常，请联系管理员处理' },
  { pattern: /rate limit|too many requests/i,                      zh: '请求过于频繁，请稍后重试' },
  { pattern: /green net check|inappropriate content/i,             zh: '内容安全审核未通过，请修改素材后重试' },
  { pattern: /sensitive|copyright/i,                               zh: '内容触发安全审核，请修改后重试' },
  { pattern: /internal.*error|service.*error/i,                    zh: '阿里云服务异常，请稍后重试' },
  { pattern: /timeout/i,                                           zh: '生成超时，请稍后重试' },
  { pattern: /access denied/i,                                     zh: '阿里云接口访问被拒，请联系管理员' },
];

/** 前端本地化 DashScope 原始错误消息（不修改 DB 数据，仅用于展示） */
export function translateDashScopeError(msg: string | null | undefined): string {
  if (!msg) return msg || '';
  // 图片分辨率不足
  const resMatch = msg.match(/image.*?\/([^/\s]+\.\w+)\s+resolution must be at least (\d+x\d+), got (\d+x\d+)/i);
  if (resMatch) {
    return `图片分辨率不足：${resMatch[1]} 为 ${resMatch[3].replace('x', '×')}，最小要求 ${resMatch[2].replace('x', '×')}`;
  }
  // 视频时长不足：duration should be at least 3s, got 2.32s
  const durMatch = msg.match(/duration.*at least\s*(\d+\.?\d*)\s*s.*got\s*(\d+\.?\d*)/i);
  if (durMatch) {
    return `视频时长不足：需要至少 ${durMatch[1]}s，当前视频仅 ${durMatch[2]}s`;
  }
  for (const { pattern, zh } of DASHSCOPE_ERROR_MAP) {
    if (!zh) continue;
    if (pattern.test(msg)) return zh;
  }
  return msg;
}
