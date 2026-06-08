import { useState, useEffect, useCallback } from 'react';
import { getAuthHeaders } from '../services/authService';

interface DeptInfo { id: number; name: string; memberCount: number; }
interface RankItem { id: number; name: string; email: string; total_credits: number; task_count: number; }
interface MemberInfo { id: number; name: string; email: string; total_credits: number; task_count: number; }
interface TimelinePoint { user_id: number; date_label: string; credits: number; }

type Granularity = 'day' | 'week';

function MemberLineChart({ member, timeline, granularity }: {
  member: MemberInfo;
  timeline: TimelinePoint[];
  granularity: Granularity;
}) {
  // 填充日期缺口
  const points = (() => {
    const filtered = timeline.filter(t => t.user_id === member.id);
    if (filtered.length === 0) return [];
    const sorted = [...filtered].sort((a, b) => a.date_label.localeCompare(b.date_label));
    if (granularity === 'day' && sorted.length >= 2) {
      const map = new Map(sorted.map(t => [t.date_label, t.credits]));
      const filled: { date_label: string; credits: number }[] = [];
      const start = new Date(sorted[0].date_label);
      const end = new Date(sorted[sorted.length - 1].date_label);
      const cursor = new Date(start);
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        filled.push({ date_label: key, credits: map.get(key) ?? 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
      return filled;
    }
    return sorted;
  })();

  if (points.length === 0) {
    return (
      <div className="flex-1 min-h-[200px] flex items-center justify-center text-gray-500 text-xs">
        {member.name} 暂无消耗数据
      </div>
    );
  }

  const W = 400, H = 180, P = 30, BW = W - 2 * P, BH = H - 2 * P;
  const maxV = Math.max(1, ...points.map(d => d.credits));
  const coords = points.map((d, i) => {
    const x = P + (i / Math.max(1, points.length - 1)) * BW;
    const y = P + BH - (d.credits / maxV) * BH;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="flex-1 min-w-[300px]">
      <div className="mb-1">
        <div className="text-sm font-semibold text-gray-200">{member.name}</div>
        <div className="flex gap-3 text-xs text-gray-400">
          <span>任务 {member.task_count}</span>
          <span>消耗 {member.total_credits}</span>
        </div>
      </div>
      <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id={`tgrad-${member.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(99,102,241)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="rgb(99,102,241)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map(r => (
            <line key={r} x1={P} y1={P + BH * (1 - r)} x2={P + BW} y2={P + BH * (1 - r)}
              stroke="#374151" strokeWidth="0.5" />
          ))}
          <polygon points={`${P},${P + BH} ${coords} ${P + BW},${P + BH}`} fill={`url(#tgrad-${member.id})`} />
          <polyline points={coords} fill="none" stroke="rgb(99,102,241)" strokeWidth="1.2" strokeLinejoin="round" />
          {points.map((d, i) => {
            const x = P + (i / Math.max(1, points.length - 1)) * BW;
            const y = P + BH - (d.credits / maxV) * BH;
            const label = granularity === 'week' ? d.date_label.replace(/^\d{4}-W/, '') : d.date_label.slice(5);
            const maxLabels = 8;
            const step = Math.max(1, Math.ceil(points.length / maxLabels));
            const showLabel = points.length <= maxLabels || i % step === 0 || i === points.length - 1;
            return (
              <g key={i}>
                {showLabel && <text x={x} y={H - 4} textAnchor="middle" fill="#4b5563" fontSize="5">{label}</text>}
                <text x={x} y={y - 5} textAnchor="middle" fill="rgb(165,180,252)" fontSize="4" fontWeight="bold">{d.credits}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export default function TeamConsumptionPanel() {
  const [dept, setDept] = useState<DeptInfo | null>(null);
  const [ranking, setRanking] = useState<RankItem[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [granularity, setGranularity] = useState<Granularity>('day');
  const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const [selDate, setSelDate] = useState(new Date());

  const loadRanking = useCallback(async (d: Date) => {
    const ds = toDateStr(d);
    const res = await fetch(`/api/admin/credits/team-ranking?date=${ds}`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (data.success) {
      setDept(data.data.dept);
      setRanking(data.data.ranking || []);
    }
  }, []);

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/admin/credits/team-timeline?granularity=${granularity}`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (data.success) {
      setDept(data.data.dept);
      setMembers(data.data.members || []);
      setTimeline(data.data.timeline || []);
    }
    setLoading(false);
  }, [granularity]);

  useEffect(() => { loadRanking(selDate); }, [selDate, loadRanking]);
  useEffect(() => { loadTimeline(); }, [loadTimeline]);

  const changeDay = (delta: number) => {
    const d = new Date(selDate);
    d.setDate(d.getDate() + delta);
    setSelDate(d);
  };

  if (loading) return <div className="p-8 text-center text-gray-400">加载中...</div>;
  if (!dept) return <div className="p-8 text-center text-gray-400">未分配小组</div>;

  return (
    <div>
      {/* 小组名称 + 人数 */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-lg font-bold text-white">{dept.name}</span>
        <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 text-sm font-medium border border-purple-500/30">
          {dept.memberCount} 人
        </span>
      </div>

      {/* 当日排名 + 日期选择器 */}
      <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">当日消耗排名</h3>
          <div className="flex items-center bg-[#1c1f2e] border border-gray-700 rounded overflow-hidden">
            <button onClick={() => setSelDate(new Date())} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white hover:bg-[#25293d] transition-colors">今天</button>
            <span className="w-px bg-gray-700" />
            <button onClick={() => changeDay(-1)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-[#25293d] transition-colors">←</button>
            <span className="w-px bg-gray-700" />
            <input
              type="date"
              value={toDateStr(selDate)}
              onChange={e => {
                if (e.target.value) {
                  const [y, m, d] = e.target.value.split('-').map(Number);
                  setSelDate(new Date(y, m - 1, d));
                }
              }}
              className="px-3 py-1.5 text-sm text-gray-200 bg-[#0f111a] border-0 outline-none cursor-pointer [color-scheme:dark]"
            />
            <span className="w-px bg-gray-700" />
            <button onClick={() => changeDay(1)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-[#25293d] transition-colors">→</button>
          </div>
        </div>
        {ranking.length === 0 ? (
          <div className="text-gray-500 text-sm py-4 text-center">当日无消耗记录</div>
        ) : (
          <div className="space-y-1.5">
            {ranking.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-[#25293d]">
                <div className="flex items-center gap-3">
                  <span className="text-gray-500 w-6 text-right">{i + 1}</span>
                  <span className="text-gray-200">{r.name}</span>
                  <span className="text-gray-500 text-xs">{r.task_count} 任务</span>
                </div>
                <span className="text-purple-300 font-medium">{r.total_credits} 积分</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 折线图区域 */}
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-semibold text-gray-300">个人消耗趋势</h3>
        <div className="flex bg-[#1c1f2e] border border-gray-700 rounded overflow-hidden">
          <button onClick={() => setGranularity('day')}
            className={`px-2.5 py-1 text-xs ${granularity === 'day' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}>按天</button>
          <button onClick={() => setGranularity('week')}
            className={`px-2.5 py-1 text-xs ${granularity === 'week' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'}`}>按周</button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {members.map(m => (
          <MemberLineChart key={m.id} member={m} timeline={timeline} granularity={granularity} />
        ))}
      </div>
    </div>
  );
}
