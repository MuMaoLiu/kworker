# khdvk_rk3568_a — kh_bios 板级配置

本目录实现 `kh_bios_board_ops`，由 `extension/uboot_bios` 在编译时合并进 `cmd/kh_bios/board/`。

| 文件 | 说明 |
|------|------|
| `kh_bios_board.c` | 启动、recovery、USB 供电 GPIO、系统/硬件信息 |
| `kh_bios_product.h` | 产品名、`KH_BIOS_PRODUCT_FEATURES`、默认 3s 倒计时 |

**完整使用说明**（编译、defconfig、烧录、验证、移植）：

- [extension/uboot_bios/README.md](../../../../../../extension/uboot_bios/README.md)
- [docs/kh_bios/README.md](../../../../../../docs/kh_bios/README.md)
