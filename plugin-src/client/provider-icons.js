/**
 * 各 provider 面板图标的**纯数据模块**（每个渠道一条 base64 / SVG data URI，
 * 条数 = `src/provider-registry.ts` 的 id 数，故**不在此写死数字**）。
 *
 * ## 为什么单独成文件（而不是留在 `jet-hub.js` 里）
 *
 * 本仓库的 `node_modules` 里**没有 react**（`react` 只在 `build.mjs` 的 `external`
 * 里、由宿主注入），故 `jet-hub.js` **不做任何处理时 import 不进来**（报
 * `Cannot find package 'react'`）。而「新增 provider 忘记加图标」必须能被单测抓住
 * —— 于是把图标与 `PROVIDER_ICONS` 表抽成这个**无 React 依赖**的纯模块，
 * `provider-registry.spec.ts` 才能直接 import 它做**行为断言**（而不是退回
 * 「正则扫源码文本」那种本 Task 正要消除的形态）。
 *
 * ⚠️ **但「import 不了」不能说绝对**（2026-10-08 复审修正）：用
 * `vi.mock('react', …)` 注入一个最小 React 替身后，`jet-hub.js` 是**可以**
 * import 并真正渲染的 —— `tests/unit/jet-hub-tdz.spec.ts` 就是这么做的
 * （它靠这一点在无 react / 无 DOM 的环境里拦住了 TDZ 白屏回归）。
 * 本模块存在的理由不是「做不到」，而是「**不想让每条图标断言都背上一个
 * React 替身**」：纯数据模块的断言更直接，也不会因替身缺 hook 而假失败。
 *
 * ⚠️ 这与本仓库既有的 `aggregate-panel-logic.js` / `badge-model.js` /
 * `new-account.js` 同款：**为可单测而从 `jet-hub.js` 拆出的纯逻辑模块**。
 *
 * ## 为什么不搬进 `src/provider-registry.ts`
 *
 * 宿主侧（Node）**从不使用图标**，搬过去会让 `lib/index.js` 白白背上这几十 KB
 * 的字面量。故 registry 只持有 `logoClass`，图标留在这里，并由
 * `provider-registry.spec.ts` 的「两边 id 集合相等」断言锁住同步。
 */

// 内联图标 base64
const CODEARTS_ICON = 'data:image/png;base64,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'
/**
 * LobsterAI 面板图标（内联 SVG data URL）。
 *
 * 用 SVG 而非 base64 PNG：现有三个图标是逆向客户端资源得到的 PNG，
 * 而 LobsterAI 没有可取的官方小图标 —— 内联 SVG 体积小、无色差，
 * 且在 `jet-hub-styles.js` 的 `.dim-jh-providerIcon` 白底容器里显示清晰。
 *
 * 内容是**预先算好的 base64 字面量**，不用 `btoa()` 运行时拼接：
 * 该 bundle 由 esbuild 打包，目标环境未必提供 `btoa`（Node 有、但
 * 客户端 bundle 的运行时按 web 平台配置），字面量最稳妥。
 */
const LOBSTERAI_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjZTg1MDNhIi8+PHBhdGggZD0iTTEyIDUuNWMtMi40IDAtNC4yIDEuNi00LjIgNHY1LjJjMCAyLjMgMS44IDMuOCA0LjIgMy44czQuMi0xLjUgNC4yLTMuOFY5LjVjMC0yLjQtMS44LTQtNC4yLTR6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAuMyIgY3k9IjEwLjIiIHI9IjEiIGZpbGw9IiNlODUwM2EiLz48Y2lyY2xlIGN4PSIxMy43IiBjeT0iMTAuMiIgcj0iMSIgZmlsbD0iI2U4NTAzYSIvPjxwYXRoIGQ9Ik04LjQgNy4yIDYuMiA0LjltOS40IDIuMyAyLjItMi4zTTkuOSAxOC41bC0xLjQgMm02LjYtMiAxLjQgMiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+PC9zdmc+'

/**
 * Qoder 面板图标（内联 SVG data URL）。
 *
 * 与 LobsterAI 同因用 SVG 而非 base64 PNG：Qoder 没有可取的小图标资源，
 * 内联 SVG 体积小、无色差，且在 `.dim-jh-providerIcon` 白底容器里显示清晰。
 *
 * 内容是**预先算好的 base64 字面量**，不用 `btoa()` 运行时拼接：
 * 该 bundle 由 esbuild 打包，目标环境未必提供 `btoa`。
 *
 * 图形：深色圆角方块 + 白色「Q」字形（圆环加右下角笔尾），呼应 Qoder 品牌。
 */
const QODER_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjMWYyYTNmIi8+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNC42IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44Ii8+PHBhdGggZD0iTTEzLjkgMTMuOSAxNyAxN2EwLjk1IDAuOTUgMCAwIDEtMS4zNSAxLjM1bC0zLjEtMy4xIiBmaWxsPSIjZmZmIi8+PC9zdmc+'

/**
 * Qoder **中国版**面板图标：内联 base64 PNG。
 *
 * ⚠️ **从官方安装目录提取，不凭印象重绘**（Cline 那次报障的教训：
 * 「我们用的图标和官方的好像不一样」）。
 *
 * 来源：`%LOCALAPPDATA%\Programs\Qoder CN\resources\app-icon.ico` 的
 * **256×256 PNG 帧**，面积平均缩到 48×48 后内联（容器实际显示 20×20）。
 *
 * 提取脚本：`scripts/extract-qodercn-icon.mjs`（可复现、无第三方依赖，
 * 复用 `extract-cline-icon.mjs` 的 PNG 解码/缩放）。
 *
 * ⚠️ **与国际版不是同一个图标**，所以不能复用 `QODER_ICON`：实测两站
 * `app-icon.ico` 的 256 帧 SHA256 分别为 `d9ab00eb…`（CN）与
 * `5022fe91…`（国际版）。两个面板在列表里挨着渲染，同图标会让用户
 * 分不清点的是哪个。
 *
 * 与国际版那条注释不同（它说「Qoder 没有可取的小图标资源」因而手绘 SVG）：
 * 中国版**有**官方 ICO，故这里走位图提取而非重绘。
 */
const QODERCN_ICON = 'data:image/png;base64,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'

/**
 * TRAE 面板图标（内联 SVG data URI，还原自官方标志）。
 *
 * TRAE 的官方标志是**纯色平涂**图形：亮绿色（`#32F08C`）的「错位方框 + 两枚菱形」。
 * 素材为用户提供的 Trae 官方 CDN 图（512×512 调色板 PNG，黑底不透明）。
 * 这里不是直接内联那张 PNG，而是**逐像素实测几何后重绘为 SVG**，理由有三：
 *
 * 1. 官方 PNG 是**黑底不透明**的（调色板仅含 `#000000` 与各级绿色），
 *    直接放进 `.dim-jh-providerIcon` 的白底容器里会显示成一块黑方块；
 * 2. 原图实为单色 alpha 蒙版 —— 每级绿都是 `#32F08C` 与黑的线性混合
 *    （实测 `#197846`≈50%、`#1F9658`≈63%、`#2CD27B`≈87.5%），
 *    因此几何形状可被精确还原，无需保留位图；
 * 3. SVG 体积约为同尺寸 PNG 的 1/3，且任意 DPI 下都清晰。
 *
 * 几何提取方式（扫描线实测原图 512×512 坐标）：
 * - 外框实心区 `58..453 × 116..395`；
 * - 左下缺角 `58..115 × 340..395`（这就是「错位」的来源：底部横条左端内缩）；
 * - 中央留空 `115..396 × 172..340`（用 `fill-rule="evenodd"` 挖出）；
 * - 两枚菱形中心 `(215.5, 254.5)` 与 `(329, 254.5)`，曼哈顿半径 39。
 *
 * 按上述模型做全图像素比对，与原图吻合率 **99.775%**
 * （不一致仅 591/262144 个抗锯齿边缘像素）。viewBox 取 `38 38 435 435`
 * 使图形带均匀留白并居中。
 *
 * 用 SVG 而非 base64 PNG 与 LobsterAI 图标的做法一致；内容是**预先算好的
 * base64 字面量**，不用 `btoa()` 运行时拼接 —— 该 bundle 由 esbuild 打包，
 * 目标环境未必提供 `btoa`，字面量最稳妥。
 */
const TRAE_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjM4IDM4IDQzNSA0MzUiIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCI+PHBhdGggZmlsbD0iIzMyRjA4QyIgZmlsbC1ydWxlPSJldmVub2RkIiBkPSJNNTggMTE2aDM5NXYyNzlIMTE1di01NUg1OHpNMTE1IDE3MmgyODF2MTY4SDExNXoiLz48cGF0aCBmaWxsPSIjMzJGMDhDIiBkPSJNMjE1LjUgMjE1LjVsMzkgMzktMzkgMzktMzktMzl6TTMyOSAyMTUuNWwzOSAzOS0zOSAzOS0zOS0zOXoiLz48L3N2Zz4='

/**
 * Cline 面板图标（内联 base64 PNG，**取自官方安装目录**）。
 *
 * ## ⚠️ 不要手工臆造这个图标
 *
 * **真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。
 * 初版按印象画了一个「C 形弧线」的 SVG，与 Cline 的真实标志完全不符 ——
 * 真实标志是**顶部带凸起的圆角方块 + 中间两条竖线 + 左右两侧尖角**。
 *
 * 教训：品牌图标**必须从官方资源提取**，不能凭印象重绘。
 * 提取脚本：`scripts/extract-cline-icon.mjs`（可复现，无第三方依赖）。
 *
 * ## 来源与主题
 *
 * 源文件 `%LOCALAPPDATA%\Cline\icons\app\macos\classic.png`（官方 1024×1024，
 * 32bpp ARGB 带透明圆角），脚本面积平均缩放至 **48×48** 后内联
 * （容器实际显示 20×20，48 可覆盖 2.4× DPI）。
 *
 * 官方提供四套主题，这里选 **classic（品牌紫 `#7271E5` + 白色标记）**：
 *
 * | 主题 | 为什么不用 |
 * |---|---|
 * | `midnight`（近黑底，**exe 内嵌的默认图标**） | 与 Qoder 图标的深蓝黑 `#1f2a3f` 在 20×20 下几乎无法区分，列表里会混淆 |
 * | `chip`（绿色电路板） | 20×20 下电路板纹理退化成噪点 |
 * | `hologram`（浅色全息） | 白底容器里对比度不足 |
 *
 * 另：紫色在当前 7 个 provider 图标里未被占用，白底容器中辨识度最高。
 *
 * ⚠️ 与 LobsterAI / Qoder / TRAE 的**内联 SVG**不同源，但与
 * CodeArts 等渠道的**内联 base64 PNG** 做法一致
 * —— 本项目两种形态并存，都是「预先算好的 base64 字面量」，
 * 不用 `btoa()` 运行时拼接（该 bundle 由 esbuild 打包，目标环境未必提供 `btoa`）。
 */
const CLINE_ICON = 'data:image/png;base64,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'

/**
 * Loomy（讯飞）面板图标：内联 SVG data URL（蓝底白字 L）。
 *
 * 与 LobsterAI / Qoder / TRAE 的 SVG 做法一致（体积小、无色差、
 * 在白底容器 `.dim-jh-providerIcon` 里显示清晰）。
 */
const LOOMY_ICON = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" rx="6" fill="%23007aff"/%3E%3Ctext x="12" y="17.5" font-size="15" font-family="sans-serif" font-weight="700" fill="white" text-anchor="middle"%3EL%3C/text%3E%3C/svg%3E';

/**
 * Raccoon Work（商汤小浣熊）面板图标：内联 base64 PNG。
 *
 * ⚠️ **从官方安装目录提取，不凭印象重绘**（与 Cline 那次的教训一致：
 * 早期手绘的图标与官方标志不符，用户报障「我们用的图标和 cline 的好像不一样」）。
 *
 * 来源：`C:\Program Files\raccoon-ai\resources\assets\icon.png`（1024×1024 官方图标）。
 * ⚠️ **不用 exe 内嵌图标**：实测只有 32×32（`ExtractAssociatedIcon` 与
 * `new Icon(exe, 64, 64)` 都拿不到更大尺寸），缩到 20×20 会糊。
 *
 * 提取脚本：`scripts/extract-raccoon-icon.mjs`（可复现，无第三方依赖，
 * 复用 `extract-cline-icon.mjs` 的 PNG 解码/缩放）。
 * 品牌主色 `#8E6BF2`（见客户端 `resources/config/branding.json` 的 primaryColor），
 * 在白底容器 `.dim-jh-providerIcon` 中显示清晰。
 */
const RACCOON_ICON = 'data:image/png;base64,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';

/**
 * MiniMax Code 官方 logo（**中国版与国际版共用**）。
 *
 * ⚠️ **提取自官方产物，不是手绘**（既有教训：手绘的 Cline 图标与官方不符，
 * 用户报障）。来源：客户端 asar 内的 `out/_next/static/media/loginLogo.<hash>.svg`。
 * 提取脚本：`scripts/extract-minimax-dir.mjs`（可复现，无第三方依赖）：
 *   node scripts/extract-minimax-dir.mjs "out/_next/static/media" ".minimax-forensics/media"
 * 提取到的是**明文 SVG**，此处按其原始字节做 base64（与既有 SVG 图标
 * `LOBSTERAI_ICON` / `QODER_ICON` / `TRAE_ICON` 同款编码）。
 *
 * 官方 logo 自带浅蓝底 `#7DC6FF`（80×80、圆角 20），故容器背景保持 white
 * 也能正确显示（见 jet-hub-styles.js 的 `.dim-jh-providerIcon.minimax`）。
 *
 * ⚠️ **`minimax` 与 `minimaxintl` 共用本常量**（2026-10-15 加国际站时）：
 * 两站是**同一个产品**，品牌 logo 相同。不复制一份 base64 —— 那会让 bundle
 * 白白背上约 4 KB，且将来改图标必然只改一处（经典的「同一事实两份抄写」）。
 */
const MINIMAX_ICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzQ3XzY0MDUpIj4KPHJlY3Qgd2lkdGg9IjgwIiBoZWlnaHQ9IjgwIiBmaWxsPSIjN0RDNkZGIiBzdHlsZT0iZmlsbDojN0RDNkZGO2ZpbGw6Y29sb3IoZGlzcGxheS1wMyAwLjQ5MDIgMC43NzY1IDEuMDAwMCk7ZmlsbC1vcGFjaXR5OjE7Ii8+CjxwYXRoIGQ9Ik02Ni45NTc1IDUwLjY1NTZDNjYuOTU3NSA1MS43MDYgNjYuNDg1NSA1Mi43MDA4IDY1LjY3MTkgNTMuMzY1MUw1Ni4wMDgzIDYxLjI1NTZDNTUuMzgzOCA2MS43NjU1IDU0LjYwMjMgNjIuMDQ0IDUzLjc5NiA2Mi4wNDRIMTcuMTExOEMxNS4zMDA3IDYyLjA0NCAxMy44MzI1IDYwLjU3NTggMTMuODMyNSA1OC43NjQ3VjMxLjEwNzZDMTMuODMyNSAzMC4wNTQ3IDE0LjMwNjggMjkuMDU3OSAxNS4xMjM3IDI4LjM5MzZMMjUuODc2MyAxOS42NTAzQzI2LjUgMTkuMTQzMiAyNy4yNzkzIDE4Ljg2NjMgMjguMDgzMiAxOC44NjYzSDYzLjY3ODJDNjUuNDg5MyAxOC44NjYzIDY2Ljk1NzUgMjAuMzM0NSA2Ni45NTc1IDIyLjE0NTZWNTAuNjU1NloiIGZpbGw9ImJsYWNrIiBzdHlsZT0iZmlsbDpibGFjaztmaWxsLW9wYWNpdHk6MTsiLz4KPHBhdGggZD0iTTYwLjM5ODQgNDguMzY4NEM2MC4zOTg0IDQ4Ljg5NDYgNjAuMTYxNCA0OS4zOTI4IDU5Ljc1MzMgNDkuNzI1TDUzLjE3NDIgNTUuMDc4NUM1Mi44NjIzIDU1LjMzMjMgNTIuNDcyNCA1NS40NzA5IDUyLjA3MDMgNTUuNDcwOUgyMS41MzVDMjAuOTMxMyA1NS40NzA5IDIwLjQ0MTkgNTQuOTgxNSAyMC40NDE5IDU0LjM3NzhWMzMuMjYwMUMyMC40NDE5IDMyLjczMiAyMC42ODA1IDMyLjIzMjIgMjEuMDkxMSAzMS45MDAxTDI4LjYzNDcgMjUuNzk5OEMyOC45NDYyIDI1LjU0NzkgMjkuMzM0NyAyNS40MTA2IDI5LjczNTMgMjUuNDEwN0w1OS4zMDU4IDI1LjQyNDVDNTkuOTA5MyAyNS40MjQ3IDYwLjM5ODQgMjUuOTE0MSA2MC4zOTg0IDI2LjUxNzZWNDguMzY4NFoiIGZpbGw9IndoaXRlIiBzdHlsZT0iZmlsbDp3aGl0ZTtmaWxsLW9wYWNpdHk6MTsiLz4KPHBhdGggZD0iTTI2LjU1NDcgNDMuNjYxOUMyNi41NTQ3IDQyLjY5NTkgMjcuMzM3NyA0MS45MTI5IDI4LjMwMzcgNDEuOTEyOUgzMi40NTc1QzMzLjQyMzQgNDEuOTEyOSAzNC4yMDY0IDQyLjY5NTkgMzQuMjA2NCA0My42NjE5VjU2LjIzMjZIMjYuNTU0N1Y0My42NjE5WiIgZmlsbD0iYmxhY2siIHN0eWxlPSJmaWxsOmJsYWNrO2ZpbGwtb3BhY2l0eToxOyIvPgo8cGF0aCBkPSJNMzguMTQxOCA0My42NjE5QzM4LjE0MTggNDIuNjk1OSAzOC45MjQ5IDQxLjkxMjkgMzkuODkwOCA0MS45MTI5SDQ0LjA0NDZDNDUuMDEwNiA0MS45MTI5IDQ1Ljc5MzYgNDIuNjk1OSA0NS43OTM2IDQzLjY2MTlWNTYuMjMyNkgzOC4xNDE4VjQzLjY2MTlaIiBmaWxsPSJibGFjayIgc3R5bGU9ImZpbGw6YmxhY2s7ZmlsbC1vcGFjaXR5OjE7Ii8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNDdfNjQwNSI+CjxwYXRoIGQ9Ik0wIDIwQzAgOC45NTQzMSA4Ljk1NDMxIDAgMjAgMEg2MEM3MS4wNDU3IDAgODAgOC45NTQzMSA4MCAyMFY2MEM4MCA3MS4wNDU3IDcxLjA0NTcgODAgNjAgODBIMjBDOC45NTQzMSA4MCAwIDcxLjA0NTcgMCA2MFYyMFoiIGZpbGw9IndoaXRlIiBzdHlsZT0iZmlsbDp3aGl0ZTtmaWxsLW9wYWNpdHk6MTsiLz4KPC9jbGlwUGF0aD4KPC9kZWZzPgo8L3N2Zz4K'
/**
 * ZCode（智谱）面板图标。
 *
 * 32×32 PNG（深色圆角底 + 青色 "Z"），内联 data URI —— 与其余 provider
 * 的图标方式一致（bundle 里不放二进制资源文件）。
 *
 * ⚠️ 生成方式：纯 Node 手写 PNG（zlib deflate + CRC32），零第三方依赖。
 * 重新生成见 `.tmp-zcode/icon-gen.mjs`（不入库的本地工具）。
 */
const ZCODE_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgklEQVR42u3XsRGAIAyF4UxgYe0g7j+FpZtgRwN36stLAhruqP+v4ICIdNaybsViy92yCj+CeMW7CO94gwgFRMUrIgFTAPbzgPe/Aa5nAInTAGicAtDE1QBtXAVgxGEAeuIpAFYYArDj81xEoQDLd+A1ID8k3wTkXDDEaDbEcBo1nl/XXoK4yMqvMgAAAABJRU5ErkJggg==';

/**
 * ModelScope（魔搭）面板图标（内联 SVG data URL，手绘）。
 *
 * ⚠️ **本 fork 独有**的 provider（上游 rc.11 仍无 modelscope）。
 * 与 Qoder / LobsterAI / TRAE / OpenCode 同款做法：走内联 SVG（体积小、无色差）。
 * 图形：紫色圆角方块 + 白色 M 字形（ModelScope 首字母）。
 */
const MODELSCOPE_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzYyNEFGRiIvPjxwYXRoIGQ9Ik02IDE3VjdoMi42bDMuNCA1LjJMMTUuNCA3SDE4djEwaC0yLjR2LTZsLTMgNC42aC0uMmwtMy00LjZ2Nkg2eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==';

/**
 * OpenCode 面板图标（内联 SVG data URL，手绘）。
 *
 * ⚠️ 与 Qoder / LobsterAI / TRAE 同款做法：opencode 没有可取的小图标资源，
 * 走内联 SVG（体积小、无色差、20×20 下清晰）。
 * 图形：深色圆角方块 + 白色终端提示符（`>` 加下划线），呼应 CLI 形象。
 */
const OPENCODE_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzEyMTYxZCIvPjxwYXRoIGQ9Ik02LjUgOC41IDEwLjUgMTJsLTQgMy41IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44IiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48cGF0aCBkPSJNMTIuNSAxNmg1IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMS44IiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz4=';

/**
 * Gemini Code Assist 面板图标（内联 SVG data URL，手绘）。
 *
 * ⚠️ 与 Qoder / LobsterAI / TRAE / OpenCode 同款做法：Gemini 的官方星形
 * 标志没有可取的小尺寸位图资源，走内联 SVG（体积小、无色差、20×20 下清晰）。
 * 图形：蓝紫渐变四角星 + 右上小星（官方品牌色的近似，非逐像素复刻）。
 *
 * ⚠️ 必须自带图形与底色 —— 容器按 `logoClass: 'gemini'` 给**白底**
 *（见 `jet-hub-styles.js` 的 `.dim-jh-providerIcon.gemini`）。
 */
const GEMINI_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNDI4NUY0Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjOUI3MkNCIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZD0iTTEyIDJjLjQgMy45IDIuMSA2LjYgNiA4LTMuOSAxLjQtNS42IDQuMS02IDgtLjQtMy45LTIuMS02LjYtNi04IDMuOS0xLjQgNS42LTQuMSA2LThaIiBmaWxsPSJ1cmwoI2cpIi8+PHBhdGggZD0iTTE5LjUgMTRjLjIgMS43LjkgMi45IDIuNiAzLjUtMS43LjYtMi40IDEuOC0yLjYgMy41LS4yLTEuNy0uOS0yLjktMi42LTMuNSAxLjctLjYgMi40LTEuOCAyLjYtMy41WiIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==';

/** 聚合 provider 的图标（三个候选渠道汇聚到一个中心）。 */
const AGGREGATE_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iNSIgY3k9IjUiIHI9IjIuNiIgZmlsbD0iIzRGOERGNyIvPjxjaXJjbGUgY3g9IjUiIGN5PSIxOSIgcj0iMi42IiBmaWxsPSIjOUI3MkNCIi8+PGNpcmNsZSBjeD0iMTkiIGN5PSIxMiIgcj0iMi42IiBmaWxsPSIjNEY4REY3Ii8+PHBhdGggZD0iTTcgNi4yIDE2LjQgMTFNNyAxNy44IDE2LjQgMTMiIHN0cm9rZT0iIzlCNzJDQiIgc3Ryb2tlLXdpZHRoPSIxLjciIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEuNSIgZmlsbD0iIzlCNzJDQiIvPjwvc3ZnPg==';

/**
 * OfficeAce（华为 ModelArts MaaS）图标：红底 OA 字样。
 *
 * ⚠️ 与其余 icon 同款内联 SVG data URL（避免额外资源请求）。
 *    `.dim-jh-providerIcon.officeace` 的样式见 `jet-hub-styles.js`。
 */
const OFFICEACE_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiB4PSIyIiB5PSIyIiByeD0iNCIgZmlsbD0iI2M3MDAwMCIvPjx0ZXh0IHg9IjEyIiB5PSIxNS41IiBmb250LXNpemU9IjgiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPk9BPC90ZXh0Pjwvc3ZnPg==';

/**
 * Accio（阿里）面板图标（内联 SVG data URL，手绘）。
 *
 * ⚠️ 与 Qoder / LobsterAI / TRAE / OpenCode / Gemini 同款做法：没有可取的
 * 官方小尺寸位图资源，走内联 SVG（体积小、无色差、20×20 下清晰）。
 * 图形：品牌橙圆角方块 + 白色「A」字形（呼应 Accio 首字母）。
 *
 * ⚠️ **必须自带图形与底色** —— 容器按 `logoClass: 'accio'` 给**白底**
 *（见 `jet-hub-styles.js` 的 `.dim-jh-providerIcon.accio`）。
 *
 * 生成方式：纯 Node 拼 base64（`.tmp-accio/gen-icon.mjs`，不入库），
 * **不用 `btoa()`** —— 该 bundle 由 esbuild 打包，目标环境未必提供它。
 */
const ACCIO_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iI0ZGNkEwMCIvPjxwYXRoIGQ9Ik03LjQgMTcuMiAxMSA2LjhoMmwzLjYgMTAuNGgtMi4xbC0uNzItMi4yNEgxMC4ybC0uNzIgMi4yNEg3LjRaIiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTEwLjc0IDEzLjI2aDIuNTJMMTIgOS41bC0xLjI2IDMuNzZaIiBmaWxsPSIjRkY2QTAwIi8+PC9zdmc+';
/**
 * AStudio（讯飞 AstronStudio）图标：本仓库无法获得官方 logo，故为**自绘最小 SVG**
 * （品牌蓝底 + 白色字母 A），不代表官方美术资产。编码方式与 ACCIO_ICON 同款：
 * base64 由纯 Node 预先算好写死（不用 btoa，esbuild 目标环境未必提供）。
 */
const ASTUDIO_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzFGNkZFQiIvPjxwYXRoIGQ9Ik0xMiA2LjIgMTcuNiAxOC4yaC0yLjJsLTEuMi0yLjlIOS44bC0xLjIgMi45SDYuNHoiIGZpbGw9IiNGRkZGRkYiLz48cmVjdCB4PSI5LjIiIHk9IjEyLjYiIHdpZHRoPSI1LjYiIGhlaWdodD0iMS41IiBmaWxsPSIjRkZGRkZGIi8+PC9zdmc+';


/**
 * provider id → 图标 data URI。
 *
 * ⚠️ 键必须与 `src/provider-registry.ts` 的 id 集合**完全相等**：
 * `provider-registry.spec.ts` 有一条断言锁住两边相等，漏加图标会**变红**
 *（而不是渲染出一个空白图标）。
 */
const AUTOCLAW_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjNDM2MWVlIi8+PHBhdGggZD0iTTcgOGwzIDNsLTItNG00IDBsMyA0bC0yLTNtNCAwbDMgNWwtMi00IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+';

export const PROVIDER_ICONS = {
  codearts: CODEARTS_ICON,
  lobsterai: LOBSTERAI_ICON,
  qoder: QODER_ICON,
  qodercn: QODERCN_ICON,
  trae: TRAE_ICON,
  cline: CLINE_ICON,
  loomy: LOOMY_ICON,
  raccoon: RACCOON_ICON,
  minimax: MINIMAX_ICON,
  // ⚠️ 与 `minimax` **共用同一个常量**（两站同一产品、同一品牌 logo）。
  //    漏加这一行会让 `provider-registry.spec.ts` 的「图标键集合 == registry id
  //    集合」断言变红（而不是渲染出空白图标）。
  minimaxintl: MINIMAX_ICON,
  zcode: ZCODE_ICON,
  opencode: OPENCODE_ICON,
  gemini: GEMINI_ICON,
  officeace: OFFICEACE_ICON,
  accio: ACCIO_ICON,
  astudio: ASTUDIO_ICON,
  autoclaw: AUTOCLAW_ICON,
  // ⚠️ 国际版与国内版**共用同一个图标**（同一产品，只是部署区域不同）。
  //    但键必须存在：`PROVIDER_ICONS` 的键集合与 registry 的 id 集合必须完全相等
  //    （`provider-registry.spec.ts` 有行为断言）。
  autoclawintl: AUTOCLAW_ICON,
  modelscope: MODELSCOPE_ICON,
  aggregate: AGGREGATE_ICON,
};
