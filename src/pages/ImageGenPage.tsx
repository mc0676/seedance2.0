import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { getAuthHeaders } from '../services/authService';
import { SparkleIcon } from '../components/Icons';
import { useApp } from '../context/AppContext';
import { formatShortDateTime, useUserTimezone } from '../utils/datetime';
import { getCreditBalance, type CreditBalance } from '../services/pricingService';

async function downloadImageUrl(url: string, filename?: string) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const ext = blob.type.split('/')[1]?.split('+')[0] || 'png';
    const name = filename || `image_${Date.now()}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    window.open(url, '_blank');
  }
}

const IMAGE_MODELS = [
  { value: 'nano-banana-2', label: 'Nano Banana 2', description: '速创生图，快速出图' },
  { value: 'gpt-image-2', label: 'GPT-Image-2', description: '高质量生图模型' },
] as const;

const GPT_ASPECT_OPTIONS = [
  'auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4',
  '21:9', '9:21', '1:3', '3:1', '2:1', '1:2',
] as const;

const NANO_SIZE_OPTIONS = ['1K', '2K', '4K'] as const;
const NANO_ASPECT_OPTIONS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9',
] as const;

interface ImageRecord {
  id: number;
  prompt: string;
  model: string;
  size_label: string;
  ref_urls: string[];
  result_urls: string[];
  credits_used: number;
  created_at: string;
  status?: 'pending' | 'done' | 'error';
  error_message?: string | null;
}

export default function ImageGenPage() {
  useUserTimezone();
  const { state } = useApp();
  const currentProjectId = state.currentProject?.id ?? null;
  const projectsLoaded = !state.loading;

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('nano-banana-2');
  const [gptAspect, setGptAspect] = useState<string>('1:1');
  const [nanoSize, setNanoSize] = useState<string>('1K');
  const [nanoAspect, setNanoAspect] = useState<string>('1:1');
  const [refUrls, setRefUrls] = useState<string[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 积分余额（与音频生成 / 视频生成页保持一致）
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const refreshBalance = useCallback(async () => {
    try { setBalance(await getCreditBalance()); } catch (e) { console.error('[image-gen] 余额拉取失败', e); }
  }, []);
  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  // 历史记录
  const [records, setRecords] = useState<ImageRecord[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadingRef = useRef(false);
  const historyGenRef = useRef(0);
  const historyBottomRef = useRef<HTMLDivElement>(null);

  const sizeLabel = useMemo(() => {
    if (model === 'gpt-image-2') return gptAspect;
    return `${nanoSize} · ${nanoAspect}`;
  }, [model, gptAspect, nanoSize, nanoAspect]);

  // 加载历史
  const loadHistory = useCallback(async (page: number, append = false, projectId?: number | null) => {
    if (historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const gen = historyGenRef.current;
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (projectId) qs.set('projectId', String(projectId));
      const res = await fetch(`/api/image-records?${qs}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (gen !== historyGenRef.current) return;
      if (!data.success) throw new Error(data.error);
      const { records: rows, total } = data.data;
      setRecords((prev) => append ? [...prev, ...rows] : rows);
      setHistoryHasMore(rows.length === 20 && (append ? records.length + rows.length : rows.length) < total);
      setHistoryPage(page);
    } catch {
      // silent
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始加载 & 工作组切换（等待项目列表加载完成后再请求，避免刷新时用 null projectId 拉全量记录）
  useEffect(() => {
    if (!projectsLoaded) return;
    historyGenRef.current += 1;
    historyLoadingRef.current = false;
    setRecords([]);
    setHistoryPage(1);
    setHistoryHasMore(false);
    void loadHistory(1, false, currentProjectId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, currentProjectId]);

  // 任意 pending 记录存在时，5 秒一轮拉历史第一页 + 余额，直到所有 pending 完结。
  // pending 由后端 image_records.status='pending' 持久化承载，所以切换菜单/刷新都能恢复"生成中"状态。
  const hasPending = useMemo(() => records.some((r) => r.status === 'pending'), [records]);
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => {
      void loadHistory(1, false, currentProjectId);
      void refreshBalance();
    }, 5000);
    return () => clearInterval(t);
  }, [hasPending, currentProjectId, loadHistory, refreshBalance]);

  // 无限滚动
  useEffect(() => {
    const sentinel = historyBottomRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && historyHasMore && !historyLoading) {
        void loadHistory(historyPage + 1, true, currentProjectId);
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, historyLoading, historyPage, loadHistory]);

  const handleRefUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingRef(true);
    setError('');
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mediaType', 'image');
        const res = await fetch('/api/upload/oss', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || '上传失败');
        uploaded.push(data.url);
      }
      setRefUrls((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '参考图上传失败');
    } finally {
      setUploadingRef(false);
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) { setError('请输入提示词'); return; }
    setLoading(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        model,
        sizeLabel,
        projectId: currentProjectId,
      };
      if (model === 'gpt-image-2') {
        body.size = gptAspect;
      } else {
        body.size = nanoSize;
        body.aspectRatio = nanoAspect;
      }
      if (refUrls.length > 0) {
        body.urls = refUrls;
        body.refUrls = refUrls;
      }
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '生成失败');
      // 刷新历史
      void loadHistory(1, false, currentProjectId);
      void refreshBalance();
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
      // 失败时也刷新历史 —— 后端已经把 status='error' + error_message 写入 image_records,
      // 立即拉一遍，新的失败记录会即时出现在历史列表里，无需用户手动刷新页面。
      void loadHistory(1, false, currentProjectId);
      void refreshBalance();
    } finally {
      setLoading(false);
    }
  }, [prompt, model, gptAspect, nanoSize, nanoAspect, sizeLabel, refUrls, currentProjectId, loadHistory, refreshBalance]);

  const handleReuse = (item: ImageRecord) => {
    setPrompt(item.prompt);
    setModel(item.model);
    setRefUrls(item.ref_urls);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Left Panel */}
      <div className="flex-1 md:w-[480px] md:flex-none md:border-r border-gray-800 overflow-y-auto p-4 md:p-6 bg-[#0f111a]">
        <h2 className="text-xl font-bold mb-6">图片生成</h2>

        <div className="space-y-4">
          {/* Prompt */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="block text-sm font-bold mb-3 text-gray-300">提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="描述你想生成的图片内容..."
              className="w-full bg-[#0d0f1a] border-0 rounded-xl px-4 py-3 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-purple-500/50"
            />
            <div className="text-right text-xs text-gray-500 mt-2">{prompt.length}/5000</div>
          </div>

          {/* 参考图 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-bold text-gray-300">参考图 <span className="text-gray-500 font-normal text-xs">（选填，最多 4 张）</span></label>
              {refUrls.length > 0 && (
                <button onClick={() => setRefUrls([])} className="text-xs text-gray-500 hover:text-red-400 transition-colors">清空</button>
              )}
            </div>
            {refUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {refUrls.map((url, i) => (
                  <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-700 group">
                    <img src={url} alt={`参考图${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={() => setRefUrls((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-lg"
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => handleRefUpload(e.target.files)} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingRef || refUrls.length >= 4}
              className="w-full py-2.5 border border-dashed border-gray-600 rounded-xl text-sm text-gray-400 hover:border-purple-500/60 hover:text-purple-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {uploadingRef ? (
                <><span className="animate-spin h-3.5 w-3.5 border-2 border-purple-400 border-t-transparent rounded-full" />上传中...</>
              ) : (
                <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                {refUrls.length >= 4 ? '已达上限（4张）' : '添加参考图'}</>
              )}
            </button>
          </div>

          {/* Settings */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800 space-y-5">
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">生图模型</label>
              <div className="flex flex-col gap-2">
                {IMAGE_MODELS.map((opt) => (
                  <button key={opt.value} onClick={() => setModel(opt.value)}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${model === opt.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 bg-[#161824] hover:border-gray-600'}`}
                  >
                    <div className={`text-sm font-medium ${model === opt.value ? 'text-purple-400' : 'text-gray-300'}`}>{opt.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {model === 'gpt-image-2' ? (
              <div>
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">图片比例</label>
                <div className="flex flex-wrap gap-2">
                  {GPT_ASPECT_OPTIONS.map((s) => (
                    <button key={s} onClick={() => setGptAspect(s)}
                      className={`px-3 py-2 rounded-xl border text-sm transition-all ${gptAspect === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                    >{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">分辨率</label>
                  <div className="flex flex-wrap gap-2">
                    {NANO_SIZE_OPTIONS.map((s) => (
                      <button key={s} onClick={() => setNanoSize(s)}
                        className={`px-4 py-2 rounded-xl border text-sm transition-all ${nanoSize === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                      >{s}</button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-600 mt-2">分辨率越高，生成时间越长</p>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">图片比例</label>
                  <div className="flex flex-wrap gap-2">
                    {NANO_ASPECT_OPTIONS.map((s) => (
                      <button key={s} onClick={() => setNanoAspect(s)}
                        className={`px-3 py-2 rounded-xl border text-sm transition-all ${nanoAspect === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                      >{s}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {error && <p className="text-sm text-red-400 px-1">{error}</p>}

          <div className="pb-4">
            <button
              onClick={handleGenerate}
              disabled={loading || !prompt.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
            >
              {loading ? (
                <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />生成中...</>
              ) : (
                <><SparkleIcon className="w-4 h-4" />生成图片</>
              )}
            </button>
            <p className="text-xs text-gray-600 text-center mt-2">
              每次消耗 10 积分
              {balance && (
                <span className="ml-2 text-gray-500">
                  · 余额 {balance.unlimited ? <span className="text-amber-400">无限</span> : <span className={balance.available < 10 ? 'text-red-400 font-semibold' : 'text-gray-300 font-semibold'}>{balance.available}</span>} 积分
                  {!balance.unlimited && balance.locked > 0 && (
                    <span className="ml-1 text-amber-400/80">(锁定 {balance.locked})</span>
                  )}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel - History */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">历史记录</h2>
          {currentProjectId && (
            <span className="text-xs text-gray-600">当前工作组</span>
          )}
        </div>

        {loading && (
          <div className="mx-4 mt-2 p-4 rounded-2xl border border-purple-500/30 bg-purple-500/5">
            <div className="flex items-center gap-3">
              <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full flex-shrink-0" />
              <div className="text-sm font-medium text-purple-300">图片生成中，请稍候...</div>
            </div>
          </div>
        )}

        {records.length === 0 && !loading && !historyLoading && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            暂无生成记录
          </div>
        )}

        <div className="px-4 pb-4 space-y-3 mt-2">
          {records.map((item) => (
            <div key={item.id} className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
              <div className="flex gap-3 p-3 items-start">
                {/* 缩略图区域 */}
                <div
                  className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] cursor-pointer relative group"
                  onClick={() => item.result_urls[0] && setPreviewUrl(item.result_urls[0])}
                >
                  {item.status === 'pending' ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-purple-300 text-xs">
                      <span className="animate-spin h-6 w-6 border-2 border-purple-400 border-t-transparent rounded-full" />
                      生成中...
                    </div>
                  ) : item.status === 'error' ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-red-400 text-xs px-2 text-center">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      生成失败
                    </div>
                  ) : item.result_urls.length > 0 ? (
                    <>
                      <img src={item.result_urls[0]} alt="预览" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" /></svg>
                      </div>
                      {item.result_urls.length > 1 && (
                        <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                          +{item.result_urls.length - 1}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 text-center px-2 flex items-center justify-center h-full">无图片</span>
                  )}
                </div>

                {/* 信息区域 */}
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <p className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{item.prompt || '（无提示词）'}</p>

                  {/* 失败原因（来自 image_records.error_message，由后端写入上游 API 原始 msg） */}
                  {item.status === 'error' && item.error_message && (
                    <p className="text-[11px] text-red-400/90 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1 leading-snug break-words">
                      失败原因：{item.error_message}
                    </p>
                  )}

                  {/* 参考图 */}
                  {item.ref_urls.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {item.ref_urls.slice(0, 4).map((u, i) => (
                        <img key={i} src={u} className="w-8 h-8 rounded-lg object-cover border border-gray-700 flex-shrink-0" />
                      ))}
                    </div>
                  )}

                  {/* 底部：时间 + 参数 + 操作 */}
                  <div className="flex items-end justify-between gap-2 mt-auto">
                    <span className="text-[10px] text-gray-600 flex-shrink-0">
                      {formatShortDateTime(item.created_at)}
                    </span>
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex flex-wrap justify-end gap-1">
                        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 leading-none">图片</span>
                        {item.model && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 leading-none">
                            {item.model === 'gpt-image-2' ? 'GPT-2' : item.model === 'nano-banana-2' ? 'Nano2' : item.model}
                          </span>
                        )}
                        {item.size_label && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{item.size_label}</span>
                        )}
                        {item.credits_used > 0 && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none">{item.credits_used}积分</span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        {item.result_urls.length > 0 && (
                          <button
                            onClick={() => setPreviewUrl(item.result_urls[0])}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all"
                          >预览</button>
                        )}
                        {item.result_urls.map((url, i) => (
                          <button key={i}
                            onClick={() => downloadImageUrl(url, `image_${item.id}_${i + 1}.png`)}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                            {item.result_urls.length > 1 ? `下载${i + 1}` : '下载'}
                          </button>
                        ))}
                        <button
                          onClick={() => handleReuse(item)}
                          className="text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all"
                        >复用</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 无限滚动哨兵 */}
        <div ref={historyBottomRef} className="h-4" />
        {historyLoading && (
          <div className="flex justify-center py-4">
            <span className="animate-spin h-5 w-5 border-2 border-purple-400 border-t-transparent rounded-full" />
          </div>
        )}
        {!historyHasMore && records.length > 0 && (
          <div className="text-center text-xs text-gray-600 py-2">已显示全部记录</div>
        )}
      </div>

      {/* 图片预览 */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}>
          <div className="relative max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPreviewUrl(null)}
              className="absolute -top-10 right-0 text-gray-400 hover:text-white transition-colors text-sm">
              关闭 ✕
            </button>
            <img src={previewUrl} alt="预览" className="w-full rounded-2xl max-h-[85vh] object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
