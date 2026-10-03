// The runtime's durable record of every transaction intent (protocol/specs/transactions.md). One journal per
// agent wallet in the operator's state directory, in the same format and with the same lock file as the
// other runtimes. Entries are kept as JSON objects, so fields written by another runtime are preserved.
#include <chrono>

#include <algorithm>

#include "flurbo/runtime.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#else
#include <unistd.h>
#endif

namespace flurbo {

bool process_alive(unsigned pid);
bool create_exclusive(const std::string& path, const std::string& content);
void write_atomic(const std::string& path, const std::string& data);
void remove_retrying(const std::string& path);

using json::Value;

std::string hostname() {
  static std::string name = [] {
#ifdef _WIN32
    WSADATA data;
    WSAStartup(MAKEWORD(2, 2), &data);  // gethostname needs Winsock; the reference count is harmless
#endif
    char buf[256] = {0};
    if (gethostname(buf, sizeof buf - 1) != 0 || !buf[0]) return std::string("unknown");
    return std::string(buf);
  }();
  return name;
}

Value owner() {
  Value o = Value::object();
  o.set("pid", static_cast<int64_t>(process_id()));
  o.set("host", hostname());
  return o;
}

bool is_final(const Value& e) { return !unfinished(e.str("status")); }

std::vector<PolicyEntry> policy_entries(const Value& journal) {
  std::vector<PolicyEntry> out;
  for (const auto& e : journal["entries"].as_array()) out.push_back(PolicyEntry::from_json(e));
  return out;
}

FileJournal::FileJournal(const std::string& d, const std::string& w)
    : dir(d), wallet(lower(w)), file(path_join(d, "journal.json")), lock_file(path_join(d, "journal.lock")) {
  make_dirs(d);
}

Value FileJournal::read() const {
  auto text = read_file(file);
  if (!text) {
    Value j = Value::object();
    j.set("schema", "flurbo.agent-journal.v1");
    j.set("wallet", wallet);
    j.set("chainId", 10143);
    j.set("entries", Value::array());
    return j;
  }
  Value j;
  try {
    j = json::parse(*text);
  } catch (const Error&) {
    throw invalid("The journal file is not a Flurbo agent journal.");
  }
  if (j.str("schema") != "flurbo.agent-journal.v1" || j.integer("chainId") != 10143 || !j["entries"].is_array())
    throw invalid("The journal file is not a Flurbo agent journal.");
  if (j.str("wallet") != wallet) throw invalid("This state directory belongs to wallet " + j.str("wallet") + ". Use one state directory per agent wallet.");
  return j;
}

void FileJournal::write(const Value& j) const { write_atomic(file, j.dump(1)); }

void FileJournal::acquire() const {
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(lock_timeout_ms);
  for (unsigned n = 0;; ++n) {
    Value held = owner();
    held.set("at", now_millis());
    if (create_exclusive(lock_file, held.dump())) return;
    if (auto text = read_file(lock_file)) {
      try {
        Value h = json::parse(*text);
        int64_t age = now_millis() - h.integer("at", now_millis());
        bool orphaned = h.str("host") == hostname() && h["pid"].is_integer() && !process_alive(static_cast<unsigned>(h["pid"].as_int()));
        if (age > stale_ms && (orphaned || age > int64_t{stale_ms} * 4)) {
          remove_file(lock_file);
          continue;
        }
      } catch (const Error&) {
      }
    }
    if (std::chrono::steady_clock::now() > deadline) throw Error("conflict", "The agent journal is locked by another process. Retry shortly.");
    sleep_ms(20 + static_cast<int>((process_id() * 7 + n * 13) % 30));
  }
}

// Another process reading the lock file (stale check) briefly blocks deletion on Windows; a lock that is never
// released would stall every process, so the delete is retried.
void FileJournal::release() const { remove_retrying(lock_file); }

FileJournal::Held::Held(const FileJournal& jr) : j(jr) { j.acquire(); }
FileJournal::Held::~Held() { j.release(); }

}  // namespace flurbo
