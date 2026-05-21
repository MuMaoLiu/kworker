// PTY / NAPI：服务于 KaihongOS 终端（与开源 OpenHarmony 社区 ROM
// 的环境与权限模型可能不同）。

#include "napi/native_api.h"
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <hilog/log.h>
#include <map>
#include <memory>
#include <mutex>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <thread>
#include <unistd.h>
#include <vector>

#undef LOG_DOMAIN
#define LOG_DOMAIN 0x0000
#define LOG_TAG "PtyNapi"
#define LOGI(fmt, ...)                                                         \
  ((void)OH_LOG_Print(LOG_APP, LOG_INFO, LOG_DOMAIN, LOG_TAG, fmt,             \
                      ##__VA_ARGS__))
#define LOGE(fmt, ...)                                                         \
  ((void)OH_LOG_Print(LOG_APP, LOG_ERROR, LOG_DOMAIN, LOG_TAG, fmt,            \
                      ##__VA_ARGS__))

static std::string g_last_pty_diag;
static std::string g_fork_profile;
static std::mutex g_fork_mutex;

static void resolve_shell_paths(const std::string &profile,
                                std::vector<std::string> &out) {
  out.clear();
  if (profile == "khsl") {
    out.assign(
        {"/vendor/bin/khsl", "/system/bin/khsl", "/usr/bin/khsl", "/bin/khsl"});
  } else {
    out.assign(
        {"/system/bin/sh", "/bin/sh", "/vendor/bin/sh", "/system/bin/bash"});
  }
}

static void pty_set_diag(std::string s) {
  g_last_pty_diag = std::move(s);
  LOGE("%{public}s", g_last_pty_diag.c_str());
}

struct PtyData {
  int session_id;
  char *buffer;
  size_t length;
};

struct PtySession {
  int id = 0;
  int master_fd = -1;
  pid_t child_pid = -1;
  /** daemon 会话无本地 posix 子进程，仅 unix 字节流中继 */
  bool daemon_mode = false;
  napi_threadsafe_function tsfn = nullptr;
  std::thread read_thread;
  std::atomic<bool> running{false};
};

static std::mutex g_sessions_mutex;
static std::map<int, std::unique_ptr<PtySession>> g_sessions;
static int g_next_session_id = 1;

static void CallJs(napi_env env, napi_value js_cb, void *context, void *data) {
  (void)context;
  if (env == nullptr || js_cb == nullptr) {
    return;
  }
  PtyData *ptyData = static_cast<PtyData *>(data);
  if (!ptyData) {
    return;
  }
  napi_value js_string;
  napi_create_string_utf8(env, ptyData->buffer, ptyData->length, &js_string);

  napi_value sid_val;
  napi_create_int32(env, ptyData->session_id, &sid_val);

  napi_value undefined;
  napi_get_undefined(env, &undefined);

  napi_value argv[2] = {sid_val, js_string};
  napi_value result;
  napi_call_function(env, undefined, js_cb, 2, argv, &result);

  delete[] ptyData->buffer;
  delete ptyData;
}

static void ReadThreadWorker(PtySession *session) {
  char buffer[4096];
  while (session->running.load(std::memory_order_relaxed) &&
         session->master_fd >= 0) {
    ssize_t bytes_read = read(session->master_fd, buffer, sizeof(buffer));
    if (bytes_read > 0) {
      PtyData *data = new PtyData();
      data->session_id = session->id;
      data->buffer = new char[(size_t)bytes_read];
      memcpy(data->buffer, buffer, (size_t)bytes_read);
      data->length = (size_t)bytes_read;

      napi_status status = napi_call_threadsafe_function(session->tsfn, data,
                                                         napi_tsfn_nonblocking);
      if (status != napi_ok) {
        delete[] data->buffer;
        delete data;
      }
    } else {
      break;
    }
  }
}

static napi_value GetLastPtyError(napi_env env, napi_callback_info info) {
  napi_value v;
  napi_create_string_utf8(env, g_last_pty_diag.c_str(),
                          g_last_pty_diag.length(), &v);
  return v;
}

static void exec_shell_on_slave(const char *slave_name, int master_fd) {
  close(master_fd);
  if (setsid() < 0) {
    _exit(127);
  }
  int slave_fd = open(slave_name, O_RDWR);
  if (slave_fd < 0) {
    LOGE("child open slave failed, errno=%{public}d", errno);
    _exit(127);
  }
#ifdef TIOCSCTTY
  if (ioctl(slave_fd, TIOCSCTTY, 0) < 0) {
    LOGE("child TIOCSCTTY failed, errno=%{public}d", errno);
  }
#endif
  dup2(slave_fd, STDIN_FILENO);
  dup2(slave_fd, STDOUT_FILENO);
  dup2(slave_fd, STDERR_FILENO);
  if (slave_fd > STDERR_FILENO) {
    close(slave_fd);
  }

  setenv("TERM", "xterm-256color", 1);

  std::vector<std::string> paths;
  resolve_shell_paths(g_fork_profile, paths);
  for (const auto &pathstr : paths) {
    const char *path = pathstr.c_str();
    char *const argv_i[] = {(char *)path, (char *)"-i", nullptr};
    execv(path, argv_i);
    char *const argv0[] = {(char *)path, nullptr};
    execv(path, argv0);
  }
  LOGE("child exec shell failed profile=%{public}s errno=%{public}d",
       g_fork_profile.c_str(), errno);
  _exit(127);
}

static bool spawn_shell_with_pty(const char *slave_name, pid_t *out_pid) {
  int slave_fd = open(slave_name, O_RDWR | O_NOCTTY);
  if (slave_fd < 0) {
    pty_set_diag(std::string("spawn: open slave failed errno=") +
                 std::to_string(errno) + " " + strerror(errno));
    return false;
  }

  posix_spawn_file_actions_t fa;
  if (posix_spawn_file_actions_init(&fa) != 0) {
    close(slave_fd);
    pty_set_diag(std::string("spawn: file_actions_init errno=") +
                 std::to_string(errno));
    return false;
  }
  posix_spawn_file_actions_adddup2(&fa, slave_fd, STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&fa, slave_fd, STDOUT_FILENO);
  posix_spawn_file_actions_adddup2(&fa, slave_fd, STDERR_FILENO);
  posix_spawn_file_actions_addclose(&fa, slave_fd);

  static char env_path[] = "PATH=/system/bin:/bin:/usr/bin:/vendor/bin";
  static char env_term[] = "TERM=xterm-256color";
  static char env_home[] = "HOME=/data/storage/el2/base";
  char *minimal_env[] = {env_path, env_term, env_home, nullptr};
  extern char **environ;
  char **envp = (environ != nullptr) ? environ : minimal_env;

  std::vector<std::string> paths;
  resolve_shell_paths(g_fork_profile, paths);

  pid_t pid = -1;
  int spawn_err = -1;

  for (size_t i = 0; i < paths.size() && spawn_err != 0; ++i) {
    const char *sh = paths[i].c_str();
    char *argv_i[] = {(char *)sh, (char *)"-i", nullptr};
    pid = -1;
    spawn_err = posix_spawn(&pid, sh, &fa, nullptr, argv_i, envp);
    if (spawn_err != 0) {
      char buf[320];
      snprintf(buf, sizeof(buf), "export TERM=xterm-256color; exec %s -i", sh);
      char *argv_c[] = {(char *)sh, (char *)"-c", buf, nullptr};
      pid = -1;
      spawn_err = posix_spawn(&pid, sh, &fa, nullptr, argv_c, envp);
    }
    if (spawn_err != 0) {
      char *argv0[] = {(char *)sh, nullptr};
      pid = -1;
      spawn_err = posix_spawn(&pid, sh, &fa, nullptr, argv0, envp);
    }
  }

  posix_spawn_file_actions_destroy(&fa);
  close(slave_fd);

  if (spawn_err != 0) {
    pty_set_diag(std::string("posix_spawn all attempts failed last_err=") +
                 std::to_string(spawn_err) + " errno=" + std::to_string(errno) +
                 " " + strerror(errno));
    return false;
  }
  *out_pid = pid;
  LOGI("posix_spawn shell ok, pid=%{public}d", (int)pid);
  return true;
}

static void destroy_session_locked(PtySession *s) {
  if (!s) {
    return;
  }
  s->running.store(false, std::memory_order_relaxed);
  if (!s->daemon_mode && s->child_pid > 0) {
    kill(s->child_pid, SIGKILL);
    waitpid(s->child_pid, nullptr, 0);
    s->child_pid = -1;
  }
  if (s->master_fd >= 0) {
    /** daemon 为套接字：先 shutdown 以便读线程尽快退出，避免与 JS 线程在 TSFN
     * 上互相等待 */
    if (s->daemon_mode) {
      shutdown(s->master_fd, SHUT_RDWR);
    }
    close(s->master_fd);
    s->master_fd = -1;
  }
  if (s->read_thread.joinable()) {
    s->read_thread.join();
  }
  if (s->tsfn) {
    napi_release_threadsafe_function(s->tsfn, napi_tsfn_abort);
    s->tsfn = nullptr;
  }
}

static napi_value make_int32(napi_env env, int32_t v) {
  napi_value x;
  napi_create_int32(env, v, &x);
  return x;
}

/**
 * startPty(callback(sessionId, data), profile?)
 * Returns session id (>=1) or -1 on failure.
 */
static napi_value StartPty(napi_env env, napi_callback_info info) {
  g_last_pty_diag.clear();

  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "Callback required");
    return nullptr;
  }

  napi_valuetype valuetype;
  napi_typeof(env, args[0], &valuetype);
  if (valuetype != napi_function) {
    napi_throw_type_error(env, nullptr, "Argument must be a function");
    return nullptr;
  }

  std::string profile = "default";
  if (argc >= 2) {
    napi_valuetype t1;
    napi_typeof(env, args[1], &t1);
    if (t1 == napi_string) {
      size_t slen = 0;
      napi_get_value_string_utf8(env, args[1], nullptr, 0, &slen);
      std::string s(slen + 1, '\0');
      napi_get_value_string_utf8(env, args[1], &s[0], slen + 1, &slen);
      s.resize(slen);
      profile = std::move(s);
      LOGI("startPty profile=%{public}s", profile.c_str());
    }
  }

  int new_id;
  {
    std::lock_guard<std::mutex> lk(g_sessions_mutex);
    new_id = g_next_session_id++;
  }

  auto session = std::make_unique<PtySession>();
  session->id = new_id;

  // 与 kh_term_daemon 一致：抽象 AF_UNIX 「\0kh_term_socket」（见
  // SOCKET_PATH）。
  if (profile == "daemon") {
    session->daemon_mode = true;
    session->child_pid = -1;
    sockaddr_un addr = {};
    addr.sun_family = AF_UNIX;
    static const char kKhTermSock[] = "\0kh_term_socket";
    memcpy(addr.sun_path, kKhTermSock, sizeof(kKhTermSock));
    const socklen_t alen =
        static_cast<socklen_t>(sizeof(sa_family_t) + sizeof(kKhTermSock));

    const int sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) {
      pty_set_diag(std::string("daemon socket() errno=") +
                   std::to_string(errno) + " " + strerror(errno));
      return make_int32(env, -1);
    }
    if (connect(sock, reinterpret_cast<struct sockaddr *>(&addr), alen) < 0) {
      pty_set_diag(std::string("daemon connect errno=") +
                   std::to_string(errno) + " " + strerror(errno));
      close(sock);
      return make_int32(env, -1);
    }

    LOGI("daemon socket connected session=%{public}d", new_id);
    session->master_fd = sock;
  } else {
    session->master_fd = posix_openpt(O_RDWR | O_NOCTTY);
    if (session->master_fd < 0) {
      pty_set_diag(std::string("posix_openpt errno=") + std::to_string(errno) +
                   " " + strerror(errno));
      return make_int32(env, -1);
    }

    if (grantpt(session->master_fd) != 0 || unlockpt(session->master_fd) != 0) {
      pty_set_diag(std::string("grantpt/unlockpt errno=") +
                   std::to_string(errno) + " " + strerror(errno));
      close(session->master_fd);
      session->master_fd = -1;
      return make_int32(env, -1);
    }

    char *slave_name = ptsname(session->master_fd);
    if (!slave_name) {
      pty_set_diag(std::string("ptsname failed errno=") +
                   std::to_string(errno));
      close(session->master_fd);
      session->master_fd = -1;
      return make_int32(env, -1);
    }

    bool have_child = false;
    pid_t child_pid = -1;

    {
      std::lock_guard<std::mutex> flk(g_fork_mutex);
      g_fork_profile = profile;
      errno = 0;
      pid_t pid = fork();
      if (pid == 0) {
        exec_shell_on_slave(slave_name, session->master_fd);
        _exit(127);
      }
      if (pid > 0) {
        child_pid = pid;
        have_child = true;
        LOGI("fork shell ok session=%{public}d pid=%{public}d", new_id,
             (int)pid);
      } else {
        pty_set_diag(std::string("fork errno=") + std::to_string(errno) + " " +
                     strerror(errno) + "; trying posix_spawn");
        if (spawn_shell_with_pty(slave_name, &child_pid)) {
          have_child = true;
        } else {
          have_child = false;
        }
      }
    }

    if (!have_child) {
      if (g_last_pty_diag.empty()) {
        pty_set_diag("no child process (fork and posix_spawn failed)");
      }
      close(session->master_fd);
      session->master_fd = -1;
      return make_int32(env, -1);
    }

    session->child_pid = child_pid;
  }

  napi_value work_name;
  std::string wn = "PtyReadThread_" + std::to_string(new_id);
  napi_create_string_utf8(env, wn.c_str(), NAPI_AUTO_LENGTH, &work_name);

  constexpr size_t kTsfnQueueSize = 2048;
  napi_status status = napi_create_threadsafe_function(
      env, args[0], nullptr, work_name, kTsfnQueueSize, 1, nullptr, nullptr,
      nullptr, CallJs, &session->tsfn);

  if (status != napi_ok) {
    pty_set_diag(std::string("napi_create_threadsafe_function status=") +
                 std::to_string((int)status));
    if (!session->daemon_mode && session->child_pid > 0) {
      kill(session->child_pid, SIGKILL);
      waitpid(session->child_pid, nullptr, 0);
      session->child_pid = -1;
    }
    close(session->master_fd);
    session->master_fd = -1;
    return make_int32(env, -1);
  }

  session->running.store(true, std::memory_order_relaxed);
  PtySession *raw = session.get();
  {
    std::lock_guard<std::mutex> lk(g_sessions_mutex);
    g_sessions[new_id] = std::move(session);
  }

  raw->read_thread = std::thread(ReadThreadWorker, raw);

  LOGI("%{public}s session=%{public}d uid=%{public}d euid=%{public}d",
       raw->daemon_mode ? "daemon socket" : "PTY", new_id, (int)getuid(),
       (int)geteuid());

  g_last_pty_diag = "ok";
  return make_int32(env, new_id);
}

static PtySession *find_session(int id) {
  std::lock_guard<std::mutex> lk(g_sessions_mutex);
  auto it = g_sessions.find(id);
  if (it == g_sessions.end()) {
    return nullptr;
  }
  return it->second.get();
}

static napi_value WritePty(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 2) {
    return nullptr;
  }

  int session_id = -1;
  napi_get_value_int32(env, args[1], &session_id);

  PtySession *s = find_session(session_id);
  if (!s || s->master_fd < 0) {
    return nullptr;
  }

  size_t str_len;
  napi_get_value_string_utf8(env, args[0], nullptr, 0, &str_len);
  std::string str(str_len + 1, '\0');
  napi_get_value_string_utf8(env, args[0], &str[0], str_len + 1, &str_len);

  write(s->master_fd, str.c_str(), str_len);
  return nullptr;
}

static napi_value ResizePty(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 3) {
    return nullptr;
  }

  int cols, rows, session_id;
  napi_get_value_int32(env, args[0], &cols);
  napi_get_value_int32(env, args[1], &rows);
  napi_get_value_int32(env, args[2], &session_id);

  PtySession *s = find_session(session_id);
  if (!s || s->master_fd < 0) {
    return nullptr;
  }

  /** kh_term_daemon 侧当前未中继窗口变更；避免对 SOCK_STREAM ioctl */
  if (s->daemon_mode) {
    return nullptr;
  }

  struct winsize ws;
  ws.ws_col = cols;
  ws.ws_row = rows;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  ioctl(s->master_fd, TIOCSWINSZ, &ws);

  if (s->child_pid > 0) {
    kill(s->child_pid, SIGWINCH);
  }

  return nullptr;
}

static napi_value StopPty(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  bool stop_all = false;
  if (argc < 1) {
    stop_all = true;
  } else {
    napi_valuetype t;
    napi_typeof(env, args[0], &t);
    if (t == napi_undefined) {
      stop_all = true;
    }
  }

  int session_id = -1;
  if (!stop_all) {
    napi_get_value_int32(env, args[0], &session_id);
    if (session_id < 0) {
      stop_all = true;
    }
  }

  if (stop_all) {
    std::vector<int> ids;
    {
      std::lock_guard<std::mutex> lk(g_sessions_mutex);
      for (auto &p : g_sessions) {
        ids.push_back(p.first);
      }
    }
    for (int id : ids) {
      std::unique_ptr<PtySession> up;
      {
        std::lock_guard<std::mutex> lk(g_sessions_mutex);
        auto it = g_sessions.find(id);
        if (it != g_sessions.end()) {
          up = std::move(it->second);
          g_sessions.erase(it);
        }
      }
      if (up) {
        destroy_session_locked(up.get());
      }
    }
    return nullptr;
  }

  std::unique_ptr<PtySession> up;
  {
    std::lock_guard<std::mutex> lk(g_sessions_mutex);
    auto it = g_sessions.find(session_id);
    if (it != g_sessions.end()) {
      up = std::move(it->second);
      g_sessions.erase(it);
    }
  }
  if (up) {
    destroy_session_locked(up.get());
  }
  return nullptr;
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {{"startPty", nullptr, StartPty, nullptr,
                                      nullptr, nullptr, napi_default, nullptr},
                                     {"writePty", nullptr, WritePty, nullptr,
                                      nullptr, nullptr, napi_default, nullptr},
                                     {"resizePty", nullptr, ResizePty, nullptr,
                                      nullptr, nullptr, napi_default, nullptr},
                                     {"stopPty", nullptr, StopPty, nullptr,
                                      nullptr, nullptr, napi_default, nullptr},
                                     {"getLastPtyError", nullptr,
                                      GetLastPtyError, nullptr, nullptr,
                                      nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
EXTERN_C_END

static napi_module demoModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "entry",
    .nm_priv = ((void *)0),
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterEntryModule(void) {
  napi_module_register(&demoModule);
}
