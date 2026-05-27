/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - menu UI (L2 common, board ops)
 */

#include <common.h>
#include <watchdog.h>
#include <linux/delay.h>

#include "kh_bios.h"
#include "kh_bios_board.h"
#include "kh_bios_pages.h"
#include "kh_bios_ui_draw.h"
#include "kh_bios_hotkey.h"
#include "kh_bios_env.h"
#include "kh_bios_boot.h"
#include "kh_bios_menu.h"

struct kh_bios_ctx {
	bool dirty;
	int default_boot;
	bool once_recovery;
	int gmac0;
	int gmac1;
};

static struct kh_bios_ctx bios_ctx;

static void ctx_load(void)
{
	bios_ctx.default_boot = kh_bios_env_get_default_boot();
	bios_ctx.once_recovery = kh_bios_env_get_once_recovery();
	bios_ctx.gmac0 = kh_bios_env_get_gmac(0);
	bios_ctx.gmac1 = kh_bios_env_get_gmac(1);
	bios_ctx.dirty = false;
}

static void ctx_save_all(void)
{
	kh_bios_env_set_default_boot(bios_ctx.default_boot);
	kh_bios_env_set_once_recovery(bios_ctx.once_recovery);
	kh_bios_env_set_gmac(0, bios_ctx.gmac0);
	kh_bios_env_set_gmac(1, bios_ctx.gmac1);
	kh_bios_env_save();
	bios_ctx.dirty = false;
}

static void show_sys_info(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	char lines[KH_BIOS_HW_INFO_LINES][64];
	int n = 0;
	int i;

	if (ops && ops->fill_sys_info)
		n = ops->fill_sys_info(lines, KH_BIOS_HW_INFO_LINES);

	kh_bios_ui_draw_title("System Information");
	for (i = 0; i < n; i++)
		kh_bios_ui_draw_line(i, 0, lines[i], false);
	if (!n)
		kh_bios_ui_draw_line(0, 0, "(no board system info)", false);
	kh_bios_ui_draw_footer("Press any key...");
	while (kh_bios_poll_key() == KH_KEY_NONE) {
		WATCHDOG_RESET();
		mdelay(10);
	}
}

static int page_main(struct kh_bios_ctx *ctx, int *exit_code)
{
	int count = kh_bios_menu_main_count();
	int sel = 0;
	enum kh_bios_key key;

	for (;;) {
		kh_bios_ui_draw_title("Main");
		for (int i = 0; i < count; i++) {
			const struct kh_main_menu_item *item =
				kh_bios_menu_main_item(i);

			if (item)
				kh_bios_ui_draw_line(i, 0, item->label, i == sel);
		}
		kh_bios_ui_draw_footer("Up/Down: Select  Enter: OK  Esc: Exit");

		key = KH_KEY_NONE;
		while (key == KH_KEY_NONE) {
			WATCHDOG_RESET();
			kh_bios_usb_kbd_refresh();
			key = kh_bios_poll_key();
			mdelay(10);
		}

		if (key == KH_KEY_UP && sel > 0)
			sel--;
		else if (key == KH_KEY_DOWN && sel < count - 1)
			sel++;
		else if (key == KH_KEY_ESC) {
			kh_bios_exit_reboot(false);
		} else if (key == KH_KEY_ENTER) {
			const struct kh_main_menu_item *item =
				kh_bios_menu_main_item(sel);

			if (!item)
				continue;
			switch (item->action) {
			case KH_MAIN_ACT_INFO:
				show_sys_info();
				break;
			case KH_MAIN_ACT_SAVE_EXIT:
				ctx_save_all();
				kh_bios_exit_reboot(true);
				break;
			case KH_MAIN_ACT_DISCARD_EXIT:
				kh_bios_exit_reboot(false);
				break;
			default:
				return item->page;
			}
		}
	}
}

static int page_boot(struct kh_bios_ctx *ctx)
{
	const char *items[KH_BOOT_ITEMS] = {
		"Default: KaihongOS (Normal)",
		"Default: Recovery",
		"Boot Recovery once (next reset)",
	};
	int sel = ctx->default_boot;
	enum kh_bios_key key;

	for (;;) {
		char mark[96];

		kh_bios_ui_draw_title("Boot Configuration");
		snprintf(mark, sizeof(mark), "%s%s", items[0],
			 ctx->default_boot == KH_BOOT_NORMAL ? "  [*]" : "");
		kh_bios_ui_draw_line(0, 0, mark, sel == 0);
		snprintf(mark, sizeof(mark), "%s%s", items[1],
			 ctx->default_boot == KH_BOOT_RECOVERY ? "  [*]" : "");
		kh_bios_ui_draw_line(1, 0, mark, sel == 1);
		snprintf(mark, sizeof(mark), "%s%s", items[2],
			 ctx->once_recovery ? "  [ON]" : "  [OFF]");
		kh_bios_ui_draw_line(2, 0, mark, sel == 2);
		kh_bios_ui_draw_footer("Enter: Toggle/Select  Esc: Back");

		key = KH_KEY_NONE;
		while (key == KH_KEY_NONE) {
			WATCHDOG_RESET();
			kh_bios_usb_kbd_refresh();
			key = kh_bios_poll_key();
			mdelay(10);
		}

		if (key == KH_KEY_UP && sel > 0)
			sel--;
		else if (key == KH_KEY_DOWN && sel < KH_BOOT_ITEMS - 1)
			sel++;
		else if (key == KH_KEY_ESC)
			return KH_PAGE_MAIN;
		else if (key == KH_KEY_ENTER) {
			ctx->dirty = true;
			if (sel == 0)
				ctx->default_boot = KH_BOOT_NORMAL;
			else if (sel == 1)
				ctx->default_boot = KH_BOOT_RECOVERY;
			else
				ctx->once_recovery = !ctx->once_recovery;
		}
	}
}

static int page_hardware(struct kh_bios_ctx *ctx)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	char lines[KH_BIOS_HW_TOGGLE_MAX][64];
	int line_count = 2;
	int sel = 0;
	enum kh_bios_key key;

	if (ops && ops->fill_hw_lines)
		line_count = ops->fill_hw_lines(lines, KH_BIOS_HW_TOGGLE_MAX);
	if (line_count <= 0)
		line_count = 2;

	for (;;) {
		if (!ops || !ops->fill_hw_lines) {
			snprintf(lines[0], sizeof(lines[0]),
				 "GMAC0: %s (toggle)",
				 ctx->gmac0 ? "Enabled" : "Disabled");
			snprintf(lines[1], sizeof(lines[1]),
				 "GMAC1: %s (toggle)",
				 ctx->gmac1 ? "Enabled" : "Disabled");
		}

		kh_bios_ui_draw_title("Hardware Configuration");
		for (int i = 0; i < line_count; i++)
			kh_bios_ui_draw_line(i, 0, lines[i], sel == i);
		kh_bios_ui_draw_footer("Enter: Toggle  Esc: Back");

		key = KH_KEY_NONE;
		while (key == KH_KEY_NONE) {
			WATCHDOG_RESET();
			kh_bios_usb_kbd_refresh();
			key = kh_bios_poll_key();
			mdelay(10);
		}

		if (key == KH_KEY_UP && sel > 0)
			sel--;
		else if (key == KH_KEY_DOWN && sel < line_count - 1)
			sel++;
		else if (key == KH_KEY_ESC)
			return KH_PAGE_MAIN;
		else if (key == KH_KEY_ENTER) {
			ctx->dirty = true;
			if (ops && ops->hw_toggle_item) {
				ops->hw_toggle_item(sel);
				ctx->gmac0 = kh_bios_env_get_gmac(0);
				ctx->gmac1 = kh_bios_env_get_gmac(1);
			} else if (sel == 0) {
				ctx->gmac0 = !ctx->gmac0;
			} else {
				ctx->gmac1 = !ctx->gmac1;
			}
		}
	}
}

static int page_advanced(int *exit_code)
{
	int count = kh_bios_menu_adv_count();
	int sel = 0;
	enum kh_bios_key key;

	for (;;) {
		kh_bios_ui_draw_title("Advanced");
		for (int i = 0; i < count; i++) {
			const char *label = kh_bios_menu_adv_label(i);

			if (label)
				kh_bios_ui_draw_line(i, 0, label, i == sel);
		}
		kh_bios_ui_draw_footer("Enter: Execute  Esc: Back");

		key = KH_KEY_NONE;
		while (key == KH_KEY_NONE) {
			WATCHDOG_RESET();
			kh_bios_usb_kbd_refresh();
			key = kh_bios_poll_key();
			mdelay(10);
		}

		if (key == KH_KEY_UP && sel > 0)
			sel--;
		else if (key == KH_KEY_DOWN && sel < count - 1)
			sel++;
		else if (key == KH_KEY_ESC)
			return KH_PAGE_MAIN;
		else if (key == KH_KEY_ENTER) {
			u32 feat = kh_bios_menu_adv_feat(sel);

			if (feat == KH_BIOS_FEAT_FASTBOOT) {
				kh_bios_enter_fastboot();
				*exit_code = KH_EXIT_ADV;
				return -1;
			}
			if (feat == KH_BIOS_FEAT_ROCKUSB) {
				kh_bios_enter_rockusb();
				*exit_code = KH_EXIT_ADV;
				return -1;
			}
			kh_bios_enter_cli();
		}
	}
}

int kh_bios_run(void)
{
	int page = KH_PAGE_MAIN;
	int exit_code = 0;

	printf("[kh_bios] setup menu active (%s)\n", KH_BIOS_FW_TAG);
	ctx_load();
	if (kh_bios_ui_display_takeover())
		printf("[kh_bios] HDMI unavailable, use serial for menu text\n");
	kh_bios_ui_draw_init();
	kh_bios_flush_input();
	kh_bios_usb_kbd_refresh();

	while (page >= 0) {
		switch (page) {
		case KH_PAGE_MAIN:
			page = page_main(&bios_ctx, &exit_code);
			break;
		case KH_PAGE_BOOT:
			page = page_boot(&bios_ctx);
			break;
		case KH_PAGE_HARDWARE:
			page = page_hardware(&bios_ctx);
			break;
		case KH_PAGE_SECURITY:
			page = kh_bios_page_security();
			break;
		case KH_PAGE_ADVANCED:
			page = page_advanced(&exit_code);
			break;
		default:
			page = -1;
			break;
		}
	}

	return 0;
}
