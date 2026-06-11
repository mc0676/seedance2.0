import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import type {
  AspectRatio,
  Duration,
  ModelId,
  UploadedFile,
  GenerationState,
  DownloadTask,
} from '../types/index';
import { RATIO_OPTIONS, DURATION_OPTIONS, MODEL_OPTIONS } from '../types/index';
import { generateVideo } from '../services/videoService';
import { getAuthHeaders } from '../services/authService';
import { uploadToOss, FILE_LIMITS, validateMediaCombination } from '../services/ossService';
import { estimatePricing, getCreditBalance, listEnabledModels, type RuntimeModelOption } from '../services/pricingService';
import { getDownloadTasks, makeDownloadFilename } from '../services/downloadService';
import { getVolcKeyStatus } from '../services/settingsService';
import { GearIcon, PlusIcon, CloseIcon, SparkleIcon } from '../components/Icons';
import DownloadButton from '../components/DownloadButton';
import Layout from '../components/Layout';
import AssetGrid, { type GridAsset } from '../components/AssetGrid';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { getProjectAssets } from '../services/projectService';
import { listProjectAssetGroups } from '../services/assetService';
import type { ProjectAsset, AssetGroupInfo } from '../types/index';
import { formatShortDateTime, useUserTimezone } from '../utils/datetime';
import { invalidateProjectCache } from '../utils/assetCache';

function ImageWithFallback({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-center text-xs flex-shrink-0" title="图片已失效">⚠️</div>;
  }
  return <img src={src} className="w-8 h-8 rounded-lg object-cover border border-gray-700 flex-shrink-0" onError={() => setFailed(true)} />;
}

interface AssetSelection {
  id: string;
  volcAssetId: string;
  fileType: 'image' | 'video' | 'audio';
  name: string;
  thumbnailUrl?: string;
  assetUri: string;
  chipTag: string;
}

let nextId = 0;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 类型角标配置
const TYPE_BADGE: Record<'image' | 'video' | 'audio', { label: string; cls: string }> = {
  image: { label: '图', cls: 'bg-purple-600/90 text-white' },
  video: { label: '视', cls: 'bg-blue-600/90 text-white' },
  audio: { label: '音', cls: 'bg-green-600/90 text-white' },
};

interface FileThumbProps {
  f: UploadedFile;
  onRemove: (id: string) => void;
  label?: string; // e.g. "首1"
}

function FileThumb({ f, onRemove, label }: FileThumbProps) {
  const badge = TYPE_BADGE[f.mediaType];
  return (
    <div className="relative group flex flex-col items-center gap-1">
      <div className="w-20 h-20 flex-shrink-0 relative rounded-xl border border-gray-700 bg-[#0d0f1a] overflow-hidden flex items-center justify-center">
        {f.mediaType === 'image' && f.previewUrl ? (
          <img src={f.previewUrl} alt={f.name} className="w-full h-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1 px-1 w-full">
            <span className="text-2xl">{f.mediaType === 'video' ? '🎬' : '🎵'}</span>
            <div className="text-[9px] text-gray-400 truncate w-full text-center px-1">{f.name}</div>
            <div className="text-[9px] text-gray-600">{formatBytes(f.size)}</div>
          </div>
        )}
        {/* 类型角标 */}
        <span className={`absolute top-0 left-0 text-[9px] font-bold px-1 py-0.5 rounded-tl-xl rounded-br-lg leading-none ${badge.cls}`}>{badge.label}</span>
        {/* 上传进度遮罩 */}
        {f.uploadProgress !== undefined && f.uploadProgress < 100 && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <span className="text-white text-xs font-bold">{f.uploadProgress}%</span>
          </div>
        )}
        {/* 上传完成角标 */}
        {f.ossUrl && (
          <span className="absolute bottom-0 right-0 bg-green-600/80 text-[9px] text-white px-1 py-0.5 rounded-tl-lg leading-none">✓</span>
        )}
        {/* 进度条（视频/音频） */}
        {f.mediaType !== 'image' && f.uploadProgress !== undefined && f.uploadProgress < 100 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-700">
            <div className="h-full bg-purple-500 transition-all" style={{ width: `${f.uploadProgress}%` }} />
          </div>
        )}
      </div>
      {label && <span className="text-[10px] text-purple-300 font-medium">{label}</span>}
      <button
        onClick={() => onRemove(f.id)}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600 z-10"
      >
        <CloseIcon className="w-3 h-3 text-white" />
      </button>
    </div>
  );
}

interface UnifiedUploadZoneProps {
  images: UploadedFile[];
  videos: UploadedFile[];
  audios: UploadedFile[];
  onAdd: (files: FileList, mediaType: 'image' | 'video' | 'audio') => void;
  onRemove: (id: string, mediaType: 'image' | 'video' | 'audio') => void;
  uploading: boolean;
}

function UnifiedUploadZone({ images, videos, audios, onAdd, onRemove, uploading }: UnifiedUploadZoneProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const imgLimits = FILE_LIMITS['image'];
  const vidLimits = FILE_LIMITS['video'];
  const audLimits = FILE_LIMITS['audio'];

  const allFiles: (UploadedFile & { mediaType: 'image' | 'video' | 'audio' })[] = [
    ...images.map((f) => ({ ...f, mediaType: 'image' as const })),
    ...videos.map((f) => ({ ...f, mediaType: 'video' as const })),
    ...audios.map((f) => ({ ...f, mediaType: 'audio' as const })),
  ];

  const hasAny = allFiles.length > 0;
  const canAdd = images.length < imgLimits.maxCount || videos.length < vidLimits.maxCount || audios.length < audLimits.maxCount;

  function guessMediaType(file: File): 'image' | 'video' | 'audio' {
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('audio/')) return 'audio';
    return 'image';
  }

  function dispatchFiles(fileList: FileList) {
    const grouped: Record<'image' | 'video' | 'audio', File[]> = { image: [], video: [], audio: [] };
    Array.from(fileList).forEach((f) => grouped[guessMediaType(f)].push(f));
    (['image', 'video', 'audio'] as const).forEach((t) => {
      if (grouped[t].length === 0) return;
      const dt = new DataTransfer();
      grouped[t].forEach((f) => dt.items.add(f));
      onAdd(dt.files, t);
    });
  }

  return (
    <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4">
      <div className="flex justify-between items-center mb-2">
        <label className="text-sm font-bold text-gray-300">
          参考素材
          <span className="text-xs text-gray-500 font-normal ml-1.5">
            图≤{imgLimits.sizeLabel} / 视频≤{vidLimits.sizeLabel} / 音频≤{audLimits.sizeLabel}，均可选
          </span>
        </label>
        {hasAny && (
          <button onClick={() => allFiles.forEach((f) => onRemove(f.id, f.mediaType))}
            className="text-xs text-red-400 hover:text-red-300 transition-colors">
            清除全部
          </button>
        )}
      </div>

      {hasAny && (
        <div className="flex flex-wrap gap-2 mb-3">
          {allFiles.map((f, idx) => {
            const typeLabel = f.mediaType === 'image' ? '图' : f.mediaType === 'video' ? '视' : '音';
            const typeIdx = allFiles.slice(0, idx).filter((x) => x.mediaType === f.mediaType).length + 1;
            return <FileThumb key={f.id} f={f} onRemove={(id) => onRemove(id, f.mediaType)} label={`${typeLabel}${typeIdx}`} />;
          })}
        </div>
      )}

      {canAdd && (
        <div
          onClick={() => !uploading && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!uploading) dispatchFiles(e.dataTransfer.files); }}
          className={`w-full border border-dashed border-gray-700 rounded-2xl flex flex-col items-center justify-center gap-1.5 py-5 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}
        >
          <div className="text-gray-500 text-xs text-center pointer-events-none leading-relaxed">
            <div className="flex items-center justify-center gap-1.5 mb-1">
              <PlusIcon className="w-4 h-4" />
              <span>点击或拖拽文件到此处，自动识别类型</span>
            </div>
            <span className="text-gray-600">支持图片 / 视频 / 音频混合拖入</span>
          </div>
        </div>
      )}

      {/* 接受所有媒体类型，上传后按 MIME 分流 */}
      <input
        ref={fileRef}
        type="file"
        accept={[imgLimits.accept, vidLimits.accept, audLimits.accept].join(',')}
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) dispatchFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}

const ARK_ERROR_TRANSLATIONS: Record<string, string> = {
  'The request failed because the input image may contain real person': '请求失败：输入图片中可能含有真实人脸，平台隐私保护拒绝处理，请更换图片后重试',
  'The request failed because the output video may contain sensitive': '视频内容触发平台安全审核，请修改提示词后重试',
  'The request failed because the output video may be related to copyright': '视频内容可能涉及版权限制，请修改提示词后重试',
  'The request failed because the input text may contain sens': '提示词触发安全审核，请检查文字内容后重试',
  'input text may contain sensitive': '提示词触发安全审核，请检查文字内容后重试',
  'output video may contain sensitive': '视频内容触发平台安全审核，请修改提示词后重试',
  'invalid role specified for image content': '图片参数格式错误，请检查参考图片后重试',
  'role must be specified for image contents': '多图模式需要指定图片角色，请检查后重试',
  'The request failed due to input content policy': '输入内容不符合平台内容政策，请修改提示词或素材后重试',
  'Insufficient balance': '账户余额不足，请充值后重试',
  'Rate limit exceeded': '请求频率超出限制，请稍后重试',
  'model not found': '模型不存在，请检查模型选择',
  'timeout': '请求超时，请稍后重试',
};

function parseArkError(raw: string): string {
  // 资源未找到（前端兜底翻译）
  const assetMatch = raw.match(/content\[(\d+)\].*?asset-([\w-]+)\s+is not found/i);
  if (assetMatch) {
    return `第 ${parseInt(assetMatch[1], 10) + 1} 个指定的资源 asset-${assetMatch[2]} 没有找到，请重新上传资源后重试`;
  }
  // 资产服务未激活
  if (raw.includes('has not activated the Asset Service')) {
    return '您的帐户尚未激活资产服务，请联系管理员激活';
  }
  // 先直接对原始字符串做翻译匹配（覆盖 "视频生成失败: The request..." 格式）
  for (const [en, zh] of Object.entries(ARK_ERROR_TRANSLATIONS)) {
    if (raw.includes(en)) return zh;
  }
  // 尝试从 "HTTP 400: {...}" 格式中提取 JSON
  const jsonMatch = raw.match(/HTTP \d+:\s*(\{.*\})/s);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[1]);
      const msg: string = obj?.error?.message || obj?.message || '';
      if (msg) {
        for (const [en, zh] of Object.entries(ARK_ERROR_TRANSLATIONS)) {
          if (msg.includes(en)) return zh;
        }
        return msg;
      }
    } catch {
      // JSON 解析失败，继续走下面逻辑
    }
  }
  return raw;
}

export default function SingleTaskPage() {
  useUserTimezone();
  const { currentUser, state, loadProjectTasks } = useApp();
  const { settings } = state;
  const currentProject = state.currentProject;

  // ── 火山账号状态检查 ─────────────────────────────
  const [multiAccountEnabled, setMultiAccountEnabled] = useState(false);
  useEffect(() => {
    getVolcKeyStatus()
      .then((s) => setMultiAccountEnabled(s.multiAccountEnabled))
      .catch(() => {});
  }, []);
  const isVolcKeyDisabled = !!(
    multiAccountEnabled &&
    currentProject?.volc_is_active !== 1
  );
  const [images, setImages] = useState<UploadedFile[]>([]);
  const [firstFrameImages, setFirstFrameImages] = useState<UploadedFile[]>([]);
  const [lastFrameImages, setLastFrameImages] = useState<UploadedFile[]>([]);
  const [videos, setVideos] = useState<UploadedFile[]>([]);
  const [audios, setAudios] = useState<UploadedFile[]>([]);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<ModelId>((settings.model as ModelId) || 'seedance-2.0-fast');
  const [ratio, setRatio] = useState<AspectRatio>((settings.ratio as AspectRatio) || '9:16');
  const [duration, setDuration] = useState<Duration>((Number(settings.duration) as Duration) || 4);
  const [resolution, setResolution] = useState<'480p' | '720p' | '1080p'>((settings.resolution as '480p' | '720p' | '1080p') || '720p');
  // 防止 useCallback 闭包捕获过期的 resolution 值
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;
  const [referenceMode, setReferenceMode] = useState<'reference' | 'first_last_frame'>((settings.reference_mode as 'reference' | 'first_last_frame') || 'reference');
  const [generation, setGeneration] = useState<GenerationState>({ status: 'idle' });
  const [uploading, setUploading] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [estimate, setEstimate] = useState<{ credits: number; lockedCredits: number; tokens: number; warn?: string; discountedCredits?: number; discountedLockedCredits?: number } | null>(null);
  // 防止 useCallback 闭包捕获过期的 estimate 值
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const [discountExpired, setDiscountExpired] = useState(false);
  const [balance, setBalance] = useState<{ credits: number; unlimited: boolean; locked: number; available: number } | null>(null);
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelOption[]>([]);
  // 批量生成
  const maxConcurrent = Math.max(1, parseInt(settings.max_concurrent || '5', 10) || 5);
  const [batchSize, setBatchSize] = useState(1);
  // History panel state
  const [historyItems, setHistoryItems] = useState<DownloadTask[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadingRef = useRef(false); // ref 版本，避免 loadHistory 闭包捕获过期值
  const [previewVideo, setPreviewVideo] = useState<{ url: string; prompt: string } | null>(null);
  const historyBottomRef = useRef<HTMLDivElement>(null);
  const historyLoadedRef = useRef(false);
  const prevProjectIdRef = useRef<number | undefined>(undefined);
  // Project asset library
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [assetSelections, setAssetSelections] = useState<AssetSelection[]>([]);
  const [assetSyncing, setAssetSyncing] = useState(false);
  // 素材组列表（asset_groups 表）
  const [projectAssetGroups, setProjectAssetGroups] = useState<AssetGroupInfo[]>([]);

  // @ 小窗口键盘焦点索引（-1 = 无焦点）
  const [mentionFocusIdx, setMentionFocusIdx] = useState(-1);
  // 素材组面板键盘状态：当前聚焦的组索引 + 每组展开到第几个子素材
  // 素材组面板里"当前选中的组"过滤器：null = 显示全部，否则只显示该 volc_group_id 下的素材。
  // 这样当资产较多时，用户可以先点一个组 → 之后 @ 只在该组的素材里选，避免混杂。
  const [activeAssetGroupKey, setActiveAssetGroupKey] = useState<string | null>(null);
  const [, setPanelGroupIdx] = useState(0);
  const [, setPanelSubIdxMap] = useState<Record<string, number>>({});
  // DOM-position tracking for @ anchor (node + offset pointing to just before '@')
  const mentionAnchorNodeRef = useRef<Node | null>(null);
  const mentionAnchorOffsetRef = useRef<number>(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const staleChipRef = useRef<HTMLElement | null>(null);
  // document-level pointerdown: 用 elementFromPoint 绕过 contentEditable + pointer-events 限制
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      // elementFromPoint 忽略 pointer-events:none，能正确返回 chip 元素
      const atPoint = document.elementFromPoint(e.clientX, e.clientY);
      const chip = atPoint?.closest?.('.mention-chip--stale') as HTMLElement | null;
      if (!chip || !editorRef.current?.contains(chip)) return;
      e.preventDefault();
      e.stopPropagation();
      staleChipRef.current = chip;
      // 不移动光标、不移除 chip，仅打开 @ 选择面板
      setShowMention(true);
      setMentionQuery('');
      setMentionFocusIdx(-1);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, []);
  // 复用时存待写入的编辑器 HTML，useLayoutEffect 在 render 后立即应用，早于所有 useEffect
  const pendingEditorHtmlRef = useRef<string | null>(null);
  const mentionPanelRef = useRef<HTMLDivElement>(null);
  const undoStackRef = useRef<{ text: string; cursor: number }[]>([]);
  const redoStackRef = useRef<{ text: string; cursor: number }[]>([]);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextInputUndoRef = useRef(false);
  const navigate = useNavigate();

  // Toast
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  function showToast(text: string) {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }

  const isGenerating = generation.status === 'generating';

  // 所有已上传文件（用于 @ 面板）
  const mentionItems = [
    ...images.map((f, i) => ({ file: f, label: `图片${i + 1}`, tag: `@图片${i + 1}`, emoji: '🖼️', isAsset: false })),
    ...firstFrameImages.map((f, i) => ({ file: f, label: `首图${i + 1}`, tag: `@首图${i + 1}`, emoji: '🖼️', isAsset: false })),
    ...lastFrameImages.map((f, i) => ({ file: f, label: `尾图${i + 1}`, tag: `@尾图${i + 1}`, emoji: '🖼️', isAsset: false })),
    ...videos.map((f, i) => ({ file: f, label: `视频${i + 1}`, tag: `@视频${i + 1}`, emoji: '🎬', isAsset: false })),
    ...audios.map((f, i) => ({ file: f, label: `音频${i + 1}`, tag: `@音频${i + 1}`, emoji: '🎵', isAsset: false })),
  ];

  // 素材组所有非 rejected 素材均可 @（同一素材可多次引用）
  // 渲染层 sanity check：strict 过滤——只展示 project_id 严格等于当前工作组 ID 的资产
  const currentProjectId = state.currentProject?.id;
  const projectsLoaded = !state.loading;
  const availableAssets = useMemo(
    () => projectAssets.filter((a) => a.project_id === currentProjectId),
    [projectAssets, currentProjectId]
  );

  // 自愈：prompt 或 availableAssets 变化时，确保 prompt 中所有 @<volcId> chip 都在 assetSelections 中
  // 覆盖所有路径：粘贴、手动输入、加载历史、素材延迟加载等
  useEffect(() => {
    if (!availableAssets.length || !prompt) return;
    const missing = availableAssets.filter((a) => {
      if (!a.volc_asset_id) return false;
      const tag = `@${a.volc_asset_id}`;
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const inPrompt = new RegExp(escaped + '(?![\\w-])').test(prompt);
      return inPrompt;
    });
    if (missing.length === 0) return;
    setAssetSelections((prev) => {
      const next = [...prev];
      let changed = false;
      for (const a of missing) {
        const chipTag = `@${a.volc_asset_id}`;
        if (next.some((s) => s.chipTag === chipTag)) continue;
        const assetUri = a.volc_asset_id ? `asset://${a.volc_asset_id}` : (a.file_url || '');
        next.push({
          id: `asset-${a.volc_asset_id || a.id}`,
          volcAssetId: a.volc_asset_id || '',
          fileType: a.file_type as 'image' | 'video' | 'audio',
          name: a.name,
          thumbnailUrl: a.thumbnail_url || a.file_url || undefined,
          assetUri,
          chipTag,
        });
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [prompt, availableAssets]);

  // 统一 AssetGrid 所需数据
  const gridAssets = useMemo((): GridAsset[] =>
    availableAssets.map(a => ({ ...a })), [availableAssets]);

  const groupNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of projectAssetGroups) m.set(g.id, g.name);
    return m;
  }, [projectAssetGroups]);

  // 选中某组后，@ 面板可选项只来自该组；activeAssetGroupKey=null 表示「全部」
  const mentionableAssets = useMemo(() => {
    let filtered = availableAssets;
    if (activeAssetGroupKey) {
      filtered = filtered.filter((a) => (a.asset_group_id != null ? String(a.asset_group_id) : `_single_${a.id}`) === activeAssetGroupKey);
    }
    return filtered;
  }, [availableAssets, activeAssetGroupKey]);

  // 将 mentionableAssets 按素材组名称分组，用于 @ 面板分组显示
  const groupedMentionableAssets = useMemo(() => {
    const groupNameMap = new Map<number, string>();
    for (const g of projectAssetGroups) {
      groupNameMap.set(g.id, g.name);
    }
    const groups: { name: string; assets: ProjectAsset[] }[] = [];
    const seen = new Map<string, { name: string; assets: ProjectAsset[] }>();
    for (const a of mentionableAssets) {
      const key = a.asset_group_id != null && groupNameMap.has(a.asset_group_id)
        ? groupNameMap.get(a.asset_group_id)!
        : '未分组';
      if (!seen.has(key)) {
        const entry = { name: key, assets: [] };
        seen.set(key, entry);
        groups.push(entry);
      }
      seen.get(key)!.assets.push(a);
    }
    return groups;
  }, [mentionableAssets, projectAssetGroups]);


  // 切换工作组时重置组过滤
  useEffect(() => {
    if (!activeAssetGroupKey) return;
    const exists = projectAssetGroups.some((g) =>
      String(g.id) === activeAssetGroupKey || `_single_${g.id}` === activeAssetGroupKey
    );
    if (!exists) setActiveAssetGroupKey(null);
  }, [projectAssetGroups, activeAssetGroupKey]);

  // chipTag 直接用火山素材ID，全局唯一，不受排序影响
  function getAssetChipTag(asset: ProjectAsset, _assets?: ProjectAsset[]): string {
    return `@${asset.volc_asset_id || asset.id}`;
  }

  // 精确匹配 chipTag，避免 @abc123 误匹配 @abc12345（substring 前缀碰撞）
  // chipTag 形如 @<volcId> 或 @<localId>，后跟非单词字符或字符串结尾即为完整匹配
  function promptHasChip(text: string, chipTag: string): boolean {
    const escaped = chipTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped + '(?![\\w-])').test(text);
  }

  // volcAssetId → user-written asset name（用于 chip 显示名称映射）
  const assetDisplayMap = useMemo(() =>
    new Map(projectAssets.filter(a => a.volc_asset_id).map(a => [a.volc_asset_id!, a.name])),
    [projectAssets]
  );

  // 只匹配当前已上传素材的合法 tag，避免误把普通文字里的 @ 变成 chip
  function buildHtml(text: string, overrideSelections?: AssetSelection[]) {
    const sels = overrideSelections ?? assetSelections;
    // 收集失效 chip tag 集合（volcAssetId 为空的特殊 selection）
    const staleTagSet = new Set(sels.filter(s => !s.volcAssetId).map(s => s.chipTag));
    const escaped = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<div></div>');
    // 除 assetSelections 外，还包含所有可用素材的 chipTag，
    // 确保复制粘贴带 @asset-xxx 的 chip 后也能正确渲染
    const allAvailableAssetTags = availableAssets
      .filter(a => a.volc_asset_id)
      .map(a => `@${a.volc_asset_id}`);
    const allTags = [
      ...mentionItems.map((m) => m.tag),
      ...sels.map((a) => a.chipTag),
      ...allAvailableAssetTags.filter(t => !sels.some(s => s.chipTag === t)),
    ];
    if (allTags.length === 0) return escaped;
    const tagPattern = allTags
      .map(m => m.replace(/[.*+?^${}()|[]\]/g, '\$&'))
      .join('|');
    // 从 assetSelections + availableAssets 建立 chipTag → displayName 映射
    const tagDisplayMap = new Map<string, string>([
      ...sels.map((a): [string, string] => {
        const volcId = a.volcAssetId || a.chipTag.replace(/^@/, '');
        return [a.chipTag, assetDisplayMap.get(volcId) || a.name || a.chipTag];
      }),
      ...availableAssets
        .filter(a => a.volc_asset_id)
        .map((a): [string, string] => [`@${a.volc_asset_id}`, a.name || `@${a.volc_asset_id}`]),
    ]);
    // ZWS on both sides prevents Chrome phantom line-break around contenteditable=false
    return escaped.replace(new RegExp(tagPattern, 'g'),
      m => {
        const display = tagDisplayMap.get(m) || m;
        const cls = staleTagSet.has(m) ? 'mention-chip mention-chip--stale' : 'mention-chip';
        const attr = staleTagSet.has(m) ? ' data-stale="1"' : '';
        return `​<span contenteditable="false" class="${cls}" data-tag="${m}"${attr}>@${display}</span>​`;
      });
  }

  // 不依赖闭包状态，直接传入所有素材数组——用于复用时精确重建编辑器 HTML
  function buildHtmlExplicit(
    text: string,
    selections: AssetSelection[],
    imgs: UploadedFile[],
    vids: UploadedFile[],
    auds: UploadedFile[],
    firstImgs: UploadedFile[] = [],
    lastImgs: UploadedFile[] = [],
    displayMap?: Map<string, string>,
    staleTags?: Set<string>,
  ) {
    const escaped = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<div></div>');
    const allTags = [
      ...imgs.map((_, i) => `@图片${i + 1}`),
      ...firstImgs.map((_, i) => `@首图${i + 1}`),
      ...lastImgs.map((_, i) => `@尾图${i + 1}`),
      ...vids.map((_, i) => `@视频${i + 1}`),
      ...auds.map((_, i) => `@音频${i + 1}`),
      ...selections.map((a) => a.chipTag),
    ];
    if (allTags.length === 0) return escaped;
    const tagPattern = allTags
      .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const tagDisplayMap = new Map(selections.map((a) => {
      const volcId = a.volcAssetId || a.chipTag.replace(/^@/, '');
      const displayName = displayMap?.get(volcId) || a.name || a.chipTag;
      return [a.chipTag, displayName];
    }));
    return escaped.replace(new RegExp(tagPattern, 'g'),
      m => {
        const display = tagDisplayMap.get(m) || m;
        const isStale = staleTags?.has(m);
        const cls = isStale ? 'mention-chip mention-chip--stale' : 'mention-chip';
        const attr = isStale ? ` data-stale="1"` : '';
        return `​<span contenteditable="false" class="${cls}" data-tag="${m}"${attr}>@${display}</span>​`;
      });
  }

  function extractTextLen(raw: string): number {
    return raw.replace(/\u200B/g, "").length;
  }

  function extractText(el: Node): string {
    let t = '';
    const nodes = Array.from(el.childNodes);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === Node.TEXT_NODE) {
        // 跳过零宽空格（chip 前后的光标占位符）
        t += (n.textContent ?? '').replace(/\u200B/g, '');
      } else if ((n as Element).tagName === 'DIV') {
        t += '\n';
      } else if ((n as Element).tagName === 'BR') {
        const prev = n.previousSibling as Element | null;
        if (prev?.classList?.contains('mention-chip')) continue;
        t += '\n';
      } else if ((n as Element).classList?.contains('mention-chip')) {
        // chip 显示的是用户名称，但逻辑 tag 存在 data-tag 属性
        t += (n as Element).getAttribute('data-tag') ?? (n.textContent ?? '').replace(/​/g, '');
      } else {
        t += extractText(n);
      }
    }
    return t;
  }

  function getCursorOffset(root: HTMLDivElement): number {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    // Clone DOM from root start to cursor, run extractText so <br>→

    // is counted the same way as in the full-text extraction.
    try {
      const pre = document.createRange();
      pre.setStart(root, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const frag = pre.cloneContents();
      const tmp = document.createElement('div');
      tmp.appendChild(frag);
      let len = extractText(tmp).length;
      const tag = (range.startContainer as Element).tagName;
      if (range.startOffset === 0 && (tag === "DIV" || tag === "P") && range.startContainer !== root) {
        len += 1;
      }
      return len;
    } catch {
      return 0;
    }
  }

  // 返回当前选区在 extractText 坐标下的 [start, end]。无选区时 start === end === caret。
  function getSelectionRange(root: HTMLDivElement): { start: number; end: number } {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return { start: 0, end: 0 };
    const range = sel.getRangeAt(0);
    const offsetAt = (container: Node, off: number): number => {
      try {
        const pre = document.createRange();
        pre.setStart(root, 0);
        pre.setEnd(container, off);
        const tmp = document.createElement('div');
        tmp.appendChild(pre.cloneContents());
        let len = extractText(tmp).length;
        const tag = (container as Element).tagName;
        if (off === 0 && (tag === "DIV" || tag === "P") && container !== root) {
          len += 1;
        }
        return len;
      } catch { return 0; }
    };
    const a = offsetAt(range.startContainer, range.startOffset);
    const b = offsetAt(range.endContainer, range.endOffset);
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  }

  function setCursorOffset(root: HTMLDivElement, offset: number) {
    const sel = window.getSelection();
    if (!sel) return;
    let cur = 0;
    const walk = (node: Node): boolean => {
      // chip span 作为原子处理：计入字符数但光标不进入内部
      if ((node as Element).classList?.contains('mention-chip')) {
        const chipLen = ((node as Element).getAttribute('data-tag') ?? node.textContent ?? '').replace(/\u200B/g, '').length;
        if (cur + chipLen >= offset) {
          // 目标落在 chip 内或末尾，光标放到 chip 之后
          const r = document.createRange();
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          return true;
        }
        cur += chipLen;
        return false;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent ?? '';
        const logLen = raw.replace(/\u200B/g, '').length;
        if (cur + logLen >= offset) {
          let remaining = offset - cur;
          let rawIdx = 0;
          while (rawIdx < raw.length) {
            if (raw[rawIdx] !== '\u200B') {
              if (remaining === 0) break;
              remaining--;
            }
            rawIdx++;
          }
          const r = document.createRange();
          r.setStart(node, rawIdx);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          return true;
        }
        cur += logLen;
      } else if ((node as Element).tagName === 'DIV') {
        if (node !== root) {
          if (cur + 1 >= offset) {
            const r = document.createRange();
            r.setStartAfter(node);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return true;
          }
          cur += 1;
        }
        for (const c of Array.from(node.childNodes)) {
          if (walk(c)) return true;
        }
      } else if ((node as Element).tagName === 'BR') {
        if (cur + 1 >= offset) {
          const r = document.createRange();
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          return true;
        }
        cur += 1;
      } else {
        for (const c of Array.from(node.childNodes)) {
          if (walk(c)) return true;
        }
      }
      return false;
    };
    if (!walk(root)) {
      const r = document.createRange();
      r.selectNodeContents(root);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // 清理 Chrome 注入的 <br>
  function cleanChipBrs(el: HTMLElement) {
    el.querySelectorAll('.mention-chip + br').forEach(br => br.remove());
  }

  function setEditorHtml(html: string) {
    if (!editorRef.current) return;
    editorRef.current.innerHTML = html;
    cleanChipBrs(editorRef.current);
    // 若最后一个子节点是 chip，追加零宽空格文本节点，确保光标有落点
    const last = editorRef.current.lastChild;
    if (last?.nodeType === Node.ELEMENT_NODE && (last as Element).classList.contains('mention-chip')) {
      editorRef.current.appendChild(document.createTextNode('\u200B'));
    }
  }

  // 保存撤销快照（立即）
  function pushUndo(text: string, cursor: number) {
    const last = undoStackRef.current[undoStackRef.current.length - 1];
    if (last?.text === text) return; // 内容未变不重复入栈
    undoStackRef.current.push({ text, cursor });
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
  }

  // 防抖快照：普通打字每 300ms 归并一次
  function schedulePushUndo(text: string, cursor: number) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => pushUndo(text, cursor), 300);
  }

  // 立即刷入防抖中待提交的快照（在 insertMention/paste 前调用）
  function flushUndo(text: string, cursor: number) {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    pushUndo(text, cursor);
  }


  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML === '') {
      setEditorHtml(buildHtml(prompt));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 复用时通过 pendingEditorHtmlRef 写入编辑器，useLayoutEffect 在每次 render 后立即执行，
  // 早于 useEffect，不受 projectAssets useEffect 覆盖的影响
  useLayoutEffect(() => {
    if (pendingEditorHtmlRef.current !== null) {
      const html = pendingEditorHtmlRef.current;
      pendingEditorHtmlRef.current = null;
      skipNextInputUndoRef.current = true;
      setEditorHtml(html);
    }
  });

  // 加载余额
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    const tick = () => getCreditBalance().then((b) => { if (alive) setBalance(b); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [currentUser]);

  // 拉取运行时可用模型列表（来源 model_pricing 表 enabled=1）
  useEffect(() => {
    listEnabledModels()
      .then((list) => setRuntimeModels(list))
      .catch(() => {});
  }, []);

  // 加载工作组素材组（有 file_url 的素材均可引用）
  // 先加载 asset_groups（可能触发自动同步），再加载 project_assets
  useEffect(() => {
    const pid = state.currentProject?.id;
    setProjectAssets([]);
    if (!pid) return;
    let cancelled = false;

    (async () => {
      // 先等 asset_groups 加载（可能含自动同步）
      const result = await listProjectAssetGroups(pid).catch(() => ({ groups: [] as AssetGroupInfo[], thumbnailsPending: 0 }));
      if (cancelled) return;
      setProjectAssetGroups(result.groups);

      // 有待迁移到 OSS 的缩略图时，后台刷新完成后自动重拉
      if (result.thumbnailsPending > 0) {
        const pid2 = pid;
        setTimeout(async () => {
          try {
            invalidateProjectCache(pid2);
            const r2 = await listProjectAssetGroups(pid2);
            setProjectAssetGroups(r2.groups);
          } catch { /* 刷新失败保持旧数据 */ }
        }, 5000);
      }
      // 再加载 project_assets
      const r = await getProjectAssets(pid, { pageSize: 100, skipLive: true } as Parameters<typeof getProjectAssets>[1]).catch(() => null);
      if (cancelled || !r) return;
      const tagged = r.assets
        .filter((a) => a.review_status !== 'rejected' && (a.volc_asset_id || a.file_url))
        .map((a) => ({ ...a, project_id: pid }));
      setProjectAssets(tagged);
    })();

    return () => { cancelled = true; };
  }, [state.currentProject?.id]);



  // 工作组切换时清空表单（assetSelections、prompt、上传素材都属于上个工作组的上下文，不应跨组保留）
  const formResetProjectIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pid = state.currentProject?.id;
    if (formResetProjectIdRef.current === undefined) {
      formResetProjectIdRef.current = pid;
      return; // 首次挂载不清空
    }
    if (pid === formResetProjectIdRef.current) return;
    formResetProjectIdRef.current = pid;
    // 清空所有跨工作组不应保留的表单上下文
    setAssetSelections([]);
    setPrompt('');
    setEditorHtml('');
    setImages((prev) => { prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
    setFirstFrameImages((prev) => { prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
    setLastFrameImages((prev) => { prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
    setVideos((prev) => { prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
    setAudios((prev) => { prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)); return []; });
    setGeneration({ status: 'idle' });
    if (editorRef.current) editorRef.current.innerHTML = '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentProject?.id]);

  const refreshWorkgroup = useCallback(async () => {
    const pid = state.currentProject?.id;
    if (!pid) return;
    setAssetSyncing(true);
    try {
      const r = await getProjectAssets(pid, { pageSize: 100, skipLive: true });
      const tagged = r.assets
        .filter((a) => a.review_status !== 'rejected' && (a.volc_asset_id || a.file_url))
        .map((a) => ({ ...a, project_id: pid }));
      setProjectAssets(tagged);
    } catch { /* ignore */ } finally {
      setAssetSyncing(false);
    }
  }, [state.currentProject?.id]);

  const historyGenRef = useRef(0); // 每次工作组切换递增，用于丢弃过期响应
  // 加载历史记录
  const loadHistory = useCallback(async (page: number, append = false, overrideProjectId?: number | null) => {
    if (historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const projectId = overrideProjectId !== undefined ? overrideProjectId : (state.currentProject?.id ?? null);
    const gen = historyGenRef.current;
    try {
      const result = await getDownloadTasks('all', 'video', page, 20, projectId, false, true);
      if (gen !== historyGenRef.current) return; // 工作组已切换，丢弃过期响应
      setHistoryItems((prev) => append ? [...prev, ...result.tasks] : result.tasks);
      setHistoryHasMore(result.tasks.length === 20 && result.tasks.length + (append ? historyItems.length : 0) < result.total);
      setHistoryPage(page);
    } catch {
      // silent
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentProject?.id]);

  // 初始加载历史（等项目列表加载完再请求，避免刷新时用 undefined projectId 拉全量）
  useEffect(() => {
    if (!projectsLoaded) return;
    if (historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    void loadHistory(1, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded]);

  // 工作组切换时立即清空历史并重新加载
  useEffect(() => {
    const pid = state.currentProject?.id;
    if (pid === prevProjectIdRef.current) return;
    prevProjectIdRef.current = pid;
    if (!historyLoadedRef.current) return; // 首次加载由上面的 effect 负责
    historyGenRef.current += 1;     // 令正在进行中的旧请求失效
    historyLoadingRef.current = false; // 解除 loading 锁，允许新请求
    setHistoryItems([]);
    setHistoryPage(1);
    setHistoryHasMore(false);
    void loadHistory(1, false, pid ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentProject?.id]);

  // 生成完成后刷新历史
  useEffect(() => {
    if (generation.status === 'success' || generation.status === 'error') {
      void loadHistory(1, false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation.status]);

  // 历史列表轮询：只要还有任务在 generating，每 5s 重新拉一次列表。
  // 这样即使 generateVideo 的内部 polling 闭包因导航/切菜单丢失，历史卡也会自动刷新到 done 状态。
  useEffect(() => {
    const hasGenerating = historyItems.some(
      (t) => t.effective_download_status === 'generating' || t.status === 'generating'
    );
    if (!hasGenerating) return;
    const timer = window.setInterval(() => {
      void loadHistory(1, false);
    }, 5000);
    return () => window.clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyItems]);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = historyBottomRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && historyHasMore && !historyLoading) {
        void loadHistory(historyPage + 1, true);
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, historyLoading, historyPage, loadHistory]);

  // 实时估算积分（requestId 计数器确保始终使用最新结果）
  const estimateRequestRef = useRef(0);
  useEffect(() => {
    if (!model) { setEstimate(null); return; }
    const ctrl = new AbortController();
    const reqId = ++estimateRequestRef.current;
    const timer = setTimeout(() => {
      estimatePricing({
        model,
        outputDurationSec: Number(duration),
        ratio,
        resolution,
        hasVideoInput: videos.length > 0,
        hasAudio: audios.length > 0,
        isDraft: false,
      })
        .then((r) => {
          if (!ctrl.signal.aborted && reqId === estimateRequestRef.current) {
            setEstimate({ credits: r.credits, lockedCredits: r.lockedCredits, tokens: r.tokens, warn: r.warn, discountedCredits: r.discountedCredits, discountedLockedCredits: r.discountedLockedCredits });
            setDiscountExpired(false);
          }
        })
        .catch(() => { if (!ctrl.signal.aborted && reqId === estimateRequestRef.current) setEstimate(null); });
    }, 200);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [model, duration, ratio, resolution, videos.length, audios.length]);

  // 选中区域覆盖 chip 时触发 Q版弹跳效果；同步维护普通文字的选中/未选中状态
  useEffect(() => {
    const handler = () => {
      if (!editorRef.current) return;
      const sel = window.getSelection();
      const hasSelection = !!(sel && !sel.isCollapsed && sel.rangeCount &&
        editorRef.current.contains(sel.getRangeAt(0).commonAncestorContainer));

      editorRef.current.classList.toggle('has-selection', hasSelection);

      const chips = editorRef.current.querySelectorAll('.mention-chip');
      chips.forEach(chip => {
        if (!hasSelection) {
          chip.classList.remove('mention-chip--selected');
          return;
        }
        const range = sel!.getRangeAt(0);
        const chipRange = document.createRange();
        chipRange.selectNode(chip);
        const overlaps =
          range.compareBoundaryPoints(Range.END_TO_START, chipRange) < 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, chipRange) > 0;
        chip.classList.toggle('mention-chip--selected', overlaps);
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, []);

  const handleEditorInput = () => {
    if (skipNextInputUndoRef.current) {
      skipNextInputUndoRef.current = false;
      return;
    }
    if (!editorRef.current) return;
    cleanChipBrs(editorRef.current);
    const text = extractText(editorRef.current);
    setPrompt(text);
    const cursor = getCursorOffset(editorRef.current);
    schedulePushUndo(text, cursor);

    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);

    // 用 DOM Range 直接取光标前一字符（多行时比 text[cursor-1] 更可靠）
    const charBeforeCursor = (() => {
      try {
        const r = range.cloneRange();
        if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset >= 1) {
          r.setStart(r.startContainer, r.startOffset - 1);
          return r.toString();
        }
        // 光标在节点起始位置，找前一个兄弟节点的最后字符
        const prev = r.startContainer.previousSibling || r.startContainer.parentNode?.previousSibling;
        if (prev) {
          const t = prev.textContent || '';
          return t[t.length - 1] ?? '';
        }
      } catch { /* ignore */ }
      return text[cursor - 1] ?? '';
    })();

    if (charBeforeCursor === '@') {
      // Save DOM position of '@': cursor is right after '@', so offset-1 points to '@'
      const node = range.startContainer;
      const offset = range.startOffset;
      if (node.nodeType === Node.TEXT_NODE && offset >= 1) {
        mentionAnchorNodeRef.current = node;
        mentionAnchorOffsetRef.current = offset - 1;
      } else {
        // Fallback: save approximate position
        mentionAnchorNodeRef.current = node;
        mentionAnchorOffsetRef.current = Math.max(0, offset - 1);
      }
      setShowMention(true);
    } else if (showMention) {
      // Check if cursor still follows the anchor @ with no whitespace
      if (!mentionAnchorNodeRef.current) {
        setShowMention(false);
        return;
      }
      // Walk text from anchor to cursor to verify still valid mention
      try {
        const checkRange = document.createRange();
        checkRange.setStart(mentionAnchorNodeRef.current, mentionAnchorOffsetRef.current);
        checkRange.setEnd(range.startContainer, range.startOffset);
        const slice = checkRange.toString().replace(/\u200B/g, '');
        if (!slice.startsWith('@') || /[\s\n]/.test(slice)) {
          setShowMention(false);
        }
      } catch {
        setShowMention(false);
      }
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { setShowMention(false); setMentionFocusIdx(-1); return; }

    // @ 小窗口 4 向键盘导航 + 回车选择
    if (showMention) {
      const flatItems: Array<{ type: 'upload'; idx: number } | { type: 'asset'; idx: number }> = [
        ...mentionItems.map((_, i) => ({ type: 'upload' as const, idx: i })),
        ...mentionableAssets.map((_, i) => ({ type: 'asset' as const, idx: i })),
      ];
      const total = flatItems.length;
      if (total > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'Enter')) {
        e.preventDefault();
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setMentionFocusIdx((p) => (p + 1) % total);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          setMentionFocusIdx((p) => (p <= 0 ? total - 1 : p - 1));
        } else if (e.key === 'Enter') {
          const item = flatItems[mentionFocusIdx];
          if (item) {
            if (item.type === 'upload') insertMention(mentionItems[item.idx].tag);
            else insertAssetMention(mentionableAssets[item.idx]);
          }
          setMentionFocusIdx(-1);
          setShowMention(false);
        }
        return;
      }
    }

    if (!editorRef.current) return;

    // 自定义撤销/重做（直接 innerHTML 赋值会清空浏览器原生栈）
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const snap = undoStackRef.current.pop();
      if (snap) {
        const currentText = extractText(editorRef.current);
        const currentCursor = getCursorOffset(editorRef.current);
        redoStackRef.current.push({ text: currentText, cursor: currentCursor });
        skipNextInputUndoRef.current = true;
        setEditorHtml(buildHtml(snap.text));
        setPrompt(snap.text);
        setTimeout(() => { if (editorRef.current) setCursorOffset(editorRef.current, snap.cursor); }, 0);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      const snap = redoStackRef.current.pop();
      if (snap) {
        const currentText = extractText(editorRef.current);
        const currentCursor = getCursorOffset(editorRef.current);
        undoStackRef.current.push({ text: currentText, cursor: currentCursor });
        skipNextInputUndoRef.current = true;
        setEditorHtml(buildHtml(snap.text));
        setPrompt(snap.text);
        setTimeout(() => { if (editorRef.current) setCursorOffset(editorRef.current, snap.cursor); }, 0);
      }
      return;
    }

    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);

    // contenteditable="false" 阻止光标进入 chip 内部，
    // 但保留方向键和删除键处理，确保行为一致
    const container = range.startContainer;
    const chipEl = (container.nodeType === Node.TEXT_NODE
      ? container.parentElement
      : container as Element)?.closest?.('.mention-chip');
    if (chipEl) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const r = document.createRange();
        r.setStartBefore(chipEl); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const r = document.createRange();
        r.setStartAfter(chipEl); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        const r = document.createRange();
        r.setStartBefore(chipEl); r.collapse(true);
        chipEl.remove();
        sel.removeAllRanges(); sel.addRange(r);
        if (editorRef.current) setPrompt(extractText(editorRef.current));
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        e.preventDefault();
      }
      return;
    }

    if (!range.collapsed) return;

    if (e.key === 'Backspace') {
      const node = range.startContainer;
      const offset = range.startOffset;
      const prevChip =
        (node === editorRef.current ? node.childNodes[offset - 1] : null) as Element | null
        ?? (node.nodeType === Node.TEXT_NODE && offset === 0 ? node.previousSibling as Element : null);
      if (prevChip?.classList?.contains('mention-chip')) {
        e.preventDefault();
        prevChip.remove();
        setPrompt(extractText(editorRef.current));
      }
    } else if (e.key === 'Delete') {
      const node = range.startContainer;
      const offset = range.startOffset;
      const nextChip =
        (node === editorRef.current ? node.childNodes[offset] : null) as Element | null
        ?? (node.nodeType === Node.TEXT_NODE && offset === (node.textContent ?? '').length ? node.nextSibling as Element : null);
      if (nextChip?.classList?.contains('mention-chip')) {
        e.preventDefault();
        nextChip.remove();
        setPrompt(extractText(editorRef.current));
      }
    }
  };

  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!editorRef.current) return;
    const raw = e.clipboardData.getData('text/plain');
    const converted = raw.replace(/<ref>(@[^<\n]+)<\/ref>/g, '$1');
    let { start, end } = getSelectionRange(editorRef.current);
    let currentText = extractText(editorRef.current);
    flushUndo(currentText, start);
    // 空编辑器直接覆盖 / Enter 后光标推进
    if (currentText.trim() === "" && currentText.length <= 1) { currentText = ""; start = 0; end = 0; }
    let adjustedStart = start;
    if (start === end && start > 0 && start < currentText.length && currentText[start] === String.fromCharCode(10)) adjustedStart = start + 1;
    skipNextInputUndoRef.current = true;
    const newText = currentText.slice(0, adjustedStart) + converted + currentText.slice(end);
    setEditorHtml(buildHtml(newText));
    setPrompt(newText);
    // Restore assetSelections for any @asset chips present in the pasted text
    const pastedAssets = availableAssets.filter(
      (a) => a.volc_asset_id && promptHasChip(newText, `@${a.volc_asset_id}`)
    );
    if (pastedAssets.length > 0) {
      setAssetSelections((prev) => {
        const next = [...prev];
        for (const asset of pastedAssets) {
          const chipTag = getAssetChipTag(asset);
          if (!next.some((s) => s.chipTag === chipTag)) {
            const assetUri = asset.volc_asset_id ? `asset://${asset.volc_asset_id}` : (asset.file_url || '');
            next.push({
              id: `asset-${asset.volc_asset_id || asset.id}`,
              volcAssetId: asset.volc_asset_id || '',
              fileType: asset.file_type as 'image' | 'video' | 'audio',
              name: asset.name,
              thumbnailUrl: asset.thumbnail_url || asset.file_url || undefined,
              assetUri,
              chipTag,
            });
          }
        }
        return next;
      });
    }
    const posClean = extractTextLen(currentText.slice(0, adjustedStart)) + extractTextLen(converted);
    setTimeout(() => {
      if (editorRef.current) setCursorOffset(editorRef.current, posClean);
    }, 0);
  };

  const serializeSelectionAsRef = (): string => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    let out = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? '';
      } else if ((node as Element).tagName === 'BR') {
        out += '\n';
      } else if ((node as Element).classList?.contains('mention-chip')) {
        out += `<ref>${(node as Element).getAttribute('data-tag') ?? node.textContent ?? ''}</ref>`;
      } else {
        node.childNodes.forEach(walk);
      }
    };
    // fragment 为空时回退到 toString（纯文字选区）
    if (fragment.childNodes.length === 0) return range.toString();
    fragment.childNodes.forEach(walk);
    return out || range.toString();
  };

  const handleEditorCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = serializeSelectionAsRef();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
  };

  const handleEditorCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = serializeSelectionAsRef();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    // 删除选中内容
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      sel.getRangeAt(0).deleteContents();
      if (editorRef.current) {
        setPrompt(extractText(editorRef.current));
      }
    }
  };

  const insertMention = (tag: string, displayName?: string) => {
    // 如果有点击失效 chip，先替换它而不是插入到光标位置
    if (staleChipRef.current) {
      const chip = staleChipRef.current;
      staleChipRef.current = null;
      const edit = editorRef.current;
      if (edit && chip.parentNode) {
        const frag = document.createDocumentFragment();
        const zwsBefore = document.createTextNode('\u200B');
        const newChip = document.createElement('span');
        newChip.className = 'mention-chip';
        newChip.setAttribute('contenteditable', 'false');
        newChip.setAttribute('data-tag', tag);
        newChip.textContent = displayName ? `@${displayName}` : tag;
        const zwsAfter = document.createTextNode('\u200B');
        frag.appendChild(zwsBefore);
        frag.appendChild(newChip);
        frag.appendChild(zwsAfter);
        chip.parentNode.replaceChild(frag, chip);
        setPrompt(extractText(edit));
        setShowMention(false);
        mentionAnchorNodeRef.current = null;
        // 光标放到新 chip 后
        edit.focus();
        const sel = window.getSelection();
        if (sel) {
          const r = document.createRange();
          r.setStartAfter(newChip);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        return;
      }
    }
    if (!editorRef.current || !mentionAnchorNodeRef.current) return;

    // Snapshot undo before modifying DOM
    const text = extractText(editorRef.current);
    const cursor = getCursorOffset(editorRef.current);
    flushUndo(text, cursor);

    editorRef.current.focus();
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;

    // Build a range spanning from '@' to current cursor position
    const curRange = sel.getRangeAt(0);
    const deleteRange = document.createRange();
    try {
      deleteRange.setStart(mentionAnchorNodeRef.current, mentionAnchorOffsetRef.current);
      deleteRange.setEnd(curRange.startContainer, curRange.startOffset);
    } catch {
      // Anchor became invalid; fall back to cursor-only insertion
      deleteRange.setStart(curRange.startContainer, curRange.startOffset);
      deleteRange.setEnd(curRange.startContainer, curRange.startOffset);
    }

    // Remove '@query' text
    deleteRange.deleteContents();

    // Build fragment: [ZWS][chip contenteditable=false][ZWS]
    // ZWS on both sides prevents Chrome phantom line-break around non-editable inline elements
    const frag = document.createDocumentFragment();
    const zwsBefore = document.createTextNode('\u200B');
    const chip = document.createElement('span');
    chip.className = 'mention-chip';
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('data-tag', tag);
    chip.textContent = displayName ? `@${displayName}` : tag;
    const zwsAfter = document.createTextNode('\u200B');
    frag.appendChild(zwsBefore);
    frag.appendChild(chip);
    frag.appendChild(zwsAfter);

    deleteRange.collapse(true);
    deleteRange.insertNode(frag);

    // cursor anchor = zwsAfter, after the \u200B character
    const cursorNode = zwsAfter;
    const cursorOffset = 1;

    setPrompt(extractText(editorRef.current));
    setShowMention(false);
    mentionAnchorNodeRef.current = null;

    // Defer cursor placement so Chrome's contenteditable model settles after DOM mutation
    const savedNode = cursorNode;
    const savedOffset = cursorOffset;
    setTimeout(() => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      const s = window.getSelection();
      if (!s) return;
      try {
        const r = document.createRange();
        r.setStart(savedNode, savedOffset);
        r.collapse(true);
        s.removeAllRanges();
        s.addRange(r);
      } catch {
        // Node may have been removed; place cursor at end
        const r = document.createRange();
        r.selectNodeContents(editorRef.current);
        r.collapse(false);
        s.removeAllRanges();
        s.addRange(r);
      }
    }, 0);
  };

  const insertAssetMention = (asset: ProjectAsset) => {
    const assetUri = asset.volc_asset_id ? `asset://${asset.volc_asset_id}` : (asset.file_url || '');
    if (!assetUri) return;
    // chipTag 固定为资产在列表中的位置，不随已选数量变化
    const chipTag = getAssetChipTag(asset, projectAssets);

    const sel: AssetSelection = {
      id: `asset-${asset.volc_asset_id || asset.id}`,
      volcAssetId: asset.volc_asset_id || '',
      fileType: asset.file_type as 'image' | 'video' | 'audio',
      name: asset.name,
      thumbnailUrl: asset.thumbnail_url || asset.file_url || undefined,
      assetUri,
      chipTag,
    };
    setAssetSelections((prev) => {
      // 同一资产已存在则直接复用（chipTag 不变）
      if (prev.some((s) => s.id === sel.id)) return prev;
      return [...prev, sel];
    });
    insertMention(chipTag, asset.name);
  };

  useEffect(() => { if (!showMention) setMentionFocusIdx(-1); }, [showMention]);

  // 资产列表变化时（刷新后新增），重新映射已插入 chip 的 tag
  // 复用时由 pendingEditorHtmlRef 负责写入编辑器，跳过本 effect 的覆盖
  useEffect(() => {
    if (!showMention) return;
    // 延迟添加 close 监听器，让当前点击的 mousedown 先走完再启用关闭功能
    const timer = setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (mentionPanelRef.current && !mentionPanelRef.current.contains(e.target as Node)) setShowMention(false);
      };
      document.addEventListener('mousedown', close);
      // 把 close 引用存到 cleanupRef 方便清理
      (window as any).__mentionClose = () => document.removeEventListener('mousedown', close);
    }, 0);
    return () => {
      clearTimeout(timer);
      if (typeof (window as any).__mentionClose === 'function') {
        (window as any).__mentionClose();
        delete (window as any).__mentionClose;
      }
    };
  }, [showMention]);

  // 更新文件上传进度
  const updateFileProgress = useCallback((
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    id: string,
    progress: number,
    ossUrl?: string
  ) => {
    setter((prev) => prev.map((f) =>
      f.id === id ? { ...f, uploadProgress: progress, ...(ossUrl ? { ossUrl } : {}) } : f
    ));
  }, []);

  // 添加文件并立即上传到 OSS
  const addFiles = useCallback(async (
    fileList: FileList,
    mediaType: 'image' | 'video' | 'audio',
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    currentCount: number
  ) => {
    const limits = FILE_LIMITS[mediaType];
    const remaining = limits.maxCount - currentCount;
    if (remaining <= 0) return;

    const validFiles: File[] = [];
    for (const file of Array.from(fileList).slice(0, remaining)) {
      if (file.size > limits.maxSize) {
        alert(`文件 "${file.name}" 超过大小限制（${limits.sizeLabel}），已跳过`);
        continue;
      }
      validFiles.push(file);
    }
    if (validFiles.length === 0) return;

    const newEntries: UploadedFile[] = validFiles.map((file) => ({
      id: `file-${++nextId}`,
      file,
      previewUrl: mediaType === 'image' ? URL.createObjectURL(file) : '',
      name: file.name,
      size: file.size,
      mediaType,
      uploadProgress: 0,
    }));
    setter((prev) => [...prev, ...newEntries]);

    setUploading(true);
    try {
      await Promise.all(newEntries.map(async (entry) => {
        try {
          const result = await uploadToOss(entry.file, mediaType, (pct) => {
            updateFileProgress(setter, entry.id, pct);
          });
          updateFileProgress(setter, entry.id, 100, result.url);
        } catch (err) {
          alert(`"${entry.file.name}" 上传失败：${err instanceof Error ? err.message : err}`);
          setter((prev) => prev.filter((f) => f.id !== entry.id));
        }
      }));
    } finally {
      setUploading(false);
    }
  }, [updateFileProgress]);

  const removeFile = useCallback((
    id: string,
    setter: React.Dispatch<React.SetStateAction<UploadedFile[]>>
  ) => {
    setter((prev) => {
      const f = prev.find((x) => x.id === id);
      if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    const frameImages = [...firstFrameImages, ...lastFrameImages];
    const activeImages = referenceMode === 'first_last_frame' ? frameImages : images;
    const hasMedia = activeImages.length > 0 || videos.length > 0 || audios.length > 0;
    if (!prompt.trim() && !hasMedia) return;
    if (isGenerating || uploading) return;

    // 检查是否有文件还在上传中
    const allFiles = [...activeImages, ...videos, ...audios];
    const stillUploading = allFiles.some((f) => !f.ossUrl && f.uploadProgress !== undefined && f.uploadProgress < 100);
    if (stillUploading) {
      alert('请等待文件上传完成后再生成');
      return;
    }

    const comboError = validateMediaCombination(!!prompt.trim(), activeImages.length, videos.length, audios.length);
    if (comboError) { alert(comboError); return; }

    // 折扣过期检查：refresh estimate，若之前有折扣但现在过期则拦截
    if (estimateRef.current?.discountedCredits != null && !discountExpired) {
      try {
        const fresh = await estimatePricing({
          model,
          outputDurationSec: Number(duration),
          ratio,
          resolution: resolutionRef.current,
          hasVideoInput: videos.length > 0,
          hasAudio: audios.length > 0,
          isDraft: false,
        });
        if (fresh.discountedCredits == null || fresh.discountedCredits === fresh.credits) {
          setEstimate({ credits: fresh.credits, lockedCredits: fresh.lockedCredits, tokens: fresh.tokens, warn: fresh.warn });
          setDiscountExpired(true);
          return;
        }
        // 折扣依然有效，用最新值更新
        setEstimate({ credits: fresh.credits, lockedCredits: fresh.lockedCredits, tokens: fresh.tokens, warn: fresh.warn, discountedCredits: fresh.discountedCredits, discountedLockedCredits: fresh.discountedLockedCredits });
      } catch { /* 网络错误，继续用旧 estimate 提交 */ }
    }

    // 积分余额预检（避免提交后才被后端拒绝）
    const curEstimate = estimateRef.current;
    if (balance && !balance.unlimited && curEstimate && curEstimate.lockedCredits > 0) {
      const effLocked = curEstimate.discountedLockedCredits != null ? curEstimate.discountedLockedCredits : curEstimate.lockedCredits;
      const totalNeeded = effLocked * batchSize;
      if (balance.available < totalNeeded) {
        alert(batchSize > 1
          ? `批量生成 ${batchSize} 个任务积分不足（可用 ${balance.available}，需要 ${totalNeeded}）`
          : `可用积分不足（可用 ${balance.available}，本次预计需要 ${curEstimate.lockedCredits}）`);
        return;
      }
    }

    const orderedFrameImages = [...firstFrameImages, ...lastFrameImages].filter((f) => f.ossUrl);

    // 判断 prompt 中是否有任意 @ 引用 chip
    // 若有，则仅发送被明确 @ 的素材；若无，则发送全部上传素材（兼容不写 @ 的用法）
    const allChipTags = [
      ...mentionItems.map((m) => m.tag),
      ...assetSelections.map((a) => a.chipTag),
    ];
    const hasAnyChip = allChipTags.some((tag) => promptHasChip(prompt, tag));

    // 提交前用最新 projectAssets 刷新 assetSelections 的 assetUri（修复C：快照过期问题）
    const assetMap = new Map(projectAssets.map((a) => [a.volc_asset_id, a]));
    const stateSelections = assetSelections.map((sel) => {
      if (!sel.volcAssetId) return sel;
      const live = assetMap.get(sel.volcAssetId);
      if (!live) return sel;
      const freshUri = live.volc_asset_id ? `asset://${live.volc_asset_id}` : (live.file_url || sel.assetUri);
      return freshUri !== sel.assetUri ? { ...sel, assetUri: freshUri } : sel;
    });
    // 修复D：直接从 prompt + projectAssets 派生缺失的 selection
    // 避免「粘贴后立即提交」时 useEffect 尚未跑、assetSelections 仍为空导致漏图
    const derivedFromPrompt = projectAssets
      .filter((a) => a.project_id === currentProjectId && a.volc_asset_id)
      .filter((a) => promptHasChip(prompt, `@${a.volc_asset_id}`))
      .filter((a) => !stateSelections.some((s) => s.chipTag === `@${a.volc_asset_id}`))
      .map((a) => ({
        id: `asset-${a.volc_asset_id || a.id}`,
        volcAssetId: a.volc_asset_id || '',
        fileType: a.file_type as 'image' | 'video' | 'audio',
        name: a.name,
        thumbnailUrl: a.thumbnail_url || a.file_url || undefined,
        assetUri: `asset://${a.volc_asset_id}`,
        chipTag: `@${a.volc_asset_id}`,
      }));
    const freshSelections = [...stateSelections, ...derivedFromPrompt];

    let uploadedImageUrls: string[];
    let resolvedVideoUrl: string | undefined;
    let resolvedAudioUrl: string | undefined;

    if (referenceMode === 'first_last_frame') {
      // 首尾帧模式：不受 @ 影响，始终发送首尾图
      uploadedImageUrls = orderedFrameImages.map((f) => f.ossUrl!);
      resolvedVideoUrl = undefined;
      resolvedAudioUrl = audios[0]?.ossUrl;
    } else if (hasAnyChip) {
      // 有 @ chip：只发送 prompt 中明确提及的素材
      uploadedImageUrls = images
        .map((f, i) => ({ f, tag: `@图片${i + 1}` }))
        .filter(({ f, tag }) => f.ossUrl && promptHasChip(prompt, tag))
        .map(({ f }) => f.ossUrl!);
      resolvedVideoUrl = videos
        .map((f, i) => ({ f, tag: `@视频${i + 1}` }))
        .find(({ f, tag }) => f.ossUrl && promptHasChip(prompt, tag))?.f.ossUrl;
      resolvedAudioUrl = audios
        .map((f, i) => ({ f, tag: `@音频${i + 1}` }))
        .find(({ f, tag }) => f.ossUrl && promptHasChip(prompt, tag))?.f.ossUrl;
    } else {
      // 无 @ chip：发送全部上传素材（传统用法）
      uploadedImageUrls = images.filter((f) => f.ossUrl).map((f) => f.ossUrl!);
      resolvedVideoUrl = videos[0]?.ossUrl;
      resolvedAudioUrl = audios[0]?.ossUrl;
    }

    // 资产库素材：只提交 prompt 中明确 @ 的（使用刷新后的URI + 精确匹配）
    const activeAssetImgUris = freshSelections
      .filter((a) => a.fileType === 'image' && promptHasChip(prompt, a.chipTag))
      .map((a) => a.assetUri);
    const activeAssetVidUris = freshSelections
      .filter((a) => a.fileType === 'video' && promptHasChip(prompt, a.chipTag))
      .map((a) => a.assetUri);
    const activeAssetAudUri = freshSelections
      .find((a) => a.fileType === 'audio' && promptHasChip(prompt, a.chipTag))?.assetUri;

    // 有资产库 @ 引用时，上传区素材不再混入（避免 @素材1 时带出其他上传图片）
    const hasAssetChip = freshSelections.some((a) => promptHasChip(prompt, a.chipTag));
    const imageUrls = hasAssetChip
      ? activeAssetImgUris
      : [...uploadedImageUrls, ...activeAssetImgUris];
    // 多视频素材全部合入（ARK 支持多路 video 作参考），取第一个非空
    const videoUrl = hasAssetChip
      ? (activeAssetVidUris[0] || resolvedVideoUrl)
      : (resolvedVideoUrl || activeAssetVidUris[0]);
    const audioUrl = hasAssetChip
      ? (activeAssetAudUri || resolvedAudioUrl)
      : (resolvedAudioUrl || activeAssetAudUri);

    setGeneration({ status: 'generating', progress: '正在提交视频生成请求...' });

    try {
      const result = await generateVideo(
        {
          prompt,
          model,
          ratio,
          duration,
          resolution: resolutionRef.current,
          referenceMode,
          firstFrameProvided: firstFrameImages.length > 0,
          lastFrameProvided: lastFrameImages.length > 0,
          files: [],
          imageUrls,
          videoUrl: videoUrl || undefined,
          audioUrl: audioUrl || undefined,
          projectId: state.currentProject?.id,
          batchSize: batchSize > 1 ? batchSize : undefined,
        },
        (progress) => setGeneration((prev) => ({ ...prev, progress }))
      );

      // 批量生成：不轮询，直接刷新历史
      if ('taskIds' in result) {
        setGeneration({ status: 'success', result: undefined });
        if (state.currentProject) {
          void loadProjectTasks(state.currentProject.id);
        }
        void loadHistory(1, false);
        return;
      }

      if (result.data?.[0]?.url) {
        setGeneration({ status: 'success', result });
        if (state.currentProject) {
          void loadProjectTasks(state.currentProject.id);
        }
      } else {
        setGeneration({ status: 'error', error: '未获取到视频结果，请重试' });
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : '未知错误';
      console.error('[生成失败] 完整错误信息:', raw);
      const userMessage = parseArkError(raw);
      setGeneration({ status: 'error', error: userMessage });
    }
  }, [prompt, images, firstFrameImages, lastFrameImages, videos, audios, model, ratio, duration, resolution, referenceMode, isGenerating, uploading, state.currentProject, loadProjectTasks]);

  // 页面级拖拽：按 MIME 自动分流到对应状态
  const handlePageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (uploading || isGenerating) return;
    const grouped: Record<'image' | 'video' | 'audio', File[]> = { image: [], video: [], audio: [] };
    Array.from(e.dataTransfer.files).forEach((f) => {
      if (f.type.startsWith('video/')) grouped.video.push(f);
      else if (f.type.startsWith('audio/')) grouped.audio.push(f);
      else grouped.image.push(f);
    });
    if (grouped.image.length) { const dt = new DataTransfer(); grouped.image.forEach(f => dt.items.add(f)); addFiles(dt.files, 'image', setImages, images.length); }
    if (grouped.video.length) { const dt = new DataTransfer(); grouped.video.forEach(f => dt.items.add(f)); addFiles(dt.files, 'video', setVideos, videos.length); }
    if (grouped.audio.length) { const dt = new DataTransfer(); grouped.audio.forEach(f => dt.items.add(f)); addFiles(dt.files, 'audio', setAudios, audios.length); }
  }, [uploading, isGenerating, images.length, videos.length, audios.length, addFiles]);

  const handleReset = () => {
    images.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    firstFrameImages.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    lastFrameImages.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    videos.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    audios.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setImages([]);
    setFirstFrameImages([]);
    setLastFrameImages([]);
    setVideos([]);
    setAudios([]);
    setAssetSelections([]);
    setPrompt('');
    setEditorHtml(''); // 关键：清空 contenteditable，仅 setPrompt('') 不会清掉编辑器 DOM
    // 表单选项回到用户默认设置（无设置时回退硬编码默认值），与组件首次挂载的初值一致
    setModel((settings.model as ModelId) || 'seedance-2.0-fast');
    setRatio((settings.ratio as AspectRatio) || '9:16');
    setDuration((Number(settings.duration) as Duration) || 4);
    setResolution((settings.resolution as '480p' | '720p' | '1080p') || '720p');
    setReferenceMode((settings.reference_mode as 'reference' | 'first_last_frame') || 'reference');
    setGeneration({ status: 'idle' });
  };

  const activeImages = referenceMode === 'first_last_frame' ? [...firstFrameImages, ...lastFrameImages] : images;
  const canGenerate = (prompt.trim() || activeImages.length > 0 || videos.length > 0 || audios.length > 0 || assetSelections.length > 0) && !uploading;
  const effectiveLocked = estimate?.discountedLockedCredits != null ? estimate.discountedLockedCredits : (estimate?.lockedCredits ?? 0);
  const creditInsufficient = !!(balance && !balance.unlimited && effectiveLocked > 0 && balance.available < effectiveLocked * batchSize);
  const currentModelLabel = runtimeModels.find((m) => m.model_key === model)?.label
    || MODEL_OPTIONS.find((m) => m.value === model)?.label
    || 'Seedance 2.0';

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
    <>
    <Layout
      containerProps={{
        onDragOver: (e) => e.preventDefault(),
        onDrop: handlePageDrop,
      }}
      title={`${currentModelLabel} 视频配置`}
      projectName={state.currentProject?.name}
      headerActions={

        <>
          <button
            onClick={() => void refreshWorkgroup()}
            disabled={assetSyncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-50"
          >
            <svg
              className={`w-4 h-4 ${assetSyncing ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            >
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {assetSyncing ? '同步中...' : '刷新'}
          </button>
          <button onClick={() => navigate('/settings')} className="btn-ghost" title="设置">
            <GearIcon className="w-4 h-4" />
          </button>
        </>
      }
      left={

        <div className="space-y-4">
          {/* 模型选择 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">选择模型</label>
            <div className="flex flex-col gap-2">
              {(runtimeModels.length > 0
                ? runtimeModels.map((m) => ({ value: m.model_key as typeof model, label: m.label, description: m.description || '' }))
                : MODEL_OPTIONS
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { setModel(opt.value); if (opt.value === 'seedance-2.0-fast' && resolution === '1080p') setResolution('720p'); }}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
                    model === opt.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                  }`}
                >
                  <div className={`text-sm font-medium ${model === opt.value ? 'text-purple-400' : 'text-gray-300'}`}>{opt.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 首尾图模式保留分列布局 */}
          {referenceMode === 'first_last_frame' ? (
            <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4 space-y-3">
              <label className="text-sm font-bold text-gray-300">参考首尾图</label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 首图 */}
                <div>
                  <div className="text-xs text-gray-400 mb-2 font-medium">首图</div>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {firstFrameImages.map((f, idx) => (
                      <FileThumb key={f.id} f={f} onRemove={(id) => removeFile(id, setFirstFrameImages)} label={`首${idx + 1}`} />
                    ))}
                  </div>
                  {firstFrameImages.length < FILE_LIMITS.image.maxCount && (
                    <label className={`flex items-center justify-center gap-1.5 h-16 border border-dashed border-gray-700 rounded-xl text-xs text-gray-500 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}>
                      <PlusIcon className="w-3.5 h-3.5" /> 添加首图
                      <input type="file" accept={FILE_LIMITS.image.accept} multiple className="hidden" disabled={uploading}
                        onChange={(e) => { if (e.target.files) addFiles(e.target.files, 'image', setFirstFrameImages, firstFrameImages.length); e.target.value = ''; }} />
                    </label>
                  )}
                </div>
                {/* 尾图 */}
                <div>
                  <div className="text-xs text-gray-400 mb-2 font-medium">尾图</div>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {lastFrameImages.map((f, idx) => (
                      <FileThumb key={f.id} f={f} onRemove={(id) => removeFile(id, setLastFrameImages)} label={`尾${idx + 1}`} />
                    ))}
                  </div>
                  {lastFrameImages.length < FILE_LIMITS.image.maxCount && (
                    <label className={`flex items-center justify-center gap-1.5 h-16 border border-dashed border-gray-700 rounded-xl text-xs text-gray-500 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}>
                      <PlusIcon className="w-3.5 h-3.5" /> 添加尾图
                      <input type="file" accept={FILE_LIMITS.image.accept} multiple className="hidden" disabled={uploading}
                        onChange={(e) => { if (e.target.files) addFiles(e.target.files, 'image', setLastFrameImages, lastFrameImages.length); e.target.value = ''; }} />
                    </label>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* 普通模式：三合一上传区 */
            <UnifiedUploadZone
              images={images}
              videos={videos}
              audios={audios}
              onAdd={(fl, type) => {
                if (type === 'image') addFiles(fl, 'image', setImages, images.length);
                else if (type === 'video') addFiles(fl, 'video', setVideos, videos.length);
                else addFiles(fl, 'audio', setAudios, audios.length);
              }}
              onRemove={(id, type) => {
                if (type === 'image') removeFile(id, setImages);
                else if (type === 'video') removeFile(id, setVideos);
                else removeFile(id, setAudios);
              }}
              uploading={uploading}
            />
          )}

          {/* 素材组（ARK AssetGroup；与参考素材、提示词同级；为空时不渲染） */}
          {state.currentProject && projectAssetGroups.length > 0 && (
            <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-bold text-gray-300">素材组 <span className="text-amber-400">（{gridAssets.length} 个素材）</span></label>
                <span className="text-[10px] text-gray-500">点击素材插入 @ 引用</span>
              </div>
              <AssetGrid
                assets={gridAssets}
                groupNames={groupNameMap}
                onSelect={(a) => { if ((a as any).volc_asset_id) insertAssetMention(a as any); }}
              />
            </div>
          )}

          {/* Prompt */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <div className="flex items-center justify-between mb-3">
               <label className="text-sm font-bold text-gray-300">提示词</label>
              {toasts.length > 0 && (
                <div className="flex items-center gap-2">
                  {toasts.map((t) => (
                    <span key={t.id} className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-lg animate-fade-in">{t.text}</span>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <div
                ref={editorRef}
                contentEditable={!isGenerating}
                id="prompt-editor"
                onInput={handleEditorInput}
                onKeyDown={handleEditorKeyDown}
                onPaste={handleEditorPaste}
                onCopy={handleEditorCopy}
                onCut={handleEditorCut}
                data-placeholder="描述你想要生成的视频场景。输入 @ 可引用本次上传的素材或项目组素材组里的素材..."
                className="prompt-editor w-full text-sm focus:outline-none min-h-[100px] text-gray-200 leading-relaxed bg-[#0d0f1a] rounded-xl px-4 py-3"
                suppressContentEditableWarning
              />
              {showMention && (mentionItems.length > 0 || mentionableAssets.length > 0) && (
                <div
                  ref={mentionPanelRef}
                  className="absolute left-0 bottom-full mb-2 w-full bg-[#0f111a] border border-purple-500/40 rounded-xl shadow-xl z-20 overflow-hidden"
                >
                  <div className="px-3 py-2 text-[11px] text-gray-500 border-b border-gray-800 flex items-center justify-between">
                    <span>选择引用素材</span>
                    <span className="text-[10px]">↑↓←→ 导航 · Enter 选择</span>
                  </div>
                  {/* 上传文件快捷chip区 */}
                  {mentionItems.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-1">
                      {mentionItems.map((item, i) => {
                        const isFocused = mentionFocusIdx === i;
                        return (
                          <button
                            key={item.tag}
                            data-mention-idx={i}
                            onMouseDown={(e) => { e.preventDefault(); insertMention(item.tag); setMentionFocusIdx(-1); }}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-all ${
                              isFocused ? 'border-purple-400 bg-purple-500/20 text-white' : 'border-gray-700 bg-[#1c1f2e] text-gray-300 hover:border-gray-500'
                            }`}
                          >
                            {item.file.previewUrl ? (
                              <img src={item.file.previewUrl} className="w-5 h-5 rounded object-cover flex-shrink-0" />
                            ) : (
                              <span className="text-sm">{item.emoji}</span>
                            )}
                            <span className="truncate max-w-[60px]">{item.tag}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* 素材组资产网格 */}
                  {groupedMentionableAssets.length > 0 && (
                    <div className="p-3">
                      <AssetGrid
                        assets={gridAssets}
                        groupNames={groupNameMap}
                        onSelect={(a) => { if ((a as any).volc_asset_id) { insertAssetMention(a as any); setMentionFocusIdx(-1); } }}
                      />
                    </div>
                  )}
                </div>
              )}
              {showMention && mentionItems.length === 0 && availableAssets.length === 0 && (
                <div
                  ref={mentionPanelRef}
                  className="absolute left-0 bottom-full mb-2 w-full bg-[#0f111a] border border-gray-700 rounded-xl shadow-xl z-20 px-4 py-3 text-xs text-gray-500"
                >
                  还没有上传任何素材，请先上传图片、视频或音频
                </div>
              )}
            </div>
            <div className="text-right text-xs text-gray-500 mt-2">{prompt.length}/5000</div>
          </div>

          {/* Settings */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800 space-y-5">
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">画面比例</label>
              <div className="grid grid-cols-6 gap-2">
                {RATIO_OPTIONS.map((opt) => {
                  const isSelected = opt.value === ratio;
                  const maxDim = 24;
                  const scale = maxDim / Math.max(opt.widthRatio, opt.heightRatio);
                  const w = Math.round(opt.widthRatio * scale);
                  const h = Math.round(opt.heightRatio * scale);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setRatio(opt.value)}
                      className={`flex flex-col items-center gap-1.5 py-2 rounded-xl border transition-all ${
                        isSelected ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 bg-[#161824] hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center justify-center w-8 h-8">
                        <div className={`rounded-sm border ${isSelected ? 'border-purple-400' : 'border-gray-500'}`} style={{ width: `${w}px`, height: `${h}px` }} />
                      </div>
                      <span className={`text-[11px] ${isSelected ? 'text-purple-400' : 'text-gray-400'}`}>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Resolution */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">分辨率</label>
              <div className="grid grid-cols-3 gap-2">
                {(['480p', '720p', '1080p'] as const).map((opt) => {
                  const disabled = opt === '1080p' && model === 'seedance-2.0-fast';
                  const isSelected = opt === resolution;
                  return (
                    <button
                      key={opt}
                      onClick={() => { if (!disabled) setResolution(opt); }}
                      disabled={disabled}
                      title={disabled ? '快速模型不支持 1080p' : undefined}
                      className={`py-2 rounded-xl border text-sm transition-all ${
                        isSelected
                          ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                          : disabled
                            ? 'border-gray-800 bg-[#161824]/50 text-gray-600 cursor-not-allowed'
                            : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Reference Mode */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">参考模式</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { v: 'reference', label: '全能参考', desc: '0-9 张图任意上传，无图则按提示词生成' },
                  { v: 'first_last_frame', label: '首尾帧', desc: '按是否上传首图/尾图自动识别首帧、尾帧或首尾帧' },
                ] as const).map((opt) => {
                  const isSelected = opt.v === referenceMode;
                  return (
                    <button
                      key={opt.v}
                      onClick={() => {
                        if (opt.v !== referenceMode) {
                          // clear stale uploads from the previous mode
                          if (opt.v === 'first_last_frame') {
                            images.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
                            setImages([]);
                          } else {
                            firstFrameImages.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
                            lastFrameImages.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
                            setFirstFrameImages([]);
                            setLastFrameImages([]);
                          }
                          setReferenceMode(opt.v);
                        }
                      }}
                      title={opt.desc}
                      className={`py-2 px-3 rounded-xl border text-sm transition-all text-left ${
                        isSelected
                          ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                          : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Duration */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">视频时长</label>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                      duration === d ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {d}秒
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Generate */}
          <div className="pb-6 md:pb-4">
            {(isGenerating || uploading) && (
              <div className="mb-4">
                <div className="text-xs text-gray-400">
                  {uploading ? '正在上传素材到 OSS...' : (generation.progress || '处理中...')}
                </div>
              </div>
            )}

            <div className="flex gap-3">
              {/* 批量生成选择器：只有 max_concurrent > 1 时显示 */}
              {maxConcurrent > 1 && (
                <select
                  value={batchSize}
                  onChange={(e) => setBatchSize(parseInt(e.target.value, 10))}
                  disabled={isGenerating || uploading}
                  className="px-3 py-3 rounded-xl text-sm font-medium border border-gray-700 bg-[#161824] text-gray-300 focus:outline-none focus:border-purple-500 disabled:opacity-40"
                >
                  {Array.from({ length: maxConcurrent }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>数量：{n}</option>
                  ))}
                </select>
              )}
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className={`flex-1 font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 ${
                  creditInsufficient
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/20'
                    : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white shadow-lg shadow-purple-900/20'
                }`}
              >
                {isGenerating ? (
                  <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />生成中...</>
                ) : uploading ? (
                  <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />上传中...</>
                ) : creditInsufficient ? (
                  <>⚠️ 可用积分不足（可用 {balance!.available}，需 {effectiveLocked * batchSize}）</>
                ) : (
                  <><SparkleIcon className="w-4 h-4" />生成视频</>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={isGenerating || uploading}
                className="px-6 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold py-3 rounded-xl transition-all"
              >
                重置
              </button>
            </div>

            {/* 积分余额 + 实时预估 */}
            {currentUser && (
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  {balance?.unlimited ? (
                    <span className="text-amber-400 font-medium">无限额度</span>
                  ) : balance ? (
                    <>
                      余额 <span className={`font-semibold ${balance.available <= 3 ? 'text-red-400' : 'text-gray-300'}`}>{balance.available}</span> 积分
                      {balance.locked > 0 && (
                        <span className="ml-2 text-amber-400">（锁定 {balance.locked}）</span>
                      )}
                    </>
                  ) : (
                    <>余额 <span className="font-semibold text-gray-300">{currentUser.credits ?? 0}</span> 积分</>
                  )}
                </span>
                {estimate && estimate.credits > 0 ? (
                  discountExpired ? (
                    <span className="text-amber-400">
                      折扣已过期！请确认积分消耗：本次预计消耗 <span className="text-purple-300 font-semibold">{estimate.credits * batchSize}</span> 积分
                      <span className="ml-2 text-gray-500">（锁定 {estimate.lockedCredits * batchSize}）</span>
                    </span>
                  ) : (
                  <span>
                    {estimate.discountedCredits != null && estimate.discountedCredits !== estimate.credits ? (
                      <>
                        本次预计消耗 <span className="text-emerald-300 font-semibold">{estimate.discountedCredits * batchSize}</span>
                        <span className="ml-1 text-gray-500">（折扣前 {estimate.credits * batchSize}）</span>
                      </>
                    ) : (
                      <>
                        本次预计消耗 <span className="text-purple-300 font-semibold">{estimate.credits * batchSize}</span> 积分
                      </>
                    )}
                    {estimate.discountedLockedCredits != null && estimate.discountedLockedCredits !== estimate.lockedCredits ? (
                      <span className="ml-2 text-gray-500">（锁定 {estimate.discountedLockedCredits * batchSize}）</span>
                    ) : (
                      <span className="ml-2 text-gray-500">（锁定 {estimate.lockedCredits * batchSize}）</span>
                    )}
                  </span>
                  )
                ) : (
                  <span>请选择模型与时长</span>
                )}
              </div>
            )}
          </div>
        </div>
      }

      right={
        <>
        {/* Current generation banner */}
        {(isGenerating || generation.status === 'error') && (
          <div className={`mx-4 mt-4 p-4 rounded-2xl border ${generation.status === 'error' ? 'border-red-500/30 bg-red-500/5' : 'border-purple-500/30 bg-purple-500/5'}`}>
            {isGenerating ? (
              <div className="flex items-center gap-3">
                <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full flex-shrink-0" />
                <div>
                  <div className="text-sm font-medium text-purple-300">生成中...</div>
                  <div className="text-xs text-gray-500 mt-0.5">{generation.progress || '处理中，请耐心等待'}</div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-red-400">{generation.error}</div>
            )}
          </div>
        )}

        {historyItems.length === 0 && !historyLoading && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            暂无生成记录
          </div>
        )}

        <div className="px-4 pb-4 space-y-3">
          {historyItems.map((item) => {
            const playUrl = item.video_url;
            const isGroup = !!item.concurrent_id;
            const allGroupItems = isGroup ? [item, ...(item.concurrent_items || [])] : [item];

            return (
            <div key={isGroup ? (item.concurrent_id || `group-${item.id}`) : item.id} className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
              <div className="flex gap-3 p-3 items-start">
                {/* Thumbnail / status — 非批量时显示 */}
                {!isGroup && (
                <div
                  className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] flex items-center justify-center cursor-pointer relative group"
                  onClick={() => {
                    if (playUrl) {
                      setPreviewVideo({ url: playUrl, prompt: item.prompt });
                    }
                  }}
                >
                  {item.status === 'done' && playUrl ? (
                    <>
                      <video
                        src={playUrl}
                        muted
                        className="w-full h-full object-cover"
                        preload="metadata"
                        onMouseEnter={(e) => (e.currentTarget as HTMLVideoElement).play()}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLVideoElement).pause(); (e.currentTarget as HTMLVideoElement).currentTime = 0; }}
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      </div>
                    </>
                  ) : item.status === 'generating' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-purple-400">
                      <span className="animate-spin h-3 w-3 border-2 border-purple-400 border-t-transparent rounded-full" />
                      生成中
                    </span>
                  ) : item.status === 'error' ? (
                    <span className="text-xs text-red-400 text-center px-1">失败</span>
                  ) : (
                    <span className="text-xs text-gray-500 text-center px-1">待下载</span>
                  )}
                </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  {/* Prompt */}
                  <p className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{item.prompt || '（无提示词）'}</p>

                  {/* 报错信息直接显示在卡片内（仅非批量时） */}
                  {!isGroup && item.status === 'error' && item.error_message && (
                    <p className="text-xs text-red-400 line-clamp-3 leading-relaxed bg-red-950/30 rounded-lg px-2 py-1">{parseArkError(item.error_message)}</p>
                  )}

                  {/* Asset thumbnails（仅非批量时） */}
                  {!isGroup && item.assets && item.assets.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {item.assets.filter((a) => a.assetType === 'image').slice(0, 5).map((a, i) => (
                        a.uri.startsWith('asset://') ? (
                          <div key={i} className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-[10px] text-amber-400 flex-shrink-0">资</div>
                        ) : (
                          <ImageWithFallback key={i} src={a.uri} />
                        )
                      ))}
                      {item.assets.some((a) => a.assetType === 'video') && (
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-base flex-shrink-0">🎬</div>
                      )}
                      {item.assets.some((a) => a.assetType === 'audio') && (
                        <div className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center text-base flex-shrink-0">🎵</div>
                      )}
                    </div>
                  )}

                  {/* 批量生成的子项网格 */}
                  {isGroup && (
                    <div className="mt-1">
                      <span className="text-[10px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">批量生成 · {allGroupItems.length} 个视频</span>
                      <div className="grid grid-cols-3 gap-2 mt-2">
                        {allGroupItems.map((sub) => {
                          const subPlayUrl = sub.video_url;
                          const isSubDone = sub.status === 'done' && subPlayUrl;
                          const isSubGenerating = sub.status === 'generating';
                          const isSubError = sub.status === 'error';
                          return (
                            <div key={sub.id} className="bg-[#0f111a] rounded-xl overflow-hidden border border-gray-800">
                              <div
                              className="h-[15vh] min-h-[80px] cursor-pointer relative group flex items-center justify-center"
                                onClick={() => {
                                  if (subPlayUrl) setPreviewVideo({ url: subPlayUrl, prompt: item.prompt });
                                }}
                              >
                                {isSubDone ? (
                                  <>
                                    <video src={subPlayUrl} muted className="w-full h-full object-cover" preload="metadata" />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                      <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                                    </div>
                                  </>
                                ) : isSubGenerating ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] text-purple-400">
                                    <span className="animate-spin h-2.5 w-2.5 border-2 border-purple-400 border-t-transparent rounded-full" />
                                    生成中
                                  </span>
                                ) : isSubError ? (
                                  <span className="text-[10px] text-red-400">失败</span>
                                ) : (
                                  <span className="text-[10px] text-gray-500">待下载</span>
                                )}
                              </div>
                              <div className="flex gap-1 p-1.5 justify-center">
                                <DownloadButton small table="tasks" id={sub.id} url={sub.video_url!} filename={makeDownloadFilename(sub.prompt, sub.id)} generationStatus={sub.status} downloadStatus={(sub.download_status as any) || 'pending'} onStatusChange={() => {}} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Bottom row */}
                  <div className="flex items-end justify-between gap-2 mt-auto">
                    <span className="text-[10px] text-gray-600 flex-shrink-0">{formatShortDateTime(item.created_at)}</span>
                    <div className="flex flex-col items-end gap-1">
                      {/* 用户信息 + 积分（仅视频生成模块） */}
                      {item.model_type === 'video' && (item as any).user_name && (
                        <span className="text-[10px] text-gray-400 text-right leading-tight">
                          {(item as any).user_name}{((item as any).user_email) ? `(${(item as any).user_email})` : ''}
                        </span>
                      )}
                      {item.model_type === 'video' && (item as any).credits_used > 0 && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none" title="实际消耗积分">
                          {(item as any).credits_used}积分
                        </span>
                      )}
                      {/* 参数角标 */}
                      <div className="flex flex-wrap justify-end gap-1">
                        {item.model && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 leading-none">
                            {item.model.replace('seedance-2.0-fast-vip','2.0Fast VIP').replace('seedance-2.0-fast','2.0Fast').replace('seedance-2.0-vip','2.0 VIP').replace('seedance-2.0','2.0').replace('seedance-1.5-pro','1.5Pro')}
                          </span>
                        )}
                        {item.ratio && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{item.ratio}</span>}
                        {item.duration && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{item.duration}s</span>}
                        {item.resolution && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{item.resolution}</span>}
                      </div>
                      {/* 增强相关 UI 已移至 /enhancement 页面 */}
                      <div className="flex gap-2">
                        {/* 批量操作 */}
                        {isGroup && (
                          <div className="flex flex-wrap gap-1 justify-end">
                            {allGroupItems.map((gi) => (
                              <DownloadButton small key={gi.id} table="tasks" id={gi.id} url={gi.video_url!} filename={makeDownloadFilename(gi.prompt, gi.id)} generationStatus={gi.status} downloadStatus={(gi.download_status as any) || 'pending'} onStatusChange={() => {}} />
                            ))}
                          </div>
                        )}
                        {/* 预览 & 下载（非批量） */}
                        {!isGroup && playUrl && (
                          <button
                            onClick={() => {
                              setPreviewVideo({ url: playUrl, prompt: item.prompt });
                            }}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all"
                          >
                                                        预览
                          </button>
                        )}
                        {!isGroup && (
                          <DownloadButton table="tasks" id={item.id} url={item.video_url ?? null} filename={makeDownloadFilename(item.prompt, item.id)} generationStatus={item.status} downloadStatus={(item.download_status as any) || 'pending'} onStatusChange={() => {}} />
                        )}
                      <button
                        onClick={async () => {
                          // 1. 还原参数
                          if (item.model) setModel(item.model as ModelId);
                          if (item.ratio) setRatio(item.ratio as AspectRatio);
                          if (item.duration) setDuration(Number(item.duration) as Duration);
                          if (item.resolution) {
                            const r = item.resolution as '480p' | '720p' | '1080p';
                            setResolution(item.model === 'seedance-2.0-fast' && r === '1080p' ? '720p' : r);
                          }
                          // 确保全能参考模式，让上传区域可见
                          setReferenceMode('reference');

                          const assets = item.assets || [];

                          // 2. 分离 OSS 文件和资产引用
                          const ossImages = assets.filter((a) => a.assetType === 'image' && !a.uri.startsWith('asset://'));
                          const ossVideos = assets.filter((a) => a.assetType === 'video' && !a.uri.startsWith('asset://'));
                          const ossAudios = assets.filter((a) => a.assetType === 'audio' && !a.uri.startsWith('asset://'));
                          const assetRefs = assets.filter((a) => a.uri.startsWith('asset://'));

                          let ossFailedCount = 0;
                          // 通过后端代理检查 OSS URL 是否真正失效（避免前端 CORS 误判）
                          const checkOss = async (url: string) => {
                            try {
                              const r = await fetch('/api/oss/check-url', {
                                method: 'POST',
                                headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
                                body: JSON.stringify({ url }),
                              });
                              const d = await r.json();
                              return d.success && d.data?.ok;
                            } catch { return false; }
                          };
                          const allOss = [...ossImages, ...ossVideos, ...ossAudios];
                          const ossResults = await Promise.all(allOss.map(async (a) => ({ ...a, valid: await checkOss(a.uri) })));
                          const validOssImages = ossResults.filter(a => a.assetType === 'image' && a.valid);
                          const validOssVideos = ossResults.filter(a => a.assetType === 'video' && a.valid);
                          const validOssAudios = ossResults.filter(a => a.assetType === 'audio' && a.valid);
                          ossFailedCount = ossResults.filter(a => !a.valid).length;

                          const makeName = (a: typeof assets[0], ext: string) =>
                            a.originalName || a.uri.split('/').pop()?.split('?')[0] || `file.${ext}`;

                          const restoredImages = validOssImages.map((a) => ({
                            id: `restored-${++nextId}`,
                            file: new File([], makeName(a, 'jpg'), { type: 'image/jpeg' }),
                            previewUrl: a.uri,
                            name: makeName(a, 'jpg'),
                            size: 0,
                            mediaType: 'image' as const,
                            ossUrl: a.uri,
                            uploadProgress: 100,
                          }));
                          const restoredVideos = validOssVideos.map((a) => ({
                            id: `restored-${++nextId}`,
                            file: new File([], makeName(a, 'mp4'), { type: 'video/mp4' }),
                            previewUrl: '',
                            name: makeName(a, 'mp4'),
                            size: 0,
                            mediaType: 'video' as const,
                            ossUrl: a.uri,
                            uploadProgress: 100,
                          }));
                          const restoredAudios = validOssAudios.map((a) => ({
                            id: `restored-${++nextId}`,
                            file: new File([], makeName(a, 'mp3'), { type: 'audio/mpeg' }),
                            previewUrl: '',
                            name: makeName(a, 'mp3'),
                            size: 0,
                            mediaType: 'audio' as const,
                            ossUrl: a.uri,
                            uploadProgress: 100,
                          }));

                          // 3. 确保 projectAssets 已加载（assetRefs 匹配需要）
                          // 只在 task 属于当前工作组时才操作 setProjectAssets，避免跨工作组污染
                          let currentProjectAssets = projectAssets;
                          const currentPid = state.currentProject?.id;
                          const taskPid = item.project_id;
                          const sameProject = !taskPid || !currentPid || taskPid === currentPid;
                          if (assetRefs.length > 0 && sameProject && currentPid) {
                            try {
                              setAssetSyncing(true);
                              const r = await getProjectAssets(currentPid, { pageSize: 100, skipLive: true });
                              currentProjectAssets = r.assets
                                .filter((a: ProjectAsset) => a.review_status !== 'rejected' && (a.volc_asset_id || a.file_url))
                                .map((a: ProjectAsset) => ({ ...a, project_id: currentPid }));
                              setProjectAssets(currentProjectAssets);
                            } catch { /* ignore */ } finally {
                              setAssetSyncing(false);
                            }
                          } else if (assetRefs.length > 0 && !sameProject) {
                            alert(`此任务属于其他项目组，请先切换到对应项目组再复用`);
                            return;
                          }

                          // 4. 还原素材引用：匹配 prompt 中的 @asset-xxx / @素材N / @资产N 标签
                          const storedPrompt = item.prompt || '';
                          const tagMatches = [...storedPrompt.matchAll(/@(?:asset-[a-zA-Z0-9-]+|素材\d+|资产\d+)/g)].map((m) => m[0]);
                          const deletedNames: string[] = [];
                          const newSelections: AssetSelection[] = [];
                          let newPrompt = storedPrompt;

                          assetRefs.forEach((ref, idx) => {
                            const volcId = ref.uri.replace('asset://', '');
                            const asset = currentProjectAssets.find((a) => a.volc_asset_id === volcId);
                            const oldTag = tagMatches[idx];
                            if (!asset) {
                              // 失效素材：替换 tag 为 @失效素材 并保留其后文本
                              if (oldTag) newPrompt = newPrompt.replace(oldTag, '@失效素材');
                              // 加入 special selection 供编辑器渲染为灰色可点击 chip
                              newSelections.push({
                                id: `stale-${volcId || idx}`,
                                volcAssetId: '',
                                fileType: 'image',
                                name: '失效素材',
                                chipTag: '@失效素材',
                              });
                              deletedNames.push(ref.originalName?.replace('asset://', '') || volcId);
                              return;
                            }
                            const newTag = getAssetChipTag(asset);
                            if (oldTag && oldTag !== newTag) {
                              newPrompt = newPrompt.split(oldTag).join(newTag);
                            }
                            newSelections.push({
                              id: `asset-${asset.volc_asset_id || asset.id}`,
                              volcAssetId: asset.volc_asset_id || '',
                              fileType: asset.file_type as 'image' | 'video' | 'audio',
                              name: asset.name,
                              thumbnailUrl: asset.thumbnail_url || asset.file_url || undefined,
                              assetUri: ref.uri,
                              chipTag: newTag,
                            });
                          });

                          // 5. 同步写入所有状态
                          setImages(restoredImages);
                          setVideos(restoredVideos);
                          setAudios(restoredAudios);
                          setAssetSelections(newSelections);
                          setPanelGroupIdx(0);
                          setPanelSubIdxMap({});
                          setPrompt(newPrompt);

                          // 6. 把目标 HTML 存入 ref，下一次 render（useLayoutEffect）时写入编辑器
                          // 不用 setTimeout，避免被 useEffect([projectAssets]) 覆盖
                          const staleTags = new Set(newSelections.filter(s => !s.volcAssetId).map(s => s.chipTag));
                          const finalHtml = buildHtmlExplicit(newPrompt, newSelections, restoredImages, restoredVideos, restoredAudios, [], [], assetDisplayMap, staleTags);
                          pendingEditorHtmlRef.current = finalHtml;

                          // 7. 提示已删除/失效素材（先清历史 toast，重新计时）
                          setToasts([]);
                          const totalFailed = deletedNames.length + ossFailedCount;
                          if (totalFailed > 0) {
                            let msg = `总共 ${totalFailed} 个素材失效。`;
                            if (deletedNames.length > 0) msg += `${deletedNames.length} 个引用素材已经失效，相关引用已经断开。`;
                            if (ossFailedCount > 0) msg += `${ossFailedCount} 个参考素材已经失效。`;
                            showToast(msg.trim());
                          }

                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all"
                      >
                        复用
                      </button>
                    </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            );
          })}

          {/* Infinite scroll sentinel */}
          <div ref={historyBottomRef} className="h-4" />
          {historyLoading && (
            <div className="flex justify-center py-4">
              <span className="animate-spin h-5 w-5 border-2 border-purple-400 border-t-transparent rounded-full" />
            </div>
          )}
          {!historyHasMore && historyItems.length > 0 && (
            <div className="text-center text-xs text-gray-600 py-2">已显示全部记录</div>
          )}
        </div>
        </>
      }

    />
    {/* Video preview modal */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewVideo(null)}
        >
          <div
            className={`relative flex flex-col gap-3 ${previewVideo.url ? 'w-full max-w-5xl' : 'w-full max-w-xl'}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close */}
            <button
              onClick={() => setPreviewVideo(null)}
              className="absolute -top-9 right-0 text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1"
            >
              关闭 ✕
            </button>

            {/* Video */}
            {previewVideo.url && (
              <video
                src={previewVideo.url}
                controls
                autoPlay
                className="w-full rounded-2xl max-h-[72vh] bg-black"
              />
            )}

            {/* Info panels */}
            {previewVideo.prompt && (
              <div className="bg-[#0f111a]/90 border border-gray-700 rounded-xl px-4 py-3">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">提示词</div>
                <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap break-words max-h-28 overflow-y-auto custom-scrollbar">{previewVideo.prompt}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}