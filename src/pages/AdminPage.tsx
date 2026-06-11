import { useState, useEffect, useRef, Fragment } from 'react';
import { useApp } from '../context/AppContext';
import { formatDateTime, formatDate, useUserTimezone, parseServerDate } from '../utils/datetime';
import * as XLSX from 'xlsx';
import {
  getSystemStats,
  getUserList,
  updateUserStatus,
  updateUserCredits,
  resetUserPassword,
  listFeatureKeys,
  getDefaultPermissions,
  getUserPermissions,
  setUserPermission,
  listVolcTasks,
  type VolcArkTask,
  listAllModelPricing,
  upsertModelPricing,
  deleteModelPricing,
  setUserRole,
  listVolcKeyGroups,
  createVolcKeyGroup,
  updateVolcKeyGroup,
  activateVolcKeyGroup,
  deactivateVolcKeyGroup,
  deleteVolcKeyGroup,
  type VolcKeyGroup,
  getWuyinKey,
  updateWuyinKey,
  getMediaKitKey,
  updateMediaKitKey,
  getDeepseekConfig,
  updateDeepseekConfig,
  getEnhancementPricing as fetchEnhancementPricing,
  updateEnhancementBaseRate,
  type AdminEnhancementPricing,
  getAudioGenConfig,
  updateAudioGenConfig,
  type AudioGenConfig,
} from '../services/authService';
import {
  getAuthHeaders,
  updateUserProfileByAdmin,
  listDepartmentsAdmin,
  createDepartmentAdmin,
  renameDepartmentAdmin,
  deleteDepartmentAdmin,
  type AdminDepartment,
} from '../services/authService';
import DepartmentSelect from '../components/DepartmentSelect';
import AnalyticsPanels from '../components/AnalyticsPanels';
import CreditDistributionPanel from '../components/CreditDistributionPanel';
import DiscountModal from '../components/DiscountModal';
import type { User, FeatureKey, ModelPricing } from '../types';
import { UsersIcon, ShieldIcon, CheckIcon, SparkleIcon, PlusIcon } from '../components/Icons';

interface SystemStats {
  totalUsers: number;
  activeUsers: number;
  totalProjects: number;
  totalTasks: number;
  todayCheckIns: number;
  totalCreditsIssued: number;
}

function StyledCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate?: boolean; onChange: () => void }) {
  return (
    <div onClick={onChange} className="cursor-pointer">
      {indeterminate ? (
        <div className="w-5 h-5 rounded-lg bg-purple-500/30 border-2 border-purple-400 flex items-center justify-center transition-all">
          <div className="w-2.5 h-0.5 rounded-full bg-purple-400" />
        </div>
      ) : checked ? (
        <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center shadow-md shadow-purple-500/30 transition-all scale-110">
          <svg viewBox="0 0 12 10" className="w-3 h-3" fill="none">
            <path d="M1.5 5L4.5 8L10.5 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ) : (
        <div className="w-5 h-5 rounded-lg border-2 border-dashed border-gray-600 bg-[#1c1f2e] hover:border-purple-400/60 transition-all" />
      )}
    </div>
  );
}

interface ActivationCode {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  note: string;
  credits_value: number;
  created_at: string;
}

async function fetchActivationCodes(): Promise<ActivationCode[]> {
  const res = await fetch('/api/admin/activation-codes', { headers: getAuthHeaders() });
  const result = await res.json();
  return result.data || [];
}

async function createActivationCode(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/admin/activation-codes', {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '创建失败');
  return result.data || {};
}

async function updateActivationCode(id: number, payload: { maxUses?: number; note?: string; creditsValue?: number }): Promise<void> {
  const res = await fetch(`/api/admin/activation-codes/${id}`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '更新失败');
}

async function deleteActivationCode(id: number): Promise<void> {
  const res = await fetch(`/api/admin/activation-codes/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '删除失败');
}

async function fetchSystemConfig(): Promise<{ registrationEnabled: boolean; maintenanceMode: boolean; maintenanceMessage: string; informationOfAccountOfVolc: boolean }> {
  const res = await fetch('/api/admin/system-config', { headers: getAuthHeaders() });
  const result = await res.json();
  return result.data || { registrationEnabled: true, maintenanceMode: false, maintenanceMessage: '系统维护中，请稍后再试。', informationOfAccountOfVolc: false };
}

async function saveSystemConfig(payload: { registrationEnabled?: boolean; maintenanceMode?: boolean; maintenanceMessage?: string; informationOfAccountOfVolc?: boolean }): Promise<void> {
  const res = await fetch('/api/admin/system-config', {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '保存失败');
}

async function toggleUnlimitedCredits(userId: number, unlimited: boolean): Promise<void> {
  const res = await fetch(`/api/admin/users/${userId}/unlimited`, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ unlimited }),
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || '更新失败');
}

/**
 * 小组管理卡片：列表 + 新建 + 改名 + 删除。
 *
 * 任何 CRUD 后调 onChanged 让上层（如用户编辑模态里的 DepartmentSelect）刷新下拉。
 * 删除小组会触发后端 ON DELETE SET NULL，关联用户被解绑后下次登录会被 Gate 拦截要求重选。
 */
function DepartmentManagementCard({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<AdminDepartment[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const reload = async () => {
    setLoading(true);
    try { setItems(await listDepartmentsAdmin()); }
    catch (e) { alert(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void reload(); }, []);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      await createDepartmentAdmin(trimmed);
      setNewName('');
      await reload();
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : '新建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleSaveRename = async (id: number) => {
    const trimmed = editingName.trim();
    if (!trimmed) return;
    try {
      await renameDepartmentAdmin(id, trimmed);
      setEditingId(null);
      setEditingName('');
      await reload();
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : '重命名失败');
    }
  };

  const handleDelete = async (d: AdminDepartment) => {
    const tip = d.user_count > 0
      ? `小组「${d.name}」当前有 ${d.user_count} 个用户。删除后这些用户的小组字段会被清空，下次登录需重新选择。\n确认删除？`
      : `确认删除小组「${d.name}」？`;
    if (!window.confirm(tip)) return;
    try {
      const out = await deleteDepartmentAdmin(d.id);
      await reload();
      onChanged();
      if (out.affectedUsers > 0) alert(`已删除，影响 ${out.affectedUsers} 个用户`);
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-white">小组管理</h2>
        <button onClick={() => void reload()} className="text-xs text-gray-400 hover:text-white">刷新</button>
      </div>

      {/* 新建 */}
      <div className="flex gap-2 mb-4">
        <input
          value={newName}
          maxLength={60}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          placeholder="新小组名（≤60 字符）"
          className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-purple-500"
        />
        <button
          onClick={handleCreate}
          disabled={!newName.trim() || creating}
          className="px-4 py-2 bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 disabled:opacity-40 rounded-lg text-sm font-medium"
        >{creating ? '新建中…' : '新建小组'}</button>
      </div>

      {/* 列表 */}
      {loading && items.length === 0 ? (
        <div className="text-xs text-gray-500">加载中…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-gray-500">暂无小组，从上方新建吧</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {items.map((d) => (
            <div key={d.id} className="flex items-center gap-2 bg-[#0f111a] rounded-xl px-3 py-2">
              {editingId === d.id ? (
                <>
                  <input
                    autoFocus
                    value={editingName}
                    maxLength={60}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveRename(d.id); }}
                    className="flex-1 min-w-0 px-2 py-1 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-purple-500"
                  />
                  <button onClick={() => void handleSaveRename(d.id)} className="px-2 py-1 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 rounded text-xs">保存</button>
                  <button onClick={() => { setEditingId(null); setEditingName(''); }} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-200">取消</button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0 flex items-baseline gap-2">
                    <span className="text-sm text-white truncate">{d.name}</span>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{d.user_count} 人</span>
                  </div>
                  <button
                    onClick={() => { setEditingId(d.id); setEditingName(d.name); }}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-white"
                  >改名</button>
                  <button
                    onClick={() => void handleDelete(d)}
                    className="px-2 py-1 text-xs text-red-400 hover:text-red-300"
                  >删除</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-500 mt-3">
        提示：删除小组后，该小组下的所有用户会被解绑（小组字段置空），下次登录会被引导重新选择小组。
      </p>
    </div>
  );
}

export default function AdminPage() {
  useUserTimezone();
  const { currentUser } = useApp();
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalUsers, setTotalUsers] = useState(0);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [filterEmail, setFilterEmail] = useState<string>('');

  // 功能权限
  const [featureKeys, setFeatureKeys] = useState<FeatureKey[]>([]);
  const [userPerms, setUserPerms] = useState<Record<string, boolean>>({});
  const [permsLoading, setPermsLoading] = useState(false);

  // 全局任务查询（火山方舟直连，使用激活Key组或手动输入key）
  const GLOBAL_ARK_KEY = 'c7cf1f3a-6a5f-42e2-aae1-ac804020c18c';
  const [manualApiKey, setManualApiKey] = useState<string>(GLOBAL_ARK_KEY);
  const [accountTasksLoading, setAccountTasksLoading] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // 火山Key组管理
  const [volcKeyGroups, setVolcKeyGroups] = useState<VolcKeyGroup[]>([]);
  const [newKeyGroup, setNewKeyGroup] = useState({ name: '', ark_model_key: 'c7cf1f3a-6a5f-42e2-aae1-ac804020c18c', volc_access_key: '', volc_secret_key: '', grouping_weight: 0, note: '' });
  const [editingKeyGroup, setEditingKeyGroup] = useState<VolcKeyGroup | null>(null);
  const [keyGroupsLoading, setKeyGroupsLoading] = useState(false);
  const [multiAccountEnabled, setMultiAccountEnabled] = useState(false);

  // 速创API Key
  const [wuyinKey, setWuyinKey] = useState('');
  const [wuyinKeyEditing, setWuyinKeyEditing] = useState(false);
  const [wuyinKeyDraft, setWuyinKeyDraft] = useState('');
  // MediaKit
  const [mediaKitKey, setMediaKitKey] = useState('');
  const [mediaKitKeyEditing, setMediaKitKeyEditing] = useState(false);
  const [mediaKitKeyDraft, setMediaKitKeyDraft] = useState('');
  // DeepSeek
  const [deepseekKey, setDeepseekKey] = useState('');
  const [deepseekKeyEditing, setDeepseekKeyEditing] = useState(false);
  const [deepseekKeyDraft, setDeepseekKeyDraft] = useState('');
  const [deepseekModel, setDeepseekModel] = useState('deepseek-v4-flash');
  const [deepseekReasoning, setDeepseekReasoning] = useState('');
  const [enhancementPricing, setEnhancementPricing] = useState<AdminEnhancementPricing | null>(null);

  // HappyHorse
  const [happyhorseKeyMasked, setHappyhorseKeyMasked] = useState('');
  const [happyhorseKeyConfigured, setHappyhorseKeyConfigured] = useState(false);
  const [happyhorseKeyEditing, setHappyhorseKeyEditing] = useState(false);
  const [happyhorseKeyDraft, setHappyhorseKeyDraft] = useState('');
  const [happyhorsePricing, setHappyhorsePricing] = useState<Array<{ mode: string; model: string; resolution: string; credits_per_second: number }>>([]);
  const [activeHappyhorseTab, setActiveHappyhorseTab] = useState<string>('t2v');

  // BSS 阿里云账户余额
  const [bssAkMasked, setBssAkMasked] = useState('');
  const [bssAkConfigured, setBssAkConfigured] = useState(false);
  const [bssSkConfigured, setBssSkConfigured] = useState(false);
  const [bssAkEditing, setBssAkEditing] = useState(false);
  const [bssAkDraft, setBssAkDraft] = useState('');
  const [bssSkDraft, setBssSkDraft] = useState('');
  const [bssBalance, setBssBalance] = useState<{ availableAmount: string; availableCashAmount: string; creditAmount: string; currency: string; mybankCreditAmount: string; quotaLimit: string } | null>(null);
  const [bssBalanceLoading, setBssBalanceLoading] = useState(false);
  const [bssBalanceError, setBssBalanceError] = useState('');

  // 火山引擎账户余额（按Key组ID索引）
  const [volcBalances, setVolcBalances] = useState<Record<number, { accountID: number; availableBalance: string; cashBalance: string; arrearsBalance: string; creditLimit: string; freezeAmount: string }>>({});
  const [volcBalanceLoadingId, setVolcBalanceLoadingId] = useState<number | null>(null);
  const [volcBalanceErrors, setVolcBalanceErrors] = useState<Record<number, string>>({});

  // 批量生成设置
  const [batchMaxConcurrent, setBatchMaxConcurrent] = useState<string>('5');
  const [batchSaving, setBatchSaving] = useState(false);

  // 折扣管理
  interface DiscountItem { id?: number; model: string; sub_key: string; type: 'percent' | 'number'; value: number; start_date: string; end_date: string; }
  const [discounts, setDiscounts] = useState<DiscountItem[]>([]);
  const [discountModalScope, setDiscountModalScope] = useState<'model' | 'happyhorse' | null>(null);

  // 音频生成中转配置
  const [audioCfg, setAudioCfg] = useState<AudioGenConfig | null>(null);
  const [audioCfgDraft, setAudioCfgDraft] = useState<AudioGenConfig | null>(null);
  const [audioCfgEditing, setAudioCfgEditing] = useState(false);
  const [audioCfgOptions, setAudioCfgOptions] = useState<{ ratios: string[]; resolutions: string[]; durations: number[] } | null>(null);
  const [audioCfgSaving, setAudioCfgSaving] = useState(false);

  // 火山原生资产库
  interface VolcAssetGroup { Id: string; Name: string; Description?: string; GroupType?: string; ProjectName?: string; CreateTime?: string; UpdateTime?: string; coverUrl?: string; }
  interface VolcAsset { Id: string; Name?: string; AssetType?: string; Status?: string; CreateTime?: string; UpdateTime?: string; ProjectName?: string; URL?: string; GroupId?: string; }
  // 层级：null=第一级组列表，object=第二级素材列表
  const [volcLevel, setVolcLevel] = useState<'groups' | 'assets'>('groups');
  const [volcAssetGroups, setVolcAssetGroups] = useState<VolcAssetGroup[]>([]);
  const [volcAssets, setVolcAssets] = useState<VolcAsset[]>([]);
  const [volcGroupsLoading, setVolcGroupsLoading] = useState(false);
  const [volcAssetsLoading, setVolcAssetsLoading] = useState(false);
  const [volcGroupPage, setVolcGroupPage] = useState(1);
  const [volcGroupTotal, setVolcGroupTotal] = useState(0);
  const [volcAssetPage, setVolcAssetPage] = useState(1);
  const [volcAssetTotal, setVolcAssetTotal] = useState(0);
  const [selectedGroup, setSelectedGroup] = useState<VolcAssetGroup | null>(null);
  const [volcGroupSearch, setVolcGroupSearch] = useState('');
  const [volcAssetSearch, setVolcAssetSearch] = useState('');
  const [assetUrlMap, setAssetUrlMap] = useState<Record<string, string>>({});
  // 编辑素材组
  const [editingGroup, setEditingGroup] = useState<VolcAssetGroup | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupDesc, setEditGroupDesc] = useState('');
  const [editGroupLoading, setEditGroupLoading] = useState(false);
  // 编辑素材
  const [editingAsset, setEditingAsset] = useState<VolcAsset | null>(null);
  const [editAssetName, setEditAssetName] = useState('');
  const [editAssetLoading, setEditAssetLoading] = useState(false);
  // 详情查看
  const [detailAsset, setDetailAsset] = useState<VolcAsset | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // AK/SK
  const [volcAkId, setVolcAkId] = useState('');
  const [volcSkKey, setVolcSkKey] = useState('');
  const [volcAkSkEditing, setVolcAkSkEditing] = useState(false);
  const [volcAkIdDraft, setVolcAkIdDraft] = useState('');
  const [volcSkKeyDraft, setVolcSkKeyDraft] = useState('');
  // 资产库 / 全局任务查询按 API 账户 tab 切换
  const [assetTabKeyGroupId, setAssetTabKeyGroupId] = useState<number | null>(null);
  const [taskTabKeyGroupId, setTaskTabKeyGroupId] = useState<number | null>(null);

  // 资产库按 tab 缓存：{ [keyGroupId]: { groups: VolcAssetGroup[], total: number } }
  const [assetCache, setAssetCache] = useState<Record<number, { groups: VolcAssetGroup[]; total: number }>>({});

  // 全局任务查询按 tab 缓存：{ [keyGroupId]: { tasks, total, pageNum, rawJson, apiKey } }
  const [taskCache, setTaskCache] = useState<Record<number, { tasks: VolcArkTask[]; total: number; pageNum: number; rawJson: string; apiKey: string }>>({});

  // 从缓存读取当前 tab 的任务数据（派生状态）
  const activeTaskCache = taskTabKeyGroupId != null ? (taskCache[taskTabKeyGroupId] ?? null) : null;
  const volcTasks: VolcArkTask[] = activeTaskCache?.tasks ?? [];
  const volcTotal = activeTaskCache?.total ?? 0;
  const volcPageNum = activeTaskCache?.pageNum ?? 1;
  const volcRawJson = activeTaskCache?.rawJson ?? '';

  const loadVolcGroups = async (page = 1, search = volcGroupSearch, keyGroupId?: number | null) => {
    setVolcGroupsLoading(true);
    const kId = keyGroupId ?? assetTabKeyGroupId;
    try {
      const params = new URLSearchParams({ pageNumber: String(page), pageSize: '20' });
      if (search.trim()) params.set('name', search.trim());
      if (kId) params.set('keyGroupId', String(kId));
      const res = await fetch(`/api/admin/volc-native/asset-groups?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const items: VolcAssetGroup[] = data.data?.Items || [];
      setVolcAssetGroups(items);
      setVolcGroupTotal(data.data?.TotalCount || 0);
      setVolcGroupPage(page);
      // 写入缓存
      if (kId) {
        setAssetCache(prev => ({ ...prev, [kId]: { groups: items.slice(), total: data.data?.TotalCount || 0 } }));
      }
      // 异步加载每组封面
      items.forEach(async (g) => {
        try {
          const r = await fetch(`/api/admin/volc-native/assets?groupId=${encodeURIComponent(g.Id)}&pageNumber=1&pageSize=1`, { headers: getAuthHeaders() });
          const d = await r.json();
          const firstAsset = d.data?.Items?.[0];
          if (!firstAsset) return;
          const r2 = await fetch(`/api/admin/volc-native/asset?id=${encodeURIComponent(firstAsset.Id)}`, { headers: getAuthHeaders() });
          const d2 = await r2.json();
          const url: string | undefined = d2.data?.URL;
          if (url) setVolcAssetGroups(prev => prev.map(item => item.Id === g.Id ? { ...item, coverUrl: url } : item));
        } catch {}
      });
    } catch (e) {
      if (kId) {
        setAssetCache(prev => ({ ...prev, [kId]: { groups: [], total: 0 } }));
      }
      alert(e instanceof Error ? e.message : '加载失败');
    } finally { setVolcGroupsLoading(false); }
  };

  const loadVolcAssets = async (page = 1, groupId = selectedGroup?.Id, search = volcAssetSearch) => {
    if (!groupId) return;
    setVolcAssetsLoading(true);
    try {
      const params = new URLSearchParams({ pageNumber: String(page), pageSize: '20', groupId });
      if (search.trim()) params.set('name', search.trim());
      const res = await fetch(`/api/admin/volc-native/assets?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const items: VolcAsset[] = data.data?.Items || [];
      setVolcAssets(items);
      setVolcAssetTotal(data.data?.TotalCount || 0);
      setVolcAssetPage(page);
      // 异步加载每个素材 URL
      items.forEach(async (a) => {
        try {
          const r = await fetch(`/api/admin/volc-native/asset?id=${encodeURIComponent(a.Id)}&keyGroupId=${assetTabKeyGroupId || ''}`, { headers: getAuthHeaders() });
          const d = await r.json();
          const url: string | undefined = d.data?.URL;
          if (url) setAssetUrlMap(prev => ({ ...prev, [a.Id]: url }));
        } catch {}
      });
    } catch (e) {
      if (assetTabKeyGroupId) {
        setAssetCache(prev => ({ ...prev, [assetTabKeyGroupId]: { groups: [], total: 0 } }));
      }
      alert(e instanceof Error ? e.message : '加载失败');
    } finally { setVolcAssetsLoading(false); }
  };

  const handleEnterGroup = (g: VolcAssetGroup) => {
    setSelectedGroup(g);
    setVolcAssets([]);
    setVolcAssetPage(1);
    setVolcAssetSearch('');
    setDetailAsset(null);
    setVolcLevel('assets');
    setAssetUrlMap({});
    loadVolcAssets(1, g.Id, '');
  };

  const handleBackToGroups = () => {
    setVolcLevel('groups');
    setSelectedGroup(null);
    setVolcAssets([]);
    setDetailAsset(null);
    setEditingAsset(null);
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup) return;
    setEditGroupLoading(true);
    try {
      const res = await fetch(`/api/admin/volc-native/asset-groups/${encodeURIComponent(editingGroup.Id)}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: editGroupName.trim(), description: editGroupDesc.trim(), keyGroupId: assetTabKeyGroupId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setEditingGroup(null);
      await loadVolcGroups(volcGroupPage, volcGroupSearch);
    } catch (e) { alert(e instanceof Error ? e.message : '更新失败'); }
    finally { setEditGroupLoading(false); }
  };

  const handleDeleteGroup = async (g: VolcAssetGroup) => {
    if (!confirm(`删除素材组「${g.Name}」（${g.Id}）？\n此操作将同时删除组内所有素材，不可恢复！`)) return;
    try {
      const res = await fetch(`/api/admin/volc-native/asset-groups/${encodeURIComponent(g.Id)}`, {
        method: 'DELETE', headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ keyGroupId: assetTabKeyGroupId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await loadVolcGroups(volcGroupPage, volcGroupSearch);
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败'); }
  };

  const handleUpdateAsset = async () => {
    if (!editingAsset) return;
    setEditAssetLoading(true);
    try {
      const res = await fetch(`/api/admin/volc-native/assets/${encodeURIComponent(editingAsset.Id)}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: editAssetName.trim(), keyGroupId: assetTabKeyGroupId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setEditingAsset(null);
      await loadVolcAssets(volcAssetPage, selectedGroup?.Id, volcAssetSearch);
    } catch (e) { alert(e instanceof Error ? e.message : '更新失败'); }
    finally { setEditAssetLoading(false); }
  };

  const handleDeleteAsset = async (a: VolcAsset) => {
    if (!confirm(`删除素材「${a.Name || a.Id}」？此操作不可撤销。`)) return;
    try {
      const res = await fetch(`/api/admin/volc-native/assets/${encodeURIComponent(a.Id)}`, {
        method: 'DELETE', headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ keyGroupId: assetTabKeyGroupId }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await loadVolcAssets(volcAssetPage, selectedGroup?.Id, volcAssetSearch);
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败'); }
  };

  const handleGetAsset = async (a: VolcAsset) => {
    setDetailLoading(true);
    setDetailAsset(null);
    try {
      const res = await fetch(`/api/admin/volc-native/asset?id=${encodeURIComponent(a.Id)}&keyGroupId=${assetTabKeyGroupId || ''}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setDetailAsset(data.data);
      // 同步更新列表中该条记录的状态
      setVolcAssets(prev => prev.map(item => item.Id === a.Id ? { ...item, Status: data.data.Status, Name: data.data.Name } : item));
    } catch (e) { alert(e instanceof Error ? e.message : '查询失败'); }
    finally { setDetailLoading(false); }
  };

  const loadVolcAkSk = async () => {
    try {
      const res = await fetch('/api/admin/volc-native/aksk', { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success) { setVolcAkId(data.data.access_key_id); setVolcSkKey(data.data.secret_access_key); }
    } catch {}
  };

  const handleSaveVolcAkSk = async () => {
    try {
      const res = await fetch('/api/admin/volc-native/aksk', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ access_key_id: volcAkIdDraft, secret_access_key: volcSkKeyDraft }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setVolcAkId(volcAkIdDraft); setVolcSkKey(volcSkKeyDraft); setVolcAkSkEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };


  // 模型计费
  const [modelPricings, setModelPricings] = useState<ModelPricing[]>([]);
  const [activeModelTab, setActiveModelTab] = useState<string>('');
  const [editingModel, setEditingModel] = useState<Partial<ModelPricing> | null>(null);
  const [newModel, setNewModel] = useState({ model_key: '', label: '', pricing_type: 'seedance2' as 'seedance2' | 'seedance15', price_no_video_low: 0, price_no_video_high: 0, price_with_video_low: 0, price_with_video_high: 0, price_audio: 0, price_silent: 0, sort_order: 0, description: '' });

  // 弹窗状态
  const [showUserModal, setShowUserModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [editCredits, setEditCredits] = useState('');
  const [editOperation, setEditOperation] = useState<'set' | 'add' | 'subtract'>('set');
  // 编辑用户的姓名 / 小组（管理员代填）
  const [editUserName, setEditUserName] = useState('');
  const [editUserDepartment, setEditUserDepartment] = useState('');
  // 小组管理 CRUD 后用这个 key 触发 DepartmentSelect 重新拉一遍下拉列表
  const [departmentRefreshKey, setDepartmentRefreshKey] = useState(0);

  // 激活码管理
  const [codes, setCodes] = useState<ActivationCode[]>([]);
  const [newCode, setNewCode] = useState({ code: '', maxUses: 1, note: '', creditsValue: 0 });
  const [editingCodeId, setEditingCodeId] = useState<number | null>(null);
  const [editingCodeData, setEditingCodeData] = useState({ maxUses: 1, note: '', creditsValue: 0 });
  const [selectedCodeIds, setSelectedCodeIds] = useState<number[]>([]);
  const codeDragStartRef = useRef<number | null>(null);
  const codeDragSelectingRef = useRef(false);

  const handleCodeRowMouseDown = (index: number, id: number, e: React.MouseEvent) => {
    // 点击交互元素（按钮/输入框/复选框）时不触发拖选
    const target = e.target as HTMLElement;
    if (target.closest('button, input, .cursor-pointer')) return;

    codeDragStartRef.current = index;
    codeDragSelectingRef.current = !selectedCodeIds.includes(id);
    setSelectedCodeIds((prev) =>
      codeDragSelectingRef.current
        ? [...new Set([...prev, id])]
        : prev.filter((x) => x !== id)
    );
  };

  const handleCodeRowMouseEnter = (index: number) => {
    if (codeDragStartRef.current === null) return;
    const start = Math.min(codeDragStartRef.current, index);
    const end = Math.max(codeDragStartRef.current, index);
    const rangeIds = codes.slice(start, end + 1).map((c) => c.id);
    setSelectedCodeIds((prev) =>
      codeDragSelectingRef.current
        ? [...new Set([...prev, ...rangeIds])]
        : prev.filter((x) => !rangeIds.includes(x))
    );
  };

  useEffect(() => {
    const stopDrag = () => { codeDragStartRef.current = null; };
    document.addEventListener('mouseup', stopDrag);
    return () => document.removeEventListener('mouseup', stopDrag);
  }, []);

  // 系统配置
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('系统维护中，请稍后再试。');
  const [informationOfAccountOfVolc, setInformationOfAccountOfVolc] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadCodes = async () => {
    try { setCodes(await fetchActivationCodes()); } catch {}
  };

  const loadSystemConfig = async () => {
    try {
      const cfg = await fetchSystemConfig();
      setRegistrationEnabled(cfg.registrationEnabled);
      setMaintenanceMode(cfg.maintenanceMode);
      setMaintenanceMessage(cfg.maintenanceMessage);
      setInformationOfAccountOfVolc(cfg.informationOfAccountOfVolc);
    } catch {}
  };

  const handleCreateCode = async (isConfirmed = false) => {
    if (!newCode.code.trim()) { alert('请输入激活码'); return; }
    try {
      const data = await createActivationCode(isConfirmed ? { ...newCode, confirm: true } : newCode);
      if (data?.needConfirm && data?.warning) {
        if (window.confirm(data.warning)) {
          await handleCreateCode(true);
          return;
        }
      }
      setNewCode({ code: '', maxUses: 1, note: '', creditsValue: 0 });
      await loadCodes();
    } catch (err) { alert(err instanceof Error ? err.message : '创建失败'); }
  };

  const handleUpdateCode = async (id: number) => {
    try {
      await updateActivationCode(id, editingCodeData);
      setEditingCodeId(null);
      await loadCodes();
    } catch (err) { alert(err instanceof Error ? err.message : '更新失败'); }
  };

  const handleDeleteCode = async (id: number, isSelfPaid = false, unused = 0) => {
    if (isSelfPaid) {
      if (!confirm(`该激活码涉及自费，删除将会退还 ${unused} 积分，是否继续？`)) return;
    } else {
      if (!confirm('确定删除此激活码？已激活的用户不受影响。')) return;
    }
    try {
      await deleteActivationCode(id);
      await loadCodes();
    } catch (err) { alert(err instanceof Error ? err.message : '删除失败'); }
  };

  const handleSelectAllCodes = () => {
    if (selectedCodeIds.length === codes.length) {
      setSelectedCodeIds([]);
    } else {
      setSelectedCodeIds(codes.map((c) => c.id));
    }
  };

  const handleSelectUsedUpCodes = () => {
    const usedUpIds = codes.filter((c) => c.used_count >= c.max_uses).map((c) => c.id);
    setSelectedCodeIds(usedUpIds);
  };

  const handleDeleteSelectedCodes = async () => {
    if (selectedCodeIds.length === 0) return;
    if (!confirm(`确定删除选中的 ${selectedCodeIds.length} 个激活码？已激活的用户不受影响。`)) return;
    try {
      for (const id of selectedCodeIds) {
        await deleteActivationCode(id);
      }
      setSelectedCodeIds([]);
      await loadCodes();
    } catch (err) { alert(err instanceof Error ? err.message : '删除失败'); }
  };

  const handleToggleRegistration = async (enabled: boolean) => {
    setSavingConfig(true);
    try {
      await saveSystemConfig({ registrationEnabled: enabled });
      setRegistrationEnabled(enabled);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleToggleMaintenance = async (enabled: boolean) => {
    setSavingConfig(true);
    try {
      await saveSystemConfig({ maintenanceMode: enabled, maintenanceMessage });
      setMaintenanceMode(enabled);
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSaveMaintenanceMessage = async () => {
    setSavingConfig(true);
    try {
      await saveSystemConfig({ maintenanceMessage });
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const loadStats = async () => {
    try {
      const data = await getSystemStats();
      setStats(data);
    } catch (err) {
      console.error('加载系统统计失败:', err);
    }
  };

  const loadUsers = async (page: number = 1) => {
    try {
      setLoading(true);
      const filters: Record<string, string> = {};
      if (filterStatus !== 'all') filters.status = filterStatus;
      if (filterRole !== 'all') filters.role = filterRole;
      if (filterEmail.trim()) filters.email = filterEmail.trim();

      const result = await getUserList(page, 20, filters);
      setUsers(result.users);
      setTotalPages(result.pagination.totalPages);
      setTotalUsers(result.pagination.total);
      setCurrentPage(result.pagination.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    loadUsers();
    loadCodes();
    loadSystemConfig();
    // 权限元数据
    listFeatureKeys().then(setFeatureKeys).catch(() => {});
    getDefaultPermissions().catch(() => {});
    // 只读数据：管理员可查看
    listAllModelPricing().then((list) => { setModelPricings(list); setActiveModelTab(list[0]?.model_key ?? ''); }).catch(() => {});
    fetchEnhancementPricing().then(setEnhancementPricing).catch(() => {});
    fetch('/api/admin/happyhorse-pricing', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((j) => { if (j?.success) setHappyhorsePricing(j.data.pricing || []); })
      .catch(() => {});
    // 折扣数据（管理员可查看）
    fetch('/api/admin/discounts', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((j) => { if (j?.success) setDiscounts(j.data.discounts || []); })
      .catch(() => {});
    getAudioGenConfig().then((d) => { setAudioCfg(d.config); setAudioCfgOptions(d.options); }).catch(() => {});
    if (isSuperAdmin || currentUser?.role === 'admin') {
      loadMultiAccountStatus();
      loadVolcKeyGroups().then(() => {
        // 默认选中第一个可用的 Key 组
        setVolcKeyGroups(groups => {
          const firstActive = groups.find(g => g.is_active);
          if (firstActive) {
            if (!assetTabKeyGroupId) setAssetTabKeyGroupId(firstActive.id);
            if (!taskTabKeyGroupId) {
              setTaskTabKeyGroupId(firstActive.id);
              setManualApiKey(firstActive.ark_model_key);
            }
          }
          return groups;
        });
      });
      getWuyinKey().then((d) => setWuyinKey(d.key)).catch(() => {});
      getMediaKitKey().then((d) => setMediaKitKey(d.key)).catch(() => {});
      getDeepseekConfig().then((d) => {
        setDeepseekKey(d.key); setDeepseekModel(d.model); setDeepseekReasoning(d.reasoning_effort);
      }).catch(() => {});
      // HappyHorse
      fetch('/api/admin/happyhorse-key', { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((j) => { if (j?.success) { setHappyhorseKeyMasked(j.data.masked || ''); setHappyhorseKeyConfigured(!!j.data.configured); } })
        .catch(() => {});
      loadVolcAkSk();
      // 批量生成设置
      fetch('/api/admin/batch-concurrent', { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((j) => { if (j?.success) setBatchMaxConcurrent(j.data.max_concurrent || '5'); })
        .catch(() => {});
      // BSS 配置
      fetch('/api/admin/bss-config', { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((j) => { if (j?.success) { setBssAkMasked(j.data.maskedAk || ''); setBssAkConfigured(!!j.data.akConfigured); setBssSkConfigured(!!j.data.skConfigured); } })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    loadUsers(1);
  }, [filterStatus, filterRole]);

  const handleSearchEmail = () => loadUsers(1);

  const handleExportUsers = async () => {
    try {
      const res = await fetch('/api/admin/users/export', { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '导出失败');
      const users: Record<string, unknown>[] = data.data;

      const roleLabel: Record<string, string> = {
        super_admin: '系统管理员',
        admin: '普通管理员',
        user: '普通用户',
      };
      const statusLabel: Record<string, string> = {
        active: '正常',
        disabled: '禁用',
      };
      const dateFields = new Set(['last_check_in_at', 'created_at', 'updated_at']);

      function fmtDate(val: unknown): string {
        const d = parseServerDate(val as string | number | Date | null | undefined);
        if (!d) return '';
        // UTC+8 格式化
        const opts: Intl.DateTimeFormatOptions = {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false,
          timeZone: 'Asia/Shanghai',
        };
        return new Intl.DateTimeFormat('zh-CN', opts).format(d);
      }

      // 列顺序：id, email, name(第3列), role, status, credits, unlimited_credits,
      //          daily_check_in, last_check_in_at, department, created_at, updated_at,
      //          password_hash(最后)
      const headerMap: [string, string][] = [
        ['id', '用户 ID'],
        ['email', '邮箱'],
        ['name', '名称'],
        ['role', '角色'],
        ['status', '状态'],
        ['credits', '积分'],
        ['unlimited_credits', '无限积分'],
        ['daily_check_in', '每日签到'],
        ['last_check_in_at', '最后签到时间'],
        ['department', '部门'],
        ['created_at', '创建时间'],
        ['updated_at', '更新时间'],
        ['password_hash', '密码哈希'],
      ];

      const rows = users.map((u) =>
        headerMap.map(([key]) => {
          if (key === 'role') return roleLabel[String(u.role)] ?? u.role;
          if (key === 'status') return statusLabel[String(u.status)] ?? u.status;
          if (key === 'unlimited_credits') return u.unlimited_credits === 1 ? '是' : '否';
          if (key === 'department') {
            const deptName = u.department_name ? String(u.department_name) : '';
            const deptId = u.department_id != null ? String(u.department_id) : '';
            return deptName ? `${deptName}[${deptId}]` : deptId;
          }
          if (dateFields.has(key)) return fmtDate(u[key]);
          const val = u[key];
          if (val === null || val === undefined) return '';
          return val;
        })
      );

      const headerRow = headerMap.map(([, label]) => label);
      const sheetData = [headerRow, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '用户列表');
      XLSX.writeFile(wb, `用户列表_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      alert(e instanceof Error ? e.message : '导出失败');
    }
  };

  const handleLoadUserPerms = async (userId: number) => {
    setPermsLoading(true);
    try {
      const perms = await getUserPermissions(userId);
      setUserPerms(perms);
    } catch (e) {
      alert(e instanceof Error ? e.message : '加载权限失败');
    } finally {
      setPermsLoading(false);
    }
  };

  const handleToggleUserPerm = async (key: string, enabled: boolean) => {
    if (!selectedUser) return;
    try {
      const merged = await setUserPermission(selectedUser.id, key, enabled);
      setUserPerms(merged);
    } catch (e) {
      alert(e instanceof Error ? e.message : '更新失败');
    }
  };

  const handleManualKeyQuery = async (page: number = 1) => {
    const key = manualApiKey.trim();
    const tabId = taskTabKeyGroupId ?? 0; // 用 0 作为手动输入 key 的缓存键
    setAccountTasksLoading(true);
    try {
      const result = await listVolcTasks({ apiKey: key || undefined, pageNum: page, pageSize: 20 });
      const items = result.data || result.items || result.tasks || [];
      const raw = JSON.stringify(result, null, 2);
      setTaskCache((prev) => ({
        ...prev,
        [tabId]: { tasks: items as VolcArkTask[], total: result.total || items.length, pageNum: page, rawJson: raw, apiKey: key },
      }));
    } catch (e) {
      alert(e instanceof Error ? e.message : '加载任务失败');
      setTaskCache((prev) => ({
        ...prev,
        [tabId]: { tasks: [], total: 0, pageNum: page, rawJson: '', apiKey: key },
      }));
    } finally {
      setAccountTasksLoading(false);
    }
  };

  const loadVolcKeyGroups = async () => {
    setKeyGroupsLoading(true);
    try { setVolcKeyGroups(await listVolcKeyGroups()); } catch {}
    finally { setKeyGroupsLoading(false); }
  };

  const handleCreateKeyGroup = async () => {
    if (!newKeyGroup.name || !newKeyGroup.ark_model_key) {
      alert('名称、模型Key均必填');
      return;
    }
    try {
      await createVolcKeyGroup(newKeyGroup);
      setNewKeyGroup({ name: '', ark_model_key: 'c7cf1f3a-6a5f-42e2-aae1-ac804020c18c', volc_access_key: '', volc_secret_key: '', grouping_weight: 0, note: '' });
      await loadVolcKeyGroups();
    } catch (e) { alert(e instanceof Error ? e.message : '创建失败'); }
  };

  const handleSaveKeyGroup = async () => {
    if (!editingKeyGroup) return;
    try {
      await updateVolcKeyGroup(editingKeyGroup.id, editingKeyGroup);
      setEditingKeyGroup(null);
      await loadVolcKeyGroups();
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const handleActivateKeyGroup = async (id: number) => {
    // 单账户模式：弹确认框提示将禁用其他组
    if (!multiAccountEnabled && !confirm('激活该组将禁用其他所有 Key 组，确认继续？')) {
      return;
    }
    try {
      await activateVolcKeyGroup(id);
      await loadVolcKeyGroups();
    } catch (e) { alert(e instanceof Error ? e.message : '激活失败'); }
  };

  const handleDeactivateKeyGroup = async (id: number, name: string) => {
    if (!confirm(`确认停用 Key 组「${name}」？`)) return;
    try {
      await deactivateVolcKeyGroup(id);
      await loadVolcKeyGroups();
    } catch (e) { alert(e instanceof Error ? e.message : '停用失败'); }
  };

  const handleDeleteKeyGroup = async (id: number, name: string) => {
    if (!confirm(`确认删除Key组「${name}」？`)) return;
    try {
      await deleteVolcKeyGroup(id);
      await loadVolcKeyGroups();
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败'); }
  };

  const loadMultiAccountStatus = async () => {
    try {
      const r = await fetch('/api/admin/multi-account', { headers: getAuthHeaders() });
      const d = await r.json();
      if (d?.success) setMultiAccountEnabled(d.data.enabled);
    } catch {}
  };

  const handleToggleMultiAccount = async () => {
    const next = !multiAccountEnabled;
    // 关闭开关（单账户模式）时，检查是否有多组激活
    if (!next) {
      const activeCount = volcKeyGroups.filter(g => g.is_active).length;
      if (activeCount > 1) {
        if (!confirm(`关闭多账户模式将只保留第一组激活，其余 ${activeCount - 1} 组将被停用。确认继续？`)) {
          return;
        }
      }
    }
    try {
      const r = await fetch('/api/admin/multi-account', {
        method: 'PUT', headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (d?.success) {
        setMultiAccountEnabled(d.data.enabled);
        await loadVolcKeyGroups(); // 刷新Key组列表，反映激活状态变化
      }
    } catch (e) { alert(e instanceof Error ? e.message : '切换失败'); }
  };

  // 速创API Key
  const handleSaveWuyinKey = async () => {
    try {
      await updateWuyinKey(wuyinKeyDraft);
      setWuyinKey(wuyinKeyDraft);
      setWuyinKeyEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const handleSaveMediaKitKey = async () => {
    try {
      await updateMediaKitKey(mediaKitKeyDraft);
      setMediaKitKey(mediaKitKeyDraft);
      setMediaKitKeyEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };
  
  // DeepSeek 配置保存
  const handleSaveDeepseekConfig = async () => {
    try {
      await updateDeepseekConfig({ key: deepseekKeyDraft, model: deepseekModel, reasoning_effort: deepseekReasoning });
      setDeepseekKey(deepseekKeyDraft);
      setDeepseekKeyEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const handleSaveHappyhorseKey = async () => {
    try {
      const res = await fetch('/api/admin/happyhorse-key', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ apiKey: happyhorseKeyDraft }),
      });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '保存失败');
      // 重新拉
      const r2 = await fetch('/api/admin/happyhorse-key', { headers: getAuthHeaders() });
      const j2 = await r2.json();
      if (j2?.success) {
        setHappyhorseKeyMasked(j2.data.masked || '');
        setHappyhorseKeyConfigured(!!j2.data.configured);
      }
      setHappyhorseKeyEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const handleSaveBssConfig = async () => {
    try {
      const body: Record<string, string> = {};
      if (bssAkDraft) body.accessKeyId = bssAkDraft;
      if (bssSkDraft) body.accessKeySecret = bssSkDraft;
      const res = await fetch('/api/admin/bss-config', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '保存失败');
      const r2 = await fetch('/api/admin/bss-config', { headers: getAuthHeaders() });
      const j2 = await r2.json();
      if (j2?.success) {
        setBssAkMasked(j2.data.maskedAk || '');
        setBssAkConfigured(!!j2.data.akConfigured);
        setBssSkConfigured(!!j2.data.skConfigured);
      }
      setBssAkEditing(false);
      setBssAkDraft('');
      setBssSkDraft('');
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const handleQueryBssBalance = async () => {
    setBssBalanceLoading(true);
    setBssBalanceError('');
    setBssBalance(null);
    try {
      const res = await fetch('/api/admin/bss-balance', { headers: getAuthHeaders() });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '查询失败');
      setBssBalance(j.data);
    } catch (e) {
      setBssBalanceError(e instanceof Error ? e.message : '查询失败');
    } finally {
      setBssBalanceLoading(false);
    }
  };

  const handleQueryVolcBalance = async (keyGroupId: number) => {
    setVolcBalanceLoadingId(keyGroupId);
    setVolcBalanceErrors((prev) => { const next = { ...prev }; delete next[keyGroupId]; return next; });
    setVolcBalances((prev) => { const next = { ...prev }; delete next[keyGroupId]; return next; });
    try {
      const res = await fetch(`/api/admin/volc-balance?keyGroupId=${keyGroupId}`, { headers: getAuthHeaders() });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '查询失败');
      setVolcBalances((prev) => ({ ...prev, [keyGroupId]: j.data }));
    } catch (e) {
      setVolcBalanceErrors((prev) => ({ ...prev, [keyGroupId]: e instanceof Error ? e.message : '查询失败' }));
    } finally {
      setVolcBalanceLoadingId(null);
    }
  };

  const handleUpdateHappyhorsePrice = async (mode: string, resolution: string, creditsPerSecond: number) => {
    try {
      const res = await fetch('/api/admin/happyhorse-pricing', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ pricing: [{ mode, resolution, credits_per_second: creditsPerSecond }] }),
      });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '保存失败');
      setHappyhorsePricing(j.data.pricing || []);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  // 精确匹配折扣
  const getActiveDiscount = (model: string, subKey: string): DiscountItem | undefined => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return discounts.find((d) => d.model === model && d.sub_key === subKey && d.start_date <= now && d.end_date >= now);
  };

  // 计算折扣后的显示数据
  const getDiscountedDisplay = (model: string, subKey: string, originalPrice: number) => {
    const discount = getActiveDiscount(model, subKey);
    if (!discount || discount.value <= 0) return { discounted: false, price: originalPrice, percent: 0 };
    let discounted: number;
    if (discount.type === 'percent') {
      discounted = Math.ceil(originalPrice * (1 - discount.value / 100));
    } else {
      discounted = Math.ceil(discount.value);
    }
    const percent = discount.type === 'percent' ? discount.value : Math.round((1 - discount.value / originalPrice) * 100 * 100) / 100;
    return { discounted: true, price: discounted, percent };
  };

  // 折扣价格渲染
  const renderDiscountedPrice = (model: string, subKey: string, originalPrice: number) => {
    const d = getDiscountedDisplay(model, subKey, originalPrice);
    if (!d.discounted) return <div className="text-amber-400 text-sm">{originalPrice}</div>;
    return (
      <div className="flex items-center gap-2">
        <span className="text-gray-500 text-sm line-through">{originalPrice}</span>
        <span className="text-emerald-400 text-sm font-semibold">{d.price}</span>
        <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 text-[10px] font-medium">
          -{d.percent.toFixed(2)}%
        </span>
      </div>
    );
  };


  const handleSaveAudioCfg = async () => {
    if (!audioCfgDraft) return;
    setAudioCfgSaving(true);
    try {
      const res = await updateAudioGenConfig(audioCfgDraft);
      setAudioCfg(res.config);
      setAudioCfgEditing(false);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
    finally { setAudioCfgSaving(false); }
  };

  const handleUpdateEnhancementBaseRate = async (baseCreditsPerMinute: number) => {
    try {
      await updateEnhancementBaseRate(baseCreditsPerMinute);
      const fresh = await fetchEnhancementPricing();
      setEnhancementPricing(fresh);
    } catch (e) { alert(e instanceof Error ? e.message : '保存失败'); }
  };

  const reloadModelPricings = () =>
    listAllModelPricing().then((list) => {
      setModelPricings(list);
      setActiveModelTab((prev) => prev || (list[0]?.model_key ?? ''));
    }).catch(() => {});

  const handleSaveModelEdit = async (m: ModelPricing) => {
    try {
      await upsertModelPricing(m.model_key, {
        label: m.label,
        pricing_type: m.pricing_type,
        price_no_video_low: m.price_no_video_low,
        price_no_video_high: m.price_no_video_high,
        price_with_video_low: m.price_with_video_low,
        price_with_video_high: m.price_with_video_high,
        price_audio: m.price_audio,
        price_silent: m.price_silent,
        draft_factor_audio: m.draft_factor_audio,
        draft_factor_silent: m.draft_factor_silent,
        default_fps: m.default_fps,
        enabled: m.enabled ? 1 : 0,
        sort_order: m.sort_order,
        description: m.description || '',
      });
      setEditingModel(null);
      await reloadModelPricings();
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handleToggleModelEnabled = async (m: ModelPricing) => {
    try {
      await upsertModelPricing(m.model_key, {
        label: m.label,
        pricing_type: m.pricing_type,
        price_no_video_low: m.price_no_video_low,
        price_no_video_high: m.price_no_video_high,
        price_with_video_low: m.price_with_video_low,
        price_with_video_high: m.price_with_video_high,
        price_audio: m.price_audio,
        price_silent: m.price_silent,
        draft_factor_audio: m.draft_factor_audio,
        draft_factor_silent: m.draft_factor_silent,
        default_fps: m.default_fps,
        enabled: m.enabled ? 0 : 1,
        sort_order: m.sort_order,
        description: m.description || '',
      });
      await reloadModelPricings();
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handleCreateModel = async () => {
    if (!newModel.model_key.trim() || !newModel.label.trim()) {
      alert('model_key 和 label 必填');
      return;
    }
    try {
      await upsertModelPricing(newModel.model_key, {
        label: newModel.label,
        pricing_type: newModel.pricing_type,
        price_no_video_low: Number(newModel.price_no_video_low) || 0,
        price_no_video_high: Number(newModel.price_no_video_high) || 0,
        price_with_video_low: Number(newModel.price_with_video_low) || 0,
        price_with_video_high: Number(newModel.price_with_video_high) || 0,
        price_audio: Number(newModel.price_audio) || 0,
        price_silent: Number(newModel.price_silent) || 0,
        enabled: 1,
        sort_order: Number(newModel.sort_order) || 0,
        description: newModel.description,
      });
      setNewModel({ model_key: '', label: '', pricing_type: 'seedance2', price_no_video_low: 0, price_no_video_high: 0, price_with_video_low: 0, price_with_video_high: 0, price_audio: 0, price_silent: 0, sort_order: 0, description: '' });
      await reloadModelPricings();
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    }
  };

  const handleDeleteModel = async (modelKey: string) => {
    if (!confirm(`确认删除模型计费配置「${modelKey}」？`)) return;
    try {
      await deleteModelPricing(modelKey);
      await reloadModelPricings();
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleStatusChange = async (userId: number, newStatus: 'active' | 'disabled') => {
    try {
      await updateUserStatus(userId, newStatus);
      loadUsers(currentPage);
      loadStats();
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新状态失败');
    }
  };

  const handleOpenUserModal = (user: User) => {
    setSelectedUser(user);
    setEditCredits('');
    setShowUserModal(true);
    setUserPerms({});
    setEditUserName((user.name || '').trim());
    setEditUserDepartment((user.department || '').trim());
    handleLoadUserPerms(user.id);
  };

  const handleUpdateCredits = async () => {
    if (!selectedUser) return;

    // 统一保存：姓名 / 小组 / 积分。任意一项有改动才调对应 API。
    const trimmedName = editUserName.trim();
    const trimmedDept = editUserDepartment.trim();
    const origName = (selectedUser.name || '').trim();
    const origDept = (selectedUser.department || '').trim();
    // 普通管理员不允许修改小组，部门变更仅对系统管理员生效
    const deptChanged = isSuperAdmin && trimmedDept !== origDept;
    const profileChanged = trimmedName !== origName || deptChanged;
    const creditsChanged = !!editCredits;

    if (!profileChanged && !creditsChanged) {
      setShowUserModal(false);
      return;
    }

    try {
      if (profileChanged) {
        await updateUserProfileByAdmin(selectedUser.id, {
          name: trimmedName === '' ? null : trimmedName,
          department: deptChanged ? (trimmedDept === '' ? null : trimmedDept) : undefined,
        });
      }
      if (creditsChanged) {
        const credits = parseInt(editCredits);
        if (isNaN(credits) || credits < 0) {
          alert('请输入有效的积分数量');
          return;
        }
        await updateUserCredits(selectedUser.id, credits, editOperation);
        loadStats();
      }
      loadUsers(currentPage);
      setShowUserModal(false);
      alert('已保存');
    } catch (err) {
      alert(err instanceof Error ? err.message : '保存失败');
    }
  };

  const handleResetPassword = async () => {
    if (!selectedUser) return;

    const newPassword = prompt('请输入新密码（至少 8 位，包含数字和字母）:');
    if (!newPassword) return;

    try {
      await resetUserPassword(selectedUser.id, newPassword);
      try { await navigator.clipboard.writeText(newPassword); } catch {}
      alert(`用户 ${selectedUser.email} 的密码已重置，新密码已复制到剪贴板`);
    } catch (err) {
      alert(err instanceof Error ? err.message : '重置密码失败');
    }
  };

  const handleToggleUnlimited = async (user: User) => {
    const current = (user as any).unlimitedCredits || user.unlimitedCredits;
    try {
      await toggleUnlimitedCredits(user.id, !current);
      loadUsers(currentPage);
    } catch (err) {
      alert(err instanceof Error ? err.message : '更新失败');
    }
  };

  const StatCard = ({ title, value, icon: Icon, color }: {
    title: string;
    value: string | number;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }) => (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-400 text-sm mb-1">{title}</p>
          <p className="text-3xl font-bold text-white">{value}</p>
        </div>
        <div className={`w-12 h-12 rounded-xl ${color} flex items-center justify-center`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
    </div>
  );


  return (
    <div className="min-h-screen bg-[#0f111a] p-6">
      <div className="max-w-7xl mx-auto">
        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">管理后台</h1>
          <p className="text-gray-400">管理系统用户和查看系统统计</p>
        </div>

        {/* 统计卡片 */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            <StatCard title="总用户数" value={stats.totalUsers} icon={UsersIcon} color="bg-gradient-to-br from-blue-500 to-cyan-500" />
            <StatCard title="活跃用户" value={stats.activeUsers} icon={CheckIcon} color="bg-gradient-to-br from-green-500 to-emerald-500" />
            <StatCard title="总项目组数" value={stats.totalProjects} icon={SparkleIcon} color="bg-gradient-to-br from-purple-500 to-pink-500" />
            <StatCard title="总任务数" value={stats.totalTasks} icon={ShieldIcon} color="bg-gradient-to-br from-amber-500 to-orange-500" />
            <StatCard title="今日签到" value={stats.todayCheckIns} icon={CheckIcon} color="bg-gradient-to-br from-rose-500 to-red-500" />
            <StatCard title="发放积分" value={stats.totalCreditsIssued} icon={SparkleIcon} color="bg-gradient-to-br from-indigo-500 to-violet-500" />
          </div>
        )}

        {/* ═══════════ 消耗分析面板 ═══════════ */}
        <AnalyticsPanels />

        {/* 积分发放统计 */}
        <CreditDistributionPanel />

        {/* 激活码管理 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden mb-8">
          <div className="p-6 border-b border-gray-800">
            <h2 className="text-xl font-semibold text-white">激活码管理</h2>
            <p className="text-gray-400 text-sm mt-1">激活码兑换后向用户积分账户增加指定积分（支持负数扣减）</p>
          </div>

          {/* 新建激活码 */}
          <div className="p-6 border-b border-gray-800">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <input
                type="text"
                value={newCode.code}
                onChange={(e) => setNewCode({ ...newCode, code: e.target.value })}
                placeholder="激活码"
                className="bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500"
              />
              <input
                type="number"
                value={newCode.creditsValue}
                onChange={(e) => setNewCode({ ...newCode, creditsValue: Number(e.target.value) })}
                placeholder="积分变化（正增负减）"
                className="bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500"
              />
              <input
                type="number"
                min={1}
                value={newCode.maxUses}
                onChange={(e) => setNewCode({ ...newCode, maxUses: Number(e.target.value) })}
                placeholder="使用次数"
                className="bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCode.note}
                  onChange={(e) => setNewCode({ ...newCode, note: e.target.value })}
                  placeholder="备注（可选）"
                  className="flex-1 bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500"
                />
                <button
                  onClick={() => handleCreateCode()}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-sm font-medium transition-all"
                >
                  <PlusIcon className="w-4 h-4" />
                  创建
                </button>
              </div>
            </div>
          </div>

          {/* 激活码列表 */}
          {selectedCodeIds.length > 0 && (
            <div className="px-6 py-3 bg-[#0f111a] border-b border-gray-800 flex items-center gap-3">
              <span className="text-sm text-gray-300">已选择 {selectedCodeIds.length} 项</span>
              <button onClick={handleDeleteSelectedCodes} className="px-3 py-1.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-md text-xs font-medium transition-all">删除选中（{selectedCodeIds.length}）</button>
              <button onClick={handleSelectUsedUpCodes} className="px-3 py-1.5 bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 rounded-md text-xs font-medium transition-all">一键选中已用完</button>
            </div>
          )}
          {codes.length === 0 ? (
            <div className="p-8 text-center text-gray-500">暂无激活码</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[#0f111a]">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase w-10">
                      <StyledCheckbox
                        checked={selectedCodeIds.length === codes.length && codes.length > 0}
                        indeterminate={selectedCodeIds.length > 0 && selectedCodeIds.length < codes.length}
                        onChange={handleSelectAllCodes}
                      />
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">激活码</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">积分变化</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">已用 / 总次</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">备注</th>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">用量</th>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">创建时间</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {codes.map((c, idx) => (
                    <tr key={c.id} className="hover:bg-[#0f111a]/50"
                      onMouseDown={(e) => handleCodeRowMouseDown(idx, c.id, e)}
                      onMouseEnter={() => handleCodeRowMouseEnter(idx)}
                    >
                      <td className="px-6 py-4 text-sm">
                        <StyledCheckbox
                          checked={selectedCodeIds.includes(c.id)}
                          onChange={() => {
                            setSelectedCodeIds((prev) =>
                              prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                            );
                          }}
                        />
                      </td>
                        <td className="px-6 py-4 text-sm font-mono">
                         {(() => {
                           // 每日积分过期：基于 created_at 日期判断（仅当天有效）
                           const todayStr = new Date().toISOString().slice(0, 10);
                           const trulyExpired = c.is_credit_daily === 1 && c.created_at?.slice(0, 10) !== todayStr;
                           const usedUp = c.used_count >= c.max_uses;
                            const showExpiredBadge = trulyExpired;
                           const gray = trulyExpired || usedUp;
                           return (
                             <span className="inline-flex items-center gap-2">
                               <span className={gray ? 'text-gray-400' : 'text-white'}>{c.code}</span>
                               {showExpiredBadge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/50 text-gray-400">过期</span>}
                             </span>
                           );
                         })()}
                       </td>
                      <td className="px-6 py-4 text-sm">
                        {editingCodeId === c.id ? (
                          <input
                            type="number"
                            value={editingCodeData.creditsValue}
                            onChange={(e) => setEditingCodeData({ ...editingCodeData, creditsValue: Number(e.target.value) })}
                            className="w-28 bg-[#0f111a] border border-gray-700 rounded px-2 py-1 text-sm text-white"
                          />
                        ) : (
                          <span className={c.credits_value >= 0 ? 'text-green-400' : 'text-red-400'}>
                            {c.credits_value >= 0 ? '+' : ''}{c.credits_value}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {editingCodeId === c.id ? (
                          <input
                            type="number"
                            min={c.used_count}
                            value={editingCodeData.maxUses}
                            onChange={(e) => setEditingCodeData({ ...editingCodeData, maxUses: Number(e.target.value) })}
                            className="w-20 bg-[#0f111a] border border-gray-700 rounded px-2 py-1 text-sm text-white"
                          />
                        ) : (
                          <span className={`${c.used_count >= c.max_uses ? 'text-red-400' : 'text-green-400'}`}>
                            {c.used_count} / {c.max_uses}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-400">
                        {editingCodeId === c.id ? (
                          <input
                            type="text"
                            value={editingCodeData.note}
                            onChange={(e) => setEditingCodeData({ ...editingCodeData, note: e.target.value })}
                            className="w-36 bg-[#0f111a] border border-gray-700 rounded px-2 py-1 text-sm text-white"
                          />
                        ) : (
                          c.note || '-'
                        )}
                      </td>
                       <td className="px-6 py-4 text-sm text-gray-400">
                         {(currentUser?.role === 'super_admin' || c.created_by === currentUser?.id) && (
                           (() => {
                             const total = c.credits_value * c.max_uses;
                             const consumed = c.credits_value * c.used_count;
                             const expired = c.is_credit_daily === 1 && c.created_at?.slice(0, 10) !== new Date().toISOString().slice(0, 10);
                             if (expired || c.used_count >= c.max_uses) return null;
                             if (c.is_credit_daily === 1) return <span className="text-blue-400">今日额度 {total}（{consumed} 已被领取）</span>;
                             if (c.is_credit_daily === 0) return <span className="text-amber-400">自费额度 {total}（{consumed} 已被领取）</span>;
                             return null;
                           })()
                         )}
                       </td>
                       <td className="px-6 py-4 text-sm text-gray-400">
                         {formatDate(c.created_at)}
                       </td>
                      <td className="px-6 py-4 text-sm">
                        <div className="flex gap-2">
                          {editingCodeId === c.id ? (
                            <>
                              <button onClick={() => handleUpdateCode(c.id)} className="btn-save">保存</button>
                              <button onClick={() => setEditingCodeId(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-md text-xs font-medium transition-colors">取消</button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => { setEditingCodeId(c.id); setEditingCodeData({ maxUses: c.max_uses, note: c.note, creditsValue: c.credits_value }); }}
                                className="btn-edit"
                              >编辑</button>
                              <button onClick={() => {
                                const isSelfPaid = c.is_credit_daily === 0;
                                const unused = (c.max_uses - c.used_count) * c.credits_value;
                                handleDeleteCode(c.id, isSelfPaid, unused);
                              }} className="btn-danger">删除</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 用户列表 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden mb-8">
          <div className="p-6 border-b border-gray-800">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <h2 className="text-xl font-semibold text-white">用户管理</h2>
              <div className="flex items-center gap-3">
                {isSuperAdmin && (
                  <button
                    onClick={handleExportUsers}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    导出Excel
                  </button>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={filterEmail}
                    onChange={(e) => setFilterEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSearchEmail(); }}
                    placeholder="按邮箱搜索"
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 w-56"
                  />
                  <button
                    onClick={handleSearchEmail}
                    className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-xl text-white text-sm font-medium transition-colors"
                  >
                    搜索
                  </button>
                </div>
                {isSuperAdmin && (
                  <select
                    value={filterRole}
                    onChange={(e) => setFilterRole(e.target.value)}
                    className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="all">所有角色</option>
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                )}
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="all">所有状态</option>
                  <option value="active">正常</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin text-purple-500">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-gray-400 mt-4">加载中...</p>
            </div>
          ) : error ? (
            <div className="p-12 text-center text-red-400">{error}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-[#0f111a]">
                    <tr>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">ID</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">邮箱</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">姓名</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">小组</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase min-w-[5em]">角色</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase min-w-[2em]">状态</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">积分</th>
                      {isSuperAdmin && <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">无限额度</th>}
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">注册时间</th>
                      <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {(isSuperAdmin ? users : users).map((user) => {
                      // 普通管理员只能操作自己小组的普通用户 + 自己；系统管理员可编辑所有人。
                      const adminDeptId = currentUser ? (users.find(u => u.id === currentUser.id) as any)?.department_id : null;
                      const sameDept = isSuperAdmin || (adminDeptId != null && (user as any).department_id === adminDeptId);
                      const canEdit = isSuperAdmin || (sameDept && (user.role === 'user' || user.id === currentUser?.id));
                      return (
                      <tr key={user.id} className="hover:bg-[#0f111a]/50">
                        <td className="px-6 py-4 text-sm text-gray-400">#{user.id}</td>
                        <td className="px-6 py-4 text-sm text-white">{user.email}</td>
                        <td className="px-6 py-4 text-sm text-gray-300">
                          {user.name || <span className="text-amber-500/80 text-xs">未填</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-300">
                          {user.department || <span className="text-amber-500/80 text-xs">未填</span>}
                        </td>
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            user.role === 'super_admin' ? 'bg-red-500/20 text-red-400' :
                            user.role === 'admin' ? 'bg-amber-500/20 text-amber-400' :
                            'bg-gray-500/20 text-gray-400'
                          }`}>
                            {user.role === 'super_admin' ? '系统管理员' : user.role === 'admin' ? '普通管理员' : '普通用户'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm whitespace-nowrap">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${user.status === 'active' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                            {user.status === 'active' ? '正常' : '禁用'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-white">
                          {(user as any).unlimitedCredits || user.unlimitedCredits ? (
                            <span className="text-amber-400 font-semibold">∞</span>
                          ) : (
                            user.credits
                          )}
                        </td>
                        {isSuperAdmin && (
                          <td className="px-6 py-4 text-sm">
                            <button
                              onClick={() => handleToggleUnlimited(user)}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${(user as any).unlimitedCredits || user.unlimitedCredits ? 'bg-amber-500' : 'bg-gray-700'}`}
                            >
                              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${(user as any).unlimitedCredits || user.unlimitedCredits ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>
                          </td>
                        )}
                        <td className="px-6 py-4 text-sm text-gray-400">
                          {formatDateTime(user.createdAt!)}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <div className="flex items-center gap-2">
                            {canEdit ? (
                              <>
                                {/* 禁用 / 启用：不允许操作自己（自己禁自己 = 自锁） */}
                                {user.id !== currentUser?.id && (
                                  <button
                                    onClick={() => handleStatusChange(user.id, user.status === 'active' ? 'disabled' : 'active')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${user.status === 'active' ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'}`}
                                  >
                                    {user.status === 'active' ? '禁用' : '启用'}
                                  </button>
                                )}
                                {isSuperAdmin && user.id !== currentUser?.id && (
                                  <select
                                    value={user.role}
                                    onChange={async (e) => {
                                      try {
                                        await setUserRole(user.id, e.target.value as 'user' | 'admin' | 'super_admin');
                                        loadUsers(currentPage);
                                      } catch (err) { alert(err instanceof Error ? err.message : '修改失败'); }
                                    }}
                                    className="px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-xs text-white"
                                  >
                                    <option value="user">普通用户</option>
                                    <option value="admin">普通管理员</option>
                                    <option value="super_admin">系统管理员</option>
                                  </select>
                                )}
                                <button
                                  onClick={() => handleOpenUserModal(user)}
                                  className="px-3 py-1.5 bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 rounded-md text-xs font-medium transition-all"
                                >
                                  编辑
                                </button>
                              </>
                            ) : (
                              <span className="text-xs text-gray-600">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                      );
                    })}

                  </tbody>
                </table>
              </div>

              {/* 分页 */}
              <div className="p-6 border-t border-gray-800 flex items-center justify-between">
                <p className="text-sm text-gray-400">共 {totalUsers} 个用户，第 {currentPage} / {totalPages} 页</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => loadUsers(currentPage - 1)} disabled={currentPage <= 1} className="btn-page">上一页</button>
                  <button onClick={() => loadUsers(currentPage + 1)} disabled={currentPage >= totalPages} className="btn-page">下一页</button>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">跳转</span>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      defaultValue={currentPage}
                      key={currentPage}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = parseInt((e.target as HTMLInputElement).value);
                          if (!isNaN(v) && v >= 1 && v <= totalPages) loadUsers(v);
                        }
                      }}
                      className="w-16 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-white text-sm"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* 小组管理（紧邻用户列表） */}
        <DepartmentManagementCard onChanged={() => setDepartmentRefreshKey((k) => k + 1)} />

        {/* 系统设置（仅系统管理员） */}
        {isSuperAdmin && (
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">系统设置</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-white text-sm font-medium">开放用户注册</p>
              <p className="text-gray-400 text-xs mt-0.5">关闭后新用户无法注册账号</p>
            </div>
            <button
              onClick={() => handleToggleRegistration(!registrationEnabled)}
              disabled={savingConfig}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${registrationEnabled ? 'bg-purple-600' : 'bg-gray-700'} ${savingConfig ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${registrationEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="border-t border-gray-700 mt-4 pt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-white text-sm font-medium">维护模式</p>
                <p className="text-gray-400 text-xs mt-0.5">开启后所有用户看到维护公告，仅管理员可正常使用</p>
              </div>
              <button
                onClick={() => handleToggleMaintenance(!maintenanceMode)}
                disabled={savingConfig}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${maintenanceMode ? 'bg-yellow-500' : 'bg-gray-700'} ${savingConfig ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${maintenanceMode ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={maintenanceMessage}
                onChange={(e) => setMaintenanceMessage(e.target.value)}
                placeholder="维护公告内容"
                className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
              />
              <button
                onClick={handleSaveMaintenanceMessage}
                disabled={savingConfig}
                className="btn-save disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
        )}


        {/* 模型计费管理 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">模型计费管理</h2>
              <p className="text-xs text-gray-500 mt-1">每次生成任务按 model 扣减积分；1 元 ≈ 100 积分</p>
            </div>
            {isSuperAdmin && (
            <button
              onClick={() => setDiscountModalScope('model')}
              className="px-4 py-2 bg-amber-600/20 border border-amber-500/40 hover:bg-amber-600/30 rounded-lg text-amber-400 text-sm font-medium transition-all"
            >
              折扣设置
            </button>
            )}
          </div>

          <div className="flex gap-1 mb-4 flex-wrap">
            {modelPricings.map((m) => (
              <button
                key={m.model_key}
                onClick={() => { setActiveModelTab(m.model_key); setEditingModel(null); }}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${activeModelTab === m.model_key ? 'bg-purple-600 text-white' : 'bg-[#0f111a] border border-gray-700 text-gray-400 hover:text-white'}`}
              >
                {m.label || m.model_key}
                {!m.enabled && <span className="ml-1 text-xs text-gray-500">(禁用)</span>}
              </button>
            ))}
            {isSuperAdmin && (
            <button
              onClick={() => setActiveModelTab('__new__')}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${activeModelTab === '__new__' ? 'bg-green-600 text-white' : 'bg-[#0f111a] border border-gray-700 text-gray-400 hover:text-white'}`}
            >+ 添加模型</button>
            )}
          </div>

          {activeModelTab === '__new__' ? (
            <div className="bg-[#0f111a] rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-medium text-white mb-4">新增模型计费配置</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className="block text-xs text-gray-400 mb-1">model_key</label><input className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.model_key} onChange={(e) => setNewModel((s) => ({ ...s, model_key: e.target.value }))} placeholder="seedance-2.0-fast" /></div>
                <div><label className="block text-xs text-gray-400 mb-1">展示名</label><input className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.label} onChange={(e) => setNewModel((s) => ({ ...s, label: e.target.value }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">无视频/720p 单价</label><input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.price_no_video_low} onChange={(e) => setNewModel((s) => ({ ...s, price_no_video_low: Number(e.target.value) }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">无视频/1080p 单价</label><input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.price_no_video_high} onChange={(e) => setNewModel((s) => ({ ...s, price_no_video_high: Number(e.target.value) }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">含视频/720p 单价</label><input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.price_with_video_low} onChange={(e) => setNewModel((s) => ({ ...s, price_with_video_low: Number(e.target.value) }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">含视频/1080p 单价</label><input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.price_with_video_high} onChange={(e) => setNewModel((s) => ({ ...s, price_with_video_high: Number(e.target.value) }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">排序</label><input type="number" min="0" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.sort_order} onChange={(e) => setNewModel((s) => ({ ...s, sort_order: Number(e.target.value) }))} /></div>
                <div><label className="block text-xs text-gray-400 mb-1">描述</label><input className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={newModel.description} onChange={(e) => setNewModel((s) => ({ ...s, description: e.target.value }))} /></div>
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={handleCreateModel} className="btn-primary">新增</button>
                <button onClick={() => setActiveModelTab(modelPricings[0]?.model_key ?? '')} className="btn-secondary">取消</button>
              </div>
            </div>
          ) : modelPricings.filter((m) => m.model_key === activeModelTab).map((m) => {
            const isEditing = editingModel?.model_key === m.model_key;
            const ev = isEditing ? editingModel as ModelPricing : m;
            const update = (patch: Partial<ModelPricing>) => setEditingModel((s) => ({ ...(s as ModelPricing), ...patch }));
            return (
              <div key={m.model_key} className="bg-[#0f111a] rounded-xl p-5 border border-gray-800">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="text-white font-medium">{m.label}</div>
                    <div className="text-xs text-gray-500 font-mono mt-0.5">{m.model_key}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {isSuperAdmin && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">启用</span>
                      <button onClick={() => handleToggleModelEnabled(m)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${m.enabled ? 'bg-green-500' : 'bg-gray-700'}`}>
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${m.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                    )}
                    {isSuperAdmin && !isEditing && <button onClick={() => setEditingModel({ ...m })} className="btn-edit">编辑</button>}
                    {isSuperAdmin && <button onClick={() => handleDeleteModel(m.model_key)} className="btn-danger">删除</button>}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div><label className="block text-xs text-gray-400 mb-1">展示名</label>{isEditing ? <input className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.label} onChange={(e) => update({ label: e.target.value })} /> : <div className="text-white text-sm">{m.label}</div>}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">排序</label>{isEditing ? <input type="number" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.sort_order} onChange={(e) => update({ sort_order: Number(e.target.value) })} /> : <div className="text-white text-sm">{m.sort_order}</div>}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">无视频/720p 单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_no_video_low} onChange={(e) => update({ price_no_video_low: Number(e.target.value) })} /> : renderDiscountedPrice(m.model_key, 'price_no_video_low', m.price_no_video_low)}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">无视频/1080p 单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_no_video_high} onChange={(e) => update({ price_no_video_high: Number(e.target.value) })} /> : (m.price_no_video_high ? renderDiscountedPrice(m.model_key, 'price_no_video_high', m.price_no_video_high) : <div className="text-gray-500 text-sm">—</div>)}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">含视频/720p 单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_with_video_low} onChange={(e) => update({ price_with_video_low: Number(e.target.value) })} /> : renderDiscountedPrice(m.model_key, 'price_with_video_low', m.price_with_video_low)}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">含视频/1080p 单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_with_video_high} onChange={(e) => update({ price_with_video_high: Number(e.target.value) })} /> : (m.price_with_video_high ? renderDiscountedPrice(m.model_key, 'price_with_video_high', m.price_with_video_high) : <div className="text-gray-500 text-sm">—</div>)}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">有声单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_audio} onChange={(e) => update({ price_audio: Number(e.target.value) })} /> : (m.price_audio ? renderDiscountedPrice(m.model_key, 'price_audio', m.price_audio) : <div className="text-gray-500 text-sm">—</div>)}</div>
                  <div><label className="block text-xs text-gray-400 mb-1">无声单价</label>{isEditing ? <input type="number" step="0.01" className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.price_silent} onChange={(e) => update({ price_silent: Number(e.target.value) })} /> : (m.price_silent ? renderDiscountedPrice(m.model_key, 'price_silent', m.price_silent) : <div className="text-gray-500 text-sm">—</div>)}</div>
                  <div className="md:col-span-2"><label className="block text-xs text-gray-400 mb-1">描述</label>{isEditing ? <input className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" value={ev.description || ''} onChange={(e) => update({ description: e.target.value })} /> : <div className="text-gray-400 text-sm">{m.description || '—'}</div>}</div>
                </div>
                {isEditing && (
                  <div className="mt-4 flex gap-2">
                    <button onClick={() => handleSaveModelEdit(ev)} className="btn-save">保存</button>
                    <button onClick={() => setEditingModel(null)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 火山原生资产库 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          {/* 头部 */}
          <div className="mb-4 flex items-start justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {volcLevel === 'assets' && (
                <button onClick={handleBackToGroups} className="p-1.5 bg-[#0f111a] border border-gray-700 hover:border-gray-500 rounded-xl text-gray-400 hover:text-white text-xs transition-colors">← 返回</button>
              )}
              <div>
                <h2 className="text-xl font-semibold text-white">私域虚拟人像素材库</h2>
                {volcLevel === 'assets' && selectedGroup && (
                  <p className="text-xs text-purple-400 mt-0.5 font-mono">{selectedGroup.Name} · {selectedGroup.Id}</p>
                )}
                {volcLevel === 'groups' && (
                  <p className="text-xs text-gray-500 mt-1">AIGC 类型素材组管理，素材 URI 格式：<code className="text-cyan-400">asset://{'<asset_id>'}</code></p>
                )}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {volcLevel === 'groups' && (
                <button onClick={() => loadVolcGroups(1, volcGroupSearch, assetTabKeyGroupId)} disabled={volcGroupsLoading}
                  className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-xl text-white text-xs">
                  {volcGroupsLoading ? '加载中...' : '查询'}
                </button>
              )}
              {volcLevel === 'assets' && (
                <button onClick={() => loadVolcAssets(1)} disabled={volcAssetsLoading}
                  className="px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-xl text-gray-400 hover:text-white text-xs disabled:opacity-50">
                  {volcAssetsLoading ? '加载中...' : '刷新'}
                </button>
              )}
              {isSuperAdmin && (() => {
                const selGroup = volcKeyGroups.find(kg => kg.id === assetTabKeyGroupId);
                const ak = selGroup?.volc_access_key || volcAkId;
                const sk = selGroup?.volc_secret_key || volcSkKey;
                return (
                <button onClick={() => { setVolcAkSkEditing(v => !v); setVolcAkIdDraft(ak); setVolcSkKeyDraft(sk); }}
                  className="px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-xl text-gray-400 hover:text-white text-xs">配置 AK/SK</button>
                );
              })()}
            </div>
          </div>

          {/* API 账户 Tab 切换 */}
          {volcLevel === 'groups' && volcKeyGroups.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {volcKeyGroups.map((kg) => {
                const isActive = assetTabKeyGroupId === kg.id;
                const isDisabled = !kg.is_active;
                return (
                  <button
                    key={kg.id}
                    onClick={() => {
                      if (isActive) return;
                      setAssetTabKeyGroupId(kg.id);
                      // 恢复缓存的 tab 数据
                      const cached = assetCache[kg.id];
                      if (cached) {
                        setVolcAssetGroups(cached.groups);
                        setVolcGroupTotal(cached.total);
                      } else {
                        setVolcAssetGroups([]);
                        setVolcGroupTotal(0);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isActive
                        ? 'bg-purple-600 text-white shadow-sm shadow-purple-600/20'
                        : isDisabled
                          ? 'bg-gray-800/50 text-gray-500 border border-gray-700/50 hover:border-gray-600'
                          : 'bg-[#0f111a] text-gray-400 border border-gray-700 hover:border-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {kg.name}
                    {isDisabled && <span className="ml-1 text-[10px] opacity-60">(未激活)</span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* AK/SK 配置面板（仅系统管理员） */}
          {isSuperAdmin && volcAkSkEditing && (
            <div className="mb-4 p-4 bg-[#0f111a] border border-gray-700 rounded-xl space-y-3">
              <div><label className="block text-xs text-gray-400 mb-1">Access Key ID</label>
                <input value={volcAkIdDraft} onChange={(e) => setVolcAkIdDraft(e.target.value)}
                  className="w-full bg-[#1c1f2e] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" /></div>
              <div><label className="block text-xs text-gray-400 mb-1">Secret Access Key</label>
                <input value={volcSkKeyDraft} onChange={(e) => setVolcSkKeyDraft(e.target.value)} type="password"
                  className="w-full bg-[#1c1f2e] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" /></div>
              <div className="flex gap-2">
                <button onClick={handleSaveVolcAkSk} className="btn-save">保存</button>
                <button onClick={() => setVolcAkSkEditing(false)} className="px-4 py-2 bg-gray-700 rounded-xl text-white text-sm">取消</button>
              </div>
            </div>
          )}

          {/* 编辑素材组弹层（仅系统管理员） */}
          {isSuperAdmin && editingGroup && (
            <div className="mb-4 p-4 bg-[#0f111a] border border-purple-500/30 rounded-xl space-y-3">
              <h3 className="text-sm font-medium text-white">编辑素材组 · <span className="text-gray-400 font-mono text-xs">{editingGroup.Id}</span></h3>
              <input value={editGroupName} onChange={(e) => setEditGroupName(e.target.value)} placeholder="名称 *"
                className="w-full bg-[#1c1f2e] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
              <input value={editGroupDesc} onChange={(e) => setEditGroupDesc(e.target.value)} placeholder="描述（可选）"
                className="w-full bg-[#1c1f2e] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
              <div className="flex gap-2">
                <button onClick={handleUpdateGroup} disabled={editGroupLoading}
                  className="btn-save disabled:opacity-50">{editGroupLoading ? '保存中...' : '保存'}</button>
                <button onClick={() => setEditingGroup(null)} className="px-4 py-2 bg-gray-700 rounded-xl text-white text-sm">取消</button>
              </div>
            </div>
          )}

          {/* 编辑素材弹层（仅系统管理员） */}
          {isSuperAdmin && editingAsset && (
            <div className="mb-4 p-4 bg-[#0f111a] border border-purple-500/30 rounded-xl space-y-3">
              <h3 className="text-sm font-medium text-white">编辑素材名称 · <span className="text-gray-400 font-mono text-xs">{editingAsset.Id}</span></h3>
              <input value={editAssetName} onChange={(e) => setEditAssetName(e.target.value)} placeholder="新名称"
                className="w-full bg-[#1c1f2e] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
              <div className="flex gap-2">
                <button onClick={handleUpdateAsset} disabled={editAssetLoading}
                  className="btn-save disabled:opacity-50">{editAssetLoading ? '保存中...' : '保存'}</button>
                <button onClick={() => setEditingAsset(null)} className="px-4 py-2 bg-gray-700 rounded-xl text-white text-sm">取消</button>
              </div>
            </div>
          )}

          {/* 素材详情面板 */}
          {detailAsset && (
            <div className="mb-4 p-4 bg-[#0f111a] border border-cyan-500/20 rounded-xl">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-gray-300">素材详情</p>
                <button onClick={() => setDetailAsset(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕ 关闭</button>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mb-3">
                {Object.entries(detailAsset).filter(([, v]) => v != null).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-gray-500 text-xs w-24 flex-shrink-0">{k}</span>
                    <span className="text-gray-300 text-xs font-mono break-all">{String(v)}</span>
                  </div>
                ))}
              </div>
              {detailAsset.Id && (
                <div className="pt-3 border-t border-gray-800">
                  <p className="text-xs text-gray-400 mb-1">视频生成 URI：</p>
                  <code className="text-xs text-cyan-400 font-mono bg-[#1c1f2e] px-2 py-1 rounded select-all">asset://{detailAsset.Id}</code>
                </div>
              )}
            </div>
          )}

          {/* ── 第一级：素材组卡片 ── */}
          {volcLevel === 'groups' && (
            <div>
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="text-xs text-gray-500">共 {volcGroupTotal} 个素材组</span>
                <input value={volcGroupSearch} onChange={(e) => setVolcGroupSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadVolcGroups(1, volcGroupSearch)}
                  placeholder="按名称搜索..." className="flex-1 min-w-32 max-w-48 bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500" />
              </div>
              {volcGroupsLoading ? (
                <div className="flex items-center justify-center h-40">
                  <div className="animate-spin text-purple-500"><svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" /></svg></div>
                </div>
              ) : volcAssetGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-gray-500 text-sm">
                  <p>暂无素材组，点击「查询」加载</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {volcAssetGroups.map((g) => (
                      <div key={g.Id} className="bg-[#0f111a] border border-gray-800 hover:border-purple-500/40 rounded-2xl overflow-hidden transition-all group flex flex-col cursor-pointer"
                        onClick={() => handleEnterGroup(g)}>
                        <div className="aspect-square bg-[#161824] overflow-hidden relative flex-shrink-0">
                          {g.coverUrl ? (
                            <img src={g.coverUrl} alt={g.Name} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">👤</div>
                          )}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                        </div>
                        <div className="p-3 flex flex-col gap-1.5 flex-1">
                          <p className="text-white text-sm font-medium truncate" title={g.Name}>{g.Name}</p>
                          {g.Description
                            ? <p className="text-gray-500 text-xs truncate" title={g.Description}>{g.Description}</p>
                            : <p className="text-gray-700 text-xs">—</p>}
                          <p className="text-gray-600 text-xs font-mono truncate" title={g.Id}>{g.Id}</p>
                          {g.CreateTime && <p className="text-gray-600 text-xs">{formatDateTime(g.CreateTime)}</p>}
                          <div className="mt-auto pt-1 flex items-center justify-between gap-2" onClick={(e) => e.stopPropagation()}>
                            {isSuperAdmin && (
                            <button onClick={() => { setEditingGroup(g); setEditGroupName(g.Name); setEditGroupDesc(g.Description || ''); setEditingAsset(null); }}
                              className="btn-edit">编辑</button>
                            )}
                            {isSuperAdmin && (
                            <button onClick={() => handleDeleteGroup(g)}
                              className="btn-danger">删除</button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {volcGroupTotal > 20 && (
                    <div className="mt-6 flex items-center justify-center gap-3">
                      <button onClick={() => loadVolcGroups(volcGroupPage - 1)} disabled={volcGroupPage <= 1}
                        className="btn-page">上一页</button>
                      <span className="text-gray-400 text-sm">{volcGroupPage} · 共 {volcGroupTotal} 个</span>
                      <button onClick={() => loadVolcGroups(volcGroupPage + 1)} disabled={volcAssetGroups.length < 20}
                        className="btn-page">下一页</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── 第二级：素材卡片 ── */}
          {volcLevel === 'assets' && (
            <div>
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="text-xs text-gray-500">共 {volcAssetTotal} 个素材</span>
                <input value={volcAssetSearch} onChange={(e) => setVolcAssetSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadVolcAssets(1, selectedGroup?.Id, volcAssetSearch)}
                  placeholder="按名称搜索..." className="flex-1 min-w-32 max-w-48 bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500" />
              </div>
              {volcAssetsLoading ? (
                <div className="flex items-center justify-center h-40">
                  <div className="animate-spin text-purple-500"><svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" /></svg></div>
                </div>
              ) : volcAssets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 text-gray-500 text-sm">
                  <p>该素材组暂无素材</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {volcAssets.map((a) => {
                      const imgUrl = assetUrlMap[a.Id];
                      const isVideo = a.AssetType === 'Video';
                      return (
                        <div key={a.Id} className="bg-[#0f111a] border border-gray-800 hover:border-purple-500/40 rounded-2xl overflow-hidden transition-all group flex flex-col">
                          <div className="aspect-square bg-[#161824] overflow-hidden relative flex-shrink-0">
                            {imgUrl && !isVideo ? (
                              <img src={imgUrl} alt={a.Name || a.Id} className="w-full h-full object-contain" />
                            ) : imgUrl && isVideo ? (
                              <video src={imgUrl} className="w-full h-full object-contain" muted />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">
                                {a.AssetType === 'Video' ? '🎬' : a.AssetType === 'Audio' ? '🎵' : '🖼'}
                              </div>
                            )}
                            <div className="absolute top-2 left-2">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${a.Status === 'Active' ? 'bg-green-500/20 text-green-400' : a.Status === 'Failed' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                {a.Status === 'Active' ? '已过审' : a.Status === 'Failed' ? '未通过' : a.Status || '审核中'}
                              </span>
                            </div>
                          </div>
                          <div className="p-3 flex flex-col gap-1.5 flex-1">
                            <p className="text-white text-sm font-medium truncate" title={a.Name || a.Id}>
                              {a.Name || <span className="text-gray-500">—</span>}
                            </p>
                            {a.AssetType
                              ? <span className="text-xs text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded w-fit">{a.AssetType}</span>
                              : <p className="text-gray-700 text-xs">—</p>}
                            <p className="text-gray-600 text-xs font-mono truncate" title={a.Id}>{a.Id}</p>
                            <code className="text-xs text-cyan-400 font-mono select-all break-all">asset://{a.Id}</code>
                            {a.CreateTime && <p className="text-gray-600 text-xs">{formatDateTime(a.CreateTime)}</p>}
                            <div className="mt-auto pt-1 flex items-center gap-1 flex-wrap">
                              <button onClick={() => handleGetAsset(a)} disabled={detailLoading}
                                className="btn-edit disabled:opacity-50">详情</button>
                              {isSuperAdmin && (
                              <button onClick={() => { setEditingAsset(a); setEditAssetName(a.Name || ''); setEditingGroup(null); }}
                                className="btn-edit">编辑</button>
                              )}
                              {isSuperAdmin && (
                              <button onClick={() => handleDeleteAsset(a)}
                                className="btn-danger">删除</button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {(volcAssetPage > 1 || volcAssets.length >= 20) && (
                    <div className="mt-6 flex items-center justify-center gap-3">
                      <button onClick={() => loadVolcAssets(volcAssetPage - 1)} disabled={volcAssetPage <= 1}
                        className="btn-page">上一页</button>
                      <span className="text-gray-400 text-sm">{volcAssetPage} · 共 {volcAssetTotal} 个</span>
                      <button onClick={() => loadVolcAssets(volcAssetPage + 1)} disabled={volcAssets.length < 20}
                        className="btn-page">下一页</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* 火山Key组管理（仅系统管理员） */}
        {isSuperAdmin && (<>
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="mb-4">
            <h2 className="text-xl font-semibold text-white">火山Key组管理</h2>
            <p className="text-xs text-gray-500 mt-1">
              {multiAccountEnabled
                ? '多组可同时激活，按分组权重分配给新项目；权重总和需保持 100%'
                : '当前为单账户模式，同时仅一组可激活'}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">多账户模式：</span>
              <button
                onClick={handleToggleMultiAccount}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${multiAccountEnabled ? 'bg-purple-600' : 'bg-gray-700'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${multiAccountEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <span className={`text-xs ${multiAccountEnabled ? 'text-purple-400' : 'text-gray-500'}`}>
                {multiAccountEnabled ? '已启用' : '已关闭'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">项目组显示API账户：</span>
              <button
                onClick={async () => {
                  const next = !informationOfAccountOfVolc;
                  setInformationOfAccountOfVolc(next);
                  try { await saveSystemConfig({ informationOfAccountOfVolc: next }); } catch { setInformationOfAccountOfVolc(!next); }
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${informationOfAccountOfVolc ? 'bg-purple-600' : 'bg-gray-700'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${informationOfAccountOfVolc ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
              <span className={`text-xs ${informationOfAccountOfVolc ? 'text-purple-400' : 'text-gray-500'}`}>
                {informationOfAccountOfVolc ? '已启用' : '已关闭'}
              </span>
            </div>
          </div>

          {/* 新增Key组 */}
          <div className="bg-[#0f111a] rounded-xl p-4 border border-gray-800 mb-4">
            <h3 className="text-sm font-medium text-gray-300 mb-3">新增Key组</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" placeholder="Key组名称 *" value={newKeyGroup.name} onChange={(e) => setNewKeyGroup((s) => ({ ...s, name: e.target.value }))} />
              <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="ARK 模型Key *" value={newKeyGroup.ark_model_key} onChange={(e) => setNewKeyGroup((s) => ({ ...s, ark_model_key: e.target.value }))} />
              <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="资产库 Access Key ID（AK）" value={newKeyGroup.volc_access_key} onChange={(e) => setNewKeyGroup((s) => ({ ...s, volc_access_key: e.target.value }))} />
              <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="资产库 Secret Access Key（SK）" type="password" value={newKeyGroup.volc_secret_key} onChange={(e) => setNewKeyGroup((s) => ({ ...s, volc_secret_key: e.target.value }))} />
              {multiAccountEnabled && (
                <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" type="number" min="0" max="100" placeholder="分组权重 % (0-100)" value={newKeyGroup.grouping_weight || ''} onChange={(e) => setNewKeyGroup((s) => ({ ...s, grouping_weight: parseInt(e.target.value) || 0 }))} />
              )}
              <input className="px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" placeholder="备注（可选）" value={newKeyGroup.note} onChange={(e) => setNewKeyGroup((s) => ({ ...s, note: e.target.value }))} />
            </div>
            <button onClick={handleCreateKeyGroup} className="mt-3 btn-primary flex items-center gap-2">
              <PlusIcon className="w-4 h-4" />新增
            </button>
          </div>

          {/* Key组列表 */}
          {keyGroupsLoading ? (
            <p className="text-sm text-gray-400">加载中...</p>
          ) : volcKeyGroups.length === 0 ? (
            <p className="text-sm text-gray-500">暂无Key组，请新增</p>
          ) : (
            <div className="space-y-3">
              {volcKeyGroups.map((g) => (
                <div key={g.id} className={`rounded-xl p-4 border ${g.is_active ? 'border-green-500/40 bg-green-500/5' : 'border-gray-800 bg-[#0f111a]'}`}>
                  {editingKeyGroup?.id === g.id ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="text-xs text-gray-400">名称 <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" placeholder="Key组名称 *" value={editingKeyGroup.name} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, name: e.target.value } : s)} /></label>
                        <label className="text-xs text-gray-400">ARK API Key <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="ARK 模型Key *" value={editingKeyGroup.ark_model_key} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, ark_model_key: e.target.value } : s)} /></label>
                        <label className="text-xs text-gray-400">AK <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="资产库 Access Key ID（AK）" value={editingKeyGroup.volc_access_key} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, volc_access_key: e.target.value } : s)} /></label>
                        <label className="text-xs text-gray-400">SK <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono" placeholder="资产库 Secret Access Key（SK）" type="password" value={editingKeyGroup.volc_secret_key} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, volc_secret_key: e.target.value } : s)} /></label>
                        {multiAccountEnabled && <label className="text-xs text-gray-400">分组权重 (%) <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" type="number" min="0" max="100" placeholder="分组权重 %" value={editingKeyGroup.grouping_weight ?? ''} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, grouping_weight: parseInt(e.target.value) || 0 } : s)} /></label>}
                        <label className="text-xs text-gray-400 md:col-span-2">备注 <input className="mt-1 w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm" placeholder="备注（可选）" value={editingKeyGroup.note} onChange={(e) => setEditingKeyGroup((s) => s ? { ...s, note: e.target.value } : s)} /></label>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={handleSaveKeyGroup} className="btn-save">保存</button>
                        <button onClick={() => setEditingKeyGroup(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-md text-white text-xs">取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-medium text-white">{g.name}</span>
                          {g.is_active ? (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/20 text-green-400">激活中</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-gray-700 text-gray-400">未激活</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 font-mono">模型Key: {g.ark_model_key}</div>
                        <div className="text-xs text-gray-500 font-mono">Access Key: {g.volc_access_key ? `${g.volc_access_key.slice(0, 8)}...` : '（未配置）'}</div>
                        <div className="text-xs text-gray-500 font-mono">Secret Key: {g.volc_secret_key ? '••••••••' : '（未配置）'}</div>
                        {g.note && <div className="text-xs text-gray-600 mt-1">{g.note}</div>}
                        {multiAccountEnabled && (
                          <div className="text-xs text-gray-400 mt-1">
                            {!!g.is_active && (
                              <>
                                分组权重：<span className="text-purple-400 font-medium">{g.grouping_weight ?? 0}%</span>
                                <span className="mx-2">·</span>
                              </>
                            )}
                            组数：{g.bound_count ?? 0}
                            {g.id === 1 && (g.default_count ?? 0) > 0 && (
                              <span className="text-gray-500">（另有 {g.default_count} 个默认组）</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {!g.is_active && (
                          <button onClick={() => handleActivateKeyGroup(g.id)} className="px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-md text-white text-xs font-medium">激活</button>
                        )}
                        {multiAccountEnabled && !!g.is_active && (
                          <button onClick={() => handleDeactivateKeyGroup(g.id, g.name)} className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 rounded-md text-white text-xs font-medium">停用</button>
                        )}
                        <button onClick={() => setEditingKeyGroup({ ...g })} className="btn-edit">编辑</button>
                        {!g.is_active && (
                          <button onClick={() => handleDeleteKeyGroup(g.id, g.name)} className="btn-danger">删除</button>
                        )}
                        {g.volc_access_key && g.volc_secret_key && (
                          <button
                            onClick={() => handleQueryVolcBalance(g.id)}
                            disabled={volcBalanceLoadingId === g.id}
                            className="px-3 py-1.5 bg-purple-600/20 border border-purple-500/40 hover:bg-purple-600/30 disabled:opacity-50 rounded-md text-purple-400 text-xs font-medium transition-all"
                          >
                            {volcBalanceLoadingId === g.id ? '查询中...' : '查询余额'}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* 余额查询结果 */}
                    {volcBalanceErrors[g.id] && (
                      <div className="mt-3 bg-red-950/30 border border-red-500/30 rounded-lg p-2 text-xs text-red-400">{volcBalanceErrors[g.id]}</div>
                    )}
                    {volcBalances[g.id] && (
                      <div className="mt-3 bg-[#1c1f2e] rounded-lg p-3 border border-gray-700">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs text-gray-400">账户 {volcBalances[g.id].accountID}</span>
                        </div>
                        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                          <div className="bg-[#0f111a] rounded p-2">
                            <div className="text-[10px] text-gray-500">可用余额</div>
                            <div className="text-sm font-bold text-purple-300">{parseFloat(volcBalances[g.id].availableBalance).toFixed(2)}</div>
                          </div>
                          <div className="bg-[#0f111a] rounded p-2">
                            <div className="text-[10px] text-gray-500">现金余额</div>
                            <div className="text-sm font-bold text-green-300">{parseFloat(volcBalances[g.id].cashBalance).toFixed(2)}</div>
                          </div>
                          <div className="bg-[#0f111a] rounded p-2">
                            <div className="text-[10px] text-gray-500">欠费金额</div>
                            <div className="text-sm font-bold text-red-300">{parseFloat(volcBalances[g.id].arrearsBalance).toFixed(2)}</div>
                          </div>
                          <div className="bg-[#0f111a] rounded p-2">
                            <div className="text-[10px] text-gray-500">信控额度</div>
                            <div className="text-sm font-bold text-blue-300">{parseFloat(volcBalances[g.id].creditLimit).toFixed(2)}</div>
                          </div>
                          <div className="bg-[#0f111a] rounded p-2">
                            <div className="text-[10px] text-gray-500">冻结金额</div>
                            <div className="text-sm font-bold text-amber-300">{parseFloat(volcBalances[g.id].freezeAmount).toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        </>)}

        {/* MediaKit API Key 管理 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-2">火山 AI MediaKit Key</h2>
          <p className="text-xs text-gray-500 mb-4">用于视频画质增强（mediakit.cn-beijing.volces.com）</p>
          {isSuperAdmin && (<>
          {mediaKitKeyEditing ? (
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                value={mediaKitKeyDraft}
                onChange={(e) => setMediaKitKeyDraft(e.target.value)}
              />
              <button onClick={handleSaveMediaKitKey} className="btn-save">保存</button>
              <button onClick={() => setMediaKitKeyEditing(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <code className="flex-1 px-3 py-2 bg-[#0f111a] rounded text-gray-300 text-sm font-mono truncate">{mediaKitKey || '（未配置）'}</code>
              <button onClick={() => { setMediaKitKeyDraft(mediaKitKey); setMediaKitKeyEditing(true); }} className="btn-edit">修改</button>
            </div>
          )}
          </>)}

          {/* 计费配置 */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-white mb-2">画质增强基础单价</h3>
            <p className="text-xs text-gray-500 mb-3">
              新规则与 MediaKit 官方计费表对齐：单次扣费 = 输出分钟数 × 系数 × 基础单价。
              系数表（标准/专业 × 720p/1080p/2k/4k × ≤30/&gt;30fps 共 16 项）固定不可调；
              如需整体加成或打折，请调整下方基础单价。默认 75 = 0.75 元/分钟 × 100 积分/元。
            </p>
            {enhancementPricing && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 bg-[#0f111a] rounded-xl px-3 py-2">
                  <div className="flex-shrink-0 w-32">
                    <div className="text-sm text-white">基础单价</div>
                    <div className="text-[10px] text-gray-500">enhancement_base_credits_per_minute</div>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-400">
                    {isSuperAdmin ? (
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={enhancementPricing.baseCreditsPerMinute}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v !== enhancementPricing.baseCreditsPerMinute) {
                          void handleUpdateEnhancementBaseRate(v);
                        }
                      }}
                      className="w-24 px-2 py-1 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm"
                    />
                    ) : (
                    <span className="text-amber-400 text-sm">{enhancementPricing.baseCreditsPerMinute}</span>
                    )}
                    <span>积分/分钟</span>
                  </div>
                  {isSuperAdmin && (
                  <button
                    onClick={() => void handleUpdateEnhancementBaseRate(enhancementPricing.defaultBaseCreditsPerMinute)}
                    className="ml-auto text-[11px] px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all"
                  >
                    恢复默认 ({enhancementPricing.defaultBaseCreditsPerMinute})
                  </button>
                  )}
                </div>
                <div className="bg-[#0f111a] rounded-xl px-3 py-2 text-xs text-gray-400">
                  <div className="text-gray-300 mb-2">完整 16 项系数表</div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono">
                    {enhancementPricing.coefficients.filter((c) => c.tool_version === 'standard').map((c) => (
                      <div key={`std-${c.resolution_tier}-${c.fps_tier}`} className="flex justify-between">
                        <span>标准 · {c.resolution_tier} · {c.fps_tier === 'le30' ? '≤30fps' : '>30fps'}</span>
                        <span className="text-gray-300">×{c.coefficient}</span>
                      </div>
                    ))}
                  </div>
                  <div className="my-3 border-t border-gray-700/50" />
                  <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono">
                    {enhancementPricing.coefficients.filter((c) => c.tool_version === 'professional').map((c) => (
                      <div key={`pro-${c.resolution_tier}-${c.fps_tier}`} className="flex justify-between">
                        <span>专业 · {c.resolution_tier} · {c.fps_tier === 'le30' ? '≤30fps' : '>30fps'}</span>
                        <span className="text-gray-300">×{c.coefficient}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {!enhancementPricing && (
              <div className="text-xs text-gray-600">加载中...</div>
            )}
          </div>
        </div>

        {/* HappyHorse API Key + 计费 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-2">HappyHorse API Key</h2>
          <p className="text-xs text-gray-500 mb-4">用于 HappyHorse 视频生成（dashscope.aliyuncs.com，阿里云百炼）</p>
          {isSuperAdmin && (<>
          {happyhorseKeyEditing ? (
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                value={happyhorseKeyDraft}
                onChange={(e) => setHappyhorseKeyDraft(e.target.value)}
                placeholder="sk-xxxxxxxx"
              />
              <button onClick={handleSaveHappyhorseKey} className="btn-save">保存</button>
              <button onClick={() => setHappyhorseKeyEditing(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <code className="flex-1 px-3 py-2 bg-[#0f111a] rounded text-gray-300 text-sm font-mono truncate">
                {happyhorseKeyConfigured ? happyhorseKeyMasked : '（未配置）'}
              </code>
              <button onClick={() => { setHappyhorseKeyDraft(''); setHappyhorseKeyEditing(true); }} className="btn-edit">修改</button>
            </div>
          )}
          </>)}

          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-white">HappyHorse 模型计费管理</h3>
              {isSuperAdmin && (
              <button
                onClick={() => setDiscountModalScope('happyhorse')}
                className="px-3 py-1.5 bg-amber-600/20 border border-amber-500/40 hover:bg-amber-600/30 rounded-lg text-amber-400 text-xs font-medium transition-all"
              >
                折扣设置
              </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-3">单价：积分/秒。1 元 = 100 积分。video-edit 按"输入+输出"秒数计费，其他按"输出"秒数计费。</p>
            {happyhorsePricing.length === 0 ? (
              <div className="text-xs text-gray-600">加载中...</div>
            ) : (
              <>
                {/* Tab 按钮 */}
                <div className="flex gap-1 mb-4 flex-wrap">
                  {(['t2v', 'i2v', 'r2v', 'video-edit'] as const).map((mode) => {
                    const modelName = happyhorsePricing.find((p) => p.mode === mode)?.model || mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setActiveHappyhorseTab(mode)}
                        className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                          activeHappyhorseTab === mode
                            ? 'bg-purple-600 text-white'
                            : 'bg-[#0f111a] border border-gray-700 text-gray-400 hover:text-white'
                        }`}
                      >
                        {modelName}
                      </button>
                    );
                  })}
                </div>

                {/* Tab 内容：当前选中模式的定价卡 */}
                <div className="bg-[#0f111a] rounded-xl p-5 border border-gray-800">
                  <div className="text-white font-medium mb-4">
                    {happyhorsePricing.find((p) => p.mode === activeHappyhorseTab)?.model || activeHappyhorseTab}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {happyhorsePricing
                      .filter((p) => p.mode === activeHappyhorseTab)
                      .map((p) => (
                        <div key={p.resolution} className="bg-[#1c1f2e] rounded-xl p-4 border border-gray-700">
                          <div className="text-xs text-gray-400 mb-2">分辨率</div>
                          <div className="text-white text-sm font-medium mb-3">{p.resolution}</div>
                          <div className="text-xs text-gray-400 mb-1">单价（积分/秒）</div>
                          {isSuperAdmin ? (
                            <>
                            <input
                              type="number"
                              min={0}
                              defaultValue={p.credits_per_second}
                              onBlur={(e) => {
                                const v = parseInt(e.target.value, 10);
                                if (Number.isFinite(v) && v !== p.credits_per_second) {
                                  void handleUpdateHappyhorsePrice(p.mode, p.resolution, v);
                                }
                              }}
                              className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                            />
                            {getDiscountedDisplay(p.mode, p.resolution, p.credits_per_second).discounted && (
                              <div className="mt-2 flex items-center gap-2">
                                <span className="text-emerald-400 text-xs">{getDiscountedDisplay(p.mode, p.resolution, p.credits_per_second).price} 积分/秒</span>
                                <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 text-[10px] font-medium">
                                  -{getDiscountedDisplay(p.mode, p.resolution, p.credits_per_second).percent.toFixed(2)}%
                                </span>
                              </div>
                            )}
                            </>
                          ) : (
                            renderDiscountedPrice(p.mode, p.resolution, p.credits_per_second)
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 阿里云账户余额（仅系统管理员） */}
          {isSuperAdmin && (
          <div className="mt-6 pt-6 border-t border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">阿里云账户余额</h3>
                <p className="text-xs text-gray-500 mt-0.5">通过 BSS OpenAPI 查询阿里云账户实时余额（DashScope 计费账户）</p>
              </div>
            </div>

            {/* AK 配置 */}
            {bssAkEditing ? (
              <div className="bg-[#0f111a] rounded-xl p-4 border border-gray-700 space-y-3 mb-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">AccessKey ID</label>
                  <input
                    className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                    value={bssAkDraft}
                    onChange={(e) => setBssAkDraft(e.target.value)}
                    placeholder="LTAI5t..."
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">AccessKey Secret</label>
                  <input
                    className="w-full px-3 py-2 bg-[#1c1f2e] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                    value={bssSkDraft}
                    onChange={(e) => setBssSkDraft(e.target.value)}
                    placeholder="..."
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleSaveBssConfig} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors">保存</button>
                  <button onClick={() => { setBssAkEditing(false); setBssAkDraft(''); setBssSkDraft(''); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm">取消</button>
                </div>
              </div>
            ) : (
              <div className="bg-[#0f111a] rounded-xl p-4 border border-gray-700 mb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-400 mb-1">AccessKey 状态</div>
                    <div className="flex items-center gap-3">
                      <span className={`text-sm ${bssAkConfigured ? 'text-green-400' : 'text-red-400'}`}>
                        AK ID: {bssAkConfigured ? bssAkMasked : '未配置'}
                      </span>
                      <span className={`text-sm ${bssSkConfigured ? 'text-green-400' : 'text-red-400'}`}>
                        AK Secret: {bssSkConfigured ? '已配置' : '未配置'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => { setBssAkDraft(''); setBssSkDraft(''); setBssAkEditing(true); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm transition-colors">修改</button>
                </div>
              </div>
            )}

            {/* 查询余额 */}
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={handleQueryBssBalance}
                disabled={bssBalanceLoading || !bssAkConfigured || !bssSkConfigured}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-white text-sm font-medium transition-colors"
              >
                {bssBalanceLoading ? '查询中...' : '查询余额'}
              </button>
              {(!bssAkConfigured || !bssSkConfigured) && (
                <span className="text-xs text-amber-400">请先配置 AccessKey</span>
              )}
            </div>

            {/* 余额展示 */}
            {bssBalanceError && (
              <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-3 text-xs text-red-400">{bssBalanceError}</div>
            )}
            {bssBalance && (
              <div className="bg-[#0f111a] rounded-xl p-4 border border-gray-700">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="bg-[#1c1f2e] rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">可用余额</div>
                    <div className="text-lg font-bold text-purple-300 mt-1">{parseFloat(bssBalance.availableAmount).toFixed(2)} <span className="text-xs text-gray-400">{bssBalance.currency}</span></div>
                  </div>
                  <div className="bg-[#1c1f2e] rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">可用现金余额</div>
                    <div className="text-lg font-bold text-green-300 mt-1">{parseFloat(bssBalance.availableCashAmount).toFixed(2)} <span className="text-xs text-gray-400">{bssBalance.currency}</span></div>
                  </div>
                  <div className="bg-[#1c1f2e] rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">信用额度</div>
                    <div className="text-lg font-bold text-blue-300 mt-1">{parseFloat(bssBalance.creditAmount).toFixed(2)} <span className="text-xs text-gray-400">{bssBalance.currency}</span></div>
                  </div>
                  <div className="bg-[#1c1f2e] rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">网商银行额度</div>
                    <div className="text-lg font-bold text-amber-300 mt-1">{parseFloat(bssBalance.mybankCreditAmount).toFixed(2)} <span className="text-xs text-gray-400">{bssBalance.currency}</span></div>
                  </div>
                  <div className="bg-[#1c1f2e] rounded-lg p-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider">配额上限</div>
                    <div className="text-lg font-bold text-gray-300 mt-1">{parseFloat(bssBalance.quotaLimit).toFixed(2)} <span className="text-xs text-gray-400">{bssBalance.currency}</span></div>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        {/* 速创API Key 管理（仅系统管理员） */}
        {isSuperAdmin && (<>
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-2">速创API Key</h2>
          <p className="text-xs text-gray-500 mb-4">用于 Nano Banana 2 / GPT-Image-2 生图接口（api.wuyinkeji.com）</p>
          {wuyinKeyEditing ? (
            <div className="flex gap-2">
              <input
                className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                value={wuyinKeyDraft}
                onChange={(e) => setWuyinKeyDraft(e.target.value)}
              />
              <button onClick={handleSaveWuyinKey} className="btn-save">保存</button>
              <button onClick={() => setWuyinKeyEditing(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <code className="flex-1 px-3 py-2 bg-[#0f111a] rounded text-gray-300 text-sm font-mono truncate">{wuyinKey || '（未配置）'}</code>
              <button onClick={() => { setWuyinKeyDraft(wuyinKey); setWuyinKeyEditing(true); }} className="btn-edit">修改</button>
            </div>
          )}
        </div>

        {/* DeepSeek API 配置 */}
        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <h2 className="text-xl font-semibold text-white mb-2">DeepSeek API</h2>
          <p className="text-xs text-gray-500 mb-4">用于文本生成（api.deepseek.com）</p>
          {deepseekKeyEditing ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  className="flex-1 px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-purple-500"
                  value={deepseekKeyDraft}
                  onChange={(e) => setDeepseekKeyDraft(e.target.value)}
                  placeholder="sk-..."
                />
                <button onClick={handleSaveDeepseekConfig} className="btn-save">保存</button>
                <button onClick={() => setDeepseekKeyEditing(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400">默认模型：</span>
                <select
                  className="px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                  value={deepseekModel}
                  onChange={(e) => setDeepseekModel(e.target.value)}
                >
                  <option value="deepseek-v4-flash">deepseek-v4-flash（快速）</option>
                  <option value="deepseek-v4-pro">deepseek-v4-pro（专业）</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400">推理深度：</span>
                <select
                  className="px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                  value={deepseekReasoning}
                  onChange={(e) => setDeepseekReasoning(e.target.value)}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high（默认）</option>
                  <option value="max">max</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <code className="flex-1 px-3 py-2 bg-[#0f111a] rounded text-gray-300 text-sm font-mono truncate">{deepseekKey || '（未配置）'}</code>
              <span className="text-xs text-purple-400 font-mono">{deepseekModel}</span>
              <span className="text-xs text-gray-500 font-mono">推理:{deepseekReasoning}</span>
              <button onClick={() => { setDeepseekKeyDraft(deepseekKey); setDeepseekKeyEditing(true); }} className="btn-edit">修改</button>
            </div>
          )}
        </div>

        <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-xl font-semibold text-white">全局任务查询（火山方舟直连）</h2>
              <p className="text-xs text-gray-500 mt-1">直接调火山方舟 ListContentGenerationTasks 接口；默认使用当前激活Key组，也可手动输入其他Key</p>
            </div>
          </div>
          {/* API 账户 Tab 切换 */}
          {volcKeyGroups.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {volcKeyGroups.map((kg) => {
                const isActive = taskTabKeyGroupId === kg.id;
                const isDisabled = !kg.is_active;
                return (
                  <button
                    key={kg.id}
                    onClick={() => {
                      if (isActive) return;
                      setTaskTabKeyGroupId(kg.id);
                      // 从缓存恢复该 tab 的 apiKey，无缓存时用默认值
                      const cached = taskCache[kg.id];
                      setManualApiKey(cached?.apiKey ?? kg.ark_model_key);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isActive
                        ? 'bg-purple-600 text-white shadow-sm shadow-purple-600/20'
                        : isDisabled
                          ? 'bg-gray-800/50 text-gray-500 border border-gray-700/50 hover:border-gray-600'
                          : 'bg-[#0f111a] text-gray-400 border border-gray-700 hover:border-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {kg.name}
                    {isDisabled && <span className="ml-1 text-[10px] opacity-60">(未激活)</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={manualApiKey}
              onChange={(e) => setManualApiKey(e.target.value)}
              placeholder="ARK API Key（留空使用激活Key组）"
              className="flex-1 px-4 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              onKeyDown={(e) => e.key === 'Enter' && handleManualKeyQuery(1)}
            />
            <button
              onClick={() => handleManualKeyQuery(1)}
              disabled={accountTasksLoading}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-xl text-sm"
            >
              查询
            </button>
          </div>
          {accountTasksLoading ? (
            <p className="text-sm text-gray-400">加载中（火山接口）...</p>
          ) : volcTasks.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-500">暂无任务记录，点击查询加载</p>
              {volcRawJson && (
                <details className="text-xs">
                  <summary className="text-gray-500 cursor-pointer hover:text-gray-400">查看原始响应</summary>
                  <pre className="mt-2 bg-[#0f111a] p-3 rounded text-gray-300 overflow-x-auto max-h-60">{volcRawJson}</pre>
                </details>
              )}
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between text-xs text-gray-400 flex-wrap gap-2">
                <span>共 {volcTotal} 条 / 第 {volcPageNum} 页</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleManualKeyQuery(Math.max(1, volcPageNum - 1))} disabled={volcPageNum <= 1} className="btn-page">上一页</button>
                  <div className="flex items-center gap-1">
                    <span>跳至</span>
                    <input
                      type="number"
                      min={1}
                      defaultValue={volcPageNum}
                      key={volcPageNum}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = parseInt((e.target as HTMLInputElement).value);
                          if (!isNaN(v) && v >= 1) handleManualKeyQuery(v);
                        }
                      }}
                      className="w-14 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-center text-white text-xs focus:outline-none focus:border-purple-500"
                    />
                    <span>页</span>
                  </div>
                  <button onClick={() => handleManualKeyQuery(volcPageNum + 1)} disabled={volcTasks.length < 20} className="btn-page">下一页</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-400 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">task id</th>
                      <th className="px-3 py-2 text-left">model</th>
                      <th className="px-3 py-2 text-left">status</th>
                      <th className="px-3 py-2 text-left">tokens</th>
                      <th className="px-3 py-2 text-left">created_at</th>
                      <th className="px-3 py-2 text-left">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {volcTasks.map((t) => {
                      const id = (t.id || t.task_id || '') + '';
                      const tokens = t.usage?.total_tokens ?? t.usage?.completion_tokens ?? '-';
                      const ts = t.created_at;
                      const tsStr = ts == null ? '-' : formatDateTime(typeof ts === 'number' ? ts * 1000 : ts);
                      const expanded = expandedTaskId === id;
                      return (
                        <Fragment key={id}>
                          <tr className="hover:bg-[#0f111a]/50">
                            <td className="px-3 py-2 text-gray-300 font-mono text-xs">{id || '-'}</td>
                            <td className="px-3 py-2 text-gray-400 text-xs">{t.model || '-'}</td>
                            <td className="px-3 py-2"><span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300 text-xs">{t.status || '-'}</span></td>
                            <td className="px-3 py-2 text-amber-400 text-xs">{tokens}</td>
                            <td className="px-3 py-2 text-gray-500 text-xs">{tsStr}</td>
                            <td className="px-3 py-2">
                              <button onClick={() => setExpandedTaskId(expanded ? null : id)} className="px-2 py-1 bg-purple-500/20 text-purple-400 rounded text-xs">{expanded ? '收起' : '展开 raw'}</button>
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={6} className="px-3 py-2 bg-[#0f111a]">
                                <pre className="text-xs text-gray-300 overflow-x-auto max-h-80">{JSON.stringify(t, null, 2)}</pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        </>)}

            {/* 音频生成中转视频配置 */}
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
                <h2 className="text-xl font-semibold text-white mb-2">音频生成中转配置</h2>
                <p className="text-xs text-gray-500 mb-4">音频生成会先生成一段中转视频再提取音轨,这里配置中转视频的参数,降低消耗。默认:Seedance
                    2.0 Fast / 1:1 / 480p / 4 秒</p>
                {audioCfg && audioCfgOptions ? (
                    isSuperAdmin && audioCfgEditing && audioCfgDraft ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <label className="block">
                                <span className="text-xs text-gray-400 block mb-1">模型</span>
                                <select
                                    className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                                    value={audioCfgDraft.model}
                                    onChange={(e) => setAudioCfgDraft({...audioCfgDraft, model: e.target.value})}
                                >
                                    {Array.from(new Set([audioCfgDraft.model, ...modelPricings.map((m) => m.model_key), 'seedance-2.0-fast', 'seedance-2.0'])).map((k) => (
                                        <option key={k} value={k}>{k}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="block">
                                <span className="text-xs text-gray-400 block mb-1">画面比例</span>
                                <select
                                    className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                                    value={audioCfgDraft.ratio}
                                    onChange={(e) => setAudioCfgDraft({...audioCfgDraft, ratio: e.target.value})}
                                >
                                    {audioCfgOptions.ratios.map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </label>
                            <label className="block">
                                <span className="text-xs text-gray-400 block mb-1">分辨率</span>
                                <select
                                    className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                                    value={audioCfgDraft.resolution}
                                    onChange={(e) => setAudioCfgDraft({...audioCfgDraft, resolution: e.target.value})}
                                >
                                    {audioCfgOptions.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </label>
                            <label className="block">
                                <span className="text-xs text-gray-400 block mb-1">时长(秒)</span>
                                <select
                                    className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
                                    value={audioCfgDraft.duration}
                                    onChange={(e) => setAudioCfgDraft({
                                        ...audioCfgDraft,
                                        duration: Number(e.target.value)
                                    })}
                                >
                                    {audioCfgOptions.durations.map((d) => <option key={d} value={d}>{d}s</option>)}
                                </select>
                            </label>
                            <div className="sm:col-span-2 flex gap-2 mt-1">
                                <button onClick={handleSaveAudioCfg} disabled={audioCfgSaving}
                                        className="btn-save">{audioCfgSaving ? '保存中...' : '保存'}</button>
                                <button onClick={() => setAudioCfgEditing(false)}
                                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 flex-wrap">
                            <code
                                className="flex-1 min-w-0 px-3 py-2 bg-[#0f111a] rounded text-gray-300 text-sm font-mono">
                                {audioCfg.model} · {audioCfg.ratio} · {audioCfg.resolution} · {audioCfg.duration}s
                            </code>
                            {isSuperAdmin && <button onClick={() => {
                                setAudioCfgDraft(audioCfg);
                                setAudioCfgEditing(true);
                            }} className="btn-edit">修改
                            </button>}
                        </div>
                    )
                ) : (
                    <div className="text-xs text-gray-500">加载中...</div>
                )}
            </div>

        {/* 批量生成设置 */}
        {isSuperAdmin && (
          <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 mb-6">
            <h2 className="text-xl font-semibold text-white mb-2">批量生成设置</h2>
            <p className="text-xs text-gray-500 mb-4">
              控制视频生成和 HappyHorse 模块点击一次按钮可同时生成的任务数。数量越大，积分消耗越快。
            </p>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              每次批量生成数量上限
            </label>
            <div className="flex flex-wrap gap-2 mb-4">
              {([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setBatchMaxConcurrent(String(n))}
                  className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                    batchMaxConcurrent === String(n)
                      ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                      : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              onClick={async () => {
                setBatchSaving(true);
                try {
                  const res = await fetch('/api/admin/batch-concurrent', {
                    method: 'PUT',
                    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ max_concurrent: batchMaxConcurrent }),
                  });
                  const data = await res.json();
                  if (!data.success) throw new Error(data.error || '保存失败');
                  alert('已保存');
                } catch (e) {
                  alert(e instanceof Error ? e.message : '保存失败');
                } finally {
                  setBatchSaving(false);
                }
              }}
              disabled={batchSaving}
              className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-xl transition-all font-medium shadow-lg shadow-purple-900/20 text-sm"
            >
              {batchSaving ? '保存中...' : '保存设置'}
            </button>
          </div>
        )}

        {/* 用户编辑弹窗 */}
        {showUserModal && selectedUser && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 w-full max-w-md">
              <h3 className="text-xl font-semibold text-white mb-6">编辑用户 - {selectedUser.email}</h3>
              <div className="space-y-4">
                {/* 姓名 + 小组：管理员代填 / 修正 */}
                <div className="border border-amber-700/30 bg-amber-500/5 rounded-xl p-3 space-y-3">
                  <label className="text-sm font-medium text-amber-300">姓名 / 小组</label>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">姓名（2~20 字符，留空可清除）</label>
                    <input
                      value={editUserName}
                      maxLength={20}
                      onChange={(e) => setEditUserName(e.target.value)}
                      placeholder="例如：张三"
                      className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-gray-400 mb-1">小组（如需新增请到下方「小组管理」）</label>
                    {isSuperAdmin ? (
                      <DepartmentSelect
                        value={editUserDepartment}
                        onChange={setEditUserDepartment}
                        refreshKey={departmentRefreshKey}
                      />
                    ) : (
                      <div className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-lg text-sm text-gray-500">
                        {editUserDepartment || '（未设置）'}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-500">点击下方「保存」按钮统一提交姓名、小组、积分等所有改动。</p>
                </div>

                {isSuperAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">修改积分</label>
                  <div className="flex gap-2">
                    <select
                      value={editOperation}
                      onChange={(e) => setEditOperation(e.target.value as 'set' | 'add' | 'subtract')}
                      className="px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="set">设置为</option>
                      <option value="add">增加</option>
                      <option value="subtract">减少</option>
                    </select>
                    <input
                      type="number"
                      value={editCredits}
                      onChange={(e) => setEditCredits(e.target.value)}
                      className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      placeholder="数量"
                      min="0"
                    />
                  </div>
                  {(() => {
                    const currentCredits = selectedUser?.credits ?? 0;
                    const num = parseInt(editCredits) || 0;
                    if (num <= 0) return null;
                    if (editOperation === 'subtract' && num > currentCredits) {
                      return (
                        <p className="mt-2 text-xs text-amber-400">
                          该用户剩余积分 {currentCredits}，无法扣除 {num}，将扣除 {currentCredits}
                        </p>
                      );
                    }
                    if (editOperation === 'set' && num < currentCredits) {
                      const deduct = currentCredits - num;
                      return (
                        <p className="mt-2 text-xs text-amber-400">
                          将从 {currentCredits} 调整为 {num}，减少 {deduct} 积分
                        </p>
                      );
                    }
                    return null;
                  })()}
                </div>
                )}

                {/* 功能权限编辑（仅系统管理员可见） */}
                {isSuperAdmin && (
                <div className="border-t border-gray-800 pt-4">
                  <label className="block text-sm font-medium text-gray-300 mb-3">功能权限</label>
                  {permsLoading ? (
                    <p className="text-xs text-gray-500">加载中...</p>
                  ) : featureKeys.length === 0 ? (
                    <p className="text-xs text-gray-500">暂无可配置的功能</p>
                  ) : (
                    <div className="space-y-2">
                      {featureKeys.map((f) => (
                        <div key={f.key} className="flex items-center justify-between bg-[#0f111a] rounded-xl px-3 py-2">
                          <div>
                            <p className="text-sm text-white">{f.label}</p>
                            <p className="text-[10px] text-gray-500 font-mono">{f.key}</p>
                          </div>
                          <button
                            onClick={() => handleToggleUserPerm(f.key, !userPerms[f.key])}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${userPerms[f.key] ? 'bg-purple-500' : 'bg-gray-700'}`}
                          >
                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${userPerms[f.key] ? 'translate-x-5' : 'translate-x-1'}`} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}

                <div className="flex gap-3">
                  <button onClick={handleResetPassword} className="flex-1 px-4 py-3 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-xl font-medium transition-all">重置密码</button>
                  <button onClick={() => setShowUserModal(false)} className="flex-1 px-4 py-3 bg-[#0f111a] border border-gray-700 text-white hover:bg-gray-800 rounded-xl font-medium transition-all">取消</button>
                  <button onClick={handleUpdateCredits} className="btn-save flex-1">保存</button>
                </div>
              </div>
            </div>
          </div>
        )}

      {/* 折扣设置弹窗 */}
      {discountModalScope && (
        <DiscountModal
          scope={discountModalScope}
          modelPricings={discountModalScope === 'model' ? modelPricings : undefined}
          happyhorsePricing={discountModalScope === 'happyhorse' ? happyhorsePricing : undefined}
          onClose={(saved) => {
            const scrollY = window.scrollY;
            setDiscountModalScope(null);
            if (saved) {
              // 刷新折扣 + 定价数据
              Promise.all([
                fetch('/api/admin/discounts', { headers: getAuthHeaders() }).then(r => r.json()),
                discountModalScope === 'happyhorse'
                  ? fetch('/api/admin/happyhorse-pricing', { headers: getAuthHeaders() }).then(r => r.json())
                  : listAllModelPricing().then(list => ({ success: true, data: { pricing: list } })),
              ]).then(([discJ, priceJ]) => {
                if (discJ?.success) {
                  setDiscounts(discJ.data.discounts || []);
                }
                if (priceJ?.success) {
                  if (discountModalScope === 'happyhorse') {
                    setHappyhorsePricing(priceJ.data.pricing || []);
                  } else {
                    setModelPricings(priceJ.data.pricing || []);
                  }
                }
                // 恢复滚动位置
                requestAnimationFrame(() => window.scrollTo(0, scrollY));
              }).catch(() => {});
            }
          }}
        />
      )}
      </div>
    </div>
  );
}