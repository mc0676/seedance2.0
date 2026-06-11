import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import Layout from '../components/Layout';
import { getAuthHeaders } from '../services/authService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SendIcon, ChatIcon } from '../components/Icons';
import { useUserTimezone, formatDateTime } from '../utils/datetime';
import type { TextDialogue } from '../types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  _id?: number; // tasks_text.id，用于删除单条消息
}

export default function TextGenPage() {
  useUserTimezone();
  const { state } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [dialogueId, setDialogueId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [dialogues, setDialogues] = useState<TextDialogue[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [hoverMsgId, setHoverMsgId] = useState<number | null>(null);

  const scrollToBottom = () => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });

  const loadDialogues = useCallback(async () => {
    try {
      const projectId = state.currentProject?.id;
      const params = new URLSearchParams({ page: '1', pageSize: '50' });
      if (projectId) params.append('projectId', String(projectId));
      const res = await fetch(`/api/text-gen/history?${params}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success) setDialogues(data.data.items);
    } catch {}
  }, [state.currentProject?.id]);

  useEffect(() => { loadDialogues(); }, [loadDialogues]);

  const loadDialogue = async (did: string) => {
    try {
      const res = await fetch(`/api/text-gen/dialogue/${encodeURIComponent(did)}`, { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.success) {
        const msgs: Message[] = [];
        for (const row of data.data.rows) {
          try {
            const items = JSON.parse(row.messages_in_once);
            for (const item of items) msgs.push({ ...item, _id: row.id });
          } catch {}
        }
        setMessages(msgs);
        setDialogueId(did);
        setTimeout(scrollToBottom, 100);
      }
    } catch {}
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    const userMsg: Message = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages([...newMessages, assistantMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      const res = await fetch('/api/text-gen', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
          projectId: state.currentProject?.id,
          id_of_dialogue: dialogueId,
          stream: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setMessages((prev) => { const c = [...prev]; const i = c.length - 1; if (c[i]?.role === 'assistant') c[i] = { ...c[i], content: '[错误] ' + (err.error || '请求失败') }; return c; });
        setStreaming(false); return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setStreaming(false); return; }
      const decoder = new TextDecoder();
      let buffer = '', content = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            if (chunk.done) {
              if (chunk.id_of_dialogue && !dialogueId) setDialogueId(chunk.id_of_dialogue);
              break;
            }
            content += chunk?.choices?.[0]?.delta?.content || '';
            setMessages((prev) => { const c = [...prev]; const i = c.length - 1; if (c[i]?.role === 'assistant') c[i] = { ...c[i], content }; return c; });
          } catch {}
        }
        buffer = '';
        scrollToBottom();
      }
    } catch (e: any) {
      setMessages((prev) => { const c = [...prev]; const i = c.length - 1; if (c[i]?.role === 'assistant') c[i] = { ...c[i], content: '[网络错误] ' + e.message }; return c; });
    } finally { setStreaming(false); loadDialogues(); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleNewChat = () => { setMessages([]); setDialogueId(null); };

  const handleDeleteMsg = async (msgId: number) => {
    if (!confirm('删除这一次对话么？')) return;
    try {
      await fetch(`/api/text-gen/message/${msgId}`, { method: 'DELETE', headers: getAuthHeaders() });
      setMessages((prev) => prev.filter((m) => m._id !== msgId));
    } catch {}
  };

  const handleDeleteDialogue = async (did: string) => {
    if (!confirm('删除整个对话？')) return;
    try {
      await fetch(`/api/text-gen/dialogue/${encodeURIComponent(did)}`, { method: 'DELETE', headers: getAuthHeaders() });
      setDialogues((prev) => prev.filter((d) => d.id_of_dialogue !== did));
      if (dialogueId === did) { setMessages([]); setDialogueId(null); }
    } catch {}
  };

  const handleRename = async (did: string) => {
    if (!renameText.trim()) { setRenamingId(null); return; }
    try {
      await fetch(`/api/text-gen/dialogue/${encodeURIComponent(did)}/rename`, {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: renameText.trim() }),
      });
      setDialogues((prev) => prev.map((d) => d.id_of_dialogue === did ? { ...d, name: renameText.trim() } : d));
    } catch {}
    setRenamingId(null);
  };

  const left = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <ChatIcon className="w-4 h-4 text-purple-400" />
          <span className="text-sm font-medium text-gray-200">历史对话</span>
        </div>
        <button onClick={handleNewChat} className="text-xs text-purple-400 hover:text-purple-300">新对话</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {dialogues.length === 0 ? (
          <p className="text-xs text-gray-600 text-center mt-8">暂无历史</p>
        ) : (
          dialogues.map((d) => (
            <div key={d.id_of_dialogue} className="border-b border-gray-800/50 hover:bg-[#1c1f2e] transition-colors group">
              {renamingId === d.id_of_dialogue ? (
                <div className="flex gap-1 px-4 py-2">
                  <input
                    autoFocus
                    className="flex-1 bg-[#0f111a] border border-purple-500 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRename(d.id_of_dialogue); if (e.key === 'Escape') setRenamingId(null); }}
                  />
                  <button onClick={() => handleRename(d.id_of_dialogue)} className="text-xs text-purple-400 hover:text-purple-300 px-1">保存</button>
                </div>
              ) : (
                <button onClick={() => loadDialogue(d.id_of_dialogue)} className="w-full text-left px-4 py-3 pr-16 relative">
                  <div className="text-xs text-gray-400 truncate">{d.name}</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">{formatDateTime(d.created_at)}</div>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={(e) => { e.stopPropagation(); setRenamingId(d.id_of_dialogue); setRenameText(d.name); }}
                      className="text-gray-500 hover:text-gray-300 text-[10px]" title="重命名">✎ 重命名</button>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteDialogue(d.id_of_dialogue); }}
                      className="text-red-500/70 hover:text-red-400 text-[10px]" title="删除对话">× 删除</button>
                  </div>
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );

  const right = (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3">
            <ChatIcon className="w-16 h-16 text-purple-500/20" />
            <p className="text-sm">向 DeepSeek 提问，开始对话</p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} group`}>
              <div className={`relative max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role === 'assistant' ? 'markdown-body' : ''} ${hoverMsgId === m._id ? 'ring-2 ring-red-500/40 shadow-lg shadow-red-500/20' : ''} ${
                m.role === 'user'
                  ? 'bg-purple-600/30 border border-purple-500/30 text-gray-200'
                  : 'bg-[#1c1f2e] border border-gray-700 text-gray-300'
              }`}>
              {m._id && (i === 0 || messages[i-1]?._id !== m._id) && (
                <button
                  onClick={() => handleDeleteMsg(m._id!)}
                  onMouseEnter={() => setHoverMsgId(m._id!)}
                  onMouseLeave={() => setHoverMsgId(null)}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500/80 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center hover:bg-red-500"
                  title="删除这一问一答"
                >×</button>
              )}
                <div className="whitespace-pre-wrap break-words">
                  {m.content ? (
                    m.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    ) : m.content
                  ) : (streaming && m.role === 'assistant' ? <span className="animate-pulse text-gray-500">▊</span> : '')}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="px-4 pb-4 pt-2 border-t border-gray-800">
        <div className="flex gap-2 bg-[#1c1f2e] border border-gray-700 rounded-2xl px-4 py-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入内容，Enter 发送，Shift+Enter 换行"
            rows={2}
            disabled={streaming}
            className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-500 resize-none focus:outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || streaming}
            className="self-end p-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white transition-all"
          >
            <SendIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Layout
      title="文本生成"
      projectName={state.currentProject?.name}
      historyTitle=""
      left={left}
      right={right}
    />
  );
}
