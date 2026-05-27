/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - entry (L2 common core)
 */

#include <common.h>
#include <command.h>
#include <linux/errno.h>

#include "kh_bios.h"
#include "kh_bios_board.h"
#include "kh_bios_boot.h"
#include "kh_bios_hotkey.h"
#include "kh_bios_env.h"

/*
 * Strong symbol: overrides Rockchip __weak rk_board_late_init() in board.c.
 * (Two __weak definitions would coalesce to the empty board.c stub.)
 */
int rk_board_late_init(void)
{
	if (IS_ENABLED(CONFIG_KH_BIOS))
		kh_bios_boot_check();
	return 0;
}

int kh_bios_boot_check(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	int delay = kh_bios_env_get_delay();

	if (!ops) {
		printf("[kh_bios] no board ops\n");
		return -EINVAL;
	}

	printf("[kh_bios] %s %s (%s) setup %d sec, F10/USB-B or serial-B\n",
	       KH_BIOS_FW_TAG, ops->product_name, ops->soc_name, delay);

	if (kh_bios_wait_f10(delay)) {
		printf("[kh_bios] F10 detected, entering BIOS\n");
		kh_bios_run();
		kh_bios_prepare_boot_continue();
		return 0;
	}
	return 0;
}

static int do_kh_bios(cmd_tbl_t *cmdtp, int flag, int argc, char *const argv[])
{
	if (argc > 1 && !strcmp(argv[1], "check")) {
		kh_bios_boot_check();
		return CMD_RET_SUCCESS;
	}
	return kh_bios_run() ? CMD_RET_FAILURE : CMD_RET_SUCCESS;
}

U_BOOT_CMD(
	kh_bios, 2, 0, do_kh_bios,
	"KaihongOS BIOS setup utility (L2)",
	"[check] - F10 window or enter setup menu"
);
