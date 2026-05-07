import { useState, useCallback } from 'react';
import { getAuthHeaders } from '../services/authService';
import { SparkleIcon } from '../components/Icons';

const IMAGE_MODELS = [
  { value: 'nano-banana-2', label: 'Nano Banana 2', description: '速创生图，快速出图' },
  { value: 'gpt-image-2', label: 'GPT-Image-2', description: '高质量生图模型' },
] as const;

const SIZE_OPTIONS = ['1024x1024', '1536x1024', '1024x1536'] as const;

interface ImageHistoryItem {
  id: number;
  prompt: string;
  model: string;
  size: string;
  n: number;
  urls: string[];
  creditsUsed: number | null;
  createdAt: Date;
}

let nextHistoryId = 0;

export default function ImageGenPage() {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('nano-banana-2');
  const [size, setSize] = useState<string>('1024x1024');
  const [n, setN] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ImageHistoryItem[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) { setError('请输入提示词'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt: prompt.trim(), model, size, n }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '生成失败');
      const urls: string[] = (data.data?.data || []).map((d: any) => d.url || d.b64_json).filter(Boolean);
      const item: ImageHistoryItem = {
        id: ++nextHistoryId,
        prompt: prompt.trim(),
        model,
        size,
        n,
        urls,
        creditsUsed: typeof data.creditsUsed === 'number' ? data.creditsUsed : null,
        createdAt: new Date(),
      };
      setHistory((prev) => [item, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setLoading(false);
    }
  }, [prompt, model, size, n]);

  const handleReuse = (item: ImageHistoryItem) => {
    setPrompt(item.prompt);
    setModel(item.model);
    setSize(item.size);
    setN(item.n);
  };

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Left Panel - Form */}
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

          {/* Settings */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800 space-y-5">
            {/* Model */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">生图模型</label>
              <div className="flex flex-col gap-2">
                {IMAGE_MODELS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setModel(opt.value)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                      model === opt.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                    }`}
                  >
                    <div className={`text-sm font-medium ${model === opt.value ? 'text-purple-400' : 'text-gray-300'}`}>{opt.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Size */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">图片尺寸</label>
              <div className="flex flex-wrap gap-2">
                {SIZE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSize(s)}
                    className={`px-3 py-2 rounded-lg border text-sm transition-all ${
                      size === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Count */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">生成数量</label>
              <div className="flex gap-2">
                {[1, 2, 4].map((v) => (
                  <button
                    key={v}
                    onClick={() => setN(v)}
                    className={`px-4 py-2 rounded-lg border text-sm transition-all ${
                      n === v ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {v} 张
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-red-400 px-1">{error}</p>}

          {/* Generate button */}
          <div className="pb-4">
            <button
              onClick={handleGenerate}
              disabled={loading || !prompt.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
            >
              {loading ? (
                <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />生成中...</>
              ) : (
                <><SparkleIcon className="w-4 h-4" />生成图片</>
              )}
            </button>
            <p className="text-xs text-gray-600 text-center mt-2">每次消耗 5 积分</p>
          </div>
        </div>
      </div>

      {/* Right Panel - History */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">历史记录</h2>
        </div>

        {loading && (
          <div className="mx-4 mt-2 p-4 rounded-2xl border border-purple-500/30 bg-purple-500/5">
            <div className="flex items-center gap-3">
              <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full flex-shrink-0" />
              <div className="text-sm font-medium text-purple-300">图片生成中，请稍候...</div>
            </div>
          </div>
        )}

        {history.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            暂无生成记录
          </div>
        )}

        <div className="px-4 pb-4 space-y-4 mt-2">
          {history.map((item) => (
            <div key={item.id} className="bg-[#1c1f2e] border border-gray-800 rounded-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-start justify-between px-4 pt-3 pb-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 line-clamp-2">{item.prompt}</p>
                  <div className="flex gap-3 mt-1 text-[10px] text-gray-600">
                    <span>{item.model}</span>
                    <span>{item.size}</span>
                    {item.creditsUsed !== null && <span className="text-amber-500">消耗 {item.creditsUsed} 积分</span>}
                    <span>{item.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleReuse(item)}
                  className="ml-3 flex-shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all"
                >
                  复用
                </button>
              </div>

              {/* Images grid */}
              <div className={`grid gap-2 p-3 pt-0 ${item.urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {item.urls.map((url, i) => (
                  <div
                    key={i}
                    className="rounded-xl overflow-hidden border border-gray-700 cursor-pointer hover:border-purple-500/50 transition-all group relative"
                    onClick={() => setPreviewUrl(url)}
                  >
                    <img src={url} alt={`图片 ${i + 1}`} className="w-full object-cover" />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" /></svg>
                    </div>
                    <div className="absolute bottom-2 right-2">
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-[10px] px-2 py-0.5 bg-black/60 text-gray-300 rounded hover:text-white transition-colors"
                      >
                        下载
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Image preview modal */}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPreviewUrl(null)}
              className="absolute -top-10 right-0 text-gray-400 hover:text-white transition-colors text-sm"
            >
              关闭 ✕
            </button>
            <img src={previewUrl} alt="预览" className="w-full rounded-2xl max-h-[85vh] object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}
