"""抓取本应用窗口截图（PrintWindow 对 GPU 渲染窗口黑屏，故用置前 + ImageGrab）。"""
import ctypes
import ctypes.wintypes as wt
import sys
import time
from PIL import ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def list_windows():
    out = []

    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                out.append((hwnd, buf.value))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def main():
    want = sys.argv[1] if len(sys.argv) > 1 else "Codex"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "shot.png"
    matches = [(h, t) for h, t in list_windows() if want.lower() in t.lower()]
    if not matches:
        print("NO_WINDOW", want)
        for h, t in list_windows():
            print(" ", h, t)
        return 1
    hwnd, title = matches[0]
    print("HWND", hwnd, title)
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    time.sleep(0.4)
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.2)
    img = ImageGrab.grab(all_screens=True)
    img.save(out_path)
    print("SAVED", out_path, img.size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
