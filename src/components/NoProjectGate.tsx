import { useState } from 'react';
import { useApp } from '../context/AppContext';

export default function NoProjectGate() {
  const { createProjectAction, selectProject } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const project = await createProjectAction(name.trim());
      selectProject(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#0f111a]/95 backdrop-blur-sm">
      <div className="bg-[#1c1f2e] border border-gray-700 rounded-2xl shadow-2xl p-8 w-full max-w-md mx-4">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">暂无可用工作组</h2>
          <p className="text-gray-400 text-sm">
            您当前不在任何工作组中。<br />
            请联系管理员将您添加至工作组，或自行创建一个。
          </p>
        </div>

        {!showCreate ? (
          <div className="space-y-3">
            <button
              onClick={() => setShowCreate(true)}
              className="w-full py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
            >
              创建工作组
            </button>
            <p className="text-center text-xs text-gray-500">
              如需加入他人工作组，请联系管理员
            </p>
          </div>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1">工作组名称 <span className="text-red-400">*</span></label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：我的视频项目"
                className="w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 text-sm"
              />
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setShowCreate(false); setError(''); }}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-sm transition-colors"
              >
                返回
              </button>
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="flex-1 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-lg text-white font-medium transition-colors"
              >
                {loading ? '创建中…' : '确认创建'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
