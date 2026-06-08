import { useState, useEffect, useCallback } from 'react';
import ProjectConsumptionPanel from '../components/ProjectConsumptionPanel';
import TeamConsumptionPanel from '../components/TeamConsumptionPanel';
import { DownloadIcon } from '../components/Icons';
import { useApp } from '../context/AppContext';
import { getAuthHeaders } from '../services/authService';
import { formatDateTime, getUserTimezone } from '../utils/datetime';

interface FixEntry { id: number; type: 'wrong' | 'dead'; returnedCredits: number; }

interface ConsumptionRow {
  id: number; time: string;
  userName: string; userEmail: string; department: string; project: string;
  action: string; actionLabel: string; model: string; status: string;
  lockedCredits: number | null; actualCredits: number | null;
}

const ACTION_OPTIONS = [
  { value: '', label: '全部行为' },
  { value: 'image', label: '图片生成' },
  { value: 'audio', label: '音频生成' },
  { value: 'video', label: '视频生成' },
  { value: 'enhancement', label: '视频增强' },
];

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  locked: { text: '已锁定', cls: 'bg-blue-500/20 text-blue-300' },
  settled: { text: '已结算', cls: 'bg-emerald-500/20 text-emerald-300' },
  released: { text: '已释放', cls: 'bg-red-500/20 text-red-300' },
};

export default function ConsumptionAnalysisPage() {
  const [tab, setTab] = useState<'detail' | 'project' | 'team'>('detail');

  useEffect(() => {
    const titles: Record<string, string> = { detail: '消耗明细', project: '项目消耗', team: '团队消耗' };
    document.title = titles[tab] || '消耗分析';
  }, [tab]);

  const { currentUser } = useApp();
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const isAdmin = currentUser?.role === 'admin';
  const isUser = !isSuperAdmin && !isAdmin;

  const [rows, setRows] = useState<ConsumptionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  const [filterUser, setFilterUser] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [fixMap, setFixMap] = useState<Map<number, FixEntry>>(new Map());
  const [fixingIds, setFixingIds] = useState<Set<number>>(new Set());
  const [fixBanner, setFixBanner] = useState<string | null>(null);

  const loadData = useCallback(async (pg: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(pg), pageSize: String(pageSize) });
      if (!isUser && filterUser) qs.set('user', filterUser);
      if (!isUser && !isAdmin && filterDept) qs.set('department', filterDept);
      if (filterProject) qs.set('project', filterProject);
      if (filterAction) qs.set('action', filterAction);
      if (filterStatus) qs.set('status', filterStatus);

      const res = await fetch(`/api/admin/consumption-analysis?${qs}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRows(data.data.rows);
      setTotal(data.data.total);

      const fl: FixEntry[] = data.data.fixLog || [];
      if (fl.length > 0) {
        const newMap = new Map<number, FixEntry>();
        const ids = new Set<number>();
        let totalCredits = 0;
        for (const f of fl) { newMap.set(f.id, f); ids.add(f.id); totalCredits += f.returnedCredits || 0; }
        setFixMap(newMap);
        setFixingIds(ids);
        setFixBanner(`本次自动修复 ${fl.length} 个锁，归还 ${totalCredits} 积分`);
        setTimeout(() => { setFixingIds(new Set()); setFixBanner(null); }, 300);
      } else {
        // 保持已有 fixMap 用于显示已修复行的最终状态
        setFixBanner(null);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [filterUser, filterDept, filterProject, filterAction, filterStatus, isUser, isAdmin]);

  useEffect(() => { loadData(1); }, [loadData]);

  const totalPages = Math.ceil(total / pageSize);

  const handleExport = async (range: string) => {
    try {
      const qs = new URLSearchParams({ range, tz: getUserTimezone() });
      const res = await fetch(`/api/admin/consumption-analysis/export?${qs}`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const monthStr = dateStr.slice(0, 7);
      let suffix = range === 'today' ? `_${dateStr}` : range === 'month' ? `_${monthStr}` : '';
      let prefix = '';
      if (isUser && currentUser?.name) prefix = `${currentUser.name}_`;
      else if (isAdmin && currentUser?.department) prefix = `${currentUser.department}_`;
      a.download = `${prefix}消耗明细${suffix}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e: any) { alert(e.message || '导出失败'); }
  };

  function getStatusDisplay(r: ConsumptionRow) {
    const fix = fixMap.get(r.id);
    if (fix) {
      if (fixingIds.has(r.id)) return { text: '操作中', cls: 'bg-yellow-500/20 text-yellow-300 animate-pulse' };
      if (fix.type === 'wrong') return { text: '错锁已解锁', cls: 'bg-amber-500/20 text-amber-300' };
      if (fix.type === 'dead') return { text: '死锁已解锁', cls: 'bg-orange-500/20 text-orange-300' };
    }
    const st = STATUS_LABELS[r.status] || { text: r.status, cls: 'bg-gray-700 text-gray-300' };
    return { text: st.text, cls: st.cls };
  }

  return (
    <div className="p-6 max-w-full mx-auto">
      <div className="flex border-b border-gray-700 mb-6">
        <button onClick={() => setTab('detail')}
          className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
            tab === 'detail' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-500'
          }`}>消耗明细</button>
          {!isUser && (
            <button onClick={() => setTab('project')}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === 'project' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-500'
              }`}>项目消耗</button>
          )}
          {!isUser && (
            <button onClick={() => setTab('team')}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === 'team' ? 'border-purple-500 text-purple-400' : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-500'
              }`}>团队消耗</button>
          )}
      </div>

      {tab === 'detail' ? (
        <>
      {fixBanner && (
        <div className="mb-4 px-4 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400 flex items-center gap-2">
          <span className="animate-pulse">●</span> {fixBanner}
        </div>
      )}

      <div className="flex flex-wrap gap-3 mb-4">
        {!isUser && (
          <input className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white w-40"
            placeholder="用户（姓名/邮箱）" value={filterUser}
            onChange={e => { setFilterUser(e.target.value); setPage(1); }} />
        )}
        {!isUser && !isAdmin && (
          <input className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white w-32"
            placeholder="小组" value={filterDept}
            onChange={e => { setFilterDept(e.target.value); setPage(1); }} />
        )}
        <input className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white w-32"
          placeholder="项目" value={filterProject}
          onChange={e => { setFilterProject(e.target.value); setPage(1); }} />
        <select className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white"
          value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(1); }}>
          {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white"
          value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          <option value="locked">已锁定</option>
          <option value="settled">已结算</option>
          <option value="released">已释放</option>
        </select>
        <button onClick={() => { setPage(1); loadData(1); }}
          className="px-4 py-1.5 bg-purple-600 text-white rounded text-sm hover:bg-purple-500">查询</button>
        <div className="flex-1" />
        <span className="text-gray-500 text-xs">导出:</span>
        {['today','month','all'].map(range => (
          <button key={range} onClick={() => handleExport(range)}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/40 hover:bg-emerald-600/30 rounded text-sm text-emerald-400 font-medium transition-all">
            <DownloadIcon className="w-3.5 h-3.5" />
            {range === 'today' ? '今天' : range === 'month' ? '本月' : '全部'}
          </button>
        ))}
      </div>

      <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-400">暂无数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[#0f111a] border-b border-gray-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs text-gray-400">时间</th>
                {!isUser && <th className="px-3 py-2 text-left text-xs text-gray-400">用户</th>}
                {!isUser && !isAdmin && <th className="px-3 py-2 text-left text-xs text-gray-400">小组</th>}
                <th className="px-3 py-2 text-left text-xs text-gray-400">项目</th>
                <th className="px-3 py-2 text-left text-xs text-gray-400">行为</th>
                <th className="px-3 py-2 text-left text-xs text-gray-400">模型</th>
                <th className="px-3 py-2 text-left text-xs text-gray-400">状态</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400">锁定积分</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400">实际积分</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map(r => {
                const st = getStatusDisplay(r);
                return (
                  <tr key={r.id} className="hover:bg-[#0f111a]/50">
                    <td className="px-3 py-2 text-gray-300 text-xs whitespace-nowrap">{r.time ? formatDateTime(r.time) : '-'}</td>
                    {!isUser && <td className="px-3 py-2 text-gray-300 text-xs">{r.userName && r.userEmail ? `${r.userName}(${r.userEmail})` : r.userName || r.userEmail || '-'}</td>}
                    {!isUser && !isAdmin && <td className="px-3 py-2 text-gray-300 text-xs">{r.department || '-'}</td>}
                    <td className="px-3 py-2 text-gray-300 text-xs max-w-[120px] truncate">{r.project || '-'}</td>
                    <td className="px-3 py-2"><span className="px-1.5 py-0.5 rounded text-xs bg-gray-700/60 text-gray-300">{r.actionLabel}</span></td>
                    <td className="px-3 py-2 text-gray-400 text-xs font-mono">{r.model || '-'}</td>
                    <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded text-xs ${st.cls}`}>{st.text}</span></td>
                    <td className="px-3 py-2 text-amber-400 text-xs text-right">{r.lockedCredits ?? '-'}</td>
                    <td className="px-3 py-2 text-emerald-400 text-xs text-right font-semibold">{r.actualCredits != null ? r.actualCredits : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button onClick={() => { const p = page - 1; setPage(p); loadData(p); }} disabled={page <= 1}
            className="px-3 py-1 bg-gray-700 text-white rounded text-sm disabled:opacity-50">上一页</button>
          <span className="text-gray-400 text-sm">{page}/{totalPages} 页（共 {total} 条）</span>
          <button onClick={() => { const p = page + 1; setPage(p); loadData(p); }} disabled={page >= totalPages}
            className="px-3 py-1 bg-gray-700 text-white rounded text-sm disabled:opacity-50">下一页</button>
        </div>
      )}
    </>
      ) : tab === 'project' ? (
        <ProjectConsumptionPanel />
      ) : (
        <TeamConsumptionPanel />
      )}
    </div>
  );
}