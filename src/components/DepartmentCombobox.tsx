import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listDepartments } from '../services/authService';

interface DepartmentComboboxProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** 输入框 className override（默认沿用 NoProjectGate 同款样式） */
  inputClassName?: string;
}

/**
 * 部门字段的「模糊查询 + 自动新建」组合框。
 *
 * 行为：
 *  - 输入时 300ms 防抖 GET /api/departments?q=...
 *  - 下拉列表显示候选项（最多 50）
 *  - 若 q 非空且候选中无完全相同项，末尾追加「+ 新建『xxx』」
 *  - 选择候选 / 「+ 新建」 / Enter 后把 value 同步到 onChange，并关闭下拉
 *  - 失焦延迟关闭（避免点击下拉项时直接 blur 关闭导致点不到）
 */
export default function DepartmentCombobox({
  value,
  onChange,
  disabled,
  placeholder = '搜索部门名 / 输入新部门后选「+ 新建」',
  autoFocus,
  inputClassName,
}: DepartmentComboboxProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Array<{ id: number; name: string }>>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const runQuery = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const out = await listDepartments(q);
      setItems(out);
      setFocusIdx(0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 输入变化 → 防抖查询
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runQuery(value);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, runQuery]);

  // 首次聚焦预拉
  function handleFocus() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    setOpen(true);
    if (items.length === 0) void runQuery(value);
  }

  function handleBlur() {
    // 延迟关闭，让点击下拉项的 onMouseDown 先生效
    blurTimerRef.current = setTimeout(() => setOpen(false), 150);
  }

  const trimmed = value.trim();
  const exactMatch = items.some((d) => d.name === trimmed);
  const showCreateRow = !!trimmed && !exactMatch;
  const flatList: Array<{ kind: 'pick'; name: string } | { kind: 'create'; name: string }> = useMemo(() => {
    const out: Array<{ kind: 'pick'; name: string } | { kind: 'create'; name: string }> = [];
    for (const it of items) out.push({ kind: 'pick', name: it.name });
    if (showCreateRow) out.push({ kind: 'create', name: trimmed });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, showCreateRow, trimmed]);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(flatList.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flatList[focusIdx];
      if (target) pick(target.name);
      else if (trimmed) pick(trimmed); // 没有候选时直接采用当前输入
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={inputClassName ?? 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm'}
      />
      {open && (loading || flatList.length > 0) && (
        <div className="absolute z-50 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-h-60 overflow-y-auto custom-scrollbar">
          {loading && (
            <div className="px-3 py-2 text-xs text-gray-500">加载中…</div>
          )}
          {!loading && flatList.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">无匹配，请输入新部门名后按 Enter 新建</div>
          )}
          {!loading && flatList.map((row, i) => (
            <button
              type="button"
              key={`${row.kind}:${row.name}`}
              onMouseDown={(e) => { e.preventDefault(); pick(row.name); }}
              onMouseEnter={() => setFocusIdx(i)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                i === focusIdx ? 'bg-blue-500/20 text-blue-200' : 'text-gray-300 hover:bg-gray-700'
              }`}
            >
              {row.kind === 'create' ? (
                <>
                  <span className="text-emerald-400">+</span>
                  <span>新建</span>
                  <span className="font-mono text-emerald-300">「{row.name}」</span>
                </>
              ) : (
                <span>{row.name}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
