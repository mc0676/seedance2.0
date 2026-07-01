/**
 * 统一素材网格组件
 * 外观: grid 4列, 2行可见, 垂直滚动, aspect-square卡片
 * 底部标签: 组名样式(琥珀色)，字体加大
 * img: loading="lazy" decoding="async" object-contain
 */

export interface GridAsset {
  id: string | number;
  name: string;
  thumbnail_url?: string | null;
  file_url?: string | null;
  file_type?: string;
  volc_asset_id?: string;
  review_status?: string;
  asset_group_id?: number | null;
  group_name?: string | null;
}

interface AssetGridProps {
  assets: GridAsset[];
  groupNames?: Map<number, string>;
  onSelect: (asset: GridAsset) => void;
  selectedUrl?: string | null;
  showPendingOverlay?: boolean;
}

export default function AssetGrid({
  assets,
  groupNames,
  onSelect,
  selectedUrl,
  showPendingOverlay = true,
}: AssetGridProps) {
  return (
    <div className="max-h-[20rem] overflow-y-auto custom-scrollbar">
      <div className="grid grid-cols-4 gap-2">
        {assets.map((asset) => {
          const isSelected = selectedUrl && asset.file_url && selectedUrl === asset.file_url;
          const isPending = asset.review_status === 'pending';
          const isRejected = asset.review_status === 'rejected';
          const gid = asset.asset_group_id;
          const gname = (gid != null && groupNames) ? groupNames.get(gid) : null;
          const label = gname || asset.name;

          return (
            <button
              key={asset.id}
              disabled={isRejected}
              onClick={() => {
                if (!isRejected && !isPending) onSelect(asset);
              }}
              title={isRejected ? '未过审' : isPending ? '审核中' : label}
              className={`relative aspect-square w-full rounded-xl overflow-hidden border-2 transition-all ${
                isRejected ? 'cursor-not-allowed opacity-60 bg-red-500/10 border-red-500/40' :
                isPending ? 'bg-amber-500/10 border-amber-500/40' :
                isSelected ? 'border-purple-400 shadow-lg shadow-purple-500/20' :
                'border-gray-700 hover:border-gray-500 hover:scale-105'
              }`}
            >
              {asset.file_type === 'audio' ? (
                <div className="w-full h-full flex items-center justify-center text-4xl bg-[#0d0f1a] text-gray-500">🎵</div>
              ) : asset.file_type === 'video' ? (
                asset.thumbnail_url || asset.file_url ? (
                  <img src={asset.thumbnail_url || asset.file_url!} alt={asset.name} loading="lazy" decoding="async"
                    className="w-full h-full object-contain bg-[#0d0f1a]"
                    onError={(e) => {
                      // 缩略图加载失败时替换为视频图标
                      const img = e.currentTarget;
                      const parent = img.parentElement;
                      if (parent) {
                        img.style.display = 'none';
                        const fallback = document.createElement('div');
                        fallback.className = 'w-full h-full flex items-center justify-center text-4xl bg-[#0d0f1a] text-gray-500';
                        fallback.textContent = '🎬';
                        parent.appendChild(fallback);
                      }
                    }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-4xl bg-[#0d0f1a] text-gray-500">🎬</div>
                )
              ) : asset.thumbnail_url || asset.file_url ? (
                <img
                  src={asset.thumbnail_url || asset.file_url!}
                  alt={asset.name}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-contain bg-[#0d0f1a]"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xl bg-[#0d0f1a] text-gray-600">
                  {asset.file_type === 'video' ? '🎬' : asset.file_type === 'audio' ? '🎵' : '🖼️'}
                </div>
              )}

              {isSelected && !isRejected && !isPending && (
                <span className="absolute top-0 right-0 text-[7px] font-bold px-0.5 py-px leading-none border-b border-l rounded-bl-lg bg-purple-500 text-white border-purple-500/40">✓</span>
              )}
              {isRejected && (
                <span className="absolute top-0 right-0 text-[7px] font-bold px-0.5 py-px leading-none border-b border-l rounded-bl-lg bg-red-500 text-white border-red-500/40">✕</span>
              )}
              {showPendingOverlay && isPending && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <span className="text-xs text-amber-300 font-bold">审核中</span>
                </div>
              )}
              {/* 组名标签（琥珀色样式，字体加大） */}
              <div className="absolute bottom-0 left-0 right-0 bg-amber-500/80 text-white text-[10px] text-center py-0.5 font-bold truncate px-1">
                {isRejected ? '未过审' : isPending ? '审核中' : label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
