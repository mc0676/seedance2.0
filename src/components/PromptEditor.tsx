/**
 * PromptEditor - TipTap prompt editor
 * - @mention dropdown with thumbnail previews
 * - Inline thumbnail chips for images
 * - onChange outputs plain text @tag format
 */
import { useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { Extension } from '@tiptap/core';
import { createRoot, Root } from 'react-dom/client';

export interface ReferenceItem {
  tag: string;
  name: string;
  url?: string;
  type: 'image' | 'video' | 'audio';
  source?: 'upload' | 'asset';
}
export interface PromptEditorHandle { insertMention(tag: string): void }

interface Props {
  refs: ReferenceItem[];
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  editorId?: string;
  className?: string;
  onReady?: (h: PromptEditorHandle) => void;
}

// ---- Mention dropdown ----
function showPopup(
  items: ReferenceItem[],
  onSelect: (item: ReferenceItem) => void,
  clientRect?: () => DOMRect | null,
) {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.zIndex = '50';
  document.body.appendChild(el);
  const r = clientRect?.();
  if (r) { el.style.top = `${r.bottom + 4}px`; el.style.left = `${r.left}px`; }
  const root: Root = createRoot(el);

  const uploadItems = items.filter(it => it.source === 'upload');
  const assetItems = items.filter(it => it.source === 'asset');
  const hasSep = uploadItems.length > 0 && assetItems.length > 0;

  const origClose = () => { setTimeout(() => root.unmount(), 0); el.remove(); };
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('mouseup', onDocMouseUp, true);
    origClose();
  };
  const onDocMouseDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) {
      closeTimer = setTimeout(() => close(), 100);
    }
  };
  const onDocMouseUp = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  };
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('mouseup', onDocMouseUp, true);

  const renderItem = (it: ReferenceItem) => (
    <button key={it.tag} type="button"
      onClick={() => { onSelect(it); close(); }}
      className="flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-[#1c1f2e] transition-colors">
      {it.type === 'image' && it.url
        ? <img src={it.url} className="w-10 h-10 object-cover rounded-lg border border-gray-700 flex-shrink-0" alt="" />
        : <div className={`w-10 h-10 rounded-lg border border-gray-700 flex items-center justify-center flex-shrink-0 ${it.type === 'video' ? 'bg-blue-500/10' : 'bg-green-500/10'}`}>
            {it.type === 'video' ? '🎬' : '🎵'}
          </div>
      }
      <span className="text-sm text-gray-200 truncate">{it.name}</span>
    </button>
  );

  root.render(
    <div className="bg-[#12141f] border border-gray-700/60 rounded-xl shadow-[0_8px_56px_rgba(0,0,0,0.5)] overflow-hidden w-[260px]"
      onMouseDown={e => e.preventDefault()}>
      <div className="px-3 py-2.5 text-xs font-medium text-gray-400 border-b border-gray-800/60">
        引用素材
      </div>
      <div className="max-h-72 overflow-y-auto custom-scrollbar py-1" style={{ scrollbarGutter: 'stable' }}>
        {uploadItems.length > 0 && (<>{uploadItems.map(renderItem)}{hasSep ? <div className="mx-3 my-1 border-t border-gray-800/60" /> : null}</>)}
        {assetItems.map(renderItem)}
        {items.length === 0 && <div className="px-3 py-4 text-xs text-gray-500 text-center">无匹配素材</div>}
      </div>
    </div>
  );
  return close;
}

// ---- Component ----
export default function PromptEditor({
  refs, value, onChange,
  placeholder = 'Describe your video scene...',
  maxLength = 5000, disabled = false,
  editorId, className = 'min-h-[100px]',
  onReady,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const editorRef = useRef<any>(null);

  const suggestion = useMemo(() => ({
    char: '@',
    items: ({ query }: { query: string }): string[] => {
      const r = refsRef.current;
      const q = query.toLowerCase();
      const filtered = q ? r.filter(it => {
        const tagBody = it.tag.replace(/^@/, '');
        return tagBody.toLowerCase().startsWith(q) || it.name.toLowerCase().includes(q);
      }) : r;
      return filtered.map(it => it.tag);
    },
    render: () => {
      let closeFn: (() => void) | null = null;
      const cleanup = () => { closeFn?.(); closeFn = null; };

      const filterAndShow = (query: string, cmd: (item: { id: string }) => void, cr?: () => DOMRect | null) => {
        cleanup();
        const r = refsRef.current;
        const q = query.toLowerCase();
        const filtered = q
          ? r.filter(it => {
              const tagBody = it.tag.replace(/^@/, '');
              return tagBody.toLowerCase().startsWith(q) || it.name.toLowerCase().includes(q);
            })
          : r;
        const wrappedCmd = (item: ReferenceItem) => {
          const ed = editorRef.current;
          setTimeout(() => {
            if (!ed) return;
            const sel = window.getSelection();
            if (!sel?.rangeCount) return;
            const { startContainer, startOffset } = sel.getRangeAt(0);
            if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
              const text = startContainer.textContent || '';
              if (text[startOffset - 1] === ' ') {
                const pos = ed.state.doc.resolve(ed.state.selection.from - 1).pos;
                ed.view.dispatch(ed.state.tr.delete(pos, pos + 1));
              }
            }
          }, 0);
          cmd({ id: item.tag });
        };
        closeFn = showPopup(filtered, wrappedCmd, cr);
      };

      return {
        onStart(props: any) { filterAndShow(props.query || '', props.command, props.clientRect); },
        onUpdate(props: any) { filterAndShow(props.query || '', props.command, props.clientRect); },
        onKeyDown(props: { event: KeyboardEvent }) {
          if (props.event.key === 'Escape') { cleanup(); return true; }
          if (props.event.key === 'ArrowDown' || props.event.key === 'ArrowUp') return true;
          if (props.event.key === 'Enter') return true;
          return false;
        },
        onExit() { cleanup(); },
      };
    },
  }), []);

  // Smart @ insertion (no space before @)
  const SmartAt = useMemo(() => Extension.create({
    name: 'smartAt',
    addKeyboardShortcuts() {
      return {
        '@': () => {
          const { $from, empty } = this.editor.state.selection;
          if (!empty) return false;
          const text = $from.parent.textContent.slice(0, $from.parentOffset);
          if (text.length > 0 && !/\s$/.test(text)) {
            this.editor.commands.insertContent(' @');
            return true;
          }
          return false;
        },
      };
    },
  }), []);

  // 从编辑器 DOM 提取纯文本（包含 mention chip 的 data-tag）
  // ProseMirror 的 textContent 会丢失 atom 节点（如 mention）的文本，因此必须从 DOM 提取
  function extractEditorText(dom: HTMLElement): string {
    let text = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent ?? '').replace(/\u200B/g, '');
      } else if ((node as Element).classList?.contains('mention-chip')) {
        text += (node as Element).getAttribute('data-tag') ?? '';
      } else if ((node as Element).tagName === 'BR') {
        text += '\n';
      } else {
        node.childNodes.forEach(walk);
      }
    };
    dom.childNodes.forEach(walk);
    return text.replace(/\n+$/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  const editor = useEditor({
    extensions: [
      SmartAt,
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false,
        blockquote: false, codeBlock: false, horizontalRule: false,
        strike: false, italic: false, bold: false, code: false,
      }),
      Placeholder.configure({ placeholder, showOnlyWhenEditable: true }),
      Mention.configure({
        HTMLAttributes: { class: 'mention-chip' },
        suggestion,
        renderHTML({ node }) {
          const tag = (node.attrs.id as string) || '';
          const ref = refsRef.current.find((r: ReferenceItem) => r.tag === tag);
          const hasImg = !!(ref?.url && ref.type === 'image');
          const icon = ref?.type === 'video' ? '🎬' : ref?.type === 'audio' ? '🎵' : '';
          const name = ref?.name || tag;
          const shortName = name.length > 8 ? name.slice(0, 7) + '...' : name;
          if (hasImg) {
            return ['span', { class: 'mention-chip mention-chip--img', 'data-tag': tag, contenteditable: 'false' },
              ['img', { src: ref!.url, class: 'mention-chip-thumb', alt: '', draggable: 'false' }],
              ['span', { class: 'mention-chip-label' }, shortName],
            ];
          }
          if (icon) return ['span', { class: 'mention-chip', 'data-tag': tag, contenteditable: 'false' },
            ['span', { class: 'mention-chip-icon' }, icon], ['span', { class: 'mention-chip-label' }, shortName]];
          return ['span', { class: 'mention-chip', 'data-tag': tag, contenteditable: 'false' }, shortName];
        },
        renderText({ node }) { return (node.attrs.id as string) || ''; },
      }),
    ],
    content: value || '',
    editable: !disabled,
    editorProps: {
      handlePaste: (_view, event, _slice) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        event.preventDefault();
        let raw = text.replace(/\[([^\]]+)\]/g, '@$1');
        raw = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const { from, to } = _view.state.selection;

        const tags = refsRef.current.map((r: ReferenceItem) => r.tag);
        const pattern = tags.length > 0
          ? new RegExp('(' + tags.map((t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g')
          : null;
        const nodes: Array<{ type: 'text'; text: string } | { type: 'mention'; tag: string }> = [];
        let last = 0;
        if (pattern) {
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(raw)) !== null) {
            if (m.index > last) nodes.push({ type: 'text', text: raw.slice(last, m.index) });
            nodes.push({ type: 'mention', tag: m[0] });
            last = m.index + m[0].length;
          }
        }
        if (last < raw.length) nodes.push({ type: 'text', text: raw.slice(last) });
        if (nodes.length === 0) nodes.push({ type: 'text', text: raw });

        const tr = _view.state.tr.replaceWith(from, to, _view.state.schema.nodes.paragraph.create(null,
          nodes.map(n => n.type === 'mention'
            ? _view.state.schema.nodes.mention.create({ id: n.tag })
            : _view.state.schema.text(n.text)
          )
        ));
        _view.dispatch(tr);
        return true;
      },
      transformPastedText: (text: string) => {
        return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n');
      },
    },
    onCreate({ editor: ed }) {
      const dom = ed.view.dom;
      const handler = (e: ClipboardEvent) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!dom.contains(range.commonAncestorContainer)) return;
        e.preventDefault();
        const fragment = range.cloneContents();
        let text = '';
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
          } else if ((node as Element).classList?.contains('mention-chip')) {
            text += (node as Element).getAttribute('data-tag') || '';
          } else if ((node as Element).tagName === 'BR') {
            text += '\n';
          } else if ((node as Element).tagName === 'P' || (node as Element).tagName === 'DIV') {
            node.childNodes.forEach(walk);
            if (text && !text.endsWith('\n')) text += '\n';
          } else {
            node.childNodes.forEach(walk);
          }
        };
        fragment.childNodes.forEach(walk);
        text = text.replace(/\n+$/, '');
        const refText = text.replace(/@([^\s@]+)/g, '[$1]');
        e.clipboardData?.setData('text/plain', refText);
        e.clipboardData?.setData('text/html', refText.replace(/\n/g, '<br>'));
        if (e.type === 'cut') { range.deleteContents(); }
      };
      dom.addEventListener('copy', handler);
      dom.addEventListener('cut', handler);
    },
    onUpdate: ({ editor: ed }) => {
      const text = extractEditorText(ed.view.dom);
      if (maxLength && text.length > maxLength) ed.commands.setContent(text.slice(0, maxLength), { emitUpdate: false });
      else onChangeRef.current(text);
    },
  }, []);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    editorRef.current = editor;
    if (editor && onReadyRef.current) {
      onReadyRef.current({ insertMention: (tag: string) => { editor.commands.insertContent({ type: 'mention', attrs: { id: tag } }); } });
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const cur = extractEditorText(editor.view.dom);
    if (cur !== value && value !== undefined) editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const handler = () => {
      const sel = window.getSelection();
      const hasSelection = !!(sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer));
      el.querySelectorAll('.mention-chip').forEach((chip) => {
        if (!hasSelection) { chip.classList.remove('mention-chip--selected'); return; }
        const range = sel!.getRangeAt(0);
        const cr = document.createRange();
        cr.selectNode(chip);
        const overlaps = range.compareBoundaryPoints(Range.END_TO_START, cr) < 0 &&
                         range.compareBoundaryPoints(Range.START_TO_END, cr) > 0;
        chip.classList.toggle('mention-chip--selected', overlaps);
      });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [editor]);

  return (
    <div className="bg-[#0d0f1a] rounded-xl focus-within:ring-1 focus-within:ring-purple-500/50 transition-shadow">
      <EditorContent editor={editor} id={editorId}
        className={`prompt-editor-content px-4 py-3 text-sm text-gray-200 leading-relaxed ${className}`} />
    </div>
  );
}
