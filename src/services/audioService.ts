import type { AudioGeneration } from '../types';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface SubmitAudioGenerationParams {
  projectId: number;
  referenceImageUrl: string;
  /** 已入库的素材资产 URI（asset://asset-xxx）。提供后将用它替代 referenceImageUrl 调推理，规避真人检测。 */
  referenceAssetUri?: string | null;
  voicePrompt: string;
}

export async function submitAudioGeneration(params: SubmitAudioGenerationParams): Promise<{ audioGenerationId: number; taskId: number }> {
  const res = await fetch(`${API_BASE}/audio-generations`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
  });
  const ct = res.headers.get('content-type') || '';
  let body: { success?: boolean; error?: string; data?: { audioGenerationId: number; taskId: number } } = {};
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error || `提交音频生成失败（HTTP ${res.status}）`);
  }
  return body.data;
}

export async function getAudioGeneration(id: number): Promise<AudioGeneration> {
  const res = await fetch(`${API_BASE}/audio-generations/${id}`, { headers: getAuthHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || '获取记录失败');
  return body.data as AudioGeneration;
}

export interface AudioGenerationListResult {
  items: AudioGeneration[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAudioGenerations(page = 1, pageSize = 20, projectId?: number | null): Promise<AudioGenerationListResult> {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (projectId) qs.set('projectId', String(projectId));
  const res = await fetch(`${API_BASE}/audio-generations/list?${qs}`, {
    headers: getAuthHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || '获取列表失败');
  return body.data as AudioGenerationListResult;
}

export interface AudioGenPublicConfig {
  model: string;
  ratio: string;
  resolution: string;
  duration: number;
}

export async function getAudioGenPublicConfig(): Promise<AudioGenPublicConfig> {
  const res = await fetch(`${API_BASE}/audio-generations/config`, { headers: getAuthHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || '获取配置失败');
  return body.data as AudioGenPublicConfig;
}

export interface AudioGenEstimate {
  credits: number;
  lockedCredits: number;
  tokens: number;
  yuan: number;
}

export async function estimateAudioGenCredits(cfg: AudioGenPublicConfig): Promise<AudioGenEstimate> {
  const res = await fetch(`${API_BASE}/pricing/estimate`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: cfg.model,
      outputDurationSec: cfg.duration,
      resolution: cfg.resolution,
      ratio: cfg.ratio,
      hasVideoInput: false,
      hasAudio: false,
      isDraft: false,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) throw new Error(body.error || '估算失败');
  return body.data as AudioGenEstimate;
}
