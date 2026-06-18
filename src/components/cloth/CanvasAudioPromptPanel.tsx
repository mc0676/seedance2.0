// 音频节点下方生成面板 — 复刻 CanvasVideoPromptPanel 提交/估价/锁定逻辑
import { useState, useEffect, useCallback, useRef } from 'react';
import { Zap, ArrowUp, Box, Loader2 } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';
import { getCreditBalance, estimatePricing, type CreditBalance, type PricingEstimate } from '../../services/pricingService';
import { submitAudioGeneration } from '../../services/audioService';

interface AudioGenConfig {
  model: string;
  ratio: string;
  resolution: string;
  duration: number;
}

interface CanvasAudioPromptPanelProps {
  open: boolean;
  nodeId: string;
  projectId: number;
  onClose: () => void;
  onPromptLibrary?: () => void;
  onGenerating?: (recordId: number, model: string, prompt: string) => void;
  onPromptError?: (errorMessage: string) => void;
  isGenerating?: boolean;
  generatingRecordId?: number | null;
  savedPrompt?: string;
  selectedAsset?: { thumbnail_url?: string; file_url?: string; name?: string; volc_asset_id?: string } | null;
  theme?: {
    panel: string; panelBorder: string; nodeFill: string;
    nodeStroke: string; nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

const MODEL_LABELS: Record<string, string> = {
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
};

export function CanvasAudioPromptPanel({ open, onClose, onPromptLibrary, onGenerating, onPromptError, isGenerating, generatingRecordId, savedPrompt, selectedAsset, theme, projectId }: CanvasAudioPromptPanelProps) {
  const t = theme || {
    panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c', nodeFill: '#292524',
    nodeStroke: '#44403c', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [config, setConfig] = useState<AudioGenConfig | null>(null);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [estimate, setEstimate] = useState<PricingEstimate | null>(null);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  // 将错误同步到父组件 → 卡片内显示
  useEffect(() => { if (error) onPromptError?.(error); }, [error, onPromptError]);
  const pollingRef = useRef(false);
  const recordIdRef = useRef<number | null>(null);
  const selfStartedRef = useRef(false);

  // 拉取配置 + 余额（首次）
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const [configRes, bal] = await Promise.all([
          fetch('/api/audio-generations/config', { headers: getAuthHeaders() }),
          getCreditBalance(),
        ]);
        const data = await configRes.json();
        if (data.success && data.data) setConfig(data.data as AudioGenConfig);
        setBalance(bal);
      } catch { /* ignore */ }
    })();
  }, [open]);

  // 余额定时刷新（5s 轮询，与主页面一致）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () => getCreditBalance().then((b) => { if (alive) setBalance(b); }).catch(() => {});
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

  // 复位面板 — 仅在面板打开/关闭时触发；若节点标记为生成中则恢复并重启轮询
  useEffect(() => {
    if (!open) return;
    setError('');
    if (isGenerating) {
      setGenerating(true);
      selfStartedRef.current = true;
      if (savedPrompt) setPrompt(savedPrompt);
      // 若已有 recordId 且未在轮询中，重启轮询
      if (generatingRecordId && !pollingRef.current) {
        recordIdRef.current = generatingRecordId;
        pollResult(generatingRecordId);
      }
      return;
    }
    pollingRef.current = false;
    if (selfStartedRef.current) { selfStartedRef.current = false; return; }
    setPrompt('');
    setGenerating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 实时估价（配置固定，仅在 config 变化时请求）
  useEffect(() => {
    if (!config) { setEstimate(null); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      estimatePricing({
        model: config.model,
        outputDurationSec: config.duration,
        ratio: config.ratio,
        resolution: config.resolution,
        isDraft: false,
      }).then((r) => {
        if (!ctrl.signal.aborted) setEstimate(r);
      }).catch(() => {
        if (!ctrl.signal.aborted) setEstimate(null);
      });
    }, 200);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [config]);

  const refreshBalance = useCallback(async () => {
    try { setBalance(await getCreditBalance()); } catch { /* ignore */ }
  }, []);

  const handleSubmit = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    if (!selectedAsset?.file_url && !selectedAsset?.thumbnail_url) {
      setError('请先选择参考图片（点击左下角 提示词库）');
      return;
    }

    // 积分预检
    if (balance && !balance.unlimited && estimate && estimate.lockedCredits > 0 && balance.available < estimate.lockedCredits) {
      setError(`可用积分不足（可用 ${balance.available}，本次预计需要 ${estimate.lockedCredits}）`);
      return;
    }

    setGenerating(true);
    setError('');
    try {
      const refUrl = selectedAsset.file_url || selectedAsset.thumbnail_url || '';
      const result = await submitAudioGeneration({
        projectId,
        referenceImageUrl: refUrl,
        referenceAssetUri: selectedAsset.volc_asset_id ? `asset://${selectedAsset.volc_asset_id}` : undefined,
        voicePrompt: text,
      });
      selfStartedRef.current = true;
      recordIdRef.current = result.audioGenerationId;
      onGenerating?.(result.audioGenerationId, config?.model || '', text);
      pollResult(result.audioGenerationId);
    } catch (e: any) {
      setError(e.message || '请求失败');
      setGenerating(false);
      refreshBalance();
    }
  };

  const pollResult = async (recordId: number) => {
    pollingRef.current = true;
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (!pollingRef.current) return;
      try {
        const res = await fetch(`/api/audio-generations/${recordId}`, { headers: getAuthHeaders() });
        const d = await res.json();
        if (d.success && d.data) {
          const rec = d.data;
          const url = rec.intermediate_video_url || rec.task_video_url || '';
          if (rec.status === 'done' && url) {
            setGenerating(false);
            refreshBalance();
            return;
          }
          if (rec.status === 'error') {
            const errMsg = rec.error_message || '生成失败';
            setError(errMsg);
            setGenerating(false);
            refreshBalance();
            return;
          }
        }
      } catch { /* 继续轮询 */ }
    }
    setError('生成超时，请稍后查看下载管理');
    setGenerating(false);
    refreshBalance();
  };

  if (!open) return null;

  const configLabel = config
    ? `${MODEL_LABELS[config.model] || config.model} · ${config.ratio} · ${config.resolution} · ${config.duration}s`
    : '加载中...';

  const available = balance?.unlimited ? '无限' : (balance?.available ?? 0).toLocaleString();
  const estimateCredits = estimate?.credits;
  const estimateLocked = estimate?.lockedCredits;

  return (
    <div
      className="flex flex-col rounded-2xl border p-3 shadow-2xl backdrop-blur"
      style={{
        background: t.panel, borderColor: t.panelBorder, color: t.nodeText,
        width: '100%', minWidth: 360, maxWidth: 600,
      }}
    >
      {/* 提示词输入 + 火山资源缩略图 — 同一行，方形预览在右侧 */}
      <div className="flex gap-2">
        <textarea
          className="thin-scrollbar h-20 flex-1 resize-none rounded-xl border px-3 py-2 text-sm leading-5 outline-none"
          placeholder='例如：用兴奋激昂的语气说：“欢迎来到我的世界！”'
          style={{ background: t.nodeFill, borderColor: t.nodeStroke, color: t.nodeText }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {selectedAsset?.thumbnail_url || selectedAsset?.file_url ? (
          <div
            className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border"
            style={{ borderColor: t.panelBorder, background: t.nodeFill }}
          >
            <img
              src={selectedAsset.thumbnail_url || selectedAsset.file_url}
              alt={selectedAsset.name || '火山资源'}
              className="h-full w-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        ) : (
          <div
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed"
            style={{ borderColor: t.nodeStroke, color: t.nodeFaint }}
          >
            <span className="text-center text-[10px] leading-tight px-1">点击左下角选择图片</span>
          </div>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mt-2 text-[11px] leading-tight" style={{ color: '#ef4444' }}>{error}</div>
      )}

      {/* 底部操作栏 — 复刻原项目 canvas-node-prompt-panel 布局 */}
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
        {/* 左侧工具组：提示词库按钮 + 配置胶囊（复刻原项目左侧第一个是提示词库按钮） */}
        <div className="flex min-w-0 items-center gap-2">
          {onPromptLibrary && (
            <button
              type="button"
              onClick={onPromptLibrary}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-transparent p-0 transition hover:brightness-110"
              style={{ color: t.nodeText }}
              aria-label="提示词库"
              title="提示词库"
            >
              <Box className="size-3.5" />
            </button>
          )}
          <span
            className="inline-flex h-8 w-fit min-w-[9rem] max-w-full items-center gap-2 rounded-full border bg-transparent px-3 text-sm font-normal"
            style={{ borderColor: t.panelBorder, color: t.nodeText }}
          >
            <span className="min-w-0 flex-1 truncate text-left">{configLabel}</span>
          </span>
        </div>

        {/* 右侧：余额 + 生成按钮 — 完全复刻视频面板 */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="shrink-0 text-[10px] leading-tight text-right whitespace-nowrap"
            style={{ color: t.nodeFaint }}
          >
            余额 {available}
            {balance && !balance.unlimited ? (
              <><br />(锁定 {balance.locked.toLocaleString()})</>
            ) : (
              <><br />(锁定 --)</>
            )}
          </span>
          <button
            type="button"
            disabled={generating || !prompt.trim() || (!selectedAsset?.thumbnail_url && !selectedAsset?.file_url)}
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
                  <span className="tabular-nums">{estimateCredits != null ? estimateCredits : '--'}</span>
                  <br />
                  <span>{estimateLocked != null ? `(锁定 ${estimateLocked})` : '(锁定 --)'}</span>
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
