import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ReactFlow,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  addEdge,
  useNodesState,
  useEdgesState,
  useNodes,
  type EdgeProps,
  type NodeTypes,
  type EdgeTypes,
  useStore,
  Handle,
  Position,
  type NodeProps,
  useViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getAuthHeaders } from '../../services/authService';
import { Settings2, Keyboard } from 'lucide-react';
import { MenuIcon, ImageIcon, VideoIcon, SparkleIcon, FilmIcon, PlusIcon, TrashIcon, FileUpIcon, SettingsIcon } from '../../components/Icons';
import { CanvasMinimap } from '../../components/cloth/CanvasMinimap';
import { CanvasZoomDock } from '../../components/cloth/CanvasZoomDock';
import { CanvasNodeHoverToolbar } from '../../components/cloth/CanvasNodeHoverToolbar';
import { ImageAssociateModal } from '../../components/cloth/ImageAssociateModal';
import { VideoAssociateModal } from '../../components/cloth/VideoAssociateModal';
import { AudioAssociateModal } from '../../components/cloth/AudioAssociateModal';
import { PromptLibraryModal } from '../../components/cloth/PromptLibraryModal';
import { CanvasImagePromptPanel } from '../../components/cloth/CanvasImagePromptPanel';
import { CanvasVideoPromptPanel } from '../../components/cloth/CanvasVideoPromptPanel';
import { CanvasAudioPromptPanel } from '../../components/cloth/CanvasAudioPromptPanel';
import { CanvasConfigNodePanel } from '../../components/cloth/CanvasConfigNodePanel';
import type { ConfigGenerationMode, ConfigPanelInputSummary, CanvasResourceReference } from '../../components/cloth/CanvasConfigNodePanel';
import { ImagePreviewModal } from '../../components/cloth/ImagePreviewModal';
import { CanvasNodeInfoModal } from '../../components/cloth/CanvasNodeInfoModal';
import { CanvasToolbar, type ToolbarAction } from '../../components/cloth/CanvasToolbar';
import { CanvasSettingsModal } from '../../components/cloth/CanvasSettingsModal';
import { ThemeToggler } from '../../components/cloth/ThemeToggler';
import type { CanvasCloth, CanvasClothsAsset, CanvasClothsConnection, CanvasScript } from '../../types';
import { nanoid } from 'nanoid';
import { useUserTimezone } from '../../utils/datetime';
import { videoUrlToMp3Blob, downloadBlob } from '../../utils/audioExtractor';

// 音频 mp3 转码缓存（跨渲染持久化，存 Blob 对象避免 fetch blob URL 的兼容问题）
const mp3BlobCache = new Map<string, { blob: Blob; url: string }>();

// ── 原项目 canvas-theme dark 配色 ──
const C_DARK = {
  bg: '#181715',
  nodeFill: '#292524',
  nodeStroke: '#44403c',
  nodeText: '#f5f5f4',
  nodeMuted: '#d6d3d1',
  nodeFaint: '#78716c',
  nodePlaceholder: '#a8a29e',
  panel: 'rgba(31,29,26,.96)',
  panelBorder: '#44403c',
  grid: 'rgba(245,245,244,.10)',
  dot: 'rgba(245,245,244,.24)',
  selection: 'rgba(250,250,249,.10)',
  selectionStroke: '#fafaf9',
  edge: '#7c3aed',
  blue: '#2f80ff',
} as const;

const C_LIGHT = {
  bg: '#f4f2ed',
  nodeFill: '#e7e5df',
  nodeStroke: '#d6d3ca',
  nodeText: '#292524',
  nodeMuted: '#78716c',
  nodeFaint: '#a8a29e',
  nodePlaceholder: '#8a8479',
  panel: 'rgba(251,250,247,.96)',
  panelBorder: '#d6d3ca',
  grid: 'rgba(68,64,60,.12)',
  dot: 'rgba(68,64,60,.28)',
  selection: 'rgba(28,25,23,.06)',
  selectionStroke: '#1c1917',
  edge: '#7c3aed',
  blue: '#2f80ff',
} as const;

type CType = typeof C_DARK;

// ── 画布主题上下文（浅色/深色配色切换） ──
const CanvasThemeContext = createContext<CType>(C_DARK as CType);
const useCanvasTheme = () => useContext(CanvasThemeContext);

async function readImageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ── 构建 @ 引用列表（给配置面板的 composer 用）──
function buildConfigReferences(connectedNodes: Node[]): CanvasResourceReference[] {
  const refs: CanvasResourceReference[] = [];
  const counts: Record<string, number> = { text: 0, image: 0, video: 0, audio: 0 };
  for (const node of connectedNodes) {
    const nt = (node.data as any)?.nodeType || node.type;
    const kind = nt === 'script' || nt === 'text' ? 'text' : nt === 'image' ? 'image' : nt === 'video' ? 'video' : nt === 'audio' ? 'audio' : null;
    if (!kind) continue;
    const content = (node.data as any)?.content || '';
    const hasContent = kind === 'text' ? !!content.trim() : !!content;
    if (!hasContent) continue;
    const idx = counts[kind]++;
    const labels: Record<string, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };
    const label = `${labels[kind]}${idx + 1}`;
    const isVolcano = (node.data as any)?.dbType === 'imagine_of_volc' || node.type === 'imagine_of_volc';
    refs.push({
      nodeId: node.id,
      kind,
      label,
      title: (node.data as any)?.label || label,
      text: kind === 'text' ? content : undefined,
      previewUrl: (kind === 'image' || kind === 'video') ? content : undefined,
      idOfResource: (node.data as any)?.id_of_resource || undefined,
      isVolcano,
      volcAssetUri: isVolcano && (node.data as any)?.volcAssetId ? `asset://${(node.data as any).volcAssetId}` : undefined,
    });
  }
  return refs;
}

// ── 组装提示词：@[idx] → [Image N] / 文本内联，收集 ref_urls ──
function assemblePromptForGenerate(
  rawPrompt: string,
  assetsOfAt: { id: number; id_of_clothes_asset: number }[],
  refs: CanvasResourceReference[],
): { finalPrompt: string; refUrls: string[]; volcUrls: string[] } {
  const atMap = new Map<number, number>();
  for (const a of assetsOfAt) atMap.set(a.id, a.id_of_clothes_asset);
  const refByAssetId = new Map<number, CanvasResourceReference>();
  for (const r of refs) { if (r.idOfResource) refByAssetId.set(r.idOfResource, r); }

  const refUrls: string[] = [];
  const volcUrls: string[] = [];
  let imgSeq = 0, videoSeq = 0, audioSeq = 0;

  const result = rawPrompt.replace(/@\[(\d+)\]/g, (_match, idxStr) => {
    const idx = parseInt(idxStr, 10);
    const assetId = atMap.get(idx);
    if (!assetId) return _match;
    const ref = refByAssetId.get(assetId);
    if (!ref) return _match;

    if (ref.kind === 'text') {
      return ref.text || '';
    }
    if (ref.kind === 'image') {
      imgSeq++;
      if (ref.isVolcano && ref.volcAssetUri) {
        volcUrls.push(ref.volcAssetUri);
      } else if (ref.previewUrl) {
        refUrls.push(ref.previewUrl);
      }
      return `[Image ${imgSeq}]`;
    }
    if (ref.kind === 'video') {
      videoSeq++;
      return `[Video ${videoSeq}]`;
    }
    if (ref.kind === 'audio') {
      audioSeq++;
      return `[Audio ${audioSeq}]`;
    }
    return _match;
  });

  return { finalPrompt: result.trim(), refUrls, volcUrls };
}

// ── 画布网格 — 严格复刻原项目 CanvasGrid：CSS radial-gradient(点) / linear-gradient(线)
//    随视口缩放 + 位移，而非 ReactFlow 内置 Background
function CanvasGrid({ mode }: { mode: 'dots' | 'lines' | 'blank' }) {
  const C = useCanvasTheme();
  const viewport = useViewport();
  if (mode === 'blank') return null;

  const gridSize = 48 * viewport.zoom;
  const x = viewport.x % gridSize;
  const y = viewport.y % gridSize;
  const dotSize = viewport.zoom < 0.12 ? 0.8 : 1.15;
  const backgroundImage =
    mode === 'dots'
      ? `radial-gradient(circle, ${C.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)`
      : `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`;

  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-40"
      style={{
        backgroundImage,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}

const NODE_TYPES_LIST = ['script', 'image', 'video', 'audio', 'enhancement', 'imagine_of_volc'] as const;
type NodeType = (typeof NODE_TYPES_LIST)[number];

// 与底部工具栏图标一致的 SVG 组件
const TextSvg = () => <svg className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>;
const Music2Svg = () => <svg className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/></svg>;

const NODE_META: Record<NodeType, { icon: ReactNode; label: string; accent: string }> = {
  script: { icon: <TextSvg />, label: '文本', accent: '#a8a29e' },
  image: { icon: <ImageIcon className="size-3" />, label: '图片', accent: '#10b981' },
  video: { icon: <VideoIcon className="size-3" />, label: '视频', accent: '#7c3aed' },
  audio: { icon: <Music2Svg />, label: '音频', accent: '#f59e0b' },
  enhancement: { icon: <SparkleIcon className="size-3" />, label: '增强', accent: '#06b6d4' },
  imagine_of_volc: { icon: <ImageIcon className="size-3" />, label: '火山', accent: '#f59e0b' },
};

// ── 自定义节点（原项目风格的节点框架） ──
type ResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

// ── 原项目 ResizeHandle — 不可见的 28×28 角部拖拽热区，依靠圆角边框即可触发 ──
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
  const positionClass = {
    'top-left': '-left-[14px] -top-[14px] cursor-nwse-resize',
    'top-right': '-right-[14px] -top-[14px] cursor-nesw-resize',
    'bottom-left': '-bottom-[14px] -left-[14px] cursor-nesw-resize',
    'bottom-right': '-bottom-[14px] -right-[14px] cursor-nwse-resize',
  }[corner];
  return <div className={`nodrag absolute z-50 size-7 ${positionClass}`} onMouseDown={(event) => onMouseDown(event, corner)} />;
}

interface CanvasNodeData {
  label: string;
  content?: string;
  nodeType: NodeType;
  id_of_resource?: number | null;
  width?: number;
  height?: number;
  onContentChange?: (nodeId: string, content: string) => void;
}

function CanvasNodeImpl({ id: nodeId, data, selected, width: rfWidth, height: rfHeight, positionAbsoluteX, positionAbsoluteY }: NodeProps & { width?: number; height?: number }) {
  const C = useCanvasTheme();
  const d = data as unknown as CanvasNodeData;
  const spec = NODE_META[d.nodeType as NodeType] || NODE_META.script;
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(d.content || '');
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const borderRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport();
  const { setNodes } = useReactFlow();
  const dataRef = useRef(data);
  dataRef.current = data;
  const resizeRef = useRef<{
    isResizing: boolean;
    corner: ResizeCorner;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    startWidth: number;
    startHeight: number;
    keepRatio: boolean;
    ratio: number;
  }>({ isResizing: false } as any);

  const isImage = d.nodeType === 'image';
  const isVideo = d.nodeType === 'video';
  const isAudio = d.nodeType === 'audio';
  const hasImageContent = isImage && !!d.content;
  const hasVideoContent = isVideo && !!d.content;
  const hasAudioContent = isAudio && !!d.content;

  // 视频尺寸已适配标记（按内容 URL 追踪，URL 变化时重新适配）
  const videoFittedRef = useRef<string | null>(null);
  // 当内容 URL 变化时，重置适配标记
  useEffect(() => {
    if (isVideo && d.content && videoFittedRef.current !== d.content) {
      videoFittedRef.current = null;
    }
  }, [isVideo, d.content]);

  // ── 音频 mp4→mp3 转码缓存（仅下载时按需使用，存 Blob 对象）──

  // 原项目：边框 div 使用 ReactFlow 传入的实际渲染尺寸（即 getNodeDimensions 返回值）
  const nodeW = rfWidth ?? (d.width || 260);
  const nodeH = rfHeight ?? (d.height || 160);

  // 直接写入 DOM 样式，绕过所有 React / ReactFlow 样式层
  useEffect(() => {
    if (!borderRef.current) return;
    borderRef.current.style.width = `${nodeW}px`;
    borderRef.current.style.height = `${nodeH}px`;
  }, [nodeW, nodeH]);

  // ── 原项目自定义缩放逻辑（替代 ReactFlow NodeResizer） ──
  const handleResizeMove = useCallback(
    (event: MouseEvent) => {
      if (!resizeRef.current.isResizing) return;
      const scale = viewport.zoom;
      const dx = (event.clientX - resizeRef.current.startX) / scale;
      const dy = (event.clientY - resizeRef.current.startY) / scale;
      const minWidth = 120;
      const minHeight = 80;
      const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
      const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
      const fromLeft = resizeRef.current.corner.includes('left');
      const fromTop = resizeRef.current.corner.includes('top');
      const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
      const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
      let width = rawWidth;
      let height = rawHeight;
      if (resizeRef.current.keepRatio) {
        const ratio = resizeRef.current.ratio;
        if (Math.abs(dx) >= Math.abs(dy)) {
          height = width / ratio;
        } else {
          width = height * ratio;
        }
        if (height < minHeight) { height = minHeight; width = height * ratio; }
        if (width < minWidth) { width = minWidth; height = width / ratio; }
      }
      setNodes((nds) => nds.map((n) =>
        n.id === nodeId
          ? { ...n, width, height, position: { x: fromLeft ? startRight - width : resizeRef.current.startLeft, y: fromTop ? startBottom - height : resizeRef.current.startTop }, measured: { width, height }, style: { width, height }, data: { ...n.data, width, height } }
          : n
      ));
      (dataRef.current as any)?.onNodeDirty?.(nodeId);
    },
    [nodeId, viewport.zoom, setNodes],
  );

  const handleResizeUp = useCallback(() => {
    resizeRef.current.isResizing = false;
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', handleResizeUp);
  }, [handleResizeMove]);

  const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
    event.stopPropagation();
    event.preventDefault();
    resizeRef.current = {
      isResizing: true,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: positionAbsoluteX,
      startTop: positionAbsoluteY,
      startWidth: nodeW,
      startHeight: nodeH,
      keepRatio: hasImageContent || isVideo,
      ratio: nodeW / (nodeH || 1),
    };
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeUp);
    };
  }, [handleResizeMove, handleResizeUp]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      const len = inputRef.current.value.length;
      inputRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  // 工具栏"编辑文字"触发/退出编辑模式（editMode 仅由按钮控制，blur 不清除）
  const prevEditMode = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const curr = !!(data as any)?.editMode;
    if (curr && !prevEditMode.current) {
      setEditText(d.content || '');
      setEditing(true);
    }
    if (!curr && prevEditMode.current) {
      if (editing) {
        d.onContentChange?.(nodeId, editText);
        setEditing(false);
      }
    }
    prevEditMode.current = curr;
  }, [(data as any)?.editMode]);

  const finishEdit = () => {
    setEditing(false);
    d.onContentChange?.(nodeId, editText);
    exitAllTextEdit?.();
  };

  // 原项目连接点显隐规则：hovered || selected || isConnecting
  const showHandles = hovered || selected;

  return (
    <>
      {/* 原项目 ResizeHandle — 四个不可见的角部拖拽热区 */}
      <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
      <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
      <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
      <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
      <div
        ref={borderRef}
        className={`relative rounded-3xl border-2 transition-shadow ${editing && !isImage ? 'nodrag' : ''}`}
        style={{
          background: hasImageContent ? 'transparent' : C.nodeFill,
          borderColor: hasImageContent
            ? (selected || (data as any)?.isActive ? C.blue : (data as any)?.highlighted ? C.nodeMuted : 'transparent')
            : (selected || (data as any)?.isActive ? C.blue : (data as any)?.highlighted ? C.nodeMuted : `${C.nodeStroke}80`),
          boxShadow: selected || (data as any)?.isActive
            ? `0 0 0 2px ${C.blue}40`
            : (data as any)?.highlighted
              ? `0 0 0 1px ${C.nodeMuted}55, 0 18px 48px rgba(0,0,0,.14)`
              : undefined,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onNodeContextMenu?.(nodeId, e.clientX, e.clientY);
        }}
        onDoubleClick={(e) => {
          // 图片节点双重点击 → 查看大图（原项目逻辑）
          if (isImage && hasImageContent) {
            e.stopPropagation();
            (data as any)?.onDoubleClickImage?.(nodeId);
          }
        }}
      >
      {/* 连接端口 — 左侧 target。ReactFlow 默认 CSS: left:0 + translate(-50%,-50%) → 48px 容器中心在节点边缘。复刻原项目 size-12 + 圆点 */}
      <Handle
        type="target"
        position={Position.Left}
        className="!flex !items-center !justify-center !border-0 !bg-transparent"
        style={{
          width: 48,
          height: 48,
          opacity: showHandles ? 1 : 0,
          pointerEvents: showHandles ? 'auto' : 'none',
          transition: 'opacity 150ms',
          zIndex: 30,
        } as any}
        id={`${nodeId}-target`}
      >
        <div
          className="rounded-full transition-all hover:scale-125"
          style={{ width: 12, height: 12, background: C.nodeFill, border: `2px solid ${C.nodeMuted}` }}
        />
      </Handle>
      {/* 连接端口 — 右侧 source（含配置节点，用于连接派生结果卡片） */}
      <Handle
        type="source"
        position={Position.Right}
        className="!flex !items-center !justify-center !border-0 !bg-transparent"
        style={{
          width: 48,
          height: 48,
          opacity: showHandles ? 1 : 0,
          pointerEvents: showHandles ? 'auto' : 'none',
          transition: 'opacity 150ms',
          zIndex: 30,
        } as any}
        id={`${nodeId}-source`}
      >
        <div
          className="rounded-full transition-all hover:scale-125"
          style={{ width: 12, height: 12, background: C.nodeFill, border: `2px solid ${C.nodeMuted}` }}
        />
      </Handle>

      {/* 左上角 "火山资产" 标签 — imagine_of_volc 类型专属 */}
      {(d.nodeType === 'imagine_of_volc' || (data as any)?.dbType === 'imagine_of_volc') && (
        <span
          className="pointer-events-none absolute left-2 top-2 z-30 rounded-md px-1.5 py-0.5 text-[10px] font-medium flex items-center gap-1"
          style={{
            background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
            color: '#1c1917',
            boxShadow: '0 1px 3px rgba(245,158,11,0.3)',
          }}
        >
          <ImageIcon className="size-3" />
          <span>火山资产</span>
        </span>
      )}

      {/* 右上角资源类型标签 — 原项目 ResourceLabelBadge 风格（增强节点不显示） */}
      {d.nodeType !== 'enhancement' && (
      <span
        className="pointer-events-none absolute right-2 top-2 z-30 rounded-md px-1.5 py-0.5 text-[10px] font-medium flex items-center gap-1"
        style={{
          background: selected ? C.blue : C.nodeFaint,
          color: selected ? '#fff' : C.nodeText,
          boxShadow: selected ? '0 1px 3px rgba(0,0,0,0.2)' : undefined,
        }}
      >
        {spec.icon}
        <span>{spec.label}</span>
      </span>
      )}

      {/* 节点内容区 */}
      <div className={`rounded-[inherit] ${d.nodeType === 'enhancement' ? 'overflow-visible' : 'overflow-hidden'}`} style={{ height: '100%', width: '100%' }}>
        {isImage ? (
          (data as any)?.generateError ? (
            /* 图片生成错误 */
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4" style={{ color: '#fca5a5' }}>
              <div className="flex size-10 items-center justify-center rounded-full" style={{ background: 'rgba(220,38,38,.15)' }}>
                <svg className="size-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <span className="text-[11px] text-center leading-tight">{(data as any).generateError}</span>
            </div>
          ) : hasImageContent ? (
            <div className="h-full w-full overflow-hidden rounded-3xl">
              <img
                src={d.content}
                alt={d.label || '图片'}
                draggable={false}
                className="pointer-events-none block h-full w-full select-none object-contain"
                onDragStart={(e) => e.preventDefault()}
              />
            </div>
          ) : (data as any)?.generating ? (
            /* 原项目 LoadingContent — 旋转圆环 + "生成中" */
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.blue }}>
              <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: C.nodeStroke, borderTopColor: C.blue }} />
              <span className="text-[10px] tracking-[0.2em]">生成中</span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.nodePlaceholder }}>
              <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: C.nodeStroke }}>
                <ImageIcon className="size-6 opacity-30" />
              </div>
              <span className="text-[10px] tracking-[0.18em] opacity-50">空图片节点</span>
            </div>
          )
        ) : isVideo ? (
          (data as any)?.generateError ? (
            /* 视频生成错误 */
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4" style={{ color: '#fca5a5' }}>
              <div className="flex size-10 items-center justify-center rounded-full" style={{ background: 'rgba(220,38,38,.15)' }}>
                <svg className="size-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <span className="text-[11px] text-center leading-tight">{(data as any).generateError}</span>
            </div>
          ) : hasVideoContent ? (
            <video
              src={d.content}
              controls
              className="h-full w-full rounded-3xl bg-black object-contain"
              preload="metadata"
              onDragStart={(e) => e.preventDefault()}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget as HTMLVideoElement;
                const vw = v.videoWidth, vh = v.videoHeight;
                if (!vw || !vh) return;
                // 节点已有非默认尺寸（来自 DB 持久化或用户手动拖拽），跳过自动适配
                const curW = (d as any)?.width || 260;
                const curH = (d as any)?.height || 160;
                if (curW !== 260 || curH !== 160) return;
                // 每个节点同一视频源只自动适配一次（对齐 infinite-canvas fitNodeSize）
                if (videoFittedRef.current === d.content) return;
                videoFittedRef.current = d.content || null;
                const maxW = 640, maxH = 640;
                const scale = Math.min(1, maxW / vw, maxH / vh);
                const nw = Math.round(vw * scale), nh = Math.round(vh * scale);
                setNodes((nds) => nds.map((n) => {
                  if (n.id !== nodeId) return n;
                  const cx = n.position.x + ((n as any).width || (n.style as any)?.width || 260) / 2;
                  const cy = n.position.y + ((n as any).height || (n.style as any)?.height || 160) / 2;
                  return {
                    ...n,
                    position: { x: cx - nw / 2, y: cy - nh / 2 },
                    width: nw, height: nh,
                    measured: { width: nw, height: nh },
                    style: { ...((n as any).style || {}), width: nw, height: nh },
                    data: { ...n.data, width: nw, height: nh },
                  };
                }));
                // 标记脏节点 + 立即保存尺寸到 DB（不等 1s 延迟同步）
                (dataRef.current as any)?.onNodeDirty?.(nodeId);
                (dataRef.current as any)?.onVideoResized?.(nodeId, nw, nh);
              }}
            />
          ) : (data as any)?.generating ? (
            /* 视频生成中 — 旋转圆环 + "生成中" */
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.blue }}>
              <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: C.nodeStroke, borderTopColor: C.blue }} />
              <span className="text-[10px] tracking-[0.2em]">生成中</span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.nodePlaceholder }}>
              <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: C.nodeStroke }}>
                <VideoIcon className="size-6 opacity-30" />
              </div>
              <span className="text-[10px] tracking-[0.18em] opacity-50">空视频节点</span>
            </div>
          )
        ) : isAudio ? (
          (data as any)?.generateError ? (
            /* 音频生成错误 */
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4" style={{ color: '#fca5a5' }}>
              <div className="flex size-10 items-center justify-center rounded-full" style={{ background: 'rgba(220,38,38,.15)' }}>
                <svg className="size-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <span className="text-[11px] text-center leading-tight">{(data as any).generateError}</span>
            </div>
          ) : hasAudioContent ? (
            <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: C.nodeFill, color: C.nodeText }}>
              <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2Svg />
                <span className="truncate">音频</span>
              </div>
              {d.label && <p className="text-[11px] leading-relaxed opacity-50 line-clamp-2">{d.label}</p>}
              <audio src={d.content} controls className="w-full" style={{ colorScheme: C.nodeText < '#888' ? 'light' : 'dark' }} onDragStart={(e) => e.preventDefault()} />
            </div>
          ) : (data as any)?.generating ? (
            /* 音频生成中 — 旋转圆环 + "生成中" */
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.blue }}>
              <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: C.nodeStroke, borderTopColor: C.blue }} />
              <span className="text-[10px] tracking-[0.2em]">生成中</span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: C.nodePlaceholder }}>
              <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: C.nodeStroke }}>
                <svg className="size-6 opacity-30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/></svg>
              </div>
              <span className="text-[10px] tracking-[0.18em] opacity-50">空音频节点</span>
            </div>
          )
        ) : (d.nodeType === 'enhancement' && (data as any)?.dbType === 'config') ? (
          <CanvasConfigNodePanel
            nodeId={nodeId}
            projectId={(data as any)?.promptProjectId ?? null}
            generationMode={(data as any)?.configGenerationMode || (data as any)?.generationMode || 'image'}
            initialModel={(data as any)?.configModel || null}
            initialSize={(data as any)?.size as string | undefined}
            initialRatio={(data as any)?.ratio as string | undefined}
            initialSeconds={(data as any)?.seconds as string | undefined}
            initialPrompt={(data as any)?.configPrompt || ''}
            initialAssetsOfAt={(data as any)?.configAssetsOfAt || (data as any)?.assetsOfAt || '[]'}
            inputSummary={(data as any)?.configInputSummary || { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 }}
            references={(data as any)?.configReferences || []}
            theme={(data as any)?.configTheme || { fill: C.nodeFill, stroke: C.nodeStroke, text: C.nodeText, muted: C.nodeMuted, faint: C.nodeFaint, activeBg: C.selection, blue: C.blue }}
            composerOpen={!!(data as any)?.composerOpen}
            onComposerToggle={(data as any)?.onComposerToggle || (() => {})}
            onConfigChange={(data as any)?.configOnChange || (() => {})}
            onBlur={(data as any)?.configOnBlur || (() => {})}
            onGenerate={(data as any)?.configOnGenerate || (() => {})}
            isRunning={!!(data as any)?.generating}
          />
        ) : editing ? (
          <textarea
            ref={inputRef}
            className="w-full h-full resize-none bg-transparent text-sm leading-relaxed outline-none thin-scrollbar px-5 pt-4 pb-4"
            style={{ color: C.nodeText }}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={finishEdit}
            onKeyDown={(e) => { if (e.key === 'Escape') finishEdit(); }}
          />
        ) : d.content ? (
          <div
            className="w-full h-full overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap break-words thin-scrollbar cursor-grab px-5 pt-4 pb-4"
            style={{ color: C.nodeText }}
          >
            {d.content}
          </div>
        ) : (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: C.nodePlaceholder }}
          >
            <span className="text-xs tracking-widest opacity-50">文字</span>
          </div>
        )}
      </div>

      {/* 文本节点右下角"生成"按钮 */}
      {d.nodeType === 'script' && (
        <button
          type="button"
          className="absolute right-3 bottom-3 z-20 inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
          style={{ background: `${C.nodeFill}dd`, borderColor: C.nodeStroke, color: C.nodeText }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); (data as any)?.onScriptToImage?.(nodeId); }}
          title="用文本生成"
          aria-label="用文本生成"
        >
          <svg className="size-3.5" viewBox="0 0 64 64" fill="none"><path d="M32 8L58 54H46L32 29L18 54H6L32 8Z" fill="currentColor"/><path d="M32 40L40 54H24L32 40Z" fill="currentColor"/></svg>
          生成
        </button>
      )}

      {/* 选中边框 */}
      {selected && (
        <div className="absolute inset-0 rounded-3xl pointer-events-none" style={{ boxShadow: `0 0 0 2px ${C.blue}` }} />
      )}
      </div>

      {/* 图片生图面板 — 图片节点专用 */}
      {(data as any)?.showPromptPanel && isImage && (
        <div
          className="nodrag nowheel absolute left-1/2 top-full z-[70] w-max max-w-[600px] -translate-x-1/2 pt-4"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <CanvasImagePromptPanel
            open={true}
            nodeId={nodeId}
            projectId={(data as any)?.promptProjectId ?? null}
            initialRecordId={(data as any)?.id_of_resource && !(data as any)?.content ? (data as any)?.id_of_resource : null}
            onClose={() => (data as any)?.onPromptClose?.()}
            onGenerated={(url, recordId, model) => (data as any)?.onPromptGenerated?.(nodeId, url, recordId, model)}
            onGenerating={(recordId, model) => (data as any)?.onPromptGenerating?.(nodeId, recordId, model)}
            onPromptError={(msg) => (data as any)?.onPromptError?.(nodeId, msg)}
            theme={{ panel: C.panel, panelBorder: C.panelBorder, nodeFill: C.nodeFill, nodeStroke: C.nodeStroke, nodeText: C.nodeText, nodeMuted: C.nodeMuted, nodeFaint: C.nodeFaint }}
          />
        </div>
      )}

      {/* 视频生图面板 — 视频节点专用 */}
      {(data as any)?.showVideoPromptPanel && isVideo && (
        <div
          className="nodrag nowheel absolute left-1/2 top-full z-[70] w-max max-w-[600px] -translate-x-1/2 pt-4"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <CanvasVideoPromptPanel
            open={true}
            nodeId={nodeId}
            projectId={(data as any)?.promptProjectId ?? null}
            onClose={() => (data as any)?.onVideoPromptClose?.()}
            onGenerated={(url, recordId, model) => (data as any)?.onVideoPromptGenerated?.(nodeId, url, recordId, model)}
            onGenerating={(recordId, model) => (data as any)?.onVideoPromptGenerating?.(nodeId, recordId, model)}
            onPromptError={(msg) => (data as any)?.onVideoPromptError?.(nodeId, msg)}
            theme={{ panel: C.panel, panelBorder: C.panelBorder, nodeFill: C.nodeFill, nodeStroke: C.nodeStroke, nodeText: C.nodeText, nodeMuted: C.nodeMuted, nodeFaint: C.nodeFaint }}
          />
        </div>
      )}

      {/* 音频生成面板 — 只读配置 */}
      {(data as any)?.showAudioPromptPanel && isAudio && (
        <div
          className="nodrag nowheel absolute left-1/2 top-full z-[70] w-max max-w-[600px] -translate-x-1/2 pt-4"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <CanvasAudioPromptPanel
            open={true}
            nodeId={nodeId}
            projectId={(data as any)?.promptProjectId ?? null}
            onClose={() => (data as any)?.onAudioPromptClose?.()}
            onPromptLibrary={() => (data as any)?.onAudioPromptLibrary?.()}
            onGenerating={(recordId, model, promptText) => (data as any)?.onAudioPromptGenerating?.(nodeId, recordId, model, promptText)}
            onPromptError={(msg) => (data as any)?.onAudioPromptError?.(nodeId, msg)}
            isGenerating={!!(data as any)?.generating}
            generatingRecordId={(data as any)?.id_of_resource ?? null}
            savedPrompt={(data as any)?.audioPrompt ?? ''}
            selectedAsset={(data as any)?.volcAsset ?? null}
            theme={{
              panel: C.panel,
              panelBorder: C.panelBorder,
              nodeFill: C.nodeFill,
              nodeStroke: C.nodeStroke,
              nodeText: C.nodeText,
              nodeMuted: C.nodeMuted,
              nodeFaint: C.nodeFaint,
            }}
          />
        </div>
      )}
    </>
  );
}

const nodeTypes: NodeTypes = { script: CanvasNodeImpl, image: CanvasNodeImpl, video: CanvasNodeImpl, audio: CanvasNodeImpl, enhancement: CanvasNodeImpl, imagine_of_volc: CanvasNodeImpl };

// 连线交互回调 — 通过模块级变量绕过 ReactFlow edge data 同步问题
let onEdgeClick: (() => void) | null = null;
let onEdgeContextMenu: ((id: string, x: number, y: number) => void) | null = null;
let onNodeContextMenu: ((id: string, x: number, y: number) => void) | null = null;
let exitAllTextEdit: (() => void) | null = null;

// ── 自定义连线 — 严格复刻原项目 canvas-connections.tsx ConnectionPath ──
function CanvasEdge({ id, source, target, selected, data }: EdgeProps) {
  const C = useCanvasTheme();
  const nodes = useNodes();
  const { setNodes, setEdges } = useReactFlow();
  const from = nodes.find((n) => n.id === source);
  const to = nodes.find((n) => n.id === target);
  const active = selected || !!(data as any)?.highlighted;

  // ── 音频模式边线染色（从 edge data 读取，由 sync effect 注入）──
  const isAudio = !!(data as any)?.isAudio;
  const isNonVolcImage = isAudio && from && ((from?.data as any)?.dbType === 'image' || from?.type === 'image') && from?.type !== 'imagine_of_volc' && (from?.data as any)?.dbType !== 'imagine_of_volc';
  const isVolcImage = isAudio && from && ((from?.data as any)?.dbType === 'imagine_of_volc' || from?.type === 'imagine_of_volc');
  // @ 引用检测：用 useStore 直接读目标节点的 configAssetsOfAt（不依赖边线 data 同步）──
  const configAssetsOfAt = useStore((s) => {
    const nd = s.nodeLookup?.get(target);
    return (nd?.data as any)?.assetsOfAt || (nd?.data as any)?.configAssetsOfAt || '[]';
  });
  const volcHasAt = (() => {
    if (!isVolcImage) return false;
    const srcResId = (from?.data as any)?.id_of_resource;
    if (!srcResId) return false;
    try { return JSON.parse(configAssetsOfAt).some((a: any) => a.id_of_clothes_asset === srcResId); } catch { return false; }
  })();
  const volcDash = isVolcImage && !volcHasAt;
  const edgeColor = isNonVolcImage ? C.nodeFill : (active ? C.selectionStroke : C.nodeMuted);
  const highlightColor = isNonVolcImage ? C.grid : C.selectionStroke;
  const strokeDasharray = volcDash ? '6 4' : 'none';

  // 原项目公式：从源节点右边缘 → 目标节点左边缘
  const sx = from ? from.position.x + (from.width ?? 260) : 0;
  const sy = from ? from.position.y + (from.height ?? 160) / 2 : 0;
  const tx = to ? to.position.x : 0;
  const ty = to ? to.position.y + (to.height ?? 160) / 2 : 0;
  const dx = Math.abs(tx - sx);
  const curvature = Math.max(dx * 0.5, 50);
  const pathD = `M ${sx} ${sy} C ${sx + curvature} ${sy}, ${tx - curvature} ${ty}, ${tx} ${ty}`;

  return (
    <g>
      {/* 原项目：透明宽路径用于点击/右键（pointerEvents: stroke） */}
      <path
        d={pathD}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onClick={(event) => {
          event.stopPropagation();
          setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
          setEdges((eds) => eds.map((e) => ({ ...e, selected: e.id === id })));
          onEdgeClick?.();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
          setEdges((eds) => eds.map((e) => ({ ...e, selected: e.id === id })));
          onEdgeContextMenu?.(id, event.clientX, event.clientY);
        }}
      />
      <path
        d={pathD}
        stroke={active ? highlightColor : edgeColor}
        strokeWidth={active ? 3 : 2}
        strokeOpacity={active ? 1 : 0.82}
        strokeDasharray={strokeDasharray}
        fill="none"
        style={{ filter: active ? `drop-shadow(0 0 8px ${highlightColor}66)` : undefined, pointerEvents: 'none' }}
      />
    </g>
  );
}

const edgeTypes: EdgeTypes = { default: CanvasEdge };

// ── 主组件 ──
export default function CanvasEditorPage() {
  useUserTimezone();
  const { id: clothId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  // 画布标题编辑
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // 缩放控件
  const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [cloth, setCloth] = useState<CanvasCloth | null>(null);
  const clothRef = useRef(cloth);
  clothRef.current = cloth;

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 连线：逐条新增，立即执行（无批量概念）
  const onConnect = useCallback((params: Connection) => {
    const id = nanoid();
    setEdges((eds) => addEdge({ ...params, id, type: 'default' }, eds));
    fetch(`/api/cloths/${clothId}/connections`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id, from_asset_id: params.source, to_asset_id: params.target }),
    }).catch(() => {});
  }, [clothId]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [clickedNodeId, setClickedNodeId] = useState<string | null>(null);
  const activeNodeId = hoveredNodeId ?? clickedNodeId;

  // ── 画布外观状态 — 复刻原项目 backgroundMode / showImageInfo ──
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    try {
      const s = localStorage.getItem('seedance_canvas_settings');
      if (s) { const t = JSON.parse(s).theme; if (t === 'light' || t === 'dark') return t; }
    } catch {}
    return 'dark';
  });
  // 离开画布时恢复 html.dark（确保非画布模块保持深色主题）
  useEffect(() => {
    return () => {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    };
  }, []);
  const [backgroundMode, setBackgroundMode] = useState<'dots' | 'lines' | 'blank'>('lines');
  const [showImageInfo, setShowImageInfo] = useState(false);
  const C = themeMode === 'light' ? C_LIGHT : C_DARK;
  const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
  const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
  const [associateNodeId, setAssociateNodeId] = useState<string | null>(null);
  const [videoAssociateNodeId, setVideoAssociateNodeId] = useState<string | null>(null);
  const [audioAssociateNodeId, setAudioAssociateNodeId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [promptNodeId, setPromptNodeId] = useState<string | null>(null);
  const [videoPromptNodeId, setVideoPromptNodeId] = useState<string | null>(null);
  const [audioPromptNodeId, setAudioPromptNodeId] = useState<string | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [promptLibraryMode, setPromptLibraryMode] = useState<'insert' | 'use'>('insert');
  const promptNodeIdRef = useRef<string | null>(null);
  const videoPromptNodeIdRef = useRef<string | null>(null);
  useEffect(() => { promptNodeIdRef.current = promptNodeId; }, [promptNodeId]);
  useEffect(() => { videoPromptNodeIdRef.current = videoPromptNodeId; }, [videoPromptNodeId]);
  const audioPromptNodeIdRef = useRef<string | null>(null);
  useEffect(() => { audioPromptNodeIdRef.current = audioPromptNodeId; }, [audioPromptNodeId]);
  const rfInstanceRef = useRef<any>(null);
  const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepNodeToolbar = (nodeId: string) => {
    if (toolbarTimerRef.current) { clearTimeout(toolbarTimerRef.current); toolbarTimerRef.current = null; }
    setToolbarNodeId(nodeId);
  };
  const hideNodeToolbar = () => {
    if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = setTimeout(() => { setToolbarNodeId(null); toolbarTimerRef.current = null; }, 120);
  };

  // 注册连线交互回调
  useEffect(() => {
    onEdgeClick = () => {
      setClickedNodeId(null);
      setPromptNodeId(null);
      setToolbarNodeId(null);
    };
    onEdgeContextMenu = (id, x, y) => {
      setClickedNodeId(null);
      setPromptNodeId(null);
      setToolbarNodeId(null);
      setEdgeContextMenu({ id, x, y });
    };
    onNodeContextMenu = (id, x, y) => {
      setNodeContextMenu({ id, x, y });
    };
    exitAllTextEdit = () => {
      setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, editMode: undefined } })));
    };
    return () => { onEdgeClick = null; onEdgeContextMenu = null; onNodeContextMenu = null; exitAllTextEdit = null; };
  }, []);

  const [composerNodeId, setComposerNodeId] = useState<string | null>(null);

  // ── Composer toggle：注入到 enhancement 节点 ──
  const handleComposerToggle = useCallback((nodeId: string) => {
    setComposerNodeId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  // 原项目 relatedHighlight：激活节点 + 其上下游节点 + 相关连线
  const relatedHighlight = (() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (!activeNodeId) return { nodeIds, edgeIds };
    nodeIds.add(activeNodeId);
    edges.forEach((e) => {
      if (e.source !== activeNodeId && e.target !== activeNodeId) return;
      edgeIds.add(e.id);
      nodeIds.add(e.source);
      nodeIds.add(e.target);
    });
    return { nodeIds, edgeIds };
  })();

  // 同步 highlighted 标记到 edges 和 nodes
  const prevAudioNodesRef = useRef('');
  useEffect(() => {
    const configAudioIds = new Set<string>();
    const configAssetsMap = new Map<string, string>();
    nodes.forEach((nd) => {
      const nt = (nd.data as any)?.nodeType || nd.type;
      const dbType = (nd.data as any)?.dbType || nt;
      if (nt === 'enhancement' && dbType === 'config') {
        const mode = (nd.data as any)?.generationMode || (nd.data as any)?.configGenerationMode || '';
        if (mode === 'audio') configAudioIds.add(nd.id);
        configAssetsMap.set(nd.id, (nd.data as any)?.assetsOfAt || (nd.data as any)?.configAssetsOfAt || '[]');
      }
    });
    const audioFingerprint = [...configAudioIds].sort().join(',') + '|' + [...configAssetsMap.entries()].map(([k,v]) => `${k}:${v}`).join(';');
    const audioChanged = audioFingerprint !== prevAudioNodesRef.current;
    if (audioChanged) prevAudioNodesRef.current = audioFingerprint;

    setEdges((eds) => eds.map((e) => ({
      ...e,
      data: {
        ...e.data,
        highlighted: relatedHighlight.edgeIds.has(e.id),
        // 始终注入，指纹仅防重算，不阻塞新边线
        isAudio: configAudioIds.has(e.target) || undefined,
        configAssetsOfAt: configAssetsMap.get(e.target),
      },
    })));
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, highlighted: relatedHighlight.nodeIds.has(n.id), isActive: n.id === activeNodeId },
      })),
    );
  }, [activeNodeId, edges.length]);

  // ── 从文本节点创建配置节点 + 连线 — 复刻 infinite-canvas generateImageFromTextNode ──
  const generateConfigNode = useCallback((sourceNodeId: string, mode: ConfigGenerationMode) => {
    const sourceNode = nodesRef.current.find((n) => n.id === sourceNodeId);
    if (!sourceNode) return;

    // 创建 enhancement 节点，位置在文本节点右侧 + 120px 间距
    const configW = 336;
    const configH = 240;
    const configId = `config_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const configX = sourceNode.position.x + (sourceNode.width || 340) + 120;
    const configY = sourceNode.position.y + (sourceNode.height || 240) / 2 - configH / 2;

    const configNode: Node = {
      id: configId,
      type: 'enhancement',
      position: { x: configX, y: configY },
      width: configW,
      height: configH,
      data: {
        label: '',
        content: '',
        nodeType: 'enhancement' as NodeType,
        dbType: 'config',
        generationMode: mode,
        configGenerationMode: mode,
        configPrompt: '',
        configModel: mode === 'video' ? 'seedance-2.0' : 'nano-banana-2',
      },
      style: { width: configW, height: configH },
    };

    // 创建连线
    const edgeId = nanoid();
    const newEdge: Edge = {
      id: edgeId,
      source: sourceNodeId,
      target: configId,
      type: 'default',
    };

    setNodes((nds) => [...nds, configNode]);
    setEdges((eds) => addEdge(newEdge, eds));

    // 选中 config 节点
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === configId })));

    // 配置卡片写入数据库（type=config），刷新后从 DB 恢复
    fetch(`/api/cloths/${clothId}/assets`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        assets: [{
          id: configId, type: 'config', subtype: null,
          title: '', pos_x: configX, pos_y: configY,
          width: configW, height: configH, id_of_resource: null,
          generation_mode: mode,
          config_model: configNode.data.configModel,
          config_prompt: '',
          config_params: '{}',
        }],
      }),
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (data.id_of_resource) {
        setNodes((nds) => nds.map((n) => n.id === configId ? { ...n, data: { ...n.data, id_of_resource: data.id_of_resource } } : n));
      }
    }).catch(() => {});
    fetch(`/api/cloths/${clothId}/connections`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: edgeId, from_asset_id: sourceNodeId, to_asset_id: configId }),
    }).catch(() => {});
  }, [clothId]);

  // ── 从配置节点触发图片生成（先派生节点，再调 API）──
  const handleGenerateImageFromConfig = useCallback(async (configNodeId: string, prompt: string, model: string, sizeLabel: string, refUrls?: string[]) => {
    const configNode = nodesRef.current.find((n) => n.id === configNodeId);
    if (!configNode || !clothId) return;

    const configW = configNode.width || 336;
    const configH = configNode.height || 240;

    // 1) 立即派生图片节点（在配置节点右侧）
    const gap = 40;
    const imgNodeId = `image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const imgNode: Node = {
      id: imgNodeId,
      type: 'image',
      position: { x: configNode.position.x + configW + gap, y: configNode.position.y },
      width: configW, height: configH,
      data: {
        label: '', content: '', file_url: '',
        nodeType: 'image', dbType: 'image', generating: true,
        id_of_resource: null, model,
        width: configW, height: configH,
      },
      style: { width: configW, height: configH },
    };

    // 配置 → 图片 连线
    const edgeId = `edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newEdge: Edge = {
      id: edgeId,
      source: configNodeId,
      sourceHandle: `${configNodeId}-source`,
      target: imgNodeId,
      targetHandle: `${imgNodeId}-target`,
    };

    setNodes((nds) => [...nds, imgNode]);
    setEdges((eds) => [...eds, newEdge]);

    // 2) 调用生成 API（节点和连线等 API 返回后再写 DB）
    try {
      const body: Record<string, unknown> = { prompt, model, sizeLabel, projectId: clothRef.current?.project_id, urls: refUrls, refUrls };
      if (model === 'gpt-image-2') {
        body.size = sizeLabel;
      } else {
        const parts = sizeLabel.split(' · ');
        body.size = parts[0] || '1K';
        body.aspectRatio = parts[1] || '1:1';
      }
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) {
        setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, generating: false, generateError: data.error || '生成失败' } } : n));
        // 保存失败节点到 DB（无 id_of_resource），再保存连线
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: imgNodeId, type: 'image', subtype: model, title: '', pos_x: imgNode.position.x, pos_y: imgNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: imgNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }
      const recordId: number = data.imageRecordId;
      if (!recordId) {
        setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '未获取到任务ID' } } : n));
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: imgNodeId, type: 'image', subtype: model, title: '', pos_x: imgNode.position.x, pos_y: imgNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: imgNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }

      // 一次性写入 DB（含 recordId），再保存连线
      setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, id_of_resource: recordId } } : n));
      fetch(`/api/cloths/${clothId}/assets`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ assets: [{ id: imgNodeId, type: 'image', subtype: model, title: '', pos_x: imgNode.position.x, pos_y: imgNode.position.y, width: configW, height: configH, id_of_resource: recordId }] }),
      }).then(() => {
        fetch(`/api/cloths/${clothId}/connections`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: imgNodeId }),
        }).catch(() => {});
      }).catch(() => {});

      // 3) 轮询结果
      let attempts = 0;
      const poll = async () => {
        if (attempts > 60) {
          setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '生成超时' } } : n));
          return;
        }
        attempts++;
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const pollUrl = `/api/image-records?projectId=${clothRef.current!.project_id}&pageSize=50`;
          const pres = await fetch(pollUrl, { headers: getAuthHeaders() });
          const pdata = await pres.json();
          const record = (pdata?.data?.records || []).find((r: any) => r.id === recordId);
          if (!record) { poll(); return; }
          if (record.status === 'done' && record.result_urls?.length > 0) {
            const imgUrl = record.result_urls[0];
            const size = await readImageSize(imgUrl);
            const w = size?.width || configW;
            const h = size?.height || configH;
            setNodes((nds) => nds.map((n) => n.id === imgNodeId ? {
              ...n,
              width: w, height: h,
              style: { width: w, height: h },
              data: { ...n.data, generating: false, content: imgUrl, file_url: imgUrl, width: w, height: h },
            } : n));
            return;
          }
          if (record.status === 'error') {
            setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, generating: false, generateError: record.error_message || '生成失败' } } : n));
            return;
          }
          poll();
        } catch { poll(); }
      };
      poll();
    } catch {
      setNodes((nds) => nds.map((n) => n.id === imgNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '网络异常' } } : n));
    }
  }, [clothId]);

  // ── 从配置节点触发视频生成（先派生节点，再调 API）──
  const handleGenerateVideoFromConfig = useCallback(async (configNodeId: string, prompt: string, model: string, sizeLabel: string, refUrls?: string[], volcUrls?: string[]) => {
    const configNode = nodesRef.current.find((n) => n.id === configNodeId);
    if (!configNode || !clothId) return;

    const configW = configNode.width || 336;
    const configH = configNode.height || 240;

    // 1) 立即派生视频节点
    const gap = 40;
    const videoNodeId = `video_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const videoNode: Node = {
      id: videoNodeId,
      type: 'video',
      position: { x: configNode.position.x + configW + gap, y: configNode.position.y },
      width: configW, height: configH,
      data: { label: '', content: '', file_url: '', nodeType: 'video', dbType: 'video', generating: true, id_of_resource: null, model, width: configW, height: configH },
      style: { width: configW, height: configH },
    };
    const edgeId = `edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newEdge: Edge = { id: edgeId, source: configNodeId, sourceHandle: `${configNodeId}-source`, target: videoNodeId, targetHandle: `${videoNodeId}-target` };

    setNodes((nds) => [...nds, videoNode]);
    setEdges((eds) => [...eds, newEdge]);

    // 2) 调用生成 API（HappyHorse 走独立接口，节点和连线 API 返回后再写 DB）
    try {
      const isHH = model?.startsWith('happyhorse');
      const parts = sizeLabel.split(' · ');
      const resolution = parts[0] || '720p';
      const ratio = parts[1] || '16:9';
      const duration = parseInt(parts[2]) || 5;

      let res: Response;
      if (isHH) {
        // HappyHorse → DashScope API
        const hhMode = model.replace('happyhorse-1.0-', '');
        const media: { type: string; url: string }[] = [];
        if (refUrls && refUrls.length > 0) {
          for (const url of refUrls) media.push({ type: 'reference_image', url });
        }
        if (volcUrls && volcUrls.length > 0) {
          for (const url of volcUrls) media.push({ type: 'reference_image', url });
        }
        const hhBody: Record<string, unknown> = {
          projectId: clothRef.current?.project_id,
          mode: hhMode,
          prompt,
          resolution: resolution.toUpperCase(),
          ratio,
          duration,
        };
        if (media.length > 0) hhBody.media = media;
        res = await fetch('/api/happyhorse-tasks', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(hhBody),
        });
      } else {
        // Seedance → Ark API
        const body: Record<string, unknown> = { prompt, model, sizeLabel, projectId: clothRef.current?.project_id };
        body.resolution = resolution;
        body.ratio = ratio;
        body.duration = duration;
        if (refUrls && refUrls.length > 0) body.imageUrls = JSON.stringify(refUrls);
        if (volcUrls && volcUrls.length > 0) body.volcImageUrls = JSON.stringify(volcUrls);
        res = await fetch('/api/generate-video', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        });
      }
      const data = await res.json();
      if (!data.success) {
        setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: data.error || '生成失败' } } : n));
        // 保存失败节点到 DB
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: videoNodeId, type: 'video', subtype: model, title: '', pos_x: videoNode.position.x, pos_y: videoNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: videoNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }
      const taskId: number = isHH ? (data.data?.id || data.data?.taskId) : data.taskId;
      if (!taskId) {
        setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '未获取到任务ID' } } : n));
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: videoNodeId, type: 'video', subtype: model, title: '', pos_x: videoNode.position.x, pos_y: videoNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: videoNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }

      setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, id_of_resource: taskId } } : n));
      // 写入 DB（含 taskId）+ 连线
      fetch(`/api/cloths/${clothId}/assets`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ assets: [{ id: videoNodeId, type: 'video', subtype: model, title: '', pos_x: videoNode.position.x, pos_y: videoNode.position.y, width: configW, height: configH, id_of_resource: taskId }] }),
      }).then(() => {
        fetch(`/api/cloths/${clothId}/connections`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: videoNodeId }),
        }).catch(() => {});
      }).catch(() => {});

      // HappyHorse 由后端 worker 轮询 DashScope，前端轮询 DB 状态
      if (isHH) {
        let hhAttempts = 0;
        const hhPoll = async () => {
          if (hhAttempts > 120) { setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '生成超时' } } : n)); return; }
          hhAttempts++;
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const hhRes = await fetch(`/api/happyhorse-tasks/${taskId}`, { headers: getAuthHeaders() });
            const hhData = await hhRes.json();
            const record = hhData?.data;
            if (!record) { hhPoll(); return; }
            if ((record.status === 'done' || record.task_status === 'SUCCEEDED') && record.video_url) {
              const rawUrl = record.video_url;
              const url = rawUrl.startsWith('http') ? `/api/proxy-video?url=${encodeURIComponent(rawUrl)}` : rawUrl;
              setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, content: url, file_url: url } } : n));
              return;
            }
            if (record.status === 'error' || record.task_status === 'FAILED') {
              setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: record.error_message || '生成失败' } } : n));
              return;
            }
            hhPoll();
          } catch { hhPoll(); }
        };
        hhPoll();
        return;
      }

      // 3) Seedance 轮询
      let attempts = 0;
      const poll = async () => {
        if (attempts > 120) { setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '生成超时' } } : n)); return; }
        attempts++;
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const pres = await fetch(`/api/task/${taskId}`, { headers: getAuthHeaders() });
          const pdata = await pres.json();
          const record = pdata;
          if (!record || record.status === 'processing') { poll(); return; }
          if (record.status === 'done') {
            const videoUrl = record.result?.data?.[0]?.url || record.result_url || record.video_url;
            if (videoUrl) {
              setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, content: videoUrl, file_url: videoUrl } } : n));
              return;
            }
          }
          if (record.status === 'error') { setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: record.error || record.error_message || '生成失败' } } : n)); return; }
          poll();
        } catch { poll(); }
      };
      poll();
    } catch { setNodes((nds) => nds.map((n) => n.id === videoNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '网络异常' } } : n)); }
  }, [clothId]);

  // ── 从配置节点触发音频生成（先派生节点，再调 API）──
  const handleGenerateAudioFromConfig = useCallback(async (configNodeId: string, prompt: string, model: string, _sizeLabel: string, refUrls: string[] = [], volcUrls: string[] = []) => {
    const configNode = nodesRef.current.find((n) => n.id === configNodeId);
    if (!configNode || !clothId) return;

    const configW = configNode.width || 336;
    const configH = configNode.height || 240;

    // 1) 立即派生音频节点
    const gap = 40;
    const audioNodeId = `audio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const audioNode: Node = {
      id: audioNodeId,
      type: 'audio',
      position: { x: configNode.position.x + configW + gap, y: configNode.position.y },
      width: configW, height: configH,
      data: { label: prompt, content: '', file_url: '', nodeType: 'audio', dbType: 'audio', generating: true, id_of_resource: null, model, width: configW, height: configH },
      style: { width: configW, height: configH },
    };
    const edgeId = `edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newEdge: Edge = { id: edgeId, source: configNodeId, sourceHandle: `${configNodeId}-source`, target: audioNodeId, targetHandle: `${audioNodeId}-target` };

    setNodes((nds) => [...nds, audioNode]);
    setEdges((eds) => [...eds, newEdge]);

    // 2) 解析参考图（取第一个可用图片/火山 URL）
    const referenceImageUrl = volcUrls[0] || refUrls[0] || '';
    // 火山素材优先用 asset:// URI
    const referenceAssetUri = volcUrls[0]?.startsWith('asset://') ? volcUrls[0] : undefined;

    // 3) 调用生成 API（节点和连线等 API 返回后再写 DB）
    try {
      const res = await fetch('/api/audio-generations', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          projectId: clothRef.current?.project_id,
          referenceImageUrl,
          referenceAssetUri,
          voicePrompt: prompt,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, generateError: data.error || '生成失败' } } : n));
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: audioNodeId, type: 'audio', subtype: model, title: '', pos_x: audioNode.position.x, pos_y: audioNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: audioNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }
      const recordId: number = data.data?.audioGenerationId || data.data?.taskId;
      if (!recordId) {
        setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '未获取到任务ID' } } : n));
        fetch(`/api/cloths/${clothId}/assets`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ assets: [{ id: audioNodeId, type: 'audio', subtype: model, title: '', pos_x: audioNode.position.x, pos_y: audioNode.position.y, width: configW, height: configH }] }),
        }).then(() => {
          fetch(`/api/cloths/${clothId}/connections`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: audioNodeId }),
          }).catch(() => {});
        }).catch(() => {});
        return;
      }

      setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, id_of_resource: recordId } } : n));
      fetch(`/api/cloths/${clothId}/assets`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ assets: [{ id: audioNodeId, type: 'audio', subtype: model, title: '', pos_x: audioNode.position.x, pos_y: audioNode.position.y, width: configW, height: configH, id_of_resource: recordId }] }),
      }).then(() => {
        fetch(`/api/cloths/${clothId}/connections`, {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id: edgeId, from_asset_id: configNodeId, to_asset_id: audioNodeId }),
        }).catch(() => {});
      }).catch(() => {});

      // 3) 轮询
      let attempts = 0;
      const poll = async () => {
        if (attempts > 60) { setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '生成超时' } } : n)); return; }
        attempts++;
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const pres = await fetch(`/api/audio-generations/${recordId}`, { headers: getAuthHeaders() });
          const pdata = await pres.json();
          const record = pdata?.data;
          if (!record) { poll(); return; }
          const resultUrl = record.intermediate_video_url || record.task_video_url;
          if (record.status === 'done' && resultUrl) {
            setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, content: resultUrl, file_url: resultUrl } } : n));
            // 后台自动转 mp3，完成后替换 content 为 blob URL（原生下载即 mp3）
            videoUrlToMp3Blob(resultUrl, {}).then((blob) => {
              const blobUrl = URL.createObjectURL(blob);
              mp3BlobCache.set(resultUrl, { blob, url: blobUrl });
              setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, content: blobUrl } } : n));
            }).catch(() => {
              // 转码失败保留原视频 URL 播放，下载时仍会重试
              setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, content: resultUrl } } : n));
            });
            return;
          }
          if (record.status === 'error') { setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, generateError: record.error_message || '生成失败' } } : n)); return; }
          poll();
        } catch { poll(); }
      };
      poll();
    } catch { setNodes((nds) => nds.map((n) => n.id === audioNodeId ? { ...n, data: { ...n.data, generating: false, generateError: '网络异常' } } : n)); }
  }, [clothId]);

  // ── 注入节点数据：回调、面板状态、配置面板 props ──
  useEffect(() => {
    if (!cloth) return; // 等待画布数据加载完成
    // 所有节点共享的回调（通过 ref 访问最新状态，避免闭包陈旧问题）
    const commonCallbacks = {
      showPromptPanel: false as boolean,
      showVideoPromptPanel: false as boolean,
      showAudioPromptPanel: false as boolean,
      promptProjectId: cloth.project_id,
      onPromptClose: () => setPromptNodeId(null),
      onVideoPromptClose: () => setVideoPromptNodeId(null),
      onAudioPromptClose: () => { setAudioPromptNodeId(null); },
      onAudioPromptLibrary: () => { setPromptLibraryMode('use'); setPromptLibraryOpen(true); },
      onNodeDirty: (nodeId: string) => {
        dirtyNodeIdsRef.current.add(nodeId);
        resetSyncTimer();
      },
      onDoubleClickImage: (nodeId: string) => {
        const nd = nodesRef.current.find((nd2) => nd2.id === nodeId);
        const url = (nd?.data as any)?.content || (nd?.data as any)?.file_url;
        if (url) setPreviewUrl(url);
      },
      // 文本节点 → 创建增强节点
      onScriptToImage: (nodeId: string) => { generateConfigNode(nodeId, 'image'); },
      onScriptToVideo: (nodeId: string) => { generateConfigNode(nodeId, 'video'); },
      // 图片生成
      onPromptGenerating: (nodeId: string, recordId: number, model: string) => {
        const curNode = nodesRef.current.find((nd) => nd.id === nodeId);
        setNodes((nds) => nds.map((nd) =>
          nd.id === nodeId
            ? { ...nd, data: { ...nd.data, content: '', file_url: '', id_of_resource: recordId, model, generating: true } }
            : nd
        ));
        if (curNode && clothId) {
          const nodeType = (curNode.data as any)?.nodeType || curNode.type || 'image';
          fetch(`/api/cloths/${clothId}/assets`, {
            method: 'PUT',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ assets: [{ id: curNode.id, type: nodeType, subtype: model || null, title: (curNode.data as any)?.label || '', pos_x: curNode.position.x, pos_y: curNode.position.y, width: (curNode as any).width || 260, height: (curNode as any).height || 160, id_of_resource: recordId }] }),
          }).catch(() => {});
        }
      },
      onPromptGenerated: async (_nodeId: string, url: string, recordId: number, model: string) => {
        const targetId = promptNodeIdRef.current;
        if (!targetId) return;
        const size = await readImageSize(url);
        const w = size?.width || 260;
        const h = size?.height || 160;
        setNodes((nds2) => nds2.map((n2) => {
          if (n2.id !== targetId) return n2;
          return { ...n2, width: w, height: h, measured: { width: w, height: h }, style: { width: w, height: h }, data: { ...n2.data, content: url, file_url: url, id_of_resource: recordId, model, showPromptPanel: false, generating: false, width: w, height: h } };
        }));
        dirtyNodeIdsRef.current.add(targetId);
        resetSyncTimer();
        requestAnimationFrame(() => { setTimeout(() => rfInstanceRef.current?.updateNodeInternals(targetId), 50); });
        setPromptNodeId(null);
        setVideoPromptNodeId(null);
        setToolbarNodeId(null);
      },
      onPromptError: (nodeId: string, msg: string) => {
        setNodes((nds) => nds.map((nd) => nd.id === nodeId ? { ...nd, data: { ...nd.data, generating: false, generateError: msg } } : nd));
      },
      // 视频生成
      onVideoPromptGenerating: (nodeId: string, recordId: number, model: string) => {
        const curNode = nodesRef.current.find((nd) => nd.id === nodeId);
        setNodes((nds) => nds.map((nd) =>
          nd.id === nodeId
            ? { ...nd, data: { ...nd.data, content: '', file_url: '', id_of_resource: recordId, model, generating: true } }
            : nd
        ));
        if (curNode && clothId) {
          const nodeType = (curNode.data as any)?.nodeType || curNode.type || 'video';
          fetch(`/api/cloths/${clothId}/assets`, {
            method: 'PUT',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ assets: [{ id: curNode.id, type: nodeType, subtype: model || null, title: (curNode.data as any)?.label || '', pos_x: curNode.position.x, pos_y: curNode.position.y, width: (curNode as any).width || 260, height: (curNode as any).height || 160, id_of_resource: recordId }] }),
          }).catch(() => {});
        }
      },
      onVideoPromptGenerated: (_nodeId: string, url: string, recordId: number, model: string) => {
        const targetId = videoPromptNodeIdRef.current;
        if (!targetId) return;
        setNodes((nds2) => nds2.map((n2) => {
          if (n2.id !== targetId) return n2;
          return { ...n2, data: { ...n2.data, content: url, file_url: url, id_of_resource: recordId, model, showVideoPromptPanel: false, generating: false } };
        }));
        dirtyNodeIdsRef.current.add(targetId);
        resetSyncTimer();
        setVideoPromptNodeId(null);
        setToolbarNodeId(null);
      },
      onVideoPromptError: (nodeId: string, msg: string) => {
        setNodes((nds) => nds.map((nd) => nd.id === nodeId ? { ...nd, data: { ...nd.data, generating: false, generateError: msg } } : nd));
      },
      onVideoResized: (nodeId: string, nw: number, nh: number) => {
        if (clothId) {
          const node = nodesRef.current.find((nd) => nd.id === nodeId);
          if (!node) return;
          const d2 = node.data as any;
          const dbType = d2?.dbType || node.type || 'video';
          fetch(`/api/cloths/${clothId}/assets`, {
            method: 'PUT',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ assets: [{ id: nodeId, type: dbType, subtype: d2?.model || null, id_of_resource: d2?.id_of_resource || null, title: d2?.label || '', pos_x: node.position.x, pos_y: node.position.y, width: nw, height: nh }] }),
          }).catch(() => {});
        }
      },
      // 音频生成
      onAudioPromptGenerating: (nodeId: string, recordId: number, model: string, promptText: string) => {
        const curNode = nodesRef.current.find((nd) => nd.id === nodeId);
        setNodes((nds) => nds.map((nd) =>
          nd.id === nodeId
            ? { ...nd, data: { ...nd.data, content: '', file_url: '', id_of_resource: recordId, model, generating: true, audioPrompt: promptText } }
            : nd
        ));
        if (curNode && clothId) {
          fetch(`/api/cloths/${clothId}/assets`, {
            method: 'PUT',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ assets: [{ id: curNode.id, type: curNode.type || 'audio', subtype: model || null, title: (curNode.data as any)?.label || '', pos_x: curNode.position.x, pos_y: curNode.position.y, width: (curNode as any).width || 260, height: (curNode as any).height || 160, id_of_resource: recordId }] }),
          }).catch(() => {});
        }
      },
      onAudioPromptError: (nodeId: string, msg: string) => {
        setNodes((nds) => nds.map((nd) => nd.id === nodeId ? { ...nd, data: { ...nd.data, generating: false, generateError: msg } } : nd));
      },
    };

    setNodes((nds) => nds.map((n) => {
      const nodeType = (n.data as any)?.nodeType || n.type;
      const isConfig = nodeType === 'enhancement' && (n.data as any)?.dbType === 'config';

      // 注入面板状态标志
      (commonCallbacks as any).showPromptPanel = n.id === promptNodeId;
      (commonCallbacks as any).showVideoPromptPanel = n.id === videoPromptNodeId;
      (commonCallbacks as any).showAudioPromptPanel = n.id === audioPromptNodeId;

      // 配置节点：注入完整数据（通用回调 + 配置专用 props）
      if (isConfig) {
        const mode = (n.data as any)?.generationMode || 'image';
        const connectedEdges = edges.filter((e) => e.target === n.id);
        const connectedTextNodes = connectedEdges
          .map((e) => nodesRef.current.find((nd) => nd.id === e.source))
          .filter(Boolean);
        const textCount = connectedTextNodes.filter((nd) => {
          const nt = (nd?.data as any)?.nodeType || nd?.type;
          return (nt === 'script' || nt === 'text') && ((nd?.data as any)?.content || '').trim();
        }).length;
        const imageCount = connectedTextNodes.filter((nd) => (nd?.data as any)?.nodeType === 'image' && (nd?.data as any)?.content).length;
        const videoCount = connectedTextNodes.filter((nd) => (nd?.data as any)?.nodeType === 'video' && (nd?.data as any)?.content).length;
        const audioCount = connectedTextNodes.filter((nd) => (nd?.data as any)?.nodeType === 'audio' && (nd?.data as any)?.content).length;

        const configBase: Record<string, unknown> = {
          ...n.data,
          ...commonCallbacks,
          configInputSummary: { textCount, imageCount, videoCount, audioCount } as ConfigPanelInputSummary,
          configReferences: buildConfigReferences(connectedEdges
            .map((e) => nodesRef.current.find((nd) => nd.id === e.source))
            .filter(Boolean) as Node[]
          ),
          configGenerationMode: mode,
          composerOpen: n.id === composerNodeId,
          onComposerToggle: () => handleComposerToggle(n.id),
          configTheme: {
            fill: C.nodeFill, stroke: C.nodeStroke, text: C.nodeText,
            muted: C.nodeMuted, faint: C.nodeFaint, activeBg: C.selection, blue: C.blue,
          },
          configOnChange: (_nodeId: string, patch: Record<string, unknown>) => {
            // 同步 configGenerationMode / configModel / configAssetsOfAt，确保 PUT 同步时读到最新值
            const fullPatch = { ...patch };
            if ('generationMode' in patch) (fullPatch as any).configGenerationMode = patch.generationMode;
            if ('model' in patch) (fullPatch as any).configModel = patch.model;
            if ('assetsOfAt' in patch) (fullPatch as any).configAssetsOfAt = patch.assetsOfAt;
            setNodes((nds3) => nds3.map((n3) => n3.id === n.id ? { ...n3, data: { ...n3.data, ...fullPatch } } : n3));
            // 同步更新边线 isAudio / configAssetsOfAt 标记（直接操作，无需等 sync effect）
            if ('generationMode' in patch || 'assetsOfAt' in patch) {
              setEdges((eds) => eds.map((e) => {
                if (e.target !== n.id) return e;
                const update: Record<string, unknown> = {};
                if ('generationMode' in patch) update.isAudio = (fullPatch as any).configGenerationMode === 'audio' || undefined;
                if ('assetsOfAt' in patch) update.configAssetsOfAt = (fullPatch as any).configAssetsOfAt;
                return { ...e, data: { ...e.data, ...update } };
              }));
            }
            dirtyNodeIdsRef.current.add(n.id);
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
            syncTimerRef.current = setTimeout(() => { flushSyncRef.current?.(); }, 1000);
          },
          configOnBlur: () => { flushSync(); },
          configOnGenerate: (nodeId2: string, mode2: ConfigGenerationMode, model: string, prompt: string, sizeLabel: string) => {
            flushSync();
            const assetsOfAtRaw = (n.data as any)?.assetsOfAt || (n.data as any)?.configAssetsOfAt || '[]';
            let assetsOfAtList: { id: number; id_of_clothes_asset: number }[] = [];
            try { assetsOfAtList = JSON.parse(assetsOfAtRaw); } catch {}
            const refs = ((n.data as any)?.configReferences || []) as CanvasResourceReference[];
            const { finalPrompt: assembled, refUrls, volcUrls } = assemblePromptForGenerate(prompt, assetsOfAtList, refs);
            if (!assembled) return;
            const isSeedanceModel = (mode2 === 'video' || mode2 === 'audio') && model?.startsWith('seedance');
            const finalPrompt = isSeedanceModel
              ? assembled.replace(/\[Image (\d+)\]/g, '@图片$1').replace(/\[Video (\d+)\]/g, '@视频$1').replace(/\[Audio (\d+)\]/g, '@音频$1')
              : assembled;
            if (mode2 === 'image') { handleGenerateImageFromConfig(nodeId2, finalPrompt, model, sizeLabel, refUrls); }
            else if (mode2 === 'video') { handleGenerateVideoFromConfig(nodeId2, finalPrompt, model, sizeLabel, refUrls, volcUrls); }
            else if (mode2 === 'audio') { handleGenerateAudioFromConfig(nodeId2, finalPrompt, model, sizeLabel, refUrls, volcUrls); }
          },
        };
        return { ...n, data: configBase };
      }

      // 非配置节点：注入通用回调 + 面板状态
      return { ...n, data: { ...n.data, ...commonCallbacks } };
    }));
  }, [promptNodeId, videoPromptNodeId, audioPromptNodeId, cloth?.project_id, C, edges, composerNodeId]);

  const selectedCount = nodes.filter((n) => n.selected).length;

  const handleContentChange = useCallback((nodeId: string, content: string) => {
    setNodes((nds) => nds.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, content } } : n));
    dirtyNodeIdsRef.current.add(nodeId);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      flushSyncRef.current?.();
    }, 1000);
  }, []);

  const handleContentChangeRef = useRef(handleContentChange);
  handleContentChangeRef.current = handleContentChange;
  const onContentChangeWrapper = useCallback((nodeId: string, content: string) => {
    handleContentChangeRef.current(nodeId, content);
  }, []);

  // ── 工具栏操作 ──
  const getViewportCenter = useCallback(() => {
    const rf = rfInstanceRef.current;
    if (rf) {
      const vp = rf.getViewport();
      const cx = (window.innerWidth / 2 - vp.x) / vp.zoom;
      const cy = (window.innerHeight / 2 - vp.y) / vp.zoom;
      return { x: cx - 130, y: cy - 80 };
    }
    return { x: Math.random() * 300 + 100, y: Math.random() * 200 + 100 };
  }, []);

  const handleToolbarAction = useCallback(async (action: ToolbarAction) => {
    if (action === 'deselect') {
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
      return;
    }
    if (action === 'delete-selected') {
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      // 立即删除（不等 debounce）
      for (const id of selectedIds) {
        fetch(`/api/cloths/${clothId}/assets/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {});
      }
      setNodes((nds) => nds.filter((n) => !n.selected));
      setEdges((eds) => {
        const remainingIds = new Set(nodes.filter((n) => !n.selected).map((n) => n.id));
        return eds.filter((e) => remainingIds.has(e.source) && remainingIds.has(e.target));
      });
      return;
    }
    // 添加节点：在视口中心附近随机位置创建
    if (action.startsWith('add-')) {
      const type = action.replace('add-', '') as 'text' | 'image' | 'video' | 'audio' | 'config';
      const id = `${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const runtimeTypes: Record<string, string> = { text: 'script', image: 'image', video: 'video', audio: 'audio', config: 'enhancement' };
      // 文本类型：先创建 canvas_scripts 记录，拿到 id_of_resource
      let idOfResource: number | null = null;
      if (type === 'text') {
        try {
          const r = await fetch('/api/canvas/scripts', {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ content: '', project_id: cloth!.project_id }),
          });
          const d = await r.json();
          if (d.success && d.data?.id) idOfResource = d.data.id;
        } catch {}
      }
      const isTextNode = type === 'text';
      const isConfigNode = type === 'config';
      const nodeWidth = isTextNode ? 340 : isConfigNode ? 336 : 260;
      const nodeHeight = isTextNode ? 240 : isConfigNode ? 240 : 160;
      setNodes((nds) => [...nds, {
        id,
        type: runtimeTypes[type] || 'script',
        position: getViewportCenter(),
        width: nodeWidth,
        height: nodeHeight,
        data: {
          label: '', content: '',
          nodeType: runtimeTypes[type] || 'script',
          dbType: isConfigNode ? 'config' : undefined,
          generationMode: isConfigNode ? 'image' : undefined,
          configGenerationMode: isConfigNode ? 'image' : undefined,
          configPrompt: isConfigNode ? '' : undefined,
          configModel: isConfigNode ? 'nano-banana-2' : undefined,
          id_of_resource: idOfResource, width: nodeWidth, height: nodeHeight,
          onContentChange: onContentChangeWrapper,
        },
        style: { width: nodeWidth, height: nodeHeight },
      }]);
      // 立即保存新节点（不等 debounce）
      const assetType = isConfigNode ? 'config' : (runtimeTypes[type] || 'script');
      const assetPayload: Record<string, unknown> = { id, type: assetType, subtype: null, title: '', pos_x: 0, pos_y: 0, width: nodeWidth, height: nodeHeight, id_of_resource: idOfResource };
      if (isConfigNode) {
        assetPayload.generation_mode = 'image';
        assetPayload.config_model = 'nano-banana-2';
        assetPayload.config_prompt = '';
        assetPayload.config_params = '{}';
      }
      const savePromise = fetch(`/api/cloths/${clothId}/assets`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ assets: [assetPayload] }),
      }).then(async (res) => {
        if (!isConfigNode) return;
        const data = await res.json().catch(() => ({}));
        const savedId = data?.id_of_resource ?? (data?.data?.id_of_resource);
        if (savedId) {
          setNodes((nds) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, id_of_resource: savedId } } : n));
        }
      }).catch(() => {});
      // 不阻塞 UI
      savePromise.catch(() => {});
      return;
    }
    // undo/redo/upload/library/my-assets/style/clear — 暂未实现
    if (action === 'volc-assets') { setPromptLibraryMode('insert'); setPromptLibraryOpen(true); return; }
  }, [handleContentChange, nodes]);

  // 加载画布
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (!clothId) return;
    (async () => {
      try {
        const res = await fetch(`/api/cloths/${clothId}`, { headers: getAuthHeaders() });
        const data = await res.json();
        const currentCloth = data.success ? data.data : null;
        if (data.success) setCloth(currentCloth);
        // 画布不存在（404），跳转到画布列表页
        if (!data.success && !redirectedRef.current) {
          redirectedRef.current = true;
          alert('画布已经删除');
          navigate('/cloth', { replace: true });
          return;
        }
        if (!currentCloth) return;
        const projectId = currentCloth?.project_id;
        const aRes = await fetch(`/api/cloths/${clothId}/assets`, { headers: getAuthHeaders() });
        const aData = await aRes.json();
        if (aData.success) {
          const assets = aData.data as CanvasClothsAsset[];

          // 收集所有 id_of_resource，按类型分批拉取资源内容
          const scriptIds = assets
            .filter((a) => a.type === 'script' && a.id_of_resource)
            .map((a) => a.id_of_resource!);
          const imageIds = assets
            .filter((a) => a.type === 'image' && a.id_of_resource)
            .map((a) => a.id_of_resource!);

          // 批量拉取 canvas_scripts 文本内容
          const scriptMap = new Map<number, string>();
          if (scriptIds.length > 0) {
            try {
              const sRes = await fetch(`/api/canvas/scripts`, { headers: getAuthHeaders() });
              const sData = await sRes.json();
              if (sData.success) {
                for (const s of (sData.data as CanvasScript[])) {
                  if (scriptIds.includes(s.id)) scriptMap.set(s.id, s.content || '');
                }
              }
            } catch {}
          }

          // 批量拉取 image_records 图片 URL + 状态
          const imageMap = new Map<number, string>();
          const imageStatusMap = new Map<number, { status: string; error: string }>();
          if (imageIds.length > 0) {
            try {
              const iRes = await fetch(`/api/image-records?projectId=${projectId}&pageSize=${imageIds.length + 10}`, { headers: getAuthHeaders() });
              const iData = await iRes.json();
              if (iData.success && iData.data?.records) {
                for (const r of (iData.data.records as Array<{ id: number; result_urls: string[]; status: string; error_message?: string }>)) {
                  if (imageIds.includes(r.id)) {
                    if (r.result_urls?.length > 0) imageMap.set(r.id, r.result_urls[0]);
                    imageStatusMap.set(r.id, { status: r.status, error: r.error_message || '' });
                  }
                }
              }
            } catch {}
          }

          // 批量拉取 project_assets URL（imagine_of_volc 类型）
          const volcMap = new Map<number, string>();
          const volcAssetIdMap = new Map<number, string>();
          const volcIds = assets
            .filter((a) => a.type === 'imagine_of_volc' && a.id_of_resource)
            .map((a) => a.id_of_resource!);
          if (volcIds.length > 0 && projectId) {
            try {
              const paRes = await fetch(`/api/project-assets?projectId=${projectId}`, { headers: getAuthHeaders() });
              const paData = await paRes.json();
              if (paData.success && paData.data) {
                for (const pa of paData.data) {
                  if (volcIds.includes(pa.id)) {
                    volcMap.set(pa.id, pa.thumbnail_url || pa.file_url || '');
                    if (pa.volc_asset_id) volcAssetIdMap.set(pa.id, pa.volc_asset_id);
                  }
                }
              }
            } catch {}
          }

          // 视频：按 model 分 tasks（Seedance）和 tasks_happyhorse（HappyHorse），查全部状态
          const videoMap = new Map<number, string>();
          const videoStatusMap = new Map<number, { status: string; error: string }>();
          try {
            const videoAssets = assets.filter((a) => a.type === 'video' && a.id_of_resource);
            const seedanceVideoIds = videoAssets.filter((a) => !(a.subtype || '').startsWith('happyhorse')).map((a) => a.id_of_resource!);
            const happyhorseVideoIds = videoAssets.filter((a) => (a.subtype || '').startsWith('happyhorse')).map((a) => a.id_of_resource!);

            if (seedanceVideoIds.length > 0 && projectId) {
              const vRes = await fetch(`/api/projects/${projectId}/tasks?taskKind=video&pageSize=${seedanceVideoIds.length + 10}`, { headers: getAuthHeaders() });
              const vData = await vRes.json();
              if (vData.success && vData.data) {
                for (const r of vData.data) {
                  if (seedanceVideoIds.includes(r.id)) {
                    if (r.video_url) {
                      const rawUrl = r.video_url;
                      videoMap.set(r.id, rawUrl.startsWith('http') ? `/api/proxy-video?url=${encodeURIComponent(rawUrl)}` : rawUrl);
                    }
                    videoStatusMap.set(r.id, { status: r.status, error: r.error_message || '' });
                  }
                }
              }
            }

            if (happyhorseVideoIds.length > 0) {
              const hhRes = await fetch(`/api/happyhorse-tasks?pageSize=${happyhorseVideoIds.length + 10}`, { headers: getAuthHeaders() });
              const hhData = await hhRes.json();
              if (hhData.success && hhData.data?.items) {
                for (const r of hhData.data.items) {
                  if (happyhorseVideoIds.includes(r.id)) {
                    if (r.video_url) {
                      const rawUrl = r.video_url;
                      videoMap.set(r.id, rawUrl.startsWith('http') ? `/api/proxy-video?url=${encodeURIComponent(rawUrl)}` : rawUrl);
                    }
                    videoStatusMap.set(r.id, { status: r.status, error: r.error_message || '' });
                  }
                }
              }
            }
          } catch { /* 视频加载失败不影响其他节点渲染 */ }

          // 音频：从 audio_generations 回查 URL + 状态
          const audioMap = new Map<number, string>();
          const audioStatusMap = new Map<number, { status: string; error: string }>();
          try {
            const audioAssets = assets.filter((a) => a.type === 'audio' && a.id_of_resource);
            if (audioAssets.length > 0) {
              const audioIds = audioAssets.map((a) => a.id_of_resource!);
              const aRes = await fetch(`/api/audio-generations/list?pageSize=${audioIds.length + 10}`, { headers: getAuthHeaders() });
              const aData = await aRes.json();
              if (aData.success && aData.data?.items) {
                for (const r of aData.data.items) {
                  if (audioIds.includes(r.id)) {
                    if (r.intermediate_video_url) audioMap.set(r.id, r.intermediate_video_url);
                    audioStatusMap.set(r.id, { status: r.status, error: r.error_message || '' });
                  }
                }
              }
            }
          } catch { /* 音频加载失败不影响其他节点渲染 */ }

          setNodes(assets.map((a) => {
            let content = '';
            if (a.type === 'script' && a.id_of_resource) {
              content = scriptMap.get(a.id_of_resource) ?? '';
            } else if (a.type === 'image' && a.id_of_resource) {
              content = imageMap.get(a.id_of_resource) ?? '';
            } else if (a.type === 'video' && a.id_of_resource) {
              content = videoMap.get(a.id_of_resource) ?? '';
            } else if (a.type === 'audio' && a.id_of_resource) {
              content = audioMap.get(a.id_of_resource) ?? '';
            } else if (a.type === 'imagine_of_volc' && a.id_of_resource) {
              content = volcMap.get(a.id_of_resource) ?? '';
            }
            // 根据任务状态决定节点渲染状态
            let generateError: string | undefined;
            let isGenerating = false;
            if (a.id_of_resource && !content) {
              // 查找任务状态
              const st = a.type === 'image' ? imageStatusMap.get(a.id_of_resource)
                : a.type === 'video' ? videoStatusMap.get(a.id_of_resource)
                : a.type === 'audio' ? audioStatusMap.get(a.id_of_resource)
                : null;
              if (st) {
                if (st.status === 'error' || st.status === 'failed') {
                  generateError = st.error || '生成失败';
                } else if (st.status === 'processing' || st.status === 'generating' || st.status === 'pending') {
                  isGenerating = true;
                }
                // status === 'done' but no content → keep empty (shouldn't happen normally)
              } else if (a.type === 'image' || a.type === 'video' || a.type === 'audio') {
                // 任务记录查不到 → 可能正在生成中
                isGenerating = true;
              }
            }
            // imagine_of_volc 渲染为 image；config 渲染为 enhancement（配置面板）
            const renderType = a.type === 'imagine_of_volc' ? 'image' : a.type === 'config' ? 'enhancement' : (a.type || 'script');
            return {
              id: a.id,
              type: a.type === 'config' ? 'enhancement' : (a.type || 'script'),
              position: { x: a.pos_x, y: a.pos_y },
              width: a.width || 260,
              height: a.height || 160,
              data: {
                label: a.title,
                content,
                model: a.subtype || null,
                nodeType: renderType,
                dbType: a.type,
                id_of_resource: a.id_of_resource,
                volcAssetId: a.type === 'imagine_of_volc' && a.id_of_resource ? (volcAssetIdMap.get(a.id_of_resource) || undefined) : undefined,
                width: a.width || 260,
                height: a.height || 160,
                generating: isGenerating,
                generateError: generateError || undefined,
                onContentChange: onContentChangeWrapper,
                // config 类型专属字段
                ...(a.type === 'config' ? (() => {
                  let cp: Record<string,unknown> = {};
                  try { cp = JSON.parse((a as any).config_params || '{}'); } catch {}
                  const mode = (a as any).generation_mode || 'image';
                  const dbModel = (a as any).config_model || '';
                  // 只保留当前模式+模型的参数
                  const clean: Record<string,unknown> = {};
                  if (mode === 'image') {
                    if (dbModel === 'gpt-image-2') {
                      if (cp.size) clean.size = cp.size;
                    } else {
                      if (cp.size) clean.size = cp.size;
                      if (cp.aspectRatio) clean.aspectRatio = cp.aspectRatio;
                      if (cp.quality && cp.quality !== 'auto') clean.quality = cp.quality;
                      if (cp.count && cp.count !== 1) clean.count = cp.count;
                    }
                  } else if (mode === 'video') {
                    if (cp.resolution) clean.size = cp.resolution;
                    if (cp.aspectRatio) clean.ratio = cp.aspectRatio;
                    if (cp.duration) clean.seconds = String(cp.duration);
                  }
                  return {
                    generationMode: mode,
                    configGenerationMode: mode,
                    configPrompt: (a as any).config_prompt || '',
                    configModel: (a as any).config_model || null,
                    configAssetsOfAt: (a as any).config_assets_of_at || '[]',
                    ...clean,
                  };
                })() : {}),
              },
              style: { width: a.width || 260, height: a.height || 160 },
            };
          }));

          const cRes = await fetch(`/api/cloths/${clothId}/connections`, { headers: getAuthHeaders() });
          const cData = await cRes.json();
          if (cData.success) {
            setEdges((cData.data as CanvasClothsConnection[]).map((c) => ({
              id: c.id,
              source: c.from_asset_id,
              target: c.to_asset_id,
              type: 'default',
            })));
          }
        }
      } catch {}
    })();
  }, [clothId]);

  // ── 音频节点后台转 mp3 ──
  useEffect(() => {
    for (const n of nodes) {
      const nt = (n.data as any)?.nodeType;
      const url = (n.data as any)?.content;
      if (nt !== 'audio' || !url || !/^https?:\/\//i.test(url)) continue;
      if (mp3BlobCache.has(url)) {
        // 已有缓存，直接替换 content 为 blob URL
        const entry = mp3BlobCache.get(url)!;
        if ((n.data as any).content !== entry.url) {
          setNodes((nds) => nds.map((nd) => nd.id === n.id ? { ...nd, data: { ...nd.data, content: entry.url } } : nd));
        }
        continue;
      }
      // 后台转码（不 await，不阻塞渲染）
      videoUrlToMp3Blob(url, {}).then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        mp3BlobCache.set(url, { blob, url: blobUrl });
        setNodes((nds) => nds.map((nd) => nd.id === n.id ? { ...nd, data: { ...nd.data, content: blobUrl } } : nd));
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, clothId]);

  // 标题保存
  const handleTitleSave = useCallback(async () => {
    if (!clothId || titleDraft.trim() === (cloth?.title || '').trim()) { setTitleEditing(false); return; }
    try {
      await fetch(`/api/cloths/${clothId}`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: titleDraft.trim() }),
      });
      setCloth((prev) => prev ? { ...prev, title: titleDraft.trim() } : prev);
    } catch {}
    setTitleEditing(false);
  }, [clothId, titleDraft, cloth?.title]);

  // 点击菜单外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t && menuRef.current?.contains(t)) return;
      if (t && menuBtnRef.current?.contains(t)) return;
      setDrawerOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [drawerOpen]);

  // ── 监视器同步器：仅发送脏节点，1s 无操作后触发 ──
  const dirtyNodeIdsRef = useRef<Set<string>>(new Set());
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSyncRef = useRef<(() => void) | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const flushSync = useCallback(async () => {
    const dirtyIds = [...dirtyNodeIdsRef.current];
    dirtyNodeIdsRef.current.clear();
    if (dirtyIds.length === 0 || !clothId) return;
    const currentNodes = nodesRef.current;
    const dirtyNodes = currentNodes.filter((n) => dirtyIds.includes(n.id));
    if (dirtyNodes.length === 0) return;

    // 脚本内容保存
    const scriptNodes = dirtyNodes.filter((n) => (n.type === 'script' || (n.data as any)?.nodeType === 'script'));
    const resourceMap = new Map<string, number>();
    for (const n of scriptNodes) {
      const existingId = (n.data as any)?.id_of_resource as number | undefined;
      const content = (n.data as any)?.content || '';
      if (existingId) {
        await fetch(`/api/canvas/scripts/${existingId}`, {
          method: 'PUT',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ content }),
        }).catch(() => {});
        resourceMap.set(n.id, existingId);
      }
    }

    // 仅发送脏节点（最小操作集）
    const payloadAssets = dirtyNodes.map((n) => {
        const d = n.data as any;
        const dbType = d?.dbType || n.type || d?.nodeType || 'script';
        const idOfResource = resourceMap.get(n.id) ?? d?.id_of_resource ?? null;
        const base: Record<string, unknown> = {
          id: n.id,
          type: dbType,
          subtype: dbType === 'config' ? null : (d?.model || null),
          title: d?.label || '',
          pos_x: n.position.x,
          pos_y: n.position.y,
          width: (n as any).width || (n.style as any)?.width || 260,
          height: (n as any).height || (n.style as any)?.height || 160,
          id_of_resource: idOfResource,
        };
        if (dbType === 'config') {
          base.generation_mode = d?.generationMode || 'image';
          base.config_model = d?.configModel || d?.model || null;
          base.config_prompt = d?.configPrompt || d?.prompt || '';
          base.assets_of_at = d?.assetsOfAt || d?.configAssetsOfAt || '[]';
          // 按模式+模型收集参数
          const gMode = d?.generationMode || 'image';
          const gModel = d?.configModel || d?.model || '';
          const params: Record<string,unknown> = {};
          if (gMode === 'image') {
            if (gModel === 'gpt-image-2') {
              // gpt-image-2 只有宽高比（size 即为比例）
              if (d?.size !== undefined && d?.size !== 'auto') params.size = d.size;
            } else {
              // nano-banana-2
              if (d?.size !== undefined && d?.size !== 'auto') params.size = d.size;
              if (d?.aspectRatio !== undefined && d?.aspectRatio !== 'auto') params.aspectRatio = d.aspectRatio;
              if (d?.quality !== undefined && d?.quality !== 'auto') params.quality = d.quality;
              if (d?.count !== undefined && d?.count !== 1) params.count = d.count;
            }
          } else if (gMode === 'video') {
            if (d?.size !== undefined && d?.size !== 'auto') params.resolution = d.size;
            if (d?.ratio !== undefined && d?.ratio !== 'auto') params.aspectRatio = d.ratio;
            if (d?.seconds !== undefined && d?.seconds !== 'auto') params.duration = parseInt(d.seconds) || 5;
          }
          base.config_params = JSON.stringify(params);
        }
        return base;
      });
    await fetch(`/api/cloths/${clothId}/assets`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ assets: payloadAssets }),
    }).catch(() => {});
  }, [clothId]);
  flushSyncRef.current = flushSync;

  const resetSyncTimer = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(flushSync, 1000);
  }, [flushSync]);

  // 监听 ReactFlow 节点位置变化 → 标记脏节点 + 重置计时器
  const wrappedOnNodesChange = useCallback((changes: any[]) => {
    let hasChange = false;
    for (const c of changes) {
      if (c.type === 'position') {
        dirtyNodeIdsRef.current.add(c.id);
        hasChange = true;
      }
    }
    onNodesChange(changes);
    if (hasChange) resetSyncTimer();
  }, [onNodesChange, resetSyncTimer]);

  // 组件卸载时清理计时器
  useEffect(() => {
    return () => { if (syncTimerRef.current) clearTimeout(syncTimerRef.current); };
  }, []);

  // 按连接点判断重复：同一对 sourceHandle/targetHandle 已有连线则阻止
  const isValidConnection = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!sourceHandle || !targetHandle) return true;
      return !edges.some(
        (e) =>
          (e.source === source && e.target === target && e.sourceHandle === sourceHandle && e.targetHandle === targetHandle) ||
          (e.source === target && e.target === source && e.sourceHandle === targetHandle && e.targetHandle === sourceHandle),
      );
    },
    [edges],
  );

  if (!clothId) return <div className="flex items-center justify-center h-screen text-gray-500">画布 ID 缺失</div>;
  if (!cloth) return <div className="flex items-center justify-center h-screen text-gray-500">加载中...</div>;

  return (
    <div className={`h-screen flex flex-col relative canvas-theme-root ${themeMode === 'dark' ? 'dark' : ''}`} style={{ background: C.bg }}>
      {/* 顶部栏：汉堡菜单 + 标题 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-5">
        <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            ref={menuBtnRef}
            onClick={() => {
              if (!drawerOpen && menuBtnRef.current) {
                const r = menuBtnRef.current.getBoundingClientRect();
                setMenuPos({ left: r.left, top: r.bottom + 8 });
              }
              setDrawerOpen(!drawerOpen);
            }}
            className="grid size-9 place-items-center rounded-full transition hover:bg-white/10"
            style={{ color: C.nodeText }}
            aria-label="打开画布菜单"
          >
            <MenuIcon className="size-5" />
          </button>

          {/* 画布标题（支持双击编辑） */}
          <div className="flex min-w-0 items-center gap-2">
            {titleEditing ? (
              <input
                autoFocus
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') setTitleEditing(false); }}
                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                style={{ color: C.nodeText }}
              />
            ) : (
              <button
                type="button"
                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                onDoubleClick={() => { setTitleDraft(cloth?.title || ''); setTitleEditing(true); }}
                style={{ color: C.nodeText }}
                title="双击修改画布名称"
              >
                {cloth?.title || '未命名画布'}
              </button>
            )}
          </div>
        </div>

        {/* 右侧按钮组 — 复刻原项目 user-status-actions */}
        <div className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="grid size-9 place-items-center rounded-full transition"
            style={{ color: C.nodeText }}
            onMouseEnter={(e) => { e.currentTarget.style.background = themeMode === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title="设置"
            aria-label="设置"
          >
            <SettingsIcon className="size-4" style={{ color: C.nodeText }} />
          </button>
          <ThemeToggler theme={themeMode} onToggle={() => {
            const next = themeMode === 'dark' ? 'light' : 'dark';
            setThemeMode(next);
            document.documentElement.classList.toggle('dark', next === 'dark');
            document.documentElement.style.colorScheme = next;
            // 写入 localStorage（保留完整设置，仅更新 theme 字段）
            try {
              const raw = localStorage.getItem('seedance_canvas_settings');
              const s = raw ? JSON.parse(raw) : {};
              s.theme = next;
              // 确保必要字段存在，防止设置弹窗读取不完整对象崩溃
              if (!s.image_models) s.image_models = ['nano-banana-2', 'gpt-image-2'];
              if (!s.image_default) s.image_default = 'nano-banana-2';
              if (!s.video_models) s.video_models = ['seedance-2.0', 'seedance-2.0-fast', 'happyhorse-1.0-t2v'];
              if (!s.video_default) s.video_default = 'seedance-2.0';
              localStorage.setItem('seedance_canvas_settings', JSON.stringify(s));
            } catch {}
            // 同步到服务器
            try {
              fetch('/api/cloths/settings', {
                method: 'PUT',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ theme: next }),
              }).catch(() => {});
            } catch {}
          }} />
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="grid size-9 place-items-center rounded-full transition"
            title="快捷键"
            aria-label="快捷键"
            style={{ color: C.nodeText }}
            onMouseEnter={(e) => { e.currentTarget.style.background = themeMode === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <Keyboard className="size-4" style={{ color: C.nodeText }} />
          </button>
        </div>
      </div>

      {/* 画布 */}
      <div className="flex-1">
        <CanvasThemeContext.Provider value={C as CType}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={wrappedOnNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeMouseEnter={(_event, node) => {
            setHoveredNodeId(node.id);
            const editingNodeId = nodes.find((n) => !!(n.data as any)?.editMode)?.id;
            if (editingNodeId) {
              // 编辑模式：工具栏锁定在编辑节点上
              keepNodeToolbar(editingNodeId);
            } else {
              keepNodeToolbar(node.id);
            }
          }}
          onNodeMouseLeave={() => {
            setHoveredNodeId(null);
            // 编辑中的节点工具栏不消失
            const editingNode = toolbarNodeId ? nodes.find((n) => n.id === toolbarNodeId) : null;
            if (!(editingNode?.data as any)?.editMode) hideNodeToolbar();
          }}
          onNodeClick={(_event, node) => {
            setClickedNodeId((prev) => prev === node.id ? null : node.id);
            keepNodeToolbar(node.id);
            // 图片节点：点击时显示/切换生图面板
            if ((node.data as any)?.nodeType === 'image') {
              setPromptNodeId((prev) => prev === node.id ? null : node.id);
              setVideoPromptNodeId(null);
            } else if ((node.data as any)?.nodeType === 'video') {
              setVideoPromptNodeId((prev) => prev === node.id ? null : node.id);
              setPromptNodeId(null);
            } else if ((node.data as any)?.nodeType === 'audio') {
              // 音频节点：点击时切换音频生成面板
              setAudioPromptNodeId((prev) => prev === node.id ? null : node.id);
              setPromptNodeId(null);
              setVideoPromptNodeId(null);
            } else {
              setPromptNodeId(null);
              setVideoPromptNodeId(null);
            }
          }}
          onPaneClick={() => {
            flushSync();
            setClickedNodeId(null);
            setPromptNodeId(null);
            setVideoPromptNodeId(null);
            setAudioPromptNodeId(null);
            hideNodeToolbar();
          }}
          onPaneContextMenu={(event) => {
            // 原项目：阻止画布空白区域的浏览器右键菜单；连线右键由 CanvasEdge 处理
            const target = event.target as HTMLElement;
            if (target.closest('[data-node-id]')) return;
            event.preventDefault();
            setEdgeContextMenu(null);
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          proOptions={{ hideAttribution: true }}
          onInit={(instance: any) => {
            rfInstanceRef.current = instance;
            // 恢复上次保存的视口位置
            try {
              const saved = localStorage.getItem(`seedance_viewport_${clothId}`);
              if (saved) {
                const vp = JSON.parse(saved);
                if (typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number') {
                  instance.setViewport(vp, { duration: 0 });
                }
              }
            } catch {}
          }}
          onMoveEnd={() => {
            // 保存视口位置到 localStorage（防抖 500ms）
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
            viewportSaveTimerRef.current = setTimeout(() => {
              const vp = rfInstanceRef.current?.getViewport();
              if (vp && clothId) {
                try { localStorage.setItem(`seedance_viewport_${clothId}`, JSON.stringify({ x: vp.x, y: vp.y, zoom: vp.zoom })); } catch {}
              }
            }, 500);
          }}
          style={{ background: C.bg }}
          connectionLineStyle={{ stroke: C.nodeMuted, strokeWidth: 2, strokeDasharray: '5,5' }}
          defaultEdgeOptions={{ type: 'default' }}
        >
          <CanvasGrid mode={backgroundMode} />

          {/* 可切换小地图 — 移植自 infinite-canvas canvas-mini-map.tsx */}
          {isMiniMapOpen && <CanvasMinimap theme={{ panel: C.panel, panelBorder: C.panelBorder, nodeMuted: C.nodeMuted, activeStroke: themeMode === 'dark' ? '#fafaf9' : '#1c1917' }} />}

          {/* 底部居中菜单栏 — 移植自 infinite-canvas canvas-toolbar.tsx */}
          <CanvasToolbar
            selectedCount={selectedCount}
            canUndo={false}
            canRedo={false}
            onAction={handleToolbarAction}
            themeMode={themeMode}
            backgroundMode={backgroundMode}
            showImageInfo={showImageInfo}
            onThemeModeChange={setThemeMode}
            onBackgroundModeChange={setBackgroundMode}
            onShowImageInfoChange={setShowImageInfo}
          />

          {/* 左下角缩放 dock — 使用 useReactFlow() 确保 fitView/zoomIn/zoomOut 可靠 */}
          <CanvasZoomDock
            theme={{ panel: C.panel, panelBorder: C.panelBorder, nodeFill: C.nodeFill, nodeText: C.nodeText, nodeMuted: C.nodeMuted }}
            isMiniMapOpen={isMiniMapOpen}
            onToggleMiniMap={() => setIsMiniMapOpen(!isMiniMapOpen)}
            onShortcutsOpen={() => setShortcutsOpen(true)}
          />

          {/* 悬浮工具栏 — 复刻原项目 CanvasNodeHoverToolbar */}
          <CanvasNodeHoverToolbar
            themeMode={themeMode}
            node={(toolbarNodeId ? nodes.find((n) => n.id === toolbarNodeId) : null) as any}
            isEditing={toolbarNodeId ? !!((nodes.find((n) => n.id === toolbarNodeId)?.data as any)?.editMode) : false}
            onKeep={() => keepNodeToolbar(toolbarNodeId!)}
            onLeave={() => {
              // 编辑模式下工具栏不消失（防止鼠标移出工具栏区域时误隐藏）
              const editingNode = toolbarNodeId ? nodes.find((n) => n.id === toolbarNodeId) : null;
              if (!(editingNode?.data as any)?.editMode) hideNodeToolbar();
            }}
            onInfo={() => { setInfoNodeId(toolbarNodeId); setToolbarNodeId(null); }}
            onEditText={() => {
              if (!toolbarNodeId) return;
              setNodes((nds) => nds.map((n) => {
                if (n.id !== toolbarNodeId) return n;
                const currentEditMode = !!(n.data as any)?.editMode;
                return { ...n, data: { ...n.data, editMode: currentEditMode ? undefined : true } };
              }));
            }}
            onGenerate={() => {
              if (!toolbarNodeId) return;
              const node = nodes.find((n) => n.id === toolbarNodeId);
              const nodeType = (node?.data as any)?.nodeType;
              if (nodeType === 'script') {
                generateConfigNode(toolbarNodeId, 'image');
              } else if (nodeType === 'video') {
                setVideoPromptNodeId(toolbarNodeId);
              } else {
                setPromptNodeId(toolbarNodeId);
              }
            }}
            onDelete={() => {
              const id = toolbarNodeId;
              if (!id) return;
              // 立即删除（不等 debounce）
              fetch(`/api/cloths/${clothId}/assets/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {});
              setNodes((nds) => nds.filter((n) => n.id !== id));
              setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
              setToolbarNodeId(null);
            }}
            // 图片/视频/音频节点
            onDownload={() => {
              const id = toolbarNodeId;
              if (!id) return;
              const n = nodes.find((nd) => nd.id === id);
              const nodeType = (n?.data as any)?.nodeType;
              const url = (n?.data as any)?.content || (n?.data as any)?.file_url;
              if (!url) return;
              if (nodeType === 'audio') {
                // 如果 content 已是 blob URL（后台已转 mp3），直接 fetch 下载
                if (url.startsWith('blob:')) {
                  fetch(url).then(r => r.blob()).then(blob => {
                    const label = (n?.data as any)?.label || 'audio';
                    downloadBlob(blob, `${label.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.mp3`);
                  }).catch(() => {});
                  return;
                }
                // 否则查缓存（key=原始视频URL）或实时转码
                const cached = mp3BlobCache.get(url);
                if (cached) {
                  const label = (n?.data as any)?.label || 'audio';
                  downloadBlob(cached.blob, `${label.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.mp3`);
                } else {
                  // 实时转码并缓存
                  videoUrlToMp3Blob(url, {}).then(blob => {
                    const blobUrl = URL.createObjectURL(blob);
                    mp3BlobCache.set(url, { blob, url: blobUrl });
                    const label = (n?.data as any)?.label || 'audio';
                    downloadBlob(blob, `${label.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.mp3`);
                  }).catch(() => { window.open(url, '_blank'); });
                }
              } else {
                window.open(url, '_blank');
              }
            }}
            onReplaceImage={() => {
              if (toolbarNodeId) {
                const node = nodes.find((n) => n.id === toolbarNodeId);
                if ((node?.data as any)?.nodeType === 'video') {
                  setVideoAssociateNodeId(toolbarNodeId);
                } else if ((node?.data as any)?.nodeType === 'audio') {
                  setAudioAssociateNodeId(toolbarNodeId);
                } else {
                  setAssociateNodeId(toolbarNodeId);
                }
              }
            }}
            onViewFullImage={() => {
              const id = toolbarNodeId;
              if (!id) return;
              const n = nodes.find((nd) => nd.id === id);
              const url = (n?.data as any)?.content || (n?.data as any)?.file_url;
              if (url) setPreviewUrl(url);
            }}
            onAssociateImage={() => {
              if (toolbarNodeId) setAssociateNodeId(toolbarNodeId);
            }}
            onAssociateVideo={() => {
              if (toolbarNodeId) setVideoAssociateNodeId(toolbarNodeId);
            }}
            onAssociateAudio={() => {
              if (toolbarNodeId) setAudioAssociateNodeId(toolbarNodeId);
            }}
          />

          {/* 快捷键弹窗（复刻 Ant Design Modal 暗色主题） */}
          {shortcutsOpen && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => setShortcutsOpen(false)}>
              {/* 半透明遮罩 */}
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }}
                className="animate-[fadeIn_0.2s_ease-out]" />
              {/* Modal 面板 */}
              <div style={{ 
                position: 'relative', background: C.nodeFill, borderRadius: 8,
                maxWidth: 400, width: '90%', padding: '20px 24px',
                boxShadow: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12), 0 9px 28px 8px rgba(0,0,0,0.05)',
              }} onClick={(e) => e.stopPropagation()}
                className="animate-[modalZoomIn_0.3s_cubic-bezier(0.23,1,0.32,1)]">
                {/* 标题栏 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                  <span style={{ fontSize: 16, fontWeight: 600, color: C.nodeText }}>快捷键</span>
                  <button onClick={() => setShortcutsOpen(false)}
                    className="grid size-7 place-items-center rounded-md hover:bg-white/10 transition-colors"
                    style={{ color: C.nodeFaint, marginRight: -8, marginTop: -4 }}>
                    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
                {/* 内容 */}
                <div className="space-y-3 border-t pt-4 text-sm" style={{ borderColor: C.nodeStroke }}>
                  {[
                    ['拖动画布', '平移视图'],
                    ['滚轮', '缩放画布'],
                    ['Ctrl / Cmd + 拖动', '框选多个节点'],
                    ['Shift / Ctrl / Cmd + 点击', '追加选择节点'],
                    ['Ctrl / Cmd + C / V', '复制 / 粘贴节点'],
                    ['Delete / Backspace', '删除选中'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-4">
                      <span className="text-base font-medium" style={{ color: C.nodeText }}>{label}</span>
                      <span style={{ opacity: 0.6, color: C.nodeText }}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </ReactFlow>
        </CanvasThemeContext.Provider>
      </div>

      {/* 右键菜单 — 复刻原项目 CanvasNodeContextMenu */}
      {nodeContextMenu && (
        <div
          className="fixed z-[100] min-w-[120px] rounded-xl border py-1 shadow-2xl backdrop-blur"
          style={{ left: nodeContextMenu.x, top: nodeContextMenu.y, background: C.panel, borderColor: C.panelBorder, color: C.nodeText }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:opacity-80"
            style={{ color: C.nodeText }}
            onClick={() => {
              const sourceNode = nodes.find((n) => n.id === nodeContextMenu.id);
              if (!sourceNode) { setNodeContextMenu(null); return; }
              const newId = `${sourceNode.type || 'script'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              setNodes((nds) => [...nds, {
                ...sourceNode,
                id: newId,
                position: { x: sourceNode.position.x + 40, y: sourceNode.position.y + 40 },
                selected: false,
                data: { ...sourceNode.data },
              }]);
              // 立即保存复制节点
              fetch(`/api/cloths/${clothId}/assets`, {
                method: 'POST',
                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ assets: [{ id: newId, type: sourceNode.type || (sourceNode.data as any)?.nodeType || 'script', title: (sourceNode.data as any)?.label || '', pos_x: sourceNode.position.x + 40, pos_y: sourceNode.position.y + 40, width: sourceNode.width || 260, height: sourceNode.height || 160, id_of_resource: (sourceNode.data as any)?.id_of_resource ?? null }] }),
              }).catch(() => {});
              setNodeContextMenu(null);
            }}
          >
            复制
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:opacity-80"
            style={{ color: '#ef4444' }}
            onClick={() => {
              const id = nodeContextMenu.id;
              fetch(`/api/cloths/${clothId}/assets/${id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {});
              setNodes((nds) => nds.filter((n) => n.id !== id));
              setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
              setNodeContextMenu(null);
              setToolbarNodeId(null);
            }}
          >
            删除
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:opacity-80"
            style={{ color: C.nodeMuted }}
            onClick={() => setNodeContextMenu(null)}
          >
            取消
          </button>
        </div>
      )}
      {edgeContextMenu && (
        <div
          className="fixed z-[100] min-w-[120px] rounded-xl border py-1 shadow-2xl backdrop-blur"
          style={{ left: edgeContextMenu.x, top: edgeContextMenu.y, background: C.panel, borderColor: C.panelBorder, color: C.nodeText }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:opacity-80"
            style={{ color: '#ef4444' }}
            onClick={() => {
              const edge = edges.find((e) => e.id === edgeContextMenu.id);
              const sourceNode = edge ? nodes.find((n) => n.id === edge.source) : null;
              const targetNode = edge ? nodes.find((n) => n.id === edge.target) : null;
              const configNode = (sourceNode && ((sourceNode.data as any)?.dbType === 'config')) ? sourceNode
                : (targetNode && ((targetNode.data as any)?.dbType === 'config')) ? targetNode
                : null;
              const refNode = configNode === sourceNode ? targetNode : sourceNode;
              // 清理配置卡片的 prompt 和 assetsOfAt
              if (configNode && refNode) {
                const refIdOfResource = (refNode.data as any)?.id_of_resource;
                const assetsOfAtRaw = (configNode.data as any)?.assetsOfAt || (configNode.data as any)?.configAssetsOfAt || '[]';
                let assetsOfAtList: { id: number; id_of_clothes_asset: number }[] = [];
                try { assetsOfAtList = JSON.parse(assetsOfAtRaw); } catch {}
                const removedIdx = assetsOfAtList.find((a) => a.id_of_clothes_asset === refIdOfResource)?.id;
                if (removedIdx !== undefined) {
                  const newList = assetsOfAtList
                    .filter((a) => a.id_of_clothes_asset !== refIdOfResource)
                    .map((a, i) => ({ ...a, id: i + 1 }));
                  const prompt = (configNode.data as any)?.configPrompt || (configNode.data as any)?.prompt || '';
                  let newPrompt = prompt.replace(new RegExp(`@\\[${removedIdx}\\]`, 'g'), '');
                  // 从高到低重编号，用占位符避免冲突
                  for (let n = assetsOfAtList.length; n > removedIdx; n--) {
                    newPrompt = newPrompt.replace(new RegExp(`@\\[${n}\\]`, 'g'), `__RENUM_${n}__`);
                  }
                  for (let n = assetsOfAtList.length; n > removedIdx; n--) {
                    newPrompt = newPrompt.replace(new RegExp(`__RENUM_${n}__`, 'g'), `@[${n - 1}]`);
                  }
                  setNodes((nds) => nds.map((n) => n.id === configNode!.id ? {
                    ...n,
                    data: {
                      ...n.data,
                      assetsOfAt: JSON.stringify(newList),
                      configAssetsOfAt: JSON.stringify(newList),
                      prompt: newPrompt,
                      configPrompt: newPrompt,
                    },
                  } : n));
                }
              }
              setEdges((eds) => eds.filter((e) => e.id !== edgeContextMenu.id));
              fetch(`/api/cloths/${clothId}/connections/${edgeContextMenu.id}`, { method: 'DELETE', headers: getAuthHeaders() }).catch(() => {});
              setEdgeContextMenu(null);
            }}
          >
            删除这条线
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:opacity-80"
            style={{ color: C.nodeMuted }}
            onClick={() => setEdgeContextMenu(null)}
          >
            取消
          </button>
        </div>
      )}
      {/* 点击空白关闭菜单 */}
      {(nodeContextMenu || edgeContextMenu) && (
        <div className="fixed inset-0 z-[99]" onClick={() => { setNodeContextMenu(null); setEdgeContextMenu(null); }} onContextMenu={(e) => { e.preventDefault(); setNodeContextMenu(null); setEdgeContextMenu(null); }} />
      )}

      {/* 节点信息弹窗 — 复刻原项目 CanvasNodeInfoModal */}
      <CanvasNodeInfoModal
        node={infoNodeId ? nodes.find((n) => n.id === infoNodeId) ?? null : null}
        open={Boolean(infoNodeId)}
        onClose={() => setInfoNodeId(null)}
        theme={themeMode}
      />

      {/* 关联图片弹窗 — 展示当前项目的图片生成历史 */}
      <ImageAssociateModal
        open={Boolean(associateNodeId)}
        projectId={cloth!.project_id}
        onClose={() => setAssociateNodeId(null)}
        onSelect={async (record) => {
          if (!associateNodeId) return;
          const url = record.result_urls?.[0] || '';
          const size = await readImageSize(url);
          const w = size?.width || 260;
          const h = size?.height || 160;
          setNodes((nds) => nds.map((n) => {
            if (n.id !== associateNodeId) return n;
            return { ...n, width: w, height: h, measured: { width: w, height: h }, style: { width: w, height: h }, data: { ...n.data, content: url, file_url: url, id_of_resource: record.id, model: record.model, width: w, height: h } };
          }));
          // 强制 ReactFlow 刷新内部尺寸缓存（需等 DOM 渲染完成）
          requestAnimationFrame(() => {
            setTimeout(() => rfInstanceRef.current?.updateNodeInternals(associateNodeId), 50);
          });
          // 标记脏节点，触发 1s 延迟更新
          dirtyNodeIdsRef.current.add(associateNodeId);
          resetSyncTimer();
          setAssociateNodeId(null);
          setToolbarNodeId(null);
        }}
        theme={{
          bg: C.bg,
          panel: C.panel,
          panelBorder: C.panelBorder,
          nodeFill: C.nodeFill,
          nodeText: C.nodeText,
          nodeMuted: C.nodeMuted,
          nodeFaint: C.nodeFaint,
        }}
      />

      {/* 关联视频弹窗 — 双栏：左侧 Seedance / 右侧 HappyHorse */}
      <VideoAssociateModal
        open={Boolean(videoAssociateNodeId)}
        projectId={cloth!.project_id}
        onClose={() => setVideoAssociateNodeId(null)}
        onSelect={(record) => {
          if (!videoAssociateNodeId) return;
          setNodes((nds) => nds.map((n) => {
            if (n.id !== videoAssociateNodeId) return n;
            return { ...n, data: { ...n.data, content: record.video_url, file_url: record.video_url, id_of_resource: record.id, model: record.model } };
          }));
          // 标记脏节点，触发 1s 延迟更新
          dirtyNodeIdsRef.current.add(videoAssociateNodeId);
          resetSyncTimer();
          setVideoAssociateNodeId(null);
          setToolbarNodeId(null);
        }}
        theme={{ bg: C.bg, panel: C.panel, panelBorder: C.panelBorder, nodeFill: C.nodeFill, nodeText: C.nodeText, nodeMuted: C.nodeMuted, nodeFaint: C.nodeFaint }}
      />

      {/* 关联音频弹窗 */}
      <AudioAssociateModal
        open={Boolean(audioAssociateNodeId)}
        projectId={cloth!.project_id}
        onClose={() => setAudioAssociateNodeId(null)}
        onSelect={(record) => {
          if (!audioAssociateNodeId) return;
          setNodes((nds) => nds.map((n) => {
            if (n.id !== audioAssociateNodeId) return n;
            return { ...n, data: { ...n.data, content: record.audio_url, file_url: record.audio_url, id_of_resource: record.id, label: record.voice_prompt || '音频' } };
          }));
          dirtyNodeIdsRef.current.add(audioAssociateNodeId);
          resetSyncTimer();
          setAudioAssociateNodeId(null);
          setToolbarNodeId(null);
        }}
        theme={{ bg: C.bg, panel: C.panel, panelBorder: C.panelBorder, nodeFill: C.nodeFill, nodeText: C.nodeText, nodeMuted: C.nodeMuted, nodeFaint: C.nodeFaint }}
      />

      {/* 火山资产弹窗 — 工具栏触发插入节点，音频面板触发复制链接 */}
      <PromptLibraryModal
        open={promptLibraryOpen}
        projectId={cloth!.project_id}
        mode={promptLibraryMode}
        onClose={() => setPromptLibraryOpen(false)}
        onSelect={promptLibraryMode === 'insert' ? async (asset) => {
          const id = `imvolc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const url = asset.thumbnail_url || asset.file_url;
          const size = await readImageSize(url);
          const maxW = 400;
          const ratio = size ? size.width / size.height : 1.625;
          const w = size ? Math.min(maxW, Math.max(120, size.width)) : 260;
          const h = Math.max(80, Math.round(w / ratio));
          const pos = getViewportCenter();
          setNodes((nds) => [...nds, {
            id,
            type: 'imagine_of_volc',
            position: pos,
            width: w,
            height: h,
            data: {
              label: asset.name,
              content: url,
              nodeType: 'image',
              dbType: 'imagine_of_volc',
              id_of_resource: asset.id,
              width: w,
              height: h,
              onContentChange: onContentChangeWrapper,
            },
            measured: { width: w, height: h },
            style: { width: w, height: h },
          }]);
          fetch(`/api/cloths/${clothId}/assets`, {
            method: 'POST',
            headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ assets: [{ id, type: 'imagine_of_volc', subtype: null, title: asset.name, pos_x: pos.x, pos_y: pos.y, width: w, height: h, id_of_resource: asset.id }] }),
          }).catch(() => {});
        } : (asset) => {
          // 写入音频节点 data
          const aid = audioPromptNodeIdRef.current;
          if (aid) {
            setNodes((nds) => nds.map((n) => n.id === aid ? { ...n, data: { ...n.data, volcAsset: { thumbnail_url: asset.thumbnail_url, file_url: asset.file_url, name: asset.name, volc_asset_id: asset.volc_asset_id } } } : n));
            dirtyNodeIdsRef.current.add(aid);
            resetSyncTimer();
          }
          navigator.clipboard.writeText(asset.file_url || asset.thumbnail_url || '').catch(() => {});
        }}
      />

      {/* 画布设置面板 */}
      <CanvasSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={{ bg: C.bg, panel: C.panel, panelBorder: C.panelBorder, nodeText: C.nodeText, nodeMuted: C.nodeMuted, nodeFaint: C.nodeFaint, blue: C.blue }}
      />

      {/* 大图预览 — 复刻原项目 Modal "图片详情" */}
      <ImagePreviewModal
        open={Boolean(previewUrl)}
        url={previewUrl}
        onClose={() => setPreviewUrl(null)}
      />

      {/* 浮窗下拉菜单（fixed 定位，在 ReactFlow 容器外，backdrop-filter 可正常工作） */}
      {ReactDOM.createPortal(
        (() => {
          const isLight = themeMode === 'light';
          const menuBg = isLight ? '#ffffff' : '#1f1f1f';
          const menuText = isLight ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
          const menuBorder = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)';
          const menuHover = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.08)';
          const menuShadow = isLight
            ? '0 6px 16px rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12), 0 9px 28px 8px rgba(0,0,0,0.05)'
            : '0 6px 16px rgba(0,0,0,0.2), 0 3px 6px -4px rgba(0,0,0,0.3), 0 9px 28px 8px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.04), 0 0 40px rgba(255,255,255,0.02)';
          const menuFaint = isLight ? 'rgba(0,0,0,0.45)' : 'rgba(168,162,158,1)';
          return (
        <div className={`fixed z-50 w-56 rounded-lg p-1 origin-top ${
          drawerOpen ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-90 pointer-events-none'
        }`}
          style={{
            left: menuPos.left, top: menuPos.top,
            background: menuBg,
            boxShadow: menuShadow,
            transition: 'opacity 0.2s cubic-bezier(0.23, 1, 0.32, 1), transform 0.2s cubic-bezier(0.23, 1, 0.32, 1)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onMouseDown={(e) => { e.preventDefault(); window.location.href = '/cloth'; }}
            className="flex items-center gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] transition-colors"
            style={{ color: menuText }}
            onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <FilmIcon className="size-4" />我的画布
          </button>
          <div className="my-1 border-t" style={{ borderColor: menuBorder }} />
          <button onClick={async () => {
            try { const id = 'cloth_' + Date.now().toString(36); const res = await fetch('/api/cloths', { method: 'POST', headers: getAuthHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id, title: '未命名画布', project_id: cloth!.project_id }) }); if (res.ok) navigate(`/cloth/${id}`); } catch {} setDrawerOpen(false);
          }}
            className="flex items-center gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] transition-colors"
            style={{ color: menuText }}
            onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <PlusIcon className="size-4" />新建画布
          </button>
          <button onClick={() => {
            if (confirm('删除此画布？里面的节点和连线也会一起移除。')) { fetch(`/api/cloths/${clothId}`, { method: 'DELETE', headers: getAuthHeaders() }).then(() => navigate('/cloth')); }
            setDrawerOpen(false);
          }}
            className="flex items-center gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] transition-colors"
            style={{ color: isLight ? '#cf1322' : '#dc4446' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = isLight ? '#fff1f0' : '#dc4446'; e.currentTarget.style.color = isLight ? '#cf1322' : '#1f1f1f'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = isLight ? '#cf1322' : '#dc4446'; }}>
            <TrashIcon className="size-4" />删除当前画布
          </button>
          <div className="my-1 border-t" style={{ borderColor: menuBorder }} />
          <button onClick={() => { importRef.current?.click(); setDrawerOpen(false); }}
            className="flex items-center gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] transition-colors"
            style={{ color: menuText }}
            onMouseEnter={(e) => { e.currentTarget.style.background = menuHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
            <FileUpIcon className="size-4" />导入素材
          </button>
          <div className="my-1 border-t" style={{ borderColor: menuBorder }} />
          <button disabled
            className="flex items-center justify-between gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] opacity-40"
            style={{ color: menuText }}>
            <span className="flex items-center gap-3">
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>撤销
            </span>
            <span className="text-xs" style={{ color: menuFaint }}>⌘ Z</span>
          </button>
          <button disabled
            className="flex items-center justify-between gap-3 w-full rounded-md px-3 py-[5px] text-sm leading-[1.5714] opacity-40"
            style={{ color: menuText }}>
            <span className="flex items-center gap-3">
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 15l6-6m0 0l-6-6m6 6H9a6 6 0 000 12h3" /></svg>重做
            </span>
            <span className="text-xs" style={{ color: menuFaint }}>⌘ ⇧ Z</span>
          </button>
        </div>
        );
        })()
      , document.body
      )}
    </div>
  );
}