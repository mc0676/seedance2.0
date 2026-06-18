// 视频关联弹窗 — 双栏：左侧 Seedance 视频生成记录，右侧 HappyHorse 记录
import { useState, useEffect, useCallback } from 'react';
import { getAuthHeaders } from '../../services/authService';

interface VideoAssociateModalProps {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  onSelect: (record: { id: number; video_url: string; prompt: string; model: string; source: 'seedance' | 'happyhorse' }) => void;
  theme?: {
    bg: string; panel: string; panelBorder: string; nodeFill: string;
    nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

interface VideoRecord {
  id: number;
  prompt: string;
  model: string;
  video_url: string;
  status: string;
  created_at: string;
}

export function VideoAssociateModal({ open, projectId, onClose, onSelect, theme }: VideoAssociateModalProps) {
  const t = theme || {
    bg: '#181715', panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c',
    nodeFill: '#292524', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [seedanceRecords, setSeedanceRecords] = useState<VideoRecord[]>([]);
  const [happyhorseRecords, setHappyhorseRecords] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRecords = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      // Seedance: 通过项目任务接口拉取
      if (projectId) {
        const sRes = await fetch(`/api/projects/${projectId}/tasks?status=done&taskKind=video&pageSize=50`, { headers: getAuthHeaders() });
        const sData = await sRes.json();
        if (sData.success && sData.data) {
          const tasks = (Array.isArray(sData.data) ? sData.data : []).filter(
            (r: any) => r.task_video_url || r.video_url
          );
          setSeedanceRecords(tasks.map((r: any) => ({
            id: r.id,
            prompt: r.prompt || '',
            model: r.model || 'seedance',
            video_url: r.task_video_url || r.video_url || '',
            status: r.status,
            created_at: r.created_at,
          })));
        }
      }
      // HappyHorse: /api/happyhorse-tasks 返回 data.items
      const hUrl = projectId
        ? `/api/happyhorse-tasks?projectId=${projectId}&pageSize=50`
        : '/api/happyhorse-tasks?pageSize=50';
      const hRes = await fetch(hUrl, { headers: getAuthHeaders() });
      const hData = await hRes.json();
      if (hData.success && hData.data) {
        const items = hData.data.items || hData.data || [];
        const tasks = items.filter(
          (r: any) => (r.task_status === 'SUCCEEDED' || r.status === 'done' || r.status === 'SUCCEEDED') && (r.video_url || r.task_video_url)
        );
        setHappyhorseRecords(tasks.map((r: any) => ({
          id: r.id,
          prompt: r.prompt || '',
          model: r.model || 'happyhorse',
          video_url: r.video_url || r.task_video_url || '',
          status: r.task_status || r.status,
          created_at: r.created_at,
        })));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [open, projectId]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  if (!open) return null;

  const RecordCard = ({ record, source }: { record: VideoRecord; source: 'seedance' | 'happyhorse' }) => (
    <button
      className="flex flex-col gap-1 rounded-xl border p-2 text-left transition hover:opacity-80"
      style={{ background: t.nodeFill, borderColor: t.panelBorder }}
      onClick={() => onSelect({ id: record.id, video_url: record.video_url, prompt: record.prompt, model: record.model, source })}
    >
      <video
        src={record.video_url}
        className="aspect-video w-full rounded-lg bg-black object-cover"
        muted
        preload="metadata"
      />
      <div className="text-[11px] leading-tight truncate" style={{ color: t.nodeText }}>{record.prompt || '(无提示词)'}</div>
      <div className="text-[10px]" style={{ color: t.nodeFaint }}>{record.model}</div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,.55)' }} />
      <div
        className="relative z-10 flex max-h-[85vh] w-[900px] max-w-[95vw] flex-col rounded-3xl border shadow-2xl"
        style={{ background: t.bg, borderColor: t.panelBorder, color: t.nodeText }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: t.panelBorder }}>
          <h2 className="text-base font-semibold">关联视频</h2>
          <button onClick={onClose} className="text-lg leading-none opacity-50 hover:opacity-80">&times;</button>
        </div>

        {/* Dual column body */}
        <div className="flex-1 overflow-hidden flex divide-x" style={{ divideColor: t.panelBorder }}>
          {/* Left: Seedance */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-4 py-2 text-xs font-medium" style={{ color: t.nodeMuted }}>视频生成</div>
            <div className="flex-1 overflow-y-auto px-4 pb-4 thin-scrollbar">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm" style={{ color: t.nodeFaint }}>加载中...</div>
              ) : seedanceRecords.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm" style={{ color: t.nodeFaint }}>暂无记录</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {seedanceRecords.map((r) => <RecordCard key={`s-${r.id}`} record={r} source="seedance" />)}
                </div>
              )}
            </div>
          </div>

          {/* Right: HappyHorse */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-4 py-2 text-xs font-medium" style={{ color: t.nodeMuted }}>HappyHorse</div>
            <div className="flex-1 overflow-y-auto px-4 pb-4 thin-scrollbar">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-sm" style={{ color: t.nodeFaint }}>加载中...</div>
              ) : happyhorseRecords.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm" style={{ color: t.nodeFaint }}>暂无记录</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {happyhorseRecords.map((r) => <RecordCard key={`h-${r.id}`} record={r} source="happyhorse" />)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
