import { useCallback, useMemo, useRef, useState } from 'react';
import { useReactFlow, useOnViewportChange, useStore, type Node } from '@xyflow/react';

// ── 移植自 infinite-canvas: canvas-mini-map.tsx ──
// 使用 useOnViewportChange + ref 确保 moveTo 回调始终拿到最新 zoom，
// 尺寸直接从 DOM 读取（与 setViewport 使用同一容器）。

interface MiniMapTheme {
  panel: string;
  panelBorder: string;
  nodeMuted: string;
  activeStroke: string;
}

interface Props {
  theme?: MiniMapTheme;
}

const DEFAULT_DARK: MiniMapTheme = {
  panel: 'rgba(31,29,26,.96)',
  panelBorder: '#44403c',
  nodeMuted: '#d6d3d1',
  activeStroke: '#fafaf9',
};

function nodeColor(type: string, muted: string): string {
  switch (type) {
    case 'image':       return '#10b981';
    case 'video':       return '#f97316';
    case 'audio':       return '#a855f7';
    case 'enhancement': return '#60a5fa';
    default:            return muted;
  }
}

function nodeSize(node: Node): { w: number; h: number } {
  const w = (node.style as any)?.width ?? (node as any).width ?? (node as any).measured?.width ?? 260;
  const h = (node.style as any)?.height ?? (node as any).height ?? (node as any).measured?.height ?? 160;
  return { w: Number(w) || 260, h: Number(h) || 160 };
}

export function CanvasMinimap({ theme }: Props) {
  const C = theme || DEFAULT_DARK;
  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // 用 getViewport() 初始化 — fitView 之后的实际视口，而非硬编码 {0,0,1}
  const [vp, setVp] = useState(() => {
    const v = rf.getViewport();
    return { x: v.x, y: v.y, zoom: v.zoom };
  });
  const vpRef = useRef({ x: rf.getViewport().x, y: rf.getViewport().y, zoom: rf.getViewport().zoom });
  const W = 240;
  const H = 160;

  // 订阅后续视口变化
  useOnViewportChange({
    onChange: useCallback((next: { x: number; y: number; zoom: number }) => {
      vpRef.current = next;
      setVp(next);
    }, []),
  });

  // 订阅节点变化 + 容器尺寸（ReactFlow store 已初始化，比 DOM ref 更早可用）
  const nodes = useStore((s) => s.nodes) as Node[];
  const vpW = useStore((s) => s.width) || (typeof window !== 'undefined' ? window.innerWidth : 1200);
  const vpH = useStore((s) => s.height) || (typeof window !== 'undefined' ? window.innerHeight : 720);

  const viewport = { x: vp.x, y: vp.y, k: vp.zoom };
  const viewportSize = { width: vpW, height: vpH };

  // ── 计算世界边界 & 缩放比 ──
  const { worldBounds, scale, offset } = useMemo(() => {
    if (!nodes.length) {
      return {
        worldBounds: { x: -500, y: -500, w: 1000, h: 1000 },
        scale: 0.16,
        offset: { x: 40, y: 0 },
      };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const { w, h } = nodeSize(node);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + w);
      maxY = Math.max(maxY, node.position.y + h);
    }
    minX -= 500; minY -= 500; maxX += 500; maxY += 500;
    const bw = maxX - minX;
    const bh = maxY - minY;
    const s = Math.min(W / bw, H / bh);
    return {
      worldBounds: { x: minX, y: minY, w: bw, h: bh },
      scale: s,
      offset: { x: (W - bw * s) / 2, y: (H - bh * s) / 2 },
    };
  }, [nodes]);

  const toMinimap = useCallback(
    (wx: number, wy: number) => ({
      x: (wx - worldBounds.x) * scale + offset.x,
      y: (wy - worldBounds.y) * scale + offset.y,
    }),
    [scale, offset.x, offset.y, worldBounds.x, worldBounds.y],
  );

  const toWorld = useCallback(
    (mx: number, my: number) => ({
      x: (mx - offset.x) / scale + worldBounds.x,
      y: (my - offset.y) / scale + worldBounds.y,
    }),
    [scale, offset.x, offset.y, worldBounds.x, worldBounds.y],
  );

  // ── 当前可视区域矩形（与原项目公式完全一致）──
  const viewportRect = useMemo(() => {
    const vx = -viewport.x / viewport.k;
    const vy = -viewport.y / viewport.k;
    const vw = viewportSize.width / viewport.k;
    const vh = viewportSize.height / viewport.k;
    const p1 = toMinimap(vx, vy);
    const p2 = toMinimap(vx + vw, vy + vh);
    return { x: p1.x, y: p1.y, w: Math.max(p2.x - p1.x, 4), h: Math.max(p2.y - p1.y, 4) };
  }, [toMinimap, viewport.k, viewport.x, viewport.y, viewportSize.width, viewportSize.height]);

  const moveTo = useCallback(
    (event: React.PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const world = toWorld(event.clientX - rect.left, event.clientY - rect.top);
      const { zoom } = vpRef.current;
      const vpW2 = (containerRef.current?.closest('.react-flow') as HTMLElement | null)?.clientWidth ?? 1200;
      const vpH2 = (containerRef.current?.closest('.react-flow') as HTMLElement | null)?.clientHeight ?? 720;
      rf.setViewport({
        x: vpW2 / 2 - world.x * zoom,
        y: vpH2 / 2 - world.y * zoom,
        zoom,
      });
    },
    [rf, toWorld],
  );

  return (
    <div
      className="overflow-hidden rounded-lg border backdrop-blur-sm"
      style={{
        position: 'absolute',
        bottom: 84,
        left: 20,
        width: W,
        height: H,
        background: C.panel,
        borderColor: C.panelBorder,
        boxShadow: C.activeStroke === '#fafaf9'
          ? '0 25px 50px -12px rgba(0,0,0,0.5)'
          : '0 4px 24px rgba(0,0,0,0.08)',
        zIndex: 50,
      }}
    >
      <div
        ref={containerRef}
        className="relative h-full w-full cursor-crosshair"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setIsDragging(true);
          moveTo(event);
        }}
        onPointerMove={(event) => {
          if (isDragging) moveTo(event);
        }}
        onPointerUp={() => setIsDragging(false)}
        onPointerLeave={() => setIsDragging(false)}
      >
        {nodes.map((node) => {
          const pos = toMinimap(node.position.x, node.position.y);
          const { w, h } = nodeSize(node);
          const type = (node.data as any)?.nodeType || node.type || '';
          return (
            <div
              key={node.id}
              className="absolute rounded-[1px]"
              style={{
                left: pos.x,
                top: pos.y,
                width: Math.max(w * scale, 2),
                height: Math.max(h * scale, 2),
                backgroundColor: nodeColor(type, C.nodeMuted),
                opacity: 0.8,
              }}
            />
          );
        })}
        <div
          className="pointer-events-none absolute border"
          style={{
            left: viewportRect.x,
            top: viewportRect.y,
            width: viewportRect.w,
            height: viewportRect.h,
            borderColor: C.activeStroke,
            background: `${C.activeStroke}18`,
          }}
        />
      </div>
    </div>
  );
}

