/* SPDX-License-Identifier: GPL-2.0+ */
#ifndef __KH_BIOS_ENV_H__
#define __KH_BIOS_ENV_H__

#include <stdbool.h>
#include "kh_bios.h"

void kh_bios_env_set_default_boot(int target);
int kh_bios_env_get_default_boot(void);
void kh_bios_env_set_once_recovery(bool enable);
bool kh_bios_env_get_once_recovery(void);
int kh_bios_env_get_delay(void);
int kh_bios_env_get_gmac(int idx);
void kh_bios_env_set_gmac(int idx, int enable);
int kh_bios_env_save(void);
void kh_bios_env_apply_boot_choice(void);

#endif
