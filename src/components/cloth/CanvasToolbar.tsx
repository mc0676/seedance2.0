import { createContext, useContext, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { TrashIcon, FileUpIcon, SparkleIcon, ImageIcon, VideoIcon } from '../Icons';

// ── 移植自 infinite-canvas: canvas-toolbar.tsx ──
// 底部居中菜单栏，含添加节点 / 素材 / 外观 / 删除 / 清空。
// 配色严格复刻原项目 canvas-theme.ts 的 toolbar 色板

const C_DARK = {
  panel: 'rgba(31,29,26,.96)',
  panelBorder: '#44403c',
  nodeFill: '#292524',
  nodeStroke: '#44403c',
  nodeText: '#f5f5f4',
  nodeMuted: '#d6d3d1',
  activeBg: '#3a3631',
};

const C_LIGHT = {
  panel: 'rgba(251,250,247,.96)',
  panelBorder: '#d6d3ca',
  nodeFill: '#e7e5df',
  nodeStroke: '#d6d3ca',
  nodeText: '#292524',
  nodeMuted: '#57534e',
  activeBg: '#e7e5df',
};

function toolbarColors(themeMode: 'dark' | 'light') {
  return themeMode === 'light' ? C_LIGHT : C_DARK;
}

type ToolbarC = typeof C_DARK;
const ToolbarThemeCtx = createContext<ToolbarC>(C_DARK);
const useToolbarC = () => useContext(ToolbarThemeCtx);

/* ══════════ 内联 SVG 图标 ══════════ */
const HandSvg    = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v-4"/></svg>;
const UndoSvg    = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/></svg>;
const RedoSvg    = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M15 15 21 9m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3"/></svg>;
const TextSvg    = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>;
const PaletteSvg = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M7.5 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM12 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM16.5 10.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM8.5 15.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>;
const EraserSvg  = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.1-9.1a1 1 0 0 1 1.4 0l5.8 5.8a1 1 0 0 1 0 1.4L13 19"/><path d="M5 21h14"/><path d="M12.5 11.5 8 16"/></svg>;
const LibrarySvg = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>;
const FolderSvg  = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>;
const Music2Svg  = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/></svg>;
const CubeSvg    = () => <svg className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>;

/* ══════════ 辅助 ─────────────────── */

function Divider() {
  const C = useToolbarC();
  return <div className="mx-1 h-6 w-px" style={{ background: C.panelBorder }} />;
}

function getTipX(wrap: HTMLDivElement | null, target: HTMLElement) {
  if (!wrap) return 0;
  const wrapBox = wrap.parentElement?.getBoundingClientRect() || wrap.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  return box.left - wrapBox.left + box.width / 2;
}

const LABELS: Record<string, string> = {
  'tool-hand': '移动/选择', 'tool-undo': '撤销', 'tool-redo': '重做',
  'tool-text': '文本', 'tool-image': '图片', 'tool-video': '视频',
  'tool-audio': '音频', 'tool-config': '生成配置', 'tool-upload': '上传素材',
  'tool-library': '素材库', 'tool-assets': '我的素材', 'tool-style': '画布外观',
  'tool-delete': '删除选中', 'tool-clear': '清空画布',
  'tool-volc-assets': '火山资产',
};

/* ══════════ 子组件 ───────────────── */

function ToolbarBtn({
  id, active, hovered, activeStyle, hoverStyle,
  wrapRef, onHover, onTip, onClick, disabled, danger, children,
}: {
  id: string; active?: boolean; hovered: string | null;
  activeStyle?: CSSProperties; hoverStyle: CSSProperties;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onHover: (id: string | null) => void; onTip: (x: number) => void;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; danger?: boolean; children: ReactNode;
}) {
  const C = useToolbarC();
  const isHovered = hovered === id;
  const style: CSSProperties = active ? (activeStyle ?? hoverStyle)
    : isHovered ? hoverStyle
    : { color: danger ? '#f87171' : C.nodeMuted, opacity: disabled ? 0.35 : 1 };

  return (
    <button
      aria-label={LABELS[id] || id}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md transition-colors bg-transparent border-0 outline-none cursor-pointer shrink-0"
      style={style}
      onMouseEnter={(e) => { onHover(id); onTip(getTipX(wrapRef.current, e.currentTarget)); }}
      onMouseLeave={() => onHover(null)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ══════════ 主组件 ───────────────── */

export type ToolbarAction =
  | 'deselect' | 'undo' | 'redo'
  | 'add-text' | 'add-image' | 'add-video' | 'add-audio' | 'add-config'
  | 'upload' | 'library' | 'my-assets' | 'volc-assets' | 'style'
  | 'delete-selected' | 'clear';

interface CanvasToolbarProps {
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onAction: (action: ToolbarAction) => void;
  themeMode?: 'dark' | 'light';
  backgroundMode?: 'dots' | 'lines' | 'blank';
  showImageInfo?: boolean;
  onThemeModeChange?: (mode: 'dark' | 'light') => void;
  onBackgroundModeChange?: (mode: 'dots' | 'lines' | 'blank') => void;
  onShowImageInfoChange?: (show: boolean) => void;
}

export function CanvasToolbar({ selectedCount, canUndo, canRedo, onAction, themeMode = 'dark', backgroundMode = 'lines', showImageInfo = false, onThemeModeChange, onBackgroundModeChange, onShowImageInfoChange }: CanvasToolbarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tipX, setTipX] = useState(0);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [panelX, setPanelX] = useState(0);
  const C = toolbarColors(themeMode);

  const isDark = themeMode === 'dark';
  const dockStyle: CSSProperties = {
    background: C.panel, borderColor: C.panelBorder, color: C.nodeMuted,
    boxShadow: isDark ? '0 18px 45px rgba(0,0,0,.32)' : '0 16px 40px rgba(28,25,23,.12)',
  };
  const hoverStyle: CSSProperties = { background: C.nodeFill, color: C.nodeText };
  const activeStyle: CSSProperties = { background: C.activeBg, color: C.nodeText };
  const tip = hovered ? (LABELS[hovered] || '') : '';

  return (
    <ToolbarThemeCtx.Provider value={C}>
    <div className="pointer-events-none absolute bottom-5 z-50 flex justify-center" style={{ left: 300, right: 16 }}>
      {/* 悬浮提示 */}
      {tip ? (
        <span
          className="absolute bottom-[calc(100%+8px)] -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-lg"
          style={{ left: tipX, background: C.nodeText, color: C.panel }}
        >
          {tip}
        </span>
      ) : null}

      <div
        ref={wrapRef}
        className="thin-scrollbar pointer-events-auto flex h-14 max-w-full items-center gap-1 overflow-x-auto rounded-xl border px-2 shadow-lg backdrop-blur [&>*]:shrink-0"
        style={dockStyle}
      >
        {/* ── 移动/选择 ── */}
        <ToolbarBtn id="tool-hand" active={!selectedCount} hovered={hovered} activeStyle={activeStyle} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('deselect')}>
          <HandSvg />
        </ToolbarBtn>

        {/* ── 撤销 / 重做 ── */}
        <ToolbarBtn id="tool-undo" disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('undo')}>
          <UndoSvg />
        </ToolbarBtn>
        <ToolbarBtn id="tool-redo" disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('redo')}>
          <RedoSvg />
        </ToolbarBtn>

        <Divider />

        {/* ── 添加节点 ── */}
        <ToolbarBtn id="tool-text" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('add-text')}>
          <TextSvg />
        </ToolbarBtn>
        <ToolbarBtn id="tool-image" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('add-image')}>
          <ImageIcon className="size-[18px]" />
        </ToolbarBtn>
        <ToolbarBtn id="tool-video" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('add-video')}>
          <VideoIcon className="size-[18px]" />
        </ToolbarBtn>
        <ToolbarBtn id="tool-audio" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('add-audio')}>
          <Music2Svg />
        </ToolbarBtn>
        <ToolbarBtn id="tool-config" disabled hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('add-config')}>
          <SparkleIcon className="size-[18px]" />
        </ToolbarBtn>

        <Divider />

        {/* ── 素材 ── */}
        <ToolbarBtn id="tool-upload" disabled hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('upload')}>
          <FileUpIcon className="size-[18px]" />
        </ToolbarBtn>
        <ToolbarBtn id="tool-library" disabled hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('library')}>
          <LibrarySvg />
        </ToolbarBtn>
        <ToolbarBtn id="tool-assets" disabled hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('my-assets')}>
          <FolderSvg />
        </ToolbarBtn>
        <ToolbarBtn id="tool-volc-assets" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('volc-assets')}>
          <CubeSvg />
        </ToolbarBtn>

        {/* ── 外观 ── */}
        <ToolbarBtn
          id="tool-style"
          active={appearanceOpen}
          hovered={hovered}
          activeStyle={activeStyle}
          hoverStyle={hoverStyle}
          wrapRef={wrapRef}
          onHover={setHovered}
          onTip={setTipX}
          onClick={(e) => { setPanelX(getTipX(wrapRef.current, e.currentTarget)); setAppearanceOpen((v) => !v); }}
        >
          <PaletteSvg />
        </ToolbarBtn>

        {/* ── 删除 / 清空（仅在有选中时显示删除） ── */}
        {selectedCount > 0 && (
          <>
            <Divider />
            <ToolbarBtn id="tool-delete" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('delete-selected')} danger>
              <TrashIcon className="size-[18px]" />
            </ToolbarBtn>
          </>
        )}

        <Divider />
        <ToolbarBtn id="tool-clear" hovered={hovered} hoverStyle={hoverStyle} wrapRef={wrapRef} onHover={setHovered} onTip={setTipX} onClick={() => onAction('clear')} danger>
          <EraserSvg />
        </ToolbarBtn>
      </div>

      {/* ── 外观弹窗 — 复刻原项目 canvas-toolbar.tsx 画布外观 ── */}
      {appearanceOpen && (
        <div
          className="pointer-events-auto absolute bottom-[72px] z-30 w-[248px] -translate-x-1/2 rounded-xl border p-2.5 shadow-xl backdrop-blur"
          style={{ left: panelX || '50%', background: C.panel, borderColor: C.panelBorder, color: C.nodeMuted }}
        >
          <div className="px-1 pb-2 text-sm font-medium opacity-65" style={{ color: C.nodeText }}>画布外观</div>

          {/* 主题模式切换 */}
          <div className="px-1 pb-1.5 text-[11px] font-medium opacity-50">背景颜色</div>
          <div className="grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: C.nodeFill }}>
            <ThemeBtn label="浅色" active={themeMode === 'light'} onClick={() => onThemeModeChange?.('light')}>
              <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              浅色
            </ThemeBtn>
            <ThemeBtn label="深色" active={themeMode === 'dark'} onClick={() => onThemeModeChange?.('dark')}>
              <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              深色
            </ThemeBtn>
          </div>

          {/* 网格样式 */}
          <div className="mt-3 px-1 pb-1.5 text-[11px] font-medium opacity-50">网格样式</div>
          <div className="grid grid-cols-3 gap-0.5 rounded-lg p-0.5" style={{ background: C.nodeFill }}>
            {(['dots', 'lines', 'blank'] as const).map((mode) => (
              <button
                key={mode}
                className="flex items-center justify-center gap-1.5 rounded-md py-2 text-xs transition"
                style={{
                  background: backgroundMode === mode ? C.activeBg : 'transparent',
                  color: backgroundMode === mode ? C.nodeText : C.nodeMuted,
                }}
                onClick={() => { onBackgroundModeChange?.(mode); }}
              >
                {mode === 'dots' ? <DotGridIcon /> : mode === 'lines' ? <LineGridIcon /> : <BlankIcon />}
                {mode === 'dots' ? '点' : mode === 'lines' ? '线' : '空白'}
              </button>
            ))}
          </div>

          {/* 图片信息开关 */}
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg px-1.5 py-1">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium opacity-65">
              <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              图片信息
            </span>
            <div
              className="relative h-5 w-9 cursor-pointer rounded-full transition-colors"
              style={{ background: showImageInfo ? C.nodeText : C.nodeStroke }}
              onClick={() => onShowImageInfoChange?.(!showImageInfo)}
            >
              <div
                className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
                style={{ left: showImageInfo ? 18 : 2 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
    </ToolbarThemeCtx.Provider>
  );
}

/* ══════════ 网格模式图标（复刻 lucide-react CircleDot / Grid2x2 / Square，size-4） ══════════ */
function DotGridIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}
function LineGridIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}
function BlankIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

/* ══════════ 主题按钮 ───────────────── */
function ThemeBtn({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  const C = useToolbarC();
  return (
    <button
      className="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition"
      style={{ background: active ? C.activeBg : 'transparent', color: active ? C.nodeText : C.nodeMuted }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
