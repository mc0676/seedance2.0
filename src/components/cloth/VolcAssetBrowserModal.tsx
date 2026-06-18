// 火山资产浏览弹窗 — 复刻 infinite-canvas AssetPickerModal 卡片样式 + 按 file_type 分类 tab
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Image, Film, Music, File, ChevronLeft, ExternalLink, Search } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';

interface VolcAssetBrowserModalProps {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  theme?: {
    bg: string; panel: string; panelBorder: string; nodeFill: string;
    nodeText: string; nodeMuted: string; nodeFaint: string;
  };
}

interface VolcGroup {
  Id: string; Name: string; Description?: string; thumbnail_oss_url?: string;
}
interface VolcAsset {
  Id: string; Name?: string; AssetType?: string; URL?: string; ThumbnailURL?: string; CreateTime?: string;
}

const TYPE_TABS = [
  { label: '全部', value: '' },
  { label: '图片', value: 'Image' },
  { label: '视频', value: 'Video' },
  { label: '音频', value: 'Audio' },
] as const;

const TYPE_LABEL: Record<string, string> = { Image: '图片', Video: '视频', Audio: '音频' };

function AssetTypeIcon({ type, className }: { type?: string; className?: string }) {
  const at = (type || '').toLowerCase();
  if (at.includes('image')) return <Image className={className} />;
  if (at.includes('video')) return <Film className={className} />;
  if (at.includes('audio')) return <Music className={className} />;
  return <File className={className} />;
}

/* ══════ 素材卡片 — 复刻 infinite-canvas PickerCard ══════ */
function AssetCard({ asset, theme: t, onCopy, copied, onInsert }: {
  asset: VolcAsset; theme: VolcAssetBrowserModalProps['theme']; onCopy: (url: string, id: string) => void; copied: string | null; onInsert?: (asset: VolcAsset) => void;
}) {
  const isCopied = copied === asset.Id;
  return (
    <div
      className="group relative cursor-pointer overflow-hidden rounded-lg border text-left transition hover:shadow-md"
      style={{ borderColor: t?.panelBorder || '#44403c', background: t?.nodeFill || '#292524' }}
      onClick={() => onInsert?.(asset)}
    >
      {/* 封面 — 复刻原项目 aspect-[4/3] */}
      {asset.URL || asset.ThumbnailURL ? (
        <img src={asset.ThumbnailURL || asset.URL} alt={asset.Name || ''} className="aspect-[4/3] w-full object-cover bg-black/40" />
      ) : (
        <div className="flex aspect-[4/3] w-full items-center justify-center" style={{ background: 'rgba(120,113,108,.15)' }}>
          <AssetTypeIcon type={asset.AssetType} className="size-8 opacity-30" />
        </div>
      )}

      {/* 底部信息栏 — 复刻原项目 p-2.5 + flex justify-between */}
      <div className="p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium" style={{ color: t?.nodeText || '#f5f5f4' }}>
            {asset.Name || asset.Id.slice(0, 8)}
          </span>
          {/* 类型标签 — 复刻原项目 Tag */}
          <span className="m-0 shrink-0 rounded border px-1.5 py-px text-[10px]" style={{ borderColor: 'rgba(120,113,108,.4)', color: t?.nodeMuted || '#d6d3d1' }}>
            {TYPE_LABEL[asset.AssetType || ''] || asset.AssetType || '未知'}
          </span>
        </div>
      </div>

      {/* 悬停覆盖层 — 复刻原项目 "插入" 遮罩 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">
        插入
      </div>

      {/* 复制按钮 — 右上角悬停显示 */}
      {asset.URL ? (
        <button
          className="absolute top-2 right-2 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: 'rgba(0,0,0,.45)' }}
          title="复制链接"
          onClick={(e) => { e.stopPropagation(); onCopy(asset.URL!, asset.Id); }}
        >
          {isCopied ? (
            <span className="text-[10px] text-green-400 px-0.5">已复制</span>
          ) : (
            <ExternalLink className="size-3.5 text-white/80" />
          )}
        </button>
      ) : null}
    </div>
  );
}

/* ══════ 主组件 ══════ */
export function VolcAssetBrowserModal({ open, projectId, onClose, theme }: VolcAssetBrowserModalProps) {
  const t = theme || {
    bg: '#181715', panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c',
    nodeFill: '#292524', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c',
  };

  const [groups, setGroups] = useState<VolcGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<VolcGroup | null>(null);
  const [assets, setAssets] = useState<VolcAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchGroups = useCallback(async () => {
    if (!open || !projectId) return;
    setGroupsLoading(true);
    try {
      const params = new URLSearchParams({ projectId: String(projectId), pageSize: '50' });
      const res = await fetch(`/api/volc-native/asset-groups?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.data?.Items) setGroups(data.data.Items);
    } catch { /* ignore */ }
    setGroupsLoading(false);
  }, [open, projectId]);

  const fetchAssets = useCallback(async (groupId: string) => {
    setAssetsLoading(true);
    try {
      const params = new URLSearchParams({ groupId, pageSize: '200' });
      const res = await fetch(`/api/volc-native/assets?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success && data.data?.Items) setAssets(data.data.Items);
    } catch { /* ignore */ }
    setAssetsLoading(false);
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  // 按类型 + 关键词筛选
  const filteredAssets = useMemo(() => {
    let list = assets;
    if (typeFilter) list = list.filter((a) => a.AssetType === typeFilter);
    if (keyword.trim()) {
      const q = keyword.trim().toLowerCase();
      list = list.filter((a) => (a.Name || '').toLowerCase().includes(q));
    }
    return list;
  }, [assets, typeFilter, keyword]);

  const copyUrl = (url: string, id: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleInsert = (asset: VolcAsset) => {
    if (asset.URL) copyUrl(asset.URL, asset.Id);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,.55)' }} />
      <div
        className="relative z-10 flex max-h-[85vh] w-[960px] max-w-[95vw] flex-col rounded-3xl border shadow-2xl"
        style={{ background: t.bg, borderColor: t.panelBorder, color: t.nodeText }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: t.panelBorder }}>
          <div className="flex items-center gap-3">
            {selectedGroup ? (
              <button onClick={() => { setSelectedGroup(null); setAssets([]); setTypeFilter(''); setKeyword(''); }}
                className="opacity-50 hover:opacity-80 transition-opacity">
                <ChevronLeft className="size-5" />
              </button>
            ) : null}
            <h2 className="text-base font-semibold">{selectedGroup ? selectedGroup.Name : '火山资产库'}</h2>
          </div>
          <button onClick={onClose} className="text-lg leading-none opacity-50 hover:opacity-80">&times;</button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedGroup ? (
            /* ══════ 素材组列表 ══════ */
            groupsLoading ? (
              <div className="flex justify-center py-16" style={{ color: t.nodeMuted }}>
                <div className="size-6 animate-spin rounded-full border-2 border-transparent" style={{ borderTopColor: t.nodeMuted }} />
              </div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16" style={{ color: t.nodeMuted }}>
                <Box className="size-10 opacity-30" />
                <span className="text-sm">暂无绑定素材组</span>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {groups.map((g) => (
                  <button key={g.Id}
                    className="flex flex-col gap-2 rounded-xl border p-3 text-left transition hover:opacity-80"
                    style={{ background: t.nodeFill, borderColor: t.panelBorder }}
                    onClick={() => { setSelectedGroup(g); fetchAssets(g.Id); }}>
                    {g.thumbnail_oss_url ? (
                      <img src={g.thumbnail_oss_url} alt={g.Name} className="aspect-square w-full rounded-lg object-cover bg-black/40" />
                    ) : (
                      <div className="aspect-square w-full rounded-lg flex items-center justify-center" style={{ background: t.nodeMuted + '20' }}>
                        <Box className="size-8 opacity-30" style={{ color: t.nodeMuted }} />
                      </div>
                    )}
                    <div className="text-[12px] leading-tight truncate font-medium" style={{ color: t.nodeText }}>{g.Name}</div>
                    {g.Description ? (
                      <div className="text-[10px] leading-tight truncate" style={{ color: t.nodeFaint }}>{g.Description}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            )
          ) : (
            /* ══════ 素材列表（含分类 tab） ══════ */
            <>
              {/* 筛选栏 — 复刻原项目 Tag.CheckableTag */}
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" style={{ color: t.nodeFaint }} />
                  <input
                    className="w-48 rounded-lg border py-1.5 pr-3 pl-8 text-xs outline-none transition"
                    style={{ background: t.nodeFill, borderColor: t.panelBorder, color: t.nodeText }}
                    placeholder="搜索素材"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                  />
                </div>
                <div className="flex gap-1.5">
                  {TYPE_TABS.map((opt) => (
                    <button
                      key={opt.value || 'all'}
                      className={`rounded border px-2.5 py-1 text-xs transition ${
                        typeFilter === opt.value
                          ? 'border-[#a78bfa] bg-[#a78bfa]/15 text-[#c4b5fd]'
                          : ''
                      }`}
                      style={typeFilter !== opt.value ? { borderColor: t.panelBorder, color: t.nodeMuted } : undefined}
                      onClick={() => setTypeFilter(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 素材卡片网格 */}
              {assetsLoading ? (
                <div className="flex justify-center py-16" style={{ color: t.nodeMuted }}>
                  <div className="size-6 animate-spin rounded-full border-2 border-transparent" style={{ borderTopColor: t.nodeMuted }} />
                </div>
              ) : filteredAssets.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16" style={{ color: t.nodeMuted }}>
                  <Box className="size-10 opacity-30" />
                  <span className="text-sm">{keyword || typeFilter ? '无匹配素材' : '素材组为空'}</span>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-3">
                  {filteredAssets.map((a) => (
                    <AssetCard key={a.Id} asset={a} theme={t} onCopy={copyUrl} copied={copiedId} onInsert={handleInsert} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
