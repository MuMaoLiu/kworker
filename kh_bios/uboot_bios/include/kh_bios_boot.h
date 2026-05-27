/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_BOOT_H__
#define __KH_BIOS_BOOT_H__

int kh_bios_boot_system(void);
void kh_bios_prepare_boot_continue(void);
void kh_bios_exit_reboot(bool config_saved) __attribute__((noreturn));
void kh_bios_board_force_reset(void) __attribute__((noreturn));
int kh_bios_enter_fastboot(void);
int kh_bios_enter_rockusb(void);
int kh_bios_enter_cli(void);

#endif
