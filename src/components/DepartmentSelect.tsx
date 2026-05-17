import { useEffect, useState } from 'react';
import { listDepartments } from '../services/authService';

interface DepartmentSelectProps {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  className?: string;
  /** 是否允许「未设置 / 留空」选项 */
  allowEmpty?: boolean;
  /** 触发外部重新拉取（如小组管理页 CRUD 后） */
  refreshKey?: number;
}

/**
 * 小组字段的严格下拉：只能从已有小组字典中选；不允许新建。
 *
 * 用户管理页使用此组件——新建小组必须走管理后台「小组管理」卡片，避免脏数据。
 * 与 DepartmentCombobox（首次填用、可新建）刻意分开，职责清晰。
 */
export default function DepartmentSelect({
  value, onChange, disabled, className, allowEmpty = true, refreshKey,
}: DepartmentSelectProps) {
  const [items, setItems] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listDepartments('')
      .then((rows) => { if (alive) setItems(rows); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refreshKey]);

  // 若当前 value 不在列表里（如小组被改名 / 删除），也展示一项标记
  const valueExists = !value || items.some((it) => it.name === value);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className ?? 'w-full px-3 py-2 bg-[#0f111a] border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-purple-500'}
    >
      {allowEmpty && <option value="">{loading ? '加载中…' : '— 未设置 —'}</option>}
      {!valueExists && value && (
        <option value={value} disabled>{value}（已失效，请重新选择）</option>
      )}
      {items.map((d) => (
        <option key={d.id} value={d.name}>{d.name}</option>
      ))}
    </select>
  );
}
