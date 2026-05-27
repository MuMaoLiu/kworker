# OpenHarmony U-Boot BIOS（kh_bios）

在 **U-Boot 阶段**提供 PC 风格 Setup：HDMI 图形菜单、USB 键盘 **F10** / 串口 **B** 进入、配置写入 U-Boot env，退出后 **冷复位** 再启动系统。

本目录是 **kh_bios 的独立维护仓**（从 OpenHarmony 主仓拆出），包含：

> **路径占位符**：文档中 `{company}` 表示设备厂商目录名（如 `device/board/{company}/`），`{product}` 表示产品/板型目录名。参考实现：`{company}=kaihong`、`{product}=khdvk_rk3568_a`。

| 子目录 | 角色 | 合入 OpenHarmony 后的路径 |
|--------|------|---------------------------|
| `uboot_bios/` | L2 通用核心（所有产品共用） | `extension/uboot_bios/` |
| `uboot/` | 板级薄配置（以 khdvk_rk3568_a 为参考） | `device/board/{company}/{product}/uboot/` |

> **维护原则**：只改 `uboot_bios/core` 与 `uboot/bios`，不要把 core 复制进板级目录；集成由 `integrate_kh_bios.sh` 在编译时完成。

---

## 功能概述

| 能力 | 说明 |
|------|------|
| 进 BIOS 热键 | USB **F10**、USB **B**、串口 **B**（倒计时内） |
| 倒计时 | 默认 **3 秒**（`KH_BIOS_DEFAULT_DELAY`）；旧 env `kh_bios_delay=10` 会被忽略 |
| 显示 | HDMI 1920×1080 AMI 风格 UI（ARGB8888），依赖 Rockchip DRM FB patch |
| 菜单 | Main / Boot / Hardware / Security / Advanced（由 `features` 掩码裁剪） |
| 退出 | Save / Discard / Esc → **CRU 冷复位**（非继续跑 bootcmd，避免花屏） |
| 启动 | `kh_bios_board_ops.boot_normal()` → 3568 上为 `bootkhp` |
| 固件标识 | 串口打印 `KH_BIOS_FW_TAG`（见 `uboot_bios/include/kh_bios.h`），用于确认烧录版本 |

### 启动时序（简图）

```text
上电 → Logo
  → rk_board_late_init() [弱符号，kh_bios.c]
  → USB 上电/枚举（板级 ops）
  → 3s 倒计时（F10 / USB-B / 串口-B）
  → [可选] kh_bios_run() 菜单
  → kh_bios_boot_system() → bootkhp / extlinux
```

手动命令（U-Boot 命令行）：`kh_bios`、`kh_bios check`。

---

## 目录结构

```text
special/kh_bios/
├── README.md                 # 本文档
├── uboot_bios/               # L2 通用（→ extension/uboot_bios）
│   ├── core/                 # 源码、Makefile、Kconfig
│   ├── include/              # kh_bios*.h、board ops 契约
│   ├── patches/              # rockchip_video_fb*.patch
│   ├── scripts/
│   │   └── integrate_kh_bios.sh
│   └── README.md             # L2 API 速查
└── uboot/                    # 板级（→ device/board/.../uboot）
    ├── bios/
    │   ├── kh_bios_board.c   # kh_bios_board_ops 实现
    │   └── kh_bios_product.h # 产品名、features、默认延时
    ├── configs/*_defconfig
    ├── dts/
    ├── rkbin/
    ├── build_uboot.sh
    └── BUILD.gn              # OH 全量编译入口
```

集成后，U-Boot 构建树中出现：`cmd/kh_bios/`（core + include + board 合并，**仅存在于 `out/uboot/.../src_tmp`**，不改 SoC 自带 uboot 源仓）。

---

## 与 OpenHarmony 主仓的关系

### 同步到主仓（开发完成后）

将本仓内容覆盖到 OH 对应路径（示例路径请按实际 `ROOT_DIR` 修改）：

```bash
OH=/path/to/openharmony
ECO=/path/to/kh_application_eco/special/kh_bios

rsync -a --delete "${ECO}/uboot_bios/" "${OH}/extension/uboot_bios/"
rsync -a "${ECO}/uboot/" "${OH}/device/board/{company}/khdvk_rk3568_a/uboot/"
```

提交时建议 **两个路径一起合入**：`extension/uboot_bios` + `device/board/.../uboot`。

### 从主仓拉回本仓

```bash
rsync -a "${OH}/extension/uboot_bios/" "${ECO}/uboot_bios/"
rsync -a "${OH}/device/board/{company}/khdvk_rk3568_a/uboot/" "${ECO}/uboot/"
```

---

## 编译

### 前提

- 已具备完整 **OpenHarmony + Rockchip U-Boot** 环境（`device/soc/rockchip/tools/uboot/rk356x`、`rkbin` 等）。
- 已将本仓 **同步** 到 OH，或在本仓 `uboot/` 旁保留 `uboot_bios/`（`build_uboot.sh` 会自动查找，见下）。

### 方式一：单独编 U-Boot（改 BIOS 时常用）

在 OH 根目录执行：

```bash
cd /path/to/openharmony

bash device/board/{company}/khdvk_rk3568_a/uboot/build_uboot.sh \
  "." \
  "/path/to/openharmony/out/arm64/khdvk_rk3568_a/packages/phone/images" \
  "/path/to/openharmony/device/board/{company}/khdvk_rk3568_a" \
  "/path/to/openharmony" \
  "{company}" "khdvk_rk3568_a" "{company}" "khdvk_rk3568_a"
```

**产物（请烧这一份）：**

```text
out/arm64/khdvk_rk3568_a/packages/phone/images/uboot.img
```

> **注意**：`out/arm/.../uboot.img` 可能是旧包或未单独编译的产物；以 **arm64** 路径为准，或烧录前用下文「验证」中的 `strings` 检查固件标签。

也可直接调用本仓脚本（参数同上，第 3 个参数指向 OH 里 `device/board/...`）：

```bash
bash special/kh_bios/uboot/build_uboot.sh \
  "." \
  "${OH}/out/arm64/khdvk_rk3568_a/packages/phone/images" \
  "${OH}/device/board/{company}/khdvk_rk3568_a" \
  "${OH}" \
  "{company}" "khdvk_rk3568_a" "{company}" "khdvk_rk3568_a"
```

`build_uboot.sh` 查找 `uboot_bios` 的顺序：

1. 环境变量 `KH_BIOS_ROOT`（若已设置且目录存在）
2. 与 `uboot/` 同级的 `../uboot_bios`（本 eco 仓布局）
3. `${ROOT_DIR}/extension/uboot_bios`（OH 标准布局）

### 方式二：OH 全量编译

通过 `uboot/BUILD.gn` 的 `action("uboot")` 参与镜像打包；改 BIOS 后仍建议先用方式一快速迭代，再全量编验证。

### 修改固件版本号

发版前更新 `uboot_bios/include/kh_bios.h` 中的 `KH_BIOS_FW_TAG`，重新编译并记录 MD5，便于现场对照串口。

---

## 编译开关（Kconfig / defconfig）

BIOS 是否编进 U-Boot、依赖哪些子系统，由 **三层机制** 控制：Kconfig 定义 → 板级 defconfig 打开 → Makefile 条件链接。

### 开关关系（简图）

```text
{product}.config
  └── CONFIG_BASE_DEFCONFIG → {product}_defconfig
           │
           ▼
build_uboot.sh → integrate_kh_bios.sh → out/uboot/{product}/src_tmp
           │
           ├── cmd/Kconfig  source "cmd/kh_bios/Kconfig"   ← uboot_bios/core/Kconfig
           ├── cmd/Makefile obj-$(CONFIG_KH_BIOS) += kh_bios/
           └── patches/rockchip_video_fb*.patch            ← CONFIG_KH_BIOS 时 FB 1920×1080
           │
           ▼
out/uboot/{product}/OBJ/.config  →  最终 uboot.img
```

### 1. 总开关（kh_bios 专有 Kconfig）

**定义位置**（L2 通用，合入后在 out 树为 `cmd/kh_bios/Kconfig`）：

| 配置项 | 类型 | 依赖 | 说明 |
|--------|------|------|------|
| `CONFIG_KH_BIOS` | bool | `DM_VIDEO` | **主开关**：编进 `cmd/kh_bios/` 整包；`rk_board_late_init()` 调倒计时 |
| `CONFIG_KH_BIOS_HOTKEY_F10` | bool | `KH_BIOS` + `USB_KEYBOARD` | Kconfig 子项，默认随 `KH_BIOS` 为 y；**源码暂未单独 `#ifdef`**，F10 实际走 `CONFIG_USB_KEYBOARD` |

`menuconfig` 路径（仅在 integrate 后的 out 树）：**Command line interface → KaihongOS U-Boot BIOS setup utility (L2)**。

**Makefile 链接**（由 `integrate_kh_bios.sh` 写入 `cmd/Makefile`）：

```makefile
obj-$(CONFIG_KH_BIOS) += kh_bios/
```

`CONFIG_KH_BIOS=y` 时编译 `cmd/kh_bios/` 下全部对象（core + `board/kh_bios_board.o`）。`kh_bios` 命令通过 `U_BOOT_CMD` 注册，**无**独立 `CONFIG_CMD_KH_BIOS`。

### 2. 板级 defconfig（3568A 参考）

**文件**：`uboot/configs/khdvk_rk3568_a_defconfig`（合入主仓后为 `device/board/{company}/{product}/uboot/configs/`）。

**入口链**：`khdvk_rk3568_a.config` 指定 `CONFIG_BASE_DEFCONFIG="khdvk_rk3568_a_defconfig"`，`make.sh` 生成 `out/uboot/{product}/OBJ/.config`。

BIOS 相关最小片段（3568A 已打开）：

```text
CONFIG_BOOTDELAY=0                  # 关闭 U-Boot autoboot 倒计时，由 kh_bios 内 3s 窗口接管
CONFIG_USB_KEYBOARD=y
CONFIG_USB_KEYBOARD_FN_KEYS=y       # F10 等功能键
CONFIG_KH_BIOS=y                    # ★ BIOS 总开关
CONFIG_CMD_BOOT_KAIHONG=y           # bootkhp；菜单退出后 boot_normal() 使用
CONFIG_DM_VIDEO=y                   # KH_BIOS 的 Kconfig depends on
CONFIG_DRM_ROCKCHIP=y               # 及 DRM_ROCKCHIP_* 子项（HDMI FB）
CONFIG_DEBUG_UART=y
CONFIG_DEBUG_UART_BASE=0xFE660000   # 串口 B 进 BIOS
```

**3568A 完整 defconfig 中还包含**（运行时实际生效，见 `.config`）：`CONFIG_CONSOLE_MUX=y`（stdin 串口+USB 键盘）、`CONFIG_USB` / host 控制器、`CONFIG_ANDROID_BOOTLOADER`（recovery/BCB，板级 `kh_bios_board.c` 使用）等。

**核对是否编进当前镜像**：

```bash
grep -E 'CONFIG_KH_BIOS|CONFIG_USB_KEYBOARD|CONFIG_DM_VIDEO' \
  out/uboot/khdvk_rk3568_a/OBJ/.config
```

### 3. 依赖开关（U-Boot 既有选项，非 kh_bios 专有）

| 配置项 | 作用 |
|--------|------|
| `CONFIG_DM_VIDEO` | `CONFIG_KH_BIOS` 硬依赖；HDMI vidconsole |
| `CONFIG_DRM_ROCKCHIP` + 子项 | Rockchip DRM / HDMI 帧缓冲 |
| `CONFIG_USB_KEYBOARD` / `FN_KEYS` | USB 键盘与 F10 |
| `CONFIG_BOOTDELAY=0` | 避免与 BIOS 3s 倒计时叠加 |
| `CONFIG_CMD_BOOT_KAIHONG` | 编译 `bootkhp.o`（SoC `cmd/Kconfig` 定义） |
| `CONFIG_DEBUG_UART` + `BASE` | 串口热键与 early log |
| `CONFIG_CONSOLE_MUX` | 多路 stdin（serial + usbkbd） |
| `CONFIG_DM_USB` / `CONFIG_USB_*` | USB host 枚举 |
| `CONFIG_HVB_LIBHVB` | Security 页 HVB 占位（可选） |

**Patch 级**：`uboot_bios/patches/rockchip_video_fb_header.patch` 在 `#elif defined(CONFIG_KH_BIOS)` 下将 FB 设为 1920×1080、32bpp，并导出 `rockchip_show_fbbase_fmt()`。

### 4. 源码内条件编译

`CONFIG_KH_BIOS=y` 后整目录参与链接；各模块再按已有 U-Boot 宏裁剪：

| 文件 | 主要条件宏 | 用途 |
|------|------------|------|
| `kh_bios.c` | `IS_ENABLED(CONFIG_KH_BIOS)` | 入口 `rk_board_late_init()` → `kh_bios_boot_check()` |
| `kh_bios_hotkey.c` | `CONFIG_USB_KEYBOARD`、`CONFIG_DM_VIDEO`、`CONFIG_DEBUG_UART`、`CONFIG_CONSOLE_MUX`、`CONFIG_DM_USB` | F10/B、USB init、倒计时 |
| `kh_bios_ui_draw.c` | `CONFIG_DRM_ROCKCHIP`、`CONFIG_DM_VIDEO` | HDMI AMI UI |
| `kh_bios_board.c` | `CONFIG_ANDROID_BOOTLOADER` | recovery / misc BCB |
| `kh_bios_security.c` | `CONFIG_HVB_LIBHVB` | Security 页 |

### 5. 板级功能掩码（C 宏，非 Kconfig）

`uboot/bios/kh_bios_product.h` 中 `KH_BIOS_PRODUCT_FEATURES` 控制菜单项（Boot / Hardware / Security / Fastboot 等），改宏即可裁剪 UI，**不**走 `menuconfig`：

```c
#define KH_BIOS_PRODUCT_FEATURES \
    (KH_BIOS_FEAT_BOOT_MENU | KH_BIOS_FEAT_HW_MENU | ...)
```

### 6. 新产品如何打开 BIOS

1. 在 `device/board/{company}/{product}/uboot/configs/*_defconfig` 增加 `CONFIG_KH_BIOS=y`，并保证 `CONFIG_DM_VIDEO`、`CONFIG_USB_KEYBOARD` 等依赖项（见上表）。
2. `build_uboot.sh` 自动调用 `integrate_kh_bios.sh`，**无需**手改 SoC 源仓 `cmd/Makefile` / `cmd/Kconfig`。
3. 编完后检查 `out/uboot/{product}/OBJ/.config` 与 `strings uboot.img | grep kh_bios-`。

关闭 BIOS：在 defconfig 中 `# CONFIG_KH_BIOS is not set` 或删除该行后重编；`cmd/kh_bios/` 不会链接进镜像。

---

## 烧录

- 分区：**uboot**（与 Loader 配套时一并更新 `MiniLoaderAll.bin`，见 `uboot/build_uboot.sh` 拷贝逻辑）。
- 文件：`uboot.img`（约 4 MiB）。
- 烧录后 **冷启动** 或掉电上电，勿仅软重启到内核而不经过 U-Boot。

---

## 功能验证

### 1. 确认镜像内容（烧录前，在 PC 上）

```bash
UBOOT=out/arm64/khdvk_rk3568_a/packages/phone/images/uboot.img

strings "$UBOOT" | grep -E 'KH_BIOS_FW_TAG|kh_bios-20|USB init then|cold reset now|setup menu active'
md5sum "$UBOOT"
```

应能看到当前 `KH_BIOS_FW_TAG`（例如 `kh_bios-20260527-r4`），且 **不应** 再出现旧文案 `setup window %d sec after USB`。

### 2. 串口启动日志（烧录后）

连接 **UART**（3568A：`0xfe660000`，与 `earlycon` 一致），上电后关注 `[kh_bios]` 行：

| 检查项 | 期望 |
|--------|------|
| 固件标签 | `[kh_bios] kh_bios-20xxxxxx-rN KHDVK RK3568-A ... setup 3 sec` |
| 倒计时文案 | `USB init then 3 sec for F10/USB-B or serial-B` |
| USB host1 | **不应** 再扫描 `usb@fd880000` / `fd8c0000`（DTS 已禁 host1） |
| 进菜单 | `setup menu active (kh_bios-...)` |
| Discard/Save 退出 | `exit without saving` 或 `configuration saved` → `cold reset now` → `CRU cold reset` → U-Boot **从头**打印 |

若仍为 `setup window 10 sec` 或 `10 sec`，说明 **未烧到新 uboot.img** 或烧错路径。

### 3. 热键

| 操作 | 期望 |
|------|------|
| 倒计时内串口发 **B** | 进入 BIOS 菜单 |
| USB 键盘 **F10** | 进入 BIOS（键盘接 **J98 / host0**） |
| 倒计时内不按键 | 约 3s 后自动 `boot_normal` 启动系统 |

### 4. 菜单与退出

| 操作 | 期望 |
|------|------|
| HDMI | 1920×1080 菜单，可方向键/Enter（USB 或串口） |
| **Discard Changes** | 冷复位，再次上电仍可见 kh_bios 倒计时 |
| **Save & Exit** | 写入 env 后冷复位 |
| 启动后显示 | 无长时间花屏；内核无连续 `POST_BUF_EMPTY` / drm-logo IOMM fault（若仍有，查是否未冷复位或 env 异常） |

### 5. U-Boot 命令行（可选）

```text
=> kh_bios check
=> kh_bios
=> printenv kh_default_boot kh_bios_delay
```

---

## 新产品移植步骤

以 **khdvk_rk3568_a** 为模板，新产品只需新增/修改 **板级 `uboot/`**，通用 core 保持不变。

### 1. 复制板级目录

```text
device/board/{company}/{product}/uboot/
├── bios/
│   ├── kh_bios_board.c
│   ├── kh_bios_product.h
│   └── Makefile          # obj-y += kh_bios_board.o
├── configs/<new_product>_defconfig
├── dts/<new_product>.dts
├── build_uboot.sh        # 与 3568A 相同模式，改 DEVICE_NAME
└── BUILD.gn
```

### 2. 修改 `kh_bios_product.h`

- `KH_BIOS_PRODUCT_NAME` / `KH_BIOS_SOC_NAME`
- `KH_BIOS_DEFAULT_DELAY`
- `KH_BIOS_PRODUCT_FEATURES`（不需要的菜单用 feature 关掉）

### 3. 实现 `kh_bios_board.c`

实现 `struct kh_bios_board_ops`（契约见 `uboot_bios/include/kh_bios_board.h`）：

| 回调 | 典型实现 |
|------|----------|
| `boot_normal` | `run_command("bootkhp", 0)` 或 `bootcmd` |
| `set_recovery_next` | 写 misc / reboot mode |
| `fill_sys_info` / `fill_hw_lines` | 读板级 ID、MAC、存储等 |
| `hw_toggle_item` | GMAC、USB 等开关写 env |
| `enter_fastboot` / `enter_download` | `fastboot` / `rockusb` |

USB 供电、Hub、GPIO 等放在板级 `kh_bios_board_usb_init()` 一类函数中（参考 3568A）。

### 4. defconfig 最低配置

见上文 **[编译开关（Kconfig / defconfig）](#编译开关kconfig--defconfig)**。至少包含：

```text
CONFIG_KH_BIOS=y
CONFIG_DM_VIDEO=y
CONFIG_USB_KEYBOARD=y
CONFIG_USB_KEYBOARD_FN_KEYS=y
CONFIG_CMD_BOOT_KAIHONG=y
CONFIG_BOOTDELAY=0
CONFIG_DEFAULT_DEVICE_TREE="..."
```

### 5. 设备树注意点（RK3568 经验）

- USB 键盘：host0（J98）稳定；有问题的 host1 可在 DTS **status = "disabled"**。
- HDMI / VOP：与 logo、BIOS FB 地址协调；退出 BIOS 必须 `display_restore` 或冷复位。
- 串口：与 `stdin` / `earlycon` 一致，便于串口 **B** 进菜单。

### 6. 集成脚本

`build_uboot.sh` 在 `copy_uboot_source` 末尾调用：

```bash
bash "${KH_BIOS_ROOT}/scripts/integrate_kh_bios.sh" \
    "${UBOOT_SRC_TMP_PATH}" "${SCRIPT_DIR}"
```

无需手改 `cmd/Makefile`（脚本会 patch out 树）。

### 7. 发版检查清单

- [ ] 更新 `KH_BIOS_FW_TAG`
- [ ] `strings uboot.img` 可见新标签与新 log 文案
- [ ] 串口 3s 倒计时 + F10/B 进菜单
- [ ] Discard → `cold reset now` → 重新进 U-Boot
- [ ] 正常启动 OH / Linux 无严重 DRM 花屏

---

## 环境变量（U-Boot env）

| 键 | 含义 |
|----|------|
| `kh_default_boot` | `normal` / `recovery` |
| `kh_once_recovery` | `1` 表示下次进 recovery |
| `kh_bios_delay` | 历史兼容；当前 core **固定使用** `KH_BIOS_DEFAULT_DELAY`（3），若 env 不同会打印 ignore 提示 |
| `kh_gmac0` / `kh_gmac1` | 硬件页以太网开关（板级定义） |

清理旧配置：`env delete kh_bios_delay` → `saveenv`。

---

## 常见问题

| 现象 | 原因与处理 |
|------|------------|
| 串口仍是 `10 sec` / `setup window after USB` | 烧错 `uboot.img`（常见：`out/arm` 旧包）；改烧 **arm64** 路径并核对 `KH_BIOS_FW_TAG` |
| `Unknown command 'bootkhp'` | defconfig 未开 `CONFIG_CMD_BOOT_KAIHONG` 或板级未实现 `boot_normal` 回退 |
| USB 键盘无效 | 键盘接 host0；看 DTS 是否仍枚举 host1；EHCI timeout 多为硬件/拓扑问题 |
| 退出 BIOS 后花屏、内核 IOMM fault | 旧固件未冷复位；新固件应 `cold reset now`；或 `kh_bios_prepare_boot_continue()` 未执行 |
| `integrate_kh_bios.sh` 报 `rockchip_show_fbbase_fmt missing` | patch 未打上，检查 `uboot_bios/patches/` 与 SoC uboot 版本是否匹配 |
| `CONFIG_KH_BIOS` 未出现在 `.config` | defconfig 未打开或 integrate 未执行；检查 `build_uboot.sh` 与 out 树 |

---

## 参考

- L2 API 与 env 键速查：`uboot_bios/README.md`
- 参考产品：**khdvk_rk3568_a**（`uboot/bios/`、`uboot/dts/khdvk_rk3568_a.dts`）
- OpenHarmony 主仓镜像路径：`out/arm64/<product>/packages/phone/images/uboot.img`

---

## 维护记录

| 日期 | 说明 |
|------|------|
| 2026-05 | 从 OH `extension/uboot_bios` + `khdvk_rk3568_a/uboot` 迁入本 eco 仓；L2/L3 分离、冷复位退出、FW_TAG 校验 |
| 2026-05 | 补充编译开关（Kconfig / defconfig / Makefile）说明 |
