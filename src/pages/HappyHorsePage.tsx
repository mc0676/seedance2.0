import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { uploadToOss, FILE_LIMITS, probeOssVideo } from '../services/ossService';
import { CloseIcon, PlusIcon, SparkleIcon, GearIcon } from '../components/Icons';
import { formatShortDateTime, useUserTimezone } from '../utils/datetime';
import { getCreditBalance } from '../services/pricingService';
import { deleteHappyhorseFromHistory } from '../services/downloadService';
import { useNavigate } from 'react-router-dom';
import {
  submitHappyhorseTask,
  listMyHappyhorseTasks,
  getHappyhorsePricing,
  estimateHappyhorseCredits,
} from '../services/happyhorseService';
import type {
  HappyhorseMode, HappyhorseResolution, HappyhorseRatio,
  HappyhorseMediaItem, HappyhorseTask, HappyhorsePricingItem,
} from '../types';

const MODE_TABS: { mode: HappyhorseMode; label: string; desc: string }[] = [
  { mode: 't2v', label: '文生视频', desc: 'happyhorse-1.0-t2v · 仅 prompt → 视频' },
  { mode: 'i2v', label: '首帧视频', desc: 'happyhorse-1.0-i2v · 上传 1 张首帧图 + prompt' },
  { mode: 'r2v', label: '多图生视频', desc: 'happyhorse-1.0-r2v · 1~9 张参考图，prompt 中用 @ 引用图片，提交时自动转换为 [Image N]' },
  { mode: 'video-edit', label: '视频编辑', desc: 'happyhorse-1.0-video-edit · 1 个视频 + 0~5 张参考图（输入+输出均计费）' },
];
const RATIO_OPTIONS: HappyhorseRatio[] = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4'];
const RESOLUTIONS: HappyhorseResolution[] = ['720P', '1080P'];
const DURATION_OPTIONS = [3, 4, 5, 6, 7, 8, 10, 12, 15];

const STATUS_BADGE: Record<HappyhorseTask['status'], { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'bg-gray-700/40 text-gray-300 border-gray-600' },
  processing: { text: '处理中', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  done: { text: '已完成', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  error: { text: '失败', cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
  canceled: { text: '已取消', cls: 'bg-gray-700/40 text-gray-300 border-gray-600' },
};

function MediaThumb({
  m, idx, onRemove, showName = false,
}: { m: HappyhorseMediaItem; idx: number; onRemove: () => void; showName?: boolean }) {
  const isVideo = m.type === 'video';
  const isFirstFrame = m.type === 'first_frame';
  return (
    <div className="relative group flex flex-col items-center gap-1 w-20">
      <div className="w-20 h-20 flex-shrink-0 relative rounded-xl border border-gray-700 bg-[#0d0f1a] overflow-hidden flex items-center justify-center">
        {isVideo ? (
          <div className="flex flex-col items-center gap-1 px-1 w-full">
            <span className="text-2xl">🎬</span>
            {!showName && (
              <div className="text-[9px] text-gray-400 truncate w-full text-center px-1">{m.original_name || '视频'}</div>
            )}
          </div>
        ) : (
          <img src={m.url} alt="" className="w-full h-full object-cover pointer-events-none" />
        )}
        <span className={`absolute top-0 left-0 text-[9px] font-bold px-1 py-0.5 rounded-tl-xl rounded-br-lg leading-none ${
          isVideo ? 'bg-blue-600/90 text-white'
            : isFirstFrame ? 'bg-amber-600/90 text-white'
            : 'bg-purple-600/90 text-white'
        }`}>
          {isVideo ? '视' : isFirstFrame ? '首' : `参${idx}`}
        </span>
      </div>
      {showName && m.original_name && (
        <div
          className="text-[10px] text-gray-400 max-w-[5rem] truncate text-center leading-tight"
          title={m.original_name}
        >
          {m.original_name}
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800 border border-gray-700 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 hover:border-red-600 z-10"
      ><CloseIcon className="w-3 h-3 text-white" /></button>
    </div>
  );
}

export default function HappyHorsePage() {
  useUserTimezone();
  const navigate = useNavigate();
  const { state, currentUser } = useApp();
  const projectId = state.currentProject?.id ?? null;

  const [mode, setMode] = useState<HappyhorseMode>('t2v');
  const [prompt, setPrompt] = useState('');
  const [resolution, setResolution] = useState<HappyhorseResolution>('720P');
  const [ratio, setRatio] = useState<HappyhorseRatio>('16:9');
  const [duration, setDuration] = useState<number>(5);
  const [audioSetting, setAudioSetting] = useState<'auto' | 'origin'>('auto');
  const [seed, setSeed] = useState<string>('');
  const [media, setMedia] = useState<HappyhorseMediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<HappyhorsePricingItem[] | null>(null);
  const [balance, setBalance] = useState<{ credits: number; unlimited: boolean; locked: number; available: number } | null>(null);
  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // video-edit：已上传待编辑视频的真实时长（秒），用于精确预估积分
  const [editVideoDuration, setEditVideoDuration] = useState<number | null>(null);
  // 批量生成
  const maxConcurrent = Math.max(1, parseInt(state.settings.max_concurrent || '5', 10) || 5);
  const [batchSize, setBatchSize] = useState(1);
  // @ 提及面板：弹出位置 + 当前 @ 之后的过滤文本 + 高亮项
  const [mentionPanel, setMentionPanel] = useState<{ top: number; left: number; filter: string; focusIdx: number } | null>(null);
  const mentionAnchorNodeRef = useRef<Node | null>(null);
  const mentionAnchorOffsetRef = useRef<number>(0);

  const [tasks, setTasks] = useState<HappyhorseTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(1);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const deletingRef = useRef(false);
  const loadingRef = useRef(false); // 防止并发加载
  const loadGenRef = useRef(0); // 代际计数器，丢弃过期响应
  const loadedRef = useRef(false); // 防止同一 projectId 重复初始加载
  const prevProjectIdRef = useRef<number | null>(null);
  const PAGE_SIZE = 12;
  const [previewVideo, setPreviewVideo] = useState<{ url: string; prompt: string; error?: string | null } | null>(null);

  // 加载计费表
  useEffect(() => {
    getHappyhorsePricing().then(setPricing).catch(() => setPricing([]));
  }, []);

  // 余额轮询
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    const tick = () => getCreditBalance().then((b) => { if (alive) setBalance(b); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [currentUser]);

  // 将任务列表按 concurrent_id 分组合并。第一个任务作为组头（代表该批次），其余放入 concurrent_items
  function groupTasks(items: HappyhorseTask[]): HappyhorseTask[] {
    const groups = new Map<string, HappyhorseTask[]>();
    const singles: HappyhorseTask[] = [];
    for (const t of items) {
      if (t.concurrent_id) {
        if (!groups.has(t.concurrent_id)) {
          groups.set(t.concurrent_id, []);
        }
        groups.get(t.concurrent_id)!.push(t);
      } else {
        singles.push(t);
      }
    }
    const grouped: HappyhorseTask[] = [];
    for (const [, grp] of groups) {
      grp.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const primary = grp[0];
      const siblings = grp.slice(1);
      grouped.push({ ...primary, concurrent_items: siblings });
    }
    grouped.push(...singles);
    // 按每个组的最新 created_at 降序排序
    grouped.sort((a, b) => {
      const aMax = a.concurrent_items?.length
        ? Math.max(...a.concurrent_items.map((x) => new Date(x.created_at).getTime()))
        : new Date(a.created_at).getTime();
      const bMax = b.concurrent_items?.length
        ? Math.max(...b.concurrent_items.map((x) => new Date(x.created_at).getTime()))
        : new Date(b.created_at).getTime();
      return bMax - aMax;
    });
    return grouped;
  }

  const loadTasks = useCallback(async (append = false) => {
    if (!projectId || deletingRef.current || loadingRef.current) return;
    loadingRef.current = true;
    setTasksLoading(true);
    const gen = loadGenRef.current;
    try {
      const p = append ? pageRef.current : 1;
      const data = await listMyHappyhorseTasks(projectId, p, PAGE_SIZE);
      if (gen !== loadGenRef.current) return; // 旧响应，丢弃
      const grouped = groupTasks(data.items);
      if (append) {
        setTasks((prev) => [...prev, ...grouped]);
        pageRef.current = p + 1;
      } else {
        setTasks(grouped);
        pageRef.current = 2;
      }
      setHasMore(data.items.length === PAGE_SIZE && (p - 1) * PAGE_SIZE + data.items.length < data.total);
    } catch (e) {
      console.error('[happyhorse] 加载任务列表失败', e);
    } finally {
      loadingRef.current = false;
      setTasksLoading(false);
    }
  }, [projectId]);
  // 项目切换 / 初次加载
  useEffect(() => {
    if (!projectId) return;
    if (prevProjectIdRef.current === projectId && loadedRef.current) return;
    prevProjectIdRef.current = projectId;
    loadedRef.current = true;
    loadGenRef.current += 1;
    loadTasks();
  }, [projectId, loadTasks]);

  // 无限滚动：底部哨兵进入视野时加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !tasksLoading && !loadingRef.current) {
          loadTasks(true);
        }
      },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, tasksLoading, projectId, loadTasks]);

  // 轮询进行中任务
  useEffect(() => {
    if (!tasks.some((t) => t.status === 'processing' || t.status === 'pending')) return;
    const t = setInterval(() => loadTasks(), 8000);
    return () => clearInterval(t);
  }, [tasks, projectId, loadTasks]);

  // 切换 mode 时清空 media（避免类型混淆）
  // 复用历史任务时，setMode 会触发下面的 useEffect 把表单清空，
  // 与同事件里的 setMedia/setPrompt(...) 撞车——用 ref flag 跳过这一次重置。
  const skipModeResetRef = useRef(false);

  // 切换 mode 时清空表单（复用流程中跳过）
  useEffect(() => {
    if (skipModeResetRef.current) { skipModeResetRef.current = false; return; }
    setMedia([]);
    setSubmitError(null);
    setEditVideoDuration(null);
    setPrompt('');
  }, [mode]);

  const showRatio = mode === 't2v' || mode === 'r2v';
  const showDuration = mode !== 'video-edit';
  const showAudioSetting = mode === 'video-edit';
  // r2v + video-edit 都启用 contenteditable + @ 引用编辑器
  const useMentionEditor = mode === 'r2v' || mode === 'video-edit';

  // r2v / video-edit 可用的提及项：
  //   r2v        → 每张参考图 @1 / @2 …
  //   video-edit → 1 个 @Video（待编辑视频）+ 每张参考图 @1 / @2 …
  // chip 显示用文件原名；逻辑 tag (data-tag) 用于光标 + 提交时的 [Image N] / [Video] 转换。
  const refImages = useMemo(
    () => media.filter((m) => m.type === 'reference_image'),
    [media]
  );
  const editVideoItem = useMemo(
    () => media.find((m) => m.type === 'video') || null,
    [media]
  );
  const VIDEO_MENTION_TAG = '@Video';
  type MentionItem = { idx: number; tag: string; url: string; name: string; kind: 'video' | 'image' };
  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = [];
    if (mode === 'video-edit' && editVideoItem) {
      items.push({
        idx: 0,
        tag: VIDEO_MENTION_TAG,
        url: editVideoItem.url,
        name: editVideoItem.original_name || '待编辑视频',
        kind: 'video',
      });
    }
    refImages.forEach((m, i) => {
      items.push({
        idx: i + 1,
        tag: `@${i + 1}`,
        url: m.url,
        name: m.original_name || `图片 ${i + 1}`,
        kind: 'image',
      });
    });
    return items;
  }, [mode, editVideoItem, refImages]);
  const tagDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const mi of mentionItems) map.set(mi.tag, mi.name);
    return map;
  }, [mentionItems]);

  function chipDisplayFor(tag: string): string {
    return tagDisplayMap.get(tag) ?? tag;
  }

  /** @ 面板的过滤匹配：空过滤=全部命中；否则 tag 去掉 @ 后前缀匹配，或文件名子串包含 */
  function mentionMatchesFilter(mi: MentionItem, filter: string): boolean {
    if (!filter) return true;
    const tagBody = mi.tag.replace(/^@/, '');
    if (tagBody.startsWith(filter)) return true;
    return mi.name.toLowerCase().includes(filter.toLowerCase());
  }

  // 给字符串做 HTML 属性安全转义（chip 显示名走 textContent 不需 DOM 转义，但 buildEditorHtml 是字符串拼接）
  function escapeHtmlAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── contenteditable 编辑器：HTML 构造、文本抽取、光标 ────────────────────────

  function buildEditorHtml(text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    // 已知 tag 集合：@N（数字）+ @Video（video-edit 模式下）。
    // 用 alternation 把所有 tag 一次性匹配，避免 @Video 被 @\d+ 漏掉。
    const knownTags = mentionItems.map((mi) => mi.tag);
    const fixedTags = knownTags.filter((t) => !/^@\d+$/.test(t)); // 非数字 tag（如 @Video）
    const patterns: string[] = [];
    if (fixedTags.length > 0) {
      patterns.push(fixedTags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
    }
    patterns.push('@\\d+'); // 数字 tag 兜底（即使当前没有图片，也保留以便复用 / 粘贴）
    const re = new RegExp(`(${patterns.join('|')})`, 'g');
    return escaped.replace(re, (m) => {
      const display = chipDisplayFor(m);
      return `​<span contenteditable="false" class="mention-chip" data-tag="${escapeHtmlAttr(m)}">${escapeHtmlAttr(display)}</span>​`;
    });
  }

  function extractEditorText(el: Node): string {
    let t = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        t += (n.textContent ?? '').replace(/​/g, '');
      } else if ((n as Element).tagName === 'BR') {
        const prev = n.previousSibling as Element | null;
        if (prev?.classList?.contains('mention-chip')) continue;
        t += '\n';
      } else if ((n as Element).classList?.contains('mention-chip')) {
        // 逻辑文本永远使用 data-tag（@N），与显示文本无关
        t += (n as Element).getAttribute('data-tag') ?? '';
      } else {
        t += extractEditorText(n);
      }
    }
    return t;
  }

  /** chip 在「逻辑文本」中占用的字符数 = data-tag 的字符数 */
  function chipLogicalLen(el: Element): number {
    return (el.getAttribute('data-tag') || '').length;
  }

  function getCursorOffset(root: HTMLDivElement): number {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    try {
      const pre = document.createRange();
      pre.setStart(root, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const tmp = document.createElement('div');
      tmp.appendChild(pre.cloneContents());
      return extractEditorText(tmp).length;
    } catch { return 0; }
  }

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
        return extractEditorText(tmp).length;
      } catch { return 0; }
    };
    const a = offsetAt(range.startContainer, range.startOffset);
    const b = offsetAt(range.endContainer, range.endOffset);
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  }

  /** 直接重写编辑器 HTML，并保证 chip 后总有零宽空格落点 */
  function setEditorHtml(html: string) {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = html;
    cleanChipBrs(el);
    const last = el.lastChild;
    if (last?.nodeType === Node.ELEMENT_NODE && (last as Element).classList.contains('mention-chip')) {
      el.appendChild(document.createTextNode('​'));
    }
  }

  function setCursorOffset(root: HTMLDivElement, offset: number) {
    const sel = window.getSelection();
    if (!sel) return;
    let cur = 0;
    const walk = (node: Node): boolean => {
      if ((node as Element).classList?.contains('mention-chip')) {
        const chipLen = chipLogicalLen(node as Element);
        if (cur + chipLen >= offset) {
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
        const logLen = raw.replace(/​/g, '').length;
        if (cur + logLen >= offset) {
          let remaining = offset - cur;
          let rawIdx = 0;
          while (rawIdx < raw.length) {
            if (raw[rawIdx] !== '​') {
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

  function cleanChipBrs(el: HTMLElement) {
    el.querySelectorAll('.mention-chip + br').forEach((br) => br.remove());
  }

  // r2v 模式下，当 mentionItems（即各 @N 的显示名）变化时，同步刷新已挂载 chip 的 textContent
  useEffect(() => {
    if (!useMentionEditor) return;
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.mention-chip[data-tag]').forEach((chip) => {
      const tag = chip.getAttribute('data-tag') || '';
      const display = chipDisplayFor(tag);
      if (chip.textContent !== display) chip.textContent = display;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagDisplayMap, mode]);

  // r2v 模式下，prompt 变化（程序触发，非用户输入）时同步重写编辑器 HTML
  useLayoutEffect(() => {
    if (!useMentionEditor) return;
    const el = editorRef.current;
    if (!el) return;
    if (extractEditorText(el) === prompt) return; // 用户正在输入，跳过避免抢光标
    const cursor = getCursorOffset(el);
    el.innerHTML = buildEditorHtml(prompt);
    cleanChipBrs(el);
    setCursorOffset(el, Math.min(cursor, prompt.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, mode]);

  // 选区跨越 chip 时，给 chip 加琥珀色高亮，其它文字轻微暗淡，让"复制时"也有 chip 视觉
  // 与 SingleTaskPage 同款：监听 selectionchange，遍历 chip 用 Range.compareBoundaryPoints 判定相交
  useEffect(() => {
    if (!useMentionEditor) return;
    const handler = () => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      const hasSelection = !!(sel && !sel.isCollapsed && sel.rangeCount &&
        el.contains(sel.getRangeAt(0).commonAncestorContainer));
      el.classList.toggle('has-selection', hasSelection);

      const chips = el.querySelectorAll('.mention-chip');
      chips.forEach((chip) => {
        if (!hasSelection) { chip.classList.remove('mention-chip--selected'); return; }
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
  }, [mode]);

  // ── @ 提及面板 ────────────────────────────────────────────────────────────

  function closeMentionPanel() {
    setMentionPanel(null);
    mentionAnchorNodeRef.current = null;
  }

  function insertMentionChip(tag: string) {
    const el = editorRef.current;
    if (!el) return;
    // 删除 @ + 过滤文本，把光标放回 @ 处
    const anchorNode = mentionAnchorNodeRef.current;
    const anchorOff = mentionAnchorOffsetRef.current;
    if (anchorNode && anchorNode.nodeType === Node.TEXT_NODE) {
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const cur = sel.getRangeAt(0);
        const r = document.createRange();
        r.setStart(anchorNode, anchorOff);
        r.setEnd(cur.endContainer, cur.endOffset);
        r.deleteContents();
      }
    }
    // 插入 chip：显示用文件原名，逻辑 tag 走 data-tag
    const chip = document.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    chip.className = 'mention-chip';
    chip.setAttribute('data-tag', tag);
    chip.textContent = chipDisplayFor(tag);
    const zwsBefore = document.createTextNode('​');
    const zwsAfter = document.createTextNode('​');
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const r = sel.getRangeAt(0);
      r.insertNode(zwsAfter);
      r.insertNode(chip);
      r.insertNode(zwsBefore);
      r.setStartAfter(zwsAfter);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    cleanChipBrs(el);
    setPrompt(extractEditorText(el));
    closeMentionPanel();
  }

  function handleEditorInput() {
    const el = editorRef.current;
    if (!el) return;
    cleanChipBrs(el);
    const text = extractEditorText(el);
    setPrompt(text);

    // 检测光标前是否刚输入了 @，决定是否打开提及面板
    if (!useMentionEditor || mentionItems.length === 0) {
      closeMentionPanel();
      return;
    }
    const sel = window.getSelection();
    if (!sel?.rangeCount) { closeMentionPanel(); return; }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const off = range.startOffset;
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = (node.textContent ?? '');
      // 向左找最近的 @；@ 后允许跟数字 / 中文 / 字母（不能含空白），用于匹配 @1 / @Video / @cat 等
      const left = rawText.slice(0, off);
      const m = left.match(/@([^\s@]*)$/);
      if (m) {
        const rect = range.getClientRects()[0];
        const containerRect = el.getBoundingClientRect();
        const filter = m[1];
        const matches = (mi: MentionItem) => mentionMatchesFilter(mi, filter);
        const focusIdx = mentionItems.findIndex(matches);
        if (rect) {
          setMentionPanel({
            top: rect.bottom - containerRect.top + 4,
            left: rect.left - containerRect.left - 4,
            filter,
            focusIdx: focusIdx === -1 ? 0 : focusIdx,
          });
        }
        mentionAnchorNodeRef.current = node;
        mentionAnchorOffsetRef.current = off - m[0].length;
        return;
      }
    }
    closeMentionPanel();
  }

  function handleEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (mentionPanel) {
      const filtered = mentionItems.filter((mi) => mentionMatchesFilter(mi, mentionPanel.filter));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionPanel((p) => p && ({ ...p, focusIdx: Math.min(filtered.length - 1, p.focusIdx + 1) }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionPanel((p) => p && ({ ...p, focusIdx: Math.max(0, p.focusIdx - 1) }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const target = filtered[mentionPanel.focusIdx];
        if (target) {
          e.preventDefault();
          insertMentionChip(target.tag);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionPanel();
        return;
      }
    }
    // 删除 chip 当作一个整体
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        const off = r.startOffset;
        let prev: ChildNode | null = null;
        if (node.nodeType === Node.TEXT_NODE) {
          // 文本节点开头：找前一个兄弟（跳过零宽空格文本）
          const raw = (node.textContent ?? '');
          if (off === 0 || raw.slice(0, off).replace(/​/g, '').length === 0) {
            let cand = node.previousSibling;
            while (cand && cand.nodeType === Node.TEXT_NODE && (cand.textContent ?? '').replace(/​/g, '').length === 0) {
              cand = cand.previousSibling;
            }
            prev = cand as ChildNode | null;
          }
        } else if (node === editorRef.current) {
          prev = (node.childNodes[off - 1] as ChildNode | null) ?? null;
        }
        if (prev && (prev as Element).classList?.contains('mention-chip')) {
          e.preventDefault();
          prev.remove();
          if (editorRef.current) {
            cleanChipBrs(editorRef.current);
            setPrompt(extractEditorText(editorRef.current));
          }
          return;
        }
      }
    }
  }

  function handleEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const el = editorRef.current;
    if (!el) return;
    const raw = e.clipboardData.getData('text/plain');
    if (!raw) return;
    // <ref>@N</ref> 是本编辑器自己复制出来的封装，剥壳后还原为纯 @N 文本，由 buildEditorHtml 重新 chip 化
    const converted = raw.replace(/<ref>(@[^<\n]+)<\/ref>/g, '$1');
    const { start, end } = getSelectionRange(el);
    const currentText = extractEditorText(el);
    const newText = currentText.slice(0, start) + converted + currentText.slice(end);
    setEditorHtml(buildEditorHtml(newText));
    setPrompt(newText);
    const pos = start + converted.length;
    setTimeout(() => { if (editorRef.current) setCursorOffset(editorRef.current, pos); }, 0);
  }

  /**
   * 把当前选区序列化成「带 <ref> 标签的纯文本」：
   *   <ref>@N</ref> 用于 chip；普通文本保持原样；<br> → \n。
   * 这样跨编辑器粘贴（哪怕回到本编辑器）也能精确还原 chip。
   */
  function serializeSelectionAsRef(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    let out = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += (node.textContent ?? '').replace(/​/g, '');
      } else if ((node as Element).tagName === 'BR') {
        out += '\n';
      } else if ((node as Element).classList?.contains('mention-chip')) {
        out += `<ref>${(node as Element).getAttribute('data-tag') ?? ''}</ref>`;
      } else {
        node.childNodes.forEach(walk);
      }
    };
    if (fragment.childNodes.length === 0) return range.toString();
    fragment.childNodes.forEach(walk);
    return out || range.toString();
  }

  function handleEditorCopy(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = serializeSelectionAsRef();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
  }

  function handleEditorCut(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = serializeSelectionAsRef();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    const sel = window.getSelection();
    if (sel?.rangeCount) sel.getRangeAt(0).deleteContents();
    if (editorRef.current) {
      cleanChipBrs(editorRef.current);
      setPrompt(extractEditorText(editorRef.current));
    }
  }


  const estimate = useMemo(() => {
    // video-edit 计费 = (输入秒数 + 输出秒数) × 单价。必须先上传视频拿到真实输入时长，否则不预估
    // DashScope 规则：输入 ≤ 15s 时输出与输入等长；输入 > 15s 时上游截取前 15s，输出也为 15s
    let dur: number | undefined;
    if (mode === 'video-edit') {
      if (!editVideoDuration || editVideoDuration <= 0) {
        return { credits: 0, lockedCredits: 0, rate: 0 };
      }
      const effective = Math.min(15, editVideoDuration);
      dur = effective * 2; // 输入 + 输出
    } else {
      dur = duration;
    }
    return estimateHappyhorseCredits(mode, resolution, dur, pricing);
  }, [mode, resolution, duration, pricing, editVideoDuration]);

  const creditInsufficient = !!balance && !balance.unlimited && estimate.lockedCredits * batchSize > balance.available;

  // ── 上传 ─────────────────────────────────────────────────
  async function handleUploadImage(files: FileList | null) {
    if (!files || files.length === 0) return;
    const limit = FILE_LIMITS.image;
    // i2v 仅 1 张首帧；r2v 1~9 张参考图；video-edit 0~5 张参考图
    const maxImages = mode === 'i2v' ? 1 : mode === 'video-edit' ? 5 : 9;
    const existing = media.filter((m) => m.type === 'first_frame' || m.type === 'reference_image').length;
    if (existing + files.length > maxImages) {
      setSubmitError(`图片最多 ${maxImages} 张`);
      return;
    }
    setUploading(true); setUploadPct(0); setSubmitError(null);
    try {
      const newOnes: HappyhorseMediaItem[] = [];
      for (const file of Array.from(files)) {
        if (file.size > limit.maxSize) throw new Error(`图片不能超过 ${limit.sizeLabel}`);
        const out = await uploadToOss(file, 'image', (pct) => setUploadPct(pct));
        newOnes.push({
          type: mode === 'i2v' ? 'first_frame' : 'reference_image',
          url: out.url,
          original_name: file.name,
        });
      }
      setMedia((prev) => [...prev, ...newOnes]);
    } catch (e: any) {
      setSubmitError(e.message || '上传失败');
    } finally {
      setUploading(false); setUploadPct(0);
    }
  }

  async function handleUploadVideo(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > 100 * 1024 * 1024) { setSubmitError('视频不能超过 100MB'); return; }
    setUploading(true); setUploadPct(0); setSubmitError(null);
    // 客户端 probe（兜底，某些视频文件浏览器拿不到元数据；后端 probe 才是权威）
    const blobUrl = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    const localProbe = new Promise<number | null>((resolve) => {
      probe.addEventListener('loadedmetadata', () => {
        const d = probe.duration;
        resolve(Number.isFinite(d) && d > 0 ? d : null);
      }, { once: true });
      probe.addEventListener('error', () => resolve(null), { once: true });
    });
    probe.src = blobUrl;
    try {
      const out = await uploadToOss(file, 'video', (pct) => setUploadPct(pct));
      URL.revokeObjectURL(blobUrl);
      // 1) 优先用服务端 OSS video/info 探测的时长
      let duration: number | null = out.videoInfo?.durationSec ?? null;
      // 2) 兜底用浏览器 probe 出的时长
      if (!duration || duration <= 0) duration = await localProbe;
      setEditVideoDuration(Number.isFinite(duration as number) && (duration as number) > 0 ? (duration as number) : null);
      setMedia((prev) => [
        { type: 'video', url: out.url, original_name: file.name },
        ...prev.filter((x) => x.type !== 'video'),
      ]);
      if (!duration || duration <= 0) {
        setSubmitError('视频时长无法识别，提交将按上限保守预扣，结算时多退少补');
      }
    } catch (e: any) {
      URL.revokeObjectURL(blobUrl);
      setSubmitError(e.message || '视频上传失败');
    } finally {
      setUploading(false); setUploadPct(0);
    }
  }

  function removeMedia(idx: number) {
    // r2v / video-edit：删除某张参考图前，把 prompt 里的 @N 同步重排（@<idx+1> 删除，@>idx+1 各减 1）
    if ((mode === 'r2v' || mode === 'video-edit') && media[idx]?.type === 'reference_image') {
      const removedTagNum = imageIndexInRefList(idx) + 1; // 1-based among reference images
      const refTotal = media.filter((m) => m.type === 'reference_image').length;
      const reindex: Record<number, number | null> = {};
      for (let k = 1; k <= refTotal; k++) {
        reindex[k] = k === removedTagNum ? null : (k > removedTagNum ? k - 1 : k);
      }
      remapPromptChipTags(reindex);
    }
    // video-edit：删除待编辑视频时同步清掉时长 + 把 prompt 里的 @Video chip 去掉
    if (media[idx]?.type === 'video') {
      setEditVideoDuration(null);
      if (mode === 'video-edit') {
        // 同步删除 @Video chip / 文本
        setPrompt((prev) => prev.split(VIDEO_MENTION_TAG).join(''));
        const el = editorRef.current;
        if (el) {
          el.querySelectorAll<HTMLElement>(`.mention-chip[data-tag="${VIDEO_MENTION_TAG}"]`).forEach((chip) => chip.remove());
        }
      }
    }
    setMedia((prev) => prev.filter((_, i) => i !== idx));
  }

  /** 把 media 数组里某条 reference_image 在「参考图列表」内的 0-based 序号取出 */
  function imageIndexInRefList(idxInMedia: number): number {
    let rank = 0;
    for (let k = 0; k < idxInMedia; k++) {
      if (media[k].type === 'reference_image') rank++;
    }
    return rank;
  }

  /**
   * r2v 模式下，把编辑器和 prompt 里的 chipTag 重新映射。
   * 输入：{ 旧 1-based 序号 -> 新 1-based 序号 | null（被删除） }
   */
  function remapPromptChipTags(reindex: Record<number, number | null>) {
    const transform = (tag: string): string | null => {
      const num = parseInt(tag.replace(/^@/, ''), 10);
      if (!Number.isFinite(num)) return tag;
      const target = reindex[num];
      if (target === null) return null; // 被删除
      if (target === undefined) return tag;
      return `@${target}`;
    };
    // 更新 plain text prompt
    setPrompt((prev) => prev.replace(/@(\d+)/g, (_m, g1) => {
      const t = transform('@' + g1);
      return t === null ? '' : t;
    }));
    // 更新 contenteditable DOM（如已挂载）
    const el = editorRef.current;
    if (el) {
      el.querySelectorAll<HTMLElement>('.mention-chip[data-tag]').forEach((chip) => {
        const t = transform(chip.getAttribute('data-tag') || '');
        if (t === null) chip.remove();
        else if (t !== chip.getAttribute('data-tag')) {
          chip.setAttribute('data-tag', t);
          // 显示文本走文件原名（在新一轮 mentionItems 计算后再用 useEffect 兜底刷新）
          chip.textContent = chipDisplayFor(t);
        }
      });
    }
  }

  // ── 提交 ─────────────────────────────────────────────────
  async function handleSubmit() {
    if (!projectId) { setSubmitError('请先选择工作组'); return; }
    if (mode === 't2v' && !prompt.trim()) { setSubmitError('请输入提示词'); return; }
    if (mode === 'i2v' && !media.some((m) => m.type === 'first_frame')) { setSubmitError('请上传首帧图片'); return; }
    if (mode === 'r2v' && media.filter((m) => m.type === 'reference_image').length < 1) { setSubmitError('请至少上传 1 张参考图'); return; }
    if (mode === 'video-edit' && !media.some((m) => m.type === 'video')) { setSubmitError('请上传待编辑的视频'); return; }
    // video-edit：必须有可信的视频时长才能精确计费；OSS 探测失败 / 浏览器 probe 失败 / 视频已过期都属此情况
    if (mode === 'video-edit' && (!editVideoDuration || editVideoDuration <= 0)) {
      setSubmitError('无法识别视频时长，无法预估积分。请重新上传视频后再生成。');
      return;
    }

    setSubmitting(true); setSubmitError(null);
    try {
      const seedNum = seed.trim() ? parseInt(seed.trim(), 10) : undefined;
      // r2v / video-edit：把 @N → [Image N]、@Video → [Video]（仅匹配合法序号 / 有视频上传时）
      let finalPrompt = prompt.trim();
      if (mode === 'r2v' || mode === 'video-edit') {
        const refTotal = refImages.length;
        finalPrompt = finalPrompt.replace(/@(\d+)/g, (m, g1) => {
          const n = parseInt(g1, 10);
          return n >= 1 && n <= refTotal ? `[Image ${n}]` : m;
        });
      }
      if (mode === 'video-edit' && editVideoItem) {
        finalPrompt = finalPrompt.split(VIDEO_MENTION_TAG).join('[Video]');
      }
      await submitHappyhorseTask({
        projectId,
        mode,
        prompt: finalPrompt,
        resolution,
        ratio: showRatio ? ratio : undefined,
        duration: showDuration ? duration : undefined,
        media: media.length ? media : undefined,
        watermark: false, // 强制不加水印
        audioSetting: mode === 'video-edit' ? audioSetting : undefined,
        seed: Number.isFinite(seedNum) ? seedNum : undefined,
        // video-edit 必须把已 probe 的视频时长上传，否则后端没法精确预扣
        inputVideoDurationSec: mode === 'video-edit' && editVideoDuration && editVideoDuration > 0
          ? editVideoDuration
          : undefined,
        batchSize: batchSize > 1 ? batchSize : undefined,
      });
      setPrompt(''); setMedia([]); setSeed(''); setEditVideoDuration(null);
      await loadTasks();
    } catch (e: any) {
      setSubmitError(e.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setPrompt(''); setMedia([]); setSeed(''); setSubmitError(null);
  }

  // ── 任务操作 ─────────────────────────────────────────────
  // 直接从 DashScope OSS URL 下载（24h 有效）。fetch 成阻塞流后转 blob 再触发 a[download]，
  // 这样能强制带上我们指定的文件名（跨域 URL 配合 <a download> 浏览器会忽略文件名，blob 不受限）。
  async function handleDownload(t: HappyhorseTask) {
    if (!t.video_url) return;
    try {
      const resp = await fetch(t.video_url);
      if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
      const blob = await resp.blob();
      const promptPreview = (t.prompt || '').slice(0, 30).replace(/[\\/:*?"<>|]/g, '_');
      const filename = `happyhorse_${t.id}_${promptPreview || t.mode}.mp4`;
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 5 * 60 * 1000);
    } catch (e: any) {
      alert(`下载失败：${e.message || '未知错误'}（视频链接可能已过期，请重新生成）`);
    }
  }

  /**
   * 复用历史任务：把模式、参数、媒体、prompt 一次性还原到表单。
   * 媒体直接复用历史 OSS / DashScope 临时 URL（不重新上传）。
   * r2v 的 [Image N] 自动转回 @N，由编辑器 useLayoutEffect 重新 chip 化。
   * video-edit 的视频时长无法二次 probe 历史 URL（CORS / dashscope 链接 24h 失效），
   *   优先取任务记录里的 result_input_duration，无则置空并提示。
   */
  function handleReuse(t: HappyhorseTask) {
    // 标记本次 mode 切换不要触发表单清空（我们马上要塞历史值进去）
    skipModeResetRef.current = true;

    // 1. 模式 + 参数
    setMode(t.mode);
    setResolution(t.resolution);
    if (t.ratio) setRatio(t.ratio);
    if (t.duration) setDuration(t.duration);
    if (t.audio_setting === 'auto' || t.audio_setting === 'origin') setAudioSetting(t.audio_setting);
    setSeed(t.seed != null ? String(t.seed) : '');

    // 2. 媒体（直接复用任务持久化的 url）
    const restoredMedia: HappyhorseMediaItem[] = (t.media || []).map((m) => ({
      type: m.type,
      url: m.url,
      original_name: m.original_name || null,
    }));
    setMedia(restoredMedia);

    // 3. video-edit：尝试恢复视频时长用于精确预扣
    //    优先用历史记录里的 result_input_duration；无值则异步调 OSS video/info 重新探测
    if (t.mode === 'video-edit') {
      const dur = Number(t.result_input_duration);
      if (Number.isFinite(dur) && dur > 0) {
        setEditVideoDuration(dur);
      } else {
        setEditVideoDuration(null);
        const vid = restoredMedia.find((m) => m.type === 'video');
        if (vid?.url) {
          probeOssVideo(vid.url)
            .then((info) => { if (info.durationSec > 0) setEditVideoDuration(info.durationSec); })
            .catch((e) => {
              setSubmitError(e.message?.includes('不存在') || e.message?.includes('过期')
                ? '原视频已不在 OSS 中（可能已过期或被删除），请重新上传后再生成。'
                : `视频信息探测失败：${e.message || '未知错误'}`);
            });
        }
      }
    } else {
      setEditVideoDuration(null);
    }

    // 4. prompt：r2v / video-edit 把 [Image N] / [Video] 还原为 @N / @Video，让 mention chip 自动重建；其它模式直接回填
    let restoredPrompt = t.prompt || '';
    if (t.mode === 'r2v' || t.mode === 'video-edit') {
      restoredPrompt = restoredPrompt.replace(/\[Image (\d+)\]/g, '@$1');
    }
    if (t.mode === 'video-edit') {
      restoredPrompt = restoredPrompt.split('[Video]').join(VIDEO_MENTION_TAG);
    }
    setPrompt(restoredPrompt);

    setSubmitError(null);
    // 兜底：若 mode 没变化（[mode] effect 不会跑），flag 在下个 tick 主动清掉，避免污染下一次真切换
    setTimeout(() => { skipModeResetRef.current = false; }, 0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── 渲染 ─────────────────────────────────────────────────
  // video-edit 模式：上传了视频但时长不可知 → 提交时会落入 30s 上限兜底，可能超出余额，
  // 而且就算余额够也会扣多。统一禁用提交，强制用户重新上传 / 重选媒体。
  const hasEditVideo = mode === 'video-edit' && media.some((m) => m.type === 'video');
  const videoEditDurationUnknown = hasEditVideo && (!editVideoDuration || editVideoDuration <= 0);
  const modeInputMissing =
    (mode === 't2v' && !prompt.trim()) ||
    (mode === 'i2v' && !media.some((m) => m.type === 'first_frame')) ||
    (mode === 'r2v' && media.filter((m) => m.type === 'reference_image').length < 1) ||
    (mode === 'video-edit' && !media.some((m) => m.type === 'video'));
  const canGenerate = !submitting && !uploading && !!projectId && !creditInsufficient && !videoEditDurationUnknown && !modeInputMissing;
  const currentTab = MODE_TABS.find((m) => m.mode === mode)!;

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">HappyHorse · {currentTab.label}</h1>
        <button onClick={() => navigate('/settings')} className="btn-ghost">
          <GearIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Left Panel */}
      <div className="flex-1 md:w-[520px] md:flex-none md:border-r border-gray-800 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        <div className="hidden md:flex flex-col gap-1 mb-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold truncate">HappyHorse</h2>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => void loadTasks()}
                disabled={tasksLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-50"
              >
                <svg className={`w-4 h-4 ${tasksLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {tasksLoading ? '刷新中...' : '刷新'}
              </button>
              <button onClick={() => navigate('/settings')} className="btn-ghost" title="设置">
                <GearIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
          {state.currentProject && (
            <div className="flex items-center gap-2">
              <span className="text-xs px-2.5 py-1 rounded-xl bg-purple-500/20 border border-purple-500/30 text-purple-300 font-medium truncate max-w-[300px]">
                {state.currentProject.name}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {/* Mode Tabs */}
          <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">生成模式</label>
            <div className="grid grid-cols-2 gap-2">
              {MODE_TABS.map((m) => (
                <button
                  key={m.mode}
                  onClick={() => setMode(m.mode)}
                  className={`px-3 py-2.5 rounded-xl text-sm border transition-all text-left ${
                    mode === m.mode
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                  }`}
                >
                  <div className="font-medium">{m.label}</div>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-2">{currentTab.desc}</p>
          </div>

          {/* 媒体上传 */}
          {mode !== 't2v' && (
            <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4 space-y-3">
              <label className="text-sm font-bold text-gray-300">
                {mode === 'i2v' && '首帧图片（必填，1 张）'}
                {mode === 'r2v' && '参考图（1~9 张，输入 @ 引用）'}
                {mode === 'video-edit' && '待编辑视频（1 个，必填）+ 参考图（0~5 张），prompt 中输入 @ 引用'}
              </label>
              <div className="flex flex-wrap gap-2">
                {media.map((m, i) => {
                  return (
                    <div key={i}>
                      <MediaThumb
                        m={m}
                        idx={imageIndexInRefList(i) + 1}
                        onRemove={() => removeMedia(i)}
                        showName={mode === 'r2v' || mode === 'i2v' || mode === 'video-edit'}
                      />
                    </div>
                  );
                })}
                {/* 图片上传按钮 */}
                {(() => {
                  const imgCount = media.filter((m) => m.type !== 'video').length;
                  const maxImg = mode === 'i2v' ? 1 : mode === 'video-edit' ? 5 : 9;
                  if (imgCount >= maxImg) return null;
                  return (
                    <label className={`flex items-center justify-center gap-1.5 w-20 h-20 border border-dashed border-gray-700 rounded-xl text-xs text-gray-500 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}>
                      <PlusIcon className="w-3.5 h-3.5" />
                      <span>图片</span>
                      <input
                        ref={imgInputRef} type="file" accept={FILE_LIMITS.image.accept}
                        multiple={mode !== 'i2v'} className="hidden" disabled={uploading}
                        onChange={(e) => { void handleUploadImage(e.target.files); e.target.value = ''; }}
                      />
                    </label>
                  );
                })()}
                {mode === 'video-edit' && !media.some((m) => m.type === 'video') && (
                  <label className={`flex items-center justify-center gap-1.5 w-20 h-20 border border-dashed border-purple-700 rounded-xl text-xs text-purple-500 ${uploading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-400 hover:bg-[#25293d]'} transition-all`}>
                    <PlusIcon className="w-3.5 h-3.5" />
                    <span>视频</span>
                    <input
                      ref={videoInputRef} type="file" accept="video/mp4,video/quicktime" className="hidden" disabled={uploading}
                      onChange={(e) => { void handleUploadVideo(e.target.files); e.target.value = ''; }}
                    />
                  </label>
                )}
              </div>
              {uploading && (
                <div className="text-xs text-gray-500">上传中... {uploadPct}%</div>
              )}
              <p className="text-[10px] text-gray-500">
                图片：JPEG/PNG/WEBP，单张 ≤30MB；视频：MP4/MOV，时长 3~60s，≤100MB
              </p>
            </div>
          )}

          {/* Prompt */}
          <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">
              提示词 {mode === 'i2v' && <span className="text-gray-500 normal-case">（可选）</span>}
              {mode === 'r2v' && <span className="text-gray-500 normal-case">（输入 @ 引用参考图）</span>}
              {mode === 'video-edit' && <span className="text-gray-500 normal-case">（输入 @ 引用待编辑视频或参考图）</span>}
            </label>
            {useMentionEditor ? (
              <div className="relative">
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder={mode === 'video-edit'
                    ? '示例：将 @Video 中的人物换成 @1 的服饰...'
                    : '示例：让 @1 中的女子穿上 @2 的旗袍，在 @3 的花园里漫步...'}
                  onInput={handleEditorInput}
                  onKeyDown={handleEditorKeyDown}
                  onPaste={handleEditorPaste}
                  onCopy={handleEditorCopy}
                  onCut={handleEditorCut}
                  className="prompt-editor w-full min-h-[120px] bg-[#0f111a] border border-gray-700 rounded-xl p-3 text-sm text-white focus:border-purple-500 outline-none whitespace-pre-wrap break-words"
                />
                {mentionPanel && mentionItems.length > 0 && (
                  <div
                    className="absolute z-30 bg-[#1c1f2e] border border-gray-700 rounded-xl shadow-xl p-1 max-h-60 overflow-y-auto custom-scrollbar w-[260px]"
                    style={{ top: mentionPanel.top, left: mentionPanel.left }}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    {mentionItems
                      .filter((mi) => mentionMatchesFilter(mi, mentionPanel.filter))
                      .map((mi, i) => (
                        <button
                          key={mi.tag}
                          type="button"
                          onClick={() => insertMentionChip(mi.tag)}
                          className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left text-sm transition-colors ${
                            i === mentionPanel.focusIdx ? 'bg-purple-500/20 text-purple-200' : 'text-gray-300 hover:bg-gray-800'
                          }`}
                        >
                          {mi.kind === 'video' ? (
                            <div className="w-8 h-8 rounded border border-gray-700 bg-blue-500/10 flex items-center justify-center text-base flex-shrink-0">🎬</div>
                          ) : (
                            <img src={mi.url} alt="" className="w-8 h-8 object-cover rounded border border-gray-700" />
                          )}
                          <span className="font-mono text-purple-300">{mi.tag}</span>
                          <span className="truncate text-xs text-gray-400">{mi.name}</span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            ) : (
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={5}
                maxLength={5000}
                className="w-full bg-[#0f111a] border border-gray-700 rounded-xl p-3 text-sm text-white focus:border-purple-500 outline-none resize-none"
                placeholder="描述你想生成的视频内容..."
              />
            )}
            <div className="text-[10px] text-gray-500 mt-1 text-right">{prompt.length} / 5000</div>
          </div>

          {/* 参数 */}
          <div className="bg-[#1c1f2e] rounded-2xl border border-gray-800 p-4 space-y-4">
            {/* Resolution */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">分辨率</label>
              <div className="flex gap-2">
                {RESOLUTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setResolution(r)}
                    className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                      resolution === r ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                    }`}
                  >{r}</button>
                ))}
              </div>
            </div>

            {/* Ratio */}
            {showRatio && (
              <div>
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">画幅</label>
                <div className="flex flex-wrap gap-2">
                  {RATIO_OPTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRatio(r)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                        ratio === r ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >{r}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Duration */}
            {showDuration && (
              <div>
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">视频时长</label>
                <div className="flex flex-wrap gap-2">
                  {DURATION_OPTIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => setDuration(d)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                        duration === d ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >{d}秒</button>
                  ))}
                </div>
              </div>
            )}

            {/* Audio setting (video-edit only) */}
            {showAudioSetting && (
              <div>
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">声音</label>
                <div className="flex gap-2">
                  {(['auto', 'origin'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setAudioSetting(v)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all ${
                        audioSetting === v ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'
                      }`}
                    >{v === 'auto' ? '自动' : '保留原声'}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Seed */}
            <div>
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">Seed（可选）</label>
              <input
                type="text" value={seed}
                onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
                placeholder="留空随机"
                className="w-full bg-[#0f111a] border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:border-purple-500 outline-none"
              />
            </div>
          </div>

          {/* Generate */}
          <div className="pb-6 md:pb-4">
            {(submitting || uploading) && (
              <div className="mb-4">
                <div className="text-xs text-gray-400">
                  {uploading ? `正在上传素材到 OSS... ${uploadPct}%` : '提交中...'}
                </div>
              </div>
            )}
            <div className="flex gap-3">
              {/* 批量生成选择器 */}
              {maxConcurrent > 1 && (
                <select
                  value={batchSize}
                  onChange={(e) => setBatchSize(parseInt(e.target.value, 10))}
                  disabled={submitting || uploading}
                  className="px-3 py-3 rounded-xl text-sm font-medium border border-gray-700 bg-[#161824] text-gray-300 focus:outline-none focus:border-purple-500 disabled:opacity-40"
                >
                  {Array.from({ length: maxConcurrent }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>数量：{n}</option>
                  ))}
                </select>
              )}
              <button
                onClick={handleSubmit}
                disabled={!canGenerate}
                className={`flex-1 font-bold py-3 rounded-xl transition-all flex items-center justify-center gap-2 ${
                  creditInsufficient
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/20'
                    : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white shadow-lg shadow-purple-900/20'
                }`}
              >
                {submitting ? (
                  <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />生成中...</>
                ) : uploading ? (
                  <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />上传中...</>
                ) : creditInsufficient ? (
                  <>⚠️ 可用积分不足（可用 {balance!.available}，需 {estimate.lockedCredits * batchSize}）</>
                ) : videoEditDurationUnknown ? (
                  <>⚠️ 请重新上传视频</>
                ) : modeInputMissing ? (
                  <>{mode === 't2v' ? '请输入提示词' : mode === 'i2v' ? '请上传首帧图' : mode === 'r2v' ? '请上传参考图' : '请上传视频'}</>
                ) : (
                  <><SparkleIcon className="w-4 h-4" />生成视频</>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={submitting || uploading}
                className="px-6 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white font-bold py-3 rounded-xl transition-all"
              >重置</button>
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
                {mode === 'video-edit' && (!editVideoDuration || editVideoDuration <= 0) ? (
                  <span className="text-amber-400">请先上传视频后再预估积分</span>
                ) : estimate.credits > 0 ? (
                  <span>
                    本次预计消耗 <span className="text-purple-300 font-semibold">{estimate.credits * batchSize}</span> 积分
                    <span className="ml-2 text-gray-500">（锁定 {estimate.lockedCredits * batchSize}）</span>
                  </span>
                ) : (
                  <span>{pricing === null ? '加载计费中...' : '请选择参数'}</span>
                )}
              </div>
            )}
            {mode === 'video-edit' && estimate.credits > 0 && editVideoDuration && editVideoDuration > 0 && (
              <div className="mt-1 text-[10px] text-gray-500">
                视频编辑计费 = 输入 {Math.min(15, Math.ceil(editVideoDuration))}s + 输出 {Math.min(15, Math.ceil(editVideoDuration))}s（≤15s 输出与输入等长）
              </div>
            )}
            {submitError && <div className="mt-3 text-sm text-red-400">{submitError}</div>}
          </div>
        </div>
      </div>

      {/* Right Panel - History */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">历史记录</h2>
        </div>

        {tasksLoading && tasks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full mr-2" />加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">暂无生成记录</div>
        ) : (
          <div className="px-4 pb-4 space-y-3">
            {tasks.map((t) => {
              const badge = STATUS_BADGE[t.status];
              const playUrl = t.video_url;
              const canPreview = !!playUrl || (t.status === 'error' && !!t.error_message);
              const openPreview = () => {
                if (!canPreview) return;
                setPreviewVideo({
                  url: playUrl || '',
                  prompt: t.prompt || '',
                  error: t.status === 'error' && t.error_message ? t.error_message : null,
                });
              };
              const isGroup = !!t.concurrent_id;
              const allGroupItems = isGroup ? [t, ...(t.concurrent_items || [])] : [t];

              return (
                <div key={isGroup ? (t.concurrent_id || `group-${t.id}`) : t.id} className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
                  <div className="flex gap-3 p-3 items-start">
                    {/* Thumbnail — 非批量时显示 */}
                    {!isGroup && (
                    <div
                      className={`w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] flex items-center justify-center relative group ${canPreview ? 'cursor-pointer' : ''}`}
                      onClick={openPreview}
                    >
                      {t.status === 'done' && playUrl ? (
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
                      ) : t.status === 'processing' || t.status === 'pending' ? (
                        <span className="text-xs text-blue-400 text-center px-1 flex flex-col items-center gap-1">
                          <span className="animate-spin h-4 w-4 border-2 border-blue-400 border-t-transparent rounded-full" />
                          {badge.text}
                        </span>
                      ) : t.status === 'error' ? (
                        <span className="text-xs text-red-400 text-center px-1">失败</span>
                      ) : (
                        <span className="text-xs text-gray-500 text-center px-1">{badge.text}</span>
                      )}
                    </div>
                    )}

                    {/* Info */}
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className={`px-2 py-0.5 rounded border ${badge.cls}`}>{badge.text}</span>
                        <span className="text-gray-500">#{t.id}</span>
                        <span className="text-purple-400">{MODE_TABS.find((m) => m.mode === t.mode)?.label}</span>
                      </div>
                      <p className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{t.prompt || '（无提示词）'}</p>
                      {!isGroup && t.status === 'error' && t.error_message && (
                        <p className="text-xs text-red-400 line-clamp-3 leading-relaxed bg-red-950/30 rounded-lg px-2 py-1">{t.error_message}</p>
                      )}

                      {/* 输入素材缩略（非批量时） */}
                      {!isGroup && t.media && t.media.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {t.media.slice(0, 6).map((m, i) => (
                            m.type === 'video' ? (
                              <div key={i} className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-base flex-shrink-0">🎬</div>
                            ) : (
                              <img key={i} src={m.url} className="w-8 h-8 rounded-lg object-cover border border-gray-700 flex-shrink-0" onError={(e) => (e.currentTarget.style.display = 'none')} />
                            )
                          ))}
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
                              const isSubProcessing = sub.status === 'processing' || sub.status === 'pending';
                              const isSubError = sub.status === 'error';
                              return (
                                <div key={sub.id} className="bg-[#0f111a] rounded-xl overflow-hidden border border-gray-800">
                                  <div
                                  className="h-[15vh] min-h-[80px] cursor-pointer relative group flex items-center justify-center"
                                    onClick={() => {
                                      if (subPlayUrl) setPreviewVideo({ url: subPlayUrl, prompt: t.prompt, error: null });
                                    }}
                                  >
                                    {isSubDone ? (
                                      <>
                                        <video src={subPlayUrl} muted className="w-full h-full object-cover" preload="metadata" />
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                                        </div>
                                      </>
                                    ) : isSubProcessing ? (
                                      <span className="text-[10px] text-blue-400 flex flex-col items-center gap-1">
                                        <span className="animate-spin h-3 w-3 border-2 border-blue-400 border-t-transparent rounded-full" />
                                        生成中
                                      </span>
                                    ) : isSubError ? (
                                      <span className="text-[10px] text-red-400">失败</span>
                                    ) : (
                                      <span className="text-[10px] text-gray-500">待下载</span>
                                    )}
                                  </div>
                                  <div className="flex gap-1 p-1.5 justify-center">
                                    {isSubDone && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleDownload(sub); }}
                                        className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all"
                                      >下载</button>
                                    )}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!confirm('确定要删除此产物吗？')) return;
                                        const taskId = sub.id;
                                        deletingRef.current = true;
                                        setTasks((prev) => prev.map((h) => {
                                          if (h.concurrent_id === t.concurrent_id && h.concurrent_items) {
                                            if (taskId === h.id) {
                                              // 删除的是组头：用第一个兄弟替代，无兄弟则移除整组
                                              const siblings = h.concurrent_items;
                                              if (siblings.length === 0) return null;
                                              const [newHead, ...rest] = siblings;
                                              return { ...newHead, concurrent_items: rest, concurrent_id: h.concurrent_id };
                                            }
                                            // 删除的是兄弟
                                            const filtered = h.concurrent_items.filter((x) => x.id !== taskId);
                                            return { ...h, concurrent_items: filtered };
                                          }
                                          return h;
                                        }).filter(Boolean) as HappyhorseTask[]);
                                        deleteHappyhorseFromHistory(taskId)
                                          .catch((e) => {
                                            alert(`删除失败：${e.message}`);
                                            loadTasks();
                                          })
                                          .finally(() => { deletingRef.current = false; });
                                      }}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
                                    >删除</button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Bottom row */}
                      <div className="flex items-end justify-between gap-2 mt-auto">
                        <span className="text-[10px] text-gray-600 flex-shrink-0">{formatShortDateTime(t.created_at)}</span>
                        <div className="flex flex-col items-end gap-1.5">
                          <div className="flex flex-wrap justify-end gap-1">
                            <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 leading-none">
                              {MODE_TABS.find((m) => m.mode === t.mode)?.label}
                            </span>
                            {t.resolution && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{t.resolution}</span>}
                            {t.ratio && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{t.ratio}</span>}
                            {t.duration && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{t.duration}s</span>}
                          </div>
                          <div className="flex gap-2">
                            {/* 批量操作 */}
                            {isGroup && (
                              <>
                                <button
                                  onClick={async () => {
                                    const doneItems = allGroupItems.filter((gi) => gi.status === 'done' && gi.video_url);
                                    if (doneItems.length === 0) { alert('没有可下载的产物'); return; }
                                    for (const gi of doneItems) {
                                      try { await handleDownload(gi); } catch {}
                                    }
                                  }}
                                  className="text-[11px] px-2 py-1 rounded-xl border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-all"
                                >批量下载({allGroupItems.filter((gi) => gi.status === 'done' && gi.video_url).length})</button>
                                <button
                                  onClick={() => {
                                    if (!confirm(`确定要删除整条批量记录（${allGroupItems.length} 个产物）吗？`)) return;
                                    deletingRef.current = true;
                                    setTasks((prev) => prev.filter((h) => h.concurrent_id !== t.concurrent_id));
                                    Promise.all(allGroupItems.map((gi) => deleteHappyhorseFromHistory(gi.id).catch(() => {})))
                                      .catch(() => loadTasks())
                                      .finally(() => { deletingRef.current = false; });
                                  }}
                                  className="text-[11px] px-2 py-1 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all"
                                >批量删除</button>
                              </>
                            )}
                            {/* 非批量操作 */}
                            {!isGroup && canPreview && (
                              <button onClick={openPreview} className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                                {playUrl ? '预览' : '报错'}
                              </button>
                            )}
                            {!isGroup && t.status === 'done' && t.video_url && (
                              <button onClick={() => handleDownload(t)} className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">下载</button>
                            )}
                            <button onClick={() => handleReuse(t)} className="text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all">复用</button>
                            {!isGroup && (
                            <button
                              onClick={() => {
                                if (!confirm('确定要从历史记录中删除此任务吗？')) return;
                                const taskId = t.id;
                                deletingRef.current = true;
                                setTasks((prev) => prev.filter((x) => x.id !== taskId));
                                deleteHappyhorseFromHistory(taskId)
                                  .catch((e) => {
                                    alert(`删除失败：${e.message}`);
                                    loadTasks();
                                  })
                                  .finally(() => { deletingRef.current = false; });
                              }}
                              className="text-[11px] px-2 py-1 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all"
                            >删除</button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 无限滚动哨兵 */}
        <div ref={sentinelRef} className="flex items-center justify-center py-4">
          {tasksLoading && (
            <span className="text-sm text-gray-500">加载更多...</span>
          )}
          {!hasMore && tasks.length > 0 && (
            <span className="text-xs text-gray-600">已加载全部记录</span>
          )}
        </div>
      </div>

      {/* 视频预览弹窗 —— 与 SingleTaskPage 同款 */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewVideo(null)}
        >
          <div
            className={`relative flex flex-col gap-3 ${previewVideo.url ? 'w-full max-w-5xl' : 'w-full max-w-xl'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewVideo(null)}
              className="absolute -top-9 right-0 text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1"
            >关闭 ✕</button>

            {previewVideo.url && (
              <video
                src={previewVideo.url}
                controls
                autoPlay
                className="w-full rounded-2xl max-h-[72vh] bg-black"
              />
            )}

            {(previewVideo.prompt || previewVideo.error) && (
              <div className={`grid gap-3 ${previewVideo.prompt && previewVideo.error ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {previewVideo.prompt && (
                  <div className="bg-[#0f111a]/90 border border-gray-700 rounded-xl px-4 py-3">
                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">提示词</div>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap break-words max-h-28 overflow-y-auto custom-scrollbar">{previewVideo.prompt}</p>
                  </div>
                )}
                {previewVideo.error && (
                  <div className="bg-red-950/50 border border-red-700/40 rounded-xl px-4 py-3">
                    <div className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-1.5">报错信息</div>
                    <p className="text-sm text-red-300 leading-relaxed whitespace-pre-wrap break-words max-h-28 overflow-y-auto custom-scrollbar">{previewVideo.error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
