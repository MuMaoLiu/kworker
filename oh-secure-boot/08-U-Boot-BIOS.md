# 08 - U-Boot BIOS 测试矩阵

## 代码路径（L2 通用架构）

| 层级 | 路径 |
|------|------|
| 通用核心 | `extension/uboot_bios/` |
| 集成脚本 | `extension/uboot_bios/scripts/integrate_kh_bios.sh` |
| 3568A 板级 | `device/board/{company}/khdvk_rk3568_a/uboot/bios/` |
| defconfig | `device/board/{company}/khdvk_rk3568_a/uboot/configs/khdvk_rk3568_a_defconfig` |

接入说明见 `extension/uboot_bios/README.md`。

## 功能测试

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | F10 进入 | USB 键盘，上电 3 秒内 F10 | HDMI 显示 OpenHarmony Setup Utility |
| 2 | 正常启动 | 不按键 | 串口 `[kh_bios]` 倒计时，随后 `bootkhp` 启动 |
| 3 | 串口进入 | `kh_bios` 命令 | 进入主菜单 |
| 4 | 系统信息 | Main → System Information | 显示板名、内存、eMMC |
| 5 | Recovery 一次 | Boot → once ON → Save & Exit | 重启进 recovery |
| 6 | 默认 Recovery | Boot → Default Recovery → Save | 每次启动写 BCB |
| 7 | Fastboot | Advanced → Fastboot | `fastboot usb 0` |
| 8 | Rockusb | Advanced → Rockusb | 进入下载模式 |
| 9 | Security | Main → Security | 显示 HVB 占位状态 |
| 10 | env 持久 | 修改 GMAC → Save → `printenv kh_gmac0` | 值保留 |

## 回归测试

| # | 场景 | 预期 |
|---|------|------|
| R1 | 无 USB 键盘冷启动 | 倒计时结束后正常进系统 |
| R2 | Ctrl+C / 串口中断 | 不破坏 autoboot |
| R3 | 热重启 | BIOS 窗口仍出现 |

## 已知限制

- 图形界面基于 `vidconsole` 文本绘制，非完整 BMP UI
- F10 依赖 `CONFIG_USB_KEYBOARD_FN_KEYS`
- `kh_gmac*` 仅写入 env，内核侧需另行解析（后续）
- Security 页 HVB 为只读占位，完整 OHVB 与 BIOS 解耦后续集成
