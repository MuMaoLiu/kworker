/* SPDX-License-Identifier: GPL-2.0+ */
#include <common.h>
#include <cli.h>
#include <command.h>
#include <linux/delay.h>

#include <asm/io.h>
#include <asm/arch/clock.h>
#include <asm/arch/cru_rk3568.h>

#include "kh_bios.h"
#include "kh_bios_board.h"
#include "kh_bios_env.h"
#include "kh_bios_ui_draw.h"

#if defined(CONFIG_ARM64) && defined(CONFIG_ARM_PSCI_FW)
#include <asm/system.h>
#endif

#define RK3568_CRU_BASE		0xFDD20000
#define RK3568_GLB_SRST_FST	(RK3568_CRU_BASE + 0xD4)
#define RK3568_SRST_MAGIC	0xfdb9

void kh_bios_prepare_boot_continue(void)
{
	/*
	 * Return VOP from BIOS FB (0x7d800000) to logo plane before bootcmd/booti.
	 * Avoids kernel drm-logo IOMM fault and POST_BUF_EMPTY after BIOS use.
	 */
	kh_bios_ui_display_restore();
}

static void kh_bios_hw_cold_reset(void)
{
	struct rk3568_cru *cru = rockchip_get_cru();

	/* Do not usb_stop(): tears down host1 and prints VBus errors if reset fails. */
	kh_bios_prepare_boot_continue();
	printf("[kh_bios] CRU cold reset\n");

	if (cru)
		writel(RK3568_SRST_MAGIC, &cru->glb_srst_fst);
	writel(RK3568_SRST_MAGIC, (void __iomem *)RK3568_GLB_SRST_FST);

	dsb();
	isb();

#if defined(CONFIG_ARM64) && defined(CONFIG_ARM_PSCI_FW)
	psci_system_reset();
#endif

	for (;;)
		;
}

void __weak kh_bios_board_force_reset(void)
{
	kh_bios_hw_cold_reset();
}

int kh_bios_boot_system(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	bool want_recovery;
	int ret;

	want_recovery = (kh_bios_env_get_default_boot() == KH_BOOT_RECOVERY) ||
			kh_bios_env_get_once_recovery();
	kh_bios_env_apply_boot_choice();

	if (want_recovery && ops && ops->set_recovery_next)
		ops->set_recovery_next();

	if (!ops || !ops->boot_normal)
		return CMD_RET_FAILURE;

	kh_bios_prepare_boot_continue();
	ret = ops->boot_normal();
	if (ret)
		printf("[kh_bios] boot_normal failed (%d)\n", ret);
	return ret;
}

void kh_bios_exit_reboot(bool config_saved)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	bool want_recovery;

	printf("[kh_bios] %s, cold reset now\n",
	       config_saved ? "configuration saved" : "exit without saving");

	if (config_saved) {
		want_recovery = (kh_bios_env_get_default_boot() == KH_BOOT_RECOVERY) ||
				kh_bios_env_get_once_recovery();
		kh_bios_env_apply_boot_choice();
		if (want_recovery && ops && ops->set_recovery_next)
			ops->set_recovery_next();
	}

	flushc();
	kh_bios_hw_cold_reset();
}

int kh_bios_enter_fastboot(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();

	if (ops && ops->enter_fastboot)
		return ops->enter_fastboot();
	return run_command("fastboot usb 0", 0);
}

int kh_bios_enter_rockusb(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();

	if (ops && ops->enter_download)
		return ops->enter_download();
	return run_command("rockusb 0 ${devtype} ${devnum}", 0);
}

int kh_bios_enter_cli(void)
{
	cli_loop();
	return 0;
}
