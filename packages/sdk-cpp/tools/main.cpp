// flurbo-agent-cpp, the C++ runtime's command line. See cli_main in src/runner.cpp.
#include <cstdio>

#include "flurbo/runtime.hpp"

int main(int argc, char** argv) {
  std::vector<std::string> args(argv + 1, argv + argc);
  return flurbo::cli_main(
      args, [](const std::string& s) { std::printf("%s\n", s.c_str()); }, [](const std::string& s) { std::fprintf(stderr, "%s\n", s.c_str()); });
}
