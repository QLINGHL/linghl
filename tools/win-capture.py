"""抓取本应用窗口（按 electron 主进程 PID 精确匹配），并输出指定区域的像素统计。

原生窗口控件（最小化/最大化/关闭）是系统绘制的，不在 CDP 截图范围内，
所以校验主题色必须走屏幕抓取。
"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys
import time
from PIL import ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def electron_main_pids() -> set[int]:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
         "Where-Object { $_.CommandLine -like '*codex-app*' -and $_.CommandLine -notlike '*--type=*' } | "
         "Select-Object -ExpandProperty ProcessId"],
        capture_output=True, text=True,
    ).stdout
    return {int(x) for x in out.split() if x.strip().isdigit()}


def find_window() -> int | None:
    pids = electron_main_pids()
    hits: list[tuple[int, int]] = []

    def cb(hwnd, _l):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value.strip():
                hits.append((hwnd, pid.value))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return hits[0][0] if hits else None


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "shot-window.png"
    crop_arg = sys.argv[2] if len(sys.argv) > 2 else "corner"  # corner | full
    hwnd = find_window()
    if not hwnd:
        print("NO_WINDOW")
        return 1
    # 只 SetForegroundWindow 对后台进程常常无效（Windows 前台锁），
    # 先最小化再还原是唯一稳的做法（还原会回到原来的最大化状态）
    SW_MINIMIZE, SW_RESTORE = 6, 9
    user32.ShowWindow(hwnd, SW_MINIMIZE)
    time.sleep(0.6)
    user32.ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.4)
    cur = user32.GetForegroundWindow()
    tt = user32.GetWindowThreadProcessId(cur, None)
    th = user32.GetWindowThreadProcessId(hwnd, None)
    user32.AttachThreadInput(tt, th, True)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    user32.AttachThreadInput(tt, th, False)
    time.sleep(2.0)

    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    print("HWND", hwnd, "rect", rect.left, rect.top, rect.right, rect.bottom, "size", w, h)

    img = ImageGrab.grab(all_screens=True)
    img.save(out_path)

    # 多显示器：ImageGrab 的图以虚拟屏左上角为原点，必须减掉虚拟屏原点偏移，
    # 否则按 GetWindowRect 的绝对坐标裁出来的是别的窗口（这个坑踩过一次）
    vx = user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
    vy = user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
    print("virtual origin", vx, vy, "image", img.size)
    L, T, R, B = rect.left - vx, rect.top - vy, rect.right - vx, rect.bottom - vy

    if crop_arg == "corner":
        c = img.crop((R - 190, T, R, T + 90))
        c = c.resize((c.width * 3, c.height * 3))
        c.save(out_path.replace(".png", "-corner.png"))
        px = img.load()
        vals = [sum(px[x, y]) // 3 for x in range(R - 80, R - 4) for y in range(T + 26, T + 74)]
        print("corner max luminance:", max(vals), "min:", min(vals))
        print("saved", out_path, "and", out_path.replace(".png", "-corner.png"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
