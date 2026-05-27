/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * khdvk_rk3568_a - KaihongOS U-Boot BIOS product config (L2 thin layer)
 */

#ifndef __KH_BIOS_PRODUCT_H__
#define __KH_BIOS_PRODUCT_H__

#include "kh_bios_board.h"

#define KH_BIOS_PRODUCT_NAME	"KHDVK RK3568-A"
#define KH_BIOS_SOC_NAME	"RK3568"
#define KH_BIOS_DEFAULT_DELAY	3

#define KH_BIOS_PRODUCT_FEATURES \
	(KH_BIOS_FEAT_BOOT_MENU | \
	 KH_BIOS_FEAT_HW_MENU | \
	 KH_BIOS_FEAT_SECURITY | \
	 KH_BIOS_FEAT_FASTBOOT | \
	 KH_BIOS_FEAT_ROCKUSB)

#endif
