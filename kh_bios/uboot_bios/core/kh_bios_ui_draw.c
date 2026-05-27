/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - Windows/AMI-style TUI (1920x1080 HDMI)
 */

#include <common.h>
#include <linux/errno.h>

#include "kh_bios_ui_draw.h"
#include "kh_bios_board.h"

#ifdef CONFIG_DRM_ROCKCHIP
#include <video.h>
#include <video_rockchip.h>
#endif

#ifdef CONFIG_DM_VIDEO
#include <dm.h>
#include <video_font.h>

static struct udevice *ui_vid;
static char ui_page_title[64];

#define BIOS_FB_W		1920
#define BIOS_FB_H		1080
#define BIOS_FONT_SCALE		2
#define BIOS_CHAR_W		(VIDEO_FONT_WIDTH * BIOS_FONT_SCALE)
#define BIOS_CHAR_H		(VIDEO_FONT_HEIGHT * BIOS_FONT_SCALE)

/* Classic PC BIOS / UEFI setup palette (ARGB8888) */
#define C_BLUE		0xff000080
#define C_BLUE_LT	0xff0000aa
#define C_GRAY		0xffc0c0c0
#define C_WHITE		0xffffffff
#define C_BLACK		0xff000000

#define PANEL_X		120
#define PANEL_Y		180
#define PANEL_W		920
#define PANEL_H		640
#define MENU_X		(PANEL_X + 24)
#define MENU_Y0		(PANEL_Y + 72)
#define MENU_DY		44
#define FOOTER_Y	980

static struct video_priv *bios_video_priv(void)
{
	if (!ui_vid && uclass_first_device_err(UCLASS_VIDEO, &ui_vid))
		return NULL;
	return ui_vid ? dev_get_uclass_priv(ui_vid) : NULL;
}

static void bios_video_sync(void)
{
	if (ui_vid)
		video_sync(ui_vid);
}

static void fb_fill_rect(struct video_priv *vp, int x, int y, int w, int h,
			 u32 color)
{
	int row, col;

	if (!vp || !vp->fb)
		return;
	for (row = y; row < y + h && row < vp->ysize; row++) {
		u32 *line = (u32 *)((u8 *)vp->fb + row * vp->line_length);

		if (row < 0)
			continue;
		for (col = x; col < x + w && col < vp->xsize; col++) {
			if (col >= 0)
				line[col] = color;
		}
	}
}

static void fb_frame(struct video_priv *vp, int x, int y, int w, int h,
		     u32 outer, u32 inner)
{
	fb_fill_rect(vp, x, y, w, 2, outer);
	fb_fill_rect(vp, x, y + h - 2, w, 2, outer);
	fb_fill_rect(vp, x, y, 2, h, outer);
	fb_fill_rect(vp, x + w - 2, y, 2, h, outer);
	fb_fill_rect(vp, x + 2, y + 2, w - 4, h - 4, inner);
}

static void draw_char_at(struct video_priv *vp, int x, int y, char ch,
			 u32 fg, u32 bg)
{
	int row, col;

	if (!vp || ch < 0 || ch >= VIDEO_FONT_CHARS)
		return;

	for (row = 0; row < VIDEO_FONT_HEIGHT; row++) {
		uchar bits = video_fontdata[(u8)ch * VIDEO_FONT_HEIGHT + row];

		for (col = 0; col < VIDEO_FONT_WIDTH; col++) {
			u32 color = (bits & 0x80) ? fg : bg;
			int px = x + col * BIOS_FONT_SCALE;
			int py = y + row * BIOS_FONT_SCALE;
			int i, j;

			for (j = 0; j < BIOS_FONT_SCALE; j++) {
				u32 *line;

				if (py + j >= vp->ysize || py + j < 0)
					continue;
				line = (u32 *)((u8 *)vp->fb +
					       (py + j) * vp->line_length);
				for (i = 0; i < BIOS_FONT_SCALE; i++) {
					if (px + i >= 0 && px + i < vp->xsize)
						line[px + i] = color;
				}
			}
			bits <<= 1;
		}
	}
}

static void draw_text(struct video_priv *vp, int x, int y, const char *s,
		      u32 fg, u32 bg)
{
	int i;

	if (!vp || !s)
		return;
	for (i = 0; s[i]; i++)
		draw_char_at(vp, x + i * BIOS_CHAR_W, y, s[i], fg, bg);
}

static void draw_chrome(struct video_priv *vp, const char *product,
			const char *page)
{
	/* Full screen blue background */
	fb_fill_rect(vp, 0, 0, BIOS_FB_W, BIOS_FB_H, C_BLUE);

	/* Top title bar (Windows Setup style) */
	fb_fill_rect(vp, 0, 0, BIOS_FB_W, 56, C_BLUE_LT);
	draw_text(vp, 24, 12, "KaihongOS Setup Utility", C_WHITE, C_BLUE_LT);
	if (product)
		draw_text(vp, 1200, 12, product, C_WHITE, C_BLUE_LT);
	if (page)
		draw_text(vp, 1600, 12, page, C_WHITE, C_BLUE_LT);

	/* Main gray panel with white inset */
	fb_frame(vp, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, C_WHITE, C_GRAY);
	fb_fill_rect(vp, PANEL_X + 4, PANEL_Y + 4, PANEL_W - 8, 48, C_BLUE);
	if (page)
		draw_text(vp, PANEL_X + 16, PANEL_Y + 12, page, C_WHITE, C_BLUE);

	/* Bottom help bar */
	fb_fill_rect(vp, 0, FOOTER_Y - 8, BIOS_FB_W, 88, C_BLUE_LT);
}

int kh_bios_ui_display_takeover(void)
{
#ifdef CONFIG_DRM_ROCKCHIP
	struct udevice *vid;
	struct video_uc_platdata *plat;
	struct video_priv *priv;

	if (uclass_first_device_err(UCLASS_VIDEO, &vid))
		return -ENODEV;

	ui_vid = vid;
	plat = dev_get_uclass_platdata(vid);
	priv = dev_get_uclass_priv(vid);
	if (!priv->fb)
		return -ENODEV;

	priv->xsize = BIOS_FB_W;
	priv->ysize = BIOS_FB_H;
	priv->bpix = VIDEO_BPP32;
	priv->line_length = priv->xsize * VNBYTES(priv->bpix);
	priv->fb_size = priv->line_length * priv->ysize;
	priv->colour_bg = C_BLUE;
	priv->colour_fg = C_WHITE;

	rockchip_show_fbbase_fmt(plat->base, BIOS_FB_W, BIOS_FB_H, 32);
	fb_fill_rect(priv, 0, 0, BIOS_FB_W, BIOS_FB_H, C_BLUE);

	video_set_flush_dcache(vid, true);
	video_sync(vid);
	printf("[kh_bios] HDMI FB %dx%d AMI-style UI\n", BIOS_FB_W, BIOS_FB_H);
	return 0;
#else
	return -ENODEV;
#endif
}

void kh_bios_ui_display_restore(void)
{
#ifdef CONFIG_DRM_ROCKCHIP
	struct udevice *vid;
	struct video_priv *priv;

	rockchip_show_logo();
	if (!uclass_first_device_err(UCLASS_VIDEO, &vid)) {
		priv = dev_get_uclass_priv(vid);
		if (priv && priv->fb)
			video_sync(vid);
	}
#endif
}

int kh_bios_ui_draw_init(void)
{
	return bios_video_priv() ? 0 : -ENODEV;
}

void kh_bios_ui_draw_clear(void)
{
	struct video_priv *vp = bios_video_priv();
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	const char *product = "KaihongOS";

	if (!vp)
		return;
	if (ops && ops->product_name)
		product = ops->product_name;
	draw_chrome(vp, product, ui_page_title[0] ? ui_page_title : "Main");
}

void kh_bios_ui_draw_title(const char *title)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	const char *product = "KaihongOS";
	struct video_priv *vp = bios_video_priv();

	if (!vp)
		return;
	if (ops && ops->product_name)
		product = ops->product_name;

	if (title) {
		snprintf(ui_page_title, sizeof(ui_page_title), "%s", title);
	} else {
		ui_page_title[0] = '\0';
	}

	draw_chrome(vp, product, title ? title : "Main");
	bios_video_sync();
}

void kh_bios_ui_draw_line(int row, int col, const char *text, bool highlight)
{
	char buf[128];
	struct video_priv *vp = bios_video_priv();
	int y = MENU_Y0 + row * MENU_DY;
	int x = MENU_X + col * BIOS_CHAR_W;
	u32 fg, bg;

	if (!vp || !text)
		return;

	if (highlight) {
		fb_fill_rect(vp, PANEL_X + 8, y - 4, PANEL_W - 16,
			     BIOS_CHAR_H + 8, C_BLUE);
		fg = C_WHITE;
		bg = C_BLUE;
		snprintf(buf, sizeof(buf), "  %s", text);
	} else {
		fg = C_BLACK;
		bg = C_GRAY;
		snprintf(buf, sizeof(buf), "  %s", text);
	}
	draw_text(vp, x, y, buf, fg, bg);
}

void kh_bios_ui_draw_footer(const char *hint)
{
	struct video_priv *vp = bios_video_priv();

	if (!hint)
		hint = "↑↓:Move   Enter:Select   Esc:Exit   F10:Save(setup)";
	if (!vp)
		return;
	draw_text(vp, 24, FOOTER_Y + 12, hint, C_WHITE, C_BLUE_LT);
	bios_video_sync();
}

#else /* !CONFIG_DM_VIDEO */

int kh_bios_ui_display_takeover(void) { return -ENODEV; }
void kh_bios_ui_display_restore(void) { }
int kh_bios_ui_draw_init(void) { return 0; }
void kh_bios_ui_draw_clear(void) { printf("\n\n"); }
void kh_bios_ui_draw_title(const char *title)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	const char *product = "KaihongOS";

	if (ops && ops->product_name)
		product = ops->product_name;
	printf("\n=== %s BIOS ===\n%s\n\n", product, title ? title : "");
}
void kh_bios_ui_draw_line(int row, int col, const char *text, bool highlight)
{
	printf("%s%s\n", highlight ? "> " : "  ", text ? text : "");
}
void kh_bios_ui_draw_footer(const char *hint)
{
	printf("\n%s\n", hint ? hint : "");
}

#endif
