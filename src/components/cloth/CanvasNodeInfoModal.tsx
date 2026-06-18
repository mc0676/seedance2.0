// 复刻原项目 canvas-node-hover-toolbar.tsx CanvasNodeInfoModal
// 原项目使用 Ant Design Modal + Segmented，此处用纯 HTML/CSS 复刻视觉效果
import { useState, useEffect, useMemo, useRef } from 'react';
import { type Node } from '@xyflow/react';

interface CanvasNodeInfoModalProps {
  node: Node | null;
  open: boolean;
  onClose: () => void;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 12 }}>
      <span style={{ opacity: 0.5 }}>{label}</span>
      <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

export function CanvasNodeInfoModal({ node, open, onClose }: CanvasNodeInfoModalProps) {
  const [view, setView] = useState<'info' | 'json'>('info');
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);
  const savedNodeRef = useRef<Node | null>(null);

  useEffect(() => {
    if (open && node) {
      savedNodeRef.current = node;
      setVisible(true);
      requestAnimationFrame(() => setAnimating(true));
    } else if (!open) {
      setAnimating(false);
      const t = setTimeout(() => { setVisible(false); savedNodeRef.current = null; }, 200);
      return () => clearTimeout(t);
    }
  }, [open, node]);

  const displayNode = node ?? savedNodeRef.current;

  useEffect(() => {
    if (open) setView('info');
  }, [displayNode?.id, open]);

  const nodeType = (displayNode?.data as any)?.nodeType;
  const dbType = (displayNode?.data as any)?.dbType;
  const typeLabel =
    nodeType === 'script' ? '文本' :
    nodeType === 'image' ? '图片' :
    nodeType === 'video' ? '视频' :
    nodeType === 'audio' ? '音频' :
    dbType === 'config' ? '配置' : '增强';

  const json = useMemo(() => {
    if (!displayNode) return '';
    return JSON.stringify(
      { id: displayNode.id, type: displayNode.type, position: displayNode.position, width: displayNode.width, height: displayNode.height, data: displayNode.data },
      null,
      2,
    );
  }, [displayNode]);

  if (!visible) return null;

  const t = {
    bg: '#1f1f1f',
    border: '#333',
    text: 'rgba(255,255,255,0.85)',
    textSecondary: 'rgba(255,255,255,0.45)',
    fill: 'rgba(255,255,255,0.06)',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      {/* 遮罩 — antd 风格淡入 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,.45)',
          opacity: animating ? 1 : 0,
          transition: 'opacity 200ms ease',
        }}
      />
      {/* 面板 — antd Modal centered 风格：无 border，仅阴影 + 缩放动画 */}
      <div
        style={{
          position: 'relative',
          width: 480,
          maxWidth: 'calc(100vw - 48px)',
          margin: '0 24px',
          borderRadius: 8,
          background: t.bg,
          color: t.text,
          boxShadow: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12), 0 9px 28px 8px rgba(0,0,0,0.05)',
          transform: animating ? 'scale(1)' : 'scale(0.95)',
          opacity: animating ? 1 : 0,
          transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1), opacity 200ms ease',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 — Segmented 在标题内，原项目 title 属性 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0', gap: 16 }}>
          <span style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>节点信息</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Segmented size=small — antd 风格 */}
            <div style={{ display: 'flex', borderRadius: 6, background: t.fill, padding: 2 }}>
              <button
                type="button"
                onClick={() => setView('info')}
                style={{
                  padding: '1px 16px', height: 24, fontSize: 13, lineHeight: '22px',
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  background: view === 'info' ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: view === 'info' ? t.text : t.textSecondary,
                  transition: 'background 0.2s, color 0.2s',
                }}
              >
                信息
              </button>
              <button
                type="button"
                onClick={() => setView('json')}
                style={{
                  padding: '1px 16px', height: 24, fontSize: 13, lineHeight: '22px',
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  background: view === 'json' ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: view === 'json' ? t.text : t.textSecondary,
                  transition: 'background 0.2s, color 0.2s',
                }}
              >
                JSON
              </button>
            </div>
            {/* 关闭按钮 */}
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none', border: 'none', color: t.textSecondary, cursor: 'pointer',
                width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 4, padding: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
        {/* 内容区 */}
        <div style={{ padding: '20px 24px 24px', maxHeight: '56vh', minHeight: 320, overflow: 'auto' }}>
          {view === 'info' && displayNode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 14 }}>
              <InfoRow label="ID" value={displayNode.id} />
              <InfoRow label="类型" value={typeLabel} />
              <InfoRow label="尺寸" value={`${Math.round(displayNode.width ?? 260)} x ${Math.round(displayNode.height ?? 160)}`} />
              <InfoRow label="位置" value={`${Math.round(displayNode.position.x)}, ${Math.round(displayNode.position.y)}`} />
              {(displayNode.data as any)?.content ? <InfoRow label="内容" value={(displayNode.data as any).content} /> : null}
              {(displayNode.data as any)?.id_of_resource ? <InfoRow label="资源ID" value={String((displayNode.data as any).id_of_resource)} /> : null}
            </div>
          ) : (
            <pre
              style={{
                height: '100%', maxHeight: '56vh', minHeight: 320, overflow: 'auto',
                borderRadius: 8, border: `1px solid ${t.border}`, padding: 12,
                fontSize: 12, lineHeight: 1.6, background: t.fill, color: t.text,
                margin: 0, fontFamily: 'monospace',
              }}
            >
              {json}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
