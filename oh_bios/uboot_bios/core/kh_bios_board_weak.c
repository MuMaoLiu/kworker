/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * Default weak board ops (override in board/kh_bios_board.c)
 */

#include <common.h>
#include <command.h>
#include "kh_bios.h"
#include "kh_bios_board.h"

static int weak_boot_normal(void)
{
	printf("[kh_bios] ERROR: board ops boot_normal not implemented\n");
	return CMD_RET_FAILURE;
}

static const struct kh_bios_board_ops weak_ops = {
	.product_name = "Unknown Product",
	.soc_name = "Unknown SoC",
	.features = KH_BIOS_FEAT_BOOT_MENU,
	.default_delay_sec = KH_BIOS_DEFAULT_DELAY,
	.boot_normal = weak_boot_normal,
};

__weak const struct kh_bios_board_ops *kh_bios_board_ops(void)
{
	return &weak_ops;
}
