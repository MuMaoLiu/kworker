#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pty.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <grp.h>
#include <limits.h>
#include <sys/types.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <termios.h>
#include <sys/prctl.h>

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

static void apply_cgroups(pid_t pid) {
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

#define SOCKET_PATH "\0kh_term_socket"

#define KDLOG(fmt, ...) fprintf(stderr, "[KHTermDaemon] " fmt "\n", ##__VA_ARGS__)

#ifndef HOST_NAME_MAX
#define HOST_NAME_MAX 64
#endif

/*
 * OH 镜像里常见的 /system/bin/sh 若未打开 BusyBox 的 PS1 反斜杠展开，
 * 使用 "\\w \\# " 会得到字面 「\w \#」而非路径与 「#」。在 exec 前用
 * cwd、主机名拼出 PS1；路径在会话内 cd 后不会自动随目录更新（除非你
 * 换用支持 PS1 \\w 的 shell 编译选项）。
 */
static void child_set_prompt(void) {
  char hn[HOST_NAME_MAX + 1]{};
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

int main() {
  // 视觉伪装：修改进程名，防止被轻易发现
  prctl(PR_SET_NAME, "kworker/u4:2", 0, 0, 0);

  KDLOG("starting...");

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) {
    KDLOG("Failed to create socket: %d (%s)", errno, strerror(errno));
    return 1;
  }

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  // 使用抽象命名空间，避免文件权限问题
  memcpy(addr.sun_path, SOCKET_PATH, sizeof(SOCKET_PATH));

  if (bind(server_fd, (struct sockaddr *)&addr,
          sizeof(sa_family_t) + sizeof(SOCKET_PATH)) < 0) {
    KDLOG("Failed to bind socket: %d (%s)", errno, strerror(errno));
    close(server_fd);
    return 1;
  }

  if (listen(server_fd, 5) < 0) {
    KDLOG("Failed to listen: %d (%s)", errno, strerror(errno));
    close(server_fd);
    return 1;
  }

  KDLOG("listening on abstract socket...");

  // 忽略 SIGCHLD 信号，防止产生僵尸进程
  signal(SIGCHLD, SIG_IGN);

  while (1) {
    int client_fd = accept(server_fd, nullptr, nullptr);
    if (client_fd < 0) {
      KDLOG("Failed to accept: %d (%s)", errno, strerror(errno));
      continue;
    }

    KDLOG("client connected, handling connection...");

    pid_t conn_pid = fork();
    if (conn_pid < 0) {
      KDLOG("fork failed: %d (%s)", errno, strerror(errno));
      close(client_fd);
      continue;
    } else if (conn_pid > 0) {
      // 主守护进程：关闭客户端 socket，继续 accept 下一个连接
      close(client_fd);
      continue;
    }

    // --- 以下为连接处理子进程 ---
    close(server_fd); // 子进程不需要监听 socket

    // 读取客户端发送的初始窗口大小
    struct winsize ws;
    if (read(client_fd, &ws, sizeof(ws)) != sizeof(ws)) {
        ws.ws_row = 24;
        ws.ws_col = 80;
    }

    // 隔离 PID namespace。调用后，下一个 fork 的子进程将成为新 namespace 的 PID 1
    // 需要确保在 forkpty 之前调用
    // 注意：屏蔽 SIGCHLD 会导致 waitpid 失败 (ECHILD)，从而导致 apt/dpkg 报错
    signal(SIGCHLD, SIG_DFL);
    
    // 禁用 snap 相关的 apt hook 提示，避免 apt 安装时出现 snap 错误
    setenv("DISABLE_SNAP_APT_HOOK", "1", 1);
    // 避免 apt 安装时出现交互式提示框
    setenv("DEBIAN_FRONTEND", "noninteractive", 1);
    // 修复 apt-get update 时遇到的 GPG 错误，忽略警告
    setenv("APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE", "1", 1);
    // 禁用 dpkg-preconfigure
    setenv("DPKG_NO_PRECONFIGURE", "1", 1);
    // 禁用 debconf 交互
    setenv("DEBCONF_NONINTERACTIVE_SEEN", "true", 1);

    if (unshare(CLONE_NEWPID) != 0) {
        KDLOG("Warning: unshare(CLONE_NEWPID) failed: %s", strerror(errno));
    }

    int master_fd;
    // 注意：这里不再传递 orig_termios，因为守护进程本身没有终端
    // 终端属性由连接过来的 khsl 客户端负责设置
    pid_t pid = forkpty(&master_fd, nullptr, nullptr, &ws);

    if (pid < 0) {
        KDLOG("forkpty failed: %d (%s)", errno, strerror(errno));
        close(client_fd);
        exit(1);
    } else if (pid > 0) {
        // I/O 转发进程：为 shell 子进程应用 Cgroups 限制
        apply_cgroups(pid);
        
        // 设置非阻塞
        int flags = fcntl(master_fd, F_GETFL, 0);
        fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
        flags = fcntl(client_fd, F_GETFL, 0);
        fcntl(client_fd, F_SETFL, flags | O_NONBLOCK);

        struct pollfd pfds[2];
        pfds[0].fd = client_fd;
        pfds[0].events = POLLIN;
        pfds[1].fd = master_fd;
        pfds[1].events = POLLIN;

        char buffer[4096];
        bool running = true;

        while (running) {
            int ret = poll(pfds, 2, -1);
            if (ret < 0) {
                if (errno == EINTR) continue;
                break;
            }

            // 从客户端读取并写入 PTY
            if (pfds[0].revents & POLLIN) {
                ssize_t n = read(client_fd, buffer, sizeof(buffer));
                if (n > 0) {
                    write(master_fd, buffer, static_cast<size_t>(n));
                } else if (n <= 0 && errno != EAGAIN) {
                    running = false;
                }
            }

            // 从 PTY 读取并写入客户端
            if (pfds[1].revents & POLLIN) {
                ssize_t n = read(master_fd, buffer, sizeof(buffer));
                if (n > 0) {
                    write(client_fd, buffer, static_cast<size_t>(n));
                } else if (n <= 0 && errno != EAGAIN) {
                    running = false;
                }
            }
        }

        close(client_fd);
        close(master_fd);
        kill(pid, SIGKILL);
        waitpid(pid, nullptr, 0);
        KDLOG("session ended.");
        exit(0); // 连接处理进程退出
    } else {
        // 子进程
        // --- Ubuntu Chroot 隔离与挂载逻辑 ---
        const char* rootfs_dir = "/data/khsl/rootfs";
        const char* img_path = "/data/khsl/ubuntu-22.04-arm64.img";
        struct stat st, st_parent;
        bool use_ubuntu = false;
        char default_user[256] = "root";

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
            // 在 Ubuntu 根目录下，通常有 /bin/bash 或者 /bin/sh
            // 极简 ubuntu-base 有时可能只带了 /bin/sh (指向 dash 或 bash)
            // 注意：/bin 可能是指向 usr/bin 的绝对路径软链接，导致在 chroot 前 access 失败
            // 因此我们同时检查 /usr/bin/bash 和 /usr/bin/sh
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
                    if (fgets(default_user, sizeof(default_user), f)) {
                        default_user[strcspn(default_user, "\r\n")] = 0; // 去除换行符
                    }
                    fclose(f);
                } else {
                    // 如果文件不存在，标记为需要初始化
                    strcpy(default_user, "");
                }
            } else {
                fprintf(stderr, "[KHTermDaemon] access(%s or %s, X_OK) failed: %s\n", usr_bin_bash, usr_bin_sh, strerror(errno));
            }
        } else {
            fprintf(stderr, "[KHTermDaemon] stat(%s) failed or not a dir: %s\n", rootfs_dir, strerror(errno));
        }

        if (use_ubuntu) {
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
            
            // 挂载全新的 procfs，配合 CLONE_NEWPID 实现彻底的进程隔离
            // 注意：在某些内核配置下，如果当前进程不是 PID 1，挂载全新的 proc 可能会失败。
            // 我们尝试挂载全新的，如果失败则回退到 bind mount 宿主机的 proc
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

        // 3. chroot 进入 Ubuntu
        if (chroot(rootfs_dir) != 0) {
            fprintf(stderr, "[KHTermDaemon] chroot failed: %s\n", strerror(errno));
            use_ubuntu = false; // chroot 失败，回退到普通 shell
        } else {
            if (chdir("/") != 0) {
                fprintf(stderr, "[KHTermDaemon] chdir(/) failed: %s\n", strerror(errno));
            }
        }
    }
    // ------------------------------------
    /* euid：决定提示符末尾 # 还是 $ */
    // 如果不使用 Ubuntu，或者 chroot 失败回退到了 host，我们需要降权为 shell 用户
    // 如果进入了 Ubuntu，我们保持 root 权限，因为后续可能会用 su 切换用户
    if (!use_ubuntu) {
        if (setgid(8876) != 0 || setuid(8876) != 0) {
          fprintf(stderr,
                  "[KHTermDaemon] child setgid/setuid failed: %s (euid=%d)\n",
                  strerror(errno), static_cast<int>(geteuid()));
        } else {
          (void)setgroups(0, nullptr);
        }
    }

    setenv("HOME", use_ubuntu ? "/root" : "/", 1);
    setenv("USER", "root", 1);
    setenv("LOGNAME", "root", 1);
    setenv("TERM", "xterm-256color", 1);
    
    if (use_ubuntu) {
        // 已经提前在 chroot 之前读取了 default_user
        setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);
        
        if (strlen(default_user) == 0) {
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
                "    useradd -m -s /bin/bash -G sudo,adm \"$username\" >/dev/null 2>&1\n"
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
        } else if (strcmp(default_user, "root") != 0) {
            // 使用 su 切换到指定用户并启动 login shell
            execl("/bin/su", "su", "-", default_user, (char *)NULL);
            execl("/usr/bin/su", "su", "-", default_user, (char *)NULL);
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
        /* -i：交互；避免 login(-l) 读 profile 改坏 PS1。PATH/HOME 已注入 */
        execl("/system/bin/sh", "sh", "-i", (char *)NULL);
        execl("/bin/sh", "sh", "-i", (char *)NULL);
        fprintf(stderr, "[KHTermDaemon] execl sh failed: %s\n", strerror(errno));
    }
    _exit(127);
  }
  }

  close(server_fd);
  return 0;
}
