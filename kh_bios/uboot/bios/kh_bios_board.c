/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * khdvk_rk3568_a - KaihongOS U-Boot BIOS board ops
 */

#include <common.h>
#include <command.h>
#include <dm.h>
#include <asm/gpio.h>
#include <dt-bindings/pinctrl/rockchip.h>
#include <power/regulator.h>

DECLARE_GLOBAL_DATA_PTR;
#include <blk.h>
#include <boot_rkimg.h>
#include <version.h>
#include <linux/sizes.h>

#ifdef CONFIG_ANDROID_BOOTLOADER
#include <android_bootloader.h>
#endif

#include "kh_bios_board.h"
#include "kh_bios_product.h"

static int bios_gpio_out(unsigned int bank, unsigned int pin)
{
	struct udevice *dev;
	struct gpio_desc desc = {};
	int ret;

	ret = uclass_get_device(UCLASS_GPIO, bank, &dev);
	if (ret)
		return ret;

	desc.dev = dev;
	desc.offset = pin;
	desc.flags = 0;
	ret = dm_gpio_request(&desc, "kh_bios_usb");
	if (ret && ret != -EBUSY)
		return ret;

	ret = dm_gpio_set_dir_flags(&desc, GPIOD_IS_OUT | GPIOD_IS_OUT_ACTIVE);
	if (ret)
		return ret;

	return dm_gpio_get_value(&desc);
}

/*
 * USB2 host 5V + HUB/port power for J98 etc. (kernel HDMI DTS GPIO map).
 * gpio-hog may run too late; drive explicitly before usb_init().
 */
int kh_bios_board_usb_power_on(void)
{
	struct udevice *dev;
	int ret, n = 0;
	static const struct {
		unsigned int bank;
		unsigned int pin;
		const char *label;
	} gpios[] = {
		{ 1, RK_PD3, "hub-en gpio1-D3" },
		{ 2, RK_PD0, "j34 gpio2-D0" },
		{ 2, RK_PD4, "j19 gpio2-D4" },
		{ 2, RK_PD5, "j17 gpio2-D5" },
		{ 2, RK_PD6, "j33 gpio2-D6" },
	};

	ret = regulator_get_by_platname("vcc5v0_host", &dev);
	if (!ret) {
		ret = regulator_set_enable(dev, true);
		printf("[kh_bios] rail vcc5v0_host: %s\n",
		       ret ? "enable failed" : "on");
		if (!ret)
			n++;
	} else {
		printf("[kh_bios] rail vcc5v0_host: not found (%d)\n", ret);
	}

	for (int i = 0; i < ARRAY_SIZE(gpios); i++) {
		ret = bios_gpio_out(gpios[i].bank, gpios[i].pin);
		printf("[kh_bios] %s: %s (read=%d)\n", gpios[i].label,
		       ret < 0 ? "fail" : "high", ret < 0 ? ret : ret);
		if (ret >= 0)
			n++;
	}

	return n ? 0 : -ENODEV;
}

static int board_boot_normal(void)
{
	int ret;

	ret = run_command("bootkhp", 0);
	if (ret) {
		printf("[kh_bios] bootkhp unavailable (%d), run bootcmd\n", ret);
		ret = run_command("bootcmd", 0);
	}
	return ret;
}

static int board_set_recovery_next(void)
{
#ifdef CONFIG_ANDROID_BOOTLOADER
	if (android_bcb_write("boot-recovery"))
		return -1;
#endif
	return 0;
}

static int board_fill_sys_info(char lines[][64], int max_lines)
{
	char mem[32], stor[32];
	int n = 0;

	if (!lines || max_lines <= 0)
		return 0;

	snprintf(lines[n], 64, "Board: %s", CONFIG_SYS_BOARD);
	n++;
	if (n >= max_lines)
		return n;

	snprintf(lines[n], 64, "SoC: %s", KH_BIOS_SOC_NAME);
	n++;
	if (n >= max_lines)
		return n;

	snprintf(lines[n], 64, "Firmware: U-Boot %s", U_BOOT_VERSION);
	n++;
	if (n >= max_lines)
		return n;

	if (gd->ram_size >= SZ_1G)
		snprintf(mem, sizeof(mem), "%lu MB (%lu GB)",
			 gd->ram_size >> 20, gd->ram_size >> 30);
	else
		snprintf(mem, sizeof(mem), "%lu MB", gd->ram_size >> 20);
	snprintf(lines[n], 64, "Memory: %s", mem);
	n++;
	if (n >= max_lines)
		return n;

	{
		struct blk_desc *desc = rockchip_get_bootdev();

		if (!desc)
			desc = blk_get_devnum_by_type(IF_TYPE_MMC, 0);
		if (desc)
			snprintf(stor, sizeof(stor), "%s %lu MB",
				 desc->if_type == IF_TYPE_MMC ? "eMMC" : "blk",
				 ((unsigned long)desc->lba * desc->blksz) >> 20);
		else
			snprintf(stor, sizeof(stor), "N/A");
	}
	snprintf(lines[n], 64, "Storage: %s", stor);
	n++;

	return n;
}

static int board_enter_fastboot(void)
{
	return run_command("fastboot usb 0", 0);
}

static int board_enter_download(void)
{
	return run_command("rockusb 0 ${devtype} ${devnum}", 0);
}

static const struct kh_bios_board_ops rk3568a_ops = {
	.product_name = KH_BIOS_PRODUCT_NAME,
	.soc_name = KH_BIOS_SOC_NAME,
	.features = KH_BIOS_PRODUCT_FEATURES,
	.default_delay_sec = KH_BIOS_DEFAULT_DELAY,
	.boot_normal = board_boot_normal,
	.set_recovery_next = board_set_recovery_next,
	.fill_sys_info = board_fill_sys_info,
	.enter_fastboot = board_enter_fastboot,
	.enter_download = board_enter_download,
};

const struct kh_bios_board_ops *kh_bios_board_ops(void)
{
	return &rk3568a_ops;
}
