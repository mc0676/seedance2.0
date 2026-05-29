import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { getAuthHeaders } from '../services/authService';
import { SparkleIcon, GearIcon } from '../components/Icons';
import { useApp } from '../context/AppContext';
import { formatShortDateTime, useUserTimezone } from '../utils/datetime';
import { getCreditBalance, type CreditBalance } from '../services/pricingService';

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

const IMAGE_MODELS = [
  { value: 'nano-banana-2', label: 'Nano Banana 2', description: '速创生图，快速出图' },
  { value: 'gpt-image-2', label: 'GPT-Image-2', description: '高质量生图模型' },
] as const;

const GPT_ASPECT_OPTIONS = [
  'auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4',
  '21:9', '9:21', '1:3', '3:1', '2:1', '1:2',
] as const;

const NANO_SIZE_OPTIONS = ['1K', '2K', '4K'] as const;
const NANO_ASPECT_OPTIONS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9',
] as const;

interface ImageRecord {
  id: number;
  prompt: string;
  model: string;
  size_label: string;
  ref_urls: string[];
  result_urls: string[];
  credits_used: number;
  created_at: string;
  status?: 'pending' | 'done' | 'error';
  error_message?: string | null;
}

export default function ImageGenPage() {
  useUserTimezone();
  const { state } = useApp();
  const currentProjectId = state.currentProject?.id ?? null;
  const projectsLoaded = !state.loading;

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('nano-banana-2');
  const [gptAspect, setGptAspect] = useState<string>('1:1');
  const [nanoSize, setNanoSize] = useState<string>('1K');
  const [nanoAspect, setNanoAspect] = useState<string>('1:1');
  const [refUrls, setRefUrls] = useState<string[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── @ mention editor（参考图存在时启用 contenteditable + chip）────────────────
  const editorRef = useRef<HTMLDivElement>(null);
  const [mentionPanel, setMentionPanel] = useState<{ top: number; left: number; filter: string; focusIdx: number } | null>(null);
  const mentionAnchorNodeRef = useRef<Node | null>(null);
  const mentionAnchorOffsetRef = useRef<number>(0);
  const useMentionEditor = refUrls.length > 0;
  type MentionItem = { idx: number; tag: string; url: string; name: string; kind: 'image' };
  const mentionItems = useMemo<MentionItem[]>(() => {
    return refUrls.map((url, i) => ({
      idx: i + 1,
      tag: `@${i + 1}`,
      url,
      name: `参考图 ${i + 1}`,
      kind: 'image' as const,
    }));
  }, [refUrls]);
  const tagDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const mi of mentionItems) map.set(mi.tag, mi.name);
    return map;
  }, [mentionItems]);
  function chipDisplayFor(tag: string): string {
    return tagDisplayMap.get(tag) ?? tag;
  }

  // 积分余额（与音频生成 / 视频生成页保持一致）
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const refreshBalance = useCallback(async () => {
    try { setBalance(await getCreditBalance()); } catch (e) { console.error('[image-gen] 余额拉取失败', e); }
  }, []);
  useEffect(() => { void refreshBalance(); }, [refreshBalance]);

  // 历史记录
  const [records, setRecords] = useState<ImageRecord[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadingRef = useRef(false);
  const historyGenRef = useRef(0);
  const historyBottomRef = useRef<HTMLDivElement>(null);

  const sizeLabel = useMemo(() => {
    if (model === 'gpt-image-2') return gptAspect;
    return `${nanoSize} · ${nanoAspect}`;
  }, [model, gptAspect, nanoSize, nanoAspect]);

  // 加载历史
  const loadHistory = useCallback(async (page: number, append = false, projectId?: number | null) => {
    if (historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    const gen = historyGenRef.current;
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (projectId) qs.set('projectId', String(projectId));
      const res = await fetch(`/api/image-records?${qs}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (gen !== historyGenRef.current) return;
      if (!data.success) throw new Error(data.error);
      const { records: rows, total } = data.data;
      setRecords((prev) => append ? [...prev, ...rows] : rows);
      setHistoryHasMore(rows.length === 20 && (append ? records.length + rows.length : rows.length) < total);
      setHistoryPage(page);
    } catch {
      // silent
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初始加载 & 工作组切换（等待项目列表加载完成后再请求，避免刷新时用 null projectId 拉全量记录）
  useEffect(() => {
    if (!projectsLoaded) return;
    historyGenRef.current += 1;
    historyLoadingRef.current = false;
    setRecords([]);
    setHistoryPage(1);
    setHistoryHasMore(false);
    void loadHistory(1, false, currentProjectId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, currentProjectId]);

  // 任意 pending 记录存在时，5 秒一轮拉历史第一页 + 余额，直到所有 pending 完结。
  // pending 由后端 image_records.status='pending' 持久化承载，所以切换菜单/刷新都能恢复"生成中"状态。
  const hasPending = useMemo(() => records.some((r) => r.status === 'pending'), [records]);
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => {
      void loadHistory(1, false, currentProjectId);
      void refreshBalance();
    }, 5000);
    return () => clearInterval(t);
  }, [hasPending, currentProjectId, loadHistory, refreshBalance]);

  // 无限滚动
  useEffect(() => {
    const sentinel = historyBottomRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && historyHasMore && !historyLoading) {
        void loadHistory(historyPage + 1, true, currentProjectId);
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, historyLoading, historyPage, loadHistory]);

  // 删除参考图时同步 remap prompt 中的 @N chip 标签
  function removeRefImage(index: number) {
    const deletedTag = `@${index + 1}`;
    let newPrompt = prompt;
    // 移除被删除的 @N
    const escapedDel = deletedTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    newPrompt = newPrompt.replace(new RegExp(escapedDel, 'g'), '');
    // 递减所有大于被删索引的 @N
    newPrompt = newPrompt.replace(/@(\d+)/g, (m, g1) => {
      const n = parseInt(g1, 10);
      if (n > index + 1) return `@${n - 1}`;
      return m;
    });
    setPrompt(newPrompt);
    setRefUrls((prev) => prev.filter((_, idx) => idx !== index));
  }

  const handleRefUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingRef(true);
    setError('');
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mediaType', 'image');
        const res = await fetch('/api/upload/oss', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: formData,
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || '上传失败');
        uploaded.push(data.url);
      }
      setRefUrls((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '参考图上传失败');
    } finally {
      setUploadingRef(false);
    }
  }, []);

  // ── contenteditable 编辑器：HTML 构造、文本抽取、光标 ────────────────────────

  function escapeHtmlAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildEditorHtml(text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const re = /@\d+/g;
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
        t += (n as Element).getAttribute('data-tag') ?? '';
      } else {
        t += extractEditorText(n);
      }
    }
    return t;
  }

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

  /** @ 面板过滤：空过滤=全部命中；否则去掉 @ 后前缀匹配，或文件名子串包含 */
  function mentionMatchesFilter(mi: MentionItem, filter: string): boolean {
    if (!filter) return true;
    const tagBody = mi.tag.replace(/^@/, '');
    if (tagBody.startsWith(filter)) return true;
    return mi.name.toLowerCase().includes(filter.toLowerCase());
  }

  function closeMentionPanel() {
    setMentionPanel(null);
    mentionAnchorNodeRef.current = null;
    mentionAnchorOffsetRef.current = 0;
  }

  function insertMentionChip(tag: string) {
    const el = editorRef.current;
    if (!el) return;
    const anchorNode = mentionAnchorNodeRef.current;
    const anchorOff = mentionAnchorOffsetRef.current;
    if (anchorNode) {
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const cur = sel.getRangeAt(0);
        const r = document.createRange();
        r.setStart(anchorNode, anchorOff);
        r.setEnd(cur.endContainer, cur.endOffset);
        r.deleteContents();
      }
    }
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

  // ── 编辑器事件处理 ─────────────────────────────────────────────────

  function handleEditorInput() {
    const el = editorRef.current;
    if (!el) return;
    cleanChipBrs(el);
    const text = extractEditorText(el);
    setPrompt(text);

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
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        const node = r.startContainer;
        const off = r.startOffset;
        let prev: ChildNode | null = null;
        if (node.nodeType === Node.TEXT_NODE) {
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
    if (text) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        sel.getRangeAt(0).deleteContents();
        const el = editorRef.current;
        if (el) {
          cleanChipBrs(el);
          setPrompt(extractEditorText(el));
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
    const converted = raw.replace(/<ref>(@[^<\n]+)<\/ref>/g, '$1');
    const { start, end } = getSelectionRange(el);
    const currentText = extractEditorText(el);
    const newText = currentText.slice(0, start) + converted + currentText.slice(end);
    setEditorHtml(buildEditorHtml(newText));
    setPrompt(newText);
    const pos = start + converted.length;
    setTimeout(() => { if (editorRef.current) setCursorOffset(editorRef.current, pos); }, 0);
  }

  // 参考图变更时同步 chip 显示名
  useEffect(() => {
    if (!useMentionEditor) return;
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.mention-chip[data-tag]').forEach((chip) => {
      const tag = chip.getAttribute('data-tag') || '';
      const display = chipDisplayFor(tag);
      if (chip.textContent !== display) chip.textContent = display;
    });
  }, [refUrls, useMentionEditor]);

  // prompt 外部变更时同步编辑器 HTML（例如 handleReuse 回填）
  useEffect(() => {
    if (!useMentionEditor) return;
    const el = editorRef.current;
    if (!el) return;
    const currentLogical = extractEditorText(el);
    if (currentLogical !== prompt) {
      const sel = window.getSelection();
      const offset = sel?.rangeCount ? getCursorOffset(el) : prompt.length;
      setEditorHtml(buildEditorHtml(prompt));
      setTimeout(() => { if (editorRef.current) setCursorOffset(editorRef.current, Math.min(offset, prompt.length)); }, 0);
    }
  }, [prompt, useMentionEditor]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) { setError('请输入提示词'); return; }
    // 积分预检
    if (balance && !balance.unlimited && balance.available < 10) {
      setError('可用积分不足（每次生成消耗 10 积分），请联系管理员充值');
      return;
    }
    setLoading(true);
    setError('');
    // 3 秒冷却防连点；出错时立即恢复
    const coolTimer = setTimeout(() => setLoading(false), 3000);
    const clearCool = () => { clearTimeout(coolTimer); setLoading(false); };
    void (async () => {
      try {
      // 检查 prompt 中是否有 @N chip
      const hasAnyChip = mentionItems.some((m) => new RegExp(m.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(prompt));
      // @N → [Image N]（对齐 HappyHorse 多图生视频的 DB 存储格式）
      let finalPrompt = prompt.trim();
      if (hasAnyChip) {
        const refTotal = refUrls.length;
        finalPrompt = finalPrompt.replace(/@(\d+)/g, (m, g1) => {
          const n = parseInt(g1, 10);
          return n >= 1 && n <= refTotal ? `[Image ${n}]` : m;
        });
      }
      // 有 chip 时只发送被引用的参考图；无 chip 时保持向后兼容（全部发送）
      const effectiveRefUrls = hasAnyChip
        ? refUrls.filter((_, i) => {
            const tag = `@${i + 1}`;
            const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(escaped).test(prompt);
          })
        : refUrls;

      const body: Record<string, unknown> = {
        prompt: finalPrompt,
        model,
        sizeLabel,
        projectId: currentProjectId,
      };
      if (model === 'gpt-image-2') {
        body.size = gptAspect;
      } else {
        body.size = nanoSize;
        body.aspectRatio = nanoAspect;
      }
      if (effectiveRefUrls.length > 0) {
        body.urls = effectiveRefUrls;
        body.refUrls = effectiveRefUrls;
      }
      const res = await fetch('/api/generate-image', { method: 'POST', headers: getAuthHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok || !data.success) { setError(data.error || '生成失败'); }
    } catch (e) {
      clearCool();
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      void loadHistory(1, false, currentProjectId);
      void refreshBalance();
    }
  })();
}, [prompt, model, gptAspect, nanoSize, nanoAspect, sizeLabel, refUrls, mentionItems, currentProjectId, loadHistory, refreshBalance, balance]);

  const handleReuse = (item: ImageRecord) => {
    // [Image N] → @N 还原，由编辑器 useEffect 自动重建 chip
    let restoredPrompt = item.prompt || '';
    if (item.ref_urls.length > 0) {
      restoredPrompt = restoredPrompt.replace(/\[Image (\d+)\]/g, '@$1');
    }
    setPrompt(restoredPrompt);
    setModel(item.model);
    setRefUrls(item.ref_urls);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">图片生成</h1>
      </div>

      {/* Left Panel */}
      <div className="flex-1 md:w-[520px] md:flex-none md:border-r border-gray-800 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        <div className="hidden md:flex flex-col gap-1 mb-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold truncate">图片生成</h2>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => void loadHistory(1, false, currentProjectId)} disabled={historyLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-medium text-white transition-all disabled:opacity-50">
                <svg className={`w-4 h-4 ${historyLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {historyLoading ? '刷新中...' : '刷新'}
              </button>
              <button onClick={() => window.location.href='/settings'} className="btn-ghost" title="设置">
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
          {/* 模型选择 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">生图模型</label>
            <div className="flex flex-col gap-2">
              {IMAGE_MODELS.map((opt) => (
                <button key={opt.value} onClick={() => setModel(opt.value)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${model === opt.value ? 'border-purple-500 bg-purple-500/10' : 'border-gray-700 bg-[#161824] hover:border-gray-600'}`}
                >
                  <div className={`text-sm font-medium ${model === opt.value ? 'text-purple-400' : 'text-gray-300'}`}>{opt.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{opt.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 参考图 */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="text-sm font-bold text-gray-300 mb-2 block">
              参考图 <span className="text-xs text-gray-500 font-normal">（选填，拖拽或点击上传，最多 4 张）</span>
            </label>

            {refUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {refUrls.map((url, i) => (
                  <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-gray-700 bg-[#0d0f1a] group">
                    <img src={url} alt={`参考图${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={() => removeRefImage(i)}
                      className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-lg"
                    >×</button>
                  </div>
                ))}
              </div>
            )}

            <div
              onClick={() => !uploadingRef && refUrls.length < 4 && fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (!uploadingRef) handleRefUpload(e.dataTransfer.files); }}
              className={`w-full border border-dashed border-gray-700 rounded-2xl flex flex-col items-center justify-center py-6 ${uploadingRef || refUrls.length >= 4 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-purple-500/50 hover:bg-[#25293d]'} transition-all`}
            >
              {uploadingRef ? (
                <div className="text-gray-400 text-sm flex items-center gap-2">
                  <span className="animate-spin h-4 w-4 border-2 border-purple-400 border-t-transparent rounded-full" /> 上传中...
                </div>
              ) : refUrls.length >= 4 ? (
                <div className="text-gray-500 text-xs text-center">
                  <svg className="w-8 h-8 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span className="block">已达上限（4 张）</span>
                </div>
              ) : (
                <div className="text-gray-500 text-xs text-center">
                  <svg className="w-10 h-10 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                  <span className="block">点击或拖拽图片到此处</span>
                  <span className="text-gray-600 text-[10px] mt-1 block">支持 JPG / PNG，单文件 ≤ 10MB</span>
                </div>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { if (e.target.files) handleRefUpload(e.target.files); e.target.value = ''; }} />
            </div>
          </div>

          {/* Prompt */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800">
            <label className="block text-sm font-bold mb-3 text-gray-300">
              提示词
              {useMentionEditor && <span className="text-gray-500 font-normal text-xs ml-1">（输入 @ 引用参考图）</span>}
            </label>
            {useMentionEditor ? (
              <div className="relative">
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder="描述你想生成的图片内容... 输入 @ 引用参考图"
                  onInput={handleEditorInput}
                  onKeyDown={handleEditorKeyDown}
                  onPaste={handleEditorPaste}
                  onCopy={handleEditorCopy}
                  onCut={handleEditorCut}
                  className="prompt-editor w-full min-h-[120px] bg-[#0d0f1a] border border-gray-700 rounded-xl p-3 text-sm text-white focus:border-purple-500 outline-none whitespace-pre-wrap break-words"
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
                          <img src={mi.url} alt="" className="w-8 h-8 object-cover rounded border border-gray-700" />
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
                placeholder="描述你想生成的图片内容..."
                className="w-full bg-[#0d0f1a] border-0 rounded-xl px-4 py-3 text-white text-sm resize-none focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              />
            )}
            <div className="text-right text-xs text-gray-500 mt-2">{prompt.length}/5000</div>
          </div>

          {/* Settings */}
          <div className="bg-[#1c1f2e] rounded-2xl p-4 border border-gray-800 space-y-5">

            {model === 'gpt-image-2' ? (
              <div>
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">图片比例</label>
                <div className="flex flex-wrap gap-2">
                  {GPT_ASPECT_OPTIONS.map((s) => (
                    <button key={s} onClick={() => setGptAspect(s)}
                      className={`px-3 py-2 rounded-xl border text-sm transition-all ${gptAspect === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                    >{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">分辨率</label>
                  <div className="flex flex-wrap gap-2">
                    {NANO_SIZE_OPTIONS.map((s) => (
                      <button key={s} onClick={() => setNanoSize(s)}
                        className={`px-4 py-2 rounded-xl border text-sm transition-all ${nanoSize === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                      >{s}</button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-600 mt-2">分辨率越高，生成时间越长</p>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-3">图片比例</label>
                  <div className="flex flex-wrap gap-2">
                    {NANO_ASPECT_OPTIONS.map((s) => (
                      <button key={s} onClick={() => setNanoAspect(s)}
                        className={`px-3 py-2 rounded-xl border text-sm transition-all ${nanoAspect === s ? 'border-purple-500 bg-purple-500/10 text-purple-400' : 'border-gray-700 bg-[#161824] text-gray-400 hover:border-gray-600'}`}
                      >{s}</button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {error && <p className="text-sm text-red-400 px-1">{error}</p>}

          <div className="pb-4">
            <button
              onClick={handleGenerate}
              disabled={loading || !prompt.trim()}
              className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-purple-900/20 flex items-center justify-center gap-2"
            >
              {loading ? (
                <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />生成中...</>
              ) : (
                <><SparkleIcon className="w-4 h-4" />生成图片</>
              )}
            </button>
            <p className="text-xs text-gray-600 text-center mt-2">
              每次消耗 10 积分
              {balance && (
                <span className="ml-2 text-gray-500">
                  · 余额 {balance.unlimited ? <span className="text-amber-400">无限</span> : <span className={balance.available < 10 ? 'text-red-400 font-semibold' : 'text-gray-300 font-semibold'}>{balance.available}</span>} 积分
                  {!balance.unlimited && balance.locked > 0 && (
                    <span className="ml-1 text-amber-400/80">(锁定 {balance.locked})</span>
                  )}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel - History */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
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

        {records.length === 0 && !loading && !historyLoading && (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            暂无生成记录
          </div>
        )}

        <div className="px-4 pb-4 space-y-3 mt-2">
          {records.map((item) => (
            <div key={item.id} className="bg-[#1c1f2e] border border-gray-800 hover:border-gray-700 rounded-2xl overflow-hidden transition-all">
              <div className="flex gap-3 p-3 items-start">
                {/* 缩略图区域 */}
                <div
                  className="w-[25vh] h-[25vh] min-w-[120px] min-h-[120px] flex-shrink-0 rounded-xl overflow-hidden bg-[#0f111a] cursor-pointer relative group"
                  onClick={() => item.result_urls[0] && setPreviewUrl(item.result_urls[0])}
                >
                  {item.status === 'pending' ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-purple-300 text-xs">
                      <span className="animate-spin h-6 w-6 border-2 border-purple-400 border-t-transparent rounded-full" />
                      生成中...
                    </div>
                  ) : item.status === 'error' ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-red-400 text-xs px-2 text-center">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      生成失败
                    </div>
                  ) : item.result_urls.length > 0 ? (
                    <>
                      <img src={item.result_urls[0]} alt="预览" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" /></svg>
                      </div>
                      {item.result_urls.length > 1 && (
                        <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                          +{item.result_urls.length - 1}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-500 text-center px-2 flex items-center justify-center h-full">无图片</span>
                  )}
                </div>

                {/* 信息区域 */}
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <p className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{(item.prompt || '（无提示词）').replace(/\[Image (\d+)\]/g, '@图片$1')}</p>

                  {/* 失败原因（来自 image_records.error_message，由后端写入上游 API 原始 msg） */}
                  {item.status === 'error' && item.error_message && (
                    <p className="text-[11px] text-red-400/90 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1 leading-snug break-words">
                      失败原因：{item.error_message}
                    </p>
                  )}

                  {/* 参考图 */}
                  {item.ref_urls.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {item.ref_urls.slice(0, 4).map((u, i) => (
                        <img key={i} src={u} className="w-8 h-8 rounded-lg object-cover border border-gray-700 flex-shrink-0" />
                      ))}
                    </div>
                  )}

                  {/* 底部：时间 + 参数 + 操作 */}
                  <div className="flex items-end justify-between gap-2 mt-auto">
                    <span className="text-[10px] text-gray-600 flex-shrink-0">
                      {formatShortDateTime(item.created_at)}
                    </span>
                    <div className="flex flex-col items-end gap-1.5">
                      <div className="flex flex-wrap justify-end gap-1">
                        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 leading-none">图片</span>
                        {item.model && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 leading-none">
                            {item.model === 'gpt-image-2' ? 'GPT-2' : item.model === 'nano-banana-2' ? 'Nano2' : item.model}
                          </span>
                        )}
                        {item.size_label && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700/60 text-gray-400 leading-none">{item.size_label}</span>
                        )}
                        {item.credits_used > 0 && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 leading-none">{item.credits_used}积分</span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        {item.result_urls.length > 0 && (
                          <button
                            onClick={() => setPreviewUrl(item.result_urls[0])}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all"
                          >预览</button>
                        )}
                        {item.result_urls.map((url, i) => (
                          <button key={i}
                            onClick={() => downloadImageUrl(url, `image_${item.id}_${i + 1}.png`)}
                            className="text-[11px] px-2 py-1 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-all">
                            {item.result_urls.length > 1 ? `下载${i + 1}` : '下载'}
                          </button>
                        ))}
                        <button
                          onClick={() => handleReuse(item)}
                          className="text-[11px] px-2 py-1 rounded-xl border border-purple-500/40 text-purple-400 hover:bg-purple-500/10 transition-all"
                        >复用</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 无限滚动哨兵 */}
        <div ref={historyBottomRef} className="h-4" />
        {historyLoading && (
          <div className="flex justify-center py-4">
            <span className="animate-spin h-5 w-5 border-2 border-purple-400 border-t-transparent rounded-full" />
          </div>
        )}
        {!historyHasMore && records.length > 0 && (
          <div className="text-center text-xs text-gray-600 py-2">已显示全部记录</div>
        )}
      </div>

      {/* 图片预览 */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewUrl(null)}>
          <div className="relative max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPreviewUrl(null)}
              className="absolute -top-10 right-0 text-gray-400 hover:text-white transition-colors text-sm">
              关闭 ✕
            </button>
            <img src={previewUrl} alt="预览" className="w-full rounded-2xl max-h-[85vh] object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}