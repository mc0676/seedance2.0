// 主题切换按钮 — 复刻原项目 AnimatedThemeToggler
import { Sun, Moon } from 'lucide-react';

interface Props {
  theme: 'dark' | 'light';
  onToggle: () => void;
}

export function ThemeToggler({ theme, onToggle }: Props) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={onToggle}
      className="grid size-9 place-items-center rounded-full transition hover:bg-white/10"
      title={isDark ? '切换到浅色主题' : '切换到深色主题'}
      aria-label={isDark ? '切换到浅色主题' : '切换到深色主题'}
    >
      {isDark ? <Sun className="size-4" style={{ color: '#f5f5f4' }} /> : <Moon className="size-4" style={{ color: '#292524' }} />}
    </button>
  );
}
