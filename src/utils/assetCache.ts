/**
 * localStorage 缓存工具
 * 缓存项目素材组+素材列表，刷新/切页不丢失
 * 键格式: cache:{type}:{projectId}
 * TTL: 5min（平衡新鲜度与持久性）
 */

const TTL_MS = 300_000;

interface CacheEntry<T> {
  data: T;
  ts: number;
}

function getCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.ts > TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function setCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota exceeded, silently skip */ }
}

export function getCachedAssetGroups(projectId: number) {
  return getCache<any[]>(`cache:assetGroups:${projectId}`);
}

export function setCachedAssetGroups(projectId: number, data: any[]) {
  setCache(`cache:assetGroups:${projectId}`, data);
}

export function getCachedProjectAssets(projectId: number) {
  return getCache<any[]>(`cache:projectAssets:${projectId}`);
}

export function setCachedProjectAssets(projectId: number, data: any[]) {
  setCache(`cache:projectAssets:${projectId}`, data);
}

/** 清理指定项目的缓存 */
export function invalidateProjectCache(projectId: number) {
  try {
    localStorage.removeItem(`cache:assetGroups:${projectId}`);
    localStorage.removeItem(`cache:projectAssets:${projectId}`);
  } catch {}
}
