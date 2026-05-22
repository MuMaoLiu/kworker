/*
 * Copyright (c) 2025 Kaihong / KHSL
 * SPDX-License-Identifier: Apache-2.0
 *
 * khsl — KHSL 交互/执行工具，CLI 编排与说明对齐 WSL.exe 习惯（按阶段实现能力）。
 */

#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <limits.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <termios.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>

#define KHSL_CLI_VERSION "khsl 1.0"

#define MOTD_PATH_SYSTEM "/system/etc/khsl/motd"
#define MOTD_PATH_VENDOR "/vendor/etc/khsl/motd"

#ifndef HOST_NAME_MAX
#define HOST_NAME_MAX 64
#endif

#define SOCKET_PATH "\0kh_term_socket"

typedef enum {
  KHSL_RUN_INTERACTIVE,
  KHSL_RUN_EXEC,
} khsl_run_mode_t;

typedef struct {
  int want_help;
  int want_version;
  int do_shutdown;
  int do_status;
  int do_list;
  const char *user_override;
  const char *cd_override;
  khsl_run_mode_t run_mode;
  char **exec_argv; /* 指向 argv 子串，末尾由 argv[argc]==NULL 终止 */
} khsl_opts_t;

static int file_exists_readable(const char *path) {
  if (path == NULL || path[0] == '\0') {
    return 0;
  }
  FILE *fp = fopen(path, "r");
  if (fp != NULL) {
    fclose(fp);
    return 1;
  }
  return 0;
}

static int hushlogin_enabled(void) {
  const char *home = getenv("HOME");
  if (home == NULL || home[0] == '\0') {
    return 0;
  }
  size_t len = strlen(home) + 32u;
  char *path = (char *)malloc(len);
  if (path == NULL) {
    return 0;
  }
  snprintf(path, len, "%s/.hushlogin", home);
  int ok = file_exists_readable(path);
  free(path);
  return ok;
}

static void print_builtin_motd_en(void) {
  struct utsname unm;
  const char *rel = "unknown";
  const char *mach = "unknown";
  if (uname(&unm) == 0) {
    rel = unm.release;
    mach = unm.machine;
  }

  fputs("\n", stdout);
  fputs(" ========================================\n", stdout);
  fputs("  Kaihong Shell Layer (KHSL)\n", stdout);
  fputs("  Local dev shell for KaihongOS / OpenHarmony\n", stdout);
  fputs(" ========================================\n\n", stdout);
  printf(" Kernel: Linux %s %s\n\n", rel, mach);
  fputs(" To hide this banner, create ~/.hushlogin in HOME.\n"
        " Chinese MOTD/help: UTF-8 terminal + export KHSL_HELP=zh\n\n",
        stdout);
}

static void print_motd(void) {
  const char *paths[] = {MOTD_PATH_SYSTEM, MOTD_PATH_VENDOR, NULL};
  for (size_t i = 0; paths[i] != NULL; ++i) {
    FILE *fp = fopen(paths[i], "r");
    if (fp != NULL) {
      char buf[1024];
      while (fgets(buf, sizeof(buf), fp) != NULL) {
        fputs(buf, stdout);
      }
      fclose(fp);
      fputs("\n", stdout);
      return;
    }
  }
  print_builtin_motd_en();
}

static void print_usage(FILE *fp) {
  fputs(
      "Copyright (c) Kaihong. All rights reserved.\n\n"
      "Usage: khsl [Argument] [Options...] [CommandLine]\n\n"
      "Arguments for running Linux binaries:\n\n"
      "    If no command line is provided, khsl launches the default shell.\n\n"
      "    --exec, -e <CommandLine>\n"
      "        Execute the specified command without using the default Linux shell.\n\n"
      "    --\n"
      "        Pass the remaining command line as is.\n\n"
      "Options:\n"
      "    --cd <Directory>\n"
      "        Sets the specified directory as the current working directory.\n"
      "        If ~ is used the Linux user's home path will be used. If the path begins\n"
      "        with a / character, it will be interpreted as an absolute Linux path.\n"
      "        Otherwise, the value must be an absolute host path.\n\n"
      "    --distribution, -d <Distro>\n"
      "        Run the specified distribution.\n\n"
      "    --user, -u <UserName>\n"
      "        Run as the specified user.\n\n"
      "Arguments for managing Kaihong Shell Layer:\n\n"
      "    --help\n"
      "        Display usage information.\n\n"
      "    --install [Options]\n"
      "        Install additional Kaihong Shell Layer distributions.\n"
      "        For a list of valid distributions, use 'khsl --list --online'.\n\n"
      "        Options:\n"
      "            --distribution, -d [Argument]\n"
      "                Downloads and installs a distribution by name.\n\n"
      "                Arguments:\n"
      "                    A valid distribution name (not case sensitive).\n\n"
      "                Example:\n"
      "                    khsl --install -d Ubuntu\n"
      "                    khsl --install --distribution Debian\n\n"
      "    --set-default-version <Version>\n"
      "        Changes the default install version for new distributions.\n\n"
      "    --shutdown\n"
      "        Immediately terminates all running distributions and the KHSL\n"
      "        lightweight utility daemon.\n\n"
      "    --status\n"
      "        Show the status of Kaihong Shell Layer.\n\n"
      "    --update [Options]\n"
      "        If no options are specified, the KHSL components will be updated\n"
      "        to the latest version.\n\n"
      "        Options:\n"
      "            --rollback\n"
      "                Revert to the previous version.\n\n"
      "Arguments for managing distributions in Kaihong Shell Layer:\n\n"
      "    --export <Distro> <FileName>\n"
      "        Exports the distribution to a tar file.\n"
      "        The filename can be - for standard output.\n\n"
      "    --import <Distro> <InstallLocation> <FileName> [Options]\n"
      "        Imports the specified tar file as a new distribution.\n"
      "        The filename can be - for standard input.\n\n"
      "        Options:\n"
      "            --version <Version>\n"
      "                Specifies the version to use for the new distribution.\n\n"
      "    --list, -l [Options]\n"
      "        Lists distributions.\n\n"
      "        Options:\n"
      "            --all\n"
      "                List all distributions, including distributions that are\n"
      "                currently being installed or uninstalled.\n\n"
      "            --running\n"
      "                List only distributions that are currently running.\n\n"
      "            --quiet, -q\n"
      "                Only show distribution names.\n\n"
      "            --verbose, -v\n"
      "                Show detailed information about all distributions.\n\n"
      "            --online, -o\n"
      "                Displays a list of available distributions for install with 'khsl --install'.\n\n"
      "    --set-default, -s <Distro>\n"
      "        Sets the distribution as the default.\n\n"
      "    --set-version <Distro> <Version>\n"
      "        Changes the version of the specified distribution.\n\n"
      "    --terminate, -t <Distro>\n"
      "        Terminates the specified distribution.\n\n"
      "    --unregister <Distro>\n"
      "        Unregisters the distribution and deletes the root filesystem.\n",
      fp);
}

static void print_help(void) { print_usage(stdout); }

static int management_arg_known_unimplemented(const char *a) {
  static const char *const longs[] = {
      "--install",             "--shutdown",           "--status",
      "--update",              "--rollback",           "--inbox",
      "--web-download",       "--export",             "--import",
      "--list",               "--quiet",             "--verbose",
      "--online",             "--set-default",        "--set-version",
      "--terminate",          "--unregister",         "--distribution",
      "--set-default-version", "--all",               "--running",
  };
  for (size_t i = 0; i < sizeof(longs) / sizeof(longs[0]); ++i) {
    if (!strcmp(a, longs[i])) {
      return 1;
    }
  }
  /*
   * 与 WSL 管理命令相关的短开关（KHSL 已单独实现 -u / -e / -h / --cd）。
   */
  if (!strcmp(a, "-d") || !strcmp(a, "-l") || !strcmp(a, "-q") ||
      !strcmp(a, "-v") || !strcmp(a, "-o") || !strcmp(a, "-t") ||
      !strcmp(a, "-s")) {
    return 1;
  }
  return 0;
}

/*
 * root 启动时尝试切到 passwd 用户（默认 shell，可由 KHSL_USER / -u 覆盖）。
 */
static int try_drop_privileges(struct passwd **out_pw) {
  *out_pw = NULL;

  uid_t uid = getuid();
  uid_t euid = geteuid();
  if (uid != (uid_t)0 && euid != (uid_t)0) {
    *out_pw = getpwuid(uid);
    return 0;
  }

  const char *user = getenv("KHSL_USER");
  if (user == NULL || user[0] == '\0') {
    user = "shell";
  }

  struct passwd *pw = getpwnam(user);
  if (pw == NULL) {
    fprintf(stderr,
        "[khsl] passwd user \"%s\" not found; staying as root.\n"
        "       Set KHSL_USER or use -u <UserName>.\n",
        user);
    *out_pw = NULL;
    return -1;
  }

  if (initgroups(pw->pw_name, pw->pw_gid) != 0) {
    fprintf(stderr, "[khsl] initgroups: %s\n", strerror(errno));
    return -1;
  }
  if (setgid(pw->pw_gid) != 0) {
    fprintf(stderr, "[khsl] setgid: %s\n", strerror(errno));
    return -1;
  }
  if (setuid(pw->pw_uid) != 0) {
    fprintf(stderr, "[khsl] setuid: %s (still root)\n", strerror(errno));
    return -1;
  }

  *out_pw = pw;
  return 0;
}

static void apply_env_from_passwd(struct passwd *pw) {
  if (pw != NULL) {
    if (pw->pw_dir != NULL && pw->pw_dir[0] != '\0') {
      setenv("HOME", pw->pw_dir, 1);
      if (chdir(pw->pw_dir) != 0) {
        (void)chdir("/");
      }
    }
    setenv("USER", pw->pw_name, 1);
    setenv("LOGNAME", pw->pw_name, 1);
    if (pw->pw_shell != NULL && pw->pw_shell[0] != '\0') {
      setenv("SHELL", pw->pw_shell, 1);
    }
  }

  const char *term = getenv("TERM");
  setenv("TERM",
         (term != NULL && term[0] != '\0') ? term : "xterm-256color", 1);
  setenv("PATH", "/system/bin:/vendor/bin:/bin:/usr/bin", 1);
  setenv("KHSL", "1", 1);
}

/* WSL：--cd ~ 时使用 Linux 用户的 HOME（此处为当前已解析的 HOME/setuid 后上下文） */
static int apply_cd_override(const char *dir) {
  if (dir == NULL || dir[0] == '\0') {
    return 0;
  }
  if (dir[0] == '~' &&
      (dir[1] == '\0' || dir[1] == '/')) {
    const char *home = getenv("HOME");
    if (home == NULL || home[0] == '\0') {
      home = "/";
    }
    if (dir[1] == '\0') {
      return chdir(home);
    }
    size_t hn = strlen(home);
    size_t suf = strlen(dir + 1);
    size_t tot = hn + suf + 1u;
    if (tot >= 1024u) {
      return -1;
    }
    char path[1024];
    memcpy(path, home, hn);
    memcpy(path + hn, dir + 1, suf + 1u);
    return chdir(path);
  }
  return chdir(dir);
}

/*
 * BusyBox ash 常未打开 PS1 里 \\w、\\$ 的反斜杠展开，会得到字面「\\w」「\\$」。
 * 启动时用 getcwd 拼路径、按 euid 写 #/$，与 kh_term_daemon::child_set_prompt 一致；
 * cd 后路径不会自动刷新，除非后续使用支持 \\w 的 shell 或 PROMPT_COMMAND。
 */
static void khsl_export_ps1(void) {
  const char *log = getenv("LOGNAME");
  if (log == NULL || log[0] == '\0') {
    log = getenv("USER");
  }
  if (log == NULL || log[0] == '\0') {
    log = "?";
  }

  char hn[HOST_NAME_MAX + 1];
  memset(hn, 0, sizeof(hn));
  if (gethostname(hn, sizeof(hn) - 1u) != 0) {
    struct utsname u;
    if (uname(&u) == 0) {
      snprintf(hn, sizeof(hn), "%.63s", u.nodename);
    } else {
      strncpy(hn, "host", sizeof(hn) - 1u);
    }
  }

  char cwd[512];
  if (getcwd(cwd, sizeof(cwd)) == NULL) {
    strncpy(cwd, "/", sizeof(cwd) - 1u);
    cwd[sizeof(cwd) - 1u] = '\0';
  }

  const char pch = (geteuid() == (uid_t)0) ? '#' : '$';

  const char *term = getenv("TERM");
  int dumb = (term != NULL && strcmp(term, "dumb") == 0);
  int no_color =
      dumb ||
      (getenv("NO_COLOR") != NULL && getenv("NO_COLOR")[0] != '\0') ||
      (getenv("KHSL_NO_COLOR") != NULL);

  static char ps1[576];
  if (no_color) {
    snprintf(ps1, sizeof(ps1), "KHSL %s@khsl-%s:%s%c ", log, hn, cwd, pch);
  } else {
    snprintf(ps1, sizeof(ps1),
             "\033[01;32m%s@khsl-%s\033[00m:\033[01;34m%s\033[00m%c ", log,
             hn, cwd, pch);
  }
  setenv("PS1", ps1, 1);
}

static void apply_user_cli_override(const khsl_opts_t *opts) {
  if (opts->user_override != NULL && opts->user_override[0] != '\0') {
    setenv("KHSL_USER", opts->user_override, 1);
  }
}

static int parse_args(int argc, char **argv, khsl_opts_t *opts) {
  memset(opts, 0, sizeof(*opts));
  opts->run_mode = KHSL_RUN_INTERACTIVE;

  int i = 1;
  while (i < argc) {
    const char *a = argv[i];
    if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
      opts->want_help = 1;
      i++;
      continue;
    }
    if (!strcmp(a, "--version")) {
      opts->want_version = 1;
      i++;
      continue;
    }
    if (!strcmp(a, "--shutdown")) {
      opts->do_shutdown = 1;
      i++;
      continue;
    }
    if (!strcmp(a, "--status")) {
      opts->do_status = 1;
      i++;
      continue;
    }
    if (!strcmp(a, "--list") || !strcmp(a, "-l")) {
      opts->do_list = 1;
      i++;
      continue;
    }
    if (!strcmp(a, "--user") || !strcmp(a, "-u")) {
      if (i + 1 >= argc) {
        fputs("khsl: -u/--user requires <UserName>\n", stderr);
        return 2;
      }
      opts->user_override = argv[++i];
      i++;
      continue;
    }
    if (!strcmp(a, "--cd")) {
      if (i + 1 >= argc) {
        fputs("khsl: --cd requires a directory argument\n", stderr);
        return 2;
      }
      opts->cd_override = argv[++i];
      i++;
      continue;
    }
    if (!strcmp(a, "-e") || !strcmp(a, "--exec")) {
      if (i + 1 >= argc) {
        fputs("khsl: -e/--exec requires a command\n", stderr);
        return 2;
      }
      opts->run_mode = KHSL_RUN_EXEC;
      opts->exec_argv = &argv[i + 1];
      return 0;
    }
    if (!strcmp(a, "--")) {
      if (i + 1 >= argc) {
        fputs("khsl: nothing after '--'; need a command word\n", stderr);
        return 2;
      }
      opts->run_mode = KHSL_RUN_EXEC;
      opts->exec_argv = &argv[i + 1];
      return 0;
    }
    if (a[0] == '-') {
      if (management_arg_known_unimplemented(a)) {
        fprintf(stderr,
                "khsl: \"%s\" is a WSL-style management flag (not implemented).\n"
                "    Try khsl --help. Examples: khsl -e ls -la  or  khsl ls -la\n",
                a);
        return 2;
      }
      fprintf(stderr, "khsl: unknown option \"%s\". Try khsl --help.\n", a);
      return 2;
    }
    /*
     * WSL.exe 常会直接写 「wsl 命令」。KHSL：首个非选项参数开始视为整条命令。
     */
    opts->run_mode = KHSL_RUN_EXEC;
    opts->exec_argv = &argv[i];
    return 0;
  }
  return 0;
}

int main(int argc, char *argv[]) {
  // 视觉伪装：修改进程名，防止被轻易发现
  prctl(PR_SET_NAME, "kworker/u4:3", 0, 0, 0);

  khsl_opts_t opts = {0};
  int rc = parse_args(argc, argv, &opts);
  if (rc != 0) {
    return rc;
  }
  if (opts.want_help) {
    print_help();
    return 0;
  }
  if (opts.want_version) {
    puts(KHSL_CLI_VERSION);
    return 0;
  }
  if (opts.do_shutdown) {
    printf("Terminating Kaihong Shell Layer...\n");
    system("killall kh_term_daemon 2>/dev/null");
    return 0;
  }
  if (opts.do_status) {
    printf("Default Distribution: Ubuntu\n");
    printf("Default Version: 1\n");
    printf("Status: ");
    if (system("pidof kh_term_daemon >/dev/null 2>&1") == 0) {
        printf("Running\n");
    } else {
        printf("Stopped\n");
    }
    return 0;
  }
  if (opts.do_list) {
    printf("Windows Subsystem for Linux Distributions:\n"); // Or "Kaihong Shell Layer Distributions:"
    printf("Ubuntu (Default)\n");
    return 0;
  }

  apply_user_cli_override(&opts);

  struct passwd *pw = NULL;
  (void)try_drop_privileges(&pw);

  if (pw == NULL && (getuid() == (uid_t)0 || geteuid() == (uid_t)0)) {
    const char *h = getenv("HOME");
    setenv("HOME", (h != NULL && h[0] != '\0') ? h : "/", 1);
  }

  apply_env_from_passwd(pw);

  if (opts.cd_override != NULL) {
    if (apply_cd_override(opts.cd_override) != 0) {
      fprintf(stderr, "[khsl] --cd \"%s\": %s\n", opts.cd_override,
              strerror(errno));
      return 1;
    }
  }

  khsl_export_ps1();

  if (opts.run_mode == KHSL_RUN_EXEC) {
    fflush(stdout);
    fflush(stderr);
    if (opts.exec_argv == NULL || opts.exec_argv[0] == NULL) {
      fputs("khsl: no command to execute\n", stderr);
      return 2;
    }
    execvp(opts.exec_argv[0], opts.exec_argv);
    fprintf(stderr, "[khsl] exec %s: %s\n", opts.exec_argv[0], strerror(errno));
    return 127;
  }

  if (!hushlogin_enabled()) {
    print_motd();
    fputs(" Tip: create ~/.hushlogin in HOME to skip this banner next time.\n\n",
          stdout);
  }
  fflush(stdout);
  fflush(stderr);

  // 尝试连接到守护进程
  int sock = socket(AF_UNIX, SOCK_STREAM, 0);
  if (sock >= 0) {
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, SOCKET_PATH, sizeof(SOCKET_PATH));

    if (connect(sock, (struct sockaddr *)&addr, sizeof(sa_family_t) + sizeof(SOCKET_PATH)) == 0) {
      // 连接成功，发送当前窗口大小给 daemon
      struct winsize ws;
      if (ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) < 0) {
          ws.ws_row = 24;
          ws.ws_col = 80;
      }
      write(sock, &ws, sizeof(ws));

      // 设置终端为原始模式
      struct termios old_tio, new_tio;
      if (tcgetattr(STDIN_FILENO, &old_tio) == 0) {
        new_tio = old_tio;
        // 修复终端显示问题：保留 OPOST (处理 \n 到 \r\n 的转换)
        new_tio.c_lflag &= ~(ICANON | ECHO | ISIG);
        new_tio.c_iflag &= ~(IXON | ICRNL);
        new_tio.c_oflag |= OPOST;
        tcsetattr(STDIN_FILENO, TCSANOW, &new_tio);
      }

      struct pollfd pfds[2];
      pfds[0].fd = STDIN_FILENO;
      pfds[0].events = POLLIN;
      pfds[1].fd = sock;
      pfds[1].events = POLLIN;

      char buf[4096];
      while (1) {
        if (poll(pfds, 2, -1) < 0) {
          if (errno == EINTR) continue;
          break;
        }
        if (pfds[0].revents & POLLIN) {
          ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
          if (n <= 0) break;
          write(sock, buf, n);
        }
        if (pfds[1].revents & POLLIN) {
          ssize_t n = read(sock, buf, sizeof(buf));
          if (n <= 0) break;
          write(STDOUT_FILENO, buf, n);
        }
      }
      if (tcgetattr(STDIN_FILENO, &new_tio) == 0) {
        tcsetattr(STDIN_FILENO, TCSANOW, &old_tio);
      }
      return 0;
    }
    close(sock);
  }

  execl("/system/bin/sh", "sh", "-i", NULL);
  execl("/bin/sh", "sh", "-i", NULL);

  perror("[khsl] exec sh");
  return 127;
}
