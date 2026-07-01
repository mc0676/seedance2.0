import { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { useApp } from './context/AppContext';
import Sidebar from './components/Sidebar';
import ProfileCompletionGate from './components/ProfileCompletionGate';
import NoProjectGate from './components/NoProjectGate';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';
import SingleTaskPage from './pages/SingleTaskPage';
import ImageGenPage from './pages/ImageGenPage';
import AudioGenPage from './pages/AudioGenPage';
import EnhancementPage from './pages/EnhancementPage';
import ConsumptionAnalysisPage from './pages/ConsumptionAnalysisPage';
import HappyHorsePage from './pages/HappyHorsePage';
import SettingsPage from './pages/Settings';
import TextGenPage from './pages/TextGenPage';
import CanvasEditorPage from './pages/cloth/CanvasEditorPage';
import CanvasPage from './pages/cloth/CanvasPage';
import ProjectWorkspacePage from './pages/ProjectWorkspacePage';
import type { User } from './types';
import { getCurrentUser } from './services/authService';

// 维护模式全屏公告
function MaintenanceOverlay({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-[9999] bg-[#0f111a] flex items-center justify-center">
      <div className="text-center max-w-md px-8">
        <div className="mb-6 text-yellow-400">
          <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-white mb-3">系统维护中</h1>
        <p className="text-gray-300 leading-relaxed mb-8">{message}</p>
        <p className="text-xs text-gray-500">维护完成后页面将自动恢复，请耐心等待...</p>
      </div>
    </div>
  );
}

// 受保护的路由组件
function ProtectedRoute({
  children,
  requireAdmin = false,
  currentUser,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
  currentUser: User | null;
}) {
  if (!currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (requireAdmin && currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

// 无工作组时全屏拦截
function NoProjectGateWrapper({ children }: { children: React.ReactNode }) {
  const { state } = useApp();

  // 加载中不拦截，等数据到了再判断
  if (state.loading || state.projects.length > 0) {
    return <>{children}</>;
  }

  return <NoProjectGate />;
}

// 主布局组件（带侧边栏）
function MainLayout({
  currentUser,
  onLogout,
  onUserUpdated,
  children,
}: {
  currentUser: User | null;
  onLogout: () => void;
  onUserUpdated: (u: User) => void;
  children: React.ReactNode;
}) {
  const needsProfile = !!currentUser
    && !currentUser.name?.trim();

  return (
    <div className="min-h-screen bg-[#0f111a]">
      <Sidebar currentUser={currentUser} onLogout={onLogout} onUserUpdated={onUserUpdated} />
      <main className="lg:pl-80 pt-16 lg:pt-0 min-h-screen">
        <NoProjectGateWrapper>
          {children}
        </NoProjectGateWrapper>
      </main>
      {/* 未填资料时显示补填弹窗 */}
      {needsProfile && currentUser && (
        <ProfileCompletionGate user={currentUser} onSaved={onUserUpdated} />
      )}
    </div>
  );
}

function AppContent() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [maintenance, setMaintenance] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('系统维护中，请稍后再试。');
  const prevMaintenance = useRef(false);

  const handleAuthSuccess = (user: User) => {
    setCurrentUser(user);
  };

  // 维护状态轮询
  const checkMaintenance = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      const inMaintenance: boolean = data.maintenance === true;
      setMaintenance(inMaintenance);
      if (data.message) setMaintenanceMessage(data.message);
      // 维护结束后自动刷新页面
      if (prevMaintenance.current && !inMaintenance) {
        window.location.reload();
      }
      prevMaintenance.current = inMaintenance;
    } catch {
      // 网络错误不改变状态
    }
  }, []);

  useEffect(() => {
    checkMaintenance();
    const timer = setInterval(checkMaintenance, 5000);
    return () => clearInterval(timer);
  }, [checkMaintenance]);

  // 加载当前用户
  useEffect(() => {
    const loadUser = async () => {
      try {
        const user = await getCurrentUser();
        setCurrentUser(user);
      } catch (error) {
        console.error('加载用户信息失败:', error);
      } finally {
        setLoading(false);
      }
    };
    loadUser();
  }, []);

  const handleLogout = () => {
    setCurrentUser(null);
  };

  // 加载过程中显示加载状态
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f111a] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin text-purple-500 mb-4">
            <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-gray-400">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <AppProvider currentUser={currentUser}>
      {maintenance && <MaintenanceOverlay message={maintenanceMessage} />}
      <Routes>
        {/* 公开路由 */}
        <Route
          path="/login"
          element={
            currentUser ? (
              <Navigate to="/" replace />
            ) : (
              <LoginPage onLoginSuccess={handleAuthSuccess} />
            )
          }
        />
        <Route
          path="/register"
          element={
            currentUser ? (
              <Navigate to="/" replace />
            ) : (
              <RegisterPage onRegisterSuccess={handleAuthSuccess} />
            )
          }
        />

        {/* 受保护的路由 */}
        <Route
          path="/"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <SingleTaskPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <SettingsPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/text-gen"
          element={<ProtectedRoute currentUser={currentUser}>
            <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
              <TextGenPage /></MainLayout></ProtectedRoute>}
        />
        <Route
          path="/cloth"
          element={<ProtectedRoute currentUser={currentUser}>
            <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
              <CanvasPage /></MainLayout></ProtectedRoute>}
        />
        <Route
          path="/cloth/:id"
          element={<ProtectedRoute currentUser={currentUser}>
            <CanvasEditorPage /></ProtectedRoute>}
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute requireAdmin currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <AdminPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/consumption-analysis"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <ConsumptionAnalysisPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/image-gen"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <ImageGenPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/audio-gen"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <AudioGenPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/enhancement"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <EnhancementPage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/happyhorse"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <HappyHorsePage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/assets"
          element={
            <ProtectedRoute currentUser={currentUser}>
              <MainLayout currentUser={currentUser} onLogout={handleLogout} onUserUpdated={setCurrentUser}>
                <ProjectWorkspacePage />
              </MainLayout>
            </ProtectedRoute>
          }
        />

        {/* 404 重定向 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}