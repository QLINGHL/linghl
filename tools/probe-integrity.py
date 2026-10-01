# -*- coding: utf-8 -*-
"""对比进程访问令牌：完整性级别 / 是否 AppContainer / 受限令牌 / DENY_ONLY 组。
纯 ctypes，不依赖 pywin32 / Add-Type。用法: python _token-probe.py <pid> ...
"""
import ctypes
import sys
from ctypes import wintypes

advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                        ctypes.POINTER(wintypes.DWORD)]
advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
advapi32.LookupAccountSidW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPWSTR,
                                       ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR,
                                       ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TOKEN_USER = 1
TOKEN_GROUPS = 2
TOKEN_RESTRICTED_SIDS = 12
TOKEN_INTEGRITY_LEVEL = 25
TOKEN_IS_APP_CONTAINER = 29
TOKEN_HAS_RESTRICTIONS = 31
SE_GROUP_USE_FOR_DENY_ONLY = 0x00000010

INTEGRITY = {0x0000: "Untrusted", 0x1000: "Low", 0x2000: "Medium", 0x3000: "High",
             0x4000: "System", 0x5000: "Protected"}


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class TOKEN_GROUPS_HDR(ctypes.Structure):
    _fields_ = [("GroupCount", wintypes.DWORD), ("Groups", SID_AND_ATTRIBUTES * 1)]


def sid_string(p):
    s = ctypes.c_wchar_p()
    if advapi32.ConvertSidToStringSidW(p, ctypes.byref(s)):
        return s.value
    return "?"


def account(p):
    name = ctypes.create_unicode_buffer(256)
    dom = ctypes.create_unicode_buffer(256)
    n = wintypes.DWORD(256)
    d = wintypes.DWORD(256)
    use = wintypes.DWORD()
    if advapi32.LookupAccountSidW(None, p, name, ctypes.byref(n), dom, ctypes.byref(d), ctypes.byref(use)):
        return f"{dom.value}\\{name.value}"
    return "?"


def token_info(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return f"PID {pid}: OpenProcess 失败 err={ctypes.get_last_error()}"
    tok = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(h, TOKEN_QUERY, ctypes.byref(tok)):
        err = ctypes.get_last_error()
        kernel32.CloseHandle(h)
        return f"PID {pid}: OpenProcessToken 失败 err={err}"

    def get(cls):
        need = wintypes.DWORD()
        advapi32.GetTokenInformation(tok, cls, None, 0, ctypes.byref(need))
        if not need.value:
            return None
        buf = ctypes.create_string_buffer(need.value)
        if not advapi32.GetTokenInformation(tok, cls, ctypes.cast(buf, ctypes.c_void_p),
                                            need.value, ctypes.byref(need)):
            return None
        return buf  # 保持引用，避免被回收

    L = [f"===== PID {pid} ====="]

    b = get(TOKEN_IS_APP_CONTAINER)
    if b:
        L.append(f"  是否 AppContainer         : {bool(ctypes.c_uint32.from_buffer(b).value)}")
    b = get(TOKEN_HAS_RESTRICTIONS)
    if b:
        L.append(f"  是否为受限令牌(受限SID)   : {bool(ctypes.c_uint32.from_buffer(b).value)}")

    b = get(TOKEN_INTEGRITY_LEVEL)
    if b:
        sa = ctypes.cast(ctypes.cast(b, ctypes.c_void_p), ctypes.POINTER(SID_AND_ATTRIBUTES)).contents
        sub = ctypes.cast(sa.Sid, ctypes.POINTER(ctypes.c_ubyte))
        count = sub[1]
        start = 8 + 4 * (count - 1)
        last = int.from_bytes(bytes(sub[start:start + 4]), "little")
        L.append(f"  完整性级别                : {INTEGRITY.get(last & 0xF000, hex(last))} (RID={last})")

    b = get(TOKEN_USER)
    if b:
        sa = ctypes.cast(ctypes.cast(b, ctypes.c_void_p), ctypes.POINTER(SID_AND_ATTRIBUTES)).contents
        L.append(f"  用户 SID                  : {sid_string(sa.Sid)} ({account(sa.Sid)})")

    b = get(TOKEN_GROUPS)
    if b:
        hdr = ctypes.cast(ctypes.cast(b, ctypes.c_void_p), ctypes.POINTER(TOKEN_GROUPS_HDR)).contents
        base_addr = ctypes.addressof(b) + TOKEN_GROUPS_HDR.Groups.offset
        arr = ctypes.cast(base_addr, ctypes.POINTER(SID_AND_ATTRIBUTES))
        deny = []
        for i in range(hdr.GroupCount):
            g = arr[i]
            if g.Attributes & SE_GROUP_USE_FOR_DENY_ONLY:
                deny.append(f"{account(g.Sid)}")
        L.append(f"  组数量 / DENY_ONLY 组     : {hdr.GroupCount} / {deny if deny else '无'}")

    b = get(TOKEN_RESTRICTED_SIDS)
    if b:
        hdr = ctypes.cast(ctypes.cast(b, ctypes.c_void_p), ctypes.POINTER(TOKEN_GROUPS_HDR)).contents
        base_addr = ctypes.addressof(b) + TOKEN_GROUPS_HDR.Groups.offset
        arr = ctypes.cast(base_addr, ctypes.POINTER(SID_AND_ATTRIBUTES))
        names = [f"{account(arr[i].Sid)}" for i in range(hdr.GroupCount)]
        L.append(f"  受限令牌 SID              : {names if names else '空（非受限令牌）'}")

    kernel32.CloseHandle(tok)
    kernel32.CloseHandle(h)
    return "\n".join(L)


if __name__ == "__main__":
    for a in sys.argv[1:]:
        try:
            print(token_info(int(a)))
        except Exception as e:
            import traceback
            print(f"PID {a}: 出错 {e}")
            traceback.print_exc()
