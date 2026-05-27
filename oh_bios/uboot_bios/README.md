# uboot_bios（L2 通用核心）

所有产品 **共用** 的 U-Boot BIOS 实现。板级差异只在 `../uboot/bios/`，由 `scripts/integrate_kh_bios.sh` 合并进 `cmd/kh_bios/`。

**完整说明（合入主仓、编译、烧录、验证、新产品移植）见：[`../README.md`](../README.md)**

## 本目录内容

| 路径 | 说明 |
|------|------|
| `core/` | `kh_bios.c` 入口、`kh_bios_hotkey.c`、`kh_bios_ui*.c`、`kh_bios_boot.c` 等 |
| `include/` | 对外头文件；板级契约 `kh_bios_board.h` |
| `patches/` | Rockchip DRM FB（`rockchip_show_fbbase_fmt`） |
| `scripts/integrate_kh_bios.sh` | 集成到 U-Boot out 树 |

## 集成调用

```bash
integrate_kh_bios.sh <UBOOT_SRC_TMP> <BOARD_UBOOT_DIR>
# 例：integrate_kh_bios.sh out/uboot/khdvk_rk3568_a/src_tmp device/board/.../uboot
```

## defconfig 最低要求

| 配置项 | 说明 |
|--------|------|
| `CONFIG_KH_BIOS=y` | 启用 BIOS |
| `CONFIG_DM_VIDEO=y` | HDMI |
| `CONFIG_USB_KEYBOARD=y` | USB 键盘 |
| `CONFIG_USB_KEYBOARD_FN_KEYS=y` | F10 |
| `CONFIG_CMD_BOOT_KAIHONG=y` | 平台启动命令（如 `bootkhp`） |

## 板级 ops

见 `include/kh_bios_board.h`：`boot_normal`、`set_recovery_next`、`fill_sys_info`、`enter_fastboot` / `enter_download`、`features`。

## env 键名

| 键 | 含义 |
|----|------|
| `kh_default_boot` | `normal` / `recovery` |
| `kh_once_recovery` | `1` 下次 recovery |
| `kh_bios_delay` | 兼容项；当前由 `KH_BIOS_DEFAULT_DELAY` 固定 |
| `kh_gmac0` / `kh_gmac1` | 硬件页 GMAC |

## 固件标识

`include/kh_bios.h` 中 `KH_BIOS_FW_TAG`：每次发版修改，串口与 `strings uboot.img` 可核对烧录版本。
