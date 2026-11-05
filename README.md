# 市场速览（marketInfo）

Windows 桌面悬浮窗：常驻置顶显示**金十数据快讯** + **A股/港股美股指数**、**贵金属**、**原油与内盘期货**行情。

- 无边框半透明面板，可拖动、可缩放，默认贴屏幕右侧；**迷你条自动收进屏幕边缘，不会越界**
- **拖到屏幕边缘 18px 内自动吸附**（左/右/上/下），普通模式和迷你模式都生效
- 行情卡片：最新价、涨跌幅、当日区间位置；涨红跌绿
- **行情 / 快讯之间的分隔条可拖拽**，单独调两栏高度；双击分隔条恢复默认，高度自动记忆
- 品种：A股指数 / 板块ETF / 港美指数 / 贵金属 / 原油与内盘期货
- **关注栏**：点击任意行情卡片即加入/移出关注，关注固定在面板顶部；迷你模式下只展示关注品种
- 快讯流：重要快讯高亮、全部/重要筛选、点击展开全文、原文可跳浏览器
- **重要快讯走 Windows 系统通知**，点击通知直接打开金十原文
- 托盘常驻：显示/隐藏、迷你模式、任务栏模式、真嵌入任务栏、点击穿透、始终置顶、开机自启
- 全局热键：`Ctrl+Alt+J` 显隐 · `Ctrl+Alt+M` 迷你 · `Ctrl+Alt+P` 点击穿透（键位被占用会自动换备选，设置面板显示实际生效的键）

## 运行

```powershell
npm install
npm start
```

首次安装若卡在 Electron 二进制下载，先设置镜像再装：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
```

若安装完成后 `node_modules/electron/dist` 里只有一个 `LICENSES.chromium.html`（zip 下完了但解压中断），手动解压补上：

```powershell
$zip = (Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter 'electron-v*-win32-x64.zip' | Select-Object -First 1).FullName
Expand-Archive -Path $zip -DestinationPath node_modules\electron\dist -Force
Set-Content node_modules\electron\path.txt 'electron.exe' -NoNewline
```

## 目录

```
electron/
  main.js            主进程：窗口、托盘、热键、自启、穿透、迷你、通知、轮询调度
  preload.js         contextBridge 暴露的受限 IPC
  store.js           设置持久化（%APPDATA%/market-info-widget/settings.json）
  taskbar-embed.js   实验性真嵌入任务栏（SetParent 到 Shell_TrayWnd，依赖 koffi）
  icons.js           程序化生成托盘/窗口图标
  data/symbols.js    行情标的清单（改这里加减品种）
  data/quotes.js     行情抓取：东方财富 + 新浪财经
  data/flash.js      金十快讯抓取与字段归一
renderer/
  index.html  styles.css  app.js
build/
  icon.ico           应用图标（16~256 多尺寸，脚本生成）
  icon.png
  afterPack.js       打包后写入 exe 图标与版本信息（resedit，替代 rcedit）
```

## 关注栏

- 点击任意行情卡片：加入关注（最新加入的排在最前），再点一次移出
- 关注卡片金色描边，同时仍保留在所属分组里，分组被关掉也不影响关注栏
- 迷你模式下若有关注品种，就只显示关注栏；没有关注时退回显示全部分组
- 关注列表存在 `settings.json` 的 `watch` 字段，按品种代码记录

## 行情 / 快讯分栏

- 两栏之间的细条可以上下拖拽，单独调整行情区高度；快讯区会跟着伸缩
- 拖拽有上下限：行情区至少留 90 px，快讯区至少留 96 px，不会把其中一栏拖没
- **双击分隔条**恢复默认（行情区按内容自适应，上限 62% 窗口高度）
- 高度存进 `settings.json` 的 `quoteHeight`（像素），重启后保持；调整窗口大小时自动收回可视范围，放大后按原高度展开
- 迷你模式下分隔条隐藏，退出迷你后恢复原来的分栏高度

## 迷你模式与屏幕吸附

- **迷你条宽度按内容自动计算**：有关注品种时按关注卡片数量伸缩，没有关注时展示全部分组；标题栏放不下时会保留最小宽度，不会压坏按钮
- 内容宽度超过屏幕时会封顶到屏幕宽度，改成横向滚动，不会撑出屏幕
- 宽度变化时按靠近的那一侧锚定：贴右边就往左伸缩，贴左边就往右伸缩
- **吸附**：拖动结束（停顿约 0.2 秒）后，窗口距离当前屏幕工作区边缘 18px 以内就自动贴齐；左右上下四条边都支持，普通模式和迷你模式通用
- 窗口被拖到屏幕外时，吸附逻辑会顺带把它收回工作区
- 退出迷你模式时，大窗口回到迷你条当前所在的那一侧；下次启动沿用这个位置
- 迷你条的位置不单独记忆，避免下次启动时大窗口出现在只剩一条小窗的位置

## 任务栏模式

标题栏的任务栏按钮（或托盘菜单的「任务栏模式」）会把窗口收成一条嵌在系统任务栏里的横条，高度与任务栏一致，宽度按关注卡片自动伸缩：

- 条带右侧的还原按钮回到普通窗口；右键托盘也可以退出
- 条带宽度随关注数量变化；左侧的手柄可以左右拖动，位置沿用上次的位置（`taskbarX`）
- 普通任务栏条是置顶窗口，Windows 11 任务栏有时会把它压到下面，程序每 1.5 秒把它抬回最上层
- **实验性「真嵌入任务栏」**：在设置面板或托盘菜单打开后，用 `SetParent` 把窗口挂进 `Shell_TrayWnd`，成为任务栏的子窗口，不再依赖置顶层级

> 微软在 Windows 11 的 XAML 任务栏里去掉了 DeskBand（`IDeskBand2`，第三方工具栏）支持，没有受支持的 API 能把第三方内容放任务栏里并让出位置。真嵌入属于非官方做法：Explorer 重启会连带销毁子窗口，程序会在 1.5 秒后自动重建窗口并重新挂回新任务栏；它也不会为条带腾出任务栏空间，仍会盖住下面原有的图标。

## 数据来源

| 数据 | 接口 |
| --- | --- |
| 金十快讯 | `flash-api.jin10.com`（公开接口，需 `x-app-id` 头） |
| 指数 / 外盘 / 贵金属 | 东方财富 `push2.eastmoney.com` |
| 内盘期货主力连续 | 新浪财经 `hq.sinajs.cn`（GBK 解码） |

均为非官方公开接口，可能变更或限流；行情有延迟，仅供自己盯盘参考，不构成投资建议。

快讯正文里的 HTML 标签会被剥离，广告位（`extras.ad`）会被过滤。

## 加品种

编辑 `electron/data/symbols.js`，往 `groups[].items` 加一行：

```js
{ short: '布伦特', name: '布伦特原油', src: 'em', secid: '112.B00Y' }
{ short: '橡胶',  name: '橡胶主力',   src: 'sina', code: 'nf_RU0' }
```

- `src: 'em'` 用东方财富 secid（指数 `1.000001`、港股美股 `100.HSI`、外盘期货 `102.CL00Y`、ETF 与 A 股一样用 `1.` / `0.` 前缀，例如人工智能ETF `1.515070`）
- `src: 'sina'` 用新浪 `nf_` 前缀的主力连续代码（上期所/大商所/郑商所均可）

## 打包 exe

```powershell
npm run dist          # 安装版 + 便携版
npm run dist:exe      # 只出便携版
```

产物在 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `MarketInfo-1.0.0-setup.exe` | NSIS 安装包（可选目录、桌面快捷方式「市场速览」） |
| `MarketInfo-1.0.0-portable.exe` | 免安装便携版，双击即用 |
| `win-unpacked/MarketInfo.exe` | 未压缩的绿色版目录 |

打包机在国内网络下需要镜像环境变量，否则会卡在 Electron / NSIS 下载：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run dist
```

### 为什么关掉了 signAndEditExecutable

electron-builder 默认用 rcedit 写 exe 图标和版本信息，这一步会下载 `winCodeSign` 压缩包。该包里带 macOS 符号链接，Windows 普通用户权限解压会报「客户端没有所需的特权」，而压缩包又做了 sha512 校验、没法自行重打包。

所以 `package.json` 里设了 `"signAndEditExecutable": false`，改由 `build/afterPack.js` 用纯 JS 的 `resedit` 在打包后直接改写 PE 资源（图标 + 版本信息），效果一样且不依赖外部二进制。

### 开发版与安装版共用数据

两者 `appId`/包名一致，配置都读写 `%APPDATA%\market-info-widget\settings.json`，所以装好后能沿用开发时调好的关注列表和窗口位置。副作用：两个同时运行时，后启动的那个会因为单实例锁直接退出。

## 点击穿透

开启后窗口不再接收鼠标（点击落到下层窗口），这是穿透的定义。为了让这个状态不变成“死锁”：

- 开启时自动收起设置面板，并弹一条系统通知说明退出方式（**点这条通知也能直接关闭穿透**）
- 标题栏出现金色「穿透中」标识，面板边框变虚线
- 退出方式：`Ctrl+Alt+P` 热键 / 右键托盘图标（菜单顶部会多出「退出点击穿透」）/ 窗口有焦点时按 `Esc`
- 热键注册失败（被其它程序占用）时会自动尝试 `Ctrl+Alt+O`、`Ctrl+Alt+T`，并把实际生效的键显示在设置面板

## 刷新策略

- 行情默认 5 秒、快讯默认 8 秒，可在设置面板调整
- 窗口隐藏时自动降频（行情 ≥20 秒、快讯 ≥30 秒），重新显示立即刷新
- 周末（周六 06:00 之后）行情降频 6 倍

## 已知边界

- 透明窗口无法对桌面做真实高斯模糊（`backdrop-filter` 只作用于窗口内部内容），面板靠高不透明度底色保证可读性
- 关闭按钮是收进托盘，退出请用设置面板底部按钮或托盘菜单
- 开机自启在开发模式（`npm start`）下指向 `node_modules` 里的 electron.exe；打包成 exe 后自动指向自身
- 系统通知受 Windows「专注助手 / 通知」设置影响，被拦截时不会弹出；便携版没有开始菜单快捷方式，通知归属名可能显示为 `com.maigo.marketinfo`，安装版会显示「市场速览」
- 关注品种同时保留在所属分组里（分组是完整行情，关注是快捷入口），介意重复可以把对应分组关掉
- 迷你模式按窗口所在屏幕的工作区收边：贴右边就往左展开，贴左边就往右展开，尺寸超过屏幕时自动缩小