// 视频节点下方的生图面板 — 参数体系对齐原项目 video-settings-panel.tsx
// Seedance: 分辨率 + 比例 + 时长 + 输出
// HappyHorse: 分辨率 + 比例 + 时长（不同选项，无输出开关）
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronDown, Loader2, Settings2, X, Zap } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';
import { getCreditBalance, estimatePricing, type CreditBalance, type PricingEstimate } from '../../services/pricingService';
import { estimateHappyhorseCredits, getHappyhorsePricing } from '../../services/happyhorseService';
import type { HappyhorsePricingItem } from '../../types';

const ALL_VIDEO_MODELS: Record<string, string> = {
  'happyhorse-1.0-t2v': 'HappyHorse 1.0 T2V',
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
};

function readVideoSettings(): { models: { value: string; label: string }[]; defaultModel: string } {
  try {
    const raw = localStorage.getItem('seedance_canvas_settings');
    if (raw) {
      const s = JSON.parse(raw);
      const models = (s.video_models || ['seedance-2.0']).filter((m: string) => ALL_VIDEO_MODELS[m]);
      return {
        models: models.map((m: string) => ({ value: m, label: ALL_VIDEO_MODELS[m] })),
        defaultModel: s.video_default && ALL_VIDEO_MODELS[s.video_default] ? s.video_default : models[0],
      };
    }
  } catch {}
  return {
    models: Object.entries(ALL_VIDEO_MODELS).map(([v, l]) => ({ value: v, label: l })),
    defaultModel: 'seedance-2.0',
  };
}

// ── 视频参数缓存（按模型类别分开记忆，刷新/切换模型后恢复上次选择） ──
type VideoModelType = 'seedance' | 'happyhorse';
interface SavedVideoParams { resolution: string; ratio: string; duration: string; generateAudio: boolean; }

function readSavedVideoParams(modelType: VideoModelType): SavedVideoParams | null {
  try {
    const raw = localStorage.getItem('seedance_canvas_settings');
    if (!raw) return null;
    const s = JSON.parse(raw);
    const key = modelType === 'happyhorse' ? 'video_params_hh' : 'video_params_sd';
    const p = s[key];
    if (p && typeof p.resolution === 'string' && typeof p.ratio === 'string' && typeof p.duration === 'string') {
      return { resolution: p.resolution, ratio: p.ratio, duration: p.duration, generateAudio: p.generateAudio !== false };
    }
  } catch {}
  return null;
}

function saveVideoParams(modelType: VideoModelType, params: SavedVideoParams) {
  try {
    const raw = localStorage.getItem('seedance_canvas_settings');
    const s = raw ? JSON.parse(raw) : {};
    const key = modelType === 'happyhorse' ? 'video_params_hh' : 'video_params_sd';
    s[key] = params;
    localStorage.setItem('seedance_canvas_settings', JSON.stringify(s));
  } catch {}
}

// ── 模型专属参数 ──

/** Seedance（保持原有正确参数） */
const SD_RES_OPTIONS = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
];
const SD_RATIO_OPTIONS = [
  { value: '9:16', label: '9:16' },
  { value: '3:4', label: '3:4' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
  { value: '21:9', label: '21:9' },
];
const SD_DURATION_OPTIONS = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'];

/** HappyHorse（对齐后端 HAPPYHORSE_RATIOS / HAPPYHORSE_RESOLUTIONS） */
const HH_RES_OPTIONS = [
  { value: '720P', label: '720P' },
  { value: '1080P', label: '1080P' },
];
const HH_RATIO_OPTIONS = [
  { value: '9:16', label: '9:16' },
  { value: '3:4', label: '3:4' },
  { value: '4:5', label: '4:5' },
  { value: '1:1', label: '1:1' },
  { value: '5:4', label: '5:4' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
];
const HH_DURATION_OPTIONS = [
  { value: '3', label: '3s' },
  { value: '4', label: '4s' },
  { value: '5', label: '5s' },
  { value: '6', label: '6s' },
  { value: '7', label: '7s' },
  { value: '8', label: '8s' },
  { value: '9', label: '9s' },
  { value: '10', label: '10s' },
  { value: '11', label: '11s' },
  { value: '12', label: '12s' },
  { value: '13', label: '13s' },
  { value: '14', label: '14s' },
  { value: '15', label: '15s' },
];

// ── 共用小组件 ──
function OptionPill({ selected, theme, onClick, children, disabled }: {
  selected: boolean; theme: NonNullable<VideoPromptPanelProps['theme']>; onClick: () => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button type="button" disabled={disabled}
      className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
      style={{ background: 'transparent', borderColor: selected ? theme.nodeText : theme.nodeStroke, color: theme.nodeText }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >{children}</button>
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
  if (r === '9:16') return { w: 9, h: 16 };
  if (r === '1:1') return { w: 1, h: 1 };
  if (r === '4:3') return { w: 4, h: 3 };
  if (r === '3:4') return { w: 3, h: 4 };
  if (r === '21:9') return { w: 21, h: 9 };
  if (r === '4:5') return { w: 4, h: 5 };
  if (r === '5:4') return { w: 5, h: 4 };
  return { w: 16, h: 9 };
}

interface VideoPromptPanelProps {
  open: boolean;
  nodeId: string | null;
  projectId: number;
  initialPrompt?: string;
  onClose: () => void;
  onGenerated: (videoUrl: string, recordId: number, model: string) => void;
  onGenerating?: (recordId: number, model: string) => void;
  onPromptError?: (errorMessage: string) => void;
  theme?: {
    panel: string; panelBorder: string; nodeFill: string;
    nodeStroke: string; nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

export function CanvasVideoPromptPanel({ open, nodeId: _nodeId, projectId: _projectId, initialPrompt, onClose, onGenerated, onGenerating, onPromptError, theme }: VideoPromptPanelProps) {
  const t = theme || {
    panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c', nodeFill: '#292524',
    nodeStroke: '#44403c', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [prompt, setPrompt] = useState('');
  const { models: VIDEO_MODELS, defaultModel: defaultVideoModel } = readVideoSettings();
  const [model, setModel] = useState<string>(defaultVideoModel);

  // 参数状态 — 优先从 localStorage 恢复上次选择
  const resolveDefaultModelType = (m: string): VideoModelType => m.startsWith('happyhorse') ? 'happyhorse' : 'seedance';
  const defaultMType = resolveDefaultModelType(defaultVideoModel);
  const savedDefaults = readSavedVideoParams(defaultMType);
  const [resolution, setResolution] = useState(savedDefaults?.resolution || (defaultMType === 'happyhorse' ? '720P' : '720p'));
  const [ratio, setRatio] = useState(savedDefaults?.ratio || '16:9');
  const [duration, setDuration] = useState(savedDefaults?.duration || '5');
  const [generateAudio, setGenerateAudio] = useState(savedDefaults?.generateAudio ?? true);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 将错误同步到父组件 → 卡片内显示
  useEffect(() => { if (error) onPromptError?.(error); }, [error]);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [estimate, setEstimate] = useState<PricingEstimate | null>(null);
  const [hhPricing, setHhPricing] = useState<HappyhorsePricingItem[] | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [btnRect, setBtnRect] = useState<DOMRect | null>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const pollingRef = useRef(false);
  const selfStartedRef = useRef(false);

  const isHH = model.startsWith('happyhorse');
  const isSeedance = model.startsWith('seedance');
  const isFast = model === 'seedance-2.0-fast';

  // 切换模型时恢复该模型类型上次保存的参数，没有则用硬编码默认值
  useEffect(() => {
    const mType: VideoModelType = isHH ? 'happyhorse' : 'seedance';
    const saved = readSavedVideoParams(mType);
    if (saved) {
      setResolution(saved.resolution);
      setRatio(saved.ratio);
      setDuration(saved.duration);
      setGenerateAudio(saved.generateAudio);
    } else if (isHH) {
      setResolution('720P');
      setRatio('16:9');
      setDuration('5');
    } else {
      setResolution('720p');
      setRatio('16:9');
      setDuration('5');
    }
  }, [isHH]);

  // 参数变化时自动保存到 localStorage，下次打开恢复
  useEffect(() => {
    const mType: VideoModelType = isHH ? 'happyhorse' : 'seedance';
    saveVideoParams(mType, { resolution, ratio, duration, generateAudio });
  }, [resolution, ratio, duration, generateAudio, isHH]);

  // 拉取 HappyHorse 计费表（仅在 HH 模式时需要）
  useEffect(() => {
    getHappyhorsePricing().then(setHhPricing).catch(() => setHhPricing([]));
  }, []);

  // 实时估算积分
  // - Seedance: 走后端 /api/pricing/estimate
  // - HappyHorse: 前端同步计算（与主页面 happyhorseService.estimateHappyhorseCredits 一致）
  useEffect(() => {
    if (!model) { setEstimate(null); return; }

    if (isHH) {
      // HappyHorse: 同步计算
      const dur = Number(duration);
      const result = estimateHappyhorseCredits('t2v', resolution as '720P' | '1080P', dur, hhPricing);
      setEstimate({
        credits: result.credits,
        lockedCredits: result.lockedCredits,
        tokens: 0, unitPrice: 0, draftFactor: 1, yuan: 0, model,
      });
      return;
    }

    // Seedance: 异步调用后端
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      estimatePricing({
        model,
        outputDurationSec: Number(duration),
        ratio,
        resolution,
        isDraft: false,
      }).then((r) => {
        if (!ctrl.signal.aborted) setEstimate(r);
      }).catch(() => {
        if (!ctrl.signal.aborted) setEstimate(null);
      });
    }, 200);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [model, duration, ratio, resolution, isHH, hhPricing]);

  // sizeLabel
  const durDisplay = `${duration}s`;
  const sizeLabel = `${resolution} · ${ratio} · ${durDisplay}`;

  // 当前模型的分辨率选项
  const resOptions = (isHH ? HH_RES_OPTIONS : SD_RES_OPTIONS).map((r: any) => ({
    ...r,
    disabled: isFast && r.value === '1080p' ? true : !!(r as any).disabled,
  }));
  const ratioOptions = isHH ? HH_RATIO_OPTIONS : SD_RATIO_OPTIONS;
  const durationOptions: { value: string; label: string }[] = isHH
    ? HH_DURATION_OPTIONS
    : SD_DURATION_OPTIONS.map((v) => ({ value: v, label: `${v}s` }));

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
    setPrompt(initialPrompt || '');
    setGenerating(false);
  }, [open]);

  // 余额定时刷新（5s 轮询，与主页面一致）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () => getCreditBalance().then((b) => { if (alive) setBalance(b); }).catch(() => {});
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

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

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || generating) return;

    // 积分预检
    if (balance && !balance.unlimited && estimate && estimate.lockedCredits > 0 && balance.available < estimate.lockedCredits) {
      setError(`可用积分不足（可用 ${balance.available}，本次预计需要 ${estimate.lockedCredits}）`);
      return;
    }

    setGenerating(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        prompt: text,
        model,
        projectId: _projectId,
        ratio,
        duration: parseInt(duration, 10),
      };

      if (isHH) {
        body.resolution = resolution; // 720P / 1080P
        body.mode = 't2v';
        const res = await fetch('/api/happyhorse-tasks', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.success) { setError(data.error || '生成失败'); setGenerating(false); refreshBalance(); return; }
        const taskId: number = data.data?.id;
        if (!taskId) { setError('未获取到任务ID'); setGenerating(false); refreshBalance(); return; }
        selfStartedRef.current = true;
        onGenerating?.(taskId, model);
        pollResultHH(taskId);
      } else {
        body.resolution = resolution;
        body.generateAudio = generateAudio;
        body.watermark = false;
        const res = await fetch('/api/generate-video', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        });
        const data = await res.json();
        // Seedance 端点不返回 success 字段，直接检查 taskId
        const taskId: number = data.taskId;
        if (!taskId) { setError(data.error || '生成失败'); setGenerating(false); refreshBalance(); return; }
        selfStartedRef.current = true;
        onGenerating?.(taskId, model);
        pollResultSD(taskId);
      }
    } catch (e: any) {
      setError(e.message || '请求失败');
      setGenerating(false);
      refreshBalance();
    }
  };

  const pollResultSD = async (taskId: number) => {
    setGenerating(true);
    pollingRef.current = true;
    let failCount = 0;
    while (pollingRef.current) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await fetch(`/api/task/${taskId}`, { headers: getAuthHeaders() });
        if (!res.ok) { failCount++; if (failCount >= 20) { setError('任务超时'); setGenerating(false); refreshBalance(); pollingRef.current = false; return; } continue; }
        failCount = 0;
        const data = await res.json();
        // Seedance 响应: { status: "done"|"processing"|"error", result?: { data: [{ url }] }, error?: string }
        const isDone = data.status === 'done' || data.status === 'succeeded' || data.status === 'SUCCEEDED';
        const isError = data.status === 'error' || data.status === 'failed' || data.status === 'FAILED';
        const videoUrl = data.result?.data?.[0]?.url || data.video_url || data.result_url;
        if (isDone && videoUrl) {
          onGenerated(videoUrl, taskId, model);
          onClose(); setGenerating(false); refreshBalance(); pollingRef.current = false; return;
        }
        if (isError) {
          setError(data.error || data.error_message || data.message || '生成失败');
          setGenerating(false); refreshBalance(); pollingRef.current = false; return;
        }
      } catch { failCount++; if (failCount >= 20) { setError('网络异常'); setGenerating(false); refreshBalance(); pollingRef.current = false; return; } }
    }
  };

  const pollResultHH = async (taskId: number) => {
    setGenerating(true);
    pollingRef.current = true;
    let failCount = 0;
    while (pollingRef.current) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!pollingRef.current) return;
      try {
        const res = await fetch(`/api/happyhorse-tasks/${taskId}`, { headers: getAuthHeaders() });
        if (!res.ok) { failCount++; if (failCount >= 20) { setError('任务超时'); setGenerating(false); refreshBalance(); pollingRef.current = false; return; } continue; }
        failCount = 0;
        const data = await res.json();
        const record = data?.data || data?.task;
        if (!record) continue;
        if ((record.status === 'done' || record.task_status === 'SUCCEEDED') && (record.video_url || record.result_url)) {
          onGenerated(record.video_url || record.result_url, taskId, model);
          onClose(); setGenerating(false); refreshBalance(); pollingRef.current = false; return;
        }
        if (record.status === 'error' || record.task_status === 'FAILED') {
          setError(record.error_message || record.message || '生成失败');
          setGenerating(false); refreshBalance(); pollingRef.current = false; return;
        }
      } catch { failCount++; if (failCount >= 20) { setError('网络异常'); setGenerating(false); refreshBalance(); pollingRef.current = false; return; } }
    }
  };

  if (!open) return null;

  const available = balance?.unlimited ? '无限' : (balance?.available ?? 0).toLocaleString();

  return (
    <div
      className="flex flex-col rounded-2xl border p-3 shadow-2xl backdrop-blur"
      style={{ background: t.panel, borderColor: t.panelBorder, color: t.nodeText, width: '100%', minWidth: 360, maxWidth: 600 }}
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
        placeholder="描述要生成的视频内容"
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
          {/* 模型下拉 */}
          <div className="relative">
            <button ref={modelBtnRef} type="button" disabled={generating}
              className="inline-flex h-8 w-fit min-w-[9rem] max-w-full items-center gap-2 rounded-full border bg-transparent px-3 text-sm font-normal transition-colors"
              style={{ borderColor: modelOpen ? t.nodeText : t.nodeStroke, color: t.nodeText }}
              onClick={(e) => { e.stopPropagation(); setModelOpen((v) => !v); setConfigOpen(false); }}
            >
              <span className="min-w-0 flex-1 truncate text-left">{VIDEO_MODELS.find((m) => m.value === model)?.label || model}</span>
              <ChevronDown className={`size-3.5 shrink-0 opacity-50 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
            </button>
            {modelOpen && (
              <div ref={modelPanelRef}
                className="absolute bottom-full left-0 mb-1.5 z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border p-1 shadow-xl"
                style={{ background: t.panel, borderColor: t.panelBorder }}
                onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              >
                {VIDEO_MODELS.map((m) => (
                  <button key={m.value} type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
                    style={{ color: m.value === model ? t.nodeText : t.nodeMuted, background: m.value === model ? t.nodeFill : 'transparent' }}
                    onClick={() => { setModel(m.value); setModelOpen(false); }}
                  ><span className="truncate">{m.value}</span></button>
                ))}
              </div>
            )}
          </div>

          {/* 参数配置按钮 + Portal 弹窗 */}
          <div className="relative">
            <button ref={configBtnRef} type="button" disabled={generating}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition"
              style={{ background: t.nodeFill, borderColor: configOpen ? t.nodeText : t.nodeStroke, color: t.nodeText }}
              onClick={(e) => { e.stopPropagation(); setConfigOpen((v) => !v); }}
            >
              <Settings2 className="size-3.5" />
              <span className="truncate">{sizeLabel}</span>
            </button>

            {configOpen && btnRect && createPortal(
              <div ref={configPanelRef}
                className="fixed w-[320px] rounded-2xl border p-4 shadow-2xl backdrop-blur space-y-4"
                style={{
                  background: t.panel, borderColor: t.panelBorder, color: t.nodeText,
                  left: Math.max(12, Math.min(window.innerWidth - 320 - 12, btnRect.left)),
                  bottom: window.innerHeight - btnRect.top + 8,
                  maxHeight: Math.max(260, btnRect.top - 24),
                  overflowY: 'auto', zIndex: 1200,
                }}
                onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
              >
                {/* 分辨率 */}
                <div className="space-y-2.5">
                  <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>{isHH ? '分辨率' : '分辨率'}</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {resOptions.map((r) => (
                      <OptionPill key={r.value} selected={resolution === r.value} disabled={r.disabled} theme={t} onClick={() => !r.disabled && setResolution(r.value)}>
                        {r.label}
                      </OptionPill>
                    ))}
                  </div>
                  {isFast && !isHH && <div className="text-[11px] leading-4 opacity-55">fast 模型不支持 1080p，会自动使用 720p。</div>}
                </div>

                {/* 比例 */}
                <div className="space-y-2.5">
                  <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>比例</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {ratioOptions.map((r) => {
                      const wh = ratioWH(r.value);
                      return (
                        <button key={r.value} type="button"
                          className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                          style={{ borderColor: ratio === r.value ? t.nodeText : t.nodeStroke, color: t.nodeText }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => setRatio(r.value)}
                        >
                          <SizePreview w={wh.w} h={wh.h} color={t.nodeText} />
                          <span>{r.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 时长 */}
                <div className="space-y-2.5">
                  <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>时长</div>
                  <div className="grid grid-cols-4 gap-2.5">
                    {durationOptions.map((d) => (
                      <OptionPill key={d.value} selected={duration === d.value} theme={t} onClick={() => setDuration(d.value)}>
                        {d.label}
                      </OptionPill>
                    ))}
                  </div>
                </div>

                {/* Seedance 专属：参考模式 + 输出 */}
                {isSeedance && (
                  <>
                    <div className="space-y-2.5">
                      <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>参考模式</div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm"
                          style={{ background: 'transparent', borderColor: t.nodeText, color: t.nodeText }}
                        >全能参考</button>
                        <button type="button" disabled
                          className="h-9 cursor-not-allowed rounded-full border px-2 text-sm opacity-35"
                          style={{ background: 'transparent', borderColor: t.nodeStroke, color: t.nodeMuted }}
                        >首尾帧</button>
                      </div>
                    </div>

                    <div className="space-y-2.5">
                      <div className="text-xs font-medium" style={{ color: t.nodeMuted }}>输出</div>
                      <div className="rounded-xl border p-2.5 space-y-2" style={{ borderColor: t.nodeStroke }}>
                        <label className="flex items-center justify-between text-xs cursor-pointer" style={{ color: t.nodeText }}>
                          生成声音
                          <input type="checkbox" checked={generateAudio} onChange={(e) => setGenerateAudio(e.target.checked)}
                            className="accent-current" style={{ accentColor: t.nodeText }} />
                        </label>
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
            余额 {available}
            {balance && !balance.unlimited ? (
              <><br />(锁定 {balance.locked.toLocaleString()})</>
            ) : (
              <><br />(锁定 --)</>
            )}
          </span>
          <button type="button" disabled={generating || !prompt.trim()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition disabled:opacity-40"
            style={{ background: generating ? '#dc2626' : t.nodeText, color: generating ? '#fff' : t.panel }}
            onClick={handleSubmit}
          >
            {generating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                生成中
              </>
            ) : (
              <>
                <Zap className="size-3.5 fill-current" strokeWidth={2.4} />
                <span className="text-[10px] leading-tight text-center min-w-[3em]">
                  <span className="tabular-nums">{estimate ? estimate.credits : '--'}</span><br />
                  <span>{estimate ? `(锁定 ${estimate.lockedCredits})` : '(锁定 --)'}</span>
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
