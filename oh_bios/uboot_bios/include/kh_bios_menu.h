/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_MENU_H__
#define __KH_BIOS_MENU_H__

#include "kh_bios.h"

enum kh_main_action {
	KH_MAIN_ACT_NONE = 0,
	KH_MAIN_ACT_INFO,
	KH_MAIN_ACT_SAVE_EXIT,
	KH_MAIN_ACT_DISCARD_EXIT,
};

struct kh_main_menu_item {
	const char *label;
	u32 required_feat;
	enum kh_bios_page page;
	enum kh_main_action action;
};

int kh_bios_menu_main_count(void);
const struct kh_main_menu_item *kh_bios_menu_main_item(int index);
int kh_bios_menu_adv_count(void);
const char *kh_bios_menu_adv_label(int index);
u32 kh_bios_menu_adv_feat(int index);

#endif
