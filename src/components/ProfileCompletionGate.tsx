import { useState } from 'react';
import { updateMyProfile } from '../services/authService';
import DepartmentCombobox from './DepartmentCombobox';
import type { User } from '../types';

interface ProfileCompletionGateProps {
  /** 当前已知用户对象，用于 prefill name / 显示 email */
  user: User;
  /** 提交成功后回调，把刷新过的 user 同步到上层 state */
  onSaved: (user: User) => void;
}

/**
 * 强制补填姓名 + 部门的 Gate。
 *
 * 触发条件由 MainLayout 控制（`!user.name || !user.department`）。
 * 唯一关闭路径：成功提交 PUT /api/auth/me 并回调 onSaved。
 * 风格与 NoProjectGate 一致：fixed inset-0 蒙层 + 卡片表单。
 */
export default function ProfileCompletionGate({ user, onSaved }: ProfileCompletionGateProps) {
  const [name, setName] = useState((user.name || '').trim());
  const [department, setDepartment] = useState((user.department || '').trim());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const trimmedName = name.trim();
  const trimmedDept = department.trim();
  const nameValid = trimmedName.length >= 2 && trimmedName.length <= 20;
  const deptValid = !!trimmedDept && trimmedDept.length <= 60;
  const canSubmit = nameValid && deptValid && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    try {
      const fresh = await updateMyProfile({ name: trimmedName, department: trimmedDept });
      onSaved(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[45] flex items-center justify-center bg-gray-900/95 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl p-8 w-full max-w-md mx-4">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">完善个人信息</h2>
          <p className="text-gray-400 text-sm">
            首次使用本平台需补充姓名与小组，便于团队协作。<br />
            邮箱：<span className="text-gray-300">{user.email}</span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-300 mb-1">姓名 <span className="text-red-400">*</span></label>
            <input
              autoFocus
              value={name}
              maxLength={20}
              onChange={(e) => setName(e.target.value)}
              placeholder="2~20 个字符"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">小组 <span className="text-red-400">*</span></label>
            <DepartmentCombobox
              value={department}
              onChange={setDepartment}
              placeholder="搜索已有小组，或输入新小组按 Enter 创建"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              提交后该小组将加入字典库供其他同事选用。<br />
              <span className="text-amber-400/80">注意：小组一经提交，后续修改需联系管理员。</span>
            </p>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium transition-colors"
          >
            {loading ? '提交中…' : '提交并进入'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-500 mt-4">
          如遇问题请联系平台管理员协助补填
        </p>
      </div>
    </div>
  );
}
