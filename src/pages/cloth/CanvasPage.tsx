import { useState, useRef, useEffect, useCallback, memo } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../../context/AppContext";
import { getAuthHeaders } from "../../services/authService";
import { DownloadIcon, PencilIcon, PlusIcon, CloseIcon, TrashIcon, CheckIcon, FileUpIcon } from "../../components/Icons";
import { formatDateTime } from "../../utils/datetime";
import type { CanvasCloth } from "../../types";

// 删除确认对话框
function DeleteConfirmDialog({ ids, onConfirm, onClose }: { ids: Set<string>; onConfirm: () => void; onClose: () => void }) {
  const count = ids.size;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="rounded-lg border border-stone-800 bg-[#141414] p-6 shadow-2xl max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-stone-100">删除画布？</h3>
        <p className="mt-2 text-sm text-stone-500">将删除 {count} 个画布，里面的节点和连线也会一起移除。</p>
        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-lg border px-4 py-1.5 text-sm transition"
            style={{ borderColor: "#424242", color: "rgba(255,255,255,0.85)" }}
            onMouseEnter={(e) => { const t = e.currentTarget; t.style.borderColor = '#e8e8e8'; t.style.color = '#e8e8e8'; }}
            onMouseLeave={(e) => { const t = e.currentTarget; t.style.borderColor = '#424242'; t.style.color = 'rgba(255,255,255,0.85)'; }}>
            取消
          </button>
          <button onClick={onConfirm} className="rounded-lg px-4 py-1.5 text-sm text-white transition"
            style={{ background: "#dc4446" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#e84749'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#dc4446'; }}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// 卡片组件
const CanvasProjectCard = memo(function CanvasProjectCard({
  cloth, onRename, onExport, onDelete, onEnter, selected, onToggleSelect,
}: {
  cloth: CanvasCloth & { nodeCount?: number; connCount?: number };
  onRename: (id: string, title: string, curTitle: string) => void;
  onExport: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onEnter: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(cloth.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const saveTitle = () => {
    const v = editTitle.trim();
    if (v && v !== cloth.title) onRename(cloth.id, v, cloth.title);
    setEditing(false);
  };

  return (
    <article
      className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-white/5 p-5 transition hover:bg-white/10"
      onClick={() => { if (!editing) onEnter(cloth.id); }}
    >
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onClick={(e) => e.stopPropagation()} onChange={(e) => onToggleSelect(cloth.id, e.target.checked)} className="mt-1 size-4 accent-stone-100" aria-label={`选择 ${cloth.title}`} />
        {editing ? (
          <input ref={inputRef} className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-stone-100 outline-none" value={editTitle}
            onClick={(e) => e.stopPropagation()} onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") { setEditTitle(cloth.title); setEditing(false); } }} autoFocus />
        ) : (
          <button className="min-w-0 cursor-pointer text-left">
            <h2 className="truncate text-xl font-semibold text-stone-100">{cloth.title}</h2>
            <p className="mt-3 text-sm leading-6 text-stone-400">{cloth.nodeCount ?? 0} 个节点 · {cloth.connCount ?? 0} 条连线</p>
          </button>
        )}
      </div>
      <div className="mt-8 flex items-end justify-between gap-3">
        <p className="text-xs text-stone-500">更新于 {formatDateTime(cloth.updated_at)?.slice(0, 16) || cloth.updated_at?.slice(0, 16) || ""}</p>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <>
              <button onClick={saveTitle} className="rounded-full p-2 text-stone-400 hover:bg-white/10 hover:text-stone-100 transition" title="保存"><CheckIcon className="size-4" /></button>
              <button onClick={() => { setEditTitle(cloth.title); setEditing(false); }} className="rounded-full p-2 text-stone-400 hover:bg-white/10 hover:text-stone-100 transition" title="取消"><CloseIcon className="size-4" /></button>
            </>
          ) : (
            <>
              <button onClick={() => onExport(cloth.id, cloth.title)} className="rounded-full p-2 text-stone-400 hover:bg-white/10 hover:text-stone-100 transition" title="导出"><DownloadIcon className="size-4" /></button>
              <button onClick={() => { setEditing(true); setEditTitle(cloth.title); setTimeout(() => inputRef.current?.focus(), 50); }} className="rounded-full p-2 text-stone-400 hover:bg-white/10 hover:text-stone-100 transition" title="重命名"><PencilIcon className="size-4" /></button>
              <button onClick={() => onDelete(cloth.id)} className="rounded-full p-2 text-stone-400 hover:bg-white/10 hover:text-red-400 transition" title="删除"><TrashIcon className="size-4" /></button>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

// 导出
async function exportCloth(clothId: string, title: string) {
  const [aRes, cRes] = await Promise.all([
    fetch(`/api/cloths/${clothId}/assets`, { headers: getAuthHeaders() }),
    fetch(`/api/cloths/${clothId}/connections`, { headers: getAuthHeaders() }),
  ]);
  const [aData, cData] = await Promise.all([aRes.json(), cRes.json()]);
  const blob = new Blob([JSON.stringify({ app: "seedance-canvas", version: 1, exportedAt: new Date().toISOString(), cloth: { title, assets: aData.data || [], connections: cData.data || [] } }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title || "画布"}.canvas.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function CanvasPage() {
  const navigate = useNavigate();
  const { state } = useApp();
  const [cloths, setCloths] = useState<(CanvasCloth & { nodeCount?: number; connCount?: number })[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<Set<string> | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const pid = state.currentProject?.id;
      if (!pid) { setLoading(false); return; }
      const url = `/api/cloths?projectId=${pid}`;
      const res = await fetch(url, { headers: getAuthHeaders() });
      const d = await res.json();
      if (!d.success) return;
      const enriched = await Promise.all((d.data as CanvasCloth[]).map(async (c) => {
        try {
          const [aR, cR] = await Promise.all([fetch(`/api/cloths/${c.id}/assets`, { headers: getAuthHeaders() }), fetch(`/api/cloths/${c.id}/connections`, { headers: getAuthHeaders() })]);
          const [aD, cD] = await Promise.all([aR.json(), cR.json()]);
          return { ...c, nodeCount: aD.data?.length || 0, connCount: cD.data?.length || 0 };
        } catch { return { ...c, nodeCount: 0, connCount: 0 }; }
      }));
      setCloths(enriched);
    } catch {} finally { setLoading(false); }
  }, [state.currentProject?.id]);

  useEffect(() => { load(); }, [load]);

  const createAndEnter = async () => {
    const title = `无限画布 ${cloths.length + 1}`;
    const id = "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await fetch("/api/cloths", { method: "POST", headers: getAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id, title, project_id: state.currentProject?.id }) });
    navigate(`/cloth/${id}`);
  };

  const rename = async (id: string, n: string, cur: string) => {
    if (n === cur) return;
    await fetch(`/api/cloths/${id}`, { method: "PUT", headers: getAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ title: n }) });
    setCloths((p) => p.map((c) => (c.id === id ? { ...c, title: n } : c)));
  };

  const del = async (id: string) => {
    if (!confirm("删除此画布？")) return;
    await fetch(`/api/cloths/${id}`, { method: "DELETE", headers: getAuthHeaders() });
    load();
  };

  const doDeleteMany = async () => {
    if (!deleteIds) return;
    for (const id of deleteIds) await fetch(`/api/cloths/${id}`, { method: "DELETE", headers: getAuthHeaders() });
    setDeleteIds(null);
    setSelectedIds(new Set());
    load();
  };

  const toggle = (id: string, checked: boolean) => setSelectedIds((p) => { const n = new Set(p); checked ? n.add(id) : n.delete(id); return n; });
  const batchExport = async () => { const sel = cloths.filter((c) => selectedIds.has(c.id)); for (const c of sel) await exportCloth(c.id, c.title); };

  const batchDelete = async () => {
    if (!confirm(`删除选中的 ${selectedIds.size} 个画布？`)) return;
    for (const id of selectedIds) await fetch(`/api/cloths/${id}`, { method: "DELETE", headers: getAuthHeaders() });
    setSelectedIds(new Set()); load();
  };

  const imp = async (f?: File) => {
    if (!f) return;
    try {
      const tx = await f.text();
      const d = JSON.parse(tx);
      if (!d.cloth?.title) throw 0;
      const { title, assets = [], connections = [] } = d.cloth;
      const id = "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await fetch("/api/cloths", { method: "POST", headers: getAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id, title, project_id: state.currentProject?.id }) });
      if (assets.length) await fetch(`/api/cloths/${id}/assets`, { method: "POST", headers: getAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ assets }) });
      if (connections.length) await fetch(`/api/cloths/${id}/connections`, { method: "POST", headers: getAuthHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ connections }) });
      load();
    } catch { alert("导入失败，请选择有效的画布文件"); } finally { if (importRef.current) importRef.current.value = ""; }
  };

  return (
    <main className="min-h-screen overflow-auto" style={{ background: "var(--canvas-bg)", color: "var(--canvas-fg)" }}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-6" style={{ borderColor: "var(--canvas-border)" }}>
          <div>
            <p className="text-xs" style={{ color: "#78716c" }}>画布库</p>
            <h1 className="mt-3 text-3xl font-semibold">无限画布</h1>
          </div>
          <div className="flex items-center gap-2">
            {selectedIds.size > 0 ? (
              <>
                <button onClick={batchExport} className="flex items-center gap-1.5 rounded-lg border px-4 py-1.5 text-sm transition" style={{ borderColor: "#424242", color: "rgba(255,255,255,0.85)" }}
                  onMouseEnter={(e) => { const t = e.currentTarget; t.style.borderColor = '#e8e8e8'; t.style.color = '#e8e8e8'; }}
                  onMouseLeave={(e) => { const t = e.currentTarget; t.style.borderColor = '#424242'; t.style.color = 'rgba(255,255,255,0.85)'; }}>
                  <DownloadIcon className="size-4" />导出选中 ({selectedIds.size})
                </button>
                <button onClick={batchDelete} className="flex items-center gap-1.5 rounded-lg border px-4 py-1.5 text-sm transition" style={{ borderColor: "#424242", color: "rgba(255,255,255,0.85)" }}
                  onMouseEnter={(e) => { const t = e.currentTarget; t.style.borderColor = '#e8e8e8'; t.style.color = '#e8e8e8'; }}
                  onMouseLeave={(e) => { const t = e.currentTarget; t.style.borderColor = '#424242'; t.style.color = 'rgba(255,255,255,0.85)'; }}>
                  删除选中
                </button>
              </>
            ) : cloths.length > 0 ? (
              <button onClick={() => setDeleteIds(new Set(cloths.map((c) => c.id)))} className="flex items-center gap-1.5 rounded-lg border px-4 py-1.5 text-sm transition" style={{ borderColor: "#424242", color: "rgba(255,255,255,0.85)" }}
                onMouseEnter={(e) => { const t = e.currentTarget; t.style.borderColor = '#e8e8e8'; t.style.color = '#e8e8e8'; }}
                onMouseLeave={(e) => { const t = e.currentTarget; t.style.borderColor = '#424242'; t.style.color = 'rgba(255,255,255,0.85)'; }}>
                删除全部
              </button>
            ) : null}
            {cloths.length > 0 && (
              <button onClick={() => importRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border px-4 py-1.5 text-sm transition" style={{ borderColor: "#424242", color: "rgba(255,255,255,0.85)" }}
                onMouseEnter={(e) => { const t = e.currentTarget; t.style.borderColor = '#e8e8e8'; t.style.color = '#e8e8e8'; }}
                onMouseLeave={(e) => { const t = e.currentTarget; t.style.borderColor = '#424242'; t.style.color = 'rgba(255,255,255,0.85)'; }}>
                <FileUpIcon className="size-4" />导入画布
              </button>
            )}
            <button onClick={createAndEnter} className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm transition disabled:opacity-50" disabled={loading}
              style={{ background: "#d8d8d8", color: "#141414" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e8e8e8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#d8d8d8'; }}>
              <PlusIcon className="size-4" />新建画布
            </button>
          </div>
        </header>

        {loading ? (
          <section className="flex min-h-[360px] items-center justify-center border-y text-sm" style={{ borderColor: "#44403c", color: "#78716c" }}>正在加载画布...</section>
        ) : cloths.length ? (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {cloths.map((c) => (
              <CanvasProjectCard key={c.id} cloth={c} onRename={rename} onExport={exportCloth} onDelete={del} onEnter={(id) => navigate(`/cloth/${id}`)} selected={selectedIds.has(c.id)} onToggleSelect={toggle} />
            ))}
          </div>
        ) : (
          <section className="flex min-h-[360px] flex-col items-center justify-center border-y text-center" style={{ borderColor: "var(--canvas-border)" }}>
            <h2 className="text-xl font-medium">还没有画布</h2>
            <p className="mt-3 text-sm" style={{ color: "#78716c" }}>新建一个画布后，就可以独立保存节点、连线和画布外观。</p>
            <button onClick={createAndEnter} className="mt-6 flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm transition"
              style={{ background: "#d8d8d8", color: "#141414" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e8e8e8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#d8d8d8'; }}>
              <PlusIcon className="size-4" />新建画布
            </button>
          </section>
        )}
      </div>
      <input ref={importRef} type="file" accept=".json,.canvas.json" className="hidden" onChange={(e) => imp(e.target.files?.[0])} />
      {deleteIds && <DeleteConfirmDialog ids={deleteIds} onConfirm={doDeleteMany} onClose={() => setDeleteIds(null)} />}
    </main>
  );
}
