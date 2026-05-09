import type { ApiResponse, VideoEnhancement, EnhancementPricing } from '../types/index';
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

export async function getEnhancementPricing(): Promise<EnhancementPricing[]> {
  const res = await fetch(`${API_BASE}/enhancement-pricing`, {
    headers: getAuthHeaders(),
  });
  return asJson<EnhancementPricing[]>(res, '获取增强计费配置失败');
}

export async function getEnhancements(taskId: number): Promise<VideoEnhancement[]> {
  const res = await fetch(`${API_BASE}/video-enhancements?taskId=${taskId}`, {
    headers: getAuthHeaders(),
  });
  return asJson<VideoEnhancement[]>(res, '获取增强记录失败');
}

export interface EnhancementListResult {
  items: VideoEnhancement[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listMyEnhancements(page = 1, pageSize = 20): Promise<EnhancementListResult> {
  const res = await fetch(`${API_BASE}/video-enhancements/list?page=${page}&pageSize=${pageSize}`, {
    headers: getAuthHeaders(),
  });
  return asJson<EnhancementListResult>(res, '获取增强记录失败');
}

export interface SubmitEnhancementParams {
  taskId?: number;
  videoUrl?: string;
  durationSeconds?: number;
  scene: VideoEnhancement['scene'];
  toolVersion: VideoEnhancement['tool_version'];
  resolution: VideoEnhancement['target_resolution'];
}

export async function submitEnhancement(
  params: SubmitEnhancementParams
): Promise<{ enhancement: VideoEnhancement; estimatedCredits: number }> {
  const res = await fetch(`${API_BASE}/video-enhancements`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
  });
  const ct = res.headers.get('content-type') || '';
  let body: { success?: boolean; error?: string; data?: VideoEnhancement; estimatedCredits?: number } = {};
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error || `提交增强任务失败（HTTP ${res.status}）`);
  }
  return { enhancement: body.data, estimatedCredits: body.estimatedCredits || 0 };
}

export function estimateCredits(
  durationSec: number,
  toolVersion: VideoEnhancement['tool_version'],
  pricing: EnhancementPricing[]
): number {
  const p = pricing.find((x) => x.tool_version === toolVersion);
  if (!p) return 0;
  return Math.max(1, Math.round(durationSec)) * p.credits_per_second;
}
