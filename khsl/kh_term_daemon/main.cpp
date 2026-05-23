#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
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
#include <sys/prctl.h>
#include <sched.h>

#include "khsl_core.h"

#define SOCKET_PATH "\0kh_term_socket"
#define KDLOG(fmt, ...) fprintf(stderr, "[KHTermDaemon] " fmt "\n", ##__VA_ARGS__)

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

        // --- 安全管控 Step 1: IPC 通信层安全 (Socket 鉴权) ---
        struct ucred cred;
        socklen_t len = sizeof(struct ucred);
        if (getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) == 0) {
            // 仅允许 root (0) 和 shell (2000) 用户连接
            if (cred.uid != 0 && cred.uid != 2000) {
                KDLOG("Security Alert: Rejecting connection from unauthorized UID %d", cred.uid);
                close(client_fd);
                continue;
            }
        } else {
            KDLOG("Warning: Failed to get peer credentials: %s", strerror(errno));
            close(client_fd);
            continue;
        }

        KDLOG("client connected (UID: %d, PID: %d), handling connection...", cred.uid, cred.pid);

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
        // 注意：屏蔽 SIGCHLD 会导致 waitpid 失败 (ECHILD)，从而导致 apt/dpkg 报错
        signal(SIGCHLD, SIG_DFL);

        // --- 安全管控 Step 4: User Namespace (防逃逸) ---
        // 尝试隔离 User Namespace，将 Ubuntu 内的 root 映射为宿主机的普通用户
        // 注意：这需要内核支持 CONFIG_USER_NS。如果不支持，unshare 会失败，我们继续执行。
        /*
        if (unshare(CLONE_NEWUSER) == 0) {
            // 映射 UID 0 -> 100000
            int fd = open("/proc/self/uid_map", O_WRONLY);
            if (fd >= 0) {
                write(fd, "0 100000 1\n", 11);
                close(fd);
            }
            // 映射 GID 0 -> 100000
            fd = open("/proc/self/setgroups", O_WRONLY);
            if (fd >= 0) {
                write(fd, "deny", 4);
                close(fd);
            }
            fd = open("/proc/self/gid_map", O_WRONLY);
            if (fd >= 0) {
                write(fd, "0 100000 1\n", 11);
                close(fd);
            }
            KDLOG("User Namespace isolation enabled.");
        } else {
            KDLOG("Warning: unshare(CLONE_NEWUSER) failed: %s (Kernel might not support it)", strerror(errno));
        }
        */

        int sync_pipe1[2]; // Child to Parent (I have unshared)
        int sync_pipe2[2]; // Parent to Child (I have written maps)
        if (pipe(sync_pipe1) < 0 || pipe(sync_pipe2) < 0) {
            KDLOG("pipe failed: %s", strerror(errno));
        }

        if (unshare(CLONE_NEWPID) != 0) {
            KDLOG("Warning: unshare(CLONE_NEWPID) failed: %s", strerror(errno));
        }

        int master_fd;
        pid_t pid = forkpty(&master_fd, nullptr, nullptr, &ws);

        if (pid < 0) {
            KDLOG("forkpty failed: %d (%s)", errno, strerror(errno));
            close(client_fd);
            exit(1);
        } else if (pid > 0) {
            // I/O 转发进程 (Parent)
            close(sync_pipe1[1]);
            close(sync_pipe2[0]);

            char c;
            if (read(sync_pipe1[0], &c, 1) == 1) {
                // Child has unshared. Write UID/GID maps from the parent (which has CAP_SETUID/GID)
                // 1:1 mapping for all 65536 UIDs/GIDs so that root in container is root on host
                // This avoids permission denied errors when accessing host files (like /proc, /sys, /dev)
                char path[256];
                snprintf(path, sizeof(path), "/proc/%d/uid_map", pid);
                int fd = open(path, O_WRONLY);
                if (fd >= 0) { 
                    write(fd, "0 0 65536\n", 10); 
                    close(fd); 
                } else {
                    KDLOG("Failed to open uid_map: %s", strerror(errno));
                }

                snprintf(path, sizeof(path), "/proc/%d/setgroups", pid);
                fd = open(path, O_WRONLY);
                if (fd >= 0) {
                    write(fd, "deny", 4);
                    close(fd);
                }

                snprintf(path, sizeof(path), "/proc/%d/gid_map", pid);
                fd = open(path, O_WRONLY);
                if (fd >= 0) { 
                    write(fd, "0 0 65536\n", 10); 
                    close(fd); 
                } else {
                    KDLOG("Failed to open gid_map: %s", strerror(errno));
                }
            }
            close(sync_pipe1[0]);

            // Tell child to continue
            write(sync_pipe2[1], "1", 1);
            close(sync_pipe2[1]);

            // 为 shell 子进程应用 Cgroups 限制
            KhslApplyCgroups(pid);
            
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
            // 子进程 (Child)
            close(sync_pipe1[0]);
            close(sync_pipe2[1]);

            // --- 安全管控 Step 4: User Namespace (防逃逸) ---
            if (unshare(CLONE_NEWUSER) == 0) {
                KDLOG("User Namespace unshared.");
            } else {
                KDLOG("Warning: unshare(CLONE_NEWUSER) failed: %s", strerror(errno));
            }

            // Tell parent we unshared
            write(sync_pipe1[1], "1", 1);
            close(sync_pipe1[1]);

            // Wait for parent to write maps
            char c;
            read(sync_pipe2[0], &c, 1);
            close(sync_pipe2[0]);

            // 调用核心逻辑隔离并进入 Ubuntu
            int use_ubuntu = KhslEnterUbuntuNamespace();
            KhslExecShell(use_ubuntu);
            _exit(127); // 不应该执行到这里
        }
    }

    close(server_fd);
    return 0;
}
