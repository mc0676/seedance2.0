import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { formatDateTime, parseServerDate } from '../utils/datetime';
import * as XLSX from 'xlsx';
import {
  fetchDailyTrend,
  fetchTodayRanking,
  fetchCreditDetails,
  fetchGroupSummary,
  fetchProjectConsumption,
  fetchFailureAnalysis,
  fetchUserActivity,
  CreditDetailItem,
  getAuthHeaders,
} from '../services/authService';

const ANALYTICS_TABS = ['趋势图', '当日排行', '消耗明细', '小组汇总', '项目组消耗', '失败分析', '用户活跃度'] as const;

const CACHE_TTL = 5 * 60 * 1000; // 5分钟

function cacheGet(key: string) {
  try {
    const raw = localStorage.getItem(`analytics_${key}`);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts < CACHE_TTL) return data;
  } catch {}
  return null;
}

function cacheSet(key: string, data: any) {
  try { localStorage.setItem(`analytics_${key}`, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// SVG 简单折线图
function TrendChart({ data }: { data: Array<{ day: string; consumed: number }> }) {
  if (data.length === 0) return <p className="text-gray-500 text-sm p-4">暂无数据</p>;
  const W = 600, H = 220, P = 20, BW = W - 2 * P, BH = H - 2 * P;
  const maxV = Math.max(1, ...data.map(d => d.consumed));
  const points = data.map((d, i) => {
    const x = P + (i / Math.max(1, data.length - 1)) * BW;
    const y = P + BH - (d.consumed / maxV) * BH;
    return `${x},${y}`;
  }).join(' ');
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[600px] h-auto">
        <defs>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(168,85,247)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(168,85,247)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map(r => (
          <line key={r} x1={P} y1={P + BH * (1 - r)} x2={P + BW} y2={P + BH * (1 - r)} stroke="#374151" strokeWidth="0.5" />
        ))}
        <polygon points={`${P},${P + BH} ${points} ${P + BW},${P + BH}`} fill="url(#lineGrad)" />
        <polyline points={points} fill="none" stroke="rgb(168,85,247)" strokeWidth="2" strokeLinejoin="round" />
        {data.filter((_, i) => data.length <= 7 || i % Math.ceil(data.length / 7) === 0 || i === data.length - 1).map((d, i) => {
          const idx = data.indexOf(d);
          const x = P + (idx / Math.max(1, data.length - 1)) * BW;
          return <text key={i} x={x} y={H - 2} textAnchor="middle" fill="#6b7280" fontSize="8">{d.day.slice(5)}</text>;
        })}
      </svg>
    </div>
  );
}

// 迷你柱状图（用于活跃度）
function BarChart({ data }: { data: Array<{ day: string; active_users: number }> }) {
  if (data.length === 0) return <p className="text-gray-500 text-sm p-4">暂无数据</p>;
  const W = 600, H = 180, P = 20, BW = (W - 2 * P) / data.length - 2;
  const maxV = Math.max(1, ...data.map(d => d.active_users));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[600px] h-auto">
        {data.map((d, i) => {
          const h = (d.active_users / maxV) * (H - 2 * P - 10);
          const x = P + i * (BW + 2);
          const y = H - P - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={BW} height={h} rx="2" fill="rgb(99,102,241)" opacity="0.8">
                <title>{d.day}: {d.active_users} 活跃用户</title>
              </rect>
              {data.length <= 15 && <text x={x + BW/2} y={H - 2} textAnchor="middle" fill="#6b7280" fontSize="7">{d.day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function AnalyticsPanels() {
  const { currentUser } = useApp();
  const [dimension, setDimension] = useState<'all' | 'department'>(currentUser?.role === 'super_admin' ? 'all' : 'department');
  const [tab, setTab] = useState<string>('趋势图');
  const [trendData, setTrendData] = useState<Array<{ day: string; consumed: number; active_users: number; total_calls: number }>>([]);
  const [rankingData, setRankingData] = useState<Array<{ id: number; email: string; name: string | null; department: string; total_credits: number; call_count: number }>>([]);
  const [detailData, setDetailData] = useState<{ rows: CreditDetailItem[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } } | null>(null);
  const [groupData, setGroupData] = useState<Array<{ department: string; user_count: number; total_credits: number; call_count: number }>>([]);
  const [groupDrill, setGroupDrill] = useState<{ group: string; data: Array<any> } | null>(null);
  const [projectData, setProjectData] = useState<Array<{ id: number; name: string; user_count: number; total_credits: number; task_count: number }>>([]);
  const [failureData, setFailureData] = useState<Array<{ action: string; error_message: string | null; fail_count: number; wasted_credits: number }>>([]);
  const [activityData, setActivityData] = useState<{ dailyActive: Array<{ day: string; active_users: number }>; dormant: Array<any> } | null>(null);
  const [detailQuery, setDetailQuery] = useState({ page: 1, name: '', email: '', date: '', action: '', model: '' });
  const [groupDays, setGroupDays] = useState(7);
  const [failureDays, setFailureDays] = useState(7);
  const [loadingPanel, setLoadingPanel] = useState('');
  const loadedRef = useRef<Set<string>>(new Set());
  // 小组维度 autocomplete
  const [deptMembers, setDeptMembers] = useState<Array<{ id: number; email: string; name: string }>>([]);
  const [showNameDropdown, setShowNameDropdown] = useState(false);
  const [showEmailDropdown, setShowEmailDropdown] = useState(false);

  // ── 导出状态 ─────────────────────────────────────────────────
  const [showDateRange, setShowDateRange] = useState(false);
  const [exportDateFrom, setExportDateFrom] = useState('');
  const [exportDateTo, setExportDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function weekRange(): { from: string; to: string } {
    const d = new Date();
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    return { from: fmt(monday), to: fmt(sunday) };
  }

  function monthRange(): { from: string; to: string } {
    const d = new Date();
    const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { from, to };
  }

  function fmtDateCell(val: unknown): string {
    if (!val) return '';
    const d = parseServerDate(val as string);
    if (!d) return String(val);
    const opts: Intl.DateTimeFormatOptions = {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Shanghai',
    };
    return new Intl.DateTimeFormat('zh-CN', opts).format(d);
  }

  function sheetFromData(headerMap: [string, string][], rows: Record<string, unknown>[]): unknown[][] {
    const headerRow = headerMap.map(([, label]) => label);
    const sheetRows = rows.map((r) =>
      headerMap.map(([key]) => {
        const val = r[key];
        if (key === 'created_at' || key === 'settled_at' || key === 'last_active') return fmtDateCell(val);
        if (key === 'status' && (val === 'success' || val === 'failed')) return val === 'success' ? '成功' : '失败';
        if (val === null || val === undefined) return '';
        return val;
      })
    );
    return [headerRow, ...sheetRows];
  }

    async function doExport(dateFrom: string, dateTo: string, includeTodayRanking: boolean) {
      setExporting(true);
      try {
        const deptId = dimension === 'department' ? currentUser?.department_id : undefined;
        const sp = new URLSearchParams();
        if (dateFrom) sp.set('dateFrom', dateFrom);
        if (dateTo) sp.set('dateTo', dateTo);
        if (deptId) sp.set('departmentId', String(deptId));

      // 小组工作表名：小组维度时用部门名
      const groupSheetName = dimension === 'department' && currentUser?.department ? `${currentUser.department} 汇总` : '小组汇总';

      // 并行请求所有数据
      const fetches: Promise<[string, unknown[]]>[] = [];

      // 消耗明细
      fetches.push(
        fetch(`/api/admin/credits/export?${sp}`, { headers: getAuthHeaders() })
          .then(r => r.json())
          .then(d => d.success ? ['消耗明细', d.data] as [string, unknown[]] : Promise.reject(d.error))
      );

      // 小组汇总
      fetches.push(
        fetch(`/api/admin/credits/export-group-summary?${sp}`, { headers: getAuthHeaders() })
          .then(r => r.json())
          .then(d => d.success ? [groupSheetName, d.data] as [string, unknown[]] : Promise.reject(d.error))
      );

      // 项目组消耗
      fetches.push(
        fetch(`/api/admin/credits/export-project-consumption?${sp}`, { headers: getAuthHeaders() })
          .then(r => r.json())
          .then(d => d.success ? ['项目组消耗', d.data] as [string, unknown[]] : Promise.reject(d.error))
      );

      // 当日排行（仅本日导出）
      if (includeTodayRanking) {
        const rankingSp = new URLSearchParams();
        if (deptId) rankingSp.set('departmentId', String(deptId));
        fetches.push(
          fetch(`/api/admin/credits/today-ranking?${rankingSp}`, { headers: getAuthHeaders() })
            .then(r => r.json())
            .then(d => d.success ? ['当日排行', d.data] as [string, unknown[]] : Promise.reject(d.error))
        );
      }

      const results = await Promise.all(fetches);

      const wb = XLSX.utils.book_new();

      // 当日排行（第一个 sheet）
      const rankingEntry = results.find(([name]) => name === '当日排行');
      if (rankingEntry) {
        const rankingData = rankingEntry[1] as Array<{ id: number; email: string; name: string | null; department: string; total_credits: number; call_count: number }>;
        const rankingHeaders: [string, string][] = [
          ['email', '邮箱'],
          ['name', '用户名'],
          ['department', '部门'],
          ['total_credits', '消耗积分'],
          ['call_count', '调用次数'],
        ];
        const rankingSheet = sheetFromData(rankingHeaders, rankingData as any[]);
        const ws = XLSX.utils.aoa_to_sheet(rankingSheet);
        XLSX.utils.book_append_sheet(wb, ws, '当日排行');
      }

      // 消耗明细
      const detailEntry = results.find(([name]) => name === '消耗明细');
      if (detailEntry) {
        const detailHeaders: [string, string][] = [
          ['id', 'ID'],
          ['email', '邮箱'],
          ['name', '用户名'],
          ['department', '部门'],
          ['model', '模型'],
          ['action', '动作'],
          ['credits_cost', '消耗积分'],
          ['status', '状态'],
          ['error_message', '错误信息'],
          ['created_at', '时间'],
        ];
        const detailSheet = sheetFromData(detailHeaders, detailEntry[1] as any[]);
        const ws = XLSX.utils.aoa_to_sheet(detailSheet);
        XLSX.utils.book_append_sheet(wb, ws, '消耗明细');
      }

      // 小组汇总
      const groupEntry = results.find(([name]) => name === groupSheetName);
      if (groupEntry) {
        const groupHeaders: [string, string][] = [
          ['department', '小组'],
          ['user_count', '用户数'],
          ['total_credits', '消耗积分'],
          ['call_count', '调用次数'],
        ];
        const groupSheet = sheetFromData(groupHeaders, groupEntry[1] as any[]);
        const ws = XLSX.utils.aoa_to_sheet(groupSheet);
        XLSX.utils.book_append_sheet(wb, ws, groupSheetName);
      }

      // 项目组消耗
      const projEntry = results.find(([name]) => name === '项目组消耗');
      if (projEntry) {
        const projHeaders: [string, string][] = [
          ['name', '项目组'],
          ['user_count', '用户数'],
          ['task_count', '任务数'],
          ['total_credits', '消耗积分'],
        ];
        const projSheet = sheetFromData(projHeaders, projEntry[1] as any[]);
        const ws = XLSX.utils.aoa_to_sheet(projSheet);
        XLSX.utils.book_append_sheet(wb, ws, '项目组消耗');
      }

      const label = dateFrom === dateTo ? dateFrom : `${dateFrom}_${dateTo}`;
      XLSX.writeFile(wb, `消耗分析_${label}.xlsx`);
    } catch (e) {
      alert(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  function handleExportToday() {
    const today = todayStr();
    doExport(today, today, true);
  }

  function handleExportWeek() {
    const { from, to } = weekRange();
    doExport(from, to, false);
  }

  function handleExportMonth() {
    const { from, to } = monthRange();
    doExport(from, to, false);
  }

  function handleExportRange() {
    if (!exportDateFrom && !exportDateTo) {
      setShowDateRange(!showDateRange);
      return;
    }
    doExport(exportDateFrom || '', exportDateTo || '', false);
    setShowDateRange(false);
  }

  function fetchTab(key: string) {
    const deptId = dimension === 'department' ? currentUser?.department_id : undefined;
    const cacheKey = deptId ? `${key}_dept_${deptId}` : key;
    const cached = cacheGet(cacheKey);
    if (cached) {
      loadedRef.current.add(cacheKey);
      switch (key) {
        case '趋势图': setTrendData(cached); break;
        case '当日排行': setRankingData(cached); break;
        case '消耗明细': setDetailData(cached); break;
        case '小组汇总': setGroupData(cached as any[]); break;
        case '项目组消耗': setProjectData(cached); break;
        case '失败分析': setFailureData(cached); break;
        case '用户活跃度': setActivityData(cached); break;
      }
      return;
    }

    setLoadingPanel(key);
    loadedRef.current.add(cacheKey);
    switch (key) {
      case '趋势图':
        fetchDailyTrend(30, deptId).then(d => { setTrendData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '当日排行':
        fetchTodayRanking(deptId).then(d => { setRankingData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '消耗明细':
        fetchCreditDetails({ page: detailQuery.page, name: detailQuery.name || undefined, email: detailQuery.email || undefined, date: detailQuery.date || undefined, action: detailQuery.action || undefined, model: detailQuery.model || undefined, departmentId: deptId })
          .then(d => { setDetailData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '小组汇总':
        fetchGroupSummary(groupDays, undefined, deptId).then(d => { setGroupData(d as any[]); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '项目组消耗':
        fetchProjectConsumption(30, deptId).then(d => { setProjectData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '失败分析':
        fetchFailureAnalysis(failureDays, deptId).then(d => { setFailureData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
      case '用户活跃度':
        fetchUserActivity(30, deptId).then(d => { setActivityData(d); cacheSet(cacheKey, d); }).catch(() => {}).finally(() => setLoadingPanel(''));
        break;
    }
  }

  useEffect(() => {
    const deptId = dimension === 'department' ? currentUser?.department_id : undefined;
    const cacheKey = deptId ? `${tab}_dept_${deptId}` : tab;
    if (!loadedRef.current.has(cacheKey)) {
      fetchTab(tab);
    }
  }, [tab, dimension]);

  // 小组维度：加载组成员给 autocomplete
  useEffect(() => {
    if (dimension === 'department' && currentUser?.department_id) {
      fetch(`/api/admin/departments/${currentUser.department_id}/members`, { headers: getAuthHeaders() })
        .then(r => r.json())
        .then(d => { if (d.success) setDeptMembers(d.data.members || []); })
        .catch(() => {});
    } else {
      setDeptMembers([]);
    }
  }, [dimension, currentUser?.department_id]);

  function loadDetails(page: number) {
    setDetailQuery(q => ({ ...q, page }));
    setLoadingPanel('消耗明细');
    fetchCreditDetails({ page, name: detailQuery.name || undefined, email: detailQuery.email || undefined, date: detailQuery.date || undefined, action: detailQuery.action || undefined, model: detailQuery.model || undefined })
      .then(setDetailData).catch(() => {}).finally(() => setLoadingPanel(''));
  }

  function drillGroup(group: string) {
    setLoadingPanel('小组汇总');
    fetchGroupSummary(groupDays, group).then(d => {
      setGroupDrill({ group, data: d as any[] });
    }).catch(() => {}).finally(() => setLoadingPanel(''));
  }

  return (
    <div className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden mb-8">
      <div className="p-6 border-b border-gray-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">消耗分析</h2>
            <p className="text-gray-400 text-sm mt-1">积分消耗统计、排行与明细查询</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {exporting && (
              <span className="text-emerald-400 text-xs flex items-center gap-1">
                <span className="animate-spin h-3 w-3 border-2 border-emerald-400 border-t-transparent rounded-full" />
                导出中...
              </span>
            )}
            <button onClick={handleExportToday} disabled={exporting}
              className="px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 hover:bg-emerald-600/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-emerald-300 text-xs font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              导出本日
            </button>
            <button onClick={handleExportWeek} disabled={exporting}
              className="px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 hover:bg-emerald-600/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-emerald-300 text-xs font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              导出本周
            </button>
            <button onClick={handleExportMonth} disabled={exporting}
              className="px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 hover:bg-emerald-600/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-emerald-300 text-xs font-medium transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              导出本月
            </button>
            <div className="flex items-center gap-1">
              {showDateRange && (
                <>
                  <input type="date" value={exportDateFrom} onChange={e => setExportDateFrom(e.target.value)} disabled={exporting}
                    className="w-28 px-2 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500 disabled:opacity-50" />
                  <span className="text-gray-500 text-xs">至</span>
                  <input type="date" value={exportDateTo} onChange={e => setExportDateTo(e.target.value)} disabled={exporting}
                    className="w-28 px-2 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500 disabled:opacity-50" />
                </>
              )}
              <button onClick={handleExportRange} disabled={exporting}
                className="px-3 py-1.5 bg-emerald-600/20 border border-emerald-500/30 hover:bg-emerald-600/40 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-emerald-300 text-xs font-medium transition-colors flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                按时间导出
              </button>
            </div>
          </div>
        </div>
      </div>
      {/* 维度 Tab 栏 */}
      <div className="flex flex-wrap items-center px-6 pt-4 border-b border-gray-800 gap-1">
        {(['all', 'department'] as const).map(d => (
          <button key={d} onClick={() => {
            setDimension(d);
            loadedRef.current.clear();
            fetchTab(tab);
          }}
            className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
              dimension === d ? 'bg-[#0f111a] text-purple-400 border-t border-l border-r border-gray-800' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {d === 'all' ? '全部维度' : '小组维度'}
          </button>
        ))}
      </div>
      {/* 小组维度标题 */}
      {dimension === 'department' && currentUser?.department && (
        <div className="px-6 pt-3">
          <h3 className="text-sm font-medium text-purple-400">{currentUser.department} 数据分析</h3>
        </div>
      )}
      {/* 二级 Tab 栏 */}
      <div className="flex flex-wrap items-center justify-between px-6 pt-2 border-b border-gray-800">
        <div className="flex flex-wrap gap-1">
          {(dimension === 'department' ? ANALYTICS_TABS.filter(t => t !== '小组汇总') : ANALYTICS_TABS).map(t => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                if (t === '小组汇总') { setGroupDrill(null); }
              }}
              className={`px-4 py-2 text-sm rounded-t-lg transition-colors ${
                tab === t
                  ? 'bg-[#0f111a] text-purple-400 border-t border-l border-r border-gray-800'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => { const deptId = dimension === 'department' ? currentUser?.department_id : undefined; const ck = deptId ? `${tab}_dept_${deptId}` : tab; loadedRef.current.delete(ck); localStorage.removeItem(`analytics_${ck}`); fetchTab(tab); }}
          className="px-3 py-1.5 text-xs text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
          title="刷新当前面板"
        >
          <svg className="w-4 h-4 inline-block mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          刷新
        </button>
      </div>

      {/* 面板内容 */}
      <div className="p-6">
        {loadingPanel === tab && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin text-purple-500">
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
              </svg>
            </div>
            <span className="ml-3 text-gray-400 text-sm">加载中…</span>
          </div>
        )}

        {/* 趋势图 */}
        {tab === '趋势图' && !loadingPanel && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-300">近30日积分消耗趋势</h3>
              <div className="flex gap-3 text-xs text-gray-500">
                <span>总消耗: <b className="text-purple-400">{trendData.reduce((s, d) => s + d.consumed, 0).toLocaleString()}</b></span>
                <span>日均调用: <b className="text-blue-400">{trendData.length ? Math.round(trendData.reduce((s, d) => s + d.total_calls, 0) / trendData.length) : 0}</b></span>
              </div>
            </div>
            <TrendChart data={trendData} />
          </div>
        )}

        {/* 当日排行 */}
        {tab === '当日排行' && !loadingPanel && (
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">今日积分消耗排行</h3>
            {rankingData.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无今日消耗数据</p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">#</th>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">用户</th>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">小组</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">消耗积分</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">调用次数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {rankingData.map((r, i) => (
                      <tr key={r.id} className="hover:bg-[#0f111a]/50">
                        <td className="px-4 py-2 text-gray-500">{i + 1}</td>
                        <td className="px-4 py-2 text-white">{r.name || r.email}</td>
                        <td className="px-4 py-2 text-gray-400">{r.department || '-'}</td>
                        <td className="px-4 py-2 text-right text-purple-400 font-mono">{r.total_credits}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{r.call_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 消耗明细 */}
        {tab === '消耗明细' && !loadingPanel && (
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              {/* 用户名 autocomplete */}
              <div className="relative">
                <input type="text" placeholder="用户名" value={detailQuery.name}
                  onChange={e => setDetailQuery(q => ({ ...q, name: e.target.value }))}
                  onFocus={() => dimension === 'department' && setShowNameDropdown(true)}
                  onBlur={() => setTimeout(() => setShowNameDropdown(false), 200)}
                  className="w-28 px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-purple-500" />
                {dimension === 'department' && showNameDropdown && deptMembers.length > 0 && (
                  <div className="absolute z-10 mt-1 w-48 max-h-40 overflow-y-auto bg-[#1c1f2e] border border-gray-700 rounded-lg shadow-lg">
                    {deptMembers.filter(m => !detailQuery.name || m.name.includes(detailQuery.name)).slice(0, 50).map(m => (
                      <div key={m.id} className="px-3 py-1.5 text-xs text-gray-300 hover:bg-[#0f111a] hover:text-white cursor-pointer"
                        onMouseDown={() => { setDetailQuery(q => ({ ...q, name: m.name })); setShowNameDropdown(false); }}>
                        {m.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 邮箱 autocomplete */}
              <div className="relative">
                <input type="text" placeholder="邮箱" value={detailQuery.email}
                  onChange={e => setDetailQuery(q => ({ ...q, email: e.target.value }))}
                  onFocus={() => dimension === 'department' && setShowEmailDropdown(true)}
                  onBlur={() => setTimeout(() => setShowEmailDropdown(false), 200)}
                  className="w-36 px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-purple-500" />
                {dimension === 'department' && showEmailDropdown && deptMembers.length > 0 && (
                  <div className="absolute z-10 mt-1 w-64 max-h-40 overflow-y-auto bg-[#1c1f2e] border border-gray-700 rounded-lg shadow-lg">
                    {deptMembers.filter(m => !detailQuery.email || m.email.includes(detailQuery.email) || m.name.includes(detailQuery.email)).slice(0, 50).map(m => (
                      <div key={m.id} className="px-3 py-1.5 text-xs text-gray-300 hover:bg-[#0f111a] hover:text-white cursor-pointer"
                        onMouseDown={() => { setDetailQuery(q => ({ ...q, email: m.email })); setShowEmailDropdown(false); }}>
                        {m.name}{m.name ? ' ' : ''}({m.email})
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input type="date" value={detailQuery.date} onChange={e => setDetailQuery(q => ({ ...q, date: e.target.value }))}
                className="px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-purple-500" />
              <input type="text" placeholder="模型" value={detailQuery.model} onChange={e => setDetailQuery(q => ({ ...q, model: e.target.value }))}
                className="w-28 px-3 py-1.5 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs focus:outline-none focus:border-purple-500" />
              <button onClick={() => loadDetails(1)}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-xs font-medium">查询</button>
              {detailData && (
                <span className="text-xs text-gray-500">
                  共 {detailData.pagination.total} 条，第 {detailData.pagination.page}/{detailData.pagination.totalPages} 页
                </span>
              )}
            </div>
            {detailData && detailData.rows.length === 0 ? (
              <p className="text-gray-500 text-sm">无匹配记录</p>
            ) : detailData && (
              <>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#0f111a] sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs text-gray-500">时间</th>
                        <th className="px-3 py-2 text-left text-xs text-gray-500">用户</th>
                        <th className="px-3 py-2 text-left text-xs text-gray-500">模型</th>
                        <th className="px-3 py-2 text-left text-xs text-gray-500">动作</th>
                        <th className="px-3 py-2 text-right text-xs text-gray-500">积分</th>
                        <th className="px-3 py-2 text-center text-xs text-gray-500">状态</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {detailData.rows.map(r => (
                        <tr key={r.id} className="hover:bg-[#0f111a]/50">
                          <td className="px-3 py-2 text-gray-400 text-xs font-mono">{formatDateTime(r.created_at)}</td>
                          <td className="px-3 py-2 text-xs">
                            {r.name
                              ? <><span className="text-white">{r.name}</span><span className="text-gray-500"> ({r.email})</span></>
                              : <span className="text-gray-500">- ({r.email})</span>
                            }
                          </td>
                          <td className="px-3 py-2 text-gray-400 text-xs">{r.model}</td>
                          <td className="px-3 py-2 text-gray-400 text-xs">
                            {r.concurrent_id ? `${r.action} (批量)` : r.action}
                          </td>
                          <td className="px-3 py-2 text-right text-purple-400 text-xs font-mono">
                            {r.concurrent_id && r.batch_total_credits != null && r.unit_credits != null && r.batch_count != null
                              ? `${r.batch_total_credits} (${r.unit_credits}×${r.batch_count})`
                              : r.credits_cost
                            }
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${r.status === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{r.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {detailData.pagination.totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-4">
                    <button disabled={detailData.pagination.page <= 1} onClick={() => loadDetails(detailData.pagination.page - 1)}
                      className="btn-page">上一页</button>
                    <span className="text-xs text-gray-400">{detailData.pagination.page} / {detailData.pagination.totalPages}</span>
                    <button disabled={detailData.pagination.page >= detailData.pagination.totalPages} onClick={() => loadDetails(detailData.pagination.page + 1)}
                      className="btn-page">下一页</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 小组汇总 */}
        {tab === '小组汇总' && !loadingPanel && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-300">
                {groupDrill ? (
                  <span>小组 <b className="text-purple-400">{groupDrill.group}</b> 的用户明细
                    <button onClick={() => setGroupDrill(null)} className="ml-2 text-xs text-gray-500 hover:text-white">← 返回汇总</button>
                  </span>
                ) : '按小组积分消耗汇总'}
              </h3>
              {!groupDrill && (
                <select value={groupDays} onChange={e => { setGroupDays(Number(e.target.value)); setLoadingPanel('小组汇总'); fetchGroupSummary(Number(e.target.value)).then(d => setGroupData(d as any[])).catch(() => {}).finally(() => setLoadingPanel('')); }}
                  className="px-3 py-1 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs">
                  <option value={1}>近1天</option>
                  <option value={7}>近7天</option>
                  <option value={30}>近30天</option>
                </select>
              )}
            </div>
            {groupDrill ? (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">用户</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">消耗积分</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">调用次数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {groupDrill.data.map((r: any) => (
                      <tr key={r.id} className="hover:bg-[#0f111a]/50">
                        <td className="px-4 py-2 text-white">{r.name || r.email}</td>
                        <td className="px-4 py-2 text-right text-purple-400 font-mono">{r.total_credits}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{r.call_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">小组</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">用户数</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">消耗积分</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">调用次数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {groupData.map((g, i) => (
                      <tr key={i} className="hover:bg-[#0f111a]/50 cursor-pointer" onClick={() => drillGroup(g.department)}>
                        <td className="px-4 py-2 text-purple-400 hover:underline">{g.department || '未设置'}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{g.user_count}</td>
                        <td className="px-4 py-2 text-right text-white font-mono">{g.total_credits}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{g.call_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 项目组消耗 */}
        {tab === '项目组消耗' && !loadingPanel && (
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">项目组资源消耗排行（近30天）</h3>
            {projectData.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无数据</p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">#</th>
                      <th className="px-4 py-2 text-left text-xs text-gray-500">项目组</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">用户数</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">任务数</th>
                      <th className="px-4 py-2 text-right text-xs text-gray-500">消耗积分</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {projectData.map((p, i) => (
                      <tr key={p.id} className="hover:bg-[#0f111a]/50">
                        <td className="px-4 py-2 text-gray-500">{i + 1}</td>
                        <td className="px-4 py-2 text-white">{p.name}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{p.user_count}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{p.task_count}</td>
                        <td className="px-4 py-2 text-right text-purple-400 font-mono">{p.total_credits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 失败分析 */}
        {tab === '失败分析' && !loadingPanel && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-300">失败任务分析</h3>
              <select value={failureDays} onChange={e => { const v = Number(e.target.value); setFailureDays(v); setLoadingPanel('失败分析'); fetchFailureAnalysis(v, dimension === 'department' ? currentUser?.department_id : undefined).then(setFailureData).catch(() => {}).finally(() => setLoadingPanel('')); }}
                className="px-3 py-1 bg-[#0f111a] border border-gray-700 rounded-lg text-white text-xs">
                <option value={7}>近7天</option>
                <option value={30}>近30天</option>
                <option value={0}>所有</option>
              </select>
            </div>
            {failureData.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无失败记录</p>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#0f111a] sticky top-0">
                     <tr>
                       <th className="px-4 py-2 text-left text-xs text-gray-500">类别</th>
                       <th className="px-4 py-2 text-left text-xs text-gray-500">错误信息</th>
                       <th className="px-4 py-2 text-right text-xs text-gray-500">失败次数</th>
                       <th className="px-4 py-2 text-right text-xs text-gray-500">损失积分</th>
                     </tr>
                   </thead>
                   <tbody className="divide-y divide-gray-800">
                     {failureData.map((f, i) => (
                       <tr key={i} className="hover:bg-[#0f111a]/50">
                         <td className="px-4 py-2 text-white">{f.action}</td>
                         <td className="px-4 py-2 text-red-400 text-xs max-w-xs truncate">{f.error_message || '-'}</td>
                         <td className="px-4 py-2 text-right text-red-400 font-mono">{f.fail_count}</td>
                         <td className="px-4 py-2 text-right text-red-400 font-mono">{f.wasted_credits}</td>
                       </tr>
                     ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 用户活跃度 */}
        {tab === '用户活跃度' && !loadingPanel && activityData && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">每日活跃用户数（近30天）</h3>
              <BarChart data={activityData.dailyActive} />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">
                休眠用户（近30天无操作）
                <span className="ml-2 text-xs text-gray-500">共 {activityData.dormant.length} 人</span>
              </h3>
              {activityData.dormant.length === 0 ? (
                <p className="text-gray-500 text-sm">无休眠用户</p>
              ) : (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#0f111a] sticky top-0">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs text-gray-500">用户</th>
                        <th className="px-4 py-2 text-left text-xs text-gray-500">小组</th>
                        <th className="px-4 py-2 text-left text-xs text-gray-500">最后活跃</th>
                        <th className="px-4 py-2 text-left text-xs text-gray-500">注册时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {activityData.dormant.map((u: any) => (
                        <tr key={u.id} className="hover:bg-[#0f111a]/50">
                          <td className="px-4 py-2 text-white">{u.name || u.email}</td>
                          <td className="px-4 py-2 text-gray-400">{u.department || '-'}</td>
                          <td className="px-4 py-2 text-amber-400 text-xs">{u.last_active ? formatDateTime(u.last_active) : '从未活跃'}</td>
                          <td className="px-4 py-2 text-gray-400 text-xs">{formatDateTime(u.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}