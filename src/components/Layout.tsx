import type { ReactNode } from 'react';

interface LayoutProps {
  /** 左侧面板内容 */
  left: ReactNode;
  /** 右侧面板内容（历史记录列表等） */
  right: ReactNode;
  /** 页面标题（左栏顶部显示） */
  title?: string;
  /** 右侧面板标题，默认 "历史记录" */
  historyTitle?: string;
  /** 项目/工作组名称（可选） */
  projectName?: string;
  /** 左上角操作按钮（如"刷新"等） */
  headerActions?: ReactNode;
}

/**
 * 页面布局组件：左栏调参数 + 右栏历史记录
 *
 * 与 SingleTaskPage（视频生成）保持一致的样式：
 * - 左栏 w-[520px] 固定宽度，可滚动
 * - 右栏 flex-1 填充剩余空间
 * - 深色主题 #0f111a / #090a0f
 */
export default function Layout({
  left,
  right,
  title,
  historyTitle = '历史记录',
  projectName,
  headerActions,
}: LayoutProps) {
  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden bg-[#0f111a] text-white">
      {/* Mobile Header */}
      <div className="md:hidden sticky top-0 z-40 bg-[#0f111a]/95 backdrop-blur-sm px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <h1 className="text-lg font-bold">{title || ''}</h1>
      </div>

      {/* Left Panel */}
      <div className="flex-1 md:w-[520px] md:flex-none md:border-r border-gray-800 overflow-y-auto custom-scrollbar p-4 md:p-6 bg-[#0f111a]">
        {/* Header */}
        {(title || headerActions || projectName) && (
          <div className="hidden md:flex flex-col gap-1 mb-4">
            <div className="flex items-center justify-between gap-2">
              {title && (
                <h2 className="text-xl font-bold truncate">{title}</h2>
              )}
              {headerActions && (
                <div className="flex items-center gap-2 flex-shrink-0">
                  {headerActions}
                </div>
              )}
            </div>
            {projectName && (
              <div className="flex items-center gap-2">
                <span className="text-xs px-2.5 py-1 rounded-xl bg-purple-500/20 border border-purple-500/30 text-purple-300 font-medium truncate max-w-[300px]">
                  {projectName}
                </span>
              </div>
            )}
          </div>
        )}

        {left}
      </div>

      {/* Right Panel */}
      <div className="flex-1 bg-[#090a0f] overflow-y-auto flex flex-col">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider">
            {historyTitle}
          </h2>
        </div>
        {right}
      </div>
    </div>
  );
}
