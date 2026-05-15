import { useEffect, useRef, useState } from 'react';
import type { User } from '../types';
import { updateMyProfile, changePassword } from '../services/authService';
import { CloseIcon, UserIcon } from './Icons';

interface ProfileEditCardProps {
  user: User;
  onClose: () => void;
  onSaved: (user: User) => void;
  /** 「退出登录」按钮回调 */
  onLogout: () => void;
}

/**
 * 点击侧栏底部头像后弹出的「个人信息」浮层。
 *
 *  - 显示邮箱（只读）
 *  - 显示部门（只读，灰色 + 一行小字「部门修改请联系管理员」）
 *  - 姓名可编辑（2~20 字符）→ 保存 → 调 PUT /api/auth/me
 *  - 修改密码：行内展开两个输入框，调既有的 changePassword（成功后会自动清 session 触发重登）
 *  - 退出登录：复用 onLogout 回调（与原 sidebar 行为对齐）
 */
export default function ProfileEditCard({ user, onClose, onSaved, onLogout }: ProfileEditCardProps) {
  const [name, setName] = useState((user.name || '').trim());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [pwMode, setPwMode] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwError, setPwError] = useState('');

  const cardRef = useRef<HTMLDivElement | null>(null);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 2 && trimmedName.length <= 20;
  const nameDirty = trimmedName !== (user.name || '').trim();
  const canSaveName = nameValid && nameDirty && !saving;

  async function handleSaveName() {
    if (!canSaveName) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const fresh = await updateMyProfile({ name: trimmedName });
      onSaved(fresh);
      setSuccess('姓名已更新');
      setTimeout(() => setSuccess(''), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    setPwError('');
    if (!oldPw || !newPw) { setPwError('两个密码都要填'); return; }
    if (newPw.length < 6) { setPwError('新密码至少 6 位'); return; }
    try {
      await changePassword(oldPw, newPw);
      // changePassword 内部已清 sessionId；重新登录提示
      window.location.href = '/login';
    } catch (e) {
      setPwError(e instanceof Error ? e.message : '修改失败');
    }
  }

  const roleLabel = user.role === 'super_admin' ? '系统管理员' : user.role === 'admin' ? '管理员' : '普通用户';

  return (
    <div
      ref={cardRef}
      className="absolute bottom-16 left-3 right-3 lg:left-3 lg:right-3 z-50 bg-[#1c1f2e] border border-gray-700 rounded-2xl shadow-2xl p-4 max-w-[300px]"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">个人信息</h3>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded hover:bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white"
        ><CloseIcon className="w-4 h-4" /></button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
          <UserIcon className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-sm text-white truncate">{user.email}</div>
          <div className="text-[10px] text-gray-500">{roleLabel}</div>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[11px] text-gray-400 mb-1">姓名</label>
          <div className="flex gap-2">
            <input
              value={name}
              maxLength={20}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSaveName}
              disabled={!canSaveName}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-xs text-white"
            >{saving ? '保存中' : '保存'}</button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-gray-400 mb-1">部门</label>
          <div className="px-2.5 py-1.5 bg-gray-900/60 border border-gray-800 rounded text-sm text-gray-400">
            {user.department || <span className="text-gray-600">未设置</span>}
          </div>
          <p className="text-[10px] text-amber-400/80 mt-1">部门修改请联系管理员</p>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {success && <p className="text-xs text-emerald-400">{success}</p>}

        {/* 修改密码（折叠） */}
        <div className="pt-2 border-t border-gray-800">
          {!pwMode ? (
            <button
              onClick={() => setPwMode(true)}
              className="w-full text-left text-xs text-gray-400 hover:text-white py-1"
            >修改密码 →</button>
          ) : (
            <div className="space-y-2">
              <input
                type="password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                placeholder="原密码"
                className="w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
              />
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="新密码（≥6 位）"
                className="w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
              />
              {pwError && <p className="text-xs text-red-400">{pwError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={handleChangePassword}
                  className="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white"
                >确认</button>
                <button
                  onClick={() => { setPwMode(false); setOldPw(''); setNewPw(''); setPwError(''); }}
                  className="flex-1 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-200"
                >取消</button>
              </div>
            </div>
          )}
        </div>

        {/* 退出登录 */}
        <div className="pt-2 border-t border-gray-800">
          <button
            onClick={onLogout}
            className="w-full text-left text-xs text-red-400 hover:text-red-300 py-1"
          >退出登录 →</button>
        </div>
      </div>
    </div>
  );
}
