// 音频关联弹窗 — 列出当前项目音频生成记录
import { useState, useEffect, useCallback } from 'react';
import { Music2 } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';

interface AudioAssociateModalProps {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  onSelect: (record: { id: number; audio_url: string; voice_prompt: string }) => void;
  theme?: {
    bg: string; panel: string; panelBorder: string; nodeFill: string;
    nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

interface AudioRecord {
  id: number;
  voice_prompt: string;
  intermediate_video_url: string;
  status: string;
  created_at: string;
}

export function AudioAssociateModal({ open, projectId, onClose, onSelect, theme }: AudioAssociateModalProps) {
  const t = theme || {
    bg: '#181715', panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c',
    nodeFill: '#292524', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [records, setRecords] = useState<AudioRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchRecords = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: '50' });
      if (projectId) params.set('projectId', String(projectId));
      const res = await fetch(`/api/audio-generations/list?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.data?.items) {
        const items = (data.data.items as any[]).filter(
          (r: any) => r.status === 'done' && r.intermediate_video_url
        );
        setRecords(items.map((r: any) => ({
          id: r.id,
          voice_prompt: r.voice_prompt || '',
          intermediate_video_url: r.intermediate_video_url,
          status: r.status,
          created_at: r.created_at,
        })));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [open, projectId]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,.55)' }} />
      <div
        className="relative z-10 flex max-h-[85vh] w-[600px] max-w-[95vw] flex-col rounded-3xl border shadow-2xl"
        style={{ background: t.bg, borderColor: t.panelBorder, color: t.nodeText }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: t.panelBorder }}>
          <h2 className="text-base font-semibold">关联音频</h2>
          <button onClick={onClose} className="text-lg leading-none opacity-50 hover:opacity-80">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12" style={{ color: t.nodeMuted }}>
              <div className="size-6 animate-spin rounded-full border-2 border-transparent" style={{ borderTopColor: t.nodeMuted }} />
            </div>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16" style={{ color: t.nodeMuted }}>
              <Music2 className="size-10 opacity-30" />
              <span className="text-sm">暂无音频生成记录</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {records.map((record) => (
                <button
                  key={record.id}
                  className="flex flex-col gap-2 rounded-xl border p-3 text-left transition hover:opacity-80"
                  style={{ background: t.nodeFill, borderColor: t.panelBorder }}
                  onClick={() => onSelect({ id: record.id, audio_url: record.intermediate_video_url, voice_prompt: record.voice_prompt })}
                >
                  <div className="flex items-start gap-2">
                    <Music2 className="size-4 shrink-0 mt-0.5" style={{ color: t.nodeMuted }} />
                    <span className="text-[11px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: t.nodeText }}>
                      {record.voice_prompt || '(无提示词)'}
                    </span>
                  </div>
                  <div className="text-[10px]" style={{ color: t.nodeFaint }}>
                    {record.created_at ? new Date(record.created_at).toLocaleDateString() : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
