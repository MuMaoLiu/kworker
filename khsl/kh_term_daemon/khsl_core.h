#ifndef KHSL_CORE_H
#define KHSL_CORE_H

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Apply Cgroups restrictions (Memory and CPU) to the given PID.
 */
void KhslApplyCgroups(pid_t pid);

/**
 * Perform namespace isolation, mount the Ubuntu rootfs, and chroot into it.
 * Returns 1 if successfully entered Ubuntu, 0 if it fell back to host shell.
 */
int KhslEnterUbuntuNamespace(void);

/**
 * Execute the appropriate shell (Ubuntu bash/sh or host sh) based on the 
 * result of KhslEnterUbuntuNamespace.
 * This function calls exec() and will not return on success.
 */
void KhslExecShell(int use_ubuntu);

/**
 * Set up environment variables required for the shell.
 */
void KhslSetupEnvironment(int use_ubuntu);

/**
 * Setup Network Namespace inside the guest.
 */
void KhslSetupGuestNetwork(void);

#ifdef __cplusplus
}
#endif

#endif // KHSL_CORE_H
