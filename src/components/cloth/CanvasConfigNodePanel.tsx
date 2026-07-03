// CanvasConfigNodePanel — 复刻 infinite-canvas canvas-config-node-panel.tsx
// 渲染在 enhancement 类型节点内部，提供模型选择、参数配置、生成触发
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Image, Music2, Play, Settings2, Video, ChevronDown, Loader2, Zap, FileText } from 'lucide-react';
import { getCreditBalance, estimatePricing, type CreditBalance, type PricingEstimate } from '../../services/pricingService';
import { estimateHappyhorseCredits, getHappyhorsePricing } from '../../services/happyhorseService';
import type { HappyhorsePricingItem } from '../../types';
import { getAuthHeaders } from '../../services/authService';

// ── 模型列表 ──
const IMAGE_MODELS: Record<string, string> = { 'nano-banana-2': 'Nano Banana 2', 'gpt-image-2': 'GPT-Image-2' };
const VIDEO_MODELS: Record<string, string> = { 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast', 'happyhorse-1.0-t2v': 'HappyHorse 1.0 T2V' };
const AUDIO_MODELS: Record<string, string> = { 'seedance-2.0': 'Seedance 2.0', 'seedance-2.0-fast': 'Seedance 2.0 Fast' };

function readCanvasSettings(): { imageModels: string[]; defaultImageModel: string; videoModels: string[]; defaultVideoModel: string; audioModels: string[]; defaultAudioModel: string } {
  try {
    const raw = localStorage.getItem('seedance_canvas_settings');
    if (raw) {
      const s = JSON.parse(raw);
      return {
        imageModels: (s.image_models || ['nano-banana-2']).filter((m: string) => IMAGE_MODELS[m]),
        defaultImageModel: s.image_default && IMAGE_MODELS[s.image_default] ? s.image_default : (s.image_models?.[0] || 'nano-banana-2'),
        videoModels: (s.video_models || ['seedance-2.0']).filter((m: string) => VIDEO_MODELS[m]),
        defaultVideoModel: s.video_default && VIDEO_MODELS[s.video_default] ? s.video_default : (s.video_models?.[0] || 'seedance-2.0'),
        audioModels: (s.audio_models || ['seedance-2.0-fast']).filter((m: string) => AUDIO_MODELS[m]),
        defaultAudioModel: s.audio_default && AUDIO_MODELS[s.audio_default] ? s.audio_default : (s.audio_models?.[0] || 'seedance-2.0-fast'),
      };
    }
  } catch {}
  return {
    imageModels: Object.keys(IMAGE_MODELS),
    defaultImageModel: 'nano-banana-2',
    videoModels: Object.keys(VIDEO_MODELS),
    defaultVideoModel: 'seedance-2.0',
    audioModels: Object.keys(AUDIO_MODELS),
    defaultAudioModel: 'seedance-2.0-fast',
  };
}

// ── 参数常量 ──
const GPT_ASPECT_OPTIONS = ['1:3','9:21','1:2','9:16','2:3','3:4','1:1','4:3','3:2','16:9','2:1','21:9','3:1','auto'] as const;
const NANO_SIZE_OPTIONS = ['1K','2K','4K'] as const;
const NANO_ASPECT_OPTIONS = ['9:16','2:3','3:4','4:5','1:1','5:4','4:3','3:2','16:9','21:9','auto'] as const;
const IMAGE_QUALITY_OPTIONS = ['auto','standard','hd'] as const;

function ratioWH(r: string): { w: number; h: number } {
  const parts = r.split(':');
  if (parts.length === 2) { const w = parseInt(parts[0], 10); const h = parseInt(parts[1], 10); if (w > 0 && h > 0) return { w, h }; }
  return { w: 1, h: 1 };
}

function ratioPreviewW(r: string): string {
  const { w, h } = ratioWH(r);
  if (w >= h) return '26px';
  return `${Math.round(26 * w / h)}px`;
}
function ratioPreviewH(r: string): string {
  const { w, h } = ratioWH(r);
  if (h >= w) return '26px';
  return `${Math.round(26 * h / w)}px`;
}

function qualityLabel(q: string) { return q === 'auto' ? '自动' : q === 'standard' ? '标清' : '高清'; }

const MODEL_PARAMS_PREFIX = 'seedance_model_params_';
function readModelParams(nodeId: string): Record<string, Record<string, unknown>> {
  try { return JSON.parse(localStorage.getItem(MODEL_PARAMS_PREFIX + nodeId) || '{}'); } catch { return {}; }
}
function writeModelParams(nodeId: string, v: Record<string, Record<string, unknown>>) {
  localStorage.setItem(MODEL_PARAMS_PREFIX + nodeId, JSON.stringify(v));
}

// ── 主题 ──
export interface ConfigPanelTheme { fill: string; stroke: string; text: string; muted: string; faint: string; activeBg: string; blue: string; }
export interface ConfigPanelInputSummary { textCount: number; imageCount: number; videoCount: number; audioCount: number; }
export type ConfigGenerationMode = 'image' | 'text' | 'video' | 'audio';

// ── @ 引用资源类型 ──
export type CanvasResourceKind = 'image' | 'video' | 'audio' | 'text';
export interface CanvasResourceReference {
  nodeId: string;
  kind: CanvasResourceKind;
  label: string;
  title: string;
  text?: string;
  previewUrl?: string;
  idOfResource?: number;
  isVolcano?: boolean;
  volcAssetUri?: string;  // 火山资产提交用 asset:// 格式
}
const REFERENCE_PATTERN = /@\[(\d+)\]/g;

export interface ConfigPanelProps {
  nodeId: string;
  projectId: number;
  generationMode: ConfigGenerationMode;
  inputSummary: ConfigPanelInputSummary;
  theme: ConfigPanelTheme;
  references?: CanvasResourceReference[];
  initialPrompt?: string;
  initialModel?: string | null;
  initialSize?: string;
  initialRatio?: string;
  initialSeconds?: string;
  initialAssetsOfAt?: string;  // JSON: [{"id":1,"id_of_clothes_asset":42},...]
  composerOpen?: boolean;
  onConfigChange: (nodeId: string, patch: Record<string, unknown>) => void;
  onGenerate: (nodeId: string, mode: ConfigGenerationMode, model: string, prompt: string, sizeLabel: string) => void;
  onBlur?: () => void;
  onComposerToggle?: () => void;
  isRunning?: boolean;
}

// ── Segmented 切换 ──
function SegmentedSwitch({ value, onChange, theme }: { value: string; onChange: (v: string) => void; theme: ConfigPanelTheme }) {
  const items = [
    { value: 'image', icon: <Image className="size-3.5" />, label: '图片' },
    { value: 'video', icon: <Video className="size-3.5" />, label: '视频' },
    { value: 'audio', icon: <Music2 className="size-3.5" />, label: '音频' },
  ];
  // 根据文字明暗判断主题：暗色文字(#2...)→浅色背景，亮色文字(#f...)→深色背景
  const isLight = theme.text < '#888';
  const trackBg = isLight ? '#f5f5f5' : '#000';
  const activeBg = isLight ? '#ffffff' : '#1f1f1f';
  const activeText = isLight ? 'rgba(0,0,0,.88)' : 'rgba(255,255,255,.85)';
  const inactiveText = isLight ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.65)';
  return (
    <div className="flex rounded-md p-0.5" style={{ background: trackBg }}>
      {items.map((item) => {
        const active = value === item.value;
        return (
          <button key={item.value} type="button"
            className="inline-flex h-[22px] w-[60px] items-center justify-center gap-1 rounded-[5px] px-[7px] text-[11px] font-normal transition"
            style={{
              background: active ? activeBg : 'transparent',
              color: active ? activeText : inactiveText,
            }}
            onMouseDown={(e) => e.stopPropagation()} onClick={() => onChange(item.value)}>
            {item.icon}{item.label}
          </button>
        );
      })}
    </div>
  );
}

// ── InputChip ──
function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
  return (
    <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
      <span>{label}</span><span className="font-medium">{value}</span>
    </div>
  );
}

// ── SizePreview ──
function SizePreview({ w, h, color }: { w: number; h: number; color: string }) {
  if (!w || !h) return null;
  const long = Math.max(w, h);
  const pw = Math.max(10, Math.round((w / long) * 26));
  const ph = Math.max(10, Math.round((h / long) * 26));
  return <span className="rounded-[3px] border-2" style={{ width: pw, height: ph, borderColor: color }} />;
}

// ── 参数弹出框（独立 Portal，复刻 infinite-canvas Popover 定位）──
function SettingsPopover({ open, btnRect, mode, model, size, quality, count, ratio, seconds, theme, onClose, onChange }: {
  open: boolean; btnRect: DOMRect | null; mode: string; model: string; size: string; quality: string;
  count: number; ratio: string; seconds: string; theme: ConfigPanelTheme; onClose: () => void; onChange: (patch: Record<string, unknown>) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    // 捕获阶段监听，确保拖动画布/点击任意位置时菜单消失
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('mousedown', handler, true);
    return () => {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('mousedown', handler, true);
    };
  }, [open, onClose]);

  if (!open || !btnRect) return null;

  const panelW = 320;
  const gap = 6;
  const top = btnRect.top - gap;
  const left = Math.max(12, Math.min(window.innerWidth - panelW - 12, btnRect.right - panelW));

  return createPortal(
    <div ref={panelRef}
      className="fixed z-[9999] rounded-2xl border p-4 shadow-[0_18px_54px_rgba(28,25,23,.25)] space-y-4"
      style={{
        background: theme.fill, borderColor: theme.stroke, color: theme.text,
        width: panelW, bottom: window.innerHeight - top, left,
        maxHeight: Math.max(260, btnRect.top - 24), overflowY: 'auto',
      }}
      onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
    >
      {mode === 'image' && model === 'gpt-image-2' && (
        <div className="space-y-2.5">
          <div className="text-xs font-medium" style={{ color: theme.muted }}>宽高比</div>
          <div className="grid grid-cols-7 gap-1.5">
            {GPT_ASPECT_OPTIONS.map((r) => (
              <button key={r} type="button"
                className="flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[10px] transition hover:opacity-80"
                style={{ borderColor: r === ratio ? theme.text : theme.stroke, background: r === ratio ? theme.activeBg : 'transparent' }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onChange({ size: r })}>
                <SizePreview {...(r === 'auto' ? { w: 0, h: 0 } : ratioWH(r))} color={r === ratio ? theme.text : theme.stroke} />
                <span className="leading-none">{r === 'auto' ? '自动' : r}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === 'image' && model !== 'gpt-image-2' && (
        <>
          <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.muted }}>尺寸</div>
            <div className="flex gap-2">
              {NANO_SIZE_OPTIONS.map((s) => (
                <button key={s} type="button" onMouseDown={(e) => e.stopPropagation()}
                  className="rounded-full border px-3 py-1 text-xs transition hover:opacity-80"
                  style={{ borderColor: s === size ? theme.text : theme.stroke, color: s === size ? theme.text : theme.muted }}
                  onClick={() => onChange({ size: s })}>{s}</button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.muted }}>宽高比</div>
            <div className="grid grid-cols-6 gap-1.5">
              {NANO_ASPECT_OPTIONS.map((r) => (
                <button key={r} type="button"
                  className="flex flex-col items-center gap-0.5 rounded-lg border px-1 py-1.5 text-[10px] transition hover:opacity-80"
                  style={{ borderColor: r === ratio ? theme.text : theme.stroke, background: r === ratio ? theme.activeBg : 'transparent' }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onChange({ aspectRatio: r })}>
                  <SizePreview {...(r === 'auto' ? { w: 0, h: 0 } : ratioWH(r))} color={r === ratio ? theme.text : theme.stroke} />
                  <span className="leading-none">{r === 'auto' ? '自动' : r}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {mode === 'video' && (
        (() => {
          const isHH = model?.startsWith('happyhorse');
          const isFast = model?.includes('fast');
          const resOptions = isHH ? ['720P','1080P'] : ['480p','720p','1080p'];
          const ratioOptions = isHH
            ? ['9:16','3:4','4:5','1:1','5:4','4:3','16:9']
            : ['9:16','3:4','1:1','4:3','16:9','21:9'];
          const durStart = isHH ? 3 : 4;
          const durCount = isHH ? 13 : 12;
          return (
        <>
          <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.muted }}>分辨率</div>
            <div className="grid grid-cols-3 gap-2.5">
              {resOptions.map((r) => {
                const disabled = r === '1080p' && isFast;
                return (
                  <button key={r} type="button" disabled={disabled}
                    className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
                    style={{ background: 'transparent', borderColor: r === size ? theme.text : theme.stroke, color: r === size ? theme.text : theme.muted }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => { if (!disabled) onChange({ size: r }); }}>
                    {r}
                  </button>
                );
              })}
            </div>
            {isFast && !isHH && (
              <div className="text-[11px] leading-4 opacity-55">fast 模型不支持 1080p，会自动使用 720p。</div>
            )}
          </div>
          <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.muted }}>比例</div>
            <div className="grid grid-cols-3 gap-2.5">
              {ratioOptions.map((r) => (
                <button key={r} type="button"
                  className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                  style={{ borderColor: r === ratio ? theme.text : theme.stroke, color: r === ratio ? theme.text : theme.muted }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => { onChange({ ratio: r }); }}>
                  <span className="rounded-[3px] border-2" style={{ width: ratioPreviewW(r), height: ratioPreviewH(r), borderColor: r === ratio ? theme.text : theme.stroke }} />
                  <span>{r}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.muted }}>时长</div>
            <div className="grid grid-cols-4 gap-2.5">
              {Array.from({length: durCount}, (_, i) => i + durStart).map((d) => (
                <button key={d} type="button"
                  className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
                  style={{ background: 'transparent', borderColor: String(d) === seconds ? theme.text : theme.stroke, color: String(d) === seconds ? theme.text : theme.muted }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => onChange({ seconds: String(d) })}>{d}s</button>
              ))}
            </div>
          </div>
        </>
          );
        })()
      )}
    </div>,
    document.body,
  );
}

// ══════════════════════════════════════════════
// @ 引用菜单 + DOM 辅助函数
// ══════════════════════════════════════════════

function MentionMenu({ refs, activeIndex, theme, disabledKinds, disabledNodeIds, onSelect }: {
  refs: CanvasResourceReference[]; activeIndex: number; theme: ConfigPanelTheme;
  disabledKinds?: Set<CanvasResourceKind>;
  disabledNodeIds?: Set<string>;
  onSelect: (ref: CanvasResourceReference) => void;
}) {
  const selectedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const active = menu.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (refs.length === 0) return null;

  const icons: Record<string, ReactNode> = {
    image: <Image className="size-4" />,
    video: <Video className="size-4" />,
    audio: <Music2 className="size-4" />,
    text: <FileText className="size-4" />,
  };

  const renderPreview = (ref: CanvasResourceReference) => {
    if (ref.kind === 'image' && ref.previewUrl) {
      return <img src={ref.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
    }
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-black/10">
        {icons[ref.kind]}
      </span>
    );
  };

  return (
    <div ref={menuRef} data-mention-menu="true"
      className="absolute left-2 z-[90] max-h-56 w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl"
      style={{ top: 'calc(100% + 6px)', background: theme.text < '#888' ? 'rgba(251,250,247,.96)' : 'rgba(31,29,26,.96)', borderColor: theme.stroke, color: theme.text }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDownCapture={(e) => e.stopPropagation()}
    >
      {refs.map((ref, i) => {
        const isDisabled = disabledKinds?.has(ref.kind) || disabledNodeIds?.has(ref.nodeId);
        return (
        <button key={ref.nodeId} type="button" disabled={isDisabled}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition"
          style={{
            background: i === activeIndex && !isDisabled ? theme.activeBg : 'transparent',
            color: isDisabled ? 'rgba(255,255,255,0.2)' : i === activeIndex ? theme.text : theme.muted,
            cursor: isDisabled ? 'not-allowed' : 'pointer',
          }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (!selectedRef.current && !isDisabled) { selectedRef.current = true; onSelect(ref); } }}
        >
          <span style={{ opacity: isDisabled ? 0.3 : 1 }}>{renderPreview(ref)}</span>
          <span className="min-w-0 flex-1" style={{ opacity: isDisabled ? 0.3 : 1 }}>
            <span className="block font-medium">{ref.label}</span>
            <span className="block truncate opacity-65">{ref.text || ref.title}</span>
          </span>
        </button>
        );
      })}
    </div>
  );
}

// ── 创建引用 Chip（DOM 操作）──
function createReferenceChip(ref: CanvasResourceReference, refIdx: number, theme: ConfigPanelTheme): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.referenceIdx = String(refIdx);
  chip.dataset.referenceNodeId = ref.nodeId;
  if (ref.idOfResource) chip.dataset.referenceAssetId = String(ref.idOfResource);
  if (ref.isVolcano) chip.dataset.isVolcano = 'true';
  const baseStyle = {
    background: theme.fill,
    borderColor: theme.stroke,
    color: theme.text,
    cursor: 'default',
    verticalAlign: 'middle',
  } as CSSProperties;

  if (ref.kind === 'image' && ref.previewUrl) {
    // 图片引用：显示缩略图
    chip.className = 'mx-px inline-flex size-6 items-center justify-center overflow-hidden rounded align-middle select-none';
    Object.assign(chip.style, { ...baseStyle, borderWidth: '1px', borderStyle: 'solid' });
    const img = document.createElement('img');
    img.src = ref.previewUrl;
    img.alt = ref.title;
    img.className = 'size-6 rounded object-cover';
    chip.appendChild(img);
    chip.title = ref.text || ref.title;
  } else if (ref.kind === 'text' && ref.text) {
    // 文本引用：显示截断文本
    chip.className = 'mx-px inline-flex h-7 max-w-40 items-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle select-none';
    Object.assign(chip.style, baseStyle);
    const text = document.createElement('span');
    text.className = 'block truncate';
    text.textContent = ref.text;
    chip.appendChild(text);
    chip.title = ref.text;
  } else {
    // 其他类型：显示标签
    chip.className = 'mx-px inline-flex h-7 max-w-40 items-center justify-center overflow-hidden rounded-md border px-1 text-xs leading-none align-middle select-none';
    Object.assign(chip.style, baseStyle);
    chip.textContent = ref.label;
    chip.title = ref.text || ref.title;
  }
  return chip;
}

// ── 序列化 editor 为 @[idx] 格式，同时构建 assets_of_at ──
function serializeEditor(editor: HTMLElement, refsList: CanvasResourceReference[]): { prompt: string; assetsOfAt: { id: number; id_of_clothes_asset: number }[] } {
  let prompt = '';
  const atMap = new Map<number, number>(); // idx → idOfResource
  const refByNodeId = new Map(refsList.filter(r => r.idOfResource).map(r => [r.nodeId, r.idOfResource!]));

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) { prompt += node.textContent || ''; return; }
    if (node instanceof HTMLElement && node.dataset.referenceIdx) {
      const idx = parseInt(node.dataset.referenceIdx, 10);
      const nodeId = node.dataset.referenceNodeId;
      if (nodeId && refByNodeId.has(nodeId)) {
        atMap.set(idx, refByNodeId.get(nodeId)!);
      }
      prompt += `@[${idx}]`;
      return;
    }
    if (node instanceof HTMLElement) {
      node.childNodes.forEach(walk);
    }
  }
  editor.childNodes.forEach(walk);

  const assetsOfAt: { id: number; id_of_clothes_asset: number }[] = [];
  atMap.forEach((assetId, idx) => assetsOfAt.push({ id: idx, id_of_clothes_asset: assetId }));
  assetsOfAt.sort((a, b) => a.id - b.id);

  return { prompt, assetsOfAt };
}

// ── 光标前的文本（用于 @ 检测）──
function textBeforeCaret(root: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return '';
  const range = sel.getRangeAt(0).cloneRange();
  range.setStart(root, 0);
  return range.toString();
}

// ── 解析 @[idx] token 并重建 DOM，根据 assets_of_at 验证存活性 ──
function rebuildEditorContent(
  editor: HTMLElement,
  value: string,
  references: CanvasResourceReference[],
  assetsOfAt: { id: number; id_of_clothes_asset: number }[],
  validAssetIds: Set<number>,
  theme: ConfigPanelTheme
) {
  // 构建 assets_of_at 查找表：idx → id_of_clothes_asset
  const atMap = new Map<number, number>();
  for (const a of assetsOfAt) atMap.set(a.id, a.id_of_clothes_asset);

  // 按 id_of_resource 查找 reference（用于渲染 chip 时获取 label/preview 等）
  const refByAssetId = new Map<number, CanvasResourceReference>();
  for (const r of references) {
    if (r.idOfResource) refByAssetId.set(r.idOfResource, r);
  }

  editor.innerHTML = '';
  let lastIdx = 0;
  for (const m of value.matchAll(REFERENCE_PATTERN)) {
    if (m.index === undefined) continue;
    if (m.index > lastIdx) editor.appendChild(document.createTextNode(value.slice(lastIdx, m.index)));
    const idx = parseInt(m[1], 10);
    const assetId = atMap.get(idx);
    if (assetId && validAssetIds.has(assetId)) {
      // 素材仍存在：渲染 chip
      const ref = refByAssetId.get(assetId);
      if (ref) {
        editor.appendChild(createReferenceChip(ref, idx, theme));
      } else {
        editor.appendChild(document.createTextNode(m[0]));
      }
    } else {
      // 素材已删除：渲染为纯文本 @[idx]
      editor.appendChild(document.createTextNode(m[0]));
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < value.length) editor.appendChild(document.createTextNode(value.slice(lastIdx)));
  // 恢复光标到末尾
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// ── 删除 chip 及其后的空格 ──
function removeChipWithTrailingSpace(chip: HTMLElement) {
  const next = chip.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE && (next.textContent || '').trim() === '') {
    next.remove();
  }
  chip.remove();
}

// ── Backspace/Delete 时删除相邻 @ 引用 Chip ──
function deleteAdjacentReference(key: string): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const target = adjacentReferenceNode(range, key);
  if (!target) return false;
  const nextCaretNode = document.createTextNode('');
  target.replaceWith(nextCaretNode);
  range.setStart(nextCaretNode, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function adjacentReferenceNode(range: Range, key: string): HTMLElement | null {
  const container = range.startContainer;
  const offset = range.startOffset;
  const previous = key === 'Backspace';
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent || '';
    if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
    return findReferenceSibling(container, previous);
  }
  const children = Array.from(container.childNodes);
  return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, true);
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
  let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
  while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || '').trim()) {
    current = previous ? current.previousSibling : current.nextSibling;
  }
  return current instanceof HTMLElement && current.dataset.referenceIdx ? current : null;
}

// ══════════════════════════════════════════════
// 主组件
// ══════════════════════════════════════════════
export function CanvasConfigNodePanel({
  nodeId, projectId, generationMode: initialMode, inputSummary, theme,
  references, initialPrompt, initialModel, initialSize, initialRatio, initialSeconds, initialAssetsOfAt, composerOpen, onConfigChange, onGenerate, onBlur, onComposerToggle, isRunning,
}: ConfigPanelProps) {
  const t = theme;
  const chipStyle: CSSProperties = { background: t.fill, borderColor: t.stroke, color: t.text };

  const settings = readCanvasSettings();
  const [mode, setMode] = useState<ConfigGenerationMode>(initialMode);
  useEffect(() => { setMode(initialMode); }, [initialMode]);

  // ── 模型 ──
  const resolveDefaultModel = (m: ConfigGenerationMode) => m === 'video' ? settings.defaultVideoModel : m === 'audio' ? settings.defaultAudioModel : settings.defaultImageModel;
  const [model, setModelState] = useState<string>(initialModel || resolveDefaultModel(initialMode));
  const [modelOpen, setModelOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // 音频模式：模型+参数从服务端 /api/audio-generations/config 拉取，确保与音频面板一致
  const [serverAudioConfig, setServerAudioConfig] = useState<{ model: string; ratio: string; resolution: string; duration: number } | null>(null);
  useEffect(() => {
    if (mode !== 'audio') return;
    let alive = true;
    fetch('/api/audio-generations/config', { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => {
        if (alive && d.success && d.data?.model) {
          setServerAudioConfig(d.data);
          setModelState(d.data.model);
          onConfigChange(nodeId, { generationMode: 'audio', model: d.data.model });
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [mode, nodeId]);

  // ── 参数 ──
  const [gptAspect, setGptAspect] = useState<string>('1:1');
  const [nanoSize, setNanoSize] = useState<string>('1K');
  const [nanoAspect, setNanoAspect] = useState<string>('1:1');
  const [quality, setQuality] = useState<string>('auto');
  const [imgCount, setImgCount] = useState<number>(1);
  const [videoSecs, setVideoSecs] = useState<string>(initialSeconds || '5');
  const [videoRatio, setVideoRatio] = useState<string>(initialRatio || '16:9');
  const [videoRes, setVideoRes] = useState<string>(initialSize || '720p');

  // 首次加载时，将 DB 参数写入 localStorage，确保切模型后能恢复
  useEffect(() => {
    if (initialModel && (initialSize || initialRatio || initialSeconds)) {
      const saved = readModelParams(nodeId);
      if (!saved[initialModel]) {
        const params: Record<string, unknown> = {};
        if (initialSize) params.size = initialSize;
        if (initialRatio) params.ratio = initialRatio;
        if (initialSeconds) params.seconds = initialSeconds;
        saved[initialModel] = params;
        writeModelParams(nodeId, saved);
      }
    }
  }, [initialModel, initialSize, initialRatio, initialSeconds, nodeId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBtnRect, setSettingsBtnRect] = useState<DOMRect | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const [prompt, setPromptText] = useState(initialPrompt || '');
  useEffect(() => { setPromptText(initialPrompt || ''); }, [initialPrompt]);

  // composer 打开时，从 prompt 重建编辑器内容
  useEffect(() => {
    if (composerOpen && prompt && editorRef.current) {
      requestAnimationFrame(() => {
        if (refsList.length > 0) {
          rebuildEditorContent(editorRef.current!, prompt, refsList, assetsOfAt, validAssetIds, t);
        } else {
          // 独立配置卡片（无引用素材）：直接设置纯文本
          editorRef.current!.textContent = prompt;
        }
      });
    }
  }, [composerOpen]);

  // ── @ 引用状态 ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const refsList = (references || []).filter((r) => r.label);

  // ── assets_of_at 状态 ──
  const [assetsOfAt, setAssetsOfAt] = useState<{ id: number; id_of_clothes_asset: number }[]>(() => {
    try { return JSON.parse(initialAssetsOfAt || '[]'); } catch { return []; }
  });
  useEffect(() => {
    try { setAssetsOfAt(JSON.parse(initialAssetsOfAt || '[]')); } catch { setAssetsOfAt([]); }
  }, [initialAssetsOfAt]);

  // 当前画布上仍存在的素材 ID 集合（用于判断 @ 引用是否失效）
  const validAssetIds = useMemo(() => {
    const s = new Set<number>();
    for (const r of refsList) { if (r.idOfResource) s.add(r.idOfResource); }
    return s;
  }, [refsList]);

  // ── 音频模式切换：自动清除非火山 @ chip 和多余火山 @ chip ──
  const prevModeRef = useRef(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === mode) return;
    if (mode !== 'audio') return;

    const editor = editorRef.current;
    if (!editor) return;

    // 1) 清除非火山素材 chip
    const allChips = editor.querySelectorAll('[data-reference-idx]');
    allChips.forEach((chip) => {
      const nodeId = (chip as HTMLElement).dataset.referenceNodeId;
      const ref = refsList.find(r => r.nodeId === nodeId);
      if (ref && ref.kind !== 'text' && !ref.isVolcano) {
        removeChipWithTrailingSpace(chip as HTMLElement);
      }
    });

    // 2) 火山 chip 只保留第 1 个
    let volcCount = 0;
    editor.querySelectorAll('[data-reference-idx][data-is-volcano="true"]').forEach((chip) => {
      volcCount++;
      if (volcCount > 1) removeChipWithTrailingSpace(chip as HTMLElement);
    });
  }, [mode, refsList]);

  // ── 音频模式：输入框 @ 输入时自动清除非火山 @（不等待菜单选择）──
  const handleComposerInputAudio = useCallback(() => {
    if (mode !== 'audio') return;
    const editor = editorRef.current;
    if (!editor) return;
    // 延迟执行，让浏览器先完成输入
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      // 扫描非火山 chips 并清除
      const allChips = editor.querySelectorAll('[data-reference-idx]');
      allChips.forEach((chip) => {
        const nodeId = (chip as HTMLElement).dataset.referenceNodeId;
        const ref = refsList.find(r => r.nodeId === nodeId);
        if (ref && ref.kind !== 'text' && !ref.isVolcano) {
          removeChipWithTrailingSpace(chip as HTMLElement);
        }
      });
      // 火山 chip 只保留 1 个
      let volcCount = 0;
      editor.querySelectorAll('[data-reference-idx][data-is-volcano="true"]').forEach((chip) => {
        volcCount++;
        if (volcCount > 1) removeChipWithTrailingSpace(chip as HTMLElement);
      });
    });
  }, [mode, refsList]);

  // ── 积分 ──
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const refreshBalance = useCallback(async () => { try { setBalance(await getCreditBalance()); } catch {} }, []);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);
  // 生成中实时轮询余额（锁定积分会随生成进度变化）
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = isRunning;
    if (isRunning) {
      refreshBalance(); // 开始生成时立即刷新
      const timer = setInterval(() => { refreshBalance(); }, 5000);
      return () => clearInterval(timer);
    }
    // 生成刚结束时也刷新一次（积分已结算）
    if (wasRunning && !isRunning) {
      refreshBalance();
    }
  }, [isRunning, refreshBalance]);

  const [estimate, setEstimate] = useState<PricingEstimate | null>(null);
  const [hhPricing, setHhPricing] = useState<HappyhorsePricingItem[] | null>(null);
  useEffect(() => { getHappyhorsePricing().then(setHhPricing).catch(() => setHhPricing([])); }, []);
  const isHHModel = model?.startsWith('happyhorse');
  useEffect(() => {
    // 图片模式无需实时估价
    if (mode === 'image') { setEstimate(null); return; }
    // 音频模式：使用 serverAudioConfig 参数估算
    if (mode === 'audio') {
      if (!serverAudioConfig?.model) { setEstimate(null); return; }
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        estimatePricing({
          model: serverAudioConfig.model,
          outputDurationSec: serverAudioConfig.duration || 4,
          ratio: serverAudioConfig.ratio || '1:1',
          resolution: serverAudioConfig.resolution || '480p',
          isDraft: false,
        }).then((r) => {
          if (!ctrl.signal.aborted) setEstimate(r);
        }).catch(() => {
          if (!ctrl.signal.aborted) setEstimate(null);
        });
      }, 200);
      return () => { ctrl.abort(); clearTimeout(timer); };
    }
    // 视频模式
    if (!model) { setEstimate(null); return; }
    if (isHHModel) {
      const dur = parseInt(videoSecs) || 5;
      const result = estimateHappyhorseCredits('t2v', videoRes as '720P' | '1080P', dur, hhPricing);
      setEstimate({
        credits: result.credits,
        lockedCredits: result.lockedCredits,
        tokens: 0, unitPrice: 0, draftFactor: 1, yuan: 0, model,
      });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      estimatePricing({
        model,
        outputDurationSec: parseInt(videoSecs) || 5,
        ratio: videoRatio,
        resolution: videoRes,
        isDraft: false,
      }).then((r) => {
        if (!ctrl.signal.aborted) setEstimate(r);
      }).catch(() => {
        if (!ctrl.signal.aborted) setEstimate(null);
      });
    }, 200);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [mode, model, videoRes, videoRatio, videoSecs, isHHModel, hhPricing, serverAudioConfig]);

  // ── 点击卡片空白处切换 composer（click 事件，不影响拖拽）──
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((target as any)?.isContentEditable || target?.getAttribute?.('contenteditable') === 'true') return;
      onComposerToggle?.();
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [onComposerToggle]);

  // ── 点击 composer 外部关闭 ──
  const composerOuterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!composerOpen) return;
    const handler = (e: PointerEvent) => {
      if (composerOuterRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      // @ 引用菜单在 Portal 中，点击菜单项不应关闭 composer
      if ((e.target as HTMLElement)?.closest?.('[data-mention-menu]')) return;
      onComposerToggle?.();
      onBlur?.();
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, [composerOpen, onComposerToggle]);

  // ── 模型弹出框关闭 ──
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: PointerEvent) => {
      if (modelBtnRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.('[data-model-dropdown]')) return;
      // 延迟检查，避免点击按钮自身立刻关闭
      setTimeout(() => {
        const el = document.elementFromPoint((e as any).clientX ?? 0, (e as any).clientY ?? 0);
        if (!el || modelBtnRef.current?.contains(el)) return;
        setModelOpen(false);
      }, 0);
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, [modelOpen]);

  // ── 参数弹窗位置同步 ──
  useEffect(() => {
    if (!settingsOpen) return;
    const sync = () => setSettingsBtnRect(settingsBtnRef.current?.getBoundingClientRect() || null);
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => { window.removeEventListener('resize', sync); window.removeEventListener('scroll', sync, true); };
  }, [settingsOpen]);

  // ── 模型数据 ──
  const allModels = { ...IMAGE_MODELS, ...VIDEO_MODELS, ...AUDIO_MODELS };
  const currentModels = mode === 'video' ? settings.videoModels : mode === 'audio' ? settings.audioModels : settings.imageModels;
  const displayModel = mode === 'audio' && serverAudioConfig
    ? `${allModels[serverAudioConfig.model] || serverAudioConfig.model} · ${serverAudioConfig.ratio} · ${serverAudioConfig.resolution} · ${serverAudioConfig.duration}s`
    : allModels[model] || model;

  // ── 设置按钮显示文本 ──
  const settingsLabel = mode === 'image'
    ? (model === 'gpt-image-2'
      ? gptAspect
      : `${nanoSize} · ${nanoAspect}`)
    : mode === 'audio'
      ? ''
      : `${videoRes} · ${videoRatio} · ${videoSecs}s`;

  // ── 积分（图片固定10，视频用实时估价）──
  const cost = mode === 'image' ? 10 : (estimate?.lockedCredits ?? 0);
  const canAfford = !balance || balance.unlimited || balance.available >= cost;

  const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount || prompt.trim());
  const canGenerate = hasAnyInput;

  // ── 处理器 ──
  const handleModeChange = (newMode: string) => {
    // 保存当前模型参数
    const currentParams: Record<string, unknown> = {};
    if (mode === 'image') {
      if (model === 'gpt-image-2') currentParams.size = gptAspect;
      else { currentParams.size = nanoSize; currentParams.aspectRatio = nanoAspect; currentParams.quality = quality; currentParams.count = imgCount; }
    } else if (mode === 'video') {
      currentParams.size = videoRes; currentParams.ratio = videoRatio; currentParams.seconds = videoSecs;
    }
    const saved = readModelParams(nodeId);
    saved[model] = currentParams;
    writeModelParams(nodeId, saved);

    setMode(newMode as ConfigGenerationMode);
    const newDefaultModel = newMode === 'audio' ? model : (newMode === 'video' ? settings.defaultVideoModel : settings.defaultImageModel);
    if (newMode !== 'audio') setModelState(newDefaultModel || '');

    // 恢复目标模式+模型的参数（有保存值则用保存值，否则默认）
    const targetSaved = saved[newDefaultModel] || {};
    const patch: Record<string, unknown> = { generationMode: newMode, model: newDefaultModel };

    if (newMode === 'image') {
      if (newDefaultModel === 'gpt-image-2') {
        const sz = (targetSaved.size as string) || '1:1';
        setGptAspect(sz); setQuality('auto'); setImgCount(1);
        patch.size = sz;
      } else {
        const sz = (targetSaved.size as string) || '1K';
        const ar = (targetSaved.aspectRatio as string) || '1:1';
        setNanoSize(sz); setNanoAspect(ar);
        patch.size = sz; patch.aspectRatio = ar;
        setQuality(targetSaved.quality ? targetSaved.quality as string : 'auto');
        setImgCount(targetSaved.count ? targetSaved.count as number : 1);
        if (targetSaved.quality) patch.quality = targetSaved.quality;
        if (targetSaved.count) patch.count = targetSaved.count;
      }
    } else if (newMode === 'video') {
      const isHH = newDefaultModel?.startsWith('happyhorse');
      const sz = (targetSaved.size as string) || (isHH ? '720P' : '720p');
      const ar = (targetSaved.ratio as string) || '16:9';
      const sc = (targetSaved.seconds as string) || '5';
      setVideoRes(sz); setVideoRatio(ar); setVideoSecs(sc);
      patch.size = sz; patch.ratio = ar; patch.seconds = sc;
    }

    onConfigChange(nodeId, patch);
  };

  const handleModelChange = (m: string) => {
    // 保存当前模型参数
    const currentParams: Record<string, unknown> = {};
    if (mode === 'image') {
      if (model === 'gpt-image-2') currentParams.size = gptAspect;
      else { currentParams.size = nanoSize; currentParams.aspectRatio = nanoAspect; currentParams.quality = quality; currentParams.count = imgCount; }
    } else if (mode === 'video') {
      currentParams.size = videoRes; currentParams.ratio = videoRatio; currentParams.seconds = videoSecs;
    }

    setModelState(m); setModelOpen(false);

    const saved = readModelParams(nodeId);
    saved[model] = currentParams;
    writeModelParams(nodeId, saved);

    const targetSaved = saved[m] || {};
    const patch: Record<string, unknown> = { model: m };

    if (mode === 'image') {
      if (m === 'gpt-image-2') {
        const sz = (targetSaved.size as string) || '1:1';
        setGptAspect(sz);
        patch.size = sz;
      } else {
        const sz = (targetSaved.size as string) || '1K';
        const ar = (targetSaved.aspectRatio as string) || '1:1';
        setNanoSize(sz); setNanoAspect(ar);
        patch.size = sz; patch.aspectRatio = ar;
        if (targetSaved.quality) { setQuality(targetSaved.quality as string); patch.quality = targetSaved.quality; }
        if (targetSaved.count) { setImgCount(targetSaved.count as number); patch.count = targetSaved.count; }
      }
    } else if (mode === 'video') {
      const isHH = m?.startsWith('happyhorse');
      const sz = (targetSaved.size as string) || (isHH ? '720P' : '720p');
      const ar = (targetSaved.ratio as string) || '16:9';
      const sc = (targetSaved.seconds as string) || '5';
      setVideoRes(sz); setVideoRatio(ar); setVideoSecs(sc);
      patch.size = sz; patch.ratio = ar; patch.seconds = sc;
    }

    onConfigChange(nodeId, patch);
  };

  const handleSettingsChange = (patch: Record<string, unknown>) => {
    if ('quality' in patch) setQuality(patch.quality as string);
    if ('size' in patch) { if (mode === 'video') setVideoRes(patch.size as string); else if (model === 'gpt-image-2') setGptAspect(patch.size as string); else setNanoSize(patch.size as string); }
    if ('aspectRatio' in patch) setNanoAspect(patch.aspectRatio as string);
    if ('ratio' in patch) setVideoRatio(patch.ratio as string);
    if ('count' in patch) setImgCount(patch.count as number);
    if ('seconds' in patch) setVideoSecs(patch.seconds as string);

    // 构建当前模型最新参数（用 patch 覆盖旧值）
    const saved = readModelParams(nodeId);
    const mp: Record<string, unknown> = { ...(saved[model] || {}) };
    Object.keys(patch).forEach(k => { if (k !== 'modelParams') mp[k] = patch[k]; });
    saved[model] = mp;
    writeModelParams(nodeId, saved);

    onConfigChange(nodeId, { ...patch });
  };

  const handleGenerate = () => { if (!canGenerate || isRunning) return; onBlur?.(); onGenerate(nodeId, mode, model, prompt.trim(), settingsLabel); refreshBalance(); };

  // ── @ 引用候选过滤 ──
  const mentionCandidates = (() => {
    if (!mentionOpen) return [] as CanvasResourceReference[];
    const q = mentionQuery.trim().toLowerCase();
    const base = !q ? refsList : refsList.filter((r) => `${r.label} ${r.title} ${r.text || ''}`.toLowerCase().includes(q));
    return base;
  })();

  // 当前模式下禁用的引用类型
  const disabledKinds = useMemo(() => {
    const kinds = new Set<CanvasResourceKind>();
    if (mode === 'image') kinds.add('video');
    return kinds;
  }, [mode]);

  // 音频模式下禁用的节点 ID（非火山素材，不显示在下拉但仍在 prompt 中可被清除）
  const audioDisabledNodeIds = useMemo(() => {
    if (mode !== 'audio') return new Set<string>();
    return new Set(refsList.filter(r => r.kind !== 'text' && !r.isVolcano).map(r => r.nodeId));
  }, [mode, refsList]);

  // ── 关闭 @ 菜单 ──
  const closeMention = useCallback(() => { setMentionOpen(false); setMentionQuery(''); setMentionActiveIdx(0); }, []);

  // ── 检测 @ 输入 ──
  const syncMention = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !refsList.length) { setMentionOpen(false); return; }
    const text = textBeforeCaret(editor);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
    if (!match) { setMentionOpen(false); return; }
    setMentionOpen(true);
    setMentionQuery(match[1] || '');
    setMentionActiveIdx(0);
  }, [refsList]);

  // ── 插入引用 Chip ──
  const insertReferenceChip = useCallback((ref: CanvasResourceReference) => {
    // 音频模式：非火山素材不可 @（提示词库按钮走火山资产选择器）
    if (mode === 'audio' && ref.kind !== 'text' && !ref.isVolcano) return;
    if (disabledKinds.has(ref.kind)) return;
    const editor = editorRef.current;
    if (!editor) return;

    // 音频模式：火山资产限 @ 1 个，插入前清除已有火山 chip
    if (mode === 'audio' && ref.isVolcano && editor) {
      const existingVolcChips = editor.querySelectorAll('[data-reference-idx][data-is-volcano="true"]');
      existingVolcChips.forEach((chip) => {
        // 删除 chip 后的空格
        const next = chip.nextSibling;
        if (next && next.nodeType === Node.TEXT_NODE && (next.textContent || '').trim() === '') {
          next.remove();
        }
        chip.remove();
      });
    }

    // 计算新 chip 的 idx（当前最大 idx + 1）
    let maxIdx = 0;
    editor.querySelectorAll('[data-reference-idx]').forEach((el) => {
      const i = parseInt((el as HTMLElement).dataset.referenceIdx || '0', 10);
      if (i > maxIdx) maxIdx = i;
    });
    const newIdx = maxIdx + 1;

    // 删除 @xxx 文本
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      const text = textBeforeCaret(editor);
      const match = /@([^\s@]*)$/.exec(text);
      if (match) {
        const caretNode = range.startContainer;
        const caretOff = range.startOffset;
        if (caretNode.nodeType === Node.TEXT_NODE) {
          const nodeText = caretNode.textContent || '';
          const localMatch = /@([^\s@]*)$/.exec(nodeText.slice(0, caretOff));
          if (localMatch) {
            range.setStart(caretNode, caretOff - localMatch[0].length);
            range.deleteContents();
          }
        }
      }
    }
    // 插入 chip + 空格
    const chip = createReferenceChip(ref, newIdx, t);
    const space = document.createTextNode(' ');
    const sel2 = window.getSelection();
    if (sel2?.rangeCount) {
      const range2 = sel2.getRangeAt(0);
      range2.insertNode(space);
      range2.insertNode(chip);
      range2.setStartAfter(space);
      range2.collapse(true);
      sel2.removeAllRanges();
      sel2.addRange(range2);
    } else {
      editor.appendChild(chip);
      editor.appendChild(space);
    }
    closeMention();
    // 同步 prompt + assetsOfAt
    const result = serializeEditor(editor, refsList);
    setPromptText(result.prompt);
    setAssetsOfAt(result.assetsOfAt);
    onConfigChange(nodeId, { configPrompt: result.prompt, prompt: result.prompt, assetsOfAt: JSON.stringify(result.assetsOfAt) });
  }, [t, closeMention, nodeId, onConfigChange, disabledKinds, refsList]);

  // ── 参数弹出框 Portal（内联不可行，直接在此渲染）──
  const settingsPopover = settingsOpen && settingsBtnRect ? (
    <SettingsPopover
      open={settingsOpen}
      btnRect={settingsBtnRect}
      mode={mode}
      model={model}
      size={mode === 'image' ? (model === 'gpt-image-2' ? gptAspect : nanoSize) : videoRes}
      quality={quality}
      count={imgCount}
      ratio={mode === 'image' ? (model === 'gpt-image-2' ? gptAspect : nanoAspect) : videoRatio}
      seconds={videoSecs}
      theme={t}
      onClose={() => setSettingsOpen(false)}
      onChange={handleSettingsChange}
    />
  ) : null;

  return (
    <div ref={panelRef} className="flex h-full w-full cursor-move flex-col px-3 pb-3 pt-7 text-sm nowheel" style={{ color: t.text }} onWheel={(e) => e.stopPropagation()}>
      {/* ── 标题 + Segmented ── */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="shrink-0 text-sm font-semibold">生成配置</div>
        <div className="cursor-default" onMouseDown={(e) => e.stopPropagation()}>
          <SegmentedSwitch value={mode} onChange={handleModeChange} theme={t} />
        </div>
      </div>

      {/* ── Chips ── */}
      <div className="mb-2 flex flex-wrap gap-1.5">
        <InputChip label="提示词" value={`${inputSummary.textCount} 个`} style={chipStyle} />
        <InputChip label="参考图" value={`${inputSummary.imageCount} 张`} style={chipStyle} />
        <InputChip label="参考视频" value={`${inputSummary.videoCount} 个`} style={chipStyle} />
        <InputChip label="参考音频" value={`${inputSummary.audioCount} 个`} style={chipStyle} />
      </div>

      {/* ── 模型 + 参数设置 ── */}
      <div className={`mb-2 grid min-w-0 cursor-default items-center gap-2 ${mode === 'audio' ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_148px]'}`} onMouseDown={(e) => e.stopPropagation()}>
        {/* 模型：音频模式只读标签，其他模式可下拉选择 */}
        {mode === 'audio' ? (
          <span className="inline-flex h-8 w-fit min-w-[9rem] max-w-full items-center gap-2 rounded-full border bg-transparent px-3 text-sm font-normal"
            style={{ borderColor: t.stroke, color: t.text }}>
            <span className="min-w-0 flex-1 truncate text-left">{displayModel}</span>
          </span>
        ) : (
          <button ref={modelBtnRef} type="button"
            className="flex h-8 w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-sm font-normal transition shadow-[0_1px_2px_-1px_rgba(0,0,0,.1),0_1px_3px_0_rgba(0,0,0,.1)]"
            style={{ background: 'rgba(255,255,255,.045)', borderColor: modelOpen ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.15)', color: t.text }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDownCapture={(e) => { e.stopPropagation(); e.preventDefault(); setModelOpen((v) => !v); }}>
            <span className="min-w-0 flex-1 truncate text-left">{displayModel}</span>
            <ChevronDown className={`size-4 shrink-0 opacity-50 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
          </button>
        )}
          {mode !== 'audio' && modelOpen && createPortal(
            <div data-model-dropdown="true"
              className="fixed z-[9999] min-w-[200px] rounded-xl border py-1 shadow-[0_6px_16px_rgba(0,0,0,.3)]"
              style={{ background: t.fill, borderColor: t.stroke, color: t.text,
                left: modelBtnRef.current?.getBoundingClientRect().left ?? 0,
                top: (modelBtnRef.current?.getBoundingClientRect().bottom ?? 0) + 4 }}
              onMouseDown={(e) => e.stopPropagation()}>
              {currentModels.map((m) => (
                <button key={m} type="button" onMouseDown={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:opacity-80"
                  style={{ color: m === model ? t.blue : t.text }}
                  onClick={() => handleModelChange(m)}>{allModels[m] || m}</button>
              ))}
            </div>, document.body)}

        {/* 参数设置按钮 — 音频模式由服务端统一配置，不显示 */}
        {mode !== 'audio' && (
        <span ref={settingsBtnRef as any} className="inline-flex min-w-0">
          <button type="button"
            className="flex h-10 w-full items-center gap-2 whitespace-nowrap px-2 text-xs font-normal transition hover:opacity-80"
            style={{ background: t.fill, color: t.text, borderRadius: '10px' }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDownCapture={(e) => { e.stopPropagation(); e.preventDefault(); setSettingsBtnRect(settingsBtnRef.current?.getBoundingClientRect() || null); setSettingsOpen((v) => !v); }}>
            <Settings2 className="size-3.5 shrink-0" />
            <span className="truncate">{settingsLabel}</span>
          </button>
        </span>
        )}
      </div>

      {/* ── 参数弹出框 ── */}
      {settingsPopover}

      {/* ── 开始生成按钮 ── */}
      <button type="button"
        className="mt-auto flex h-9 w-full shrink-0 cursor-pointer items-center justify-between gap-2 whitespace-nowrap px-[15px] text-sm font-normal transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: t.text < '#888' ? '#171717' : '#d8d8d8',
          color: t.text < '#888' ? '#fff' : '#171717',
          borderRadius: '10px',
        }}
        disabled={isRunning || !canGenerate || !canAfford || ((mode === 'video' || mode === 'audio') && !estimate)}
        onMouseDown={(e) => e.stopPropagation()} onClick={handleGenerate}>
        {isRunning ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <>
            {/* 左：余额 */}
            <span className="text-[10px] leading-tight whitespace-nowrap" style={{ color: t.text < '#888' ? '#999' : '#555' }}>
              余额 {balance?.unlimited ? '无限' : (balance?.available ?? 0).toLocaleString()}<br />
              (锁定 {balance?.locked?.toLocaleString() || '0'})
            </span>
            {/* 右：计费 + 开始生成 */}
            <span className="flex items-center gap-2">
              <Zap className="size-3.5 fill-current" strokeWidth={2.4} />
              <span className="text-[10px] leading-tight text-center">
                <span className="tabular-nums">{((mode === 'video' || mode === 'audio') && !estimate) ? '--' : (estimate?.discountedCredits != null && estimate.discountedCredits !== estimate.credits ? estimate.discountedCredits : (estimate?.credits ?? cost)).toLocaleString()}</span><br />
                <span>(锁定 {((mode === 'video' || mode === 'audio') && !estimate) ? '--' : (estimate?.discountedLockedCredits != null && estimate.discountedLockedCredits !== estimate.lockedCredits ? estimate.discountedLockedCredits : (estimate?.lockedCredits ?? cost)).toLocaleString()})</span>
              </span>
              <Play className="size-4" />
              <span>开始生成</span>
            </span>
          </>
        )}
      </button>

      {/* ── 提示词输入（点击空白处切换）── */}
      {composerOpen && (
      <div ref={composerOuterRef}
        className="nodrag nowheel absolute left-1/2 top-full z-[70] w-[500px] -translate-x-1/2 pt-4"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
          style={{
            background: t.text < '#888' ? 'rgba(251,250,247,.96)' : 'rgba(31,29,26,.96)',
            borderColor: t.stroke, color: t.text,
          }}>
          {/* 标题行 */}
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <div className="shrink-0 text-xs font-semibold">组装提示词</div>
              <div className="truncate text-[11px] opacity-55">@ 引用已连接素材，发送前按当前连接重新编号</div>
            </div>
          </div>
          {/* 输入区 — 支持 @ 引用 */}
          <div className="relative rounded-xl border" style={{ background: t.fill, borderColor: t.stroke }}>
            {!prompt && (
              <div className="pointer-events-none absolute left-3 top-2 text-sm leading-7" style={{ color: t.faint }}>
                输入提示词，按 @ 引用连接的图片或文本
              </div>
            )}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              className="thin-scrollbar min-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-7 outline-none"
              style={{ color: t.text }}
              onInput={() => {
                if (composingRef.current) return;
                handleComposerInputAudio();
                const editor = editorRef.current;
                if (editor) {
                  const result = serializeEditor(editor, refsList);
                  setPromptText(result.prompt);
                  setAssetsOfAt(result.assetsOfAt);
                  onConfigChange(nodeId, { configPrompt: result.prompt, prompt: result.prompt, assetsOfAt: JSON.stringify(result.assetsOfAt) });
                }
                syncMention();
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => {
                composingRef.current = false;
                const editor = editorRef.current;
                if (editor) {
                  const result = serializeEditor(editor, refsList);
                  setPromptText(result.prompt);
                  setAssetsOfAt(result.assetsOfAt);
                  onConfigChange(nodeId, { configPrompt: result.prompt, prompt: result.prompt, assetsOfAt: JSON.stringify(result.assetsOfAt) });
                }
                syncMention();
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Backspace/Delete 删除相邻 @ 引用 Chip
                if ((e.key === 'Backspace' || e.key === 'Delete') && deleteAdjacentReference(e.key)) {
                  e.preventDefault();
                  requestAnimationFrame(() => {
                    const editor = editorRef.current;
                    if (editor) {
                      const result = serializeEditor(editor, refsList);
                      setPromptText(result.prompt);
                      setAssetsOfAt(result.assetsOfAt);
                      onConfigChange(nodeId, { configPrompt: result.prompt, prompt: result.prompt, assetsOfAt: JSON.stringify(result.assetsOfAt) });
                    }
                  });
                  return;
                }
                if (mentionOpen && mentionCandidates.length > 0) {
                  const enabledCandidates = mentionCandidates.filter((r) => !disabledKinds.has(r.kind));
                  const enabledCount = enabledCandidates.length;
                  if (enabledCount === 0) { closeMention(); return; }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionActiveIdx((i) => {
                      let next = (i + 1) % mentionCandidates.length;
                      // 跳过禁用项
                      while (disabledKinds.has(mentionCandidates[next].kind) && next !== i) next = (next + 1) % mentionCandidates.length;
                      return next;
                    });
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionActiveIdx((i) => {
                      let next = (i - 1 + mentionCandidates.length) % mentionCandidates.length;
                      while (disabledKinds.has(mentionCandidates[next].kind) && next !== i) next = (next - 1 + mentionCandidates.length) % mentionCandidates.length;
                      return next;
                    });
                    return;
                  }
                  if (e.key === 'Enter') { e.preventDefault(); insertReferenceChip(mentionCandidates[Math.min(mentionActiveIdx, mentionCandidates.length - 1)]); return; }
                  if (e.key === 'Escape') { e.preventDefault(); closeMention(); return; }
                }
              }}
              onBlur={() => { setTimeout(closeMention, 150); onBlur?.(); }}
              onFocus={() => {
                // 重建 editor 内容以正确渲染 chips
                const editor = editorRef.current;
                if (editor && refsList.length > 0) {
                  rebuildEditorContent(editor, prompt, refsList, assetsOfAt, validAssetIds, t);
                }
              }}
            />
            {mentionOpen && mentionCandidates.length > 0 && editorRef.current ? (
              <MentionMenu refs={mentionCandidates} activeIndex={Math.min(mentionActiveIdx, mentionCandidates.length - 1)} theme={t} disabledKinds={disabledKinds} disabledNodeIds={audioDisabledNodeIds} onSelect={insertReferenceChip} />
            ) : null}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
