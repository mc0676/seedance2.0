import { getAuthHeaders } from './authService';
import type { ProjectAsset, ProjectAssetList } from '../types';

const BASE = '/api/projects';

export async function listProjectAssets(projectId: number, params: { page?: number; pageSize?: number; status?: string; autoInject?: boolean } = {}): Promise<ProjectAssetList> {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.status) q.set('status', params.status);
  if (params.autoInject !== undefined) q.set('autoInject', String(params.autoInject));
  const res = await fetch(`${BASE}/${projectId}/assets?${q}`, { headers: getAuthHeaders() });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '获取资产列表失败');
  return result.data;
}

export async function uploadProjectAsset(projectId: number, file: File): Promise<ProjectAsset> {
  const form = new FormData();
  form.append('file', file);
  form.append('fileType', file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image');
  const res = await fetch(`${BASE}/${projectId}/assets`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: form,
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '上传失败');
  return result.data;
}

export async function uploadProjectAssetByUrl(projectId: number, url: string, name: string, fileType = 'image'): Promise<ProjectAsset> {
  const res = await fetch(`${BASE}/${projectId}/assets`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url, name, fileType }),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '上传失败');
  return result.data;
}

export async function reviewProjectAsset(projectId: number, assetId: number, reviewStatus: 'approved' | 'rejected' | 'pending'): Promise<void> {
  const res = await fetch(`${BASE}/${projectId}/assets/${assetId}/review`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ reviewStatus }),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '审核失败');
}

export async function setAssetAutoInject(projectId: number, assetId: number, autoInject: boolean): Promise<void> {
  const res = await fetch(`${BASE}/${projectId}/assets/${assetId}/auto-inject`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ autoInject }),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '设置失败');
}

export async function deleteProjectAsset(projectId: number, assetId: number): Promise<void> {
  const res = await fetch(`${BASE}/${projectId}/assets/${assetId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '删除失败');
}

export async function syncAssetReview(projectId: number, assetId: number): Promise<ProjectAsset> {
  const res = await fetch(`${BASE}/${projectId}/assets/${assetId}/sync-review`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '同步审核失败');
  return result.data;
}

export async function syncAllPendingReviews(projectId: number): Promise<{ id: number; success: boolean; reviewStatus?: string; error?: string }[]> {
  const res = await fetch(`${BASE}/${projectId}/assets/sync-reviews`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '批量同步失败');
  return result.data;
}

export async function listProjectMembers(projectId: number) {
  const res = await fetch(`${BASE}/${projectId}/members`, { headers: getAuthHeaders() });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '获取成员列表失败');
  return result.data;
}

export async function inviteProjectMember(projectId: number, email: string, role = 'member'): Promise<void> {
  const res = await fetch(`${BASE}/${projectId}/members`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, role }),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '邀请失败');
}

export async function removeProjectMember(projectId: number, userId: number): Promise<void> {
  const res = await fetch(`${BASE}/${projectId}/members/${userId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '移除失败');
}

export async function updateProjectAsset(
  projectId: number,
  assetId: number,
  data: { name?: string; description?: string }
): Promise<import('../types').ProjectAsset> {
  const res = await fetch(`${BASE}/${projectId}/assets/${assetId}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '更新失败');
  return result.data;
}
