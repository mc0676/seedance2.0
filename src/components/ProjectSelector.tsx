import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import type { Project } from '../types/index';

const ROLE_LABEL: Record<string, string> = {
  owner: '创建者',
  admin: '管理员',
  member: '成员',
};

const ROLE_COLOR: Record<string, string> = {
  owner: 'bg-amber-500/20 text-amber-300',
  admin: 'bg-blue-500/20 text-blue-300',
  member: 'bg-gray-500/20 text-gray-300',
};

export default function ProjectSelector() {
  const { state, selectProject, createProjectAction, deleteProjectAction, currentUser } = useApp();
  const { projects, currentProject } = state;

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';

  async function handleDelete(p: Project, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`确定删除工作组「${p.name}」？此操作不可恢复，工作组内所有素材和任务也将一并删除。`)) return;
    setDeletingId(p.id);
    try {
      await deleteProjectAction(p.id);
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
  }
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateLoading(true);
    setError('');
    try {
      const project = await createProjectAction(newName.trim(), newDesc.trim() || undefined);
      selectProject(project);
      setCreating(false);
      setOpen(false);
      setNewName('');
      setNewDesc('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreateLoading(false);
    }
  }

  function handleSelect(p: Project) {
    selectProject(p);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative px-3 py-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-gray-400 shrink-0">工作组</span>
          {currentProject ? (
            <span className="truncate text-white font-medium">{currentProject.name}</span>
          ) : (
            <span className="text-gray-400 italic">未选择</span>
          )}
        </div>
        {currentProject?.my_role && (
          <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${ROLE_COLOR[currentProject.my_role] ?? ROLE_COLOR.member}`}>
            {ROLE_LABEL[currentProject.my_role] ?? currentProject.my_role}
          </span>
        )}
        <svg className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          {projects.length > 0 && (
            <ul className="max-h-48 overflow-y-auto">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center">
                  <button
                    onClick={() => handleSelect(p)}
                    className={`flex-1 text-left px-3 py-2 flex items-center justify-between hover:bg-white/10 transition-colors text-sm ${currentProject?.id === p.id ? 'bg-white/10' : ''}`}
                  >
                    <span className="truncate text-white">{p.name}</span>
                    {p.my_role && (
                      <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ml-2 ${ROLE_COLOR[p.my_role] ?? ROLE_COLOR.member}`}>
                        {ROLE_LABEL[p.my_role] ?? p.my_role}
                      </span>
                    )}
                  </button>
                  {(p.my_role === 'owner' || isAdmin) && (
                    <button
                      onClick={(e) => handleDelete(p, e)}
                      disabled={deletingId === p.id}
                      className="px-2 py-2 text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors text-sm shrink-0 disabled:opacity-50"
                      title="删除工作组"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-gray-700">
            {creating ? (
              <form onSubmit={handleCreate} className="p-3 space-y-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="工作组名称"
                  className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="描述（可选）"
                  className="w-full px-2 py-1.5 text-sm bg-gray-700 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                />
                {error && <p className="text-xs text-red-400">{error}</p>}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={createLoading || !newName.trim()}
                    className="flex-1 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
                  >
                    {createLoading ? '创建中…' : '创建'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCreating(false); setError(''); }}
                    className="flex-1 py-1.5 text-sm bg-gray-600 hover:bg-gray-500 rounded text-white transition-colors"
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full px-3 py-2 text-sm text-left text-blue-400 hover:bg-white/10 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                新建工作组
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
