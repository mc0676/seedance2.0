// 图片节点下方的生图面板 — 参数体系对齐 ImageGenPage.tsx
// GPT-Image-2: 仅宽高比（14选项）
// Nano Banana 2: 尺寸档（1K/2K/4K）+ 宽高比（11选项）
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronDown, Loader2, Settings2, X, Zap } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';
import { getCreditBalance, type CreditBalance } from '../../services/pricingService';

const ALL_MODELS: Record<string, string> = {
  'nano-banana-2': 'Nano Banana 2',
  'gpt-image-2': 'GPT-Image-2',
};

function readImageSettings(): { models: { value: string; label: string }[]; defaultModel: string } {
  try {
    const raw = localStorage.getItem('seedance_canvas_settings');
    if (raw) {
      const s = JSON.parse(raw);
      const models = (s.image_models || ['nano-banana-2']).filter((m: string) => ALL_MODELS[m]);
      return {
        models: models.map((m: string) => ({ value: m, label: ALL_MODELS[m] })),
        defaultModel: s.image_default && ALL_MODELS[s.image_default] ? s.image_default : models[0],
      };
    }
  } catch {}
  return {
    models: Object.entries(ALL_MODELS).map(([v, l]) => ({ value: v, label: l })),
    defaultModel: 'nano-banana-2',
  };
}

// ── 模型专属参数 — 对齐 ImageGenPage.tsx ──
// 按 高/宽 比例从大到小排列（竖屏→方形→横屏），auto 末尾
const GPT_ASPECT_OPTIONS = [
  '1:3', '9:21', '1:2', '9:16', '2:3', '3:4',
  '1:1',
  '4:3', '3:2', '16:9', '2:1', '21:9', '3:1',
  'auto',
] as const;

const NANO_SIZE_OPTIONS = ['1K', '2K', '4K'] as const;
const NANO_ASPECT_OPTIONS = [
  '9:16', '2:3', '3:4', '4:5',
  '1:1',
  '5:4', '4:3', '3:2', '16:9', '21:9',
  'auto',
] as const;

const IMAGE_GEN_COST = 10;

// ── 共用子组件 ──
function OptionPill({ selected, theme, onClick, children }: {
  selected: boolean; theme: NonNullable<ImagePromptPanelProps['theme']>; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
      style={{ background: 'transparent', borderColor: selected ? theme.nodeText : theme.nodeStroke, color: theme.nodeText }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// 比例预览框 — 复刻原项目 SizePreview
function SizePreview({ w, h, color }: { w: number; h: number; color: string }) {
  if (!w || !h) return null;
  const long = Math.max(w, h);
  const pw = Math.max(10, Math.round((w / long) * 26));
  const ph = Math.max(10, Math.round((h / long) * 26));
  return <span className="rounded-[3px] border-2" style={{ width: pw, height: ph, borderColor: color }} />;
}
function ratioWH(r: string): { w: number; h: number } {
  const parts = r.split(':');
  if (parts.length === 2) {
    const w = parseInt(parts[0], 10);
    const h = parseInt(parts[1], 10);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: 1, h: 1 };
}

interface ImagePromptPanelProps {
  open: boolean;
  nodeId: string | null;
  projectId: number;
  initialRecordId?: number | null;
  initialPrompt?: string;
  onClose: () => void;
  onGenerated: (imageUrl: string, recordId: number, model: string) => void;
  onGenerating?: (recordId: number, model: string) => void;
  onPromptError?: (errorMessage: string) => void;
  theme?: {
    panel: string; panelBorder: string; nodeFill: string;
    nodeStroke: string; nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

export function CanvasImagePromptPanel({ open, nodeId, projectId, initialRecordId, initialPrompt, onClose, onGenerated, onGenerating, onPromptError, theme }: ImagePromptPanelProps) {
  const t = theme || {
    panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c', nodeFill: '#292524',
    nodeStroke: '#44403c', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [prompt, setPrompt] = useState('');
  const { models: IMAGE_MODELS, defaultModel: defaultImageModel } = readImageSettings();
  const [model, setModel] = useState<string>(defaultImageModel);
  // GPT-Image-2: 仅宽高比
  const [gptAspect, setGptAspect] = useState<string>('1:1');
  // Nano Banana 2: 尺寸档 + 宽高比
  const [nanoSize, setNanoSize] = useState<string>('1K');
  const [nanoAspect, setNanoAspect] = useState<string>('1:1');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 将错误同步到父组件 → 卡片内显示
  useEffect(() => { if (error) onPromptError?.(error); }, [error]);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef(false);
  const selfStartedRef = useRef(false);

  // 对齐 ImageGenPage: GPT 只显示宽高比，Nano 显示 尺寸 · 宽高比
  const sizeLabel = model === 'gpt-image-2' ? gptAspect : `${nanoSize} · ${nanoAspect}`;

  const refreshBalance = useCallback(async () => {
    try { setBalance(await getCreditBalance()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshBalance();
    setError('');
    setConfigOpen(false);
    pollingRef.current = false;
    if (selfStartedRef.current) { selfStartedRef.current = false; return; }

    if (initialRecordId) {
      setGenerating(true);
      (async () => {
        try {
          const pollUrl = `/api/image-records?projectId=${projectId}&pageSize=100`;
          const res = await fetch(pollUrl, { headers: getAuthHeaders() });
          const data = await res.json();
          const record = (data?.data?.records || []).find((r: any) => r.id === initialRecordId);
          if (record) {
            setPrompt(record.prompt || '');
            setModel(record.model || defaultImageModel);
            // 从 size_label 恢复参数: GPT 存 ratio 字符串, Nano 存 "1K · 16:9"
            const sl: string = record.size_label || '';
            if (record.model === 'gpt-image-2') {
              if ((GPT_ASPECT_OPTIONS as readonly string[]).includes(sl)) setGptAspect(sl);
            } else {
              const parts = sl.split(' · ');
              if (parts.length >= 2) {
                if ((NANO_SIZE_OPTIONS as readonly string[]).includes(parts[0])) setNanoSize(parts[0]);
                if ((NANO_ASPECT_OPTIONS as readonly string[]).includes(parts[1])) setNanoAspect(parts[1]);
              }
            }
            if (record.status === 'done' && record.result_urls?.length > 0) {
              onGenerated(record.result_urls[0], initialRecordId, model);
              return;
            }
            if (record.status === 'error') {
              setError(record.error_message || '生成失败');
              setGenerating(false);
              return;
            }
            pollResult(initialRecordId);
          } else {
            setPrompt('');
            setGenerating(false);
          }
        } catch { setGenerating(false); }
      })();
    } else {
      setPrompt(initialPrompt || '');
      setGenerating(false);
    }
  }, [open, initialRecordId]);

  useEffect(() => { return () => { pollingRef.current = false; }; }, []);

  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (configBtnRef.current?.contains(target) || configPanelRef.current?.contains(target)) return;
      setConfigOpen(false);
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, [configOpen]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (modelBtnRef.current?.contains(target) || modelPanelRef.current?.contains(target)) return;
      setModelOpen(false);
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
  }, [modelOpen]);

  // 对齐原项目：跟踪按钮位置，resize/scroll 时更新
  useEffect(() => {
    if (!configOpen) return;
    const sync = () => setBtnRect(configBtnRef.current?.getBoundingClientRect() || null);
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [configOpen]);

  // ── 提交：完全对齐 ImageGenPage.handleGenerate ──
  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    if (balance && !balance.unlimited && balance.available < IMAGE_GEN_COST) {
      setError('可用积分不足（每次生成消耗 10 积分），请联系管理员充值');
      return;
    }
    setGenerating(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        prompt: text,
        model,
        sizeLabel,
        projectId,
      };
      if (model === 'gpt-image-2') {
        body.size = gptAspect;
      } else {
        body.size = nanoSize;
        body.aspectRatio = nanoAspect;
      }
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) { const msg = data.error || '生成失败'; setError(msg); setGenerating(false); onPromptError?.(msg); refreshBalance(); return; }
      const recordId: number = data.imageRecordId;
      if (!recordId) { const msg = '未获取到任务ID'; setError(msg); setGenerating(false); onPromptError?.(msg); refreshBalance(); return; }
      selfStartedRef.current = true;
      onGenerating?.(recordId, model);
      pollResult(recordId);
    } catch (e: any) {
      const msg = e.message || '请求失败';
      setError(msg);
      setGenerating(false);
      onPromptError?.(msg);
      refreshBalance();
    }
  };

  const pollResult = async (recordId: number) => {
    setGenerating(true);
    pollingRef.current = true;
    let failCount = 0;
    const pollUrl = `/api/image-records?projectId=${projectId}&pageSize=50`;
    while (pollingRef.current) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await fetch(pollUrl, { headers: getAuthHeaders() });
        if (!res.ok) {
          failCount++;
          if (failCount >= 3) { const msg = '网络异常，请刷新页面查看历史记录'; setError(msg); setGenerating(false); onPromptError?.(msg); refreshBalance(); pollingRef.current = false; return; }
          continue;
        }
        failCount = 0;
        const data = await res.json();
        const record = (data?.data?.records || []).find((r: any) => r.id === recordId);
        if (!record) continue;
        if (record.status === 'done' && record.result_urls?.length > 0) {
          onGenerated(record.result_urls[0], recordId, model);
          onClose(); setGenerating(false); refreshBalance(); pollingRef.current = false; return;
        }
        if (record.status === 'error') {
          const msg = record.error_message || '生成失败';
          setError(msg);
          setGenerating(false); onPromptError?.(msg); refreshBalance(); pollingRef.current = false; return;
        }
      } catch {
        failCount++;
        if (failCount >= 3) { const msg = '网络异常，请刷新页面查看历史记录'; setError(msg); setGenerating(false); onPromptError?.(msg); refreshBalance(); pollingRef.current = false; return; }
      }
    }
  };

  if (!open) return null;

  const available = balance?.unlimited ? '无限' : (balance?.available ?? 0).toLocaleString();
  const locked = balance?.locked?.toLocaleString() || '0';
  const isGpt = model === 'gpt-image-2';

  return (
    <div
      className="flex flex-col w-full rounded-2xl border p-3 shadow-2xl backdrop-blur"
      style={{ background: t.panel, borderColor: t.panelBorder, color: t.nodeText }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        onWheel={(e) => e.stopPropagation()}
        className="thin-scrollbar h-24 w-full resize-none rounded-xl border px-3 py-2 text-sm leading-5 outline-none"
        style={{ background: t.nodeFill, borderColor: t.nodeStroke, color: t.nodeText }}
        placeholder="描述要生成的图片内容"
        disabled={generating}
      />

      {error && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs" style={{ background: 'rgba(220,38,38,.15)', color: '#fca5a5' }}>
          <span className="shrink-0">⚠</span>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="shrink-0 hover:opacity-70"><X className="size-3" /></button>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* 模型下拉 — 复刻原项目 ModelPicker: rounded-full + 弹出面板 */}
          <div className="relative">
            <button
              ref={modelBtnRef}
              type="button"
              disabled={generating}
              className="inline-flex h-8 w-fit min-w-[9rem] max-w-full items-center gap-2 rounded-full border bg-transparent px-3 text-sm font-normal transition-colors"
              style={{ borderColor: modelOpen ? t.nodeText : t.nodeStroke, color: t.nodeText }}
              onClick={(e) => { e.stopPropagation(); setModelOpen((v) => !v); setConfigOpen(false); }}
            >
              <span className="min-w-0 flex-1 truncate text-left">{IMAGE_MODELS.find((m) => m.value === model)?.label || model}</span>
              <ChevronDown className={`size-3.5 shrink-0 opacity-50 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
            </button>

            {modelOpen && (
              <div
                ref={modelPanelRef}
                className="absolute bottom-full left-0 mb-1.5 z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border p-1 shadow-xl"
                style={{ background: t.panel, borderColor: t.panelBorder }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {IMAGE_MODELS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
                    style={{
                      color: m.value === model ? t.nodeText : t.nodeMuted,
                      background: m.value === model ? t.nodeFill : 'transparent',
                    }}
                    onClick={() => { setModel(m.value); setModelOpen(false); }}
                  >
                    <span className="truncate">{m.value}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              ref={configBtnRef}
              type="button"
              disabled={generating}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-xs transition"
              style={{ background: t.nodeFill, borderColor: configOpen ? t.nodeText : t.nodeStroke, color: t.nodeText }}
              onClick={(e) => { e.stopPropagation(); setConfigOpen((v) => !v); }}
            >
              <Settings2 className="size-3.5" />
              <span className="truncate">{sizeLabel}</span>
            </button>

            {configOpen && btnRect && createPortal(
              <div
                ref={configPanelRef}
                className="fixed w-[340px] rounded-2xl p-4 shadow-[0_18px_54px_rgba(28,25,23,.16)] space-y-4"
                style={{
                  background: t.panel, color: t.nodeText,
                  left: Math.max(12, Math.min(window.innerWidth - 340 - 12, btnRect.left)),
                  bottom: window.innerHeight - btnRect.top + 8,
                  maxHeight: Math.max(260, btnRect.top - 24),
                  overflowY: 'auto',
                  zIndex: 1200,
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                {isGpt ? (
                  /* GPT-Image-2: 仅宽高比 */
                  <div className="space-y-2.5">
                    <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>宽高比</div>
                    <div className="grid grid-cols-3 gap-2">
                      {GPT_ASPECT_OPTIONS.map((opt) => {
                        const wh = opt === 'auto' ? { w: 0, h: 0 } : ratioWH(opt);
                        return (
                          <button key={opt} type="button"
                            className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                            style={{ borderColor: gptAspect === opt ? t.nodeText : t.nodeStroke, color: t.nodeText }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => setGptAspect(opt)}
                          >
                            <SizePreview w={wh.w} h={wh.h} color={t.nodeText} />
                            <span>{opt}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Nano Banana 2: 尺寸档 */}
                    <div className="space-y-2.5">
                      <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>尺寸</div>
                      <div className="grid grid-cols-3 gap-2">
                        {NANO_SIZE_OPTIONS.map((opt) => (
                          <OptionPill key={opt} selected={nanoSize === opt} theme={t} onClick={() => setNanoSize(opt)}>
                            {opt}
                          </OptionPill>
                        ))}
                      </div>
                    </div>
                    {/* Nano Banana 2: 宽高比 */}
                    <div className="space-y-2.5">
                      <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>宽高比</div>
                      <div className="grid grid-cols-3 gap-2">
                        {NANO_ASPECT_OPTIONS.map((opt) => {
                          const wh = opt === 'auto' ? { w: 0, h: 0 } : ratioWH(opt);
                          return (
                            <button key={opt} type="button"
                              className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                              style={{ borderColor: nanoAspect === opt ? t.nodeText : t.nodeStroke, color: t.nodeText }}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => setNanoAspect(opt)}
                            >
                              <SizePreview w={wh.w} h={wh.h} color={t.nodeText} />
                              <span>{opt}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}

              </div>,
              document.body
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="shrink-0 text-[10px] leading-tight text-right whitespace-nowrap" style={{ color: t.nodeFaint }}>
            余额 {available}<br />
            (锁定 {locked})
          </span>

          <button
            type="button"
            disabled={!prompt.trim() || generating}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition disabled:opacity-40"
            style={{ background: generating ? '#dc2626' : t.nodeText, color: generating ? '#fff' : t.panel }}
            onClick={(e) => { e.stopPropagation(); handleSubmit(); }}
          >
            {generating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                生成中
              </>
            ) : (
              <>
                <Zap className="size-3.5 fill-current" strokeWidth={2.4} />
                <span className="text-[10px] leading-tight text-center">
                  <span className="tabular-nums">{IMAGE_GEN_COST}</span><br />
                  <span>(锁定 {IMAGE_GEN_COST})</span>
                </span>
                <ArrowUp className="size-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
