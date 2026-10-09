"""The two macOS calls the bridge needs, through ctypes.

Posting Cmd-V with CoreGraphics needs one permission (Accessibility) for this
Python binary. Going through `osascript` and System Events would need an
Automation permission on top of that.
"""

from __future__ import annotations

import ctypes
import ctypes.util

_KEY_V = 9
_FLAG_COMMAND = 0x00100000
_HID_EVENT_TAP = 0

_cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
_cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
_ax = ctypes.CDLL(ctypes.util.find_library("ApplicationServices"))

_cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
_cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
_cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
_cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
_cf.CFRelease.argtypes = [ctypes.c_void_p]
_cf.CFDictionaryCreate.restype = ctypes.c_void_p
_cf.CFDictionaryCreate.argtypes = [
    ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
    ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p,
]
_ax.AXIsProcessTrusted.restype = ctypes.c_bool
_ax.AXIsProcessTrustedWithOptions.restype = ctypes.c_bool
_ax.AXIsProcessTrustedWithOptions.argtypes = [ctypes.c_void_p]


def ax_trusted(prompt: bool = False) -> bool:
    if not prompt:
        return bool(_ax.AXIsProcessTrusted())
    key = ctypes.c_void_p.in_dll(_ax, "kAXTrustedCheckOptionPrompt")
    true = ctypes.c_void_p.in_dll(_cf, "kCFBooleanTrue")
    keys, values = (ctypes.c_void_p * 1)(key), (ctypes.c_void_p * 1)(true)
    options = _cf.CFDictionaryCreate(
        None, keys, values, 1,
        ctypes.addressof(ctypes.c_void_p.in_dll(_cf, "kCFTypeDictionaryKeyCallBacks")),
        ctypes.addressof(ctypes.c_void_p.in_dll(_cf, "kCFTypeDictionaryValueCallBacks")),
    )
    try:
        return bool(_ax.AXIsProcessTrustedWithOptions(options))
    finally:
        _cf.CFRelease(options)


def press_cmd_v() -> None:
    for down in (True, False):
        event = _cg.CGEventCreateKeyboardEvent(None, _KEY_V, down)
        _cg.CGEventSetFlags(event, _FLAG_COMMAND)
        _cg.CGEventPost(_HID_EVENT_TAP, event)
        _cf.CFRelease(event)
