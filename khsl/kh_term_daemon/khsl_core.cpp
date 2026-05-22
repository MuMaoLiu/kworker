#include "khsl_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sched.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <sys/syscall.h>

#ifndef HOST_NAME_MAX
#define HOST_NAME_MAX 64
#endif

// 辅助函数：将字符串写入指定文件
static void write_file(const char* path, const char* val) {
    FILE* f = fopen(path, "w");
    if (f) {
        fprintf(f, "%s", val);
        fclose(f);
    } else {
        fprintf(stderr, "[KHTermDaemon] Failed to write %s to %s: %s\n", val, path, strerror(errno));
    }
}

// 辅助函数：从源文件读取内容并写入目标文件
static void copy_file_content(const char* src, const char* dst) {
    FILE* fs = fopen(src, "r");
    if (!fs) return;
    char buf[256] = {0};
    if (fgets(buf, sizeof(buf), fs)) {
        write_file(dst, buf);
    }
    fclose(fs);
}

void KhslApplyCgroups(pid_t pid) {
    // 1. 内存限制 (200MB = 209715200 bytes)
    const char* mem_dir = "/sys/fs/cgroup/memory/khsl";
    if (access(mem_dir, F_OK) != 0) {
        mkdir(mem_dir, 0755);
    }
    write_file("/sys/fs/cgroup/memory/khsl/memory.limit_in_bytes", "209715200");
    
    char pid_str[32];
    snprintf(pid_str, sizeof(pid_str), "%d", pid);
    write_file("/sys/fs/cgroup/memory/khsl/cgroup.procs", pid_str);

    // 2. CPU 限制 (cpuset)
    const char* cpuset_dir = "/sys/fs/cgroup/cpuset/khsl";
    if (access(cpuset_dir, F_OK) != 0) {
        if (mkdir(cpuset_dir, 0755) == 0) {
            // cpuset 必须先初始化 cpus 和 mems 才能加入进程
            copy_file_content("/sys/fs/cgroup/cpuset/cpuset.cpus", "/sys/fs/cgroup/cpuset/khsl/cpuset.cpus");
            copy_file_content("/sys/fs/cgroup/cpuset/cpuset.mems", "/sys/fs/cgroup/cpuset/khsl/cpuset.mems");
        }
    }
    write_file("/sys/fs/cgroup/cpuset/khsl/cgroup.procs", pid_str);
}

// 全局变量保存 default_user，在 KhslEnterUbuntuNamespace 中读取，在 KhslExecShell 中使用
static char g_default_user[256] = "root";

int KhslEnterUbuntuNamespace(void) {
    const char* rootfs_dir = "/data/khsl/rootfs";
    const char* img_path = "/data/khsl/ubuntu-22.04-arm64.img";
    struct stat st, st_parent;
    bool use_ubuntu = false;

    // 检查是否已经挂载 (通过比较设备号)
    if (stat(rootfs_dir, &st) == 0 && stat("/data/khsl", &st_parent) == 0) {
        if (st.st_dev == st_parent.st_dev) {
            // 尚未挂载，尝试自动挂载
            fprintf(stderr, "[KHTermDaemon] Rootfs not mounted, attempting to mount %s...\n", img_path);
            if (access(img_path, F_OK) == 0) {
                // 尝试直接 mount -o loop
                int ret = system("mount -t ext4 -o loop /data/khsl/ubuntu-22.04-arm64.img /data/khsl/rootfs");
                if (ret != 0) {
                    fprintf(stderr, "[KHTermDaemon] direct mount failed, trying manual losetup...\n");
                    // 寻找空闲 loop 并挂载
                    system("for i in 0 1 2 3 4 5 6 7 8 9; do if ! losetup /dev/block/loop$i >/dev/null 2>&1; then mknod /dev/block/loop$i b 7 $i 2>/dev/null; losetup /dev/block/loop$i /data/khsl/ubuntu-22.04-arm64.img && mount -t ext4 /dev/block/loop$i /data/khsl/rootfs && break; fi; done");
                }
            } else {
                fprintf(stderr, "[KHTermDaemon] Image file %s not found.\n", img_path);
            }
        }
    }
    
    if (stat(rootfs_dir, &st) == 0 && S_ISDIR(st.st_mode)) {
        char bin_bash[512];
        char bin_sh[512];
        char usr_bin_bash[512];
        char usr_bin_sh[512];
        snprintf(bin_bash, sizeof(bin_bash), "%s/bin/bash", rootfs_dir);
        snprintf(bin_sh, sizeof(bin_sh), "%s/bin/sh", rootfs_dir);
        snprintf(usr_bin_bash, sizeof(usr_bin_bash), "%s/usr/bin/bash", rootfs_dir);
        snprintf(usr_bin_sh, sizeof(usr_bin_sh), "%s/usr/bin/sh", rootfs_dir);
        
        if (access(bin_bash, X_OK) == 0 || access(bin_sh, X_OK) == 0 || 
            access(usr_bin_bash, X_OK) == 0 || access(usr_bin_sh, X_OK) == 0) {
            use_ubuntu = true;
            // 在 chroot 之前读取默认用户配置
            char default_user_path[512];
            snprintf(default_user_path, sizeof(default_user_path), "%s/var/lib/khsl_default_user", rootfs_dir);
            FILE* f = fopen(default_user_path, "r");
            if (f) {
                if (fgets(g_default_user, sizeof(g_default_user), f)) {
                    g_default_user[strcspn(g_default_user, "\r\n")] = 0; // 去除换行符
                }
                fclose(f);
            } else {
                // 如果文件不存在，标记为需要初始化
                strcpy(g_default_user, "");
            }
        } else {
            fprintf(stderr, "[KHTermDaemon] access(%s or %s, X_OK) failed: %s\n", usr_bin_bash, usr_bin_sh, strerror(errno));
        }
    } else {
        fprintf(stderr, "[KHTermDaemon] stat(%s) failed or not a dir: %s\n", rootfs_dir, strerror(errno));
    }

    if (use_ubuntu) {
        // --- 安全管控 Step 2: 网络隔离 (Network Namespace) ---
        if (unshare(CLONE_NEWNET) != 0) {
            fprintf(stderr, "[KHTermDaemon] Warning: unshare(CLONE_NEWNET) failed: %s\n", strerror(errno));
        } else {
            fprintf(stderr, "[KHTermDaemon] Network Namespace isolation enabled.\n");
        }

        // 1. unshare mount namespace 隔离宿主挂载表
        if (unshare(CLONE_NEWNS) != 0) {
            fprintf(stderr, "[KHTermDaemon] Warning: unshare(CLONE_NEWNS) failed: %s. Mounts may pollute host.\n", strerror(errno));
        } else {
            // 将根挂载点设为 MS_PRIVATE，防止 bind mount 影响全局
            if (mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr) != 0) {
                fprintf(stderr, "[KHTermDaemon] mount MS_PRIVATE failed: %s\n", strerror(errno));
            }
        }

        // 2. 挂载伪文件系统
        char target[512];
        snprintf(target, sizeof(target), "%s/proc", rootfs_dir);
        
        if (mount("proc", target, "proc", 0, nullptr) != 0) {
            fprintf(stderr, "[KHTermDaemon] mount new proc failed: %s, falling back to bind mount\n", strerror(errno));
            if (mount("/proc", target, nullptr, MS_BIND | MS_REC, nullptr) != 0) {
                fprintf(stderr, "[KHTermDaemon] bind mount proc failed: %s\n", strerror(errno));
            }
        }
    
        snprintf(target, sizeof(target), "%s/sys", rootfs_dir);
        if (mount("/sys", target, nullptr, MS_BIND | MS_REC, nullptr) != 0) {
            fprintf(stderr, "[KHTermDaemon] mount sys failed: %s\n", strerror(errno));
        }
        
        snprintf(target, sizeof(target), "%s/dev", rootfs_dir);
        if (mount("/dev", target, nullptr, MS_BIND | MS_REC, nullptr) != 0) {
            fprintf(stderr, "[KHTermDaemon] mount dev failed: %s\n", strerror(errno));
        }
        
        snprintf(target, sizeof(target), "%s/dev/pts", rootfs_dir);
        if (mount("/dev/pts", target, nullptr, MS_BIND | MS_REC, nullptr) != 0) {
            fprintf(stderr, "[KHTermDaemon] mount dev/pts failed: %s\n", strerror(errno));
        }

        // 3. pivot_root 进入 Ubuntu (比 chroot 更安全，防止逃逸)
        // 必须先将 rootfs_dir 变成一个独立的挂载点
        if (mount(rootfs_dir, rootfs_dir, "bind", MS_BIND | MS_REC, nullptr) != 0) {
            fprintf(stderr, "[KHTermDaemon] bind mount rootfs to itself failed: %s\n", strerror(errno));
        }

        char put_old[512];
        snprintf(put_old, sizeof(put_old), "%s/mnt", rootfs_dir);
        mkdir(put_old, 0755);
        
        // pivot_root 需要 new_root 是一个挂载点，我们前面已经 mount -t ext4 或 bind mount 过
        if (syscall(SYS_pivot_root, rootfs_dir, put_old) == 0) {
            chdir("/");
            // 卸载旧的宿主根文件系统
            if (umount2("/mnt", MNT_DETACH) != 0) {
                fprintf(stderr, "[KHTermDaemon] umount2(/mnt) failed: %s\n", strerror(errno));
            }
            rmdir("/mnt");
        } else {
            fprintf(stderr, "[KHTermDaemon] pivot_root failed: %s, falling back to chroot\n", strerror(errno));
            if (chroot(rootfs_dir) != 0) {
                fprintf(stderr, "[KHTermDaemon] chroot failed: %s\n", strerror(errno));
                use_ubuntu = false; // chroot 失败，回退到普通 shell
            } else {
                if (chdir("/") != 0) {
                    fprintf(stderr, "[KHTermDaemon] chdir(/) failed: %s\n", strerror(errno));
                }
            }
        }
    }
    
    return use_ubuntu ? 1 : 0;
}

static void child_set_prompt(void) {
    char hn[HOST_NAME_MAX + 1] = {0};
    if (gethostname(hn, sizeof(hn) - 1U) != 0) {
        snprintf(hn, sizeof(hn), "host");
    }

    char cwd[512];
    if (getcwd(cwd, sizeof(cwd)) == nullptr) {
        snprintf(cwd, sizeof(cwd), "/");
    }

    const int root = (geteuid() == 0);
    const char *who = root ? "root" : "user";
    const char pch = root ? '#' : '$';

    const char *term = getenv("TERM");
    const bool no_color =
        (term != nullptr && strcmp(term, "dumb") == 0) ||
        (getenv("NO_COLOR") != nullptr && getenv("NO_COLOR")[0] != '\0');

    char ps1[576];
    if (no_color) {
        snprintf(ps1, sizeof(ps1), "%s@%s:%s%c ", who, hn, cwd, pch);
    } else {
        snprintf(ps1, sizeof(ps1),
                "\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m%c ", who,
                hn, cwd, pch);
    }
    setenv("PS1", ps1, 1);
}

void KhslSetupEnvironment(int use_ubuntu) {
    setenv("HOME", use_ubuntu ? "/root" : "/", 1);
    setenv("USER", "root", 1);
    setenv("LOGNAME", "root", 1);
    setenv("TERM", "xterm-256color", 1);
    
    // 禁用 snap 相关的 apt hook 提示
    setenv("DISABLE_SNAP_APT_HOOK", "1", 1);
    // 避免 apt 安装时出现交互式提示框
    setenv("DEBIAN_FRONTEND", "noninteractive", 1);
    // 修复 apt-get update 时遇到的 GPG 错误
    setenv("APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE", "1", 1);
    // 禁用 dpkg-preconfigure
    setenv("DPKG_NO_PRECONFIGURE", "1", 1);
    // 禁用 debconf 交互
    setenv("DEBCONF_NONINTERACTIVE_SEEN", "true", 1);
}

void KhslExecShell(int use_ubuntu) {
    if (!use_ubuntu) {
        // 如果不使用 Ubuntu，降权为 shell 用户
        if (setgid(8876) != 0 || setuid(8876) != 0) {
            fprintf(stderr,
                    "[KHTermDaemon] child setgid/setuid failed: %s (euid=%d)\n",
                    strerror(errno), static_cast<int>(geteuid()));
        } else {
            (void)setgroups(0, nullptr);
        }
    }

    KhslSetupEnvironment(use_ubuntu);

    if (use_ubuntu) {
        // 启动 loopback 接口，确保 Ubuntu 内部至少有 127.0.0.1
        // 外部网络连通性需要宿主机配合创建 veth 并移入该 namespace
        system("ip link set lo up 2>/dev/null");
        
        setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);
        
        if (strlen(g_default_user) == 0) {
            // First time initialization
            const char* init_script = 
                "echo 'Installing, this may take a few minutes...'\n"
                "echo 'Please create a default UNIX user account. The username does not need to match your Windows username.'\n"
                "echo 'For more information visit: https://aka.ms/wslusers'\n"
                "while true; do\n"
                "    read -p 'Enter new UNIX username: ' username\n"
                "    if [[ ! \"$username\" =~ ^[a-z_][a-z0-9_-]*$ ]]; then\n"
                "        echo 'Invalid username. Please use only lowercase letters, digits, underscores, and hyphens.'\n"
                "        continue\n"
                "    fi\n"
                "    if id \"$username\" &>/dev/null; then\n"
                "        echo 'User already exists.'\n"
                "        continue\n"
                "    fi\n"
                "    useradd -m -s /bin/bash -G sudo,adm \"$username\"\n"
                "    if [ $? -ne 0 ]; then\n"
                "        echo 'Failed to create user.'\n"
                "        continue\n"
                "    fi\n"
                "    while true; do\n"
                "        read -s -p 'New password: ' pass1\n"
                "        echo\n"
                "        read -s -p 'Retype new password: ' pass2\n"
                "        echo\n"
                "        if [ \"$pass1\" != \"$pass2\" ]; then\n"
                "            echo 'Sorry, passwords do not match.'\n"
                "            continue\n"
                "        fi\n"
                "        echo \"$username:$pass1\" | chpasswd\n"
                "        if [ $? -eq 0 ]; then\n"
                "            echo 'passwd: password updated successfully'\n"
                "            break\n"
                "        else\n"
                "            echo 'Password setup failed. Try again.'\n"
                "        fi\n"
                "    done\n"
                "    echo \"$username\" > /var/lib/khsl_default_user\n"
                "    echo 'Installation successful!'\n"
                "    exec su - \"$username\"\n"
                "done\n";
            execl("/bin/bash", "bash", "-c", init_script, (char *)NULL);
            execl("/usr/bin/bash", "bash", "-c", init_script, (char *)NULL);
        } else if (strcmp(g_default_user, "root") != 0) {
            // 使用 su 切换到指定用户并启动 login shell
            execl("/bin/su", "su", "-", g_default_user, (char *)NULL);
            execl("/usr/bin/su", "su", "-", g_default_user, (char *)NULL);
        } else {
            // 尝试执行 bash，如果不存在则回退到 sh
            execl("/bin/bash", "bash", "-l", (char *)NULL);
            execl("/usr/bin/bash", "bash", "-l", (char *)NULL);
            execl("/bin/sh", "sh", "-l", (char *)NULL);
            execl("/usr/bin/sh", "sh", "-l", (char *)NULL);
        }
        fprintf(stderr, "[KHTermDaemon] execl ubuntu shell failed: %s\n", strerror(errno));
    } else {
        setenv("PATH", "/system/bin:/bin:/usr/bin:/vendor/bin", 1);
        child_set_prompt();
        execl("/system/bin/sh", "sh", "-i", (char *)NULL);
        execl("/bin/sh", "sh", "-i", (char *)NULL);
        fprintf(stderr, "[KHTermDaemon] execl sh failed: %s\n", strerror(errno));
    }
    _exit(127);
}
