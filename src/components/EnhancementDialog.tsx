import { useEffect, useMemo, useState } from 'react';
import type { VideoEnhancement, EnhancementPricing, EnhancementResolutionPreset } from '../types/index';
import { CloseIcon } from './Icons';
import {
  getEnhancementPricing,
  submitEnhancement,
  estimateCredits,
  resolutionTier,
} from '../services/enhancementService';

type ToolVersion = VideoEnhancement['tool_version'];
type Scene = VideoEnhancement['scene'];

export type EnhancementSource =
  | { kind: 'task'; taskId: number; durationSec: number; sourceResolution?: string }
  | { kind: 'url'; videoUrl: string; durationSec: number };

interface EnhancementDialogProps {
  source: EnhancementSource;
  userBalance: number;
  unlimited?: boolean;
  onClose: () => void;
  onSubmitted: (enhancement: VideoEnhancement) => void;
}

const SCENE_OPTIONS: Array<{ value: Scene; label: string; desc: string }> = [
  { value: 'common', label: '通用', desc: '默认模板，无特殊场景倾向' },
  { value: 'aigc', label: 'AIGC', desc: 'AI 生成视频，超分到 2K/4K 并细节重绘' },
  { value: 'short_series', label: '短剧', desc: '人像增强、细节强化' },
  { value: 'ugc', label: 'UGC 短视频', desc: '修复模糊、块效应、色带' },
  { value: 'old_film', label: '老片修复', desc: '去噪、去划痕、消闪烁、色偏修正' },
];

const RESOLUTION_PRESETS: EnhancementResolutionPreset[] = [
  '240p', '360p', '480p', '540p', '720p', '1080p', '2k', '4k',
];

// 系数表中的档位边界（短边像素 ≤）。低于第一档（240p < 720）的也归入 720p 档。
const TIER_BOUNDARIES = [
  { tier: '720p',  upper: 720 },
  { tier: '1080p', upper: 1080 },
  { tier: '2k',    upper: 1440 },
  { tier: '4k',    upper: 2160 },
] as const;

const FPS_PRESETS: Array<{ value: 30 | 60 | 120; label: string; desc: string }> = [
  { value: 30,  label: '30fps',  desc: '默认档，单价 ×1' },
  { value: 60,  label: '60fps',  desc: 'AI 插帧，单价 ×2' },
  { value: 120, label: '120fps', desc: '极致流畅，单价 ×2' },
];

const VERSION_OPTIONS: Array<{ value: ToolVersion; label: string; desc: string }> = [
  { value: 'standard', label: '标准版', desc: 'RTF≈10，6~10 分钟/分钟' },
  { value: 'professional', label: '专业版', desc: 'RTF≈30+，性价比低但效果更好' },
];

// 预设 → 等效短边像素（用于「自定义」tab 初始化与显示）
function presetToShortEdge(p: EnhancementResolutionPreset): number {
  switch (p) {
    case '240p': return 240;
    case '360p': return 360;
    case '480p': return 480;
    case '540p': return 540;
    case '720p': return 720;
    case '1080p': return 1080;
    case '2k': return 1440;
    case '4k': return 2160;
  }
}

// 给定短边像素，返回计费档位 + 是否「卡在预设边界」+ 落到的边界值
function describeTier(shortEdge: number): { tier: '720p' | '1080p' | '2k' | '4k'; isExact: boolean; boundary: number } {
  for (const b of TIER_BOUNDARIES) {
    if (shortEdge <= b.upper) {
      return { tier: b.tier, isExact: shortEdge === b.upper, boundary: b.upper };
    }
  }
  return { tier: '4k', isExact: false, boundary: 2160 };
}

export default function EnhancementDialog({
  source,
  userBalance,
  unlimited,
  onClose,
  onSubmitted,
}: EnhancementDialogProps) {
  const durationSec = source.durationSec;
  const sourceResolution = source.kind === 'task' ? source.sourceResolution : undefined;
  const [scene, setScene] = useState<Scene>('common');
  const [toolVersion, setToolVersion] = useState<ToolVersion>('standard');

  // 分辨率 tab：'preset' = 八档预设；'custom' = 自定义短边 [64, 2160]
  const [resolutionMode, setResolutionMode] = useState<'preset' | 'custom'>('preset');
  const [resolutionPreset, setResolutionPreset] = useState<EnhancementResolutionPreset>(() => {
    if (sourceResolution === '480p') return '720p';
    if (sourceResolution === '720p') return '1080p';
    return '1080p';
  });
  const [resolutionLimit, setResolutionLimit] = useState<number>(1080);

  // fps tab：'preset' = 30/60/120；'custom' = 自定义 [1, 120]
  const [fpsMode, setFpsMode] = useState<'preset' | 'custom'>('preset');
  const [fpsPreset, setFpsPreset] = useState<30 | 60 | 120>(30);
  const [fpsCustom, setFpsCustom] = useState<number>(30);

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

  // 当前生效的分辨率值（用于计费 + 提交）
  const effectiveResolutionValue: EnhancementResolutionPreset | number =
    resolutionMode === 'preset' ? resolutionPreset : resolutionLimit;
  const effectiveFps = fpsMode === 'preset' ? fpsPreset : fpsCustom;

  // 用于显示档位 / 警告：自定义模式时根据短边判定档位
  const customTierInfo = useMemo(() => {
    if (resolutionMode !== 'custom') return null;
    return describeTier(resolutionLimit);
  }, [resolutionMode, resolutionLimit]);

  const credits = estimateCredits(durationSec, toolVersion, effectiveResolutionValue, effectiveFps, pricing);
  const insufficient = !unlimited && credits > userBalance;
  const tier = resolutionTier(effectiveResolutionValue);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const params: Parameters<typeof submitEnhancement>[0] = {
        scene,
        toolVersion,
        targetFps: effectiveFps,
        ...(resolutionMode === 'preset'
          ? { resolution: resolutionPreset }
          : { resolutionLimit }),
        ...(source.kind === 'task'
          ? { taskId: source.taskId }
          : { videoUrl: source.videoUrl, durationSeconds: source.durationSec }),
      };
      const { enhancement } = await submitEnhancement(params);
      onSubmitted(enhancement);
      onClose();
    } catch (e: any) {
      setError(e?.message || '提交失败');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#1c1f2e] border border-gray-700 rounded-2xl w-[60vw] max-w-[1100px] min-w-[640px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-white">画质增强</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-gray-800 flex items-center justify-center"
          >
            <CloseIcon className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* 上半：场景 + 版本（两列） */}
          <div className="grid grid-cols-2 gap-5">
            {/* 场景 */}
            <div>
              <div className="text-xs text-gray-400 mb-2">场景</div>
              <div className="grid grid-cols-2 gap-2">
                {SCENE_OPTIONS.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setScene(s.value)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      scene === s.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm ${scene === s.value ? 'text-purple-300' : 'text-gray-300'}`}>
                      {s.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{s.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* 版本 */}
            <div>
              <div className="text-xs text-gray-400 mb-2">版本</div>
              <div className="grid grid-cols-2 gap-2">
                {VERSION_OPTIONS.map((v) => (
                  <button
                    key={v.value}
                    onClick={() => setToolVersion(v.value)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      toolVersion === v.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm ${toolVersion === v.value ? 'text-purple-300' : 'text-gray-300'}`}>
                      {v.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{v.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 目标分辨率 (Tab) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">目标分辨率</span>
              {sourceResolution && (
                <span className="text-[10px] text-gray-600">原始分辨率：{sourceResolution}</span>
              )}
            </div>
            <div className="flex gap-1 border-b border-gray-800 mb-3">
              {[
                { k: 'preset' as const, label: '预设档位' },
                { k: 'custom' as const, label: '自定义短边' },
              ].map((t) => (
                <button
                  key={t.k}
                  onClick={() => setResolutionMode(t.k)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                    resolutionMode === t.k
                      ? 'border-purple-500 text-purple-300'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {resolutionMode === 'preset' ? (
              <div className="grid grid-cols-8 gap-2">
                {RESOLUTION_PRESETS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setResolutionPreset(r)}
                    className={`py-2 text-sm rounded-lg border transition-all ${
                      resolutionPreset === r
                        ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                        : 'border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={64}
                    max={2160}
                    step={1}
                    value={resolutionLimit}
                    onChange={(e) => setResolutionLimit(Number(e.target.value))}
                    className="flex-1 accent-purple-500"
                  />
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={64}
                      max={2160}
                      value={resolutionLimit}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v)) setResolutionLimit(Math.max(64, Math.min(2160, v)));
                      }}
                      className="w-20 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-white text-sm"
                    />
                    <span className="text-xs text-gray-500">px 短边</span>
                  </div>
                  <button
                    onClick={() => setResolutionLimit(presetToShortEdge(resolutionPreset))}
                    className="text-[10px] text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
                  >
                    同步预设
                  </button>
                </div>
                {customTierInfo && (
                  <div
                    className={`text-[11px] rounded-md px-2 py-1.5 border ${
                      customTierInfo.isExact
                        ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                        : 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                    }`}
                  >
                    {customTierInfo.isExact ? (
                      <>命中预设档位 <strong>{customTierInfo.tier}</strong>，按该档单价计费</>
                    ) : (
                      <>
                        ⚠ 当前 {resolutionLimit}px 落在「{customTierInfo.tier}」档（短边 ≤ {customTierInfo.boundary}px）。
                        MediaKit 按所在档计费，<strong>不会按像素比例精确计算价格</strong>。
                        如需更低单价请将短边降至 {prevTierUpper(customTierInfo.tier)}px 或以下。
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 输出帧率 (Tab) */}
          <div>
            <div className="text-xs text-gray-400 mb-2">输出帧率</div>
            <div className="flex gap-1 border-b border-gray-800 mb-3">
              {[
                { k: 'preset' as const, label: '预设值' },
                { k: 'custom' as const, label: '自定义 (1~120)' },
              ].map((t) => (
                <button
                  key={t.k}
                  onClick={() => setFpsMode(t.k)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                    fpsMode === t.k
                      ? 'border-purple-500 text-purple-300'
                      : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {fpsMode === 'preset' ? (
              <div className="grid grid-cols-3 gap-2">
                {FPS_PRESETS.map((f) => (
                  <button
                    key={f.value}
                    onClick={() => setFpsPreset(f.value)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      fpsPreset === f.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm ${fpsPreset === f.value ? 'text-purple-300' : 'text-gray-300'}`}>
                      {f.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{f.desc}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={120}
                    step={1}
                    value={fpsCustom}
                    onChange={(e) => setFpsCustom(Number(e.target.value))}
                    className="flex-1 accent-purple-500"
                  />
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={fpsCustom}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v)) setFpsCustom(Math.max(1, Math.min(120, v)));
                      }}
                      className="w-20 px-2 py-1 bg-[#0f111a] border border-gray-700 rounded text-white text-sm"
                    />
                    <span className="text-xs text-gray-500">fps</span>
                  </div>
                </div>
                <div
                  className={`text-[11px] rounded-md px-2 py-1.5 border ${
                    fpsCustom > 30
                      ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                      : 'text-gray-400 bg-gray-700/20 border-gray-700'
                  }`}
                >
                  {fpsCustom > 30 ? (
                    <>当前 {fpsCustom}fps 落在 <strong>&gt;30fps</strong> 档，单价 ×2；建议输出 ≤ 源帧率 × 4</>
                  ) : (
                    <>当前 {fpsCustom}fps 落在 <strong>≤30fps</strong> 档，基础单价 ×1</>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 预估积分 */}
          <div className="bg-[#0f111a] border border-gray-800 rounded-xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">预估积分</span>
              <span className={`text-sm font-semibold ${insufficient ? 'text-red-400' : 'text-purple-300'}`}>
                {pricingLoading ? '...' : `${credits}`} 积分
              </span>
            </div>
            <div className="text-[10px] text-gray-500 mt-1">
              {pricing
                ? `${(durationSec / 60).toFixed(2)} 分钟 × 系数（${tier} · ${effectiveFps > 30 ? '>30fps' : '≤30fps'}） × ${pricing.baseCreditsPerMinute} 积分/分钟`
                : '视频时长 × 系数 × 基础单价'}
              {unlimited ? '（你是无限积分用户，实际不扣费）' : `；当前可用 ${userBalance} 积分`}
            </div>
            {insufficient && (
              <div className="text-[11px] text-red-400 mt-1.5">可用积分不足，请联系管理员充值</div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-950/30 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="text-[10px] text-gray-600 leading-relaxed">
            提示：MediaKit 处理耗时较长（标准版 6~10 分钟，专业版 30+ 分钟），任务在后台运行，完成后会自动出现在卡片上，期间可继续操作其它视频。
          </div>
        </div>

        <div className="flex gap-2 px-6 py-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-sm rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 transition-all"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || pricingLoading || (insufficient && !unlimited)}
            className="flex-1 py-2 text-sm rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-medium transition-all"
          >
            {submitting ? '提交中...' : '提交增强'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 提示用户「想要更便宜需要把短边降到哪」时的上一档边界
function prevTierUpper(currentTier: '720p' | '1080p' | '2k' | '4k'): number {
  switch (currentTier) {
    case '1080p': return 720;
    case '2k':    return 1080;
    case '4k':    return 1440;
    default:      return 0;
  }
}
