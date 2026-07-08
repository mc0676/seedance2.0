// 复刻原项目 canvas-node-hover-toolbar.tsx
import { useState, useEffect, type ReactNode } from 'react';
import { Info, Pencil, ImageIcon, Trash2, Download, ImageUp, Eye, Film, Music2 } from 'lucide-react';
import { type Node, useViewport } from '@xyflow/react';

type HoverNode = Node & { data: { nodeType: string; content?: string; file_url?: string } };

interface CanvasNodeHoverToolbarProps {
  node: HoverNode | null;
  isEditing?: boolean;
  onKeep: () => void;
  onLeave: () => void;
  onInfo?: () => void;
  onEditText?: () => void;
  onGenerate?: () => void;
  onDelete?: () => void;
  // 图片节点专属
  onDownload?: () => void;
  onReplaceImage?: () => void;
  onViewFullImage?: () => void;
  onAssociateImage?: () => void;
  onAssociateVideo?: () => void;
  onAssociateAudio?: () => void;
  // 主题
  themeMode?: 'light' | 'dark';
  theme?: {
    panel: string; panelBorder: string; nodeText: string; nodeFill: string; nodeMuted: string;
  };
}

type ToolbarTool = {
  id: string;
  title: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
};

// ── 工具栏按钮 — 复刻原项目 ToolbarAction ──
function ToolAction({ title, label, icon, onClick, danger, active, showLabel, isDark }: ToolbarTool & { showLabel: boolean; isDark: boolean }) {
  const hasText = showLabel && Boolean(label);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`group relative flex h-12 items-center whitespace-nowrap px-1.5 ${danger ? 'text-[#ef4444]' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        className={`flex h-9 items-center rounded-lg transition ${
          hasText ? 'gap-2 px-2.5' : 'justify-center px-2'
        } ${isDark ? 'group-hover:bg-white/10' : 'group-hover:bg-black/5'} ${active ? (isDark ? 'bg-white/15' : 'bg-black/8') : ''}`}
      >
        {icon}
        {hasText ? <span>{label}</span> : null}
      </span>
    </button>
  );
}

// ── 主组件 — 复刻原项目 CanvasNodeHoverToolbar ──
export function CanvasNodeHoverToolbar({
  node, isEditing, onKeep, onLeave,
  onInfo, onEditText, onGenerate: _onGenerate, onDelete,
  onDownload, onReplaceImage, onViewFullImage, onAssociateImage, onAssociateVideo, onAssociateAudio,
  themeMode = 'dark', theme,
}: CanvasNodeHoverToolbarProps) {
  const viewport = useViewport();
  const [showLabel] = useState(true);
  const [, setHovered] = useState(false);

  useEffect(() => {
    if (!node) return;
    const t = setTimeout(() => setHovered(true), 100);
    return () => clearTimeout(t);
  }, [node?.id]);

  if (!node) return null;

  const nodeType = node.data?.nodeType;
  const isText = nodeType === 'script';
  const isImage = nodeType === 'image';
  const isVideo = nodeType === 'video';
  const isAudio = nodeType === 'audio';
  const isEnhancement = nodeType === 'enhancement';
  const hasImage = isImage && !!(node.data?.content || node.data?.file_url);
  const hasVideo = isVideo && !!(node.data?.content || node.data?.file_url);
  const hasAudio = isAudio && !!(node.data?.content || node.data?.file_url);

  // 文本、图片、视频、音频、增强节点显示工具栏
  if (!isText && !isImage && !isVideo && !isAudio && !isEnhancement) return null;

  // 居中于节点上方，viewport 坐标系转换
  const left = viewport.x + (node.position.x + (node.width ?? 260) / 2) * viewport.zoom;
  const top = viewport.y + node.position.y * viewport.zoom - 14;

  let tools: ToolbarTool[] = [];

  if (isText) {
    // 文本节点：信息、编辑文字、删除（生成按钮已在卡片右下角）
    tools = [
      ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
      ...(onEditText ? [{ id: 'editText', title: isEditing ? '退出编辑' : '编辑文本', label: '编辑文字', icon: <Pencil className="size-4" />, onClick: onEditText, active: isEditing }] : []),
      ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
    ];
  } else if (isImage) {
    if (hasImage) {
      // 已关联图片：信息、删除、下载、替换图片、查看大图
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onDownload ? [{ id: 'download', title: '下载图片', label: '下载', icon: <Download className="size-4" />, onClick: onDownload }] : []),
        ...(onReplaceImage ? [{ id: 'replaceImage', title: '替换图片', label: '替换图片', icon: <ImageUp className="size-4" />, onClick: onReplaceImage }] : []),
        ...(onViewFullImage ? [{ id: 'viewFullImage', title: '查看大图', label: '查看大图', icon: <Eye className="size-4" />, onClick: onViewFullImage }] : []),
      ];
    } else {
      // 未关联图片：信息、删除、关联图片
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onAssociateImage ? [{ id: 'associateImage', title: '关联图片', label: '关联图片', icon: <ImageIcon className="size-4" />, onClick: onAssociateImage }] : []),
      ];
    }
  } else if (isVideo) {
    if (hasVideo) {
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onDownload ? [{ id: 'download', title: '下载视频', label: '下载', icon: <Download className="size-4" />, onClick: onDownload }] : []),
        ...(onReplaceImage ? [{ id: 'replaceVideo', title: '替换视频', label: '替换视频', icon: <ImageUp className="size-4" />, onClick: onReplaceImage }] : []),
      ];
    } else {
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onAssociateVideo ? [{ id: 'associateVideo', title: '关联视频', label: '关联视频', icon: <Film className="size-4" />, onClick: onAssociateVideo }] : []),
      ];
    }
  } else if (isAudio) {
    if (hasAudio) {
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onDownload ? [{ id: 'download', title: '下载音频', label: '下载', icon: <Download className="size-4" />, onClick: onDownload }] : []),
        ...(onReplaceImage ? [{ id: 'replaceAudio', title: '替换音频', label: '替换音频', icon: <ImageUp className="size-4" />, onClick: onReplaceImage }] : []),
      ];
    } else {
      tools = [
        ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
        ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
        ...(onAssociateAudio ? [{ id: 'associateAudio', title: '关联音频', label: '关联音频', icon: <Music2 className="size-4" />, onClick: onAssociateAudio }] : []),
      ];
    }
  } else if (isEnhancement) {
    // 增强/配置节点：信息、删除
    tools = [
      ...(onInfo ? [{ id: 'info', title: '查看节点信息', label: '信息', icon: <Info className="size-4" />, onClick: onInfo }] : []),
      ...(onDelete ? [{ id: 'delete', title: '移除节点', label: '删除', icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true }] : []),
    ];
  }

  if (tools.length === 0) return null;

  const isDark = themeMode === 'dark';
  const t = theme || (isDark ? {
    panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c', nodeText: '#f5f5f4', nodeFill: '#292524', nodeMuted: '#d6d3d1',
  } : {
    panel: 'rgba(251,250,247,.96)', panelBorder: '#d6d3ca', nodeText: '#292524', nodeFill: '#e7e5df', nodeMuted: '#78716c',
  });

  return (
    <div
      className="absolute z-[60] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border text-[15px]"
      style={{
        left, top,
        background: t.panel,
        borderColor: t.panelBorder,
        color: t.nodeText,
        boxShadow: isDark ? '0 8px 28px rgba(15,23,42,.12)' : '0 8px 28px rgba(15,23,42,.08)',
      }}
      onMouseEnter={() => { onKeep(); }}
      onMouseLeave={() => { onLeave(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {tools.map((tool) => (
        <ToolAction key={tool.id} {...tool} showLabel={showLabel} isDark={isDark} />
      ))}
    </div>
  );
}
