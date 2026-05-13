import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import EnhancementDialog, { type EnhancementSource } from '../components/EnhancementDialog';
import { listMyEnhancements } from '../services/enhancementService';
import { getDownloadTasks } from '../services/downloadService';
import { uploadToOss } from '../services/ossService';
import type { DownloadTask, VideoEnhancement } from '../types';
import { SparkleIcon, SpinnerIcon, DownloadIcon, CloseIcon } from '../components/Icons';
import { formatDateTime, useUserTimezone } from '../utils/datetime';

type Tab = 'history' | 'external';

const SCENE_LABEL: Record<VideoEnhancement['scene'], string> = {
  common: '通用',
  aigc: 'AIGC',
  short_series: '短剧',
  ugc: 'UGC',
  old_film: '老片修复',
};

const VERSION_LABEL: Record<VideoEnhancement['tool_version'], string> = {
  standard: '标准版',
  professional: '专业版',
};

const STATUS_BADGE: Record<VideoEnhancement['status'], { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'bg-gray-700/40 text-gray-300 border-gray-600' },
  processing: { text: '处理中', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  done: { text: '已完成', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  error: { text: '失败', cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
};

export default function EnhancementPage() {
  useUserTimezone();
  const { state, currentUser } = useApp();
  const projectId = state.currentProject?.id ?? null;

  const [tab, setTab] = useState<Tab>('history');
  const [dialogSource, setDialogSource] = useState<EnhancementSource | null>(null);

  // ── 我的生成 Tab ───────────────────────────────────────────────
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksPage, setTasksPage] = useState(1);
  const [tasksTotal, setTasksTotal] = useState(0);
  const TASKS_PAGE_SIZE = 12;

  async function loadTasks(page = tasksPage) {
    setTasksLoading(true);
    try {
      const data = await getDownloadTasks('all', 'video', page, TASKS_PAGE_SIZE, projectId);
      const eligible = data.tasks.filter((t) => t.status === 'done' && t.video_url);
      setTasks(eligible);
      setTasksTotal(data.total);
      setTasksPage(page);
    } catch (e) {
      console.error('[enhancement] 加载视频列表失败', e);
    } finally {
      setTasksLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'history') loadTasks(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectId]);

  // ── 外部视频 Tab ───────────────────────────────────────────────
  const [extUrl, setExtUrl] = useState('');
  const [extDuration, setExtDuration] = useState<number | ''>('');
  const [extUploading, setExtUploading] = useState(false);
  const [extUploadPct, setExtUploadPct] = useState(0);
  const [extProbeError, setExtProbeError] = useState<string | null>(null);
  const probeRef = useRef<HTMLVideoElement | null>(null);

  // URL 变化时自动探测时长
  useEffect(() => {
    setExtProbeError(null);
    if (!extUrl || !/^https?:\/\//i.test(extUrl)) return;
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.crossOrigin = 'anonymous';
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setExtDuration(Math.round(v.duration));
      } else {
        setExtProbeError('无法识别视频时长，请手动输入');
      }
    };
    const onErr = () => setExtProbeError('视频加载失败，可能跨域受限，请手动输入时长');
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
    v.src = extUrl;
    probeRef.current = v;
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onErr);
      v.src = '';
      probeRef.current = null;
    };
  }, [extUrl]);

  async function handleUpload(file: File) {
    setExtUploading(true);
    setExtUploadPct(0);
    try {
      const res = await uploadToOss(file, 'video', (p) => setExtUploadPct(p));
      setExtUrl(res.url);
    } catch (e: any) {
      alert(e?.message || '上传失败');
    } finally {
      setExtUploading(false);
    }
  }

  // ── 增强记录 ────────────────────────────────────────────────────
  const [records, setRecords] = useState<VideoEnhancement[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const RECORDS_PAGE_SIZE = 10;

  async function loadRecords(page = recordsPage) {
    setRecordsLoading(true);
    try {
      const data = await listMyEnhancements(page, RECORDS_PAGE_SIZE);
      setRecords(data.items);
      setRecordsTotal(data.total);
      setRecordsPage(page);
    } catch (e) {
      console.error('[enhancement] 加载增强记录失败', e);
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => { loadRecords(1); }, []);

  // 处理中时 45s 轮询
  const hasProcessing = useMemo(
    () => records.some((r) => r.status === 'processing' || r.status === 'pending'),
    [records],
  );
  useEffect(() => {
    if (!hasProcessing) return;
    const t = setInterval(() => loadRecords(recordsPage), 45000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasProcessing, recordsPage]);

  function onSubmitted(en: VideoEnhancement) {
    setRecords((rs) => [en, ...rs]);
    setRecordsTotal((n) => n + 1);
  }

  const userBalance = currentUser?.credits ?? 0;
  const unlimited = !!currentUser?.unlimitedCredits;

  return (
    <div className="min-h-screen bg-[#0f111a] text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* 警示框 */}
        <div className="mb-6 p-4 bg-red-500/15 border border-red-500/50 rounded-xl flex items-center gap-3">
          <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
          <span className="text-red-300 text-sm font-medium">测试功能未启用</span>
        </div>

        {/* 标题 */}
        <div className="mb-6 flex items-center gap-3">
          <SparkleIcon className="w-7 h-7 text-purple-400" />
          <h1 className="text-2xl font-bold">画质增强</h1>
          <span className="text-xs text-gray-500">火山 AI MediaKit · 720p → 1080p / 4K</span>
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 border-b border-gray-800 mb-5">
          {([
            { k: 'history', label: '我的生成' },
            { k: 'external', label: '外部视频' },
          ] as const).map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === t.k
                  ? 'border-purple-500 text-purple-300'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* === 我的生成 === */}
        {tab === 'history' && (
          <div className="mb-8">
            {tasksLoading ? (
              <div className="text-center py-12 text-gray-500">
                <SpinnerIcon className="w-6 h-6 animate-spin inline-block" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-12 text-gray-500 text-sm">
                当前工作组下还没有可增强的视频，去「视频生成」生成一段吧
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="bg-[#1c1f2e] border border-gray-800 rounded-xl overflow-hidden hover:border-purple-500/50 transition"
                    >
                      <video
                        src={t.video_url}
                        muted
                        playsInline
                        preload="metadata"
                        controls
                        className="w-full aspect-video bg-black"
                      />
                      <div className="p-3">
                        <div className="text-xs text-gray-400 line-clamp-2 leading-snug min-h-[2rem]">
                          {t.prompt || '无描述'}
                        </div>
                        <div className="flex items-center justify-between mt-2.5">
                          <span className="text-[10px] text-gray-500">
                            {t.duration ? `${t.duration}s` : ''} {t.resolution || ''}
                          </span>
                          <button
                            onClick={() =>
                              setDialogSource({
                                kind: 'task',
                                taskId: t.id,
                                durationSec: Math.max(1, Math.round(Number(t.duration) || 5)),
                                sourceResolution: t.resolution || undefined,
                              })
                            }
                            className="text-xs px-3 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium transition-all"
                          >
                            ✨ 增强
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {/* 分页 */}
                {tasksTotal > TASKS_PAGE_SIZE && (
                  <Pager
                    page={tasksPage}
                    total={tasksTotal}
                    pageSize={TASKS_PAGE_SIZE}
                    onChange={(p) => loadTasks(p)}
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* === 外部视频 === */}
        {tab === 'external' && (
          <div className="mb-8 bg-[#1c1f2e] border border-gray-800 rounded-2xl p-5 space-y-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">视频 URL（http/https，需 MediaKit 可访问）</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={extUrl}
                  onChange={(e) => setExtUrl(e.target.value.trim())}
                  placeholder="https://example.com/video.mp4"
                  disabled={extUploading}
                  className="flex-1 bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none disabled:opacity-50"
                />
                <label
                  className={`px-4 py-2 rounded-xl text-sm font-medium cursor-pointer transition ${
                    extUploading
                      ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                      : 'bg-gray-700 hover:bg-gray-600 text-white'
                  }`}
                >
                  {extUploading ? `上传中 ${extUploadPct}%` : '上传'}
                  <input
                    type="file"
                    accept="video/*"
                    className="hidden"
                    disabled={extUploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5">时长（秒）</label>
              <input
                type="number"
                min={1}
                max={300}
                value={extDuration}
                onChange={(e) => {
                  const v = e.target.value;
                  setExtDuration(v === '' ? '' : Math.max(1, Math.min(300, Number(v))));
                }}
                placeholder="自动探测；探测失败时手动输入"
                className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-purple-500 focus:outline-none"
              />
              {extProbeError && <div className="text-[11px] text-amber-400 mt-1">{extProbeError}</div>}
              <div className="text-[10px] text-gray-600 mt-1">单次提交时长上限 300 秒</div>
            </div>

            {extUrl && (
              <video
                src={extUrl}
                controls
                muted
                playsInline
                preload="metadata"
                className="w-full max-h-72 bg-black rounded-xl"
              />
            )}

            <div className="flex justify-end pt-2">
              <button
                disabled={!extUrl || !extDuration || extUploading}
                onClick={() => {
                  if (!extUrl || !extDuration) return;
                  setDialogSource({ kind: 'url', videoUrl: extUrl, durationSec: Number(extDuration) });
                }}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-all"
              >
                ✨ 增强
              </button>
            </div>
          </div>
        )}

        {/* === 增强记录 === */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">增强记录</h2>
            <button
              onClick={() => loadRecords(recordsPage)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all"
            >
              刷新
            </button>
          </div>
          {recordsLoading ? (
            <div className="text-center py-10 text-gray-500">
              <SpinnerIcon className="w-6 h-6 animate-spin inline-block" />
            </div>
          ) : records.length === 0 ? (
            <div className="text-center py-10 text-gray-500 text-sm">还没有提交过增强任务</div>
          ) : (
            <div className="space-y-3">
              {records.map((r) => (
                <RecordRow key={r.id} r={r} />
              ))}
              {recordsTotal > RECORDS_PAGE_SIZE && (
                <Pager
                  page={recordsPage}
                  total={recordsTotal}
                  pageSize={RECORDS_PAGE_SIZE}
                  onChange={(p) => loadRecords(p)}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 弹窗 */}
      {dialogSource && (
        <EnhancementDialog
          source={dialogSource}
          userBalance={userBalance}
          unlimited={unlimited}
          projectId={projectId}
          onClose={() => setDialogSource(null)}
          onSubmitted={(en) => {
            onSubmitted(en);
            setDialogSource(null);
          }}
        />
      )}
    </div>
  );
}

// ── 子组件 ────────────────────────────────────────────────────────

function Pager({
  page, total, pageSize, onChange,
}: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-center gap-2 pt-4 text-sm">
      <button
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >上一页</button>
      <span className="text-gray-400">{page} / {totalPages}</span>
      <button
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >下一页</button>
    </div>
  );
}

function RecordRow({ r }: { r: VideoEnhancement }) {
  const badge = STATUS_BADGE[r.status];
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  return (
    <>
      <div className="bg-[#1c1f2e] border border-gray-800 rounded-xl p-3 flex gap-3 items-start">
        {/* 原片缩略 */}
        <div className="w-32 flex-shrink-0">
          {r.source_video_url ? (
            <video
              src={r.source_video_url}
              muted
              playsInline
              preload="metadata"
              onClick={() => setPreviewUrl(r.source_video_url || null)}
              className="w-full aspect-video bg-black rounded cursor-pointer"
            />
          ) : (
            <div className="w-full aspect-video bg-black rounded flex items-center justify-center text-gray-600 text-[10px]">
              无原片
            </div>
          )}
          <div className="text-[10px] text-gray-500 mt-1 text-center">原片</div>
        </div>

        {/* 中间信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-2 py-0.5 rounded border ${badge.cls}`}>
              {badge.text}
            </span>
            <span className="text-xs text-gray-300">
              {SCENE_LABEL[r.scene]} · {VERSION_LABEL[r.tool_version]} · {r.target_resolution ?? (r.resolution_limit ? `${r.resolution_limit}px` : '-')} · {r.target_fps ?? 30}fps
            </span>
            {r.task_id == null && (
              <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">
                外部视频
              </span>
            )}
            {r.status === 'done' && r.credits_used != null && (
              <span
                className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none"
                title="本次实际扣除积分"
              >
                {r.credits_used > 0 ? `${r.credits_used}积分` : '未计费'}
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-1.5">
            提交于 {formatDateTime(r.created_at)}
            {r.duration_seconds ? ` · 时长 ${r.duration_seconds}s` : ''}
          </div>
          {r.status === 'error' && r.error_message && (
            <div className="text-[11px] text-red-400 mt-1.5 break-all">{r.error_message}</div>
          )}
          {r.status === 'processing' && (
            <div className="text-[11px] text-blue-300 mt-1.5">
              <SpinnerIcon className="w-3 h-3 inline-block animate-spin mr-1" />
              MediaKit 处理中（标准版 6~10 分钟，专业版 30+ 分钟）
            </div>
          )}
        </div>

        {/* 增强片 */}
        <div className="w-32 flex-shrink-0">
          {r.status === 'done' && r.enhanced_video_url ? (
            <>
              <video
                src={r.enhanced_video_url}
                muted
                playsInline
                preload="metadata"
                onClick={() => setPreviewUrl(r.enhanced_video_url || null)}
                className="w-full aspect-video bg-black rounded cursor-pointer"
              />
              <a
                href={`/api/video-proxy?url=${encodeURIComponent(r.enhanced_video_url)}&download=enhanced_${r.id}.mp4`}
                className="mt-1 flex items-center justify-center gap-1 text-[11px] text-purple-300 hover:text-purple-200"
              >
                <DownloadIcon className="w-3 h-3" /> 下载
              </a>
            </>
          ) : (
            <div className="w-full aspect-video bg-black/40 rounded flex items-center justify-center text-gray-600 text-[10px]">
              {r.status === 'done' ? '链接已过期' : '待生成'}
            </div>
          )}
          <div className="text-[10px] text-gray-500 mt-1 text-center">增强片</div>
        </div>
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <button
            onClick={() => setPreviewUrl(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-gray-800 hover:bg-gray-700 flex items-center justify-center"
          >
            <CloseIcon className="w-5 h-5 text-white" />
          </button>
          <video
            src={previewUrl}
            controls
            autoPlay
            className="max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
