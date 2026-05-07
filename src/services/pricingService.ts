import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export interface PricingEstimate {
  tokens: number;
  unitPrice: number;
  draftFactor: number;
  yuan: number;
  credits: number;
  lockedCredits: number;
  model: string;
  warn?: string;
}

export interface CreditBalance {
  credits: number;
  unlimited: boolean;
  locked: number;
  available: number; // -1 表示无限
}

export async function estimatePricing(payload: {
  model: string;
  duration?: number;
  outputDurationSec?: number;
  inputDurationSec?: number;
  ratio?: string;
  resolution?: string;
  hasVideoInput?: boolean;
  hasAudio?: boolean;
  isDraft?: boolean;
  fps?: number;
}): Promise<PricingEstimate> {
  const res = await fetch(`${API_BASE}/pricing/estimate`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '估算失败');
  return data.data;
}

export async function getCreditBalance(): Promise<CreditBalance> {
  const res = await fetch(`${API_BASE}/credits/balance`, {
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '获取余额失败');
  return data.data;
}

export interface RuntimeModelOption {
  model_key: string;
  label: string;
  description: string | null;
  pricing_type: 'seedance2' | 'seedance15';
  enabled: number;
  sort_order: number;
}

export async function listEnabledModels(): Promise<RuntimeModelOption[]> {
  const res = await fetch(`${API_BASE}/model-pricing`, {
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '获取模型列表失败');
  return data.data || [];
}
