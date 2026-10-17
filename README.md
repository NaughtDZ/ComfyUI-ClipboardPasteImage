# ComfyUI Clipboard Paste Image

> Paste an image straight from your clipboard into a ComfyUI workflow — no `input/` copy, no temp files, nothing written to disk.

把剪贴板里的图片直接贴进 ComfyUI 工作流。**图片只存在于 ComfyUI 进程内存里，不写入 `input/` 目录，也不产生任何临时文件。**

原生 `LoadImage` 要求图片先落到 `input/` 才会出现在下拉列表里；VideoHelperSuite 的路径加载节点又只认本地文件。这个节点把「截图 → 保存 → 找路径 → 上传」四步直接省掉：复制，选中节点，`Ctrl+V`，完事。

## 特性

- **四种贴图方式**：`Ctrl+V`、节点按钮、右键菜单、每次执行自动读系统剪贴板
- **零落盘**：解码、缓存、缩略图全在内存完成，`input/` 目录不会被写入任何文件
- **完整输出**：`IMAGE` + `MASK` + `width` + `height`，mask 规则和原生 `LoadImage` 一致（`1 - alpha`）
- **格式通吃**：PNG / JPEG / WebP / GIF / BMP；动图多帧当 batch；带 alpha 的 PNG 正确生成 mask
- **零额外依赖**：只用 ComfyUI 自带的 `Pillow` / `numpy` / `torch`，不需要 `pip install` 任何东西

## 安装

需要 ComfyUI 0.3x 及以上（测试环境 0.40.0 + 前端 1.55.17）。

**手动安装**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/NaughtDZ/ComfyUI-ClipboardPasteImage.git
```

重启 ComfyUI。

**ComfyUI Manager**

在 Manager 里搜索 `Clipboard Paste` 安装，或直接把这个目录丢进 `custom_nodes/`。

装好后节点出现在 **image/input → 粘贴剪贴板图片 (Clipboard Paste)**，也可以在节点搜索里搜 `clipboard`。

## 用法

| 方式 | 操作 | 说明 |
| --- | --- | --- |
| **Ctrl+V**（推荐） | 选中节点，按 `Ctrl+V` | 走浏览器 `paste` 事件，不需要任何授权弹窗，最顺滑 |
| 节点按钮 | 点「📋 粘贴剪贴板图片」 | 先试浏览器 Clipboard API，失败自动退回本机系统剪贴板 |
| 右键菜单 | 右键节点 →「从系统剪贴板粘贴」 | 直接读服务端所在机器的系统剪贴板 |
| 自动模式 | 勾选 `read_system_clipboard` | 忽略粘贴内容，**每次执行**都重新读本机系统剪贴板 |

贴好后节点上会显示缩略图和尺寸。再贴一次会覆盖上一张（旧图留在内存池里，按 LRU 淘汰）。

### 自动模式：改图后直接 Queue

勾选 `read_system_clipboard` 后，节点每次执行时都调用 `PIL.ImageGrab.grabclipboard()` 读服务端本机的剪贴板。

这个模式通过 `IS_CHANGED` 返回 `nan`，**不受 ComfyUI 执行缓存影响**，因此「复制新图 → 重新 Queue」会真的取到新图，而不是缓存里的旧结果。

> 自动模式要求浏览器和服务端在同一台机器。通过局域网 / 远程访问 ComfyUI 时请用 `Ctrl+V`。

### 节点参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `image_key` | STRING | `""` | 内部使用。前端会把它隐藏，只用来在 workflow 里保存内存缓存的 key |
| `read_system_clipboard` | BOOLEAN | `false` | 勾选后忽略粘贴内容，每次执行读系统剪贴板 |

### 输出

| 输出 | 类型 | 说明 |
| --- | --- | --- |
| `image` | IMAGE | `[N, H, W, 3]`，float32，0–1；多帧图片（GIF/动图）作为 batch |
| `mask` | MASK | `[N, H, W]`；有 alpha 时取 `1 - alpha`（与原生 `LoadImage` 一致），否则全 0 |
| `width` | INT | 第一帧宽度 |
| `height` | INT | 第一帧高度 |

## 工作原理

```
浏览器                           ComfyUI 后端（内存）
────────                        ──────────────────────
Ctrl+V / paste 事件
  └─ File blob ──POST──────────▶ /clipboard_image/store
                                   └─ PIL 解码 → 内容哈希 → LRU 内存池
       ◀───── {key, w, h} ────────┘
  └─ 写入隐藏 widget image_key
  └─ GET /clipboard_image/preview/<key> ──▶ 现算缩略图，返回 PNG 字节
                                            （不读磁盘，不建临时文件）

执行 workflow
  └─ image_key ──▶ 从内存池取 PIL 帧 ──▶ torch tensor ──▶ IMAGE / MASK
```

几个刻意的设计：

- **key 是图片内容的 SHA-256 前缀**，同一张图反复贴只会占用一份内存，也让 workflow 的执行缓存在「同一张图」时正确命中。
- **不碰 `folder_paths`**，不调用 `/upload/image`（那条路由会写 `input/`）。
- **缩略图现算**，优先用缓存值，`Cache-Control: immutable`（key 是内容哈希，内容不会变）。

## HTTP API

节点注册了以下几个接口，都在同一端口下：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/clipboard_image/store` | 上传原始图片字节，返回 `{key, width, height, frames}` |
| `POST` | `/clipboard_image/from_system_clipboard` | 读取服务端系统剪贴板并缓存 |
| `GET` | `/clipboard_image/preview/<key>` | 缩略图 PNG |
| `GET` | `/clipboard_image/info/<key>` | 该 key 是否还在内存中 |
| `GET` | `/clipboard_image/stats` | 缓存条数与占用字节 |

`/store` 收的是 request body 原始字节，不是 multipart，所以可以直接：

```bash
curl -X POST --data-binary @shot.png -H "Content-Type: image/png" \
     http://127.0.0.1:8188/clipboard_image/store
```

## 配置

容量和上限都写在 `__init__.py` 顶部：

```python
MAX_ITEMS = 32                       # 内存里最多保留几张
MAX_TOTAL_BYTES = 512 * 1024 * 1024  # 最多占用约 512 MB（按像素字节估算）
MAX_UPLOAD_BYTES = 128 * 1024 * 1024 # 单次上传上限
THUMB_MAX_SIDE = 640                 # 节点缩略图最长边
```

## FAQ

**Q：重启 ComfyUI 后打开旧 workflow，提示「缓存已失效」？**

内存缓存不持久，重启即清空。重新粘贴一次即可。这是「不落盘」的必然代价——如果你希望图片能长期跟着 workflow 走，那就得用会写 `input/` 的原生节点。

**Q：为什么不做成「上传到 input 目录再加载」？**

那正是这个节点要避开的事。上传会污染 `input/`、留下无法自动清理的垃圾文件、也让 workflow 换机器后指向不存在的文件。

**Q：通过局域网 / 手机访问 ComfyUI 能用吗？**

`Ctrl+V` 和节点按钮（浏览器剪贴板通道）可以，读的是你当前设备的剪贴板。`read_system_clipboard` 自动模式读的是**服务端**机器的剪贴板，跨机器时不要用。

**Q：Nodes 2.0（Vue 节点渲染）下能预览吗？**

能。预览用的是 **DOM widget**（`addDOMWidget`），不是 canvas 绘制，所以经典渲染和 Nodes 2.0 下都能显示图片和尺寸。

早期版本用 `onDrawBackground` 在 canvas 上画缩略图，打开 Nodes 2.0 后该钩子不再被调用，于是看不到预览——现在已改为 DOM widget 优先，只有不支持 `addDOMWidget` 的老前端才退回 canvas。

**Q：能保存成文件吗？**

接原生的 `SaveImage` / `PreviewImage` 就行。这个节点只负责「把剪贴板变成 IMAGE」，落盘交给专门的节点。

## 兼容性

- ComfyUI 0.3x+（开发验证于 0.40.0，前端 `comfyui-frontend-package` 1.55.17）
- Python 3.10+ / Windows、Linux、macOS
  - 浏览器剪贴板通道（`Ctrl+V`、按钮）全平台可用
  - 系统剪贴板通道（右键菜单、`read_system_clipboard`）依赖 `PIL.ImageGrab`，目前仅 Windows

## License

[MIT](LICENSE)
