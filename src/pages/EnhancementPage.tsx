import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { listMyEnhancements } from '../services/enhancementService';
import { uploadToOss } from '../services/ossService';
import type { VideoEnhancement, EnhancementPricing, EnhancementResolutionPreset } from '../types';
import { SparkleIcon, SpinnerIcon, DownloadIcon, CloseIcon, GearIcon } from '../components/Icons';
import { formatDateTime, useUserTimezone } from '../utils/datetime';
import {
  getEnhancementPricing,
  submitEnhancement,
  estimateCredits,
  resolutionTier,
} from '../services/enhancementService';

type ToolVersion = VideoEnhancement['tool_version'];
type Scene = VideoEnhancement['scene'];

const SCENE_OPTIONS: Array<{ value: Scene; label: string; desc: string }> = [
  { value: 'short_series', label: '短剧', desc: '人像增强、细节强化' },
  { value: 'common', label: '通用', desc: '默认模板，无特殊场景倾向' },
  { value: 'aigc', label: 'AIGC', desc: 'AI 生成视频，超分到 2K/4K' },
  { value: 'ugc', label: 'UGC 短视频', desc: '修复模糊、块效应、色带' },
  { value: 'old_film', label: '老片修复', desc: '去噪、去划痕、消闪烁' },
];

const RESOLUTION_PRESETS: EnhancementResolutionPreset[] = [
  '240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k',
];

const FPS_PRESETS: Array<{ value: 30 | 60 | 120; label: string; desc: string }> = [
  { value: 30,  label: '30fps',  desc: '默认档，单价 ×1' },
  { value: 60,  label: '60fps',  desc: 'AI 插帧，单价 ×2' },
  { value: 120, label: '120fps', desc: '极致流畅，单价 ×2' },
];

const VERSION_OPTIONS: Array<{ value: ToolVersion; label: string; desc: string }> = [
  { value: 'standard', label: '标准版', desc: 'RTF≈10，6~10 分钟/分钟' },
  { value: 'professional', label: '专业版', desc: 'RTF≈30+，性价比低但效果更好' },
];

const STATUS_BADGE: Record<VideoEnhancement['status'], { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'bg-gray-700/40 text-gray-300 border-gray-600' },
  processing: { text: '处理中', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  done: { text: '已完成', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  error: { text: '失败', cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
};

const SCENE_LABEL: Record<VideoEnhancement['scene'], string> = {
  common: '通用', aigc: 'AIGC', short_series: '短剧', ugc: 'UGC', old_film: '老片修复',
};

const VERSION_LABEL: Record<VideoEnhancement['tool_version'], string> = {
  standard: '标准版', professional: '专业版',
};

export default function EnhancementPage() {
  useUserTimezone();
  const { state, currentUser } = useApp();
  const projectId = state.currentProject?.id ?? null;

  // ── 视频上传 ──────────────────────────────────────────
  const [videoUrl, setVideoUrl] = useState('');
  const [videoDuration, setVideoDuration] = useState<number | ''>('');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [probeError, setProbeError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 自动探测视频时长
  useEffect(() => {
    setProbeError(null);
    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return;
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.crossOrigin = 'anonymous';
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setVideoDuration(Math.round(v.duration));
      } else {
        setProbeError('无法识别视频时长，请手动输入');
      }
    };
    const onErr = () => setProbeError('视频加载失败，可能跨域受限，请手动输入时长');
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
    v.src = videoUrl;
    return () => { v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr); v.src = ''; };
  }, [videoUrl]);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadPct(0);
    try {
      const res = await uploadToOss(file, 'video', (p) => setUploadPct(p));
      setVideoUrl(res.url);
    } catch (e: any) {
      alert(e?.message || '上传失败');
    } finally {
      setUploading(false);
    }
  }

  // ── 参数 ──────────────────────────────────────────────
  const [scene, setScene] = useState<Scene>('short_series');
  const [toolVersion, setToolVersion] = useState<ToolVersion>('standard');
  const [resolutionMode, setResolutionMode] = useState<'preset' | 'custom'>('preset');
  const [resolutionPreset, setResolutionPreset] = useState<EnhancementResolutionPreset>('1080p');
  const [resolutionLimit, setResolutionLimit] = useState<number>(1080);
  const [fpsMode, setFpsMode] = useState<'preset' | 'custom'>('preset');
  const [fpsPreset, setFpsPreset] = useState<30 | 60 | 120>(30);
  const [fpsCustom, setFpsCustom] = useState<number>(30);

  const effectiveResolution: EnhancementResolutionPreset | number =
    resolutionMode === 'preset' ? resolutionPreset : resolutionLimit;
  const effectiveFps = fpsMode === 'preset' ? fpsPreset : fpsCustom;

  // ── 计费 ──────────────────────────────────────────────
  const [pricing, setPricing] = useState<EnhancementPricing | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getEnhancementPricing()
      .then((p) => { if (alive) setPricing(p); })
      .catch((e) => { if (alive) setError(e.message || '加载计费失败'); })
      .finally(() => { if (alive) setPricingLoading(false); });
    return () => { alive = false; };
  }, []);

  const durationSec = typeof videoDuration === 'number' ? videoDuration : 0;
  const credits = estimateCredits(durationSec, toolVersion, effectiveResolution, effectiveFps, pricing);
  const userBalance = currentUser?.credits ?? 0;
  const unlimited = !!currentUser?.unlimitedCredits;
  const insufficient = !unlimited && credits > userBalance;
  const tier = resolutionTier(effectiveResolution);
  const canSubmit = !!videoUrl && !!videoDuration && !uploading && !submitting && !pricingLoading && !(insufficient && !unlimited);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        scene, toolVersion, targetFps: effectiveFps, projectId,
        ...(resolutionMode === 'preset' ? { resolution: resolutionPreset } : { resolutionLimit }),
        videoUrl, durationSeconds: durationSec,
      };
      const { enhancement } = await submitEnhancement(params as any);
      // 刷新记录
      setRecords((prev) => [enhancement, ...prev]);
      setRecordsTotal((n) => n + 1);
      // 清空表单
      setVideoUrl('');
      setVideoDuration('');
    } catch (e: any) {
      setError(e?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  // ── 历史记录 ──────────────────────────────────────────
  const [records, setRecords] = useState<VideoEnhancement[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const RECORDS_PAGE_SIZE = 10;

  async function loadRecords(page = 1) {
    setRecordsLoading(true);
    try {
      const data = await listMyEnhancements(page, RECORDS_PAGE_SIZE, projectId);
      setRecords(data.items);
      setRecordsTotal(data.total);
      setRecordsPage(page);
    } catch (e) {
      console.error('[enhancement] 加载增强记录失败', e);
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => { loadRecords(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  // 处理中轮询
  const hasProcessing = useMemo(
    () => records.some((r) => r.status === 'processing' || r.status === 'pending'),
    [records],
  );
  useEffect(() => {
    if (!hasProcessing) return;
    const t = setInterval(() => loadRecords(recordsPage), 45000);
    return () => clearInterval(t);
  }, [hasProcessing, recordsPage, projectId]);

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">画质增强</h1>
      </div>

      {/* Left Panel */}
      <div className="flex-1 md:w-[520px] md:flex-none md:border-r border-gray-800 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        <div className="hidden md:flex flex-col gap-1 mb-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold truncate">画质增强</h2>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => void loadRecords(recordsPage)}
                disabled={recordsLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-50"
              >
                <svg className={`w-4 h-4 ${recordsLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {recordsLoading ? '刷新中...' : '刷新'}
            </button>
            <button onClick={() => window.location.href='/settings'} className="btn-ghost" title="设置">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
        {state.currentProject && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-2.5 py-1 rounded-xl bg-purple-500/20 border border-purple-500/30 text-purple-300 font-medium truncate max-w-[300px]">
              {state.currentProject.name}
            </span>
          </div>
        )}
      </div>

        <div className="space-y-4">
          {/* 视频上传 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-sm font-bold text-gray-300 mb-2 block">
              上传视频 <span className="text-xs text-gray-500 font-normal">（拖拽或点击上传，自动探测时长）</span>
            </label>

            {!videoUrl ? (
              <div
                onClick={() => !uploading && fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f && !uploading) handleUpload(f); }}
                className={`w-full border border-dashed border-gray-700 rounded-2xl flex flex-col items-center justify-center py-8 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}
              >
                {uploading ? (
                  <div className="text-gray-400 text-sm flex items-center gap-2">
                    <SpinnerIcon className="w-5 h-5 animate-spin" /> 上传中 {uploadPct}%
                  </div>
                ) : (
                  <div className="text-gray-500 text-xs text-center">
                    <svg className="w-10 h-10 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                    <span className="block">点击或拖拽视频到此处</span>
                    <span className="text-gray-600 text-[10px] mt-1 block">支持 MP4 / MOV，单文件 ≤ 200MB</span>
                  </div>
                )}
                <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }} />
              </div>
            ) : (
              <div className="space-y-3">
                <video src={videoUrl} controls muted playsInline preload="metadata" className="w-full rounded-xl bg-black max-h-48" />
                <div className="flex gap-2">
                  <button onClick={() => { setVideoUrl(''); setVideoDuration(''); setProbeError(null); }}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                    重新选择
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 时长 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-2">视频时长（秒）</label>
            <input type="number" min={1} max={300}
              value={videoDuration}
              onChange={(e) => { const v = e.target.value; setVideoDuration(v === '' ? '' : Math.max(1, Math.min(300, Number(v)))); }}
              placeholder="自动探测；探测失败时手动输入"
              className="w-full bg-[#0d0f1a] border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none" />
            {probeError && <div className="text-[11px] text-amber-400 mt-1">{probeError}</div>}
          </div>

          {/* 场景 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">场景</label>
            <div className="grid grid-cols-2 gap-2">
              {SCENE_OPTIONS.map((s) => (
                <button key={s.value} onClick={() => setScene(s.value)}
                  className={`text-left p-2.5 rounded-lg border transition-all ${scene === s.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 hover:border-gray-600'}`}>
                  <div className={`text-sm ${scene === s.value ? 'text-purple-300' : 'text-gray-300'}`}>{s.label}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 版本 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">版本</label>
            <div className="grid grid-cols-2 gap-2">
              {VERSION_OPTIONS.map((v) => (
                <button key={v.value} onClick={() => setToolVersion(v.value)}
                  className={`text-left p-2.5 rounded-lg border transition-all ${toolVersion === v.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 hover:border-gray-600'}`}>
                  <div className={`text-sm ${toolVersion === v.value ? 'text-purple-300' : 'text-gray-300'}`}>{v.label}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{v.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 目标分辨率 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">目标分辨率</label>
            <div className="flex gap-1 border-b border-gray-800 mb-3">
              {[{ k: 'preset' as const, label: '预设档位' }, { k: 'custom' as const, label: '自定义短边' }].map((t) => (
                <button key={t.k} onClick={() => setResolutionMode(t.k)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${resolutionMode === t.k ? 'border-purple-500 text-purple-300' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {resolutionMode === 'preset' ? (
              <div className="grid grid-cols-8 gap-2">
                {RESOLUTION_PRESETS.map((r) => (
                  <button key={r} onClick={() => setResolutionPreset(r)}
                    className={`py-2 text-sm rounded-lg border transition-all ${resolutionPreset === r ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700 text-gray-400 hover:border-gray-600'}`}>
                    {r}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <input type="range" min={64} max={2160} step={1} value={resolutionLimit}
                    onChange={(e) => setResolutionLimit(Number(e.target.value))} className="flex-1 accent-purple-500" />
                  <input type="number" min={64} max={2160} value={resolutionLimit}
                    onChange={(e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setResolutionLimit(Math.max(64, Math.min(2160, v))); }}
                    className="w-20 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-white text-sm" />
                </div>
              </div>
            )}
          </div>

          {/* 输出帧率 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">输出帧率</label>
            <div className="flex gap-1 border-b border-gray-800 mb-3">
              {[{ k: 'preset' as const, label: '预设值' }, { k: 'custom' as const, label: '自定义 (1~120)' }].map((t) => (
                <button key={t.k} onClick={() => setFpsMode(t.k)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${fpsMode === t.k ? 'border-purple-500 text-purple-300' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            {fpsMode === 'preset' ? (
              <div className="grid grid-cols-3 gap-2">
                {FPS_PRESETS.map((f) => (
                  <button key={f.value} onClick={() => setFpsPreset(f.value)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${fpsPreset === f.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 hover:border-gray-600'}`}>
                    <div className={`text-sm ${fpsPreset === f.value ? 'text-purple-300' : 'text-gray-300'}`}>{f.label}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">{f.desc}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input type="range" min={1} max={120} step={1} value={fpsCustom}
                  onChange={(e) => setFpsCustom(Number(e.target.value))} className="flex-1 accent-purple-500" />
                <input type="number" min={1} max={120} value={fpsCustom}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setFpsCustom(Math.max(1, Math.min(120, v))); }}
                  className="w-20 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-white text-sm" />
                <span className="text-xs text-gray-500">fps</span>
              </div>
            )}
          </div>

          {/* 预估积分 + 提交 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <div className="bg-[#0f111a] border border-gray-800 rounded-xl p-3 mb-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">预估积分</span>
                <span className={`text-sm font-semibold ${insufficient ? 'text-red-400' : 'text-purple-300'}`}>
                  {pricingLoading ? '...' : `${credits} 积分`}
                </span>
              </div>
              <div className="text-[10px] text-gray-500 mt-1">
                {pricing
                  ? `${(durationSec / 60).toFixed(2)} 分钟 × 系数（${tier} · ${effectiveFps > 30 ? '>30fps' : '≤30fps'}） × ${pricing.baseCreditsPerMinute} 积分/分钟`
                  : '视频时长 × 系数 × 基础单价'}
                {unlimited ? '（无限积分）' : `；当前可用 ${currentUser?.credits ?? 0} 积分`}
              </div>
              {insufficient && <div className="text-[11px] text-red-400 mt-1.5">可用积分不足，请联系管理员充值</div>}
            </div>

            {error && <div className="text-xs text-red-400 bg-red-950/30 rounded-lg px-3 py-2 mb-3">{error}</div>}

            <button onClick={handleSubmit} disabled={!canSubmit}
              className="w-full font-bold py-3 rounded-xl transition-all bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2">
              {submitting ? (
                <><SpinnerIcon className="w-4 h-4 animate-spin" />提交中...</>
              ) : !videoUrl ? (
                '请先上传视频'
              ) : insufficient && !unlimited ? (
                `⚠️ 积分不足（需 ${credits}）`
              ) : (
                <><SparkleIcon className="w-4 h-4" />提交增强</>
              )}
            </button>

            <div className="text-[10px] text-gray-600 mt-2 leading-relaxed text-center">
              MediaKit 处理耗时较长（标准版 6~10 分钟，专业版 30+ 分钟），完成后自动出现在右侧记录列表
            </div>
          </div>
        </div>
      </div>

      {/* Right Panel - Records */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">增强记录</h2>
          <span className="text-xs text-gray-500">{recordsTotal > 0 ? `共 ${recordsTotal} 条` : ''}</span>
        </div>

        {recordsLoading ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <SpinnerIcon className="w-6 h-6 animate-spin" />
          </div>
        ) : records.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">还没有提交过增强任务</div>
        ) : (
          <div className="px-4 pb-4 space-y-3">
            {records.map((r) => <RecordRow key={r.id} r={r} />)}
            {recordsTotal > RECORDS_PAGE_SIZE && (
              <div className="flex justify-center pt-2">
                <Pager page={recordsPage} total={recordsTotal} pageSize={RECORDS_PAGE_SIZE} onChange={(p) => loadRecords(p)} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 子组件 ──────────────────────────────────────────────

function Pager({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
      <span className="text-gray-400">{page} / {totalPages}</span>
      <button disabled={page >= totalPages} onClick={() => onChange(page + 1)} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
    </div>
  );
}

function RecordRow({ r }: { r: VideoEnhancement }) {
  const badge = STATUS_BADGE[r.status];
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  return (
    <>
      <div className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
        <div className="flex gap-3 p-3 items-start">
          {/* 原片缩略图 */}
          <div className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] cursor-pointer relative group"
            onClick={() => r.source_video_url && setPreviewUrl(r.source_video_url)}>
            {r.source_video_url ? (
              <video src={r.source_video_url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-[10px]">无原片</div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
              <span className="text-[10px] text-gray-300">原片</span>
            </div>
          </div>
          {/* 信息区 */}
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] px-2 py-0.5 rounded border ${badge.cls}`}>{badge.text}</span>
              <span className="text-xs text-gray-300 truncate">
                {SCENE_LABEL[r.scene]} · {VERSION_LABEL[r.tool_version]} · {r.target_resolution ?? (r.resolution_limit ? `${r.resolution_limit}px` : '-')} · {r.target_fps ?? 30}fps
              </span>
              {r.task_id == null && <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">外部视频</span>}
            </div>
            <div className="text-[11px] text-gray-500">
              提交于 {formatDateTime(r.created_at)}{r.duration_seconds ? ` · 时长 ${r.duration_seconds}s` : ''}
            </div>
            {r.status === 'done' && r.credits_used != null && (
              <span className="self-start text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20" title="本次实际扣除积分">
                {r.credits_used > 0 ? `${r.credits_used}积分` : '未计费'}
              </span>
            )}
            {r.status === 'error' && r.error_message && <div className="text-[11px] text-red-400 break-all">{r.error_message}</div>}
            {r.status === 'processing' && (
              <div className="text-[11px] text-blue-300">
                <SpinnerIcon className="w-3 h-3 inline-block animate-spin mr-1" />MediaKit 处理中...
              </div>
            )}
          </div>
          {/* 增强片缩略图 */}
          <div className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] relative group">
            {r.status === 'done' && r.enhanced_video_url ? (
              <>
                <video src={r.enhanced_video_url} muted playsInline preload="metadata"
                  onClick={() => r.enhanced_video_url && setPreviewUrl(r.enhanced_video_url)}
                  className="w-full h-full object-cover cursor-pointer" />
                <button onClick={() => { const u = r.enhanced_video_url; if (!u) return; const a = document.createElement('a'); a.href = `/api/video-proxy?url=${encodeURIComponent(u)}&download=enhanced_${r.id}.mp4`; a.click(); }}
                  className="absolute bottom-1 right-1 bg-purple-600 hover:bg-purple-500 text-white rounded-lg p-1.5 opacity-0 group-hover:opacity-100 transition-all z-10" title="下载">
                  <DownloadIcon className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-[10px]">
                {r.status === 'done' ? '链接已过期' : '待生成'}
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
              <span className="text-[10px] text-purple-300">增强片</span>
            </div>
          </div>
        </div>
      </div>
      {previewUrl && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setPreviewUrl(null)}>
          <button onClick={() => setPreviewUrl(null)} className="absolute top-4 right-4 w-10 h-10 rounded-full bg-gray-800 hover:bg-gray-700 flex items-center justify-center">
            <CloseIcon className="w-5 h-5 text-white" />
          </button>
          <video src={previewUrl} controls autoPlay className="max-w-full max-h-full" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}
