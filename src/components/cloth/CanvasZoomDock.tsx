// 移植自 infinite-canvas 的 setZoomScale / resetViewport
// 核心逻辑：直接通过 setViewport() 设定精确的 x/y/zoom，而非依赖 zoomIn/zoomOut 步进。
// 工具提示使用与 CanvasToolbar 相同的统一 hover 状态模式，避免快速划过残留。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useReactFlow, useOnViewportChange, useStore } from '@xyflow/react';

interface ZoomDockTheme {
  panel: string;
  panelBorder: string;
  nodeFill: string;
  nodeText: string;
  nodeMuted: string;
}

const DARK: ZoomDockTheme = {
  panel: 'rgba(31,29,26,.96)',
  panelBorder: '#44403c',
  nodeFill: '#292524',
  nodeText: '#f5f5f4',
  nodeMuted: '#d6d3d1',
};

interface CanvasZoomDockProps {
  theme?: ZoomDockTheme;
  isMiniMapOpen: boolean;
  onToggleMiniMap: () => void;
  onShortcutsOpen: () => void;
}

/* ══════════ 工具提示按钮（与 CanvasToolbar ToolbarBtn 模式一致） ══════════ */

function ZoomBtn({
  id, active, wrapRef, onHover, onTip, onClick, children, label,
  nodeFill, nodeText, nodeMuted, activeBg,
}: {
  id: string; active?: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onHover: (id: string | null) => void; onTip: (x: number) => void;
  onClick?: () => void; children: ReactNode; label: string;
  nodeFill: string; nodeText: string; nodeMuted: string; activeBg: string;
}) {
  const hoveredColor = { background: nodeFill, color: nodeText };
  const defaultColor = active ? { background: activeBg, color: nodeText } : { color: nodeMuted };
  return (
    <button
      aria-label={label}
      className="grid size-8 place-items-center rounded-md transition-colors bg-transparent border-0 outline-none cursor-pointer"
      style={defaultColor}
      onMouseEnter={(e) => { onHover(id); onTip(getTipX(wrapRef.current, e.currentTarget)); if (!active) Object.assign(e.currentTarget.style, hoveredColor); }}
      onMouseLeave={(e) => { onHover(null); if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = nodeMuted; } }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
  if (!wrap) return 0;
  const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  return box.left - wrapBox.left + box.width / 2;
}

/* ══════════ 主组件 ══════════ */

export function CanvasZoomDock({ theme, isMiniMapOpen, onToggleMiniMap, onShortcutsOpen }: CanvasZoomDockProps) {
  const C = theme || DARK;
  const { setViewport, getViewport } = useReactFlow();
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tipX, setTipX] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const storeW = useStore((s) => s.width);
  const storeH = useStore((s) => s.height);
  const sizeRef = useRef({ w: storeW || 1200, h: storeH || 720 });
  sizeRef.current = { w: storeW || sizeRef.current.w, h: storeH || sizeRef.current.h };

  useOnViewportChange({
    onChange: useCallback((vp: { zoom: number }) => {
      setZoom((prev) => (Math.abs(vp.zoom - prev) > 0.002 ? vp.zoom : prev));
    }, []),
  });

  const getSize = useCallback(() => sizeRef.current, []);

  const zoomTo = useCallback(
    (target: number, duration = 200) => {
      const s = Math.min(Math.max(target, 0.05), 5);
      const cur = getViewport();
      const { w, h } = getSize();
      const cx = (w / 2 - cur.x) / cur.zoom;
      const cy = (h / 2 - cur.y) / cur.zoom;
      setViewport({ x: w / 2 - cx * s, y: h / 2 - cy * s, zoom: s }, { duration });
      setZoom(s);
    },
    [getViewport, setViewport, getSize],
  );

  const reset = useCallback(() => {
    const { w, h } = getSize();
    setViewport({ x: w / 2, y: h / 2, zoom: 1 }, { duration: 300 });
    setZoom(1);
  }, [setViewport, getSize]);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !storeW || !storeH) return;
    didInit.current = true;
    setViewport({ x: storeW / 2, y: storeH / 2, zoom: 1 });
    setZoom(1);
  }, [storeW, storeH, setViewport]);

  const LABELS: Record<string, string> = {
    'zoom-compass': isMiniMapOpen ? '关闭小地图' : '打开小地图',
    'zoom-reset': '重置视图',
    'zoom-slider': '缩放画布',
    'zoom-shortcuts': '快捷键',
  };

  return (
    <div className="absolute bottom-5 left-5 z-50"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 统一工具提示 —— 与 CanvasToolbar 颜色完全一致：亮底暗字 */}
      {hovered ? (
        <span
          className="absolute pointer-events-none whitespace-nowrap z-50 rounded-md px-2 py-1 text-xs shadow-lg"
          style={{
            left: tipX,
            bottom: 'calc(100% + 8px)',
            transform: 'translateX(-50%)',
            background: C.nodeText,
            color: C.panel,
          }}
        >
          {LABELS[hovered] || ''}
        </span>
      ) : null}

      <div ref={wrapRef}
        className="flex h-14 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur"
        style={{ background: C.panel, borderColor: C.panelBorder, boxShadow: C.nodeText === '#f5f5f4' ? '0 18px 45px rgba(0,0,0,.32)' : '0 4px 24px rgba(0,0,0,0.08)' }}>
        <ZoomBtn id="zoom-compass" active={isMiniMapOpen} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={onToggleMiniMap} label={LABELS['zoom-compass']}
          nodeFill={C.nodeFill} nodeText={C.nodeText} nodeMuted={C.nodeMuted} activeBg={C.nodeFill}>
          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" /></svg>
        </ZoomBtn>

        <ZoomBtn id="zoom-reset" wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={reset} label={LABELS['zoom-reset']}
          nodeFill={C.nodeFill} nodeText={C.nodeText} nodeMuted={C.nodeMuted} activeBg={C.nodeFill}>
          <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
          </svg>
        </ZoomBtn>

        <div className="relative"
          onMouseEnter={() => { setHovered('zoom-slider'); setTipX(getTipX(wrapRef.current, wrapRef.current!)); }}
          onMouseLeave={() => setHovered(null)}
        >
          <input type="range" min="5" max="500" step="1"
            value={Math.round(zoom * 100)}
            onChange={(e) => zoomTo(Number(e.target.value) / 100)}
            className="w-24" style={{ accentColor: C.nodeText }} aria-label="缩放画布" />
        </div>

        <span className="w-10 text-right text-xs tabular-nums select-none" style={{ color: C.nodeMuted }}>{Math.round(zoom * 100)}%</span>

        <ZoomBtn id="zoom-shortcuts" wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={onShortcutsOpen} label={LABELS['zoom-shortcuts']}
          nodeFill={C.nodeFill} nodeText={C.nodeText} nodeMuted={C.nodeMuted} activeBg={C.nodeFill}>
          <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </ZoomBtn>
      </div>
    </div>
  );
}
