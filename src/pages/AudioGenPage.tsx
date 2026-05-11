import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { uploadToOss } from '../services/ossService';
import { submitAudioGeneration, listAudioGenerations, getAudioGeneration, getAudioGenPublicConfig, estimateAudioGenCredits, type AudioGenPublicConfig, type AudioGenEstimate } from '../services/audioService';
import { getProjectAssets } from '../services/projectService';
import { getCreditBalance, type CreditBalance } from '../services/pricingService';
import { videoUrlToMp3Blob, downloadBlob } from '../utils/audioExtractor';
import { formatDateTime, useUserTimezone } from '../utils/datetime';
import type { AudioGeneration, ProjectAsset } from '../types';
import { MicIcon, SpinnerIcon, DownloadIcon, CloseIcon } from '../components/Icons';

const STATUS_BADGE: Record<AudioGeneration['status'], { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'bg-gray-700/40 text-gray-300 border-gray-600' },
  generating: { text: '生成中', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  done: { text: '已完成', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  error: { text: '失败', cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
};

// 模块级 MP3 缓存：跨组件 mount/unmount 保留已转码结果，避免切换菜单后重复转码/下载
type Mp3CacheEntry = { blob: Blob; url: string };
const mp3Cache = new Map<number, Mp3CacheEntry>();
const inflightConversion = new Set<number>();

export default function AudioGenPage() {
  useUserTimezone();
  const { state } = useApp();
  const projectId = state.currentProject?.id ?? null;

  // ── 提交表单 ─────────────────────────────────────────────
  const [refImageUrl, setRefImageUrl] = useState<string | null>(null);
  // 已入库素材的 asset URI（asset://asset-xxx），提交时优先使用它做 Ark 推理，避免真人检测拦截
  const [refAssetUri, setRefAssetUri] = useState<string | null>(null);
  const [refImagePreview, setRefImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [voicePrompt, setVoicePrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 历史列表 ─────────────────────────────────────────────
  const [items, setItems] = useState<AudioGeneration[]>([]);
  const [loading, setLoading] = useState(false);
  const PAGE_SIZE = 12;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // id → blob URL（用于 <audio> 预览），从模块级 mp3Cache 同步而来
  const [previews, setPreviews] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (const [id, entry] of mp3Cache) init[id] = entry.url;
    return init;
  });
  const [converting, setConverting] = useState<Record<number, string>>({}); // id → stage label

  // 中转视频运行配置（来自管理后台），用于显示与积分估算
  // 初始化为与后端 AUDIO_GEN_DEFAULTS 一致的兜底值，避免 fetch 失败时 UI 空白或显示陈旧文字
  const [genConfig, setGenConfig] = useState<AudioGenPublicConfig>({
    model: 'seedance-2.0-fast', ratio: '1:1', resolution: '480p', duration: 4,
  });
  const [estimate, setEstimate] = useState<AudioGenEstimate | null>(null);

  // 余额（用户实时积分），用于在提交按钮下方展示
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  async function refreshBalance() {
    try { setBalance(await getCreditBalance()); } catch (e) { console.error('[audio-gen] 余额拉取失败', e); }
  }

  // 工作组素材组：可选取的图片素材（file_url 有效 + active + approved）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  async function loadProjectAssets() {
    if (!projectId) { setProjectAssets([]); return; }
    setPickerLoading(true);
    try {
      const r = await getProjectAssets(projectId, { pageSize: 200 });
      const filtered = r.assets.filter((a) => a.file_type === 'image' && a.review_status !== 'rejected' && !!a.file_url);
      setProjectAssets(filtered);
    } catch (e) { console.error('[audio-gen] 素材列表拉取失败', e); }
    finally { setPickerLoading(false); }
  }
  function pickAsset(a: ProjectAsset) {
    if (!a.file_url) return;
    setRefImageUrl(a.file_url);
    // 已入库素材（有 volc_asset_id）→ 推理时用 asset:// URI，可绕过真人检测；
    // 未入库（仅本地上传）→ 仍走外链，可能被 Ark 拦截
    setRefAssetUri(a.volc_asset_id ? `asset://${a.volc_asset_id}` : null);
    if (refImagePreview) URL.revokeObjectURL(refImagePreview);
    setRefImagePreview(a.thumbnail_url || a.file_url);
    setPickerOpen(false);
  }

  // 复用历史：把参考图 URL 与提示词回填到提交表单，滚动到顶部
  function handleReuse(it: AudioGeneration) {
    setRefImageUrl(it.reference_image_url);
    // 历史记录里 reference_image_url 是 OSS 外链，无 asset URI 信息（旧记录），按外链走
    setRefAssetUri(null);
    if (refImagePreview && refImagePreview.startsWith('blob:')) URL.revokeObjectURL(refImagePreview);
    setRefImagePreview(it.reference_image_url);
    setVoicePrompt(it.voice_prompt);
    setSubmitError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cfg: AudioGenPublicConfig | null = null;
      try {
        cfg = await getAudioGenPublicConfig();
        if (!cancelled && cfg) setGenConfig(cfg);
      } catch (e) { console.error('[audio-gen] 配置拉取失败,使用默认值', e); }
      try {
        const est = await estimateAudioGenCredits(cfg ?? genConfig);
        if (!cancelled) setEstimate(est);
      } catch (e) { console.error('[audio-gen] 估算失败', e); }
    })();
    void refreshBalance();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换工作组时清空素材列表（picker 打开时再按需加载）
  useEffect(() => { setProjectAssets([]); }, [projectId]);

  async function loadList(targetPage = page) {
    setLoading(true);
    try {
      const data = await listAudioGenerations(targetPage, PAGE_SIZE);
      setItems(data.items);
      setTotal(data.total);
      setPage(targetPage);
    } catch (e) {
      console.error('[audio-gen] 加载列表失败', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadList(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // 轮询未完成项
  useEffect(() => {
    const hasPending = items.some((it) => it.status === 'pending' || it.status === 'generating');
    if (!hasPending) return;
    const timer = setInterval(async () => {
      try {
        const updated = await Promise.all(
          items.map(async (it) => {
            if (it.status === 'pending' || it.status === 'generating') {
              try { return await getAudioGeneration(it.id); } catch { return it; }
            }
            return it;
          })
        );
        setItems(updated);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [items]);

  // 进入 done 后自动转码生成预览（不再自动下载）。模块级缓存 + inflight 锁保证每个 id 只转一次，
  // 来回切换菜单不会重复转码或下载
  useEffect(() => {
    for (const it of items) {
      if (it.status !== 'done') continue;
      const videoUrl = it.intermediate_video_url || it.task_video_url;
      if (!videoUrl) continue;
      if (mp3Cache.has(it.id) || inflightConversion.has(it.id)) continue;
      void convertForPreview(it.id, videoUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function convertForPreview(id: number, videoUrl: string) {
    inflightConversion.add(id);
    setConverting((m) => ({ ...m, [id]: '准备...' }));
    try {
      const blob = await videoUrlToMp3Blob(videoUrl, {
        onStage: (s) => {
          const label = s === 'fetch' ? '下载视频中...' : s === 'decode' ? '解码音轨中...' : s === 'encode' ? '编码 MP3 中...' : '完成';
          setConverting((m) => ({ ...m, [id]: label }));
        },
      });
      const url = URL.createObjectURL(blob);
      mp3Cache.set(id, { blob, url });
      setPreviews((m) => ({ ...m, [id]: url }));
    } catch (e) {
      console.error('[audio-gen] 转码失败', id, e);
    } finally {
      inflightConversion.delete(id);
      setConverting((m) => { const x = { ...m }; delete x[id]; return x; });
    }
  }

  async function handlePickImage(file: File) {
    if (!file.type.startsWith('image/')) {
      alert('请上传图片文件');
      return;
    }
    setUploading(true);
    setUploadPct(0);
    setRefImagePreview(URL.createObjectURL(file));
    setRefAssetUri(null); // 上传新图：清掉素材 URI，按外链走（含真人风险）
    try {
      const res = await uploadToOss(file, 'image', (p) => setUploadPct(p));
      setRefImageUrl(res.url);
    } catch (e) {
      alert((e as Error)?.message || '上传失败');
      setRefImageUrl(null);
      setRefImagePreview(null);
    } finally {
      setUploading(false);
    }
  }

  function clearImage() {
    setRefImageUrl(null);
    setRefAssetUri(null);
    if (refImagePreview) URL.revokeObjectURL(refImagePreview);
    setRefImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleSubmit() {
    setSubmitError(null);
    if (!projectId) { setSubmitError('请先选择工作组'); return; }
    if (!refImageUrl) { setSubmitError('请上传参考图'); return; }
    if (!voicePrompt.trim()) { setSubmitError('请输入语气提示词'); return; }
    setSubmitting(true);
    try {
      await submitAudioGeneration({ projectId, referenceImageUrl: refImageUrl, referenceAssetUri: refAssetUri, voicePrompt: voicePrompt.trim() });
      setVoicePrompt('');
      clearImage();
      await loadList(1);
      void refreshBalance();
    } catch (e) {
      setSubmitError((e as Error)?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDownload(it: AudioGeneration) {
    const cached = mp3Cache.get(it.id);
    if (cached) {
      downloadBlob(cached.blob, `audio_${it.id}.mp3`);
      return;
    }
    const videoUrl = it.intermediate_video_url || it.task_video_url;
    if (!videoUrl) { alert('视频地址不可用'); return; }
    if (inflightConversion.has(it.id)) return; // 正在转码，按钮已显示进度，避免重入
    await convertForPreview(it.id, videoUrl);
    const after = mp3Cache.get(it.id);
    if (after) downloadBlob(after.blob, `audio_${it.id}.mp3`);
    else alert('转码失败');
  }

  return (
    <div className="min-h-screen p-6 lg:p-10 text-gray-100">
      <header className="mb-6 flex items-center gap-3">
        <MicIcon className="w-8 h-8 text-purple-400" />
        <div>
          <h1 className="text-2xl font-bold">音频生成</h1>
          <p className="text-sm text-gray-400 mt-1">上传角色参考图 + 输入语气提示词,生成标准化角色音频参考文件(MP3)</p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6">
        {/* 左侧:提交表单 */}
        <section className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">参考图(角色形象)</label>
            {refImagePreview ? (
              <div className="relative w-full aspect-square rounded-xl overflow-hidden border border-gray-700 bg-black">
                <img src={refImagePreview} alt="参考图" className="w-full h-full object-cover" />
                {uploading && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-sm text-white">
                    <SpinnerIcon className="w-5 h-5 mr-2 animate-spin" />
                    上传中 {uploadPct}%
                  </div>
                )}
                {!uploading && (
                  <button
                    onClick={clearImage}
                    className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-500/80 rounded-lg text-white"
                    title="移除"
                  >
                    <CloseIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full aspect-square rounded-xl border-2 border-dashed border-gray-700 hover:border-purple-500 text-gray-400 hover:text-purple-400 transition-all flex flex-col items-center justify-center gap-2"
              >
                <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
                <span className="text-sm">点击上传角色参考图</span>
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0]; if (f) void handlePickImage(f);
            }} />
            <div className="mt-2 flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => { setPickerOpen(true); if (projectAssets.length === 0) void loadProjectAssets(); }}
                disabled={!projectId || uploading}
                className="px-3 py-1.5 rounded-lg border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed"
                title={!projectId ? '请先选择工作组' : '从素材组选择'}
              >
                从素材组选择
              </button>
              <span className="text-gray-500">或上传新图片</span>
              {refImageUrl && (
                refAssetUri ? (
                  <span className="ml-auto px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]" title={refAssetUri}>已入库素材</span>
                ) : (
                  <span className="ml-auto px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]" title="未入库素材，含真人形象时可能被 Ark 拦截">外链/未入库</span>
                )
              )}
            </div>
            {refImageUrl && !refAssetUri && (
              <p className="mt-1.5 text-[11px] text-amber-400/80 leading-snug">
                ⚠ 含真人形象的图片可能被火山拦截。建议先到「素材组管理」入库该图片，再从素材组选择使用。
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">语气提示词</label>
            <textarea
              value={voicePrompt}
              onChange={(e) => setVoicePrompt(e.target.value)}
              placeholder={'例如:用兴奋激昂的语气说"欢迎来到我的世界!"'}
              rows={5}
              className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-xl text-sm text-gray-100 placeholder-gray-500 focus:border-purple-500 focus:outline-none resize-none"
            />
            <p className="text-xs text-gray-500 mt-1">提示词将作为角色台词,Seedance 会生成 {genConfig.duration} 秒带音轨视频,浏览器自动转 MP3</p>
          </div>

          {submitError && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{submitError}</div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting || uploading || !refImageUrl || !voicePrompt.trim()}
            className="w-full px-4 py-3 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {submitting ? <><SpinnerIcon className="w-5 h-5 animate-spin" />提交中...</> : '提交生成'}
          </button>

          <p className="text-xs text-gray-600 text-center mt-2">
            {estimate ? `每次消耗约 ${estimate.credits} 积分` : '正在估算消耗...'}
            {balance && (
              <span className="ml-2 text-gray-500">
                · 余额 {balance.unlimited ? <span className="text-amber-400">无限</span> : <span className={balance.available <= (estimate?.lockedCredits ?? 0) ? 'text-red-400 font-semibold' : 'text-gray-300 font-semibold'}>{balance.available}</span>} 积分
                {!balance.unlimited && balance.locked > 0 && (
                  <span className="ml-1 text-amber-400/80">(锁定 {balance.locked})</span>
                )}
              </span>
            )}
          </p>

          <div className="text-xs text-gray-500 leading-relaxed pt-2 border-t border-gray-800">
            • 模型:{`${genConfig.model},时长 ${genConfig.duration}s,${genConfig.ratio} ${genConfig.resolution}`}<br/>
            • MP3 编码:单声道 44.1kHz 128kbps
          </div>
        </section>

        {/* 右侧:历史 */}
        <section className="bg-[#1c1f2e] border border-gray-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">生成历史</h2>
            <button onClick={() => loadList(page)} disabled={loading} className="text-sm text-purple-400 hover:text-purple-300 disabled:opacity-40">
              {loading ? '刷新中...' : '刷新'}
            </button>
          </div>

          {items.length === 0 && !loading && (
            <div className="text-center py-16 text-gray-500 text-sm">暂无记录</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.map((it) => {
              const badge = STATUS_BADGE[it.status];
              const convStage = converting[it.id];
              const previewUrl = previews[it.id];
              const hasVideo = !!(it.intermediate_video_url || it.task_video_url);
              return (
                <div key={it.id} className="bg-[#0f111a] border border-gray-800 rounded-xl p-4 flex gap-3">
                  <img src={it.reference_image_url} alt="ref" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 bg-black" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 text-xs rounded border ${badge.cls}`}>{badge.text}</span>
                      <span className="text-xs text-gray-500">#{it.id}</span>
                      {it.status === 'done' && (
                        <span className="ml-auto text-xs text-amber-300/90" title="本次实际扣除积分">
                          {it.credits_used > 0 ? `−${it.credits_used} 积分` : '未计费'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 mb-1.5" title={it.created_at}>
                      创建 {formatDateTime(it.created_at)}
                      {it.finished_at && (it.status === 'done' || it.status === 'error') && (
                        <span className="ml-2">· 完成 {formatDateTime(it.finished_at)}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-200 line-clamp-2 mb-2" title={it.voice_prompt}>{it.voice_prompt}</p>
                    {it.status === 'error' && it.error_message && (
                      <p className="text-xs text-red-400 line-clamp-2 mb-2">{it.error_message}</p>
                    )}
                    {it.status === 'generating' && it.task_progress && (
                      <p className="text-xs text-gray-500 mb-2">{it.task_progress}</p>
                    )}
                    {it.status === 'done' && hasVideo && (
                      <div className="space-y-2 mt-1">
                        {previewUrl ? (
                          <audio controls src={previewUrl} className="w-full h-9" />
                        ) : convStage ? (
                          <div className="text-xs text-gray-400 inline-flex items-center gap-1.5">
                            <SpinnerIcon className="w-3.5 h-3.5 animate-spin" />{convStage}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={() => void handleDownload(it)}
                            disabled={!!convStage}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 text-purple-300 disabled:opacity-50"
                          >
                            <DownloadIcon className="w-3.5 h-3.5" />下载 MP3
                          </button>
                          <button
                            onClick={() => handleReuse(it)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-200"
                            title="把这次的参考图与提示词回填到提交表单"
                          >
                            复用
                          </button>
                        </div>
                      </div>
                    )}
                    {it.status === 'error' && (
                      <button
                        onClick={() => handleReuse(it)}
                        className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-200"
                        title="把这次的参考图与提示词回填到提交表单,可调整后重新提交"
                      >
                        复用并重试
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 分页 */}
          {total > PAGE_SIZE && (
            <div className="flex justify-center items-center gap-2 mt-6 text-sm">
              <button onClick={() => loadList(page - 1)} disabled={page <= 1 || loading} className="px-3 py-1 rounded border border-gray-700 disabled:opacity-40">上一页</button>
              <span className="text-gray-400">第 {page} / {Math.ceil(total / PAGE_SIZE)} 页</span>
              <button onClick={() => loadList(page + 1)} disabled={page >= Math.ceil(total / PAGE_SIZE) || loading} className="px-3 py-1 rounded border border-gray-700 disabled:opacity-40">下一页</button>
            </div>
          )}
        </section>
      </div>

      {/* 素材组选择弹窗 */}
      {pickerOpen && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setPickerOpen(false)}>
          <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h3 className="text-base font-semibold text-white">从素材组选择参考图</h3>
              <button onClick={() => setPickerOpen(false)} className="text-gray-400 hover:text-white">
                <CloseIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {pickerLoading ? (
                <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
                  <SpinnerIcon className="w-5 h-5 mr-2 animate-spin" />加载中...
                </div>
              ) : projectAssets.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-sm">
                  当前工作组暂无可用图片素材<br/>
                  <span className="text-xs text-gray-600">前往「素材组管理」上传或同步</span>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {projectAssets.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => pickAsset(a)}
                      className="group flex flex-col items-stretch text-left bg-[#0f111a] border border-gray-800 rounded-lg overflow-hidden hover:border-purple-500/60 transition-all"
                      title={a.name}
                    >
                      <div className="aspect-square bg-black">
                        <img src={a.thumbnail_url || a.file_url} alt={a.name} className="w-full h-full object-cover group-hover:opacity-90" />
                      </div>
                      <div className="px-2 py-1.5 text-xs text-gray-300 truncate">{a.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-3 border-t border-gray-800">
              <button onClick={loadProjectAssets} disabled={pickerLoading} className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-[#0f111a] disabled:opacity-50">刷新</button>
              <button onClick={() => setPickerOpen(false)} className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600 text-white">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
