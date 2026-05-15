import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { getAuthHeaders } from '../services/authService';
import {
  listProjectMembers,
  inviteProjectMember,
  removeProjectMember,
} from '../services/assetService';
import type { ProjectMember } from '../types';
import { formatDateTime, formatDate, useUserTimezone } from '../utils/datetime';

type Tab = 'volc' | 'members';

interface VolcAssetGroup {
  Id: string; Name: string; Description?: string;
  GroupType?: string; ProjectName?: string;
  CreateTime?: string; UpdateTime?: string;
  coverUrl?: string;
}
interface VolcAsset {
  Id: string; Name?: string; AssetType?: string;
  Status?: string; CreateTime?: string; UpdateTime?: string;
  ProjectName?: string; GroupId?: string; URL?: string;
}

function StatusBadge({ status }: { status?: string }) {
  if (status === 'Active') return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-green-400 bg-green-400/10">已过审</span>;
  if (status === 'Failed') return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-red-400 bg-red-400/10">未通过</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-amber-400 bg-amber-400/10">{status || '审核中'}</span>;
}

function MemberRoleTag({ role }: { role: string }) {
  if (role === 'owner') return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-purple-400 bg-purple-400/10">创建者</span>;
  if (role === 'admin') return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-amber-400 bg-amber-400/10">管理员</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium text-gray-400 bg-gray-700">成员</span>;
}

async function uploadToOss(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const mediaType = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image';
  form.append('mediaType', mediaType);
  const res = await fetch('/api/upload/oss', { method: 'POST', headers: getAuthHeaders(), body: form });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'OSS 上传失败');
  return data.url as string;
}

// 删除确认弹窗
function DeleteConfirmModal({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <h3 className="text-lg font-semibold text-white mb-2">确认删除</h3>
        <p className="text-gray-400 text-sm mb-1">即将删除：<span className="text-white font-medium">「{name}」</span></p>
        <p className="text-red-400 text-xs mb-6">删除组合将同时删除组内所有素材，此操作不可恢复！</p>
        <div className="flex gap-3">
          <button onClick={onConfirm}
            className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 rounded-xl text-white text-sm font-medium transition-colors">
            确认删除
          </button>
          <button onClick={onCancel}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm transition-colors">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectWorkspacePage() {
  useUserTimezone();
  const { state, currentUser } = useApp();
  const currentProject = state.currentProject;
  const [tab, setTab] = useState<Tab>('volc');

  // ─── 火山资产库 ───
  const [volcLevel, setVolcLevel] = useState<'groups' | 'assets'>('groups');
  const [volcGroups, setVolcGroups] = useState<VolcAssetGroup[]>([]);
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

  // 创建人物组合
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [newGroupFile, setNewGroupFile] = useState<File | null>(null);
  const [newGroupPreview, setNewGroupPreview] = useState('');
  // 撞名检测：调 /check-name 拿到建议名（已存在时附 (2)/(3) 后缀）
  const [groupNameSuggestion, setGroupNameSuggestion] = useState<{ exists: boolean; suggestedName: string } | null>(null);
  const [groupNameChecking, setGroupNameChecking] = useState(false);
  const [createGroupLoading, setCreateGroupLoading] = useState(false);
  const [createGroupStep, setCreateGroupStep] = useState('');
  const newGroupFileRef = useRef<HTMLInputElement>(null);

  // 添加素材
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [addAssetFile, setAddAssetFile] = useState<File | null>(null);
  const [addAssetName, setAddAssetName] = useState('');
  const [addAssetLoading, setAddAssetLoading] = useState(false);
  const [addAssetStep, setAddAssetStep] = useState('');
  const addAssetFileRef = useRef<HTMLInputElement>(null);

  // 删除确认弹窗
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<VolcAssetGroup | null>(null);
  const [deleteGroupLoading, setDeleteGroupLoading] = useState(false);
  // 重命名素材组
  const [renameGroupTarget, setRenameGroupTarget] = useState<VolcAssetGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [renameGroupLoading, setRenameGroupLoading] = useState(false);

  // 轮询
  const volcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── 成员 ───
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [memberError, setMemberError] = useState('');

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';

  // 加载组列表，并为每个组加载第一个 Asset 封面
  // 严格按当前工作组过滤：只显示当前工作组绑定的素材组
  const loadVolcGroups = useCallback(async (page = 1, search = volcGroupSearch) => {
    if (!currentProject) { setVolcGroups([]); setVolcGroupTotal(0); return; }
    setVolcGroupsLoading(true);
    try {
      const params = new URLSearchParams({ pageNumber: String(page), pageSize: '20', projectId: String(currentProject.id) });
      if (search.trim()) params.set('name', search.trim());
      const res = await fetch(`/api/volc-native/asset-groups?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const items: VolcAssetGroup[] = data.data?.Items || [];
      setVolcGroups(items);
      setVolcGroupTotal(data.data?.TotalCount || 0);
      setVolcGroupPage(page);
      // 异步加载每个组的第一个 Asset 封面
      items.forEach(async (g) => {
        try {
          const r = await fetch(`/api/volc-native/assets?groupId=${encodeURIComponent(g.Id)}&pageNumber=1&pageSize=1`, { headers: getAuthHeaders() });
          const d = await r.json();
          const firstAsset: VolcAsset | undefined = d.data?.Items?.[0];
          if (!firstAsset) return;
          // GetAsset 拿 URL
          const r2 = await fetch(`/api/volc-native/asset?id=${encodeURIComponent(firstAsset.Id)}`, { headers: getAuthHeaders() });
          const d2 = await r2.json();
          const url: string | undefined = d2.data?.URL;
          if (url) {
            setVolcGroups(prev => prev.map(item => item.Id === g.Id ? { ...item, coverUrl: url } : item));
          }
        } catch {}
      });
    } catch (e) { console.error(e); }
    finally { setVolcGroupsLoading(false); }
  }, [currentProject?.id]);

  const loadVolcAssets = useCallback(async (page = 1, groupId?: string, search = volcAssetSearch) => {
    const gid = groupId ?? selectedGroup?.Id;
    if (!gid) return;
    setVolcAssetsLoading(true);
    try {
      const params = new URLSearchParams({ pageNumber: String(page), pageSize: '20', groupId: gid });
      if (search.trim()) params.set('name', search.trim());
      const res = await fetch(`/api/volc-native/assets?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const items: VolcAsset[] = data.data?.Items || [];
      setVolcAssets(items);
      setVolcAssetTotal(data.data?.TotalCount || 0);
      setVolcAssetPage(page);
      // 异步加载每个素材的图片 URL
      items.forEach(async (a) => {
        try {
          const r = await fetch(`/api/volc-native/asset?id=${encodeURIComponent(a.Id)}`, { headers: getAuthHeaders() });
          const d = await r.json();
          const url: string | undefined = d.data?.URL;
          if (url) setAssetUrlMap(prev => ({ ...prev, [a.Id]: url }));
        } catch {}
      });
      return items;
    } catch (e) { console.error(e); }
    finally { setVolcAssetsLoading(false); }
  }, [selectedGroup?.Id]);

  // 轮询非 Active 素材
  const pollPendingAssets = useCallback(async (assets: VolcAsset[]) => {
    const pending = assets.filter(a => a.Status !== 'Active' && a.Status !== 'Failed');
    if (!pending.length) return;
    await Promise.allSettled(pending.map(async (a) => {
      try {
        const r = await fetch(`/api/volc-native/asset?id=${encodeURIComponent(a.Id)}`, { headers: getAuthHeaders() });
        const d = await r.json();
        if (d.success && d.data) {
          setVolcAssets(prev => prev.map(item => item.Id === a.Id ? { ...item, Status: d.data.Status } : item));
        }
      } catch {}
    }));
  }, []);

  useEffect(() => {
    if (volcPollRef.current) { clearInterval(volcPollRef.current); volcPollRef.current = null; }
    if (volcLevel === 'assets' && volcAssets.some(a => a.Status !== 'Active' && a.Status !== 'Failed')) {
      volcPollRef.current = setInterval(() => pollPendingAssets(volcAssets), 30000);
    }
    return () => { if (volcPollRef.current) { clearInterval(volcPollRef.current); volcPollRef.current = null; } };
  }, [volcLevel, volcAssets]);

  const handleEnterGroup = (g: VolcAssetGroup) => {
    setSelectedGroup(g);
    setVolcAssets([]);
    setVolcAssetPage(1);
    setVolcAssetSearch('');
    setVolcLevel('assets');
    setShowAddAsset(false);
    setAssetUrlMap({});
    loadVolcAssets(1, g.Id, '');
  };

  const handleBackToGroups = () => {
    if (volcPollRef.current) { clearInterval(volcPollRef.current); volcPollRef.current = null; }
    setVolcLevel('groups');
    setSelectedGroup(null);
    setVolcAssets([]);
    setShowAddAsset(false);
  };

  // 创建素材组对话框：输入组名后 300ms 防抖调 /check-name，得到建议名（撞名时附 (2) 等后缀）
  useEffect(() => {
    if (!showCreateGroup) { setGroupNameSuggestion(null); return; }
    const trimmed = newGroupName.trim();
    if (!trimmed || !currentProject) { setGroupNameSuggestion(null); return; }
    setGroupNameChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/volc-native/asset-groups/check-name?name=${encodeURIComponent(trimmed)}&projectId=${currentProject.id}`,
          { headers: getAuthHeaders() },
        );
        const d = await r.json();
        if (d?.success) {
          setGroupNameSuggestion({ exists: !!d.data.exists, suggestedName: d.data.suggestedName });
        }
      } catch { /* 网络错就静默；提交时后端会再 resolve 一次 */ }
      finally { setGroupNameChecking(false); }
    }, 300);
    return () => { clearTimeout(t); setGroupNameChecking(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newGroupName, showCreateGroup, currentProject?.id]);

  // 创建素材组：CreateAssetGroup → CreateAsset（封面图）
  const handleCreateGroup = async () => {
    if (!currentProject) { alert('请先选择工作组'); return; }
    if (!newGroupName.trim()) { alert('请输入素材组名称'); return; }
    if (!newGroupFile) { alert('请选择一张封面图片'); return; }
    // 优先用建议名（撞名时附 (2)/(3)...），用户能看到、提交时使用
    const finalName = (groupNameSuggestion?.suggestedName || newGroupName).trim();
    setCreateGroupLoading(true);
    try {
      setCreateGroupStep('上传图片到 OSS...');
      const ossUrl = await uploadToOss(newGroupFile);

      setCreateGroupStep('创建素材组...');
      const r1 = await fetch('/api/volc-native/asset-groups', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: finalName, description: newGroupDesc.trim(), projectId: currentProject.id }),
      });
      const d1 = await r1.json();
      if (!d1.success) throw new Error(d1.error || '创建素材组失败');
      const groupId: string = d1.data?.Id;
      // 后端可能再次微调（极端并发情况），用 finalName 兜底
      const persistedName: string = d1.data?.finalName || finalName;

      setCreateGroupStep('写入封面素材...');
      await fetch('/api/volc-native/assets', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, url: ossUrl, assetType: 'Image', name: persistedName }),
      });

      setShowCreateGroup(false);
      setNewGroupName(''); setNewGroupDesc(''); setNewGroupFile(null); setNewGroupPreview('');
      setGroupNameSuggestion(null);
      await loadVolcGroups(1);
    } catch (e) { alert(e instanceof Error ? e.message : '创建失败'); }
    finally { setCreateGroupLoading(false); setCreateGroupStep(''); }
  };

  // 添加素材：OSS → CreateAsset
  const handleAddAsset = async () => {
    if (!addAssetFile || !selectedGroup) { alert('请选择文件'); return; }
    setAddAssetLoading(true);
    try {
      setAddAssetStep('上传到 OSS...');
      const ossUrl = await uploadToOss(addAssetFile);
      const assetType = addAssetFile.type.startsWith('video/') ? 'Video' : addAssetFile.type.startsWith('audio/') ? 'Audio' : 'Image';

      setAddAssetStep('提交素材...');
      const res = await fetch('/api/volc-native/assets', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId: selectedGroup.Id, url: ossUrl, assetType, name: addAssetName.trim() || addAssetFile.name }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setShowAddAsset(false); setAddAssetFile(null); setAddAssetName('');
      await loadVolcAssets(1);
    } catch (e) { alert(e instanceof Error ? e.message : '添加失败'); }
    finally { setAddAssetLoading(false); setAddAssetStep(''); }
  };

  // 删除素材
  const handleDeleteAsset = async (a: VolcAsset) => {
    if (!confirm(`确定删除素材「${a.Name || a.Id}」？`)) return;
    try {
      const res = await fetch(`/api/admin/volc-native/assets/${encodeURIComponent(a.Id)}`, {
        method: 'DELETE', headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await loadVolcAssets(volcAssetPage);
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败'); }
  };

  // 删除组合（二次确认弹窗）
  const handleConfirmDeleteGroup = async () => {
    if (!deleteGroupTarget) return;
    setDeleteGroupLoading(true);
    try {
      const res = await fetch(`/api/admin/volc-native/asset-groups/${encodeURIComponent(deleteGroupTarget.Id)}`, {
        method: 'DELETE', headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setDeleteGroupTarget(null);
      await loadVolcGroups(volcGroupPage, volcGroupSearch);
    } catch (e) { alert(e instanceof Error ? e.message : '删除失败'); }
    finally { setDeleteGroupLoading(false); }
  };

  const handleSyncStatus = () => pollPendingAssets(volcAssets);

  // 成员
  const loadMembers = async () => {
    if (!currentProject) return;
    setMembersLoading(true);
    setMemberError('');
    try { setMembers(await listProjectMembers(currentProject.id)); }
    catch (err) { setMemberError(err instanceof Error ? err.message : '加载失败'); }
    finally { setMembersLoading(false); }
  };

  const handleInvite = async () => {
    if (!currentProject || !inviteEmail.trim()) return;
    setInviting(true); setMemberError('');
    try { await inviteProjectMember(currentProject.id, inviteEmail.trim()); setInviteEmail(''); await loadMembers(); }
    catch (err) { setMemberError(err instanceof Error ? err.message : '邀请失败'); }
    finally { setInviting(false); }
  };

  const handleRemoveMember = async (member: ProjectMember) => {
    if (!currentProject || !confirm(`确定移除成员 ${member.email}？`)) return;
    try { await removeProjectMember(currentProject.id, member.user_id); await loadMembers(); }
    catch (err) { alert(err instanceof Error ? err.message : '移除失败'); }
  };

  useEffect(() => {
    if (currentProject) { void loadVolcGroups(1); void loadMembers(); }
    return () => { if (volcPollRef.current) { clearInterval(volcPollRef.current); volcPollRef.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, loadVolcGroups]);

  if (!currentProject) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <p className="text-gray-400 mb-2">请先在批量管理中选择一个工作组（项目）</p>
        <p className="text-gray-600 text-sm">工作组包含成员管理和资产库</p>
      </div>
    );
  }

  const hasPendingAssets = volcAssets.some(a => a.Status !== 'Active' && a.Status !== 'Failed');

  return (
    <>
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">工作组</h1>
        <p className="text-gray-400 text-sm mt-1">{currentProject.name}</p>
        {currentProject.description && <p className="text-gray-500 text-xs mt-0.5">{currentProject.description}</p>}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 mb-6">
        {([['volc', '资产库'], ['members', '成员管理']] as [Tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === key ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ═══ 资产库 Tab ═══ */}
      {tab === 'volc' && (
        <div>
          {/* 工具栏 */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {volcLevel === 'assets' && (
                <button onClick={handleBackToGroups}
                  className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 hover:border-gray-500 rounded-xl text-sm text-gray-300 transition-all">
                  ← 返回
                </button>
              )}
              <p className="text-gray-400 text-sm">
                {volcLevel === 'groups'
                  ? `共 ${volcGroupTotal} 个人物组合`
                  : <><span className="text-white font-medium">{selectedGroup?.Name}</span> · {volcAssetTotal} 个素材</>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {volcLevel === 'assets' && (
                <>
                  {hasPendingAssets && (
                    <button onClick={handleSyncStatus}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 hover:border-gray-500 rounded-xl text-sm text-gray-300 transition-all">
                      同步审核状态
                    </button>
                  )}
                  <button onClick={() => setShowAddAsset(v => !v)}
                    className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-sm font-medium text-white transition-all">
                    + 添加素材
                  </button>
                </>
              )}
              {volcLevel === 'groups' && (
                <>
                  <button onClick={() => loadVolcGroups(1)} disabled={volcGroupsLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50">
                    <svg className={`w-4 h-4 ${volcGroupsLoading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {volcGroupsLoading ? '同步中...' : '刷新'}
                  </button>
                  <button onClick={() => setShowCreateGroup(v => !v)}
                    className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-sm font-medium text-white transition-all">
                    + 创建人物组合
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 创建人物组合表单 */}
          {showCreateGroup && volcLevel === 'groups' && (
            <div className="mb-6 p-5 bg-[#1c1f2e] border border-purple-500/30 rounded-2xl space-y-4">
              <h3 className="text-sm font-semibold text-white">创建人物组合</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* 左列：文字字段 */}
                <div className="space-y-3">
                  <div>
                    <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="组合名称 *"
                      className={`w-full bg-[#0f111a] border rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none transition-colors ${
                        groupNameSuggestion?.exists ? 'border-amber-500/60 focus:border-amber-400' : 'border-gray-700 focus:border-purple-500'
                      }`} />
                    {groupNameChecking && (
                      <p className="mt-1 text-[11px] text-gray-500">检查同名中…</p>
                    )}
                    {!groupNameChecking && groupNameSuggestion?.exists && (
                      <p className="mt-1 text-[11px] text-amber-400">
                        当前工作组已有同名素材组，提交时将使用：
                        <span className="font-mono text-amber-300 ml-1">{groupNameSuggestion.suggestedName}</span>
                      </p>
                    )}
                  </div>
                  <input value={newGroupDesc} onChange={(e) => setNewGroupDesc(e.target.value)}
                    placeholder="描述（可选）"
                    className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500 transition-colors" />
                  <p className="text-xs text-gray-500">封面图片将作为组合第一个素材写入，审核通过后方可使用</p>
                </div>
                {/* 右列：文件选择区 */}
                <div>
                  <input ref={newGroupFileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      setNewGroupFile(f);
                      setNewGroupPreview(URL.createObjectURL(f));
                    }} />
                  {newGroupPreview ? (
                    <div className="aspect-square bg-[#0f111a] rounded-xl overflow-hidden cursor-pointer group relative border border-gray-700"
                      onClick={() => newGroupFileRef.current?.click()}>
                      <img src={newGroupPreview} className="w-full h-full object-contain" alt="封面预览" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <span className="text-white text-xs">更换图片</span>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => newGroupFileRef.current?.click()}
                      className="w-full aspect-square bg-[#0f111a] border-2 border-dashed border-gray-700 hover:border-purple-500 rounded-xl flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-purple-400 transition-colors cursor-pointer">
                      <span className="text-3xl">🖼</span>
                      <span className="text-xs">选择封面图片 *</span>
                    </button>
                  )}
                </div>
              </div>
              {createGroupStep && <p className="text-xs text-purple-400">{createGroupStep}</p>}
              <div className="flex gap-2">
                <button onClick={handleCreateGroup} disabled={createGroupLoading}
                  className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 rounded-xl text-white text-sm font-medium transition-all">
                  {createGroupLoading ? '创建中...' : '创建'}
                </button>
                <button onClick={() => { setShowCreateGroup(false); setNewGroupFile(null); setNewGroupPreview(''); }}
                  className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm font-medium transition-colors">取消</button>
              </div>
            </div>
          )}

          {/* 添加素材表单 */}
          {showAddAsset && volcLevel === 'assets' && (
            <div className="mb-6 p-5 bg-[#1c1f2e] border border-purple-500/30 rounded-2xl space-y-4">
              <h3 className="text-sm font-semibold text-white">添加素材</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* 左列：文字字段 */}
                <div className="space-y-3">
                  <input value={addAssetName} onChange={(e) => setAddAssetName(e.target.value)}
                    placeholder="素材名称（可选）"
                    className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500 transition-colors" />
                  {addAssetFile && (
                    <div className="p-3 bg-[#0f111a] border border-gray-700 rounded-xl space-y-1">
                      <p className="text-white text-sm truncate">{addAssetFile.name}</p>
                      <p className="text-gray-500 text-xs">{(addAssetFile.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  )}
                  <p className="text-xs text-gray-500">文件将先上传至 OSS，再异步写入火山引擎素材库，审核通过后方可使用</p>
                </div>
                {/* 右列：文件选择区 */}
                <div>
                  <input ref={addAssetFileRef} type="file" accept="image/*,video/*,audio/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) { setAddAssetFile(f); setAddAssetName(f.name.replace(/\.[^.]+$/, '')); } }} />
                  {addAssetFile ? (
                    <div className="aspect-square bg-[#0f111a] border border-gray-700 rounded-xl overflow-hidden cursor-pointer group relative flex items-center justify-center"
                      onClick={() => addAssetFileRef.current?.click()}>
                      {addAssetFile.type.startsWith('image/') ? (
                        <img src={URL.createObjectURL(addAssetFile)} className="w-full h-full object-contain" alt="预览" />
                      ) : (
                        <span className="text-5xl">{addAssetFile.type.startsWith('video/') ? '🎬' : '🎵'}</span>
                      )}
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <span className="text-white text-xs">更换文件</span>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => addAssetFileRef.current?.click()}
                      className="w-full aspect-square bg-[#0f111a] border-2 border-dashed border-gray-700 hover:border-purple-500 rounded-xl flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-purple-400 transition-colors cursor-pointer">
                      <span className="text-3xl">📁</span>
                      <span className="text-xs">选择文件（图像 / 视频 / 音频）</span>
                    </button>
                  )}
                </div>
              </div>
              {addAssetStep && <p className="text-xs text-purple-400">{addAssetStep}</p>}
              <div className="flex gap-2">
                <button onClick={handleAddAsset} disabled={addAssetLoading || !addAssetFile}
                  className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 rounded-xl text-white text-sm font-medium transition-all">
                  {addAssetLoading ? '提交中...' : '提交'}
                </button>
                <button onClick={() => { setShowAddAsset(false); setAddAssetFile(null); setAddAssetName(''); }}
                  className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm font-medium transition-colors">取消</button>
              </div>
            </div>
          )}

          {/* 搜索框 */}
          {volcLevel === 'groups' && (
            <div className="flex items-center gap-2 mb-4">
              <input value={volcGroupSearch} onChange={(e) => setVolcGroupSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadVolcGroups(1, volcGroupSearch)}
                placeholder="按名称搜索..."
                className="max-w-64 bg-[#1c1f2e] border border-gray-700 rounded-xl px-4 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
          )}
          {volcLevel === 'assets' && (
            <div className="flex items-center gap-2 mb-4">
              <input value={volcAssetSearch} onChange={(e) => setVolcAssetSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadVolcAssets(1, selectedGroup?.Id, volcAssetSearch)}
                placeholder="按名称搜索..."
                className="max-w-64 bg-[#1c1f2e] border border-gray-700 rounded-xl px-4 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
            </div>
          )}

          {/* ── 第一级：人物组合卡片 ── */}
          {volcLevel === 'groups' && (
            volcGroupsLoading ? (
              <div className="flex items-center justify-center h-40">
                <div className="animate-spin text-purple-500"><svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" /></svg></div>
              </div>
            ) : volcGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-500">
                <p>暂无人物组合</p>
                <p className="text-xs mt-1">点击「创建人物组合」新建，或「刷新」加载</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {volcGroups.map((g) => (
                    <div key={g.Id} className="bg-[#1c1f2e] border border-gray-800 hover:border-purple-500/40 rounded-2xl overflow-hidden transition-all group flex flex-col cursor-pointer"
                      onClick={() => handleEnterGroup(g)}>
                      {/* 封面 */}
                      <div className="aspect-square bg-[#0f111a] overflow-hidden relative flex-shrink-0">
                        {g.coverUrl ? (
                          <img src={g.coverUrl} alt={g.Name} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">👤</div>
                        )}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                      </div>
                      {/* 信息 + 操作 */}
                      <div className="p-3 flex flex-col gap-1.5 flex-1">
                        <p className="text-white text-sm font-medium truncate" title={g.Name}>{g.Name}</p>
                        {g.Description
                          ? <p className="text-gray-500 text-xs truncate" title={g.Description}>{g.Description}</p>
                          : <p className="text-gray-700 text-xs">—</p>}
                        <p className="text-gray-600 text-xs font-mono truncate" title={g.Id}>{g.Id}</p>
                        {g.CreateTime && (
                          <p className="text-gray-600 text-xs">{formatDateTime(g.CreateTime)}</p>
                        )}
                        <div className="mt-auto pt-1 flex items-center justify-between gap-2">
                          <span className="text-xs text-purple-400 group-hover:text-purple-300">查看素材 →</span>
                          <div className="flex items-center gap-1.5">
                            <button onClick={(e) => { e.stopPropagation(); setRenameGroupTarget(g); setRenameGroupName(g.Name || ''); }}
                              className="px-2 py-1 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 rounded-md text-xs transition-colors">改名</button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteGroupTarget(g); }}
                              className="px-2 py-1 bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-md text-xs transition-colors">删除</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {volcGroupTotal > 20 && (
                  <div className="mt-6 flex items-center justify-center gap-3">
                    <button onClick={() => loadVolcGroups(volcGroupPage - 1)} disabled={volcGroupPage <= 1}
                      className="px-4 py-2 bg-[#1c1f2e] border border-gray-700 rounded-xl text-white text-sm disabled:opacity-50 hover:bg-gray-800">上一页</button>
                    <span className="text-gray-400 text-sm">{volcGroupPage} · 共 {volcGroupTotal} 个</span>
                    <button onClick={() => loadVolcGroups(volcGroupPage + 1)} disabled={volcGroups.length < 20}
                      className="px-4 py-2 bg-[#1c1f2e] border border-gray-700 rounded-xl text-white text-sm disabled:opacity-50 hover:bg-gray-800">下一页</button>
                  </div>
                )}
              </>
            )
          )}

          {/* ── 第二级：素材列表 ── */}
          {volcLevel === 'assets' && (
            volcAssetsLoading ? (
              <div className="flex items-center justify-center h-40">
                <div className="animate-spin text-purple-500"><svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" /></svg></div>
              </div>
            ) : volcAssets.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-500">
                <p>该组合暂无素材</p>
                <p className="text-xs mt-1">点击「添加素材」上传</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                  {volcAssets.map((a) => {
                    const imgUrl = assetUrlMap[a.Id];
                    const isVideo = a.AssetType === 'Video';
                    return (
                      <div key={a.Id} className="bg-[#1c1f2e] border border-gray-800 hover:border-purple-500/40 rounded-2xl overflow-hidden transition-all group flex flex-col">
                        {/* 图片区 */}
                        <div className="aspect-square bg-[#0f111a] overflow-hidden relative flex-shrink-0">
                          {imgUrl && !isVideo ? (
                            <img src={imgUrl} alt={a.Name || a.Id} className="w-full h-full object-contain" />
                          ) : imgUrl && isVideo ? (
                            <video src={imgUrl} className="w-full h-full object-contain" muted />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">
                              {a.AssetType === 'Video' ? '🎬' : a.AssetType === 'Audio' ? '🎵' : '🖼'}
                            </div>
                          )}
                          {/* 审核状态角标 */}
                          <div className="absolute top-2 left-2">
                            <StatusBadge status={a.Status} />
                          </div>
                        </div>
                        {/* 信息区 */}
                        <div className="p-3 flex flex-col gap-1.5 flex-1">
                          <p className="text-white text-sm font-medium truncate" title={a.Name || a.Id}>
                            {a.Name || <span className="text-gray-500">—</span>}
                          </p>
                          {a.AssetType
                            ? <span className="text-xs text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded w-fit">{a.AssetType}</span>
                            : <p className="text-gray-700 text-xs">—</p>}
                          <p className="text-gray-600 text-xs font-mono truncate" title={a.Id}>{a.Id}</p>
                          <code className="text-xs text-cyan-400 font-mono select-all break-all">asset://{a.Id}</code>
                          {a.CreateTime && (
                            <p className="text-gray-600 text-xs">{formatDateTime(a.CreateTime)}</p>
                          )}
                          <div className="mt-auto pt-1">
                            <button onClick={() => handleDeleteAsset(a)}
                              className="w-full py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-md text-xs transition-colors">
                              删除
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(volcAssetPage > 1 || volcAssets.length >= 20) && (
                  <div className="mt-4 flex items-center justify-center gap-3">
                    <button onClick={() => loadVolcAssets(volcAssetPage - 1)} disabled={volcAssetPage <= 1}
                      className="px-4 py-2 bg-[#1c1f2e] border border-gray-700 rounded-xl text-white text-sm disabled:opacity-50 hover:bg-gray-800">上一页</button>
                    <span className="text-gray-400 text-sm">{volcAssetPage} · 共 {volcAssetTotal} 个</span>
                    <button onClick={() => loadVolcAssets(volcAssetPage + 1)} disabled={volcAssets.length < 20}
                      className="px-4 py-2 bg-[#1c1f2e] border border-gray-700 rounded-xl text-white text-sm disabled:opacity-50 hover:bg-gray-800">下一页</button>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      {/* ═══ 成员管理 Tab ═══ */}
      {tab === 'members' && (
        <div>
          <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-4 mb-6">
            <p className="text-sm font-medium text-gray-300 mb-3">邀请成员加入工作组</p>
            <div className="flex gap-2">
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInvite()} placeholder="输入用户邮箱"
                className="flex-1 px-4 py-2.5 bg-[#0f111a] border border-gray-700 focus:border-purple-500 rounded-xl text-white text-sm outline-none" />
              <button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}
                className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 rounded-xl text-sm font-medium text-white transition-all">
                {inviting ? '邀请中...' : '邀请'}
              </button>
            </div>
            {memberError && <p className="text-red-400 text-xs mt-2">{memberError}</p>}
          </div>
          {membersLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin text-purple-500"><svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" /></svg></div>
            </div>
          ) : members.length === 0 ? (
            <div className="text-center py-12 text-gray-500">暂无成员，邀请其他用户加入工作组</div>
          ) : (
            <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
              <table className="w-full">
                <thead className="bg-[#0f111a]">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 uppercase">邮箱</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 uppercase">角色</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 uppercase">加入时间</th>
                    <th className="px-5 py-3 text-left text-xs font-medium text-gray-400 uppercase">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {members.map((m) => (
                    <tr key={m.id} className="hover:bg-[#0f111a]/50">
                      <td className="px-5 py-3 text-sm text-white">{m.email}</td>
                      <td className="px-5 py-3 text-sm"><MemberRoleTag role={m.role} /></td>
                      <td className="px-5 py-3 text-sm text-gray-400">{formatDate(m.created_at)}</td>
                      <td className="px-5 py-3 text-sm">
                        {m.role !== 'owner' && (isAdmin || currentUser?.id === m.user_id) && (
                          <button onClick={() => handleRemoveMember(m)}
                            className="px-2 py-1 bg-red-600/10 text-red-500 hover:bg-red-600/20 rounded-md text-xs transition-colors">移除</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>

    {/* 删除组合确认弹窗 */}
    {deleteGroupTarget && (
      <DeleteConfirmModal
        name={deleteGroupTarget.Name}
        onConfirm={handleConfirmDeleteGroup}
        onCancel={() => setDeleteGroupTarget(null)}
      />
    )}
    {deleteGroupLoading && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="text-white text-sm">删除中...</div>
      </div>
    )}

    {/* 重命名素材组弹窗 */}
    {renameGroupTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl shadow-2xl p-6 w-full max-w-md">
          <h3 className="text-lg font-semibold text-white mb-4">重命名素材组</h3>
          <p className="text-xs text-gray-500 mb-3">原名：<span className="text-gray-300">{renameGroupTarget.Name}</span></p>
          <input
            autoFocus
            value={renameGroupName}
            maxLength={60}
            onChange={(e) => setRenameGroupName(e.target.value)}
            placeholder="输入新名称"
            className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
          />
          <p className="text-[10px] text-gray-500 mt-2">同工作组内重名时将自动加 (N) 后缀。</p>
          <div className="mt-4 flex gap-2 justify-end">
            <button
              onClick={() => { setRenameGroupTarget(null); setRenameGroupName(''); }}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm"
            >取消</button>
            <button
              disabled={renameGroupLoading || !renameGroupName.trim() || renameGroupName.trim() === renameGroupTarget.Name}
              onClick={async () => {
                if (!currentProject || !renameGroupTarget) return;
                setRenameGroupLoading(true);
                try {
                  const r = await fetch(
                    `/api/volc-native/asset-groups/${encodeURIComponent(renameGroupTarget.Id)}/rename`,
                    {
                      method: 'PATCH',
                      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                      body: JSON.stringify({ name: renameGroupName.trim(), projectId: currentProject.id }),
                    },
                  );
                  const d = await r.json();
                  if (!r.ok || !d.success) throw new Error(d.error || '重命名失败');
                  if (d.data?.suggested) {
                    alert(`存在同名素材组，已自动改为：${d.data.name}`);
                  }
                  setRenameGroupTarget(null);
                  setRenameGroupName('');
                  await loadVolcGroups(volcGroupPage);
                } catch (e) {
                  alert(e instanceof Error ? e.message : '重命名失败');
                } finally {
                  setRenameGroupLoading(false);
                }
              }}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg text-white text-sm font-medium"
            >{renameGroupLoading ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
