// 关联图片弹窗 — 展示当前项目 image_records 中 status != 'error' 的生成历史
// image_records.id ↔ canvas_clothses_assets.id_of_resource
import { useEffect, useState, useCallback } from 'react';
import { Loader2, ImageIcon, X } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';

interface ImageRecord {
  id: number;
  user_id: number;
  project_id: number;
  prompt: string;
  model: string;
  size_label: string;
  result_urls: string[];
  status: string;
  created_at: string;
}

interface ImageAssociateModalProps {
  open: boolean;
  projectId: number;
  onClose: () => void;
  onSelect: (record: ImageRecord) => void;
  theme?: {
    bg: string;
    panel: string;
    panelBorder: string;
    nodeFill: string;
    nodeText: string;
    nodeMuted: string;
    nodeFaint: string;
  };
}

export function ImageAssociateModal({ open, projectId, onClose, onSelect, theme }: ImageAssociateModalProps) {
  const [records, setRecords] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const t = theme || {
    bg: '#181715',
    panel: 'rgba(31,29,26,.96)',
    panelBorder: '#44403c',
    nodeFill: '#292524',
    nodeText: '#f5f5f4',
    nodeMuted: '#d6d3d1',
    nodeFaint: '#78716c',
  };

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/image-records?projectId=${projectId}&pageSize=100`, {
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (data.success && data.data?.records) {
        // 过滤掉 status 为 error 的记录
        const filtered = (data.data.records as ImageRecord[]).filter(
          (r) => r.status !== 'error'
        );
        setRecords(filtered);
      } else {
        setError(data.error || '加载失败');
      }
    } catch {
      setError('网络请求失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      fetchRecords();
      setSelectedId(null);
    }
  }, [open, fetchRecords]);

  const handleSelect = (record: ImageRecord) => {
    setSelectedId(record.id);
    onSelect(record);
    onClose();
  };

  const thumbUrl = (record: ImageRecord) => {
    return record.result_urls?.[0] || null;
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={onClose}
    >
      {/* 半透明遮罩 */}
      <div
        className="absolute inset-0 animate-[fadeIn_0.2s_ease-out]"
        style={{ background: 'rgba(0,0,0,.45)' }}
      />

      {/* Modal 面板 */}
      <div
        className="relative w-[560px] max-h-[80vh] flex flex-col rounded-2xl border shadow-2xl animate-[modalZoomIn_0.3s_cubic-bezier(0.23,1,0.32,1)]"
        style={{
          background: t.panel,
          borderColor: t.panelBorder,
          color: t.nodeText,
          backdropFilter: 'blur(24px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <span className="text-base font-semibold">关联图片</span>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg transition hover:bg-white/10"
            style={{ color: t.nodeMuted }}
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-5 pb-1 text-xs" style={{ color: t.nodeFaint }}>
          选择当前项目中的图片生成记录
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-3 thin-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center py-16" style={{ color: t.nodeMuted }}>
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16" style={{ color: t.nodeMuted }}>
              <span className="text-sm">{error}</span>
              <button
                onClick={fetchRecords}
                className="text-xs underline hover:opacity-80"
                style={{ color: t.nodeText }}
              >
                重试
              </button>
            </div>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16" style={{ color: t.nodeMuted }}>
              <ImageIcon className="size-10 opacity-30" />
              <span className="text-sm">暂无图片生成记录</span>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {records.map((record) => {
                const url = thumbUrl(record);
                return (
                  <button
                    key={record.id}
                    type="button"
                    className="relative aspect-square overflow-hidden rounded-xl border transition-all hover:scale-[1.03] active:scale-95"
                    style={{
                      borderColor: selectedId === record.id ? '#7c3aed' : t.panelBorder,
                      boxShadow: selectedId === record.id ? '0 0 0 2px #7c3aed40' : undefined,
                      background: t.nodeFill,
                    }}
                    onClick={() => handleSelect(record)}
                    title={record.prompt}
                  >
                    {url ? (
                      <img
                        src={url}
                        alt={record.prompt}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center" style={{ color: t.nodeFaint }}>
                        <ImageIcon className="size-6 opacity-40" />
                      </div>
                    )}
                    {/* 底部 prompt 标签 */}
                    <div
                      className="absolute bottom-0 left-0 right-0 truncate px-1.5 py-1 text-[10px] leading-tight"
                      style={{
                        background: `linear-gradient(to top, ${t.panel}, transparent)`,
                        color: t.nodeText,
                      }}
                    >
                      {record.prompt}
                    </div>
                    {/* 生成中遮罩 */}
                    {record.status === 'pending' || record.status === 'generating' ? (
                      <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.35)' }}>
                        <Loader2 className="size-4 animate-spin" style={{ color: t.nodeText }} />
                      </div>
                    ) : null}
                    {/* 选中勾号 */}
                    {selectedId === record.id && (
                      <div
                        className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full"
                        style={{ background: '#7c3aed', color: '#fff' }}
                      >
                        <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 text-xs text-right" style={{ color: t.nodeFaint }}>
          {records.length} 条记录
        </div>
      </div>
    </div>
  );
}

