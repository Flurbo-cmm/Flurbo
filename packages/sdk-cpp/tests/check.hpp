// A minimal test harness: TEST(name) registers a test; CHECK and CHECK_EQ record failures and continue.
// Run a test binary with a test name to run only that test.
#pragma once

#include <cstdio>
#include <exception>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

namespace check {

struct Test {
  const char* name;
  std::function<void()> fn;
};
inline std::vector<Test>& registry() {
  static std::vector<Test> tests;
  return tests;
}
inline int& failures() {
  static int n = 0;
  return n;
}
struct Registrar {
  Registrar(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

template <typename T>
std::string show(const T& v) {
  if constexpr (requires(std::ostream& o) { o << v; }) {
    std::ostringstream s;
    s << v;
    return s.str();
  } else {
    return "(value)";
  }
}

inline void fail(const char* file, int line, const std::string& what) {
  ++failures();
  std::fprintf(stderr, "  FAILED %s:%d: %s\n", file, line, what.c_str());
}

inline int run(int argc, char** argv) {
  int ran = 0;
  for (const auto& t : registry()) {
    if (argc > 1 && std::string(argv[1]) != t.name) continue;
    int before = failures();
    try {
      t.fn();
    } catch (const std::exception& e) {
      fail(t.name, 0, std::string("threw: ") + e.what());
    }
    ++ran;
    std::printf("test %s ... %s\n", t.name, failures() == before ? "ok" : "FAILED");
  }
  std::printf("%d tests, %d failures\n", ran, failures());
  return failures() ? 1 : 0;
}

}  // namespace check

#define TEST(name)                                           \
  static void name();                                        \
  static check::Registrar registrar_##name(#name, name);     \
  static void name()
#define CHECK(cond) \
  do {              \
    if (!(cond)) check::fail(__FILE__, __LINE__, #cond); \
  } while (0)
#define CHECK_EQ(a, b)                                                                                     \
  do {                                                                                                     \
    auto&& check_a = (a);                                                                                  \
    auto&& check_b = (b);                                                                                  \
    if (!(check_a == check_b)) check::fail(__FILE__, __LINE__, std::string(#a " == " #b ": ") + check::show(check_a) + " vs " + check::show(check_b)); \
  } while (0)
#define CHECK_THROWS(expr)                                           \
  do {                                                               \
    bool check_threw = false;                                        \
    try {                                                            \
      (void)(expr);                                                  \
    } catch (const std::exception&) {                                \
      check_threw = true;                                            \
    }                                                                \
    if (!check_threw) check::fail(__FILE__, __LINE__, "expected " #expr " to throw"); \
  } while (0)
#define TEST_MAIN \
  int main(int argc, char** argv) { return check::run(argc, argv); }
