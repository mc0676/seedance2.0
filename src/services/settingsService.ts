import type { Settings, ApiResponse } from '../types/index';
import { getAuthHeaders } from './authService';

const API_BASE = '/api';

export async function getSettings(): Promise<Settings> {
  const response = await fetch(`${API_BASE}/settings`, {
    headers: getAuthHeaders(),
  });
  const result: ApiResponse<Settings> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取设置失败');
  }
  return result.data || {};
}

export async function updateSettings(
  settings: Record<string, string>
): Promise<Settings> {
  const response = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings),
  });
  const result: ApiResponse<Settings> = await response.json();
  if (!result.success) {
    throw new Error(result.error || '更新设置失败');
  }
  return result.data!;
}

export async function redeemActivationCode(code: string): Promise<void> {
  const response = await fetch(`${API_BASE}/settings/activate`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ code }),
  });
  const result: ApiResponse = await response.json();
  if (!result.success) {
    throw new Error(result.error || '激活失败');
  }
}

export async function getVolcKeyStatus(): Promise<{ multiAccountEnabled: boolean }> {
  const response = await fetch(`${API_BASE}/volc-key-status`, {
    headers: getAuthHeaders(),
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || '获取火山Key状态失败');
  }
  return result.data;
}

export default {
  getSettings,
  updateSettings,
  redeemActivationCode,
};
