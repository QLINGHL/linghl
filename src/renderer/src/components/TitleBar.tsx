import { ChevronLeft, ChevronRight, PanelLeft, FolderOpen } from "lucide-react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { useStore } from "../store";
import { M, rpc } from "../lib/api";
import { showShortcuts, zoomFont } from "../lib/ui-actions";

const contentCls =
  "z-50 min-w-[220px] rounded-xl border border-border bg-bg p-1.5 shadow-[0_10px_38px_rgba(0,0,0,0.14)] text-[13px]";
const itemCls =
  "flex cursor-default items-center justify-between gap-8 rounded-lg px-2.5 py-[7px] outline-none data-[highlighted]:bg-bghover";
const shortcutCls = "text-text3 text-xs";

export default function TitleBar() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const setView = useStore((s) => s.setView);
  const goBack = useStore((s) => s.goBack);
  const goForward = useStore((s) => s.goForward);
  const newChat = useStore((s) => s.newChat);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const loadThreads = useStore((s) => s.loadThreads);
  const canGoBack = useStore((s) => s.viewHistoryIndex > 0);
  const canGoForward = useStore((s) => s.viewHistoryIndex < s.viewHistory.length - 1);

  const edit = (cmd: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => () => {
    void rpc.editCommand(cmd).catch(() => undefined);
  };
  const zoom = (delta: 1 | -1 | 0) => () => zoomFont(delta);
  const openDocs = () => {
    rpc.openExternal("https://developers.openai.com/codex").catch(() => undefined);
  };
  const showAbout = () => {
    void rpc
      .appInfo()
      .then((info) => window.alert(`LINGHL\n版本 ${info.version}\n数据目录：${info.userData}`))
      .catch(() => window.alert("LINGHL"));
  };

  // 高度用 h-[40px]：根字号是 14px，h-10 实际只有 35px，官方标题栏是 40px
  return (
    <header className="app-drag relative flex h-[40px] shrink-0 items-center gap-1 bg-bgsub px-2 text-[13px]">
      <button
        className={`app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-text3 ${canGoBack ? "hover:bg-bghover hover:text-text" : "cursor-default opacity-40"}`}
        onClick={goBack}
        disabled={!canGoBack}
        aria-label="后退"
        title="后退"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        className={`app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-text3 ${canGoForward ? "hover:bg-bghover hover:text-text" : "cursor-default opacity-40"}`}
        onClick={goForward}
        disabled={!canGoForward}
        aria-label="前进"
        title="前进"
      >
        <ChevronRight size={16} />
      </button>
      <button
        className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-text3 hover:bg-bghover hover:text-text"
        onClick={toggleSidebar}
        title={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
        aria-label={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
      >
        <PanelLeft size={15} />
      </button>

      <nav className="app-no-drag ml-2 flex items-center gap-0.5" data-tauri-drag-region>
        <DM.Root>
          <DM.Trigger className="rounded-md px-2.5 py-1 outline-none hover:bg-bghover">文件</DM.Trigger>
          <DM.Portal>
            <DM.Content className={contentCls} align="start" sideOffset={6}>
              <DM.Item className={itemCls} onSelect={() => void rpc.newWindow().catch(() => undefined)}>新建窗口</DM.Item>
              <DM.Item className={itemCls} onSelect={newChat}>新聊天 <span className={shortcutCls}>Ctrl+N</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item
                className={itemCls}
                onSelect={async () => {
                  const path = await rpc.env.pickFolder();
                  if (path) {
                    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
                    await useStore.getState().addProject({ name, path });
                  }
                }}
              >
                打开文件夹 <FolderOpen size={14} className="text-text3" />
              </DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item
                className={itemCls}
                onSelect={async () => {
                  try {
                    await rpc.request(M.accountLogout);
                    await useStore.getState().checkAccount();
                  } catch (error) {
                    console.warn("退出登录失败", error);
                  }
                }}
              >退出登录</DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>

        <DM.Root>
          <DM.Trigger className="rounded-md px-2.5 py-1 outline-none hover:bg-bghover">编辑</DM.Trigger>
          <DM.Portal>
            <DM.Content className={contentCls} align="start" sideOffset={6}>
              <DM.Item className={itemCls} onSelect={edit("undo")}>撤销 <span className={shortcutCls}>Ctrl+Z</span></DM.Item>
              <DM.Item className={itemCls} onSelect={edit("redo")}>重做 <span className={shortcutCls}>Ctrl+Y</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={edit("cut")}>剪切 <span className={shortcutCls}>Ctrl+X</span></DM.Item>
              <DM.Item className={itemCls} onSelect={edit("copy")}>复制 <span className={shortcutCls}>Ctrl+C</span></DM.Item>
              <DM.Item className={itemCls} onSelect={edit("paste")}>粘贴 <span className={shortcutCls}>Ctrl+V</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={edit("selectAll")}>全选 <span className={shortcutCls}>Ctrl+A</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={() => setView("settings")}>设置 <span className={shortcutCls}>Ctrl+,</span></DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>

        <DM.Root>
          <DM.Trigger className="rounded-md px-2.5 py-1 outline-none hover:bg-bghover">视图</DM.Trigger>
          <DM.Portal>
            <DM.Content className={contentCls} align="start" sideOffset={6}>
              <DM.Item className={itemCls} onSelect={toggleSidebar}>显示/隐藏侧边栏 <span className={shortcutCls}>Ctrl+B</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={() => useStore.getState().wsNewTab()}>新建标签页 <span className={shortcutCls}>Ctrl+Shift+B</span></DM.Item>
              <DM.Item className={itemCls} onSelect={() => useStore.getState().wsToggleFullView()}>完整视图 <span className={shortcutCls}>Ctrl+Shift+F</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={() => setSearchOpen(true)}>查找 <span className={shortcutCls}>Ctrl+F</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={() => void loadThreads()}>刷新聊天列表</DM.Item>
              <DM.Item className={itemCls} onSelect={zoom(1)}>放大 <span className={shortcutCls}>Ctrl+Shift+=</span></DM.Item>
              <DM.Item className={itemCls} onSelect={zoom(-1)}>缩小 <span className={shortcutCls}>Ctrl+-</span></DM.Item>
              <DM.Item className={itemCls} onSelect={zoom(0)}>实际大小 <span className={shortcutCls}>Ctrl+0</span></DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>

        <DM.Root>
          <DM.Trigger className="rounded-md px-2.5 py-1 outline-none hover:bg-bghover">帮助</DM.Trigger>
          <DM.Portal>
            <DM.Content className={contentCls} align="start" sideOffset={6}>
              <DM.Item className={itemCls} onSelect={openDocs}>文档</DM.Item>
              <DM.Item className={itemCls} onSelect={showShortcuts}>显示键盘快捷键 <span className={shortcutCls}>Ctrl+/</span></DM.Item>
              <DM.Separator className="my-1 h-px bg-border" />
              <DM.Item className={itemCls} onSelect={showAbout}>关于 LINGHL</DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </nav>
    </header>
  );
}