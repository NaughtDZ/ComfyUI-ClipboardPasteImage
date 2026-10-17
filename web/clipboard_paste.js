// ComfyUI 剪贴板图片节点 —— 前端扩展
//
// 交互：
//   · 选中节点后按 Ctrl+V（推荐，无权限弹窗）
//   · 点节点上的「粘贴剪贴板图片」按钮（先试浏览器剪贴板，再退回本机系统剪贴板）
//   · 右键菜单 → 从系统剪贴板粘贴
//
// 图片经 /clipboard_image/store 上传到后端内存，只回一个 key，
// 不会写进 ComfyUI 的 input 目录。
//
// 预览优先用 DOM widget（addDOMWidget）：Nodes 2.0 / Vue 节点渲染下
// onDrawBackground 不会被调用，只有 DOM 元素才显示得出来。没有
// addDOMWidget 的旧前端才退回 canvas 绘制。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ClipboardPasteImage";
const EXT_NAME = "ClipboardPaste.Image";
const API_BASE = "/clipboard_image";

const MIN_WIDTH = 340;
const MIN_HEIGHT = 460;
const PREVIEW_HEIGHT = 240;

const HINT_EMPTY = "在节点上按 Ctrl+V 粘贴图片";
const HINT_BROKEN = "缓存已失效（ComfyUI 重启会清空内存），请重新粘贴";

function apiUrl(path) {
  return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

function toast(severity, summary, detail) {
  const manager = app?.extensionManager?.toast;
  if (manager?.add) {
    manager.add({ severity, summary, detail, life: 6000 });
    return;
  }
  if (typeof app?.ui?.dialog?.show === "function") {
    app.ui.dialog.show(`${summary}\n${detail || ""}`.trim());
    return;
  }
  console.warn("[ClipboardPaste]", summary, detail);
}

function stateOf(node) {
  if (!node.__clipboardPaste) {
    node.__clipboardPaste = {
      keyWidget: null,
      button: null,
      domWidget: null,
      domImg: null,
      domHint: null,
      domMeta: null,
      key: "",
      img: null,
      w: 0,
      h: 0,
      status: "",
      broken: false,
      busy: false,
    };
  }
  return node.__clipboardPaste;
}

function redraw(node) {
  // DOM 预览跟 canvas 无关；只有旧前端的 canvas fallback 需要它
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------------------
// 预览：DOM widget 优先，canvas 兜底
// ---------------------------------------------------------------------------
function ensurePreviewWidget(node) {
  const st = stateOf(node);
  if (st.domWidget) return st.domWidget;
  if (typeof node.addDOMWidget !== "function") return null;

  const wrap = document.createElement("div");
  wrap.style.cssText = [
    "position:relative",
    "width:100%",
    "height:100%",
    "box-sizing:border-box",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "overflow:hidden",
    "border-radius:6px",
    "background:#1e1e1e",
  ].join(";");

  const img = document.createElement("img");
  img.alt = "";
  img.style.cssText =
    "max-width:100%;max-height:100%;object-fit:contain;display:none;pointer-events:none;";
  wrap.appendChild(img);

  const hint = document.createElement("span");
  hint.textContent = HINT_EMPTY;
  hint.style.cssText = [
    "position:absolute",
    "padding:0 12px",
    "text-align:center",
    "font:12px system-ui,-apple-system,sans-serif",
    "color:#7a7a7a",
    "pointer-events:none",
  ].join(";");
  wrap.appendChild(hint);

  const meta = document.createElement("span");
  meta.style.cssText = [
    "position:absolute",
    "left:8px",
    "bottom:4px",
    "font:11px system-ui,-apple-system,sans-serif",
    "color:#8ab4c9",
    "pointer-events:none",
  ].join(";");
  wrap.appendChild(meta);

  let widget = null;
  try {
    widget = node.addDOMWidget("clipboard_preview", "div", wrap, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => {},
      getMinHeight: () => PREVIEW_HEIGHT,
      getMaxHeight: () => PREVIEW_HEIGHT,
    });
  } catch (e) {
    console.warn("[ClipboardPaste] addDOMWidget 失败，退回 canvas 绘制:", e);
    return null;
  }
  if (!widget) return null;

  widget.serialize = false;
  widget.computeSize = (width) => [width, PREVIEW_HEIGHT];
  widget.computedHeight = PREVIEW_HEIGHT;
  wrap.style.minHeight = `${PREVIEW_HEIGHT - 8}px`;

  st.domWidget = widget;
  st.domImg = img;
  st.domHint = hint;
  st.domMeta = meta;
  return widget;
}

function syncPreview(node) {
  const st = stateOf(node);
  if (st.domImg && st.domHint) {
    if (st.img && st.img.src) {
      if (st.domImg.getAttribute("src") !== st.img.src) {
        st.domImg.src = st.img.src;
      }
      st.domImg.style.display = "block";
      st.domHint.style.display = "none";
    } else {
      st.domImg.style.display = "none";
      st.domHint.style.display = "block";
      st.domHint.textContent = st.status || HINT_EMPTY;
      st.domHint.style.color = st.broken ? "#d08d4a" : "#7a7a7a";
    }
  }
  if (st.domMeta) {
    st.domMeta.textContent = st.w ? `${st.w} × ${st.h} · 仅存内存，不写 input` : "";
  }
  redraw(node);
}

function loadPreview(node, key) {
  const st = stateOf(node);
  st.img = null;
  st.broken = false;

  if (!key) {
    st.status = HINT_EMPTY;
    syncPreview(node);
    return;
  }

  const img = new Image();
  img.onload = () => {
    st.img = img;
    st.w = img.naturalWidth;
    st.h = img.naturalHeight;
    st.status = "";
    st.broken = false;
    syncPreview(node);
  };
  img.onerror = () => {
    st.img = null;
    st.broken = true;
    st.status = HINT_BROKEN;
    syncPreview(node);
  };
  img.src = apiUrl(`${API_BASE}/preview/${encodeURIComponent(key)}`);
}

function applyResult(node, data) {
  const st = stateOf(node);
  st.key = data.key;
  st.w = data.width;
  st.h = data.height;
  st.broken = false;
  st.status = "";
  if (st.keyWidget) {
    st.keyWidget.value = data.key;
  }
  if (st.button) {
    st.button.name = `📋 ${data.width}×${data.height}（再点重新粘贴）`;
  }
  loadPreview(node, data.key);
  redraw(node);
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------
async function uploadBlob(blob) {
  const resp = await api.fetchApi(`${API_BASE}/store`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }
  if (!resp.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data;
}

async function readBrowserClipboard() {
  if (!navigator.clipboard?.read) {
    throw new Error("浏览器不支持读取剪贴板");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = (item.types || []).find((t) => t.startsWith("image/"));
    if (type) {
      return await item.getType(type);
    }
  }
  throw new Error("浏览器剪贴板里没有图片");
}

async function grabServerClipboard() {
  const resp = await api.fetchApi(`${API_BASE}/from_system_clipboard`, { method: "POST" });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = null;
  }
  if (!resp.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data;
}

async function storeBlob(node, blob) {
  const st = stateOf(node);
  if (st.busy) return;
  st.busy = true;
  st.status = "上传中…";
  st.broken = false;
  syncPreview(node);
  try {
    applyResult(node, await uploadBlob(blob));
  } catch (e) {
    st.status = `上传失败：${e?.message || e}`;
    st.broken = true;
    syncPreview(node);
    toast("error", "粘贴剪贴板图片失败", String(e?.message || e));
  } finally {
    st.busy = false;
  }
}

async function pasteFromButton(node) {
  const st = stateOf(node);
  if (st.busy) return;
  st.busy = true;
  st.status = "读取剪贴板…";
  st.broken = false;
  syncPreview(node);
  try {
    let blob = null;
    let browserError = null;
    try {
      blob = await readBrowserClipboard();
    } catch (e) {
      browserError = e;
    }
    if (blob) {
      applyResult(node, await uploadBlob(blob));
      return;
    }
    // 浏览器通道不可用时退回服务端系统剪贴板（同机场景零权限、零弹窗）
    try {
      applyResult(node, await grabServerClipboard());
    } catch (e) {
      throw new Error(e?.message || browserError?.message || "读取剪贴板失败");
    }
  } catch (e) {
    st.status = `粘贴失败：${e?.message || e}`;
    st.broken = true;
    syncPreview(node);
    toast("error", "粘贴剪贴板图片失败", String(e?.message || e));
  } finally {
    st.busy = false;
  }
}

// ---------------------------------------------------------------------------
// 节点初始化 / 恢复
// ---------------------------------------------------------------------------
function setupNode(node) {
  const st = stateOf(node);

  const keyWidget = (node.widgets || []).find((w) => w.name === "image_key");
  if (keyWidget) {
    st.keyWidget = keyWidget;
    // 隐藏但保留序列化：key 会随 workflow 保存，也会进入 prompt inputs
    keyWidget.type = "hidden";
    keyWidget.hidden = true;
    keyWidget.computeSize = () => [0, -4];
  }

  st.button = node.addWidget("button", "📋 粘贴剪贴板图片 (Ctrl+V)", null, () => {
    pasteFromButton(node);
  });

  ensurePreviewWidget(node);

  const width = Math.max(node.size[0], MIN_WIDTH);
  const height = Math.max(node.size[1], MIN_HEIGHT);
  node.setSize([width, height]);
  syncPreview(node);
}

function restoreFromWorkflow(node) {
  const st = stateOf(node);
  const key = (st.keyWidget?.value || "").trim();
  if (!key) {
    st.status = HINT_EMPTY;
    syncPreview(node);
    return;
  }
  st.key = key;
  loadPreview(node, key);
}

// ---------------------------------------------------------------------------
// canvas 兜底（只有旧前端、没有 addDOMWidget 时才会画）
// ---------------------------------------------------------------------------
function widgetBottom(node) {
  let y = typeof node.widgets_start_y === "number" ? node.widgets_start_y : 30;
  for (const w of node.widgets || []) {
    if (w.type === "hidden" || w.last_y == null || !w.size) continue;
    y = Math.max(y, w.last_y + (w.size[1] ?? 20));
  }
  return y;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPreview(node, ctx) {
  const st = node.__clipboardPaste;
  if (!st || st.domWidget || node.flags?.collapsed) return;

  const margin = 10;
  const top = widgetBottom(node) + 6;
  const availW = node.size[0] - margin * 2;
  const availH = node.size[1] - top - margin - 18;
  if (availW < 40 || availH < 40) return;

  ctx.save();

  ctx.fillStyle = "#1e1e1e";
  roundRect(ctx, margin, top, availW, availH, 6);
  ctx.fill();
  ctx.strokeStyle = st.broken ? "#a0622a" : "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (st.img && st.img.naturalWidth > 0) {
    const iw = st.img.naturalWidth;
    const ih = st.img.naturalHeight;
    const scale = Math.min(availW / iw, availH / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(st.img, margin + (availW - dw) / 2, top + (availH - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = st.broken ? "#d08d4a" : "#7a7a7a";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      st.status || HINT_EMPTY,
      margin + availW / 2,
      top + availH / 2,
      availW - 12,
    );
  }

  const footY = node.size[1] - margin - 4;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "11px sans-serif";
  ctx.fillStyle = st.w ? "#8ab4c9" : "#6a6a6a";
  const foot = st.w
    ? `${st.w} × ${st.h} · 仅存内存，不写 input`
    : "图片只存内存，不写入 input 目录";
  ctx.fillText(foot, margin, footY, availW);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ctrl+V 全局粘贴
// ---------------------------------------------------------------------------
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}

function pasteTargets() {
  const targets = [];
  const selected = app.canvas?.selected_nodes || {};
  for (const id of Object.keys(selected)) {
    const node = selected[id];
    if (node && node.type === NODE_NAME) targets.push(node);
  }
  if (targets.length) return targets;

  const hovered = app.canvas?.node_over;
  if (hovered && hovered.type === NODE_NAME) return [hovered];
  return [];
}

function onPaste(event) {
  if (isEditableTarget(event.target)) return;
  const data = event.clipboardData;
  if (!data || !data.items) return;

  let blob = null;
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (item.kind === "file" && (item.type || "").startsWith("image/")) {
      blob = item.getAsFile();
      if (blob) break;
    }
  }
  if (!blob) return;

  const targets = pasteTargets();
  if (!targets.length) return;

  event.preventDefault();
  event.stopPropagation();
  for (const node of targets) storeBlob(node, blob);
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------
app.registerExtension({
  name: EXT_NAME,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      // widget 值由 LiteGraph 在 configure 后写入，等一帧再读
      setTimeout(() => restoreFromWorkflow(this), 0);
      return result;
    };

    const onDrawBackground = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function (ctx) {
      onDrawBackground?.apply(this, arguments);
      drawPreview(this, ctx);
    };

    const onGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      onGetExtraMenuOptions?.apply(this, arguments);
      const self = this;
      options.push({
        content: "从系统剪贴板粘贴",
        callback: () => {
          const st = stateOf(self);
          st.busy = true;
          st.status = "读取系统剪贴板…";
          st.broken = false;
          syncPreview(self);
          grabServerClipboard()
            .then((data) => applyResult(self, data))
            .catch((e) => {
              st.status = `读取失败：${e?.message || e}`;
              st.broken = true;
              syncPreview(self);
              toast("error", "读取系统剪贴板失败", String(e?.message || e));
            })
            .finally(() => {
              st.busy = false;
            });
        },
      });
    };
  },

  setup() {
    document.addEventListener("paste", onPaste, true);
  },
});
