import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import * as settingsService from '../services/settingsService';
import { RATIO_OPTIONS, DURATION_OPTIONS, MODEL_OPTIONS } from '../types/index';

export default function SettingsPage() {
  const { state, updateSettingsAction } = useApp();
  const { settings } = state;

  const [localSettings, setLocalSettings] = useState({
    model: settings.model || 'seedance-2.0-fast',
    ratio: settings.ratio || '9:16',
    duration: settings.duration || '4',
    resolution: settings.resolution || '720p',
    reference_mode: settings.reference_mode || 'reference',
    download_path: settings.download_path || '',
    max_concurrent: settings.max_concurrent || '5',
    min_interval: settings.min_interval || '30000',
    max_interval: settings.max_interval || '50000',
  });

  const [hasChanges, setHasChanges] = useState(false);

  // 激活码兑换
  const [activateCode, setActivateCode] = useState('');
  const [activateError, setActivateError] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateSuccess, setActivateSuccess] = useState(false);

  const handleActivate = async () => {
    setActivateError('');
    setActivateSuccess(false);
    setActivating(true);
    try {
      await settingsService.redeemActivationCode(activateCode);
      setActivateCode('');
      setActivateSuccess(true);
    } catch (error) {
      setActivateError(error instanceof Error ? error.message : '激活失败');
    } finally {
      setActivating(false);
    }
  };

  useEffect(() => {
    const changed =
      localSettings.model !== settings.model ||
      localSettings.ratio !== settings.ratio ||
      localSettings.duration !== settings.duration ||
      localSettings.resolution !== settings.resolution ||
      localSettings.reference_mode !== settings.reference_mode ||
      localSettings.download_path !== settings.download_path ||
      localSettings.max_concurrent !== settings.max_concurrent ||
      localSettings.min_interval !== settings.min_interval ||
      localSettings.max_interval !== settings.max_interval;
    setHasChanges(changed);
  }, [localSettings, settings]);

  const handleSave = async () => {
    try {
      await updateSettingsAction(localSettings);
      setHasChanges(false);
      alert('设置已保存');
    } catch (error) {
      alert(`保存失败：${error instanceof Error ? error.message : error}`);
    }
  };

  return (
    <div className="h-screen overflow-y-auto bg-[#0f111a] text-white">
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">全局设置</h1>

        {/* 激活码兑换 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-2">激活码兑换</h2>
          <p className="text-sm text-gray-400 mb-4">输入激活码为账号增加积分</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={activateCode}
              onChange={(e) => setActivateCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
              placeholder="输入激活码"
              className="flex-1 bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            />
            <button
              onClick={handleActivate}
              disabled={activating || !activateCode}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {activating ? '激活中...' : '激活'}
            </button>
          </div>
          {activateError && <p className="mt-2 text-xs text-red-400">{activateError}</p>}
          {activateSuccess && <p className="mt-2 text-xs text-green-400">激活成功！积分已增加</p>}
        </div>

        {/* 模型设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">模型设置</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                选择模型
              </label>
              <div className="space-y-2">
                {MODEL_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() =>
                      setLocalSettings((prev) => ({ ...prev, model: option.value }))
                    }
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                      localSettings.model === option.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div
                      className={`text-sm font-medium ${
                        localSettings.model === option.value
                          ? 'text-purple-400'
                          : 'text-gray-300'
                      }`}
                    >
                      {option.label}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {option.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                画面比例
              </label>
              <div className="grid grid-cols-6 gap-2">
                {RATIO_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() =>
                      setLocalSettings((prev) => ({ ...prev, ratio: opt.value }))
                    }
                    className={`flex flex-col items-center gap-1.5 py-2 rounded-lg border transition-all ${
                      localSettings.ratio === opt.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center justify-center w-8 h-8">
                      <div
                        className={`rounded-sm border ${
                          localSettings.ratio === opt.value
                            ? 'border-purple-400'
                            : 'border-gray-500'
                        }`}
                        style={{
                          width: `${(opt.widthRatio / Math.max(opt.widthRatio, opt.heightRatio)) * 24}px`,
                          height: `${(opt.heightRatio / Math.max(opt.widthRatio, opt.heightRatio)) * 24}px`,
                        }}
                      />
                    </div>
                    <span
                      className={`text-[11px] ${
                        localSettings.ratio === opt.value
                          ? 'text-purple-400'
                          : 'text-gray-400'
                      }`}
                    >
                      {opt.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                视频时长 (秒)
              </label>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() =>
                      setLocalSettings((prev) => ({
                        ...prev,
                        duration: String(d),
                      }))
                    }
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                      localSettings.duration === String(d)
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {d}秒
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                视频分辨率
              </label>
              <div className="flex flex-wrap gap-2">
                {(['480p', '720p', '1080p'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setLocalSettings((prev) => ({ ...prev, resolution: r }))}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                      localSettings.resolution === r
                        ? 'border-purple-500 bg-purple-500/10 text-purple-400'
                        : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                参考模式
              </label>
              <div className="flex flex-wrap gap-2">
                {([
                  { value: 'reference', label: '全能参考', desc: '支持 0-9 张参考图' },
                  { value: 'first_last_frame', label: '首尾帧', desc: '控制首帧和尾帧' },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setLocalSettings((prev) => ({ ...prev, reference_mode: opt.value }))}
                    className={`text-left px-4 py-2.5 rounded-lg border transition-all ${
                      localSettings.reference_mode === opt.value
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm font-medium ${localSettings.reference_mode === opt.value ? 'text-purple-400' : 'text-gray-300'}`}>{opt.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 批量生成设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">批量生成设置</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最大并发数
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={localSettings.max_concurrent}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    max_concurrent: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最小间隔 (毫秒)
              </label>
              <input
                type="number"
                min="10000"
                max="60000"
                step="1000"
                value={localSettings.min_interval}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    min_interval: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-400 mb-2">
                最大间隔 (毫秒)
              </label>
              <input
                type="number"
                min="30000"
                max="120000"
                step="1000"
                value={localSettings.max_interval}
                onChange={(e) =>
                  setLocalSettings((prev) => ({
                    ...prev,
                    max_interval: e.target.value,
                  }))
                }
                className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>
        </div>

        {/* 下载路径设置 */}
        <div className="bg-[#1c1f2e] rounded-xl p-6 mb-6 border border-gray-800">
          <h2 className="text-lg font-bold mb-4">下载路径设置</h2>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              视频保存路径
            </label>
            <input
              type="text"
              value={localSettings.download_path}
              onChange={(e) =>
                setLocalSettings((prev) => ({
                  ...prev,
                  download_path: e.target.value,
                }))
              }
              placeholder="留空则使用默认路径：~/Videos/Seedance"
              className="w-full bg-[#0f111a] border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
            />
            <p className="text-xs text-gray-500 mt-2">
              生成的视频将自动保存到此目录下的对应项目文件夹中
            </p>
          </div>
        </div>

        {/* 保存按钮 */}
        <div className="flex justify-end gap-3 sticky bottom-0 bg-[#0f111a] py-4 border-t border-gray-800 -mx-6 px-6">
          <button
            onClick={() =>
              setLocalSettings({
                model: settings.model || 'seedance-2.0-fast',
                ratio: settings.ratio || '9:16',
                duration: settings.duration || '4',
                resolution: settings.resolution || '720p',
                reference_mode: settings.reference_mode || 'reference',
                download_path: settings.download_path || '',
                max_concurrent: settings.max_concurrent || '5',
                min_interval: settings.min_interval || '30000',
                max_interval: settings.max_interval || '50000',
              })
            }
            className="px-6 py-2.5 bg-[#1c1f2e] border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white rounded-lg transition-all font-medium"
          >
            重置
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-lg transition-all font-medium shadow-lg shadow-purple-900/20"
          >
            保存设置
          </button>
        </div>
      </div>
    </div>
  );
}
