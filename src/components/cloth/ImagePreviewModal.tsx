// 图片大图预览 — 复刻原项目 Modal "图片详情"
import { X } from 'lucide-react';

interface ImagePreviewModalProps {
  open: boolean;
  url: string | null;
  onClose: () => void;
}

export function ImagePreviewModal({ open, url, onClose }: ImagePreviewModalProps) {
  if (!open || !url) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center"
      onClick={onClose}
    >
      {/* 遮罩 */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,.45)' }}
      />

      {/* 弹窗 — width:auto, 居中 */}
      <div
        className="relative rounded-2xl shadow-2xl overflow-hidden animate-[modalZoomIn_0.3s_cubic-bezier(0.23,1,0.32,1)]"
        style={{ background: '#1a1a1a' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3.5">
          <span className="text-base font-semibold" style={{ color: 'rgba(255,255,255,.85)' }}>图片详情</span>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg transition hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,.45)' }}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 图片区 — 复刻原项目 body style */}
        <div
          style={{
            padding: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            maxHeight: '80vh',
          }}
        >
          <img
            src={url}
            alt="图片"
            style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain' }}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
