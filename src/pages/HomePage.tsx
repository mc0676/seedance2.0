/**
 * HomePage - 首页（对标 story.neodomain.cn/home）
 */
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import AuthModal from '../components/AuthModal';
import { logout } from '../services/authService';

export default function HomePage() {
  const navigate = useNavigate();
  const { currentUser } = useApp();
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    if (menuOpen) document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <div className="relative h-screen flex flex-col overflow-hidden bg-[#050505] text-white font-sans selection:bg-purple-500/30">
      <div className="absolute inset-0 z-0 select-none pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-purple-900/30 via-black/20 to-[#050505]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(120,50,200,0.12),transparent_70%)]" />
      </div>

      {/* Top Nav */}
      <nav className="relative z-20 w-full px-6 md:px-10 py-4 flex items-center justify-between">
        <button onClick={() => navigate('/home')} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <img src="https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/LOGO/web_logo.png" alt="Logo" className="w-[54px] h-[54px] rounded-lg object-contain" />
          <span className="text-base font-semibold tracking-wide">云屿智创</span>
        </button>
        <div className="relative" ref={menuRef}>
          {currentUser ? (
            <>
              <button onClick={() => setMenuOpen(!menuOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/15 hover:border-white/30 transition-all duration-300 bg-white/5">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-xs font-bold">
                  {(currentUser.name || currentUser.email || '?')[0].toUpperCase()}
                </div>
                <span className="text-sm text-gray-300 max-w-[100px] truncate hidden sm:block">
                  {currentUser.name || currentUser.email?.split('@')[0]}
                </span>
                <svg className="w-3.5 h-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-[#1a1d2e] border border-gray-700/60 rounded-xl shadow-xl overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-gray-800/60">
                    <p className="text-sm font-medium text-white">{currentUser.name || '用户'}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{currentUser.email}</p>
                  </div>
                  <button onClick={() => { navigate('/'); setMenuOpen(false); }} className="w-full px-4 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 transition-colors">进入工作台</button>
                  <button onClick={async () => { await logout(); window.location.reload(); }} className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-gray-800/60 transition-colors">退出登录</button>
                </div>
              )}
            </>
          ) : (
            <button onClick={() => setLoginOpen(true)}
              className="relative px-5 py-2 rounded-full overflow-hidden group/btn border border-white/20 hover:border-white/40 transition-all duration-300">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500/0 via-purple-500/10 to-blue-500/0 opacity-0 group-hover/btn:opacity-100 transition-opacity duration-500" />
              <span className="relative text-sm font-medium">登录</span>
            </button>
          )}
        </div>
      </nav>

      {/* Hero */}
      <div className="relative z-10 flex-1 flex flex-col justify-center items-center px-6 text-center -mt-20">
        <h1 className="text-5xl sm:text-6xl md:text-8xl lg:text-9xl font-bold tracking-tight mb-8 leading-none drop-shadow-2xl">
          <span className="block bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-white/60">AI 创作，一步到位</span>
        </h1>
        <p className="text-base md:text-2xl font-light tracking-[0.15em] text-white/80 mb-14 drop-shadow-lg">
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-purple-200 via-white to-blue-200">双引擎视频生成 &middot; 智能画质增强 &middot; 全链路创作平台</span>
        </p>
        <div className="flex items-center gap-4">
          <button disabled className="group relative px-8 py-3 bg-white/5 backdrop-blur-sm text-white/40 border border-white/10 rounded-full font-bold text-lg md:text-xl cursor-not-allowed flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <span>了解平台</span>
          </button>
          <button onClick={() => currentUser ? navigate('/') : setLoginOpen(true)}
            className="group relative px-10 md:px-12 py-3 bg-white text-black rounded-full font-bold text-lg md:text-xl hover:scale-105 transition-all duration-300 shadow-[0_0_25px_rgba(255,255,255,0.3)] hover:shadow-[0_0_50px_rgba(255,255,255,0.6)] flex items-center gap-3">
            <span>立即创作</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:translate-x-1 transition-transform"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </button>
        </div>
      </div>

      {/* Right dots */}
      <div className="absolute right-6 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-2">
        {[...Array(9)].map((_, i) => (
          <button key={i} className={`w-3 h-3 rounded-full transition-all duration-300 hover:scale-125 ${
            i === 0 ? 'bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]' : 'bg-white/30 hover:bg-white/50'
          }`} />
        ))}
      </div>

      {/* Scroll */}
      <button className="absolute bottom-10 left-1/2 -translate-x-1/2 z-20 animate-bounce p-3 rounded-full border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-all backdrop-blur-sm">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      <AuthModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}
