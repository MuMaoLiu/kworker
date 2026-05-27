# kh_terminal（OpenHarmony 终端）

面向 **OpenHarmony** 标准系统的终端类应用示例。本工程使用 **DevEco / API 23** 与 Stage 模型开发：主界面为 **ArkUI `Web`**，加载 `rawfile` 中的 **xterm.js** 做渲染，经 **NAPI（C++）** 创建 **PTY** 与系统 Shell 或 **KHSL / `khsl`** 等入口交互。应用包名：`com.example.kh_terminal`。

## 功能概要

- 多标签终端、设置页（主题 / 字号 / 默认配置 / 启动与滚动等）。
- Web 偏好经 **`javaScriptProxy`** 与 ArkTS `saveWebPrefs` / `loadWebPrefs` 写入 **`@kit.ArkData` `preferences`**（`kh_terminal_web_prefs` / `terminal_web_prefs_v1`）；`onPageEnd` 注入 `__wtInjectedPrefsJson` 并执行 `wtBootstrap()`。
- **浅色「乳白」主题**时，ArkUI 根容器与 Web 内 `lightcream` 配色一致。
- 应用与入口图标使用单层 **`app_icon.png`**（`AppScope` 与 `entry` 各一份），详见「桌面图标与图片文件」。

## 工程结构（主要部分）

| 路径 | 说明 |
|------|------|
| `entry/src/main/ets/pages/Index.ets` | 主页面：`Web` + `TerminalProxy` |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 入口 Ability |
| `entry/src/main/cpp/napi_init.cpp` | PTY + NAPI（`libentry.so`） |
| `entry/src/main/cpp/CMakeLists.txt` | 原生模块 |
| `entry/src/main/resources/rawfile/index.html` | 终端 UI 与 xterm |
| `entry/src/main/resources/rawfile/xterm/` | xterm 静态资源 |
| `AppScope/app.json5` | 应用级配置与图标 |
| `entry/src/main/module.json5` | 模块与 EntryAbility |
| `build-profile.json5` | 产品、签名、`compileSdkVersion` 等（`runtimeOS` 为工具链字段，见文件内注释） |
| `entry/scripts/assemble-hap.ps1` | 可选：注入 JBR，缓解 CLI 下 `spawn java ENOENT` |

## 架构与数据流

1. **渲染**：`Web({ src: $rawfile('index.html') })`，内嵌 xterm 处理 ANSI 与滚动等。
2. **ArkTS ↔ JS**：`TerminalProxy`：`startSession`、`writePty`、`resizePty`、`stopSession`、`getLastPtyError`、`saveWebPrefs`、`loadWebPrefs`。
3. **PTY（C++）**：`posix_openpt` / `grantpt` / `unlockpt`，`fork` 后子进程挂 slave、`execv` Shell；父进程读线程 `read(master_fd)`，经 ThreadSafe Function 回调至 ArkTS。
4. **配置档案**：`profile` 为 `default` / `powershell`（`sh` 等）或 `khsl`（`/vendor/bin/khsl` 等）；失败时可本地回显，详见 `getLastPtyError()`。

## 构建与运行

- **环境**：DevEco Studio **6.x**，SDK **API 23**（与 OpenHarmony 配套工具链一致即可）。具体 `runtimeOS` 等字段以 `build-profile.json5` 为准，服务于打包工具而非“仅能在开源 OH 上运行”的声明。
- **依赖**：`ohpm install`；详见各 `oh-package.json5`。
- **签名**：`build-profile.json5` 内路径随本机配置变更。
- **CLI**：若缺 `java`，可参考 `entry/scripts/assemble-hap.ps1`，必要时先 `hvigorw.js --stop-daemon`。
- **构建产物**：`entry/build`、`entry/.cxx`、`.hvigor` 仅为本地编译缓存（见根目录 `.gitignore`），可随时删除后重新构建。

将 HAP 部署到 **OpenHarmony** 设备或对应模拟器；PTY、权限与 **KHSL** 行为以 OpenHarmony 产品文档为准。

## 桌面图标与图片文件

当前使用**单层 PNG** 作为应用图与入口 Ability 图，避免分层图标在部分启动器蒙版下整图发黑、看起来像「无图标」：

| 配置 | 资源名 | 文件（两处需同时存在） |
|------|--------|------------------------|
| `AppScope/app.json5` → `icon` | `$media:app_icon` | `AppScope/resources/base/media/app_icon.png` |
| `entry/.../module.json5` → EntryAbility `icon` / `startWindowIcon` | `$media:app_icon` | `entry/src/main/resources/base/media/app_icon.png` |

替换图标时同步覆盖上述两个 `app_icon.png` 后重新打包。历史分层资源 `layered_image.json`、`foreground.png`、`background.png` 仍保留在工程中，但**已不再被 app/ability 引用**。

若仍无桌面图标：先**卸载旧包**再安装新 HAP；确认桌面非「仅显示正式签名应用」；`com.example.*` 在部分定制系统上可能被策略隐藏；需向 OpenHarmony 侧确认调试/侧载应用是否允许出现在工作台。

## 维护说明

PTY 路径、权限与 **KHSL** 对接在 `resolve_shell_paths` 及系统侧策略上继续按 OpenHarmony 版本迭代即可。
