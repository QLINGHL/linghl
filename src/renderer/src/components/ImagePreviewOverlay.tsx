import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, LoaderCircle, TriangleAlert, RotateCw, Minus, Plus } from "lucide-react";

/**
 * 全屏图片预览浮层（官方 `useImageDialog` 那一层）。
 *
 * 官方行为（源码 + i18n + 截图佐证）：
 *   · 点图片块打开；**可以左右切换**上一张/下一张（`onPreviousImage` / `onNextImage`，到头就禁用）；
 *   · 底部显示「第 N 张，共 M 张」（`chatgptConversations.imageLightbox.position`）；
 *   · 关闭按钮 + Esc + 点背景空白处；方向键切换；
 *   · 图加载失败给「无法加载此图像 / 重试」（`imageLightbox.loadFailed` / `.retry`）；
 *   · 底部有一条**缩放条**（官方截图里是 `−  42%  +` 的胶囊），**滚轮也能缩放**。
 *
 * ⚠️ 关闭按钮位置：本窗口用 titleBarOverlay，原生 min/max/close 画在页面右上角 40px 条带里、
 * 层级在页面之上 —— 所以贴右上角的按钮**必须放在 `top-[52px]`**，否则会和原生按钮重叠。
 *
 * 缩放实现：图片以「适应窗口」为 100%（`object-contain` 的显示尺寸），
 * 滚轮按光标为锚点缩放（1/8× ~ 8×），放大后可拖拽平移；百分比按**图片原始像素**折算，
 * 所以大截图在适应窗口时会显示类似官方的 42%。
 */
export function ImagePreviewOverlay({
  paths,
  index,
  onIndex,
  onClose,
  mediaUrl,
}: {
  paths: string[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  mediaUrl: (filePath: string) => string;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState(1); // 相对「适应窗口」的倍数
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // 记录原始宽度与「适应窗口」时的渲染宽度 —— 百分比要按图片原始像素折算（官方大图显示 42% 就是这么来的）。
  // ⚠️ 不要在 render 里读 getBoundingClientRect：读到的是上一次提交的值，百分比会慢一拍。
  const [dims, setDims] = useState<{ natural: number; fit: number } | null>(null);
  const [showZoomBar, setShowZoomBar] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const total = paths.length;
  const current = paths[index];

  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 换张图重置加载态与缩放（新图从「适应窗口」看起）
  useEffect(() => {
    setStatus("loading");
    setDims(null);
    reset();
    setShowZoomBar(false);
  }, [current, reset]);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setZoom((prev) => {
      const next = Math.min(8, Math.max(0.25, prev * factor));
      const k = next / prev;
      if (k === 1) return prev;
      const a = anchor ?? { x: 0, y: 0 };
      // 以锚点为中心缩放：image 的 transform-origin 在中心，锚点用「相对容器中心」的坐标
      setOffset((o) => ({ x: a.x - (a.x - o.x) * k, y: a.y - (a.y - o.y) * k }));
      return next;
    });
  }, []);

  // 滚轮缩放（阻断页面滚动）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      zoomBy(Math.exp(-event.deltaY * 0.0015), anchor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && total > 1) onIndex((index - 1 + total) % total);
      if (event.key === "ArrowRight" && total > 1) onIndex((index + 1) % total);
      if (event.key === "0" || event.key.toLowerCase() === "r") reset();
      if (event.key === "+" || event.key === "=") zoomBy(1.25);
      if (event.key === "-" || event.key === "_") zoomBy(0.8);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, total, onIndex, onClose, reset, zoomBy]);

  const step = (delta: number) => {
    if (total < 2) return;
    onIndex((index + delta + total) % total);
  };

  // 放大后可拖拽平移
  const [dragging, setDragging] = useState(false);
  // ⚠️ 平移**任何缩放比例下都可用**（包括缩小到 20%/32% —— 用户就是要把缩小后的图摆到想要的位置）。
  //    第一版写了 `zoom <= 1 就 return`，结果缩小的图拖不动。
  const onPointerDown = (event: React.PointerEvent) => {
    event.stopPropagation();
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    setOffset({ x: drag.ox + (event.clientX - drag.x), y: drag.oy + (event.clientY - drag.y) });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
    setDragging(false);
  };

  // 百分比：按图片原始像素折算（适应窗口时的显示宽度 ÷ 原始宽度）
  const percent = dims ? Math.max(1, Math.round((dims.fit * zoom / dims.natural) * 100)) : Math.round(zoom * 100);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      className="fixed inset-0 z-[100] overflow-hidden bg-black/80"
      onClick={onClose}
      onMouseMove={() => setShowZoomBar(true)}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        {status === "loading" ? (
          <div className="flex items-center justify-center text-white/70">
            <LoaderCircle size={22} className="animate-spin" />
          </div>
        ) : null}

        {status === "error" ? (
          <div className="flex flex-col items-center gap-3 text-white/85" onClick={(event) => event.stopPropagation()}>
            <TriangleAlert size={22} />
            <div className="text-[14px]">无法加载此图像</div>
            <button
              type="button"
              onClick={() => setStatus("loading")}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1.5 text-[13px] text-white hover:bg-white/20"
            >
              <RotateCw size={13} /> 重试
            </button>
          </div>
        ) : null}

        <img
          key={current}
          src={current ? mediaUrl(current) : ""}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const el = event.currentTarget;
            setDims({ natural: el.naturalWidth || 1, fit: el.getBoundingClientRect().width || 1 });
            setStatus("ready");
          }}
          onError={() => setStatus("error")}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (zoom === 1) zoomBy(2); else reset();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? "none" : "transform 120ms ease-out",
            cursor: dragging ? "grabbing" : "grab",
          }}
          className={`max-h-[86vh] max-w-[88vw] rounded-[8px] object-contain shadow-[0_16px_48px_rgba(0,0,0,0.5)] ${status === "ready" ? "opacity-100" : "opacity-0"}`}
        />
      </div>

      {total > 1 ? (
        <>
          <button
            type="button"
            aria-label="上一张"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
            className="absolute left-5 top-1/2 flex h-[36px] w-[36px] -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            type="button"
            aria-label="下一张"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
            className="absolute right-5 top-1/2 flex h-[36px] w-[36px] -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
          >
            <ChevronRight size={20} />
          </button>
          <div className="pointer-events-none absolute bottom-6 left-6 text-[13px] text-white/75">
            第 {index + 1} 张，共 {total} 张
          </div>
        </>
      ) : null}

      {/* 缩放条：官方截图里是底部居中的 `− 42% +` 胶囊 */}
      <div
        className={`absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/12 px-1 py-1 text-white transition-opacity duration-200 ${showZoomBar ? "opacity-100" : "opacity-0"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="缩小"
          onClick={() => zoomBy(0.8)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-full hover:bg-white/20"
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label="重置缩放"
          onClick={reset}
          className="min-w-[46px] rounded-full px-1 text-center text-[13px] tabular-nums hover:bg-white/20"
        >
          {percent}%
        </button>
        <button
          type="button"
          aria-label="放大"
          onClick={() => zoomBy(1.25)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-full hover:bg-white/20"
        >
          <Plus size={15} />
        </button>
      </div>

      <button
        type="button"
        aria-label="关闭"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute right-5 top-[52px] flex h-[36px] w-[36px] items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
      >
        <X size={18} />
      </button>
    </div>
  );
}
