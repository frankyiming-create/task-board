# 任务看板

个人任务管理桌面应用。三种视图：看板（按状态分列，支持自定义列颜色）、甘特图（时间轴 + 子任务分支线）、日历（年/月/周）。录入时除标题/备注外，日期用日历选择、状态与优先级用按钮单选、协作人与标签用勾选，避免手填格式不统一。

## v0.2.0 新增

- 左侧可收缩导航栏：用户信息、文件夹分组、标签筛选、已完成归档
- 看板列自定义颜色，卡片支持子任务清单（展开/收起、进度条）
- 甘特图：子任务从主任务线分支呈现，完成后合并回主线；点击时间轴任意位置可添加文字节点标签
- 日历视图（年/月/周切换，点日期看当天任务）
- 右键菜单（编辑/复制/延期一天/归档/删除）、批量选择与批量操作（改截止日期/转移分组/标记完成/删除）
- 重复任务（每天/每周/每月，任务标记完成后自动生成下一次）
- 逾期任务置顶提醒；到期前提醒（提前 10 分钟/1 小时/1 天，需要设置截止时间并开启桌面通知权限）
- 搜索 + 多条件筛选（标签/优先级/状态/日期范围）
- Excel 导出/导入（任务卡片信息，可按时间段导出，用于设备间数据迁移），用到了 [SheetJS](https://sheetjs.com)（Apache-2.0 许可，随包附带于 `src/vendor/`）
- 窗口置顶按钮（点击顶部图钉图标）

## 项目结构

```
kanban-app/
  src/                前端页面（纯 HTML/CSS/JS，无框架、无构建步骤）
  src-tauri/           Tauri 桌面外壳（Rust）
    src/main.rs        启动内置本地服务（axum），提供页面 + /api/state 数据接口
    tauri.conf.json    应用配置（窗口大小、图标、打包目标等）
  icons/app-icon.png   生成各平台图标用的源图
  .github/workflows/   GitHub Actions：自动构建 Mac / Windows 安装包
```

## 工作原理

程序启动后，会在本机后台起一个小型 HTTP 服务，监听所有网卡（含局域网）的 17420 端口，同时提供页面和一个 `/api/state` 数据接口，数据以 JSON 文件形式保存在系统的应用数据目录下（`task-board/data.json`）。

桌面窗口本身只是打开 `http://localhost:17420/`。手机在同一 WiFi 下，用浏览器打开 `http://电脑的局域网IP:17420/`（这个地址会显示在应用内「设置 → 手机同步」里），看到的是同一份数据，编辑会实时保存到同一个文件——不需要装 App，也不涉及应用商店或微信小程序的备案审核流程。可以在手机浏览器里"添加到主屏幕"，图标和启动方式都和普通 App 一样。

局限：这是"同一局域网内共享同一份文件"的轻量同步，不是多设备离线各自编辑再合并的那种同步；出门在外、不在同一 WiFi 下时，手机打不开那个局域网地址（后续如果需要公网访问，可以考虑把这个内置服务部署到一台你自己的云服务器或群晖之类的 NAS 上，原理不变）。

## 打包安装包 —— 在 Mac 上（生成 .dmg）

**这几步必须在真正的 Mac 电脑上做**，Tauri 不支持在别的系统上交叉编译出 macOS 安装包。

1. 装 Xcode 命令行工具（终端里执行一次即可）：
   ```bash
   xcode-select --install
   ```
2. 装 Node.js：打开 https://nodejs.org 下载 LTS 版安装包，双击安装。
3. 装 Rust：终端里执行
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   装完按提示重开一个终端窗口（或执行 `source "$HOME/.cargo/env"`）。
4. 解压这个项目的 zip，终端 `cd` 进 `kanban-app` 目录，执行：
   ```bash
   npm install
   npm run build
   ```
   第一次执行会下载编译依赖，需要几分钟，耐心等。
5. 打包好的安装包在 `src-tauri/target/release/bundle/dmg/` 目录下，是一个 `.dmg` 文件，双击打开后把里面的 App 拖进「应用程序」文件夹即可。
6. 因为没有 Apple 开发者签名，第一次打开时系统可能提示"无法验证开发者"——去「系统设置 → 隐私与安全性」，下滑找到这个 App，点"仍要打开"即可，只需要做一次。

## 打包安装包 —— 在 Windows 上（生成 .exe）

**这几步必须在真正的 Windows 电脑上做**，同样是因为 Tauri 不支持交叉编译。

1. 装 Node.js：打开 https://nodejs.org 下载 LTS 版安装包并安装。
2. 装 Rust：打开 https://rustup.rs 下载 `rustup-init.exe` 并运行，一路默认选项即可（如果提示需要 "Visual Studio C++ 生成工具"，按提示装上，或从 https://visualstudio.microsoft.com/visual-cpp-build-tools/ 下载安装，勾选"使用 C++ 的桌面开发"）。
3. 解压项目 zip，打开 PowerShell 或命令提示符，`cd` 进 `kanban-app` 目录，执行：
   ```bash
   npm install
   npm run build
   ```
4. 打包好的安装包在 `src-tauri\target\release\bundle\nsis\` 下，是一个 `.exe` 文件，双击运行即可。
5. 因为没有微软签名证书，Windows Defender SmartScreen 可能弹"Windows 已保护你的电脑"——点"更多信息"，再点"仍要运行"即可，只需要做一次。

## 开发模式（不打包，直接跑起来看效果）

按上面对应系统装好 Node.js + Rust 后，在项目目录下执行 `npm run dev` 会直接弹出应用窗口运行，不生成安装包，改代码后保存也会热更新，适合先预览效果。

## 后续如果想省事：用 GitHub Actions 自动打包

仓库里已经配好 `.github/workflows/build.yml`。如果以后方便注册一个免费 GitHub 账号、把项目传上去，在仓库的 Actions 页面点一下 "Run workflow"，几分钟后会在 Releases 里自动生成 Mac 的 `.dmg` 和 Windows 的 `.exe`，不需要自己准备两台电脑、也不需要装 Node/Rust。上传代码可以直接在 GitHub 网页上用 "Add file → Upload files" 拖文件夹，不需要懂命令行。

## 数据 / 备份

数据文件是 `task-board/data.json`（Mac 在 `~/Library/Application Support/task-board/`，Windows 在 `%APPDATA%\task-board\`），就是个纯 JSON，想备份、迁移设备，直接复制这个文件即可；也可以放进 iCloud/坚果云同步的目录里做多设备异步同步（此时不要同时在两台设备上开着应用改动，避免相互覆盖）。

## 后续可以加的东西（当前版本没做）

- 任务排序/子任务、附件
- 局域网地址二维码（现在只显示文字地址，手动在手机上输入）
- 公网访问（部署到自己的服务器/NAS）
