/* SPDX-License-Identifier: GPL-2.0+ */
#include <common.h>
#include <environment.h>
#include <command.h>

#include "kh_bios.h"
#include "kh_bios_board.h"
#include "kh_bios_env.h"

#define ENV_DEFAULT_BOOT	"kh_default_boot"
#define ENV_ONCE_RECOVERY	"kh_once_recovery"
#define ENV_GMAC0		"kh_gmac0"
#define ENV_GMAC1		"kh_gmac1"
#define ENV_BIOS_DELAY		"kh_bios_delay"

static int env_get_boot_target(void)
{
	const char *v = env_get(ENV_DEFAULT_BOOT);

	if (v && !strcmp(v, "recovery"))
		return KH_BOOT_RECOVERY;
	return KH_BOOT_NORMAL;
}

void kh_bios_env_set_default_boot(int target)
{
	env_set(ENV_DEFAULT_BOOT,
		target == KH_BOOT_RECOVERY ? "recovery" : "normal");
}

int kh_bios_env_get_default_boot(void)
{
	return env_get_boot_target();
}

void kh_bios_env_set_once_recovery(bool enable)
{
	if (enable)
		env_set(ENV_ONCE_RECOVERY, "1");
	else
		env_set(ENV_ONCE_RECOVERY, "0");
}

bool kh_bios_env_get_once_recovery(void)
{
	const char *v = env_get(ENV_ONCE_RECOVERY);

	return v && v[0] == '1';
}

int kh_bios_env_get_delay(void)
{
	const struct kh_bios_board_ops *ops = kh_bios_board_ops();
	const char *v = env_get(ENV_BIOS_DELAY);
	long d = KH_BIOS_DEFAULT_DELAY;

	if (ops && ops->default_delay_sec > 0)
		d = ops->default_delay_sec;

	if (v) {
		long e = simple_strtol(v, NULL, 10);

		if (e >= 0 && e <= 30 && e != d)
			printf("[kh_bios] ignore kh_bios_delay=%ld, use %ld sec\n",
			       e, d);
	}

	return (int)d;
}

int kh_bios_env_get_gmac(int idx)
{
	const char *v = env_get(idx ? ENV_GMAC1 : ENV_GMAC0);

	if (!v || v[0] == '1')
		return 1;
	return 0;
}

void kh_bios_env_set_gmac(int idx, int enable)
{
	env_set(idx ? ENV_GMAC1 : ENV_GMAC0, enable ? "1" : "0");
}

int kh_bios_env_save(void)
{
	return env_save() ? CMD_RET_FAILURE : CMD_RET_SUCCESS;
}

void kh_bios_env_apply_boot_choice(void)
{
	if (kh_bios_env_get_once_recovery()) {
		kh_bios_env_set_once_recovery(false);
		env_set("reboot_mode", "recovery");
	}
}
