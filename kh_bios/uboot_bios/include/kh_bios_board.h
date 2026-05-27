/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_BOARD_H__
#define __KH_BIOS_BOARD_H__

#include <linux/types.h>

#define KH_BIOS_FEAT_BOOT_MENU	(1 << 0)
#define KH_BIOS_FEAT_HW_MENU	(1 << 1)
#define KH_BIOS_FEAT_SECURITY	(1 << 2)
#define KH_BIOS_FEAT_FASTBOOT	(1 << 3)
#define KH_BIOS_FEAT_ROCKUSB	(1 << 4)

#define KH_BIOS_HW_INFO_LINES	8
#define KH_BIOS_HW_TOGGLE_MAX	8

struct kh_bios_board_ops {
	const char *product_name;
	const char *soc_name;
	u32 features;
	int default_delay_sec;

	int (*boot_normal)(void);
	int (*set_recovery_next)(void);
	/* Fill system info lines; return count written */
	int (*fill_sys_info)(char lines[][64], int max_lines);
	/* Hardware page: return line count; toggle by index */
	int (*fill_hw_lines)(char lines[][64], int max_lines);
	int (*hw_toggle_item)(int index);
	int (*enter_fastboot)(void);
	int (*enter_download)(void);
};

const struct kh_bios_board_ops *kh_bios_board_ops(void);

#endif
