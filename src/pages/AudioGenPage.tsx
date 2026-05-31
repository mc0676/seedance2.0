import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { uploadToOss } from '../services/ossService';
import { submitAudioGeneration, listAudioGenerations, getAudioGeneration, getAudioGenPublicConfig, estimateAudioGenCredits, type AudioGenPublicConfig, type AudioGenEstimate } from '../services/audioService';
import { getProjectAssets } from '../services/projectService';
import { listProjectAssetGroups } from '../services/assetService';
import AssetGrid, { type GridAsset } from '../components/AssetGrid';
import { getCreditBalance, type CreditBalance } from '../services/pricingService';
import { getVolcKeyStatus } from '../services/settingsService';
import { videoUrlToMp3Blob, downloadBlob, ExpiredVideoUrlError, isSignedUrlExpired } from '../utils/audioExtractor';
import { formatDateTime, useUserTimezone } from '../utils/datetime';
import type { AudioGeneration, ProjectAsset } from '../types';
import { MicIcon, SpinnerIcon, DownloadIcon, SparkleIcon, GearIcon } from '../components/Icons';
import Layout from '../components/Layout';

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
  const currentProject = state.currentProject;
  const projectId = currentProject?.id ?? null;

  // ── 火山账号状态检查 ─────────────────────────────
  const [multiAccountEnabled, setMultiAccountEnabled] = useState(false);
  useEffect(() => {
    getVolcKeyStatus()
      .then((s) => setMultiAccountEnabled(s.multiAccountEnabled))
      .catch(() => {});
  }, []);
  const isVolcKeyDisabled = !!(
    multiAccountEnabled &&
    currentProject?.volc_id != null &&
    currentProject?.volc_is_active !== 1
  );

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
  // 记录哪些条目的源视频已过期（签名 URL 失效）。在自动转码前先嗅探一遍，
  // 命中的就直接打标，不再触发后台 fetch / decode，也不弹窗。
  // 用户点下载按钮时再用此 set 决定是否弹友好提示。
  const [expiredIds, setExpiredIds] = useState<Set<number>>(new Set());

  // 中转视频运行配置（来自管理后台），用于显示与积分估算
  // 初始化为与后端 AUDIO_GEN_DEFAULTS 一致的兜底值，避免 fetch 失败时 UI 空白或显示陈旧文字
  const [genConfig, setGenConfig] = useState<AudioGenPublicConfig>({
    model: 'seedance-2.0-fast', ratio: '1:1', resolution: '480p', duration: 4,
  });
  const [estimate, setEstimate] = useState<AudioGenEstimate | null>(null);
  const [discountExpired, setDiscountExpired] = useState(false);

  // 余额（用户实时积分），用于在提交按钮下方展示
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  async function refreshBalance() {
    try { setBalance(await getCreditBalance()); } catch (e) { console.error('[audio-gen] 余额拉取失败', e); }
  }

  // 工作组素材组：可选取的图片素材（file_url 有效 + active + approved），自动加载
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);

  // 素材组列表（asset_groups 表）
  const [projectAssetGroups, setProjectAssetGroups] = useState<import('../types').AssetGroupInfo[]>([]);
  function pickAsset(a: ProjectAsset) {
    if (!a.file_url) return;
    setRefImageUrl(a.file_url);
    // 已入库素材（有 volc_asset_id）→ 推理时用 asset:// URI，可绕过真人检测；
    // 未入库（仅本地上传）→ 仍走外链，可能被 Ark 拦截
    setRefAssetUri(a.volc_asset_id ? `asset://${a.volc_asset_id}` : null);
    if (refImagePreview) URL.revokeObjectURL(refImagePreview);
    setRefImagePreview(a.thumbnail_url || a.file_url);
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
        if (!cancelled) { setEstimate(est); setDiscountExpired(false); }
      } catch (e) { console.error('[audio-gen] 估算失败', e); }
    })();
    void refreshBalance();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载素材组和素材（先 asset_groups 可能触发自动同步，再 project_assets）
  useEffect(() => {
    if (!projectId) { setProjectAssetGroups([]); setProjectAssets([]); return; }
    let cancelled = false;
    (async () => {
      const groups = await listProjectAssetGroups(projectId).catch(() => []);
      if (cancelled) return;
      setProjectAssetGroups(groups);
      const data = await getProjectAssets(projectId, { pageSize: 200, skipLive: true } as any).catch(() => null);
      if (cancelled || !data) return;
      const assets = data.assets
        .filter((a) => a.review_status !== 'rejected' && (a.volc_asset_id || a.file_url))
        .filter((a) => a.file_type === 'image');
      setProjectAssets(assets);
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // 统一 AssetGrid 所需数据
  const gridAssets = useMemo((): GridAsset[] =>
    projectAssets.map(a => ({ ...a })), [projectAssets]);

  const groupNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of projectAssetGroups) m.set(g.id, g.name);
    return m;
  }, [projectAssetGroups]);

  async function loadList(targetPage = page) {
    setLoading(true);
    try {
      const data = await listAudioGenerations(targetPage, PAGE_SIZE, projectId);
      setItems(data.items);
      setTotal(data.total);
      setPage(targetPage);
    } catch (e) {
      console.error('[audio-gen] 加载列表失败', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadList(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

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
  // 来回切换菜单不会重复转码或下载。
  // 已过期的源 URL 直接打 expiredIds 标，不进自动转码流程，避免一次性弹一堆 alert。
  useEffect(() => {
    let dirty = false;
    const newExpired = new Set(expiredIds);
    for (const it of items) {
      if (it.status !== 'done') continue;
      const videoUrl = it.intermediate_video_url || it.task_video_url;
      if (!videoUrl) continue;
      if (mp3Cache.has(it.id) || inflightConversion.has(it.id)) continue;
      if (newExpired.has(it.id)) continue;
      if (isSignedUrlExpired(videoUrl)) {
        newExpired.add(it.id);
        dirty = true;
        continue;
      }
      void convertForPreview(it.id, videoUrl);
    }
    if (dirty) setExpiredIds(newExpired);
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
      // 自动转码阶段不弹窗 —— 把过期/不可达的条目标记到 expiredIds，渲染到卡片上
      if (e instanceof ExpiredVideoUrlError) {
        setExpiredIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev); next.add(id); return next;
        });
      }
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
    if (!projectId) { setSubmitError('请先选择项目组'); return; }
    if (!refImageUrl) { setSubmitError('请上传参考图'); return; }
    if (!voicePrompt.trim()) { setSubmitError('请输入语气提示词'); return; }

    // 折扣过期检查
    if (estimate?.discountedCredits != null && !discountExpired) {
      try {
        const fresh = await estimateAudioGenCredits(genConfig);
        if (fresh.discountedCredits == null || fresh.discountedCredits === fresh.credits) {
          setEstimate(fresh);
          setDiscountExpired(true);
          return;
        }
        setEstimate(fresh);
      } catch { /* 网络错误，继续用旧 estimate 提交 */ }
    }

    // 积分预检
    const lockedNeeded = estimate?.discountedLockedCredits ?? estimate?.lockedCredits ?? 999;
    if (balance && !balance.unlimited && balance.available < lockedNeeded) {
      setSubmitError('可用积分不足，请联系管理员充值');
      return;
    }
    setSubmitting(true);
    // 3 秒冷却防连点；出错时立即恢复
    const coolTimer = setTimeout(() => setSubmitting(false), 3000);
    const clearCool = () => { clearTimeout(coolTimer); setSubmitting(false); };
    try {
      await submitAudioGeneration({ projectId, referenceImageUrl: refImageUrl, referenceAssetUri: refAssetUri, voicePrompt: voicePrompt.trim() });
      setVoicePrompt('');
      clearImage();
    } catch (e) {
      clearCool();
      setSubmitError((e as Error)?.message || '提交失败');
    } finally {
      void loadList(1);
      void refreshBalance();
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
    // 自动转码阶段已嗅探过过期 URL，命中的不再尝试转码
    if (expiredIds.has(it.id) || isSignedUrlExpired(videoUrl)) {
      alert('音频源视频链接已过期（火山引擎签名 URL 有效期 48 小时），请重新生成。');
      return;
    }
    if (inflightConversion.has(it.id)) return; // 正在转码，按钮已显示进度，避免重入
    await convertForPreview(it.id, videoUrl);
    const after = mp3Cache.get(it.id);
    if (after) {
      downloadBlob(after.blob, `audio_${it.id}.mp3`);
    } else if (expiredIds.has(it.id)) {
      alert('音频源视频链接已过期（火山引擎签名 URL 有效期 48 小时），请重新生成。');
    } else {
      alert('转码失败，请稍后再试');
    }
  }

  if (isVolcKeyDisabled) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-amber-400 mb-2">火山账号未启用</h2>
          <p className="text-gray-400 text-sm">当前项目所关联的火山账号未启用，请联系管理员启用。</p>
        </div>
      </div>
    );
  }

  return (
    <Layout
      title="音频生成"
      projectName={state.currentProject?.name}
      headerActions={
        <>
          <button
            onClick={() => void loadList(page)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {loading ? '刷新中...' : '刷新'}
          </button>
          <button onClick={() => window.location.href='/settings'} className="btn-ghost" title="设置">
            <GearIcon className="w-4 h-4" />
          </button>
        </>
      }
      left={
        <div className="space-y-4">
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-sm font-bold text-gray-300 mb-2 block">
              参考图(角色形象) <span className="text-xs text-gray-500 font-normal">（拖拽或点击上传）</span>
            </label>

            {!refImageUrl ? (
              <div
                onClick={() => !uploading && fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f && !uploading) handlePickImage(f); }}
                className={`w-full border border-dashed border-gray-700 rounded-2xl flex flex-col items-center justify-center py-8 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}
              >
                {uploading ? (
                  <div className="text-gray-400 text-sm flex items-center gap-2">
                    <SpinnerIcon className="w-5 h-5 animate-spin" /> 上传中 {uploadPct}%
                  </div>
                ) : (
                  <div className="text-gray-500 text-xs text-center">
                    <svg className="w-10 h-10 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                    <span className="block">点击或拖拽图片到此处</span>
                    <span className="text-gray-600 text-[10px] mt-1 block">支持 JPG / PNG，单文件 ≤ 10MB</span>
                  </div>
                )}
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePickImage(f); e.target.value = ''; }} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black">
                  <img src={refImagePreview || refImageUrl} alt="参考图" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                  {uploading && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-sm text-white">
                      <SpinnerIcon className="w-5 h-5 mr-2 animate-spin" /> 上传中 {uploadPct}%
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={clearImage}
                    className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                    重新选择
                  </button>
                  {refAssetUri ? (
                    <span className="px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]" title={refAssetUri}>已入库素材</span>
                  ) : refImageUrl && (
                    <span className="px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]" title="未入库素材，含真人形象时可能被 Ark 拦截">外链/未入库</span>
                  )}
                </div>
                {!refAssetUri && (
                  <p className="text-[11px] text-amber-400/80 leading-snug">
                    ⚠ 含真人形象的图片可能被火山拦截。建议先到「素材组管理」入库该图片，再从下方素材组选择使用。
                  </p>
                )}
              </div>
            )}

          </div>

          {/* 素材组（4列平铺，不分组；2行可见，超出滚动） */}
          {gridAssets.length > 0 && (
            <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-bold text-gray-300">素材组 <span className="text-amber-400">（{gridAssets.length} 个）</span></label>
                <span className="text-[10px] text-gray-500">点击选取参考图</span>
              </div>
              <AssetGrid
                assets={gridAssets}
                groupNames={groupNameMap}
                selectedUrl={refImageUrl}
                onSelect={(a) => pickAsset(a as any)}
              />
            </div>
          )}

          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="block text-sm font-bold text-gray-300 mb-2">语气提示词</label>
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
            className="w-full font-bold py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
          >
            {submitting ? <><SpinnerIcon className="w-4 h-4 animate-spin" />生成中...</> : <><SparkleIcon className="w-4 h-4" />生成音频</>}
          </button>

          <p className="text-xs text-gray-600 text-center mt-2">
            {discountExpired ? (
              <span className="text-amber-400">折扣已过期！请确认积分消耗：每次消耗约 <span className="text-purple-300 font-semibold">{estimate?.credits ?? 0}</span> 积分
              {estimate && <span className="ml-1 text-gray-500">（锁定 {estimate.lockedCredits}）</span>}
              </span>
            ) : estimate?.discountedCredits != null && estimate.discountedCredits !== estimate.credits ? (
              <span>每次消耗约 <span className="text-emerald-300 font-semibold">{estimate.discountedCredits}</span><span className="ml-1 text-gray-500">（折扣前 {estimate.credits}）</span> 积分</span>
            ) : (
              <span>{estimate ? `每次消耗约 ${estimate.credits} 积分` : '正在估算消耗...'}</span>
            )}
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
        </div>
      }

      right={
        <>

        {loading && items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full mr-2" />加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">暂无生成记录</div>
        ) : (
          <div className="px-4 pb-4 space-y-3">
            {items.map((it) => {
              const badge = STATUS_BADGE[it.status];
              const convStage = converting[it.id];
              const previewUrl = previews[it.id];
              const hasVideo = !!(it.intermediate_video_url || it.task_video_url);
              const isExpired = expiredIds.has(it.id);
              return (
                <div key={it.id} className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
                  <div className="flex gap-3 p-3 items-start">
                    {/* 缩略图 */}
                    <div className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] relative">
                      {it.status === 'pending' || it.status === 'generating' ? (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-purple-300 text-xs">
                          <span className="animate-spin h-6 w-6 border-2 border-purple-400 border-t-transparent rounded-full" />
                          生成中...
                        </div>
                      ) : it.status === 'error' ? (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-red-400 text-xs px-2 text-center">
                          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          失败
                        </div>
                      ) : it.reference_image_url ? (
                        <img src={it.reference_image_url} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-gray-600">
                          <MicIcon className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 text-xs rounded border ${badge.cls}`}>{badge.text}</span>
                        <span className="text-xs text-gray-500">#{it.id}</span>
                        {it.status === 'done' && (
                          <span className="ml-auto text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none" title="本次实际扣除积分">
                            {it.credits_used > 0 ? `${it.credits_used}积分` : '未计费'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-gray-500">
                        创建 {formatDateTime(it.created_at)}
                        {it.finished_at && (it.status === 'done' || it.status === 'error') && (
                          <span className="ml-2">· 完成 {formatDateTime(it.finished_at)}</span>
                        )}
                      </div>
                      <p className="text-sm text-gray-200 line-clamp-2" title={it.voice_prompt}>{it.voice_prompt}</p>
                      {it.status === 'error' && it.error_message && (
                        <p className="text-xs text-red-400 line-clamp-2">{it.error_message}</p>
                      )}
                      {it.status === 'done' && hasVideo && (
                        <div className="flex gap-2 flex-wrap mt-1">
                          {isExpired ? (
                            <span className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1">音频源视频链接已过期</span>
                          ) : previewUrl ? (
                            <audio controls src={previewUrl} className="w-full h-8 max-w-[200px]" />
                          ) : convStage ? (
                            <span className="text-xs text-gray-400 inline-flex items-center gap-1.5"><SpinnerIcon className="w-3.5 h-3.5 animate-spin" />{convStage}</span>
                          ) : null}
                          <button onClick={() => void handleDownload(it)} disabled={!!convStage}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                            <DownloadIcon className="w-3.5 h-3.5 inline-block align-middle mr-1" />{isExpired ? '下载 MP3（已过期）' : '下载 MP3'}
                          </button>
                          <button onClick={() => handleReuse(it)}
                            className="text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all">
                            复用
                          </button>
                        </div>
                      )}
                      {it.status === 'error' && (
                        <div className="flex gap-2 flex-wrap">
                          <button onClick={() => handleReuse(it)}
                            className="self-start text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all">
                            复用并重试
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {/* 分页 */}
            {total > PAGE_SIZE && (
              <div className="flex justify-center items-center gap-2 pt-4 text-sm">
                <button onClick={() => loadList(page - 1)} disabled={page <= 1 || loading} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed">上一页</button>
                <span className="text-gray-400">第 {page} / {Math.ceil(total / PAGE_SIZE)} 页</span>
                <button onClick={() => loadList(page + 1)} disabled={page >= Math.ceil(total / PAGE_SIZE) || loading} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed">下一页</button>
              </div>
            )}
          </div>
        )}
        </>
      }

    />
  );
}