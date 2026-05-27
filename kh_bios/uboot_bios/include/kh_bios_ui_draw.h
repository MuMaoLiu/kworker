/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_UI_DRAW_H__
#define __KH_BIOS_UI_DRAW_H__

#include <stdbool.h>

/* Switch VOP from resource logo BMP to U-Boot FB (call before drawing menu). */
int kh_bios_ui_display_takeover(void);
void kh_bios_ui_display_restore(void);
int kh_bios_ui_draw_init(void);
void kh_bios_ui_draw_clear(void);
void kh_bios_ui_draw_title(const char *title);
void kh_bios_ui_draw_line(int row, int col, const char *text, bool highlight);
void kh_bios_ui_draw_footer(const char *hint);

#endif
