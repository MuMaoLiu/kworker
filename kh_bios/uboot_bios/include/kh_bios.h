/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS (L2 common)
 * Copyright (c) 2026 Shenzhen Kaihong Digital Industry Development Co., Ltd.
 */

#ifndef __KH_BIOS_H__
#define __KH_BIOS_H__

#include <stdbool.h>

#define KH_BIOS_DEFAULT_DELAY	3
/* Change when rebuilding; visible on serial to confirm flashed image */
#define KH_BIOS_FW_TAG		"kh_bios-20260527-r4"

enum kh_bios_key {
	KH_KEY_NONE = 0,
	KH_KEY_UP,
	KH_KEY_DOWN,
	KH_KEY_LEFT,
	KH_KEY_RIGHT,
	KH_KEY_ENTER,
	KH_KEY_ESC,
	KH_KEY_F10,
};

enum kh_bios_boot_target {
	KH_BOOT_NORMAL = 0,
	KH_BOOT_RECOVERY,
};

enum kh_bios_page {
	KH_PAGE_MAIN = 0,
	KH_PAGE_BOOT,
	KH_PAGE_HARDWARE,
	KH_PAGE_SECURITY,
	KH_PAGE_ADVANCED,
	KH_PAGE_COUNT,
};

enum kh_bios_exit {
	KH_EXIT_REBOOT_SAVE = 0,
	KH_EXIT_CANCEL = 1,
	KH_EXIT_ADV = 2,
	KH_EXIT_REBOOT_DISCARD = 3,
};

int kh_bios_boot_check(void);
int kh_bios_run(void);
int kh_bios_boot_system(void);
void kh_bios_exit_reboot(bool config_saved) __attribute__((noreturn));

#endif /* __KH_BIOS_H__ */
