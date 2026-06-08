import { useState, useEffect, useMemo } from 'react';
import { getAuthHeaders } from '../services/authService';

interface ProjectStats {
  id: number;
  name: string;
  created_at: string;
  participant_count: number;
  task_count: number;
  total_credits: number;
}

interface TimelinePoint {
  project_id: number;
  date_label: string;
  credits: number;
}

interface ProjectTimelineData {
  projects: ProjectStats[];
  timeline: TimelinePoint[];
}

type SortKey = 'name' | 'created_at' | 'participant_count' | 'task_count' | 'total_credits';
type Granularity = 'day' | 'week';

function ProjectLineChart({ project, timeline, granularity }: {
  project: ProjectStats;
  timeline: { date_label: string; credits: number }[];
  granularity: Granularity;
}) {
  // 填充日期缺口：按天模式下，空缺日期补 0
  const points = (() => {
    if (timeline.length === 0) return [];
    const sorted = [...timeline].sort((a, b) => a.date_label.localeCompare(b.date_label));
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
      <div className="flex-1 min-h-[240px] flex items-center justify-center text-gray-500 text-sm">
        暂无消耗数据
      </div>
    );
  }

  const W = 400, H = 220, P = 34, BW = W - 2 * P, BH = H - 2 * P;
  const maxV = Math.max(1, ...points.map(d => d.credits));
  const coords = points.map((d, i) => {
    const x = P + (i / Math.max(1, points.length - 1)) * BW;
    const y = P + BH - (d.credits / maxV) * BH;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div className="flex-1 min-w-[320px]">
      <div className="mb-2">
        <div className="text-lg font-bold text-white leading-tight break-all">
          {project.name}
        </div>
        <div className="flex gap-3 text-sm text-gray-300 mt-1">
          <span title="参与人数">人数 {project.participant_count}</span>
          <span title="任务数">任务数 {project.task_count}</span>
          <span title="消耗积分">消耗积分 {project.total_credits}</span>
        </div>
      </div>
      <div className="bg-[#1c1f2e] border border-gray-800 rounded-lg p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id={`grad-${project.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(168,85,247)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="rgb(168,85,247)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map(r => (
            <line key={r} x1={P} y1={P + BH * (1 - r)} x2={P + BW} y2={P + BH * (1 - r)}
              stroke="#374151" strokeWidth="0.5" />
          ))}
          <polygon points={`${P},${P + BH} ${coords} ${P + BW},${P + BH}`} fill={`url(#grad-${project.id})`} />
           <polyline points={coords} fill="none" stroke="rgb(168,85,247)" strokeWidth="1.2" strokeLinejoin="round" />
           {points.map((d, i) => {
              const x = P + (i / Math.max(1, points.length - 1)) * BW;
              const y = P + BH - (d.credits / maxV) * BH;
              const label = granularity === 'week' ? d.date_label.replace(/^\d{4}-W/, '') : d.date_label.slice(5);
              const maxLabels = 10;
              const step = Math.max(1, Math.ceil(points.length / maxLabels));
              const showLabel = points.length <= maxLabels || i % step === 0 || i === points.length - 1;
              return (
                <g key={i}>
                  {showLabel && <text x={x} y={H - 4} textAnchor="middle" fill="#4b5563" fontSize="6">{label}</text>}
                  <text x={x} y={y - 6} textAnchor="middle" fill="rgb(192,132,252)" fontSize="5" fontWeight="bold">{d.credits}</text>
                </g>
              );
            })}
        </svg>
      </div>
    </div>
  );
}

export default function ProjectConsumptionPanel() {
  const [data, setData] = useState<ProjectTimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [granularity, setGranularity] = useState<Granularity>('day');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/admin/credits/project-timeline?granularity=${granularity}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { if (d.success) setData(d.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [granularity]);

  const sortedProjects = useMemo(() => {
    if (!data?.projects) return [];
    const sorted = [...data.projects];
    switch (sortKey) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        break;
      case 'created_at':
        sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        break;
      case 'participant_count':
        sorted.sort((a, b) => b.participant_count - a.participant_count);
        break;
      case 'task_count':
        sorted.sort((a, b) => b.task_count - a.task_count);
        break;
      case 'total_credits':
        sorted.sort((a, b) => b.total_credits - a.total_credits);
        break;
    }
    return sorted;
  }, [data, sortKey]);

  if (loading) {
    return <div className="p-8 text-center text-gray-400">加载中...</div>;
  }

  if (!data || data.projects.length === 0) {
    return <div className="p-8 text-center text-gray-400">暂无项目消耗数据</div>;
  }

  return (
    <div>
      {/* 控制栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={sortKey}
          onChange={e => setSortKey(e.target.value as SortKey)}
          className="px-3 py-1.5 bg-[#1c1f2e] border border-gray-700 rounded text-sm text-white"
        >
          <option value="name">按项目名 ↑</option>
          <option value="created_at">按创建时间 ↓</option>
          <option value="participant_count">按参与人数 ↓</option>
          <option value="task_count">按任务数 ↓</option>
          <option value="total_credits">按消耗积分 ↓</option>
        </select>
        <div className="flex bg-[#1c1f2e] border border-gray-700 rounded overflow-hidden">
          <button
            onClick={() => setGranularity('day')}
            className={`px-3 py-1.5 text-sm ${granularity === 'day'
              ? 'bg-purple-600 text-white'
              : 'text-gray-400 hover:text-white'}`}
          >按天</button>
          <button
            onClick={() => setGranularity('week')}
            className={`px-3 py-1.5 text-sm ${granularity === 'week'
              ? 'bg-purple-600 text-white'
              : 'text-gray-400 hover:text-white'}`}
          >按周</button>
        </div>
      </div>

      {/* 折线图网格：一行2个 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {sortedProjects.map(project => (
          <ProjectLineChart
            key={project.id}
            project={project}
            timeline={(data.timeline || [])
              .filter(t => t.project_id === project.id)
              .sort((a, b) => a.date_label.localeCompare(b.date_label))}
            granularity={granularity}
          />
        ))}
      </div>
    </div>
  );
}
