import { useState, useEffect, Fragment } from 'react';
import { getAuthHeaders } from '../services/authService';
import type { ModelPricing } from '../types';

interface DiscountEntry {
  id?: number;
  model: string;
  sub_key: string;
  type: 'percent' | 'number';
  value: number;
  start_date: string;
  end_date: string;
}

interface RowData {
  model: string;
  subKey: string;
  label: string;
  originalPrice: number;
  groupKey: string;
  groupLabel: string;
}

interface Props {
  scope: 'model' | 'happyhorse';
  modelPricings?: ModelPricing[];
  happyhorsePricing?: Array<{ mode: string; model: string; resolution: string; credits_per_second: number }>;
  onClose: (saved: boolean) => void;
}

const MODEL_FIELD_LABELS: Record<string, string> = {
  price_no_video_low: '无视频/720p',
  price_no_video_high: '无视频/1080p',
  price_with_video_low: '含视频/720p',
  price_with_video_high: '含视频/1080p',
  price_audio: '有声',
  price_silent: '无声',
};

const MODEL_FIELDS = Object.keys(MODEL_FIELD_LABELS);

const COL_DISC = 96;
const COL_DATE = 168;
const COL_SEP = 20;
const COL_DEL = 20;

export default function DiscountModal({ scope, modelPricings, happyhorsePricing, onClose }: Props) {
  const [entries, setEntries] = useState<DiscountEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uniformDiscount, setUniformDiscount] = useState(true);
  const [uniformDate, setUniformDate] = useState(true);

  useEffect(() => { loadDiscounts(); }, []);

  const loadDiscounts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/discounts', { headers: getAuthHeaders() });
      const j = await res.json();
      if (j?.success) {
        setEntries(j.data.discounts || []);
      }
    } catch {} finally { setLoading(false); }
  };

  const rowKey = (model: string, subKey: string) => `${model}\0${subKey}`;

  // 构建 uniform 聚合行。model/subKey 带 '*' 仅用于 UI key，不会存入 DB。
  const buildUniformRows = (): RowData[] => {
    if (scope === 'model' && modelPricings) {
      return modelPricings.map((m) => ({ model: m.model_key, subKey: '*', label: `${m.label || m.model_key}（所有字段）`, originalPrice: 0, groupKey: m.model_key, groupLabel: m.label || m.model_key }));
    }
    if (scope === 'happyhorse') {
      return [
        { model: '*', subKey: '720P', label: '所有模型 · 720P', originalPrice: 0, groupKey: '720P', groupLabel: '720P' },
        { model: '*', subKey: '1080P', label: '所有模型 · 1080P', originalPrice: 0, groupKey: '1080P', groupLabel: '1080P' },
      ];
    }
    return [];
  };

  const visibleRows = buildUniformRows();

  const findEntry = (model: string, subKey: string): DiscountEntry | undefined =>
    entries.find((e) => e.model === model && e.sub_key === subKey);

  const clearAll = async () => {
    const scopeLabel = scope === 'model' ? '模型计费' : 'HappyHorse';
    if (!window.confirm(`确认清空${scopeLabel}的全部折扣内容？此操作不可撤销。`)) return;
    setSaving(true);
    try {
      // 计算当前 scope 下所有具体条目的 key
      const targets = visibleRows.flatMap(r => expandUniformRow(r));
      const targetKeys = new Set(targets.map(t => `${t.model}\0${t.subKey}`));
      // 保留不属于当前 scope 的条目
      const keep = entries.filter(e => !targetKeys.has(`${e.model}\0${e.sub_key}`));
      const res = await fetch('/api/admin/discounts', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ discounts: keep }),
      });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '清空失败');
      onClose(true);
    } catch (e: any) {
      alert(e.message || '清空失败');
      setSaving(false);
    }
  };

  const removeEntry = (model: string, subKey: string) => {
    setEntries((prev) => prev.filter((e) => !(e.model === model && e.sub_key === subKey)));
  };

  // 把一组 patch 应用到一组 uniform 行展开后的所有具体条目上（单次 setEntries）
  const applyToUniformRows = (rows: RowData[], patch: Partial<DiscountEntry>) => {
    setEntries((prev) => {
      let next = [...prev];
      for (const r of rows) {
        const targets = expandUniformRow(r);
        for (const t of targets) {
          const idx = next.findIndex((e) => e.model === t.model && e.sub_key === t.subKey);
          if (idx >= 0) next[idx] = { ...next[idx], ...patch };
          else next.push({ model: t.model, sub_key: t.subKey, type: 'percent', value: 0, start_date: '', end_date: '', ...patch });
        }
      }
      return next;
    });
  };

  const applyToUniformRow = (r: RowData, patch: Partial<DiscountEntry>) => {
    applyToUniformRows([r], patch);
  };

  // 把 uniform 聚合行展开为具体行列表
  const expandUniformRow = (r: RowData): Array<{ model: string; subKey: string }> => {
    if (scope === 'model' && modelPricings) {
      const m = modelPricings.find((mp) => mp.model_key === r.model);
      if (!m) return [];
      const out: Array<{ model: string; subKey: string }> = [];
      for (const f of MODEL_FIELDS) {
        if ((m as any)[f] > 0) out.push({ model: r.model, subKey: f });
      }
      return out;
    }
    if (scope === 'happyhorse' && happyhorsePricing) {
      return happyhorsePricing
        .filter((p) => p.resolution === r.subKey)
        .map((p) => ({ model: p.mode, subKey: p.resolution }));
    }
    return [];
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const clean = entries.filter((e) => e.sub_key !== '*');
      const res = await fetch('/api/admin/discounts', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ discounts: clean }),
      });
      const j = await res.json();
      if (!j?.success) throw new Error(j?.error || '保存失败');
      onClose(true);
    } catch (e: any) {
      alert(e.message || '保存失败');
      setSaving(false);
    }
  };

  const getUniformDiscount = (r: RowData): { value: number } | undefined => {
    const targets = expandUniformRow(r);
    if (targets.length === 0) return undefined;
    const matched = targets.map((t) => findEntry(t.model, t.subKey)).filter(Boolean) as DiscountEntry[];
    if (matched.length !== targets.length) return undefined;
    const allSameVal = matched.every((e) => e.value === matched[0].value);
    if (allSameVal) return { value: matched[0].value };
    return undefined;
  };

  const getUniformDates = (r: RowData): { start_date: string; end_date: string } | undefined => {
    const targets = expandUniformRow(r);
    if (targets.length === 0) return undefined;
    const matched = targets.map((t) => findEntry(t.model, t.subKey)).filter(Boolean) as DiscountEntry[];
    if (matched.length !== targets.length) return undefined;
    const allSameStart = matched.every((e) => e.start_date === matched[0].start_date);
    const allSameEnd = matched.every((e) => e.end_date === matched[0].end_date);
    if (!allSameStart && !allSameEnd) return undefined;
    return {
      start_date: allSameStart ? matched[0].start_date : '',
      end_date: allSameEnd ? matched[0].end_date : '',
    };
  };

  // ── 渲染 ──
  const renderRow = (r: RowData) => {
    const rk = rowKey(r.model, r.subKey);

    let entryVal = 0;
    let start = '';
    let end = '';

    const ud = getUniformDiscount(r);
    const uds = getUniformDates(r);
    if (ud) entryVal = ud.value;
    if (uds) { start = uds.start_date; end = uds.end_date; }

    const hasDiscount = entryVal > 0;

    let displayValue = '';
    if (entryVal > 0) displayValue = String(entryVal);

    const handleDiscountChange = (rawVal: string) => {
      if (rawVal === '') {
        if (uniformDiscount) applyToUniformRows(visibleRows, { value: 0 });
        else applyToUniformRow(r, { value: 0 });
        return;
      }
      const v = parseFloat(rawVal);
      if (isNaN(v)) return;
      if (v < 0 || v > 100) return;
      if (uniformDiscount) applyToUniformRows(visibleRows, { value: v, type: 'percent' });
      else applyToUniformRow(r, { value: v, type: 'percent' });
    };

    const handleDateChange = (field: 'start_date' | 'end_date', value: string) => {
      if (uniformDate) applyToUniformRows(visibleRows, { [field]: value });
      else applyToUniformRow(r, { [field]: value });
    };

    return (
      <div key={rk} className="flex items-center bg-[#0f111a] rounded-xl px-4 py-3 border border-gray-800" style={{ gap: '12px' }}>
        <div className="flex-1 text-sm text-white min-w-0">
          <span className="truncate block">{r.label}</span>
        </div>

        <div style={{ width: COL_DISC, flexShrink: 0 }} className={`flex items-center rounded border ${
          hasDiscount ? 'border-purple-500/40 focus-within:border-purple-500 bg-purple-500/10' : 'border-gray-700 focus-within:border-purple-500 bg-[#1c1f2e]'
        }`}>
          <span className={`pl-2 py-1.5 text-sm flex-shrink-0 select-none ${hasDiscount ? 'text-purple-400' : 'text-gray-500'}`}>-</span>
          <input
            type="text"
            inputMode="decimal"
            value={displayValue}
            onChange={(e) => handleDiscountChange(e.target.value)}
            placeholder="折扣"
            className={`w-full min-w-0 bg-transparent py-1.5 text-sm text-right focus:outline-none ${hasDiscount ? 'text-purple-300' : 'text-gray-400'}`}
          />
          <span className={`pr-2 py-1.5 text-sm flex-shrink-0 select-none ${hasDiscount ? 'text-purple-400' : 'text-gray-500'}`}>%</span>
        </div>

        <input
          type="datetime-local" value={start}
          onChange={(e) => handleDateChange('start_date', e.target.value)}
          style={{ width: COL_DATE, flexShrink: 0 }}
          className={`px-2 py-1.5 rounded text-xs focus:outline-none focus:border-purple-500 ${start ? 'bg-purple-500/10 border border-purple-500/40 text-purple-300' : 'bg-[#1c1f2e] border border-gray-700 text-gray-400'}`}
        />
        <span className="text-gray-500 text-xs flex-shrink-0 text-center" style={{ width: COL_SEP }}>至</span>
        <input
          type="datetime-local" value={end}
          onChange={(e) => handleDateChange('end_date', e.target.value)}
          style={{ width: COL_DATE, flexShrink: 0 }}
          className={`px-2 py-1.5 rounded text-xs focus:outline-none focus:border-purple-500 ${end ? 'bg-purple-500/10 border border-purple-500/40 text-purple-300' : 'bg-[#1c1f2e] border border-gray-700 text-gray-400'}`}
        />

        <div style={{ width: COL_DEL, flexShrink: 0 }} className="flex justify-center">
          <button
            onClick={() => {
              const targets = expandUniformRow(r);
              for (const t of targets) removeEntry(t.model, t.subKey);
            }}
            disabled={!hasDiscount && !start && !end}
            className={`text-sm transition-colors ${(hasDiscount || start || end) ? 'text-gray-500 hover:text-red-400 cursor-pointer' : 'text-gray-700 cursor-not-allowed'}`}
          >×</button>
        </div>
      </div>
    );
  };

  const dateHeaderWidth = COL_DATE + 12 + COL_SEP + 12 + COL_DATE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => onClose(false)}>
      <div
        className="bg-[#1c1f2e] border border-gray-700 rounded-2xl shadow-2xl"
        style={{ width: 'min(90vw, 1100px)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-0 flex-shrink-0">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-semibold text-white">折扣设置 — {scope === 'model' ? '模型计费' : 'HappyHorse'}</h3>
            <button onClick={() => onClose(false)} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
          </div>
        </div>

        {loading ? (
          <div className="text-center text-gray-400 py-8 flex-1">加载中...</div>
        ) : (
          <>
            <div className="flex items-center text-xs text-gray-500 px-6 mb-1 flex-shrink-0" style={{ gap: '12px' }}>
              <span className="flex-1">项目</span>
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: COL_DISC, justifyContent: 'flex-end' }}>
                <span>折扣</span>
                <label className="flex items-center gap-0.5 cursor-pointer text-[10px] text-gray-500 hover:text-gray-300">
                  <input type="checkbox" checked={uniformDiscount} onChange={(e) => setUniformDiscount(e.target.checked)} className="w-3 h-3 accent-purple-500" />
                  统一
                </label>
              </span>
              <span className="flex items-center gap-1 flex-shrink-0" style={{ width: dateHeaderWidth }}>
                <span>起止时间</span>
                <label className="flex items-center gap-0.5 cursor-pointer text-[10px] text-gray-500 hover:text-gray-300">
                  <input type="checkbox" checked={uniformDate} onChange={(e) => setUniformDate(e.target.checked)} className="w-3 h-3 accent-purple-500" />
                  统一
                </label>
              </span>
              <div style={{ width: COL_DEL, flexShrink: 0 }} />
            </div>

            <div className="space-y-2 px-6 pb-6 overflow-y-auto flex-1">
              {(() => {
                let lastKey = '';
                return visibleRows.map((r, i) => {
                  const sep = r.groupKey !== lastKey;
                  lastKey = r.groupKey;
                  return (
                    <Fragment key={rowKey(r.model, r.subKey)}>
                      {sep && (
                        <div className={`flex items-center gap-3 ${i > 0 ? 'pt-4' : ''} pb-1`}>
                          <div className="flex-1 h-px bg-gray-700" />
                          <span className="text-xs text-gray-500 font-medium flex-shrink-0">{r.groupLabel}</span>
                          <div className="flex-1 h-px bg-gray-700" />
                        </div>
                      )}
                      {renderRow(r)}
                    </Fragment>
                  );
                });
              })()}
            </div>
          </>
        )}

        <div className="flex gap-2 justify-between px-6 pb-6 flex-shrink-0">
          <button
            onClick={clearAll}
            disabled={entries.length === 0}
            className="px-4 py-2 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed rounded-xl text-red-400 text-sm transition-all"
          >
            全部清除
          </button>
          <div className="flex gap-2">
            <button onClick={() => onClose(false)} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-xl text-white text-sm">取消</button>
            <button onClick={handleSave} disabled={saving} className="btn-save">{saving ? '保存中...' : '保存'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
