// 画布设置面板 — 拖拽排序 + 默认标签 + 管理员同步
import { useState, useEffect, useCallback } from 'react';
import { X, GripVertical, Settings2 } from 'lucide-react';
import { getAuthHeaders } from '../../services/authService';

interface CanvasSettings {
  image_models: string[];
  image_default: string;
  video_models: string[];
  video_default: string;
  theme: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  theme?: { bg: string; panel: string; panelBorder: string; nodeText: string; nodeMuted: string; nodeFaint: string; blue: string };
}

const IMAGE_MODEL_LABELS: Record<string, string> = {
  'nano-banana-2': 'Nano Banana 2',
  'gpt-image-2': 'GPT-Image-2',
};
const VIDEO_MODEL_LABELS: Record<string, string> = {
  'seedance-2.0': 'Seedance 2.0',
  'seedance-2.0-fast': 'Seedance 2.0 Fast',
  'happyhorse-1.0-t2v': 'HappyHorse 1.0 T2V',
};
const ALL_IMAGE_MODELS = Object.keys(IMAGE_MODEL_LABELS);
const ALL_VIDEO_MODELS = Object.keys(VIDEO_MODEL_LABELS);
const LS_KEY = 'seedance_canvas_settings';

function loadLocal(): CanvasSettings | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveLocal(s: CanvasSettings) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

const DEFAULT_SETTINGS: CanvasSettings = {
  image_models: [...ALL_IMAGE_MODELS],
  image_default: ALL_IMAGE_MODELS[0],
  video_models: [...ALL_VIDEO_MODELS],
  video_default: ALL_VIDEO_MODELS[0],
  theme: 'dark',
};

export function CanvasSettingsModal({ open, onClose, theme }: Props) {
  const t = theme || { bg: '#181715', panel: 'rgba(31,29,26,.96)', panelBorder: '#44403c', nodeText: '#f5f5f4', nodeMuted: '#d6d3d1', nodeFaint: '#78716c', blue: '#2f80ff' };
  const [isAdmin, setIsAdmin] = useState(false);

  const [settings, setSettings] = useState<CanvasSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 拖拽状态
  const [dragKey, setDragKey] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      // 1. 浏览器本地配置优先
      let local = loadLocal();
      // 确保必要字段存在（防止 localStorage 中存储不完整对象导致渲染崩溃）
      if (local) {
        if (!Array.isArray(local.image_models)) local.image_models = [...ALL_IMAGE_MODELS];
        if (!local.image_default || !ALL_IMAGE_MODELS.includes(local.image_default)) local.image_default = ALL_IMAGE_MODELS[0];
        if (!Array.isArray(local.video_models)) local.video_models = [...ALL_VIDEO_MODELS];
        if (!local.video_default || !ALL_VIDEO_MODELS.includes(local.video_default)) local.video_default = ALL_VIDEO_MODELS[0];
        if (!local.theme) local.theme = 'dark';
      }
      if (!local) {
        // 首次：从服务器拉取作为初始值
        const sRes = await fetch('/api/cloths/settings', { headers: getAuthHeaders() });
        const sData = await sRes.json();
        if (sData.success) {
          local = sData.data as CanvasSettings;
          // 补齐系统已知的所有模型
          for (const m of ALL_IMAGE_MODELS) { if (!local.image_models.includes(m)) local.image_models.push(m); }
          for (const m of ALL_VIDEO_MODELS) { if (!local.video_models.includes(m)) local.video_models.push(m); }
        } else {
          local = { ...DEFAULT_SETTINGS };
        }
        saveLocal(local);
      }

      // 2. 仅拉取服务器配置做 image_models / video_models 差异对比
      try {
        const sRes = await fetch('/api/cloths/settings', { headers: getAuthHeaders() });
        const sData = await sRes.json();
        if (sData.success) {
          const server = sData.data as CanvasSettings;
          // 服务器有而本地没有的模型 → 追加到末尾
          for (const m of server.image_models || []) {
            if (!local.image_models.includes(m)) local.image_models.push(m);
          }
          for (const m of server.video_models || []) {
            if (!local.video_models.includes(m)) local.video_models.push(m);
          }
          saveLocal(local);
        }
      } catch {}

      // 3. 拉取用户身份
      try {
        const uRes = await fetch('/api/auth/me', { headers: getAuthHeaders() });
        const uData = await uRes.json();
        if (uData.success) {
          setIsAdmin(uData.data?.user?.role === 'super_admin');
        }
      } catch {}

      setSettings(local);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { if (open) { fetchSettings(); setSaved(false); } }, [open, fetchSettings]);

  // 仅更新本地状态，不持久化
  const update = (s: CanvasSettings) => {
    setSettings(s);
  };

  const saveToServer = async (s: CanvasSettings) => {
    setSaving(true);
    try {
      await fetch('/api/cloths/settings', {
        method: 'PUT',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(s),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  const handleSave = () => {
    if (!settings) return;
    saveLocal(settings);
    if (isAdmin) saveToServer(settings);
    onClose();
  };

  // ── 拖拽排序 ──
  const onDragStart = (key: string) => setDragKey(key);
  const onDragOver = (e: React.DragEvent) => e.preventDefault();
  const onDrop = (section: 'image' | 'video', targetKey: string) => {
    if (!dragKey || dragKey === targetKey || !settings) return;
    const listKey = section === 'image' ? 'image_models' : 'video_models';
    const list = [...settings[listKey]];
    const from = list.indexOf(dragKey);
    const to = list.indexOf(targetKey);
    if (from === -1 || to === -1) return;
    list.splice(from, 1);
    list.splice(to, 0, dragKey);
    update({ ...settings, [listKey]: list });
    setDragKey(null);
  };

  if (!open) return null;

  const renderSection = (title: string, section: 'image' | 'video', models: string[] | undefined, defaultModel: string, labels: Record<string, string>) => {
    const safeModels = Array.isArray(models) ? models : [];
    const safeDefault = safeModels.includes(defaultModel) ? defaultModel : (safeModels[0] || '');
    return (
    <div className="mb-5">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: t.nodeMuted }}>{title}</h4>
      {/* 复刻 Ant Design Segmented：轨道色 + 选中项随主题变化 */}
      <div className="inline-flex flex-col rounded-md p-0.5" style={{
        background: t.nodeText === '#f5f5f4' ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.04)',
      }}>
        {safeModels.map((m) => {
          const isDark = t.nodeText === '#f5f5f4';
          const selectedBg = isDark ? 'rgba(255,255,255,0.08)' : '#ffffff';
          const selectedShadow = isDark ? 'none' : '0 1px 2px 0 rgba(0,0,0,0.03), 0 1px 6px -1px rgba(0,0,0,0.02), 0 2px 4px 0 rgba(0,0,0,0.02)';
          return (
          <div
            key={m}
            draggable
            onDragStart={() => onDragStart(m)}
            onDragOver={onDragOver}
            onDrop={() => onDrop(section, m)}
            onDragEnd={() => setDragKey(null)}
            onClick={() => settings && safeDefault !== m && update({ ...settings, [section === 'image' ? 'image_default' : 'video_default']: m })}
            className={`flex items-center gap-1.5 rounded-[4px] px-3 py-1 cursor-pointer select-none transition ${dragKey === m ? 'opacity-40' : ''}`}
            style={{
              background: safeDefault === m ? selectedBg : 'transparent',
              boxShadow: safeDefault === m ? selectedShadow : 'none',
              color: safeDefault === m ? t.nodeText : t.nodeMuted,
            }}
          >
            <GripVertical className="size-3 shrink-0 opacity-40" style={{ color: 'inherit' }} />
            <span className="text-sm">{labels[m] || m}</span>
          </div>
          );
        })}
      </div>
    </div>
  );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,.45)' }} />
      <div className="relative w-[480px] max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl" style={{ background: t.panel, borderColor: t.panelBorder }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: t.panelBorder }}>
          <div>
            <div className="flex items-center gap-2">
              <Settings2 className="size-4" style={{ color: t.nodeMuted }} />
              <h3 className="text-sm font-semibold" style={{ color: t.nodeText }}>画布设置</h3>
            </div>
            {isAdmin && (
              <p className="mt-0.5 text-xs" style={{ color: t.nodeFaint }}>你的身份是系统超级管理员，修改会同步系统设置</p>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 transition" style={{ color: t.nodeMuted }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.nodeText === '#f5f5f4' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          ><X className="size-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="py-10 text-center text-sm" style={{ color: t.nodeFaint }}>加载中...</div>
          ) : settings ? (
            <>
              {renderSection('图片模型', 'image', settings.image_models, settings.image_default, IMAGE_MODEL_LABELS)}
              {renderSection('视频模型', 'video', settings.video_models, settings.video_default, VIDEO_MODEL_LABELS)}
            </>
          ) : (
            <div className="py-10 text-center text-sm" style={{ color: t.nodeFaint }}>加载失败</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-[10px] border-t" style={{ borderColor: t.panelBorder }}>
          {saved && <span className="mr-auto text-[11px]" style={{ color: '#22c55e' }}>✓ 已保存到服务器</span>}
          <button
            onClick={isAdmin ? handleSave : onClose}
            disabled={isAdmin ? (!settings || saving) : false}
            className="h-8 rounded-lg px-[15px] text-sm font-normal outline-none"
            style={{
              background: t.nodeText,
              color: t.bg,
              border: '1px solid transparent',
              boxShadow: 'none',
              opacity: (isAdmin && saving) ? 0.6 : 1,
              cursor: (isAdmin && saving) ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s cubic-bezier(0.645, 0.045, 0.355, 1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = (isAdmin && saving) ? '0.6' : '1'; }}
          >
            {isAdmin && saving ? '保存中...' : '完成'}
          </button>
        </div>
      </div>
    </div>
  );
}
