import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { SHORTCUTS } from "../lib/ui-actions";
import { useStore } from "../store";

/**
 * 键盘快捷键弹层。活动栏底部的帮助按钮、`Ctrl+/`、标题栏「帮助 → 显示键盘快捷键」
 * 三条入口共用它 —— 内容取自 ui-actions 的 SHORTCUTS，保证标签写的就是实际绑定的。
 * （之前这里是 window.alert，原生弹窗跟应用的视觉体系完全不搭。）
 */
export default function ShortcutsDialog() {
  const open = useStore((s) => s.shortcutsOpen);
  const setOpen = useStore((s) => s.setShortcutsOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-[var(--c-scrim)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] max-h-[76vh] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[16px] bg-bg p-5 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_16px_48px_-8px_rgba(0,0,0,0.22)] outline-none"
        >
          <div className="flex items-start justify-between">
            <Dialog.Title className="text-[16px] font-medium text-text">键盘快捷键</Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="-mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-full text-text3 hover:bg-bghover hover:text-text"
                aria-label="关闭"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3.5">
            {SHORTCUTS.map(([keys, label]) => (
              <div
                key={keys}
                className="flex items-center justify-between gap-6 rounded-[8px] px-2 py-[7px] text-[13px]"
              >
                <span className="text-text">{label}</span>
                <kbd className="shrink-0 rounded-[6px] bg-bgsub px-2 py-[3px] font-sans text-[12px] text-text2">
                  {keys}
                </kbd>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
