import { useEffect, useState } from 'react';
import type { VideoEnhancement, EnhancementPricing } from '../types/index';
import { CloseIcon } from './Icons';
import {
  getEnhancementPricing,
  submitEnhancement,
  estimateCredits,
} from '../services/enhancementService';

type ToolVersion = VideoEnhancement['tool_version'];
type Scene = VideoEnhancement['scene'];
type Resolution = VideoEnhancement['target_resolution'];

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
  { value: 'aigc', label: 'AIGC', desc: 'AI 生成视频，超分到 2K/4K 并细节重绘' },
  { value: 'short_series', label: '短剧', desc: '人像增强、细节强化' },
  { value: 'ugc', label: 'UGC 短视频', desc: '修复模糊、块效应、色带' },
  { value: 'old_film', label: '老片修复', desc: '去噪、去划痕、消闪烁、色偏修正' },
];

const RESOLUTION_OPTIONS: Resolution[] = ['720p', '1080p', '4k'];

const VERSION_OPTIONS: Array<{ value: ToolVersion; label: string; desc: string }> = [
  { value: 'standard', label: '标准版', desc: 'RTF≈10，6~10 分钟/分钟' },
  { value: 'professional', label: '专业版', desc: 'RTF≈30+，性价比低但效果更好' },
];

export default function EnhancementDialog({
  source,
  userBalance,
  unlimited,
  onClose,
  onSubmitted,
}: EnhancementDialogProps) {
  const durationSec = source.durationSec;
  const sourceResolution = source.kind === 'task' ? source.sourceResolution : undefined;
  const [scene, setScene] = useState<Scene>('aigc');
  const [toolVersion, setToolVersion] = useState<ToolVersion>('standard');
  const [resolution, setResolution] = useState<Resolution>(() => {
    if (sourceResolution === '480p') return '720p';
    if (sourceResolution === '720p') return '1080p';
    return '1080p';
  });
  const [pricing, setPricing] = useState<EnhancementPricing[]>([]);
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

  const credits = estimateCredits(durationSec, toolVersion, pricing);
  const enabledVersions = pricing.map((p) => p.tool_version);
  const insufficient = !unlimited && credits > userBalance;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const params =
        source.kind === 'task'
          ? { taskId: source.taskId, scene, toolVersion, resolution }
          : { videoUrl: source.videoUrl, durationSeconds: source.durationSec, scene, toolVersion, resolution };
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
        className="bg-[#1c1f2e] border border-gray-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-white">画质增强</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-gray-800 flex items-center justify-center"
          >
            <CloseIcon className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* 分辨率 */}
          <div>
            <div className="text-xs text-gray-400 mb-2">目标分辨率</div>
            <div className="flex gap-2">
              {RESOLUTION_OPTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setResolution(r)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-all ${
                    resolution === r
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            {sourceResolution && (
              <div className="text-[10px] text-gray-600 mt-1.5">原始分辨率：{sourceResolution}</div>
            )}
          </div>

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
              {VERSION_OPTIONS.map((v) => {
                const disabled = !pricingLoading && !enabledVersions.includes(v.value);
                return (
                  <button
                    key={v.value}
                    disabled={disabled}
                    onClick={() => setToolVersion(v.value)}
                    className={`text-left p-2.5 rounded-lg border transition-all ${
                      disabled
                        ? 'border-gray-800 opacity-40 cursor-not-allowed'
                        : toolVersion === v.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm ${toolVersion === v.value ? 'text-purple-300' : 'text-gray-300'}`}>
                      {v.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{v.desc}</div>
                  </button>
                );
              })}
            </div>
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
              视频时长 {durationSec}s × 单价
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

        <div className="flex gap-2 px-5 py-4 border-t border-gray-800">
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
