// 火山资产浏览弹窗 — 项目素材扁平列表，按 file_type 分类
import { useState, useEffect, useMemo } from 'react';
import { Search, Image, Film, Music, File } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';

interface ProjectAsset {
  id: number;
  name: string;
  volc_asset_id: string;
  file_type: string;
  file_url: string;
  thumbnail_url: string;
  group_name: string;
  review_status: string;
  volc_name: string;
  created_at: string;
}

interface Props {
  open: boolean;
  projectId: number | null;
  onClose: () => void;
  onSelect: (asset: ProjectAsset) => void;
  mode?: 'insert' | 'use';
}

const TYPE_TABS = [
  { label: '全部', value: '' },
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: '音频', value: 'audio' },
] as const;

const TYPE_ICON: Record<string, typeof Image> = {
  image: Image,
  video: Film,
  audio: Music,
};

function AssetTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = TYPE_ICON[type] || File;
  return <Icon className={className} />;
}

const REVIEW_LABELS: Record<string, string> = {
  pending: '待审核', approved: '已通过', rejected: '已拒绝',
};

const TYPE_LABELS: Record<string, string> = {
  image: '图片', video: '视频', audio: '音频',
};

function AssetCard({ asset, onInsert, mode }: { asset: ProjectAsset; onInsert: (a: ProjectAsset) => void; mode: 'insert' | 'use' }) {
  const hasThumb = !!(asset.thumbnail_url);
  const [imgFailed, setImgFailed] = useState(false);
  const typeLabel = TYPE_LABELS[asset.file_type] || asset.file_type;
  const statusLabel = REVIEW_LABELS[asset.review_status] || asset.review_status;

  const showFallback = !hasThumb || imgFailed;

  return (
    <div className="asset-card overflow-hidden rounded-lg flex flex-col"
      style={{ border: '1px solid transparent', background: '#141414' }}>
      {/* 封面 — object-contain 黑边显示全貌，加载失败占位统一高度 */}
      <button type="button" className="block w-full text-left" onClick={() => onInsert(asset)}>
        <div className="relative aspect-[4/3] w-full bg-black">
          {showFallback ? (
            <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(120,113,108,.15)' }}>
              <AssetTypeIcon type={asset.file_type} className="size-8 opacity-30" />
            </div>
          ) : (
            <img src={asset.thumbnail_url} alt={asset.name}
              className="absolute inset-0 w-full h-full object-contain" loading="lazy"
              onError={() => setImgFailed(true)} />
          )}
        </div>
      </button>

      {/* 内容区 — 复刻 ant-card-body p-4 */}
      <button type="button" className="block w-full text-left flex-1" onClick={() => onInsert(asset)}>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="line-clamp-1 text-sm font-semibold text-stone-100">{asset.name}</h2>
            <span className="shrink-0 text-xs text-stone-500">{statusLabel}</span>
          </div>
          <p className="mt-2 text-xs leading-5 truncate text-stone-400">
            {asset.volc_asset_id || '—'}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="inline-block h-5 px-[7px] text-[11px] leading-5 rounded"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.65)' }}>
              {typeLabel}
            </span>
            {asset.volc_name && (
              <span className="inline-block h-5 px-[7px] text-[11px] leading-5 rounded"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.65)' }}>
                {asset.volc_name}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* 操作按钮 — 复刻 ant-btn-primary ant-btn-sm ant-btn-block */}
      <div className="flex items-center gap-2 px-4 pb-4">
        <button type="button" onClick={() => onInsert(asset)}
          className="flex w-full items-center justify-center gap-1.5 h-6 rounded-md text-sm"
          style={{ background: '#d8d8d8', color: '#171717' }}>
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
          <span>{mode === 'insert' ? '插入' : '使用'}</span>
        </button>
      </div>
    </div>
  );
}

export function PromptLibraryModal({ open, projectId, onClose, onSelect, mode = 'insert' }: Props) {
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [selType, setSelType] = useState('');
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) { setVisible(true); requestAnimationFrame(() => setAnimating(true)); }
    else { setAnimating(false); const t = setTimeout(() => setVisible(false), 200); return () => clearTimeout(t); }
  }, [open]);

  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    fetch(`/api/project-assets?projectId=${projectId}`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(d => { if (d.success) setAssets(d.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, projectId]);

  useEffect(() => {
    if (!open) { const t = setTimeout(() => { setKeyword(''); setSelType(''); }, 200); return () => clearTimeout(t); }
  }, [open]);

  const availableTypes = useMemo(() => {
    const set = new Set(assets.map(a => a.file_type));
    return TYPE_TABS.filter(t => t.value === '' || set.has(t.value));
  }, [assets]);

  const filtered = useMemo(() => assets.filter(a => {
    const matchType = !selType || a.file_type === selType;
    const matchKw = !keyword || a.name.toLowerCase().includes(keyword.toLowerCase());
    return matchType && matchKw;
  }), [assets, keyword, selType]);

  const handleSelect = (asset: ProjectAsset) => {
    onSelect(asset);
    onClose();
  };

  if (!visible) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)', opacity: animating ? 1 : 0, transition: 'opacity 200ms ease' }} />
      <div style={{
        position: 'relative', width: 1040, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 80px)',
        margin: '0 24px', borderRadius: 8, background: '#1f1f1f', color: 'rgba(255,255,255,0.85)',
        boxShadow: '0 6px 16px 0 rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        transform: animating ? 'scale(1)' : 'scale(0.95)', opacity: animating ? 1 : 0,
        transition: 'transform 200ms cubic-bezier(0.23,1,0.32,1), opacity 200ms ease',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>火山资产</span>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.45)', cursor: 'pointer', padding: 4, borderRadius: 4 }}>
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 0 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z"/></svg>
          </button>
        </div>
        <div style={{ padding: '0 24px 20px', overflow: 'auto', flex: 1 }}>
          <div style={{ maxWidth: 672, margin: '16px auto 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 11px', borderRadius: 6, border: '1px solid #424242', background: '#141414' }}>
              <Search className="size-4" style={{ color: 'rgba(255,255,255,0.25)', flexShrink: 0 }} />
              <input placeholder="按名称搜索" value={keyword} onChange={e => setKeyword(e.target.value)}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'rgba(255,255,255,0.85)', fontSize: 16, lineHeight: '24px', padding: '4px 0' }} />
            </div>
          </div>
          <div style={{ marginTop: 20, display: 'grid', gap: 8, gridTemplateColumns: '56px minmax(0,1fr)', alignItems: 'start' }}>
            <div style={{ paddingTop: 8, fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.45)' }}>分类</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {availableTypes.map(tab => {
                const active = selType === tab.value;
                return (
                  <button key={tab.value} type="button" onClick={() => setSelType(tab.value)}
                    style={{
                      margin: 0, border: active ? '1px solid rgba(255,255,255,0.88)' : '1px solid transparent',
                      borderRadius: 6, padding: '5px 10px', fontSize: 14, lineHeight: 1,
                      fontWeight: active ? 700 : 400,
                      background: active ? 'rgba(250,250,249,0.96)' : 'transparent',
                      color: active ? '#0c0a09' : '#e7e5e4',
                      boxShadow: active ? '0 0 0 1px rgba(255,255,255,0.18), 0 6px 18px rgba(0,0,0,0.22)' : 'none',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease',
                    }}
                    onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#ffffff'; } }}
                    onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#e7e5e4'; } }}
                  >{tab.label}</button>
                );
              })}
            </div>
          </div>
          <div className="thin-scrollbar" style={{ marginTop: 24, maxHeight: 520, overflowY: 'auto', paddingRight: 8 }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,0.25)' }}>加载中...</div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,0.25)' }}>暂无素材</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 20 }}>
                {filtered.map(asset => (
                  <AssetCard key={asset.id} asset={asset} onInsert={handleSelect} mode={mode} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
