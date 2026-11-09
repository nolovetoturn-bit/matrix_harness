# rms-image-diff（通用插件）

对两张输入图片做**像素级比对**：定位差异像素、聚类出差异区域（连通域包围盒）、统计差异率，
并生成**差异热力图**。规约见 [`docs/dsh-plugin-spec.md`](../../../docs/dsh-plugin-spec.md)。

## 文件

| 文件 | 角色 |
|---|---|
| `plugin.mjs` | 可移植清单 + 编排（工具定义、参数、报告组装） |
| `lib/png.mjs` | 零依赖 PNG 解码 / 编码（`node:zlib` + 手写 chunk/CRC32/反滤波） |
| `lib/source.mjs` | 输入解析（路径 / data URL）、魔数识别、JPEG→PNG 系统桥接 |
| `lib/diff.mjs` | 逐像素比对、8 邻接连通域聚类、热力图栅格渲染 |
| `dsh/host.mjs` | dsh 适配器：注册 `diff_images`，并把内容块投影为 dsh 可承载的形状 |

## 工具（MCP 全名 `rms-image-diff__diff_images`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `image_a` / `image_b` | string | 必填 | 图片 A/B：文件路径，或 data URL（`data:image/png;base64,...`） |
| `tolerance` | integer 0–255 | `0` | 每通道允许的最大绝对色差；超过才记为差异。`0` 为严格逐像素相等 |
| `min_region_area` | integer | `0` | 差异区域最小像素数，低于该值的连通域被丢弃（去噪） |
| `max_regions` | integer | `200` | 报告中区域个数上限，按像素数降序截断 |
| `heatmap` | boolean | `true` | 是否生成差异热力图 PNG（两图一致时不生成） |
| `heatmap_path` | string | 临时目录 | 热力图保存路径，省略时写入 `<系统临时目录>/rms-image-diff/` |

返回：文本差异报告（判定、差异像素数与占比、最大色差、差异区域表）+ 热力图图片块。

### 比对口径

- **尺寸不一致**：从左上角对齐，裁剪到公共区域后比对，报告显式说明。
- **Alpha**：4 通道一起比较；**双方 alpha 均为 0 的像素视为相同**（此时 RGB 通常是无意义残留值）。
- **区域聚类**：差异像素掩膜上做 8 邻接连通域，输出包围盒 `x/y/宽/高/像素数/平均色差/最大色差`。

### 差异热力图

黑底；差异像素按色差强度从**蓝（弱）→ 红（强）**着色；区域数 ≤ 24 时描 1px 淡色包围框以标出区域。
分辨率与比对区域一致（不缩放）。

## 图片格式

| 格式 | 支持情况 |
|---|---|
| PNG | **原生零依赖解码**：颜色类型 0/2/3/4/6，位深 1/2/4/8/16（16 位取高字节）；**不支持交错(Adam7)**，遇到会返回明确报错 |
| JPEG | **尽力支持**：借系统图像转换器无损转 PNG 后再本地解码。Windows 用 `PowerShell + System.Drawing`，macOS 用 `sips`，Linux 需 ImageMagick（`magick`/`convert`）；均不可用时返回含安装提示的报错 |
| 其它 | 返回「无法识别的图片格式」报错 |

> JPEG 走系统桥接而非内置解码器，是为了不引入任何 npm 依赖、保持插件零依赖可移植。
> 有损格式在容差 `0` 下会把压缩噪声也计为差异，比对 JPEG 时建议设置 `tolerance`（如 8–16）。

## 接入与验证

dsh 侧由项目覆盖层 [`dsh/cordis.yml`](../../../dsh/cordis.yml) 登记；MCP 侧由 `mcp/server.mjs` 自动扫描。

```powershell
# dsh 冒烟（cwd 必须是 deepseek-harness/）
"" | pnpm dsh acp --patch "../dsh/cordis.yml"
#   期望日志： [rms-image-diff] plugin loaded (1 tools)

# MCP 平面（在仓库根目录执行）
node mcp/server.mjs
#   期望： tools/list 含 rms-image-diff__diff_images；
#          tools/call 返回 text + image(image/png) 两个内容块
```

### 两平面的图片块差异

- **MCP 平面**：`render` 返回 MCP 形状 `{ type: 'image', data: <base64>, mimeType: 'image/png' }`，客户端可直接渲染热力图。
- **dsh 平面**：harness 的 `ImageBlock` 需要 attachment 服务持有的引用，且生产适配器声明文本输出，
  因此 [`dsh/host.mjs`](dsh/host.mjs) 把图片块投影掉，只保留文本块；热力图仍会落盘，路径已写在文本报告里。
