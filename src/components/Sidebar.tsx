import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  FilmIcon,
  SettingsIcon,
  MenuIcon,
  CloseIcon,
  UserIcon,
  ShieldIcon,
  LogoutIcon,
  SparkleIcon,
  ChartIcon,
  ChatIcon,
  ImageIcon,
  MicIcon,
  PackageIcon,
  CanvasIcon,
} from '../components/Icons';
import type { User } from '../types';
import { logout } from '../services/authService';
import ProjectSelector from './ProjectSelector';
import ProfileEditCard from './ProfileEditCard';

interface SidebarProps {
  currentUser: User | null;
  onLogout: () => void;
  /** 用户在个人信息卡中修改 name 后回调父组件更新全局状态 */
  onUserUpdated?: (u: User) => void;
}

interface MenuItem {
  id: string;
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  accent?: string;
}

export default function Sidebar({ currentUser, onLogout, onUserUpdated }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const expanded = true;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  const menuItems: MenuItem[] = [
    {
      id: 'SINGLE_TASK',
      label: '视频生成',
      path: '/',
      icon: FilmIcon,
    },
    {
      id: 'HAPPYHORSE',
      label: 'HappyHorse',
      path: '/happyhorse',
      icon: FilmIcon,
    },
    {
      id: 'IMAGE_GEN',
      label: '图片生成',
      path: '/image-gen',
      icon: ImageIcon,
    },
    {
      id: 'AUDIO_GEN',
      label: '音频生成',
      path: '/audio-gen',
      icon: MicIcon,
    },
    {
      id: 'ENHANCEMENT',
      label: '画质增强',
      path: '/enhancement',
      icon: SparkleIcon,
    },
    {
      id: 'TEXT_GEN',
      label: '文本生成',
      path: '/text-gen',
      icon: ChatIcon,
    },
    {
      id: 'CANVAS',
      label: '无限画布',
      path: '/cloth',
      icon: CanvasIcon,
    },
    {
      id: 'CONSUMPTION_ANALYSIS',
      label: '消耗分析',
      path: '/consumption-analysis',
      icon: ChartIcon,
    },
    {
      id: 'ASSETS',
      label: '项目组与资产',
      path: '/assets',
      icon: PackageIcon,
    },
    {
      id: 'SETTINGS',
      label: '设置',
      path: '/settings',
      icon: SettingsIcon,
    },
    {
      id: 'ADMIN',
      label: '管理后台',
      path: '/admin',
      icon: ShieldIcon,
      adminOnly: true,
      accent: 'text-amber-500',
    },
  ];

  const handleLogout = async () => {
    await logout();
    onLogout();
    navigate('/login');
  };

  const visibleItems = menuItems.filter(
    (item) => !item.adminOnly || currentUser?.role === 'admin' || currentUser?.role === 'super_admin'
  );

  return (
    <>
      {/* 移动端遮罩 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 侧边栏 */}
      <aside
        className={`fixed top-0 left-0 z-50 h-screen bg-[#1c1f2e] border-r border-gray-800 transition-all duration-300 ${
          expanded ? 'w-80' : 'w-16'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
        {/* Logo 区域 */}
        <div className="h-28 flex items-center justify-between px-4 border-b border-gray-800">
          <div className={`flex items-center gap-3 ${!expanded && 'justify-center'}`}>
            <img src="https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/LOGO/web_logo.png" alt="云屿智创" className="w-24 h-24 rounded-xl flex-shrink-0 object-contain" />
            {expanded && (
              <span className="text-3xl font-bold text-white whitespace-nowrap">
                云屿智创
              </span>
            )}
          </div>
          {expanded && (
            <button
              onClick={() => setMobileOpen(false)}
              className="lg:hidden text-gray-400 hover:text-white"
            >
              <CloseIcon className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 工作组选择器 */}
        {expanded && (
          <div className="border-b border-gray-800">
            <ProjectSelector />
          </div>
        )}

        {/* 菜单项 */}
        <nav className="p-3 space-y-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.path);

            return (
              <Link
                key={item.id}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                  active
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                } ${!expanded && 'justify-center'}`}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${item.accent || ''}`} />
                {expanded && (
                  <span className={`text-sm font-medium ${item.accent || ''}`}>
                    {item.label}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* 底部用户信息 */}
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-gray-800">
          {profileOpen && currentUser && (
            <ProfileEditCard
              user={currentUser}
              onClose={() => setProfileOpen(false)}
              onSaved={(u) => { onUserUpdated?.(u); }}
              onLogout={async () => { await logout(); onLogout(); navigate('/login'); }}
            />
          )}
          {expanded ? (
            <button
              onClick={() => setProfileOpen((v) => !v)}
              className="w-full flex items-center justify-between rounded-lg hover:bg-gray-800/60 px-1 py-1 transition-colors"
              title="个人信息"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
                  <UserIcon className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0 text-left">
                  <p className="text-sm font-medium text-white truncate">
                    {currentUser?.name
                      ? <>{currentUser.name} <span className="text-xs font-normal text-gray-500">{currentUser.email}</span></>
                      : (currentUser?.email || '用户')}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {currentUser?.department || (currentUser?.role === 'super_admin' ? '系统管理员' : currentUser?.role === 'admin' ? '管理员' : '普通用户')}
                  </p>
                </div>
              </div>
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <button
                onClick={() => setProfileOpen((v) => !v)}
                className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center"
                title="个人信息"
              >
                <UserIcon className="w-5 h-5 text-white" />
              </button>
              <button
                onClick={handleLogout}
                className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                title="退出登录"
              >
                <LogoutIcon className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* 顶部导航栏（移动端） */}
      <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-[#1c1f2e] border-b border-gray-800 z-30 flex items-center justify-between px-4">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 text-gray-400 hover:text-white"
        >
          <MenuIcon className="w-6 h-6" />
        </button>
        <div className="flex items-center gap-2">
          <img src="https://yunyu-oss.oss-cn-shanghai.aliyuncs.com/LOGO/web_logo.png" alt="云屿智创" className="w-24 h-24 rounded-xl object-contain" />
          <span className="text-3xl font-bold text-white">云屿智创</span>
        </div>
        <div className="w-10" /> {/* 占位 */}
      </header>

    </>
  );
}