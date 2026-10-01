"""Observe real desktop windows; coordinates are relative to the captured window."""
import argparse
import ctypes
import json
import time
from pathlib import Path
import win32gui
import win32con
import win32clipboard
from PIL import ImageGrab
from pywinauto import mouse, keyboard

ctypes.windll.user32.SetProcessDPIAware()
p = argparse.ArgumentParser()
p.add_argument('hwnd', type=int)
p.add_argument('output')
p.add_argument('--click', nargs=2, type=int)
p.add_argument('--text-file')
p.add_argument('--keys')
p.add_argument('--wait', type=float, default=0.7)
p.add_argument('--count', type=int, default=1)
p.add_argument('--interval', type=float, default=3)
a = p.parse_args()
win32gui.ShowWindow(a.hwnd, win32con.SW_RESTORE)
try:
    win32gui.SetForegroundWindow(a.hwnd)
except Exception:
    win32gui.ShowWindow(a.hwnd, win32con.SW_MINIMIZE)
    win32gui.ShowWindow(a.hwnd, win32con.SW_RESTORE)
time.sleep(0.4)
r = win32gui.GetWindowRect(a.hwnd)
if a.click:
    mouse.click(coords=(r[0] + a.click[0], r[1] + a.click[1]))
if a.text_file:
    value = Path(a.text_file).read_text(encoding='utf-8')
    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(value, win32con.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()
    keyboard.send_keys('^v')
if a.keys:
    keyboard.send_keys(a.keys)
time.sleep(a.wait)
out = Path(a.output)
out.parent.mkdir(parents=True, exist_ok=True)
for i in range(a.count):
    r = win32gui.GetWindowRect(a.hwnd)
    path = out if a.count == 1 else out.with_name(f'{out.stem}-{i:03d}{out.suffix}')
    ImageGrab.grab(bbox=r, all_screens=True).save(path)
    print(json.dumps({'path': str(path.resolve()), 'time': time.time(), 'rect': r, 'foreground':win32gui.GetForegroundWindow()}), flush=True)
    if i + 1 < a.count:
        time.sleep(a.interval)
