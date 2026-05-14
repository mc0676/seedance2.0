import type { ApiResponse, VideoEnhancement, EnhancementPricing, EnhancementResolutionPreset } from '../types/index';
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

export async function getEnhancementPricing(): Promise<EnhancementPricing> {
  const res = await fetch(`${API_BASE}/enhancement-pricing`, {
    headers: getAuthHeaders(),
  });
  return asJson<EnhancementPricing>(res, '获取增强计费配置失败');
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

export async function listMyEnhancements(page = 1, pageSize = 20, projectId?: number | null): Promise<EnhancementListResult> {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (projectId) qs.set('projectId', String(projectId));
  const res = await fetch(`${API_BASE}/video-enhancements/list?${qs}`, {
    headers: getAuthHeaders(),
  });
  return asJson<EnhancementListResult>(res, '获取增强记录失败');
}

export interface SubmitEnhancementParams {
  taskId?: number;
  videoUrl?: string;
  durationSeconds?: number;
  /** 当前工作组 id；外部视频源时务必带上以便归属到工作组（taskId 源时后端从 task 反查覆盖） */
  projectId?: number | null;
  scene: VideoEnhancement['scene'];
  toolVersion: VideoEnhancement['tool_version'];
  /** 二选一：预设档或自定义短边 */
  resolution?: EnhancementResolutionPreset;
  resolutionLimit?: number;
  targetFps: number;
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

/** 由短边像素或预设档 → 计费档位（与后端 enhancementPricingService.resolutionTier 同步） */
export function resolutionTier(value: EnhancementResolutionPreset | number): '720p' | '1080p' | '2k' | '4k' {
  if (typeof value === 'string') {
    if (value === '2k' || value === '4k') return value;
    // 240p/360p/480p/540p/720p 都按 720p 档（按下取整，因为 ≤720）
    if (value === '720p' || value === '540p' || value === '480p' || value === '360p' || value === '240p') return '720p';
    if (value === '1080p') return '1080p';
    return '1080p';
  }
  const n = Math.max(0, Math.round(value));
  if (n <= 720) return '720p';
  if (n <= 1080) return '1080p';
  if (n <= 1440) return '2k';
  return '4k';
}

/**
 * 估算单次画质增强的积分。与后端 enhancementPricingService.estimate 同步。
 *
 *   credits = ceil(durationSec / 60 × coefficient × baseCreditsPerMinute)
 *
 * resolution 可以是预设字符串或短边像素整数。
 */
export function estimateCredits(
  durationSec: number,
  toolVersion: VideoEnhancement['tool_version'],
  resolution: EnhancementResolutionPreset | number,
  fps: number,
  pricing: EnhancementPricing | null,
): number {
  if (!pricing) return 0;
  const fpsTier = fps > 30 ? 'gt30' : 'le30';
  const tier = resolutionTier(resolution);
  const c = pricing.coefficients.find(
    (x) => x.tool_version === toolVersion && x.resolution_tier === tier && x.fps_tier === fpsTier
  );
  if (!c) return 0;
  const minutes = Math.max(0, durationSec) / 60;
  return Math.max(0, Math.ceil(minutes * c.coefficient * pricing.baseCreditsPerMinute));
}
