import { useState, useEffect, useRef, useCallback } from 'react';
import * as downloadService from '../services/downloadService';
import type { DownloadTask } from '../types/index';
import { useApp } from '../context/AppContext';
import { formatDateTime, elapsedSeconds, useUserTimezone } from '../utils/datetime';
import { videoUrlToMp3Blob, downloadBlob, ExpiredVideoUrlError } from '../utils/audioExtractor';

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

function CheckIcon({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  if (indeterminate) {
    return (
      <div className="w-5 h-5 rounded-lg bg-purple-500/30 border-2 border-purple-400 flex items-center justify-center transition-all">
        <div className="w-2.5 h-0.5 rounded-full bg-purple-400" />
      </div>
    );
  }
  if (checked) {
    return (
      <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center shadow-md shadow-purple-500/30 transition-all scale-110">
        <svg viewBox="0 0 12 10" className="w-3 h-3" fill="none">
          <path d="M1.5 5L4.5 8L10.5 1.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    );
  }
  return (
    <div className="w-5 h-5 rounded-lg border-2 border-dashed border-gray-600 bg-[#1c1f2e] hover:border-purple-400/60 transition-all" />
  );
}
interface DownloadState {
  tasks: DownloadTask[];
  total: number;
  page: number;
  pageSize: number;
  statusFilter: string;
  typeFilter: string;
  selectedRowKeys: string[];
  isLoading: boolean;
  downloadingIds: Set<number>;
  previewTask: DownloadTask | null;
}

interface GeneratingTask {
  taskId: number;
  historyId: string;
  createdAt: string;
  elapsedSeconds: number;
}

export default function DownloadManagementPage() {
  useUserTimezone(); // 订阅时区变更，自动重渲染
  const { state: appState } = useApp();
  const currentProjectId = appState.currentProject?.id ?? null;
  const projectsLoaded = !appState.loading;
  const [state, setState] = useState<DownloadState>({
    tasks: [],
    total: 0,
    page: 1,
    pageSize: 20,
    statusFilter: 'all',
    typeFilter: 'all',
    selectedRowKeys: [],
    isLoading: false,
    downloadingIds: new Set(),
    previewTask: null,
  });

  const { tasks, total, page, pageSize, statusFilter, typeFilter, selectedRowKeys, isLoading, downloadingIds, previewTask } = state;

  // 各源表（tasks / image_records / audio_generations / tasks_happyhorse）的 id 各自自增,易冲突。
  // HappyHorse 行在下载页被打成 model_type='video'（不作为独立种类），用 happyhorse_mode 字段做内部识别。
  const isHappyhorse = (t: DownloadTask) => !!t.happyhorse_mode;
  const rowKey = (t: DownloadTask) => `${isHappyhorse(t) ? 'happyhorse' : t.model_type}:${t.id}`;
  // 视频生成 V-；HappyHorse 视频 V-H- 加以区分，避免两个 id 撞到同一前缀
  const TYPE_PREFIX: Record<string, string> = { video: 'V', image: 'I', audio: 'A', enhancement: 'E' };
  const displayId = (t: DownloadTask) => {
    if (isHappyhorse(t)) return `V-H-${t.id.toString().padStart(6, '0')}`;
    return `${TYPE_PREFIX[t.model_type] || 'T'}-${t.id.toString().padStart(6, '0')}`;
  };

  // 轮询引用
  const pollIntervalRef = useRef<number | null>(null);
  const hasInitializedRef = useRef(false);
  const dragStartIndexRef = useRef<number | null>(null);
  const dragSelectingRef = useRef(true);
  const [generatingTasks, setGeneratingTasks] = useState<GeneratingTask[]>([]);

  const toGeneratingTasks = (items: Array<{ taskId: number; historyId: string; createdAt: string }> = []) =>
    items.map((task) => ({
      taskId: task.taskId,
      historyId: task.historyId,
      createdAt: task.createdAt,
      elapsedSeconds: elapsedSeconds(task.createdAt),
    }));

  // 手动添加单个任务到轮询列表
  const handleWatchTask = (taskId: number, historyId: string, createdAt: string) => {
    setGeneratingTasks((prev) => {
      if (prev.some((t) => t.taskId === taskId)) {
        return prev;
      }
      return [
        ...prev,
        {
          taskId,
          historyId,
          createdAt,
          elapsedSeconds: elapsedSeconds(createdAt),
        },
      ];
    });
  };

  // 加载下载任务列表
  const loadTasks = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const result = await downloadService.getDownloadTasks(statusFilter, typeFilter, page, pageSize, currentProjectId, true);
      setState((prev) => ({
        ...prev,
        tasks: result.tasks,
        total: result.total,
        isLoading: false,
      }));
    } catch (error) {
      alert(`加载任务列表失败：${error instanceof Error ? error.message : error}`);
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [statusFilter, typeFilter, page, pageSize, currentProjectId]);

  const refreshGeneratingState = useCallback(async ({
    showSummary = false,
    showCompletedNotice = false,
    silentError = false,
  }: {
    showSummary?: boolean;
    showCompletedNotice?: boolean;
    silentError?: boolean;
  } = {}) => {
    try {
      const result = await downloadService.refreshDownloadTasks();
      setGeneratingTasks(toGeneratingTasks(result.generatingTasks ?? []));
      await loadTasks();

      if (showSummary) {
        alert(`刷新完成：已更新 ${result.refreshed} 个任务，${result.generating || 0} 个任务仍在生成中`);
      } else if (showCompletedNotice && result.refreshed > 0) {
        alert(`有 ${result.refreshed} 个任务已生成完成！`);
      }

      return result;
    } catch (error) {
      if (!silentError) {
        alert(`刷新失败：${error instanceof Error ? error.message : error}`);
      }
      throw error;
    }
  }, [loadTasks]);

  useEffect(() => {
    if (!projectsLoaded) return;
    const initializeOrLoad = async () => {
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        try {
          await refreshGeneratingState({ silentError: true });
        } catch (error) {
          console.error('初始化刷新失败:', error);
          await loadTasks();
        }
        return;
      }

      await loadTasks();
    };

    void initializeOrLoad();
  }, [projectsLoaded, loadTasks, refreshGeneratingState]);

  // 刷新任务列表（获取已生成的视频）
  const handleRefresh = async () => {
    try {
      await refreshGeneratingState({ silentError: true });
    } catch (error) {
      console.error('手动刷新失败:', error);
    }
  };

  // 轮询生成中的任务
  const pollGeneratingTasks = useCallback(async () => {
    if (generatingTasks.length === 0) return;

    try {
      await refreshGeneratingState({ showCompletedNotice: true, silentError: true });
    } catch (error) {
      console.error('轮询失败:', error);
    }
  }, [generatingTasks.length, refreshGeneratingState]);

  // 启动轮询 + 每秒更新已等待时间
  useEffect(() => {
    if (generatingTasks.length > 0) {
      pollGeneratingTasks();
      pollIntervalRef.current = window.setInterval(pollGeneratingTasks, 5000);
    }

    const tickInterval = window.setInterval(() => {
      setGeneratingTasks((prev) => prev.map((t) => ({ ...t, elapsedSeconds: t.elapsedSeconds + 1 })));
    }, 1000);

    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      window.clearInterval(tickInterval);
    };
  }, [generatingTasks.length, pollGeneratingTasks]);

  // 预览视频
  const handlePreview = (task: DownloadTask) => {
    setState((prev) => ({ ...prev, previewTask: task }));
  };

  const handleClosePreview = () => {
    setState((prev) => ({ ...prev, previewTask: null }));
  };

  // 计算生成时长
  const formatElapsed = (seconds: number) => {
    if (seconds < 60) return `${seconds}秒`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}分${secs.toString().padStart(2, '0')}秒`;
    const hours = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hours}小时${remainMins}分`;
  };
  const withDownloadingState = async (taskId: number, action: () => Promise<void>) => {
    if (downloadingIds.has(taskId)) return;

    setState((prev) => ({
      ...prev,
      downloadingIds: new Set(prev.downloadingIds).add(taskId),
    }));

    try {
      await action();
    } finally {
      setState((prev) => {
        const newSet = new Set(prev.downloadingIds);
        newSet.delete(taskId);
        return { ...prev, downloadingIds: newSet };
      });
    }
  };

  // 音频 mp3 下载（浏览器端转码缓存，避免重复转码）
  const audioMp3CacheRef = useRef<Map<number, Blob>>(new Map());
  const audioConvertingRef = useRef<Set<number>>(new Set());
  const [audioConverting, setAudioConverting] = useState<Record<number, boolean>>({});

  // 客户端"已下载"乐观更新：调后端 mark-downloaded 前先把 rowKey 加进 Set，
  // 让用户的点击立刻反映在状态徽章上；后端调用失败时回滚，调用成功后 loadTasks 让 effective_download_status 真值生效。
  const [optimisticDownloaded, setOptimisticDownloaded] = useState<Set<string>>(new Set());
  const markPersistDownloaded = (task: DownloadTask) => {
    const key = rowKey(task);
    setOptimisticDownloaded((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev); next.add(key); return next;
    });
    const rollback = () => setOptimisticDownloaded((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev); next.delete(key); return next;
    });
    if (task.model_type === 'image') {
      downloadService.markImageRecordDownloaded(task.id).then(() => loadTasks()).catch(rollback);
    } else if (task.model_type === 'audio') {
      downloadService.markAudioGenerationDownloaded(task.id).then(() => loadTasks()).catch(rollback);
    } else if (task.model_type === 'enhancement') {
      downloadService.markEnhancementDownloaded(task.id).then(() => loadTasks()).catch(rollback);
    } else if (isHappyhorse(task)) {
      downloadService.markHappyhorseDownloaded(task.id).then(() => loadTasks()).catch(rollback);
    }
    // video 由 handleBrowserDownload 内部已调 markDownloaded + loadTasks，这里不重复
  };

  const handleAudioMp3Download = async (task: DownloadTask) => {
    if (!task.video_url) { alert('音频源视频地址不可用'); return; }
    const cached = audioMp3CacheRef.current.get(task.id);
    if (cached) {
      downloadBlob(cached, `audio_${task.id}.mp3`);
      markPersistDownloaded(task);
      return;
    }
    if (audioConvertingRef.current.has(task.id)) return;
    audioConvertingRef.current.add(task.id);
    setAudioConverting((m) => ({ ...m, [task.id]: true }));
    try {
      const blob = await videoUrlToMp3Blob(task.video_url);
      audioMp3CacheRef.current.set(task.id, blob);
      downloadBlob(blob, `audio_${task.id}.mp3`);
      markPersistDownloaded(task);
    } catch (e) {
      if (e instanceof ExpiredVideoUrlError) {
        alert(e.message);
      } else {
        alert('转码失败：' + ((e as Error)?.message || ''));
      }
    } finally {
      audioConvertingRef.current.delete(task.id);
      setAudioConverting((m) => { const x = { ...m }; delete x[task.id]; return x; });
    }
  };

  // 图片任务的整组下载（一行可能含多张），同步标记已下载（持久化）
  const handleImageRowDownload = (task: DownloadTask) => {
    if (!task.image_urls || task.image_urls.length === 0) return;
    task.image_urls.forEach((url, i) => {
      const filename = `image_${task.id}_${i + 1}.png`;
      void downloadImageUrl(url, filename);
    });
    markPersistDownloaded(task);
  };

  const handleBrowserDownload = async (task: DownloadTask) => {
    const baseName = task.model_type === 'enhancement' ? 'enhanced'
      : isHappyhorse(task) ? 'happyhorse'
      : 'task';
    const filename = `${baseName}_${task.id}_${(task.prompt || 'video').substring(0, 20).replace(/[^\w\u4e00-\u9fa5]/g, '_')}.mp4`;
    // 有远程 URL 直接走代理下载，无需先保存到服务器
    if (task.video_url) {
      downloadService.downloadVideoFromRemoteUrl(task.video_url, filename);
      // markDownloaded after triggering download (fire-and-forget refresh)
      if (task.model_type === 'enhancement') {
        downloadService.markEnhancementDownloaded(task.id).then(() => loadTasks()).catch(() => {});
      } else if (isHappyhorse(task)) {
        downloadService.markHappyhorseDownloaded(task.id).then(() => loadTasks()).catch(() => {});
      } else {
        downloadService.markDownloaded(task.id).then(() => loadTasks()).catch(() => {});
      }
      return;
    }
    // 兜底：已下载到服务器的走 token 下载（仅视频任务支持）
    if (task.model_type !== 'video') {
      alert('该任务没有可下载的远程 URL');
      return;
    }
    await withDownloadingState(task.id, async () => {
      try {
        await downloadService.downloadLocalVideoFile(task.id, filename);
      } catch (error) {
        alert(`下载失败：${error instanceof Error ? error.message : error}`);
      }
    });
  };

  // 按 task 类型分发到对应的下载流程；视频走 OSS 直链 + 后端标记，图片/音频走客户端标记
  const dispatchDownload = (task: DownloadTask) => {
    if (task.model_type === 'audio' && task.video_url) {
      void handleAudioMp3Download(task);
    } else if (task.model_type === 'image' && task.image_urls && task.image_urls.length > 0) {
      handleImageRowDownload(task);
    } else if (task.video_url) {
      void handleBrowserDownload(task);
    }
  };

  // 批量下载（浏览器逐个触发）—— 三种类型一视同仁
  const handleBatchDownload = () => {
    if (selectedRowKeys.length === 0) return;
    const selected = tasks.filter((t) => {
      if (!selectedRowKeys.includes(rowKey(t))) return false;
      if (t.model_type === 'audio') return !!t.video_url;
      if (t.model_type === 'image') return (t.image_urls?.length ?? 0) > 0;
      return !!t.video_url; // video
    });
    if (selected.length === 0) { alert('所选任务中没有可下载的内容'); return; }
    selected.forEach(dispatchDownload);
  };

  // 下载全部待下载（含视频/图片/音频）
  const handleDownloadAllPending = () => {
    const pending = tasks.filter((t) => {
      if (t.effective_download_status !== 'pending') return false;
      if (t.model_type === 'audio') return !!t.video_url;
      if (t.model_type === 'image') return (t.image_urls?.length ?? 0) > 0;
      return !!t.video_url;
    });
    if (pending.length === 0) { alert('没有待下载的任务'); return; }
    pending.forEach(dispatchDownload);
  };

  // 删除任务（视频/图片/音频通用）：未下载的二次确认
  const handleDeleteTask = async (task: DownloadTask) => {
    const k = rowKey(task);
    const isDownloaded = task.model_type === 'video'
      ? task.effective_download_status === 'done'
      : (!!task.downloaded_at || optimisticDownloaded.has(k));

    if (isDownloaded) {
      if (!confirm('确定要删除此任务吗？')) return;
    } else {
      if (!confirm('该文件并未下载，是否确认删除？')) return;
    }

    try {
      if (task.model_type === 'image') {
        await downloadService.deleteImageRecord(task.id);
      } else if (task.model_type === 'audio') {
        await downloadService.deleteAudioGeneration(task.id);
      } else if (task.model_type === 'enhancement') {
        await downloadService.deleteEnhancement(task.id);
      } else if (task.model_type === 'happyhorse') {
        await downloadService.deleteHappyhorse(task.id);
      } else {
        await downloadService.deleteTask(task.id);
      }
      loadTasks();
    } catch (error) {
      alert(`删除任务失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedRowKeys.length === tasks.length) {
      setState((prev) => ({ ...prev, selectedRowKeys: [] }));
    } else {
      setState((prev) => ({
        ...prev,
        selectedRowKeys: tasks.map((t) => rowKey(t)),
      }));
    }
  };

  // 拖选逻辑
  const handleRowMouseDown = (index: number, key: string) => {
    dragStartIndexRef.current = index;
    dragSelectingRef.current = !selectedRowKeys.includes(key);
    setState((prev) => ({
      ...prev,
      selectedRowKeys: dragSelectingRef.current
        ? [...new Set([...prev.selectedRowKeys, key])]
        : prev.selectedRowKeys.filter((k) => k !== key),
    }));
  };

  const handleRowMouseEnter = (index: number) => {
    if (dragStartIndexRef.current === null) return;
    const start = Math.min(dragStartIndexRef.current, index);
    const end = Math.max(dragStartIndexRef.current, index);
    const rangeKeys = tasks.slice(start, end + 1).map((t) => rowKey(t));
    setState((prev) => ({
      ...prev,
      selectedRowKeys: dragSelectingRef.current
        ? [...new Set([...prev.selectedRowKeys, ...rangeKeys])]
        : prev.selectedRowKeys.filter((k) => !rangeKeys.includes(k)),
    }));
  };

  useEffect(() => {
    const stopDrag = () => { dragStartIndexRef.current = null; };
    document.addEventListener('mouseup', stopDrag);
    return () => document.removeEventListener('mouseup', stopDrag);
  }, []);

  // 分页
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 max-w-7xl mx-auto bg-[#0f111a] min-h-screen">
      {/* 标题 */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">下载管理</h1>
        <p className="text-gray-400 text-sm mt-1">
          管理已完成任务的下载与结果文件
          {generatingTasks.length > 0 && (
            <span className="ml-2 text-yellow-400">
              · 正在监听 {generatingTasks.length} 个生成中的任务
            </span>
          )}
        </p>
      </div>

      {/* 生成中任务监控面板 */}
      {generatingTasks.length > 0 && (
        <div className="mb-6 bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-yellow-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <h2 className="text-lg font-semibold text-yellow-400">正在监听生成中的任务</h2>
            </div>
            <button
              onClick={() => setGeneratingTasks([])}
              className="text-xs text-gray-400 hover:text-gray-300 transition-colors"
            >
              停止监听
            </button>
          </div>
          <div className="space-y-2">
            {generatingTasks.slice(0, 5).map((task) => (
              <div
                key={task.taskId}
                className="flex items-center justify-between bg-[#0f111a]/50 rounded px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500 font-mono">#{task.taskId}</span>
                  <span className="text-xs text-gray-400">History: {task.historyId}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-yellow-400">
                    已等待 {formatElapsed(task.elapsedSeconds)}
                  </span>
                  <span className="text-xs text-gray-500">·</span>
                  <span className="text-xs text-gray-400">每 5 秒自动刷新</span>
                </div>
              </div>
            ))}
            {generatingTasks.length > 5 && (
              <div className="text-xs text-gray-500 text-center">
                还有 {generatingTasks.length - 5} 个任务正在生成中...
              </div>
            )}
          </div>
        </div>
      )}

      {/* 筛选器和操作栏 */}
      <div className="mb-4 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setState((prev) => ({ ...prev, statusFilter: e.target.value, page: 1 }))}
            className="px-3 py-1.5 border border-gray-700 rounded-md text-sm bg-[#1c1f2e] text-gray-300 focus:outline-none focus:border-purple-500"
          >
            <option value="all">全部状态</option>
            <option value="generating">生成中</option>
            <option value="pending">待下载</option>
            <option value="downloading">下载中</option>
            <option value="done">已下载</option>
            <option value="failed">下载失败</option>
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setState((prev) => ({ ...prev, typeFilter: e.target.value, page: 1 }))}
            className="px-3 py-1.5 border border-gray-700 rounded-md text-sm bg-[#1c1f2e] text-gray-300 focus:outline-none focus:border-purple-500"
          >
            <option value="all">全部类型</option>
            <option value="video">视频</option>
            <option value="image">图片</option>
            <option value="audio">音频</option>
            <option value="enhancement">画质增强</option>
          </select>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="px-4 py-1.5 bg-purple-600 text-white rounded-md text-sm hover:bg-purple-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            刷新
          </button>

          <button
            onClick={handleDownloadAllPending}
            disabled={isLoading}
            className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            下载全部待下载
          </button>

          <button
            onClick={handleBatchDownload}
            disabled={selectedRowKeys.length === 0 || isLoading}
            className="px-4 py-1.5 bg-indigo-600 text-white rounded-md text-sm hover:bg-indigo-500 disabled:opacity-50 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            批量下载 ({selectedRowKeys.length})
          </button>
        </div>
      </div>

      {/* 任务列表表格 */}
      <div className="bg-[#1c1f2e] rounded-lg border border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">加载中...</div>
        ) : tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-400">暂无任务</div>
        ) : (
          <table className="w-full">
            <thead className="bg-[#0f111a] border-b border-gray-800">
              <tr>
                <th className="w-12 p-0 text-left">
                  <div
                    className="flex items-center justify-center h-full py-3 px-3 cursor-pointer"
                    onClick={toggleSelectAll}
                  >
                    <CheckIcon checked={selectedRowKeys.length === tasks.length && tasks.length > 0} indeterminate={selectedRowKeys.length > 0 && selectedRowKeys.length < tasks.length} />
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">任务 ID</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">项目</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">提示词</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase">创建时间</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {tasks.map((task, index) => {
                const k = rowKey(task);
                return (
                <tr
                  key={k}
                  className={`transition-colors select-none cursor-pointer ${selectedRowKeys.includes(k) ? 'bg-purple-500/5' : 'hover:bg-[#0f111a]/50'}`}
                  onMouseDown={(e) => { e.preventDefault(); handleRowMouseDown(index, k); }}
                  onMouseEnter={() => handleRowMouseEnter(index)}
                >
                  <td className="w-12 p-0">
                    <div className="flex items-center justify-center h-full min-h-[52px] px-3">
                      <CheckIcon checked={selectedRowKeys.includes(k)} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 font-mono">
                    {displayId(task)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    {task.project_name || '-'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300 max-w-xs truncate" title={task.prompt}>
                    {task.prompt.substring(0, 30)}{task.prompt.length > 30 ? '...' : ''}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-300">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      task.model_type === 'video'
                        ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                        : task.model_type === 'audio'
                        ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                        : task.model_type === 'enhancement'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    }`}>
                      {task.model_type === 'video'
                        ? (isHappyhorse(task)
                            ? `视频·HappyHorse${task.happyhorse_mode_label ? '·' + task.happyhorse_mode_label : ''}`
                            : '视频')
                        : task.model_type === 'audio' ? '音频'
                        : task.model_type === 'enhancement' ? '画质增强'
                        : '图片'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {(() => {
                      // 视频走后端 download_status；图片/音频已持久化到 downloaded_at，但乐观集合 optimisticDownloaded
                      // HappyHorse 行虽然 model_type='video'，但本质走 mark-downloaded 异步路径，与 video 不同，需要乐观更新
                      const overridden = (task.model_type !== 'video' || isHappyhorse(task)) && optimisticDownloaded.has(k)
                        ? 'done'
                        : task.effective_download_status;
                      return (
                        <span className={`px-2 py-0.5 rounded text-xs border ${
                          overridden === 'generating'
                            ? 'bg-gray-500/20 text-gray-300 border-gray-500/30'
                            : overridden === 'pending'
                            ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                            : overridden === 'downloading'
                            ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                            : overridden === 'done'
                            ? 'bg-green-500/20 text-green-400 border-green-500/30'
                            : 'bg-red-500/20 text-red-400 border-red-500/30'
                        }`}>
                          {overridden === 'generating' && '生成中'}
                          {overridden === 'pending' && '待下载'}
                          {overridden === 'downloading' && '下载中'}
                          {overridden === 'done' && '已下载'}
                          {overridden === 'failed' && '失败'}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">
                    {formatDateTime(task.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-2">
                      {/* 图片条目：预览 + 逐张下载 */}
                      {task.model_type === 'image' && task.image_urls && task.image_urls.length > 0 && (
                        <>
                          <button
                            onClick={() => handlePreview(task)}
                            className="p-1 text-purple-400 hover:bg-purple-500/10 rounded transition-colors"
                            title="预览图片"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          </button>
                          {task.image_urls.map((url, i) => (
                            <button key={i}
                              onClick={() => { void downloadImageUrl(url, `image_${task.id}_${i + 1}.png`); markPersistDownloaded(task); }}
                              className="p-1 text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
                              title={task.image_urls!.length > 1 ? `下载图片 ${i + 1}` : '下载图片'}>
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                              {task.image_urls!.length > 1 && <span className="text-[9px] ml-0.5">{i + 1}</span>}
                            </button>
                          ))}
                        </>
                      )}
                      {/* 有视频 URL 且非音频：预览 + 下载 */}
                      {task.video_url && task.model_type !== 'audio' && (
                        <>
                          <button
                            onClick={() => handlePreview(task)}
                            className="p-1 text-purple-400 hover:bg-purple-500/10 rounded transition-colors"
                            title="预览视频"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleBrowserDownload(task)}
                            className="p-1 text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
                            title="下载视频"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          </button>
                        </>
                      )}
                      {/* 音频条目：浏览器端转码下载 mp3 */}
                      {task.model_type === 'audio' && task.video_url && (
                        <button
                          onClick={() => void handleAudioMp3Download(task)}
                          disabled={!!audioConverting[task.id]}
                          className="p-1 text-pink-400 hover:bg-pink-500/10 rounded transition-colors disabled:opacity-50"
                          title={audioConverting[task.id] ? '转码中...' : '下载 MP3'}
                        >
                          {audioConverting[task.id] ? (
                            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          )}
                        </button>
                      )}
                      {/* 生成中：继续监听 */}
                      {task.effective_download_status === 'generating' && task.history_id && (
                        <button
                          onClick={() => handleWatchTask(task.id, task.history_id!, task.created_at)}
                          className="p-1 text-yellow-400 hover:bg-yellow-500/10 rounded transition-colors"
                          title="继续监听生成进度"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteTask(task)}
                        className="p-1 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        title="删除"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="mt-4 flex justify-between items-center">
          <div className="text-sm text-gray-400">
            共 {total} 条，第 {page} 页 / 共 {totalPages} 页
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setState((prev) => ({ ...prev, page: prev.page - 1 }))}
              disabled={page === 1}
              className="px-3 py-1 border border-gray-700 rounded text-sm text-gray-300 hover:bg-[#1c1f2e] disabled:opacity-50 transition-colors"
            >
              上一页
            </button>
            <button
              onClick={() => setState((prev) => ({ ...prev, page: prev.page + 1 }))}
              disabled={page >= totalPages}
              className="px-3 py-1 border border-gray-700 rounded text-sm text-gray-300 hover:bg-[#1c1f2e] disabled:opacity-50 transition-colors"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* 视频预览弹窗 */}
      {previewTask && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={handleClosePreview}
        >
          <div
            className="bg-[#1c1f2e] rounded-xl border border-gray-700 max-w-4xl w-full p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-300 truncate flex-1 mr-4">
                {previewTask.prompt || `任务 ${displayId(previewTask)}`}
              </div>
              <button
                onClick={handleClosePreview}
                className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {previewTask.model_type === 'image' && previewTask.image_urls && previewTask.image_urls.length > 0 ? (
              <div className={`grid gap-2 ${previewTask.image_urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {previewTask.image_urls.map((url, i) => (
                  <img key={i} src={url} alt={`图片 ${i + 1}`} className="w-full rounded-lg max-h-[70vh] object-contain bg-black" />
                ))}
              </div>
            ) : previewTask.video_url ? (
              <video
                src={previewTask.video_url}
                controls
                autoPlay
                className="w-full rounded-lg max-h-[70vh] bg-black"
              />
            ) : previewTask.video_path || previewTask.download_path ? (
              <video
                src={`/api/download/tasks/${previewTask.id}/preview`}
                controls
                autoPlay
                className="w-full rounded-lg max-h-[70vh] bg-black"
              />
            ) : (
              <div className="text-center text-gray-400 py-12">暂无可预览的内容</div>
            )}
            <div className="flex justify-end mt-3 gap-2">
              {previewTask.model_type === 'image' && previewTask.image_urls?.map((url, i) => (
                <button key={i}
                  onClick={() => { void downloadImageUrl(url, `image_${previewTask.id}_${i + 1}.png`); markPersistDownloaded(previewTask); }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-500 transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {previewTask.image_urls!.length > 1 ? `下载图片${i + 1}` : '下载图片'}
                </button>
              ))}
              {previewTask.model_type !== 'image' && (
                <button
                  onClick={() => handleBrowserDownload(previewTask)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-500 transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  下载视频
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
