/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_HOTKEY_H__
#define __KH_BIOS_HOTKEY_H__

#include <stdbool.h>
#include "kh_bios.h"

bool kh_bios_wait_f10(int delay_sec);
enum kh_bios_key kh_bios_poll_key(void);
void kh_bios_flush_input(void);
void kh_bios_usb_kbd_refresh(void);

#endif
