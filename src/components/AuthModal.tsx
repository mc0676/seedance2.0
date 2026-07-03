import { useState } from 'react';
import { login, register, checkEmailStatus } from '../services/authService';
import type { User } from '../types';
import { MailIcon, LockIcon, EyeIcon, EyeOffIcon } from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  onLoginSuccess: (user: User) => void;
  defaultMode?: 'login' | 'register';
}

export default function AuthModal({ open, onClose, onLoginSuccess, defaultMode = 'login' }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>(defaultMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      if (mode === 'login') {
        const r = await login({ email, password });
        onLoginSuccess(r.user);
      } else {
        await register({ email, password });
        const r = await login({ email, password });
        onLoginSuccess(r.user);
      }
      onClose();
      window.location.href = '/';
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally { setLoading(false); }
  };

  const handleBlur = async () => {
    if (mode === 'login' && email) {
      try { const r = await checkEmailStatus(email); if (!r.isRegistered) setError('该邮箱未注册，请先注册账号'); } catch {}
    }
  };

  const switchMode = (m: 'login' | 'register') => { setMode(m); setError(''); };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-transparent backdrop-blur-[20px]" />
      <div className="relative w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="bg-[#1a1d2e]/95 border border-white/10 rounded-2xl p-8 shadow-2xl">
          {/* Title */}
          <div className="relative mb-6">
            <h2 className="text-xl font-semibold text-white text-center">
              {mode === 'login' ? '用户登录' : '注册账号'}
            </h2>
            <button onClick={onClose} className="absolute right-0 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          {error && <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">邮箱</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><MailIcon className="w-5 h-5 text-gray-500" /></div>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} onBlur={handleBlur}
                  className="w-full pl-12 pr-4 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent" placeholder="请输入邮箱" required />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">密码</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none"><LockIcon className="w-5 h-5 text-gray-500" /></div>
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full pl-12 pr-12 py-3 bg-[#0f111a] border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent" placeholder="请输入密码" required minLength={6} />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-500 hover:text-gray-300">
                  {showPw ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 px-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-medium rounded-xl shadow-lg shadow-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}
            </button>
          </form>

          {/* Mode switch */}
          <div className="mt-6 text-center">
            {mode === 'login' ? (
              <p className="text-gray-400 text-sm">还没有账号？{' '}
                <button onClick={() => switchMode('register')} className="text-purple-400 hover:text-purple-300 font-medium">立即注册</button>
              </p>
            ) : (
              <p className="text-gray-400 text-sm">已有账号？{' '}
                <button onClick={() => switchMode('login')} className="text-purple-400 hover:text-purple-300 font-medium">去登录</button>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
