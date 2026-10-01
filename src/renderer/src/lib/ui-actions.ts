import { useStore } from "../store";

/** 界面缩放：基于根字号实现（0 = 恢复默认 14px）。
 *  App 的键盘监听、标题栏「视图」菜单共用这一份逻辑。 */
export function zoomFont(delta: 1 | -1 | 0) {
  const current = useStore.getState().prefs?.fontSize ?? 14;
  const next = delta === 0 ? 14 : Math.min(24, Math.max(12, current + delta));
  if (next !== current) void useStore.getState().setPrefs({ fontSize: next });
}

/** 键盘快捷键清单 —— 帮助菜单与 Ctrl+/ 共用同一份内容，
 *  保证「标签上写的」和「实际绑定的」永远一致。 */
export const SHORTCUTS: [string, string][] = [
  ["Ctrl+K / Ctrl+F / Ctrl+P", "搜索聊天"],
  ["Ctrl+N", "新聊天"],
  ["Ctrl+O", "打开文件夹"],
  ["Ctrl+B", "显示/隐藏侧边栏"],
  ["Ctrl+Shift+B", "新建标签页"],
  ["Ctrl+Shift+F", "完整视图"],
  ["Ctrl+,", "设置"],
  ["Ctrl+/", "显示键盘快捷键"],
  ["Ctrl+Shift+= / Ctrl+- / Ctrl+0", "放大 / 缩小 / 实际大小"],
  ["Alt+1 ~ Alt+9", "打开最近会话"],
  ["Enter（可改为 Ctrl+Enter）", "发送消息"],
];

export function showShortcuts() {
  // 走应用内的弹层，不用 window.alert（原生弹窗和整体视觉不搭，且会阻塞渲染进程）
  useStore.getState().setShortcutsOpen(true);
}
