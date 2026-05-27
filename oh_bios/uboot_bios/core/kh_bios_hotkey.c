/* SPDX-License-Identifier: GPL-2.0+ */
/*
 * KaihongOS U-Boot BIOS - USB F10 hotkey detection (L2 common)
 */

#include <common.h>
#include <console.h>
#include <environment.h>
#include <debug_uart.h>
#include <serial.h>
#include <watchdog.h>
#include <linux/delay.h>
#include <stdio_dev.h>

#if CONFIG_IS_ENABLED(CONSOLE_MUX)
#include <iomux.h>
#endif

#ifdef CONFIG_USB_KEYBOARD
#include <usb.h>
#endif
#ifdef CONFIG_DM_KEY
#include <key.h>
#include <linux/input.h>
#endif
#ifdef CONFIG_ADC
#include <adc.h>
#endif
#include <dm.h>

/* Board may enable USB hub/port power (GPIO/regulators) before usb_init() */
int __weak kh_bios_board_usb_power_on(void)
{
	return 0;
}

#include "kh_bios.h"
#include "kh_bios_hotkey.h"

#ifdef CONFIG_DM_VIDEO
#include <video_console.h>
#endif

#define F10_SEQ		"\x1b[21~"
#define F10_SEQ_LEN	5

static int f10_match;
static int usb_kbd_ready;
static struct udevice *bios_uart_dev;

/*
 * Rockchip leaves gd->cur_serial_dev NULL when using pre-serial (PreSerial: 2).
 * debug_uart_init() was skipped, so RX may be dead. Probe UART2 or init debug UART.
 */
/* Setup stdin mux only; do NOT touch setbrg here (breaks RX later). */
static void bios_serial_init(void)
{
	if (!bios_uart_dev && gd->cur_serial_dev)
		bios_uart_dev = gd->cur_serial_dev;

	if (!bios_uart_dev)
		uclass_get_device_by_seq(UCLASS_SERIAL, 2, &bios_uart_dev);

	if (bios_uart_dev) {
		char stdin_cfg[48];

		snprintf(stdin_cfg, sizeof(stdin_cfg), "%s,usbkbd",
			 bios_uart_dev->name);
		env_set("stdin", stdin_cfg);
#if CONFIG_IS_ENABLED(CONSOLE_MUX)
		if (!iomux_doenv(stdin, stdin_cfg))
			printf("[kh_bios] stdin mux: %s\n", stdin_cfg);
#endif
	}
}

/* Call after USB init: re-open RX and drain garbage (stuck uart_rx=1). */
static void bios_serial_rx_arm(void)
{
#if CONFIG_IS_ENABLED(DEBUG_UART)
	int flushed = 0;
	char c;

	debug_uart_init();
	mdelay(20);
	while (debug_uart_tstc() && flushed < 64) {
		c = debug_uart_getc();
		printf("[kh_bios] uart flush 0x%02x\n", c);
		flushed++;
	}
	printf("[kh_bios] UART RX ready @0x%lx %u baud, flushed %d\n",
	       gd->serial.addr ? (ulong)gd->serial.addr :
	       (ulong)CONFIG_DEBUG_UART_BASE, gd->baudrate, flushed);
	printf("[kh_bios] press B during countdown (not during USB init)\n");
#endif
}

static bool bios_stdin_tstc(void)
{
#if CONFIG_IS_ENABLED(DEBUG_UART)
	return debug_uart_tstc() != 0;
#else
	if (bios_uart_dev && serial_dev_tstc(bios_uart_dev))
		return true;
	return false;
#endif
}

static char bios_stdin_getc(void)
{
#if CONFIG_IS_ENABLED(DEBUG_UART)
	return debug_uart_getc();
#else
	if (bios_uart_dev && serial_dev_tstc(bios_uart_dev))
		return serial_dev_getc(bios_uart_dev);
	return 0;
#endif
}

static bool bios_board_key_tstc(void)
{
#ifdef CONFIG_ADC
	unsigned int val;

	if (!adc_channel_single_shot("saradc", 0, &val) && val <= 30) {
		printf("[kh_bios] volume/recovery key (adc=%u)\n", val);
		return true;
	}
#endif
#ifdef CONFIG_DM_KEY
	if (key_is_pressed(key_read(KEY_VOLUMEUP)))
		return true;
#endif
	return false;
}

static void esc_state_reset(void)
{
	f10_match = 0;
}

static bool esc_state_feed(char c)
{
	if (c == F10_SEQ[f10_match]) {
		f10_match++;
		if (f10_match >= F10_SEQ_LEN) {
			f10_match = 0;
			return true;
		}
	} else {
		f10_match = (c == F10_SEQ[0]) ? 1 : 0;
	}
	return false;
}

#ifdef CONFIG_DM_VIDEO
static struct udevice *bios_con;

static void bios_draw_countdown(int sec)
{
	char line[64];
	int y;

	if (!bios_con) {
		if (uclass_first_device_err(UCLASS_VIDEO_CONSOLE, &bios_con))
			bios_con = NULL;
	}

	if (!bios_con)
		return;

	y = 620;
	snprintf(line, sizeof(line), "                    ");
	for (int i = 0; line[i]; i++)
		vidconsole_putc_xy(bios_con, VID_TO_POS(40 + i * 8), y, line[i]);

	snprintf(line, sizeof(line), "F10 or B (USB/UART) %2d ", sec);
	for (int i = 0; line[i]; i++)
		vidconsole_putc_xy(bios_con, VID_TO_POS(40 + i * 8), y, line[i]);
}
#else
static void bios_draw_countdown(int sec)
{
	printf("\r[kh_bios] F10 (USB) or B (serial) (%2d) ", sec);
}
#endif

/*
 * Rockchip boards use stdin=serial,usbkbd with CONSOLE_MUX, but DM registers
 * the UART as "serial@..." not "serial", leaving cd_count[stdin]==0 so tstc()
 * never sees keys. Read UART (and usbkbd) directly instead.
 */
static bool bios_usb_key_tstc(void)
{
	struct stdio_dev *dev = stdio_get_by_name("usbkbd");

	if (!dev || !dev->tstc)
		return false;

	return dev->tstc(dev) > 0;
}

static char bios_usb_key_getc(void)
{
	struct stdio_dev *dev = stdio_get_by_name("usbkbd");

	if (!dev || !dev->getc)
		return 0;

	return dev->getc(dev);
}

/* Drain UART + USB for B / F10 enter-setup hotkeys. */
static bool bios_drain_enter_keys(void)
{
	bool enter = false;

	while (bios_stdin_tstc()) {
		char c = bios_stdin_getc();

		if (c == 'b' || c == 'B')
			enter = true;
		if (esc_state_feed(c))
			enter = true;
	}

	while (usb_kbd_ready && bios_usb_key_tstc()) {
		char c = bios_usb_key_getc();

		if (c == 'b' || c == 'B')
			enter = true;
		if (esc_state_feed(c))
			enter = true;
	}

	return enter;
}

static bool bios_key_tstc(void)
{
	if (bios_board_key_tstc())
		return true;
	if (bios_stdin_tstc())
		return true;
	if (usb_kbd_ready && bios_usb_key_tstc())
		return true;

	return false;
}

static char bios_key_getc(void)
{
	if (usb_kbd_ready && bios_usb_key_tstc())
		return bios_usb_key_getc();
	if (bios_stdin_tstc())
		return bios_stdin_getc();

	return 0;
}

/* Non-blocking: usbkbd may appear slightly after usb_init(). */
static int bios_usb_kbd_attach(void)
{
	if (usb_kbd_ready)
		return 0;

	if (!stdio_get_by_name("usbkbd"))
		return -ENODEV;

	usb_kbd_ready = 1;
	printf("[kh_bios] USB keyboard ready\n");
	return 0;
}

static int bios_usb_keyboard_start(void)
{
#ifdef CONFIG_USB_KEYBOARD
	int ret;

	printf("[kh_bios] initializing USB (host 5V / hub)...\n");
	kh_bios_board_usb_power_on();
	mdelay(800);
	ret = usb_init();
	if (ret) {
		printf("[kh_bios] usb init failed (%d), serial B still works\n", ret);
		return ret;
	}
#if !CONFIG_IS_ENABLED(DM_USB)
	ret = drv_usb_kbd_init();
	if (ret)
		return ret;
#endif
	/* Hub/kbd may enumerate a bit late; brief wait once (not each countdown sec). */
	{
		int i;

		for (i = 0; i < 120 && bios_usb_kbd_attach(); i++)
			mdelay(50);
	}
	if (!usb_kbd_ready)
		printf("[kh_bios] no USB keyboard, use serial B for BIOS\n");
#else
	printf("[kh_bios] USB keyboard disabled, press B on serial for BIOS\n");
#endif
	return 0;
}

enum kh_bios_key kh_bios_poll_key(void)
{
	char c;

	if (bios_board_key_tstc())
		return KH_KEY_F10;

	if (!bios_key_tstc())
		return KH_KEY_NONE;

	c = bios_key_getc();

	if (esc_state_feed(c))
		return KH_KEY_F10;

	if (c == 0x1b) {
		if (!bios_key_tstc())
			return KH_KEY_ESC;
		c = bios_key_getc();
		if (c == '[') {
			if (!bios_key_tstc())
				return KH_KEY_ESC;
			c = bios_key_getc();
			if (c == 'A')
				return KH_KEY_UP;
			if (c == 'B')
				return KH_KEY_DOWN;
			if (c == 'C')
				return KH_KEY_RIGHT;
			if (c == 'D')
				return KH_KEY_LEFT;
		}
		return KH_KEY_ESC;
	}

	if (c == '\r' || c == '\n')
		return KH_KEY_ENTER;

	if (c == 'b' || c == 'B')
		return KH_KEY_F10;

	return KH_KEY_NONE;
}

void kh_bios_flush_input(void)
{
	esc_state_reset();
	while (bios_key_tstc())
		(void)bios_key_getc();
}

void kh_bios_usb_kbd_refresh(void)
{
	bios_usb_kbd_attach();
}

bool kh_bios_wait_f10(int delay_sec)
{
	int sec = delay_sec;
	ulong start;

	esc_state_reset();
	usb_kbd_ready = 0;

	printf("[kh_bios] USB init then %d sec for F10/USB-B or serial-B\n",
	       delay_sec);
	bios_serial_init();

	/* USB power + enumeration before the visible countdown. */
	bios_usb_keyboard_start();
	bios_serial_rx_arm();

	start = get_timer(0);
	while (sec >= 0) {
		enum kh_bios_key key;

		WATCHDOG_RESET();

		bios_draw_countdown(sec);
		printf("[kh_bios] enter BIOS: F10/B, %d sec (usb=%d uart=%d)\n",
		       sec, usb_kbd_ready, bios_stdin_tstc() ? 1 : 0);

		if (bios_drain_enter_keys())
			return true;

		if (!usb_kbd_ready)
			bios_usb_kbd_attach();

		while (get_timer(start) < 1000) {
			bios_usb_kbd_attach();
			if (bios_board_key_tstc())
				return true;
			if (bios_drain_enter_keys())
				return true;
			key = kh_bios_poll_key();
			if (key == KH_KEY_F10)
				return true;
			if (key == KH_KEY_ENTER || key == KH_KEY_ESC)
				return false;
			mdelay(1);
		}
		start = get_timer(0);
		sec--;
	}

#ifndef CONFIG_DM_VIDEO
	printf("\n");
#endif
	return false;
}
