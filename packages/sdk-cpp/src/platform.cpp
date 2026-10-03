// Portable process, environment and file helpers (Windows and POSIX).
#include <fcntl.h>
#include <sys/stat.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>

#include "flurbo/runtime.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <io.h>
#include <process.h>
#include <winsock2.h>
#include <windows.h>
#else
#include <signal.h>
#include <unistd.h>
#endif

namespace flurbo {

void set_env(const std::string& name, const std::string& value) {
#ifdef _WIN32
  _putenv_s(name.c_str(), value.c_str());
#else
  setenv(name.c_str(), value.c_str(), 1);
#endif
}

void unset_env(const std::string& name) {
#ifdef _WIN32
  _putenv_s(name.c_str(), "");
#else
  unsetenv(name.c_str());
#endif
}

std::optional<std::string> get_env(const std::string& name) {
  const char* v = std::getenv(name.c_str());
  if (!v || !*v) return std::nullopt;
  std::string t = trim(v);
  if (t.empty()) return std::nullopt;
  return t;
}

void sleep_ms(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

unsigned process_id() {
#ifdef _WIN32
  return static_cast<unsigned>(_getpid());
#else
  return static_cast<unsigned>(getpid());
#endif
}

bool file_exists(const std::string& path) {
  std::error_code ec;
  return std::filesystem::exists(std::filesystem::u8path(path), ec);
}

std::optional<std::string> read_file(const std::string& path) {
  std::ifstream f(std::filesystem::u8path(path), std::ios::binary);
  if (!f) return std::nullopt;
  std::stringstream s;
  s << f.rdbuf();
  return s.str();
}

void write_file(const std::string& path, const std::string& data) {
  std::ofstream f(std::filesystem::u8path(path), std::ios::binary | std::ios::trunc);
  f << data;
  if (!f) throw Error("io", "A file in the state directory could not be written.");
}

void remove_file(const std::string& path) {
  std::error_code ec;
  std::filesystem::remove(std::filesystem::u8path(path), ec);
}

void make_dirs(const std::string& path) {
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::u8path(path), ec);
  if (ec && !file_exists(path)) throw Error("io", "The state directory could not be created.");
}

std::string utf8(const std::filesystem::path& p) {
  auto s = p.u8string();
  return std::string(s.begin(), s.end());
}

std::string path_join(const std::string& a, const std::string& b) { return utf8(std::filesystem::u8path(a) / std::filesystem::u8path(b)); }

// Whether a process on this machine still runs. Unknown counts as alive (the lock then ages out).
bool process_alive(unsigned pid) {
#ifdef _WIN32
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return GetLastError() == ERROR_ACCESS_DENIED;
  DWORD code = 0;
  bool alive = GetExitCodeProcess(h, &code) && code == STILL_ACTIVE;
  CloseHandle(h);
  return alive;
#else
  return kill(static_cast<pid_t>(pid), 0) == 0 || errno == EPERM;
#endif
}

// Create-exclusive; false when the file already exists (or is being deleted on Windows).
bool create_exclusive(const std::string& path, const std::string& content) {
#ifdef _WIN32
  int fd = _open(path.c_str(), _O_CREAT | _O_EXCL | _O_WRONLY | _O_BINARY, _S_IREAD | _S_IWRITE);
  if (fd < 0) return false;
  _write(fd, content.data(), static_cast<unsigned>(content.size()));
  _close(fd);
#else
  int fd = ::open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, 0644);
  if (fd < 0) return false;
  ssize_t n = ::write(fd, content.data(), content.size());
  (void)n;
  ::close(fd);
#endif
  return true;
}

// Writes, flushes to disk and replaces the target in one step.
void write_atomic(const std::string& path, const std::string& data) {
  std::string tmp = path + ".tmp";
#ifdef _WIN32
  int fd = _open(tmp.c_str(), _O_CREAT | _O_TRUNC | _O_WRONLY | _O_BINARY, _S_IREAD | _S_IWRITE);
  if (fd < 0) throw Error("io", "The journal could not be written.");
  bool ok = _write(fd, data.data(), static_cast<unsigned>(data.size())) == static_cast<int>(data.size()) && _commit(fd) == 0;
  _close(fd);
  if (!ok) throw Error("io", "The journal could not be written.");
  for (int attempt = 0; attempt < 200; ++attempt) {
    if (MoveFileExA(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return;
    sleep_ms(10);  // another process briefly holds the file open
  }
  throw Error("io", "The journal could not be replaced.");
#else
  int fd = ::open(tmp.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0644);
  if (fd < 0) throw Error("io", "The journal could not be written.");
  bool ok = ::write(fd, data.data(), data.size()) == static_cast<ssize_t>(data.size()) && ::fsync(fd) == 0;
  ::close(fd);
  if (!ok || std::rename(tmp.c_str(), path.c_str()) != 0) throw Error("io", "The journal could not be written.");
#endif
}

// Deletes a file, retrying while another process briefly holds it open (Windows).
void remove_retrying(const std::string& path) {
  for (int i = 0; i < 500; ++i) {
    std::error_code ec;
    if (std::filesystem::remove(std::filesystem::u8path(path), ec) || !ec) return;
    sleep_ms(5);
  }
}

}  // namespace flurbo
