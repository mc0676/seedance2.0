import { useEffect, useCallback, useState } from 'react';
import { getAuthHeaders } from '../services/authService';

// ── 下载管理器（模块级单例，页面切换不中断） ──

/** 从火山 OSS URL 中解析 X-Tos-Date + X-Tos-Expires，判断是否已过期 */
function isOssUrlExpired(url: string): boolean {
  try {
    const u = new URL(url);
    const dateStr = u.searchParams.get('X-Tos-Date');
    const expiresStr = u.searchParams.get('X-Tos-Expires');
    if (!dateStr || !expiresStr) return false;
    const m = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return false;
    const issued = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const expiresMs = +expiresStr * 1000;
    if (isNaN(issued) || isNaN(expiresMs)) return false;
    return Date.now() > issued + expiresMs;
  } catch {
    return false;
  }
}

export type DownloadState = 'pending' | 'downloading' | 'done' | 'failed' | 'failed_from_expired';

interface DownloadEntry {
  table: string;
  id: number;
  url: string;
  filename: string;
  status: DownloadState;
}

const activeDownloads = new Map<string, DownloadEntry>();

function downloadKey(table: string, id: number) {
  return `${table}:${id}`;
}

async function updateServerStatus(table: string, id: number, status: string) {
  try {
    await fetch('/api/download-status', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ table, id, status }),
    });
  } catch {}
}

/** 获取后端代理下载 URL（绕过 CORS），失败返回空字符串 */
async function getProxyUrl(videoUrl: string, filename: string): Promise<string> {
  try {
    const resp = await fetch('/api/download/video-proxy-token', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ videoUrl, filename }),
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    return data?.data?.token
      ? `/api/download/video-by-token?token=${encodeURIComponent(data.data.token)}`
      : '';
  } catch {
    return '';
  }
}

async function doDownload(entry: DownloadEntry) {
  const key = downloadKey(entry.table, entry.id);
  const t0 = Date.now();
  entry.status = 'downloading';
  refreshListeners.get(key)?.();
  updateServerStatus(entry.table, entry.id, 'downloading');

  // 跨域 URL（火山 OSS 等）通过后端代理下载，绕过 CORS
  const isCrossOrigin = (() => {
    try { return new URL(entry.url).origin !== location.origin; } catch { return false; }
  })();

  const fetchUrl = isCrossOrigin
    ? await getProxyUrl(entry.url, entry.filename)
    : entry.url;

  if (!fetchUrl) {
    entry.status = isOssUrlExpired(entry.url) ? 'failed_from_expired' : 'failed';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, entry.status);
    return;
  }

  try {
    const resp = await fetch(fetchUrl);
    if (!resp.ok) {
      const status = resp.status;
      throw new Error(status === 403 || status === 404 ? 'EXPIRED' : `HTTP ${status}`);
    }
    const blob = await resp.blob();
    const elapsed = Date.now() - t0;
    if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = entry.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    entry.status = 'done';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, 'done');
  } catch (e: any) {
    const isExpired = e.message === 'EXPIRED' || e.message?.includes('403') || e.message?.includes('404') || isOssUrlExpired(entry.url);
    const elapsed = Date.now() - t0;
    if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
    entry.status = isExpired ? 'failed_from_expired' : 'failed';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, entry.status);
  } finally {
    refreshListeners.get(key)?.();
  }
}

export function startDownload(table: string, id: number, url: string, filename: string, customDownload?: () => Promise<void>): DownloadState {
  const key = downloadKey(table, id);
  const existing = activeDownloads.get(key);
  if (existing && existing.status === 'downloading') return existing.status;
  const entry: DownloadEntry = { table, id, url, filename, status: 'downloading' };
  activeDownloads.set(key, entry);
  if (customDownload) {
    doCustomDownload(entry, customDownload);
  } else {
    doDownload(entry);
  }
  return 'downloading';
}

async function doCustomDownload(entry: DownloadEntry, fn: () => Promise<void>) {
  const key = downloadKey(entry.table, entry.id);
  const t0 = Date.now();
  try {
    entry.status = 'downloading';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, 'downloading');
    await fn();
    const elapsed = Date.now() - t0;
    if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
    entry.status = 'done';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, 'done');
  } catch (e: any) {
    const isExpired = e?.isExpired || isOssUrlExpired(entry.url);
    const elapsed = Date.now() - t0;
    if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
    entry.status = isExpired ? 'failed_from_expired' : 'failed';
    refreshListeners.get(key)?.();
    updateServerStatus(entry.table, entry.id, entry.status);
  } finally {
    refreshListeners.get(key)?.();
  }
}

// ── 组件 ──

interface DownloadButtonProps {
  table: string;
  id: number;
  url: string | null;
  filename: string;
  generationStatus: string;
  downloadStatus: DownloadState;
  small?: boolean;
  onDownload?: () => Promise<void>;
  onStatusChange?: (s: DownloadState) => void;
}

type RefreshFn = () => void;
const refreshListeners = new Map<string, RefreshFn>();

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  error: { label: '无法下载', cls: 'text-gray-500 border-gray-700 cursor-not-allowed' },
  pending: { label: '下载', cls: 'text-gray-300 border-gray-700 hover:text-white hover:border-gray-500' },
  downloading: { label: '下载中', cls: 'text-blue-400 border-blue-500/40 bg-blue-500/10' },
  done: { label: '已下载', cls: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' },
  failed: { label: '重试', cls: 'text-red-400 border-red-500/40 hover:bg-red-500/10' },
  failed_from_expired: { label: '资源过期', cls: 'text-amber-400 border-amber-500/40 hover:bg-amber-500/10' },
};

export default function DownloadButton({ table, id, url, filename, generationStatus, downloadStatus, small, onDownload, onStatusChange }: DownloadButtonProps) {
  const key = downloadKey(table, id);
  const [, forceRender] = useState(0);
  const activeState = activeDownloads.get(key)?.status;
  const displayStatus = activeState || downloadStatus;

  useEffect(() => {
    refreshListeners.set(key, () => forceRender(n => n + 1));
    return () => {
      refreshListeners.delete(key);
      const e = activeDownloads.get(key);
      if (e && e.status !== 'downloading') activeDownloads.delete(key);
    };
  }, [key]);

  const handleClick = useCallback(() => {
    if (displayStatus === 'downloading') return;
    if (displayStatus === 'done') {
      if (!confirm('该任务已下载，是否重新下载？')) return;
    }
    if (!url) return;
    const newStatus = startDownload(table, id, url, filename, onDownload);
    onStatusChange?.(newStatus);
  }, [table, id, url, filename, displayStatus, onDownload, onStatusChange]);

  useEffect(() => {
    if (downloadStatus === 'downloading' && (url || onDownload) && !activeDownloads.has(key)) {
      startDownload(table, id, url || '', filename, onDownload);
      onStatusChange?.('downloading');
    }
  }, [downloadStatus, url]);

  if (generationStatus === 'error') {
    const cfg = STATUS_CONFIG.error;
    const sizeCls = small ? 'text-[10px] px-1.5 py-0.5 rounded' : 'text-[11px] px-2 py-1 rounded-xl';
    return (
      <button disabled className={`${sizeCls} border ${cfg.cls}`} title="因为生成失败，无法下载">
        {cfg.label}
      </button>
    );
  }

  const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG.pending;
  const sizeCls = small ? 'text-[10px] px-1.5 py-0.5 rounded' : 'text-[11px] px-2 py-1 rounded-xl';

  return (
    <button
      onClick={handleClick}
      disabled={displayStatus === 'downloading'}
      className={`${sizeCls} border transition-all ${cfg.cls}`}
    >
      {displayStatus === 'downloading' && (
        <span className="animate-spin h-3 w-3 border-2 border-blue-400 border-t-transparent rounded-full inline-block align-middle mr-1" />
      )}
      {cfg.label}
    </button>
  );
}
