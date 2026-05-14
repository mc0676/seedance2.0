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
}

export interface HappyhorseSubmitResult {
  task: HappyhorseTask;
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
  let body: { success?: boolean; error?: string; data?: HappyhorseTask; estimatedCredits?: number; lockedCredits?: number } = {};
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error || `提交 HappyHorse 任务失败（HTTP ${res.status}）`);
  }
  return { task: body.data, estimatedCredits: body.estimatedCredits || 0, lockedCredits: body.lockedCredits || 0 };
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

// 与后端 happyhorsePricingService.estimate 同步
export const HAPPYHORSE_VIDEO_EDIT_MAX_SECONDS = 30;
export const HAPPYHORSE_LOCK_BUFFER = 1.2;

export function estimateHappyhorseCredits(
  mode: HappyhorseMode,
  resolution: HappyhorseResolution,
  durationSec: number | undefined,
  pricing: HappyhorsePricingItem[] | null,
): { credits: number; lockedCredits: number; rate: number } {
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
  return { credits, lockedCredits, rate };
}
