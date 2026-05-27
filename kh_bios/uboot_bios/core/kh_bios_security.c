/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - Security page (HVB placeholder)
 */

#include <common.h>
#include <watchdog.h>
#include <linux/delay.h>

#include "kh_bios.h"
#include "kh_bios_hotkey.h"
#include "kh_bios_ui_draw.h"
#include "kh_bios_pages.h"

#ifdef CONFIG_HVB_LIBHVB
#define KH_SEC_STATUS	"HVB: enabled (bootloader)"
#else
#define KH_SEC_STATUS	"HVB: not configured (Phase 5)"
#endif

int kh_bios_page_security(void)
{
	enum kh_bios_key key;

	kh_bios_ui_draw_title("Security");
	kh_bios_ui_draw_line(0, 0, KH_SEC_STATUS, false);
	kh_bios_ui_draw_line(1, 0, "Secure Boot policy: read-only in v1", false);
	kh_bios_ui_draw_line(2, 0, "Use fastboot/CLI for unlock (future)", false);
	kh_bios_ui_draw_footer("Esc: Back");

	for (;;) {
		WATCHDOG_RESET();
		key = kh_bios_poll_key();
		if (key == KH_KEY_ESC || key == KH_KEY_ENTER)
			break;
		mdelay(10);
	}
	return KH_PAGE_MAIN;
}
