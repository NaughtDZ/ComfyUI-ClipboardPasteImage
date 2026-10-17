# -*- coding: utf-8 -*-
"""
ComfyUI 剪贴板图片节点（Clipboard Paste Image）
=================================================

把剪贴板里的图片直接变成 IMAGE / MASK，**全程不写入 ComfyUI 的 input 目录**。

两条取图通道
------------
1. 浏览器前端粘贴（主通道）
   在节点上按 Ctrl+V，或点节点上的「粘贴剪贴板图片」按钮。
   图片经 ``POST /clipboard_image/store`` 以原始字节上传，后端解码后
   只保留在进程内存里，返回一个内容哈希 key；节点把 key 写进隐藏 widget。

2. 系统剪贴板直读（可选通道 / 同机兜底）
   勾选 ``read_system_clipboard`` 后，每次执行时用 ``PIL.ImageGrab.grabclipboard()``
   读取服务端所在机器的剪贴板。改图后重新 Queue 即可，无需重新粘贴。

说明
----
- 内存缓存有数量与总字节上限，按 LRU 淘汰。
- ComfyUI 重启后缓存清空，旧 workflow 里的 key 会失效（报错会提示重新粘贴）。
- 除本节点自身外��不产生任何临时文件；如需保存成文件请接 SaveImage / PreviewImage。
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import sys
import threading
import time
from collections import OrderedDict
from typing import List, Optional, Tuple

import numpy as np
import torch
from PIL import Image, ImageGrab, ImageOps, ImageSequence

LOG = logging.getLogger("ClipboardPasteImage")
if not LOG.handlers:
    LOG.addHandler(logging.StreamHandler())
LOG.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
MAX_ITEMS = 32                                  # 内存里最多保留几张
MAX_TOTAL_BYTES = 512 * 1024 * 1024             # 最多占用约 512 MB（按像素字节估算）
MAX_UPLOAD_BYTES = 128 * 1024 * 1024            # 单次上传上限
THUMB_MAX_SIDE = 640                            # 节点缩略图最长边


# ---------------------------------------------------------------------------
# 内存缓存（进程内，绝不落盘）
# ---------------------------------------------------------------------------
class _ImageStore:
    """线程安全、按内容哈希去重的 LRU 图片内存池。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._items: "OrderedDict[str, dict]" = OrderedDict()
        self._bytes = 0

    # -- 内部工具 ----------------------------------------------------------
    @staticmethod
    def _hash_frames(frames: List[Image.Image]) -> str:
        digest = hashlib.sha256()
        for frame in frames:
            digest.update(f"{frame.width}x{frame.height}:{frame.mode}:".encode("utf-8"))
            digest.update(frame.tobytes())
        return digest.hexdigest()[:32]

    def _evict_locked(self) -> None:
        while self._items and (
            len(self._items) > MAX_ITEMS or self._bytes > MAX_TOTAL_BYTES
        ):
            _, item = self._items.popitem(last=False)
            self._bytes -= item.get("bytes", 0)

    # -- 对外接口 ----------------------------------------------------------
    def put(self, frames: List[Image.Image]) -> str:
        if not frames:
            raise ValueError("没有可缓存的图像帧")
        key = self._hash_frames(frames)
        total = sum(len(f.tobytes()) for f in frames)
        with self._lock:
            if key in self._items:
                item = self._items.pop(key)
                self._bytes -= item.get("bytes", 0)
            else:
                item = {}
            item.update(
                frames=frames,
                width=frames[0].width,
                height=frames[0].height,
                bytes=total,
                ts=time.time(),
            )
            item.setdefault("thumb", None)
            self._items[key] = item
            self._bytes += total
            self._evict_locked()
        return key

    def get(self, key: str) -> Optional[dict]:
        if not key:
            return None
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            self._items.move_to_end(key)
            return item

    def exists(self, key: str) -> bool:
        with self._lock:
            return key in self._items

    def thumbnail(self, key: str) -> Optional[bytes]:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            if item.get("thumb"):
                return item["thumb"]
            frame = item["frames"][0]
        # 释放锁后再做图像处理，避免阻塞执行线程
        thumb = frame.copy()
        thumb.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)
        buf = io.BytesIO()
        thumb.save(buf, format="PNG", optimize=True)
        data = buf.getvalue()
        with self._lock:
            current = self._items.get(key)
            if current is not None:
                current["thumb"] = data
        return data

    def stats(self) -> dict:
        with self._lock:
            return {
                "items": len(self._items),
                "bytes": self._bytes,
                "max_items": MAX_ITEMS,
                "max_bytes": MAX_TOTAL_BYTES,
            }


STORE = _ImageStore()


# ---------------------------------------------------------------------------
# 图像解码 / 转换
# ---------------------------------------------------------------------------
def _mode_has_alpha(mode: str, info: dict) -> bool:
    if mode in ("RGBA", "LA", "PA", "RGBa", "La"):
        return True
    if mode in ("P", "L", "RGB") and info.get("transparency") is not None:
        return True
    return False


def decode_image_bytes(raw: bytes) -> List[Image.Image]:
    """把任意常见格式的图片字节解码成统一的 PIL 帧列表（RGB 或 RGBA）。"""
    if not raw:
        raise ValueError("收到空数据")
    with Image.open(io.BytesIO(raw)) as src:
        src.load()
        frames: List[Image.Image] = []
        first_size: Optional[Tuple[int, int]] = None
        for frame in ImageSequence.Iterator(src):
            # exif_transpose 总是返回副本，可以安全地脱离迭代器保存
            frame = ImageOps.exif_transpose(frame)
            target_mode = "RGBA" if _mode_has_alpha(frame.mode, frame.info) else "RGB"
            if frame.mode != target_mode:
                frame = frame.convert(target_mode)
            frame.load()
            if first_size is None:
                first_size = frame.size
            elif frame.size != first_size:
                # 与原生 LoadImage 一致：尺寸不一致的帧丢弃
                continue
            frames.append(frame)
        if not frames:
            raise ValueError("图片里没有可用的帧")
        return frames


def image_to_tensors(frames: List[Image.Image]):
    """PIL 帧列表 -> (IMAGE[N,H,W,3], MASK[N,H,W])，float32 / CPU。"""
    images = []
    masks = []
    for frame in frames:
        rgb = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255.0
        images.append(torch.from_numpy(rgb))
        if frame.mode == "RGBA":
            alpha = np.asarray(frame.getchannel("A"), dtype=np.float32) / 255.0
            masks.append(torch.from_numpy(1.0 - alpha))
        else:
            masks.append(torch.zeros((frame.height, frame.width), dtype=torch.float32))
    image = torch.stack(images, dim=0)
    mask = torch.stack(masks, dim=0)
    return image, mask


def _frames_from_system_clipboard() -> List[Image.Image]:
    """读取服务端本机系统剪贴板，返回帧列表；失败抛 RuntimeError。"""
    if not sys.platform.startswith("win"):
        raise RuntimeError(
            "当前系统（%s）不支持直接读取系统剪贴板，请在节点上按 Ctrl+V 粘贴图片。"
            % sys.platform
        )
    try:
        data = ImageGrab.grabclipboard()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "读取系统剪贴板失败：%s。请在节点上按 Ctrl+V 粘贴图片。" % exc
        ) from exc

    if isinstance(data, Image.Image):
        frames = decode_image_bytes(_encode_png_bytes(data))
        return frames

    if isinstance(data, list):
        # 剪贴板里是「复制的文件」，取第一个能读的图片文件
        for path in data:
            if not isinstance(path, str) or not os.path.isfile(path):
                continue
            try:
                with open(path, "rb") as fh:
                    return decode_image_bytes(fh.read())
            except Exception:  # noqa: BLE001
                continue
        raise RuntimeError(
            "系统剪贴板里是文件路径，但其中没有可读取的图片文件。"
        )

    if data is None:
        raise RuntimeError(
            "系统剪贴板里没有图片。请先复制一张图片，或在节点上按 Ctrl+V 粘贴。"
        )
    raise RuntimeError("系统剪贴板内容无法识别（%s）。" % type(data).__name__)


def _encode_png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# HTTP 路由：前端上传 / 预览 / 系统剪贴板
# ---------------------------------------------------------------------------
def _register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception as exc:  # noqa: BLE001
        LOG.warning("Cannot import aiohttp / PromptServer, clipboard upload routes unavailable: %s", exc)
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        LOG.warning("PromptServer is not initialized; skipped clipboard upload routes")
        return

    routes = instance.routes

    def _ok(**payload):
        return web.json_response(payload)

    def _err(message: str, status: int = 400):
        return web.json_response({"error": message}, status=status)

    @routes.post("/clipboard_image/store")
    async def clipboard_store(request):
        """接收前端上传的原始图片字节（不做任何落盘）。"""
        raw = await request.read()
        if not raw:
            return _err("上传内容为空", 400)
        if len(raw) > MAX_UPLOAD_BYTES:
            return _err(
                "图片过大（%.1f MB），上限 %.0f MB"
                % (len(raw) / 1048576.0, MAX_UPLOAD_BYTES / 1048576.0),
                413,
            )
        try:
            frames = decode_image_bytes(raw)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("Clipboard image decode failed: %s", exc)
            return _err("无法解码图片：%s" % exc, 415)
        key = STORE.put(frames)
        LOG.info(
            "Clipboard image cached key=%s %dx%d frames=%d (memory only, input/ untouched)",
            key,
            frames[0].width,
            frames[0].height,
            len(frames),
        )
        return _ok(
            key=key,
            width=frames[0].width,
            height=frames[0].height,
            frames=len(frames),
        )

    @routes.post("/clipboard_image/from_system_clipboard")
    async def clipboard_from_system(request):
        """直接读取服务端本机系统剪贴板（同机场景下零权限、零弹窗）。"""
        try:
            frames = _frames_from_system_clipboard()
        except RuntimeError as exc:
            return _err(str(exc), 400)
        key = STORE.put(frames)
        return _ok(
            key=key,
            width=frames[0].width,
            height=frames[0].height,
            frames=len(frames),
        )

    @routes.get("/clipboard_image/preview/{key}")
    async def clipboard_preview(request):
        key = request.match_info.get("key", "")
        data = STORE.thumbnail(key)
        if data is None:
            return _err("该图片已不在内存缓存中", 404)
        return web.Response(
            body=data,
            content_type="image/png",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @routes.get("/clipboard_image/info/{key}")
    async def clipboard_info(request):
        key = request.match_info.get("key", "")
        item = STORE.get(key)
        if item is None:
            return _ok(exists=False, key=key)
        return _ok(
            exists=True,
            key=key,
            width=item["width"],
            height=item["height"],
            frames=len(item["frames"]),
        )

    @routes.get("/clipboard_image/stats")
    async def clipboard_stats(request):
        return _ok(**STORE.stats())

    LOG.info("Clipboard routes registered: /clipboard_image/*")


try:
    _register_routes()
except Exception as exc:  # noqa: BLE001
    LOG.warning("Registering clipboard routes failed: %s", exc, exc_info=True)


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------
class ClipboardPasteImage:
    """把剪贴板图片变成 IMAGE/MASK，图片只存在内存里，不写 input 目录。"""

    CATEGORY = "image/input"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "load_clipboard_image"
    DESCRIPTION = (
        "在节点上按 Ctrl+V（或点节点按钮）把剪贴板图片直接贴进工作流。"
        "图片只保存在 ComfyUI 进程内存中，不会写入 input 目录。"
        "勾选 read_system_clipboard 可改为每次执行时直接读本机系统剪贴板。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 前端会把这个 widget 隐藏，只用来在 workflow 里保存内存 key
                "image_key": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "read_system_clipboard": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "直接读系统剪贴板",
                        "label_off": "用粘贴的图",
                    },
                ),
            },
        }

    @classmethod
    def IS_CHANGED(cls, image_key="", read_system_clipboard=False):
        # 系统剪贴板模式的结果和输入无关，必须每次执行都重跑，否则 ComfyUI 的
        # 执行缓存会让「换图后重新 Queue」拿到旧图。
        if read_system_clipboard:
            return float("nan")
        # 粘贴模式：key 是图片内容哈希，换了图自然重跑，同一张图则复用缓存。
        return image_key

    def load_clipboard_image(self, image_key="", read_system_clipboard=False):
        if read_system_clipboard:
            frames = _frames_from_system_clipboard()
            image_key = STORE.put(frames)
        else:
            key = (image_key or "").strip()
            item = STORE.get(key)
            if item is None:
                raise RuntimeError(
                    "ClipboardPasteImage：节点里还没有可用的图片。\n"
                    "· 选中本节点后按 Ctrl+V，或点击节点上的「粘贴剪贴板图片」按钮；\n"
                    "· 如果 workflow 是之前存的，ComfyUI 重启后内存缓存会清空，需要重新粘贴一次；\n"
                    "· 也可以勾选 read_system_clipboard，每次执行时直接读取本机系统剪贴板。"
                )
            frames = item["frames"]

        image, mask = image_to_tensors(frames)
        height, width = int(image.shape[1]), int(image.shape[2])
        LOG.debug("Clipboard node output %dx%d frames=%d", width, height, image.shape[0])
        return (image, mask, width, height)


NODE_CLASS_MAPPINGS = {
    "ClipboardPasteImage": ClipboardPasteImage,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ClipboardPasteImage": "粘贴剪贴板图片 (Clipboard Paste)",
}

# 前端扩展目录
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
