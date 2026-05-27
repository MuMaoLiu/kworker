/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - table-driven menus (L2 common)
 */

#include <common.h>
#include "kh_bios_board.h"
#include "kh_bios_menu.h"

static const struct kh_main_menu_item main_menu_table[] = {
	{ "System Information", 0, KH_PAGE_MAIN, KH_MAIN_ACT_INFO },
	{ "Boot Configuration", KH_BIOS_FEAT_BOOT_MENU, KH_PAGE_BOOT, KH_MAIN_ACT_NONE },
	{ "Hardware Configuration", KH_BIOS_FEAT_HW_MENU, KH_PAGE_HARDWARE, KH_MAIN_ACT_NONE },
	{ "Security", KH_BIOS_FEAT_SECURITY, KH_PAGE_SECURITY, KH_MAIN_ACT_NONE },
	{ "Advanced", 0, KH_PAGE_ADVANCED, KH_MAIN_ACT_NONE },
	{ "Save Configuration and Exit", 0, KH_PAGE_MAIN, KH_MAIN_ACT_SAVE_EXIT },
	{ "Discard Changes and Exit", 0, KH_PAGE_MAIN, KH_MAIN_ACT_DISCARD_EXIT },
};

static const char *adv_labels[] = {
	"Enter Fastboot Mode",
	"Enter Rockusb Download",
	"U-Boot Command Line",
};

static const u32 adv_feats[] = {
	KH_BIOS_FEAT_FASTBOOT,
	KH_BIOS_FEAT_ROCKUSB,
	0,
};

static u32 board_features(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();

	if (ops)
		return ops->features;
	return 0;
}

static bool feat_ok(u32 required)
{
	u32 feat = board_features();

	if (!required)
		return true;
	return (feat & required) == required;
}

int kh_bios_menu_main_count(void)
{
	int n = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(main_menu_table); i++) {
		if (feat_ok(main_menu_table[i].required_feat))
			n++;
	}
	return n;
}

const struct kh_main_menu_item *kh_bios_menu_main_item(int index)
{
	int vis = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(main_menu_table); i++) {
		if (!feat_ok(main_menu_table[i].required_feat))
			continue;
		if (vis == index)
			return &main_menu_table[i];
		vis++;
	}
	return NULL;
}

int kh_bios_menu_adv_count(void)
{
	int n = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(adv_labels); i++) {
		if (feat_ok(adv_feats[i]))
			n++;
	}
	return n;
}

const char *kh_bios_menu_adv_label(int index)
{
	int vis = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(adv_labels); i++) {
		if (!feat_ok(adv_feats[i]))
			continue;
		if (vis == index)
			return adv_labels[i];
		vis++;
	}
	return NULL;
}

u32 kh_bios_menu_adv_feat(int index)
{
	int vis = 0;
	int i;

	for (i = 0; i < ARRAY_SIZE(adv_labels); i++) {
		if (!feat_ok(adv_feats[i]))
			continue;
		if (vis == index)
			return adv_feats[i];
		vis++;
	}
	return 0;
}
