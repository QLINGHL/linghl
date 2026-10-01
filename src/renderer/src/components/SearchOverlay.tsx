import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { SquarePen, FolderOpen, Search } from "lucide-react";
import { useStore } from "../store";
import { rpc } from "../lib/api";

export default function SearchOverlay() {
  const open = useStore((s) => s.searchOpen);
  const setOpen = useStore((s) => s.setSearchOpen);
  const threads = useStore((s) => s.threads);
  const openThread = useStore((s) => s.openThread);
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (open) {
      setQ("");
      setNotice("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = threads.slice(0, 9);
    return kw ? threads.filter((t) => (t.name || t.title || t.preview || "").toLowerCase().includes(kw)).slice(0, 9) : list;
  }, [threads, q]);
  // Alt+N 快捷键打开的是"最近会话"列表的第 N 项（见 App.tsx），
  // 只有未输入过滤词时徽标才与实际行为一致
  const showAltBadges = !q.trim();

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--c-scrim)]" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[560px] max-w-[90vw] -translate-x-1/2 rounded-2xl border border-border bg-bg p-2 shadow-[0_24px_70px_rgba(0,0,0,0.22)] outline-none fade-up">
          <Dialog.Title className="sr-only">搜索聊天</Dialog.Title>
          <Dialog.Description className="sr-only">按关键字过滤最近会话，或使用下方快捷操作</Dialog.Description>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索聊天"
            className="w-full rounded-xl px-3.5 py-2.5 text-[14px] outline-none placeholder:text-text3"
          />
          {filtered.length > 0 && (
            <div className="mt-1 px-1 pb-1">
              <p className="px-2.5 py-1 text-[11.5px] text-text3">聊天</p>
              {filtered.map((t, i) => (
                <button
                  key={t.id}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-text hover:bg-bghover"
                  onClick={() => {
                    setOpen(false);
                    void openThread(t.id);
                  }}
                >
                  <span className="truncate">{t.name || t.title || t.preview || "未命名会话"}</span>
                  {showAltBadges && (
                    <span className="ml-auto rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-text3">
                      Alt+{i + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="border-t border-border px-1 pt-1.5 pb-1">
            <p className="px-2.5 py-1 text-[11.5px] text-text3">快捷操作</p>
            <button
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bghover"
              onClick={() => {
                setOpen(false);
                useStore.getState().newChat();
              }}
            >
              <SquarePen size={14} className="text-text2" /> 新聊天
              <span className="ml-auto text-[10.5px] text-text3">Ctrl+N</span>
            </button>
            <button
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bghover"
              onClick={async () => {
                const path = await rpc.env.pickFolder();
                if (path) {
                  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
                  await useStore.getState().addProject({ name, path });
                  setOpen(false);
                }
              }}
            >
              <FolderOpen size={14} className="text-text2" /> 打开文件夹
              <span className="ml-auto text-[10.5px] text-text3">Ctrl+O</span>
            </button>
            <button
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bghover"
              onClick={() => setNotice("文件搜索暂未实现，请先使用项目或聊天搜索")}
            >
              <Search size={14} className="text-text2" /> 搜索文件
              <span className="ml-auto text-[10.5px] text-text3">Ctrl+P</span>
            </button>
          </div>
          {notice && <p className="px-2.5 pb-1 text-[12px] text-accent">{notice}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
