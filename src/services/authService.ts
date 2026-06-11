import type { User, LoginCredentials, RegisterCredentials, AuthResponse } from '../types';

const API_BASE = '/api';

/**
 * 获取存储的 Session ID
 */
function getSessionId(): string | null {
  return localStorage.getItem('seedance_session_id');
}

/**
 * 设置 Session ID
 */
function setSessionId(sessionId: string): void {
  localStorage.setItem('seedance_session_id', sessionId);
}

/**
 * 移除 Session ID
 */
function removeSessionId(): void {
  localStorage.removeItem('seedance_session_id');
  localStorage.removeItem('seedance_user_cache');
}

export function getAuthSessionId(): string | null {
  return getSessionId();
}

export function getAuthHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const sessionId = getSessionId();
  if (!sessionId) {
    throw new Error('未登录');
  }

  return {
    ...headers,
    'X-Session-ID': sessionId,
  };
}

/**
 * 获取缓存的用户信息
 */
function getCachedUser(): User | null {
  const cached = localStorage.getItem('seedance_user_cache');
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 缓存用户信息
 */
function cacheUser(user: User): void {
  localStorage.setItem('seedance_user_cache', JSON.stringify(user));
}

/**
 * 注册新用户
 */
export async function register(credentials: RegisterCredentials): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '注册失败');
  }

  if (data.data) {
    setSessionId(data.data.sessionId);
    cacheUser(data.data.user);
  }

  return data.data;
}

/**
 * 用户登录
 */
export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '登录失败');
  }

  if (data.data) {
    setSessionId(data.data.sessionId);
    cacheUser(data.data.user);
  }

  return data.data;
}

/**
 * 用户登出
 */
export async function logout(): Promise<void> {
  const sessionId = getSessionId();
  if (sessionId) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'X-Session-ID': sessionId,
        },
      });
    } catch (error) {
      console.error('登出失败:', error);
    }
  }
  removeSessionId();
}

/**
 * 获取当前用户信息
 */
export async function getCurrentUser(): Promise<User | null> {
  const sessionId = getSessionId();

  if (!sessionId) {
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      headers: {
        'X-Session-ID': sessionId,
      },
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      removeSessionId();
      return null;
    }

    const user = data.data.user;
    cacheUser(user);
    return user;
  } catch (error) {
    console.error('获取用户信息失败:', error);
    return null;
  }
}

/**
 * 修改密码
 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/auth/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ oldPassword, newPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '修改密码失败');
  }

  // 修改密码后需要重新登录
  removeSessionId();
}

/**
 * 更新自己的姓名 / 小组
 *   - name: 长度 2~20，允许重名
 *   - department: 字符串，提交时后端 INSERT OR IGNORE 进字典表；首次填后不可自助改
 * 字段不传 → 该字段不更新。
 */
export async function updateMyProfile(payload: { name?: string; department?: string }): Promise<User> {
  const response = await fetch(`${API_BASE}/auth/me`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '更新个人信息失败');
  }
  const user = data.data.user as User;
  cacheUser(user);
  return user;
}

/** 小组字典模糊查询（用于下拉候选） */
export async function listDepartments(q: string = ''): Promise<Array<{ id: number; name: string }>> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const response = await fetch(`${API_BASE}/departments?${params}`, {
    headers: getAuthHeaders(),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '加载小组列表失败');
  }
  return data.data.items || [];
}

/** 管理员代填 / 修改某用户的姓名 + 小组 */
export async function updateUserProfileByAdmin(
  userId: number,
  payload: { name?: string | null; department?: string | null },
): Promise<void> {
  const response = await fetch(`${API_BASE}/admin/users/${userId}/profile`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '更新用户资料失败');
  }
}

// ── 管理员：小组字典 CRUD ───────────────────────────────────────────
export interface AdminDepartment {
  id: number;
  name: string;
  created_at: string;
  user_count: number;
}

export async function listDepartmentsAdmin(): Promise<AdminDepartment[]> {
  const res = await fetch(`${API_BASE}/admin/departments`, { headers: getAuthHeaders() });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || '加载小组列表失败');
  return data.data.items || [];
}

export async function createDepartmentAdmin(name: string): Promise<{ id: number; name: string }> {
  const res = await fetch(`${API_BASE}/admin/departments`, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || '新建小组失败');
  return data.data;
}

export async function renameDepartmentAdmin(id: number, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/departments/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || '重命名失败');
}

export async function deleteDepartmentAdmin(id: number): Promise<{ affectedUsers: number }> {
  const res = await fetch(`${API_BASE}/admin/departments/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
  return data.data;
}

/**
 * 每日签到
 */
export async function checkIn(): Promise<{ creditsEarned: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/checkin`, {
    method: 'POST',
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '签到失败');
  }

  // 更新缓存的用户信息
  const user = getCachedUser();
  if (user) {
    user.credits = (user.credits || 0) + data.data.creditsEarned;
    cacheUser(user);
  }

  return data.data;
}

/**
 * 获取签到状态
 * TODO 预留：当前 UI 未消费，留作 Settings/Profile 页签到模块未来接入
 */
export async function getCheckInStatus(): Promise<{ hasCheckedInToday: boolean; totalCheckIns: number }> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/credits/checkin/status`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取签到状态失败');
  }

  return data.data;
}

/**
 * 发送邮箱验证码
 */
export async function sendEmailCode(email: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/email-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '发送验证码失败');
  }

  return data.data;
}

/**
 * 检查邮箱状态
 */
export async function checkEmailStatus(email: string): Promise<{ isRegistered: boolean }> {
  const response = await fetch(`${API_BASE}/auth/email-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '检查邮箱状态失败');
  }

  return data.data;
}

/**
 * 验证邮箱验证码
 */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const response = await fetch(`${API_BASE}/auth/verify-email-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, code }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '验证码错误');
  }

  return data;
}

// ============================================================
// 管理员 API
// ============================================================

/**
 * 获取系统统计
 */
export async function getSystemStats(): Promise<{
  totalUsers: number;
  activeUsers: number;
  totalProjects: number;
  totalTasks: number;
  todayCheckIns: number;
  totalCreditsIssued: number;
}> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/stats`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取系统统计失败');
  }

  return data.data;
}

/**
 * 获取用户列表
 */
export async function getUserList(
  page: number = 1,
  pageSize: number = 20,
  filters?: { role?: string; status?: string; email?: string }
): Promise<{
  users: User[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    ...filters,
  } as Record<string, string>);

  const response = await fetch(`${API_BASE}/admin/users?${params.toString()}`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取用户列表失败');
  }

  return data.data;
}

/**
 * 获取用户详情
 */
export async function getUserDetail(userId: number): Promise<User | null> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}`, {
    headers: {
      'X-Session-ID': sessionId,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '获取用户详情失败');
  }

  return data.data;
}

/**
 * 更新用户状态
 */
export async function updateUserStatus(userId: number, status: 'active' | 'disabled'): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ status }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '更新用户状态失败');
  }
}

/**
 * 修改用户积分
 */
export async function updateUserCredits(
  userId: number,
  credits: number,
  operation: 'set' | 'add' | 'subtract' = 'set'
): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/credits`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ credits, operation }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '修改用户积分失败');
  }
}

/**
 * 重置用户密码
 */
export async function resetUserPassword(userId: number, newPassword: string): Promise<void> {
  const sessionId = getSessionId();

  if (!sessionId) {
    throw new Error('未登录');
  }

  const response = await fetch(`${API_BASE}/admin/users/${userId}/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify({ newPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '重置用户密码失败');
  }
}

// ==================== 功能权限管理 ====================

import type { FeatureKey } from '../types/index';

export async function setUserRole(userId: number, role: 'user' | 'admin' | 'super_admin'): Promise<void> {
  await adminFetch<unknown>(`/admin/users/${userId}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}


export interface AdminTaskByAccount {
  id: number;
  project_id: number;
  user_id: number;
  prompt: string;
  status: string;
  video_url: string | null;
  created_at: string;
  project_name: string | null;
  created_by_email: string | null;
}

async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: getAuthHeaders({ 'Content-Type': 'application/json', ...(init.headers as any) }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || '请求失败');
  }
  return data.data as T;
}

export const listFeatureKeys = () =>
  adminFetch<FeatureKey[]>('/admin/permissions/features');

export const getDefaultPermissions = () =>
  adminFetch<Record<string, boolean>>('/admin/permissions/defaults');

export const setDefaultPermissions = (permissions: Record<string, boolean>) =>
  adminFetch<Record<string, boolean>>('/admin/permissions/defaults', {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  });

export const getUserPermissions = (userId: number) =>
  adminFetch<Record<string, boolean>>(`/admin/users/${userId}/permissions`);

export const setUserPermission = (userId: number, featureKey: string, enabled: boolean) =>
  adminFetch<Record<string, boolean>>(`/admin/users/${userId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ feature_key: featureKey, enabled }),
  });

export interface VolcArkTask {
  id?: string;
  task_id?: string;
  model?: string;
  status?: string;
  created_at?: number | string;
  updated_at?: number | string;
  content?: any;
  usage?: { total_tokens?: number; completion_tokens?: number };
  error?: any;
  [k: string]: any;
}

export interface VolcArkListResponse {
  total?: number;
  data?: VolcArkTask[];
  items?: VolcArkTask[];
  tasks?: VolcArkTask[];
  page_size?: number;
  page_num?: number;
  [k: string]: any;
}

export const listVolcTasks = (params: {
  apiKey?: string;
  pageNum?: number;
  pageSize?: number;
  model?: string;
  status?: string;
}) => {
  const sp = new URLSearchParams();
  if (params.apiKey) sp.set('apiKey', params.apiKey);
  sp.set('pageNum', String(params.pageNum || 1));
  sp.set('pageSize', String(params.pageSize || 20));
  if (params.model) sp.set('model', params.model);
  if (params.status) sp.set('status', params.status);
  return adminFetch<VolcArkListResponse>(`/admin/volc/tasks?${sp.toString()}`);
};

export const getVolcTask = (taskId: string, apiKey?: string) => {
  const sp = new URLSearchParams();
  if (apiKey) sp.set('apiKey', apiKey);
  return adminFetch<VolcArkTask>(`/admin/volc/tasks/${encodeURIComponent(taskId)}?${sp.toString()}`);
};

// ==================== 火山Key组管理 ====================

export interface VolcKeyGroup {
  id: number;
  name: string;
  ark_model_key: string;
  volc_access_key: string;
  volc_secret_key: string;
  is_active: number;
  grouping_weight: number;
  note: string;
  amount_of_taking_back?: number;
  created_at: string;
  updated_at: string;
  bound_count?: number;
  default_count?: number;
}

export const listVolcKeyGroups = () =>
  adminFetch<VolcKeyGroup[]>('/admin/volc-key-groups');

export const createVolcKeyGroup = (payload: { name: string; ark_model_key: string; volc_access_key?: string; volc_secret_key?: string; grouping_weight?: number; note?: string }) =>
  adminFetch<VolcKeyGroup>('/admin/volc-key-groups', { method: 'POST', body: JSON.stringify(payload) });

export const updateVolcKeyGroup = (id: number, payload: Partial<VolcKeyGroup>) =>
  adminFetch<VolcKeyGroup>(`/admin/volc-key-groups/${id}`, { method: 'PUT', body: JSON.stringify(payload) });

export const activateVolcKeyGroup = (id: number) =>
  adminFetch<unknown>(`/admin/volc-key-groups/${id}/activate`, { method: 'PUT' });

export const deactivateVolcKeyGroup = (id: number) =>
  adminFetch<unknown>(`/admin/volc-key-groups/${id}/deactivate`, { method: 'PUT' });

export const deleteVolcKeyGroup = (id: number) =>
  adminFetch<unknown>(`/admin/volc-key-groups/${id}`, { method: 'DELETE' });

// ==================== 速创API Key ====================

export const getWuyinKey = () =>
  adminFetch<{ key: string }>('/admin/wuyin-key');

export const updateWuyinKey = (key: string) =>
  adminFetch<unknown>('/admin/wuyin-key', { method: 'PUT', body: JSON.stringify({ key }) });

// ==================== 火山 MediaKit Key ====================

export const getMediaKitKey = () =>
  adminFetch<{ key: string }>('/admin/mediakit-key');

export const updateMediaKitKey = (key: string) =>
  adminFetch<unknown>('/admin/mediakit-key', { method: 'PUT', body: JSON.stringify({ key }) });

// ==================== DeepSeek API Key ====================

export const getDeepseekConfig = () =>
  adminFetch<{ key: string; model: string; reasoning_effort: string }>('/admin/deepseek-key');

export const updateDeepseekConfig = (data: { key?: string; model?: string; reasoning_effort?: string }) =>
  adminFetch<unknown>('/admin/deepseek-key', { method: 'PUT', body: JSON.stringify(data) });

// ==================== 音频生成中转配置 ====================

export interface AudioGenConfig {
  model: string;
  ratio: string;
  resolution: string;
  duration: number;
}

export interface AudioGenConfigResponse {
  config: AudioGenConfig;
  defaults: AudioGenConfig;
  options: {
    ratios: string[];
    resolutions: string[];
    durations: number[];
  };
}

export const getAudioGenConfig = () =>
  adminFetch<AudioGenConfigResponse>('/admin/audio-gen-config');

export const updateAudioGenConfig = (cfg: AudioGenConfig) =>
  adminFetch<AudioGenConfigResponse>('/admin/audio-gen-config', { method: 'PUT', body: JSON.stringify(cfg) });

// ==================== 画质增强计费 ====================

export interface AdminEnhancementPricing {
  baseCreditsPerMinute: number;
  defaultBaseCreditsPerMinute: number;
  coefficients: Array<{
    tool_version: 'standard' | 'professional';
    resolution_tier: '720p' | '1080p' | '2k' | '4k';
    fps_tier: 'le30' | 'gt30';
    coefficient: number;
  }>;
}

export const getEnhancementPricing = () =>
  adminFetch<AdminEnhancementPricing>('/admin/enhancement-pricing');

export const updateEnhancementBaseRate = (baseCreditsPerMinute: number) =>
  adminFetch<{ baseCreditsPerMinute: number }>('/admin/enhancement-pricing', {
    method: 'PUT',
    body: JSON.stringify({ baseCreditsPerMinute }),
  });

// ==================== 模型计费管理 ====================

import type { ModelPricing } from '../types/index';

export const listAllModelPricing = () =>
  adminFetch<ModelPricing[]>('/admin/model-pricing');

export const upsertModelPricing = (modelKey: string, payload: Partial<ModelPricing>) =>
  adminFetch<ModelPricing>(`/admin/model-pricing/${encodeURIComponent(modelKey)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

export const deleteModelPricing = (modelKey: string) =>
  adminFetch<unknown>(`/admin/model-pricing/${encodeURIComponent(modelKey)}`, {
    method: 'DELETE',
  });

// ── 管理员：积分消耗分析面板 ───────────────────────────────────────

export interface DailyTrendItem {
  day: string;
  consumed: number;
  active_users: number;
  total_calls: number;
}

export interface TodayRankingItem {
  id: number;
  email: string;
  name: string | null;
  department: string;
  total_credits: number;
  call_count: number;
}

export interface CreditDetailItem {
  id: number;
  user_id: number;
  task_id: number | null;
  model: string;
  action: string;
  credits_cost: number;
  status: string;
  error_message: string | null;
  created_at: string;
  email: string;
  name: string | null;
  department: string;
  concurrent_id: string | null;
  batch_total_credits: number | null;
  batch_count: number | null;
  unit_credits: number | null;
}

export interface GroupSummaryItem {
  department: string;
  user_count: number;
  total_credits: number;
  call_count: number;
}

export interface ProjectConsumptionItem {
  id: number;
  name: string;
  user_count: number;
  total_credits: number;
  task_count: number;
}

export interface FailureItem {
  model: string;
  action: string;
  error_message: string | null;
  fail_count: number;
  wasted_credits: number;
}

export interface UserActivityData {
  dailyActive: Array<{ day: string; active_users: number }>;
  dormant: Array<{
    id: number;
    email: string;
    name: string | null;
    department: string;
    last_active: string;
    created_at: string;
  }>;
}

export const fetchDailyTrend = (days = 30, departmentId?: number) => {
  const sp = new URLSearchParams({ days: String(days) });
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<DailyTrendItem[]>(`/admin/credits/daily-trend?${sp}`);
};

export const fetchTodayRanking = (departmentId?: number) => {
  const sp = new URLSearchParams();
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<TodayRankingItem[]>(`/admin/credits/today-ranking?${sp}`);
};

export const fetchCreditDetails = (params: { page?: number; pageSize?: number; name?: string; email?: string; date?: string; action?: string; model?: string; departmentId?: number } = {}) => {
  const sp = new URLSearchParams();
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params.name) sp.set('name', params.name);
  if (params.email) sp.set('email', params.email);
  if (params.date) sp.set('date', params.date);
  if (params.action) sp.set('action', params.action);
  if (params.model) sp.set('model', params.model);
  if (params.departmentId) sp.set('departmentId', String(params.departmentId));
  return adminFetch<{ rows: CreditDetailItem[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/admin/credits/details?${sp.toString()}`);
};

export const fetchGroupSummary = (days = 7, group?: string, departmentId?: number) => {
  const sp = new URLSearchParams();
  sp.set('days', String(days));
  if (group) sp.set('group', group);
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<GroupSummaryItem[] | TodayRankingItem[]>(`/admin/credits/group-summary?${sp.toString()}`);
};

export const fetchProjectConsumption = (days = 30, departmentId?: number) => {
  const sp = new URLSearchParams({ days: String(days) });
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<ProjectConsumptionItem[]>(`/admin/credits/project-consumption?${sp}`);
};

export const fetchFailureAnalysis = (days = 7, departmentId?: number) => {
  const sp = new URLSearchParams({ days: String(days) });
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<FailureItem[]>(`/admin/credits/failure-analysis?${sp}`);
};

export const fetchUserActivity = (days = 30, departmentId?: number) => {
  const sp = new URLSearchParams({ days: String(days) });
  if (departmentId) sp.set('departmentId', String(departmentId));
  return adminFetch<UserActivityData>(`/admin/users/activity?${sp}`);
};

// ==================== 积分发放统计 ====================

export interface DistributionLogItem {
  id: number;
  admin_id: number | null;
  recipient_id: number;
  credits_amount: number;
  method: 'activation_code' | 'activation_code_daily' | 'manual_set' | 'manual_add' | 'checkin' | 'self_paying' | 'code_refund' | 'recycling';
  note: string;
  amount_of_taking_back?: number;
  created_at: string;
  admin_email: string;
  admin_name: string;
  recipient_email: string;
  recipient_name: string;
  recipient_department: string;
}

export interface DistributionSummary {
  admins: Array<{
    admin_id: number;
    admin_email: string;
    admin_name: string;
    total_credits: number;
    distribution_count: number;
  }>;
  totalCredits: number;
  totalCount: number;
}

export const fetchCreditDistributions = (params: {
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  adminId?: number;
  method?: string;
} = {}) => {
  const sp = new URLSearchParams();
  if (params.page) sp.set('page', String(params.page));
  if (params.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params.startDate) sp.set('startDate', params.startDate);
  if (params.endDate) sp.set('endDate', params.endDate);
  if (params.adminId) sp.set('adminId', String(params.adminId));
  if (params.method) sp.set('method', params.method);
  return adminFetch<{ rows: DistributionLogItem[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/admin/credit-distributions?${sp.toString()}`);
};

export const fetchDistributionSummary = (params: {
  startDate?: string;
  endDate?: string;
} = {}) => {
  const sp = new URLSearchParams();
  if (params.startDate) sp.set('startDate', params.startDate);
  if (params.endDate) sp.set('endDate', params.endDate);
  return adminFetch<DistributionSummary>(`/admin/credit-distributions/summary?${sp.toString()}`);
};

// ==================== 发分额度管理 ====================

export interface AdminQuotaItem {
  adminId: number;
  adminEmail: string;
  adminName: string;
  adminDepartment: string;
  totalQuota: number;   // 0 = 不限制
  dailyQuota: number;   // 0 = 不限制
  totalUsed: number;
  todayDailyUsed: number;
  todaySelfPaying: number;
  todaySelfRefund: number;
}

export const fetchAdminQuotas = () =>
  adminFetch<AdminQuotaItem[]>('/admin/admin-quotas');

export const takeBackDistribution = (id: number) =>
  adminFetch<{ takenBack: number; totalTakenBack: number; status: string }>(`/admin/credit-distribution/${id}/take-back`, { method: 'POST' });

export const recycleTeamCredits = () =>
  adminFetch<{ recycled: number; returnedToCreator: number; dailyTakenBack: number; total: number }>('/admin/credit-distribution/recycle-team', { method: 'POST' });

export const updateAdminQuota = (adminId: number, payload: { totalQuota?: number; dailyQuota?: number }) =>
  adminFetch<{ success: boolean }>(`/admin/admin-quotas/${adminId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });